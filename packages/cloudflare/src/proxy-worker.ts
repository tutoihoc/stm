import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { CloudflareApi, CloudflareApiError, segment } from './api.js';
import {
  PROXY_SCRIPT_NAMES,
  PROXY_VERSION_PATH,
  PROXY_WORKER_COMPATIBILITY_DATE,
  PROXY_WORKER_SOURCE,
  PROXY_WORKER_VERSION,
  type ProxyWorkerTarget,
} from './proxy-worker-script.js';

const STATE_FILE = 'cloudflare-proxy.json';
const SCHEMA_VERSION = 1 as const;

/** One deployed proxy, as the console shows it. */
export interface ProxyWorkerRecord {
  readonly target: ProxyWorkerTarget;
  readonly name: string;
  readonly url: string;
  /** The tunnel address it currently forwards to, or null while there is none. */
  readonly origin: string | null;
  readonly publishedAt: string;
}

interface StoredProxyState {
  readonly schemaVersion: 1;
  /** The account the scripts below live in, so a different account starts again. */
  readonly accountId: string | null;
  readonly subdomain: string | null;
  readonly workers: Partial<Record<ProxyWorkerTarget, ProxyWorkerRecord>>;
}

export interface ProxyWorkerOptions {
  readonly api: CloudflareApi;
  /** Where the record of what has been deployed lives. */
  readonly stateDirectory: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly logger?: (message: string, params?: Record<string, string | number>) => void;
}

/**
 * The two Workers that give a Quick Tunnel a fixed address.
 *
 * A Quick Tunnel's hostname is random and is a different one every time
 * cloudflared starts. Anybody given that address has been given something that
 * stops working without warning - and stops in the worst way, with
 * `DNS_PROBE_FINISHED_NXDOMAIN`, because the name is gone from DNS rather than
 * merely unreachable. These two sit on the account's own `workers.dev`
 * subdomain, are named once, and are redeployed pointing at whatever the
 * current tunnel is. The address somebody writes down is theirs for good.
 *
 * Two, because there are two doors and they are given to different people: a
 * chat link is shared, a console link is not.
 *
 * It refuses to take over a script the manager did not create. A name as plain
 * as `stm` may well already be something of the account owner's, and replacing
 * it would be replacing their work with ours.
 */
export class ProxyWorkerManager {
  private readonly api: CloudflareApi;
  private readonly stateDirectory: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly logger: (message: string, params?: Record<string, string | number>) => void;
  private stored: StoredProxyState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  /** One publish per target at a time, so two tunnel changes cannot interleave. */
  private readonly inFlight = new Map<ProxyWorkerTarget, Promise<ProxyWorkerRecord>>();

  public constructor(options: ProxyWorkerOptions) {
    this.api = options.api;
    this.stateDirectory = options.stateDirectory;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((): void => undefined);
  }

  /** What is deployed, as far as this manager knows without asking Cloudflare. */
  public async records(): Promise<readonly ProxyWorkerRecord[]> {
    const stored = await this.load();
    return Object.values(stored.workers).filter((record): record is ProxyWorkerRecord => record !== undefined);
  }

  public async urlFor(target: ProxyWorkerTarget): Promise<string | null> {
    return (await this.load()).workers[target]?.url ?? null;
  }

  /**
   * Point one Worker at this tunnel, deploying it if it is not there yet.
   *
   * `origin` is null when the tunnel is off, which is deployed too: the Worker
   * then serves a page saying the address is not open, which is what somebody
   * opening their own bookmark needs to read. Leaving the old origin in place
   * would hand them a Cloudflare error page about a hostname that no longer
   * exists.
   */
  public async publish(accountId: string, target: ProxyWorkerTarget, origin: string | null): Promise<ProxyWorkerRecord> {
    const pending = this.inFlight.get(target);
    if (pending) {
      // Wait for the one in flight and then do this one, so the last origin
      // asked for is the one that ends up deployed.
      await pending.catch(() => undefined);
    }
    const work = this.publishNow(accountId, target, origin).finally(() => {
      if (this.inFlight.get(target) === work) this.inFlight.delete(target);
    });
    this.inFlight.set(target, work);
    return await work;
  }

  private async publishNow(accountId: string, target: ProxyWorkerTarget, origin: string | null): Promise<ProxyWorkerRecord> {
    const name = PROXY_SCRIPT_NAMES[target];
    const stored = await this.load();
    // A different account is a different `workers.dev` subdomain and different
    // scripts. Nothing of the old account's is ours to speak for any more.
    const forAccount = stored.accountId === accountId ? stored : { ...stored, accountId, subdomain: null, workers: {} };
    const known = forAccount.workers[target];
    const wanted = origin ? normalizeOrigin(origin) : null;
    if (!known) await this.assertNameFree(accountId, name);
    const subdomain = forAccount.subdomain ?? await this.subdomain(accountId);
    await this.deploy(accountId, name, target, wanted);
    const record: ProxyWorkerRecord = {
      target,
      name,
      url: `https://${name}.${subdomain}.workers.dev`,
      origin: wanted,
      publishedAt: this.now().toISOString(),
    };
    await this.save({ ...forAccount, subdomain, workers: { ...forAccount.workers, [target]: record } });
    this.logger(wanted
      ? `[cloudflare] ${record.url} now forwards to ${wanted}`
      : `[cloudflare] ${record.url} has no tunnel behind it and says so`, { url: record.url, ...(wanted ? { origin: wanted } : {}) });
    return record;
  }

  /**
   * Take one of the Workers down.
   *
   * Only ever a script this manager created. Used when the Cloudflare account
   * is disconnected: the grant is being given back, and leaving a Worker
   * behind in somebody's account after they signed out would be leaving them
   * something to find and wonder about.
   */
  public async remove(accountId: string, target: ProxyWorkerTarget): Promise<boolean> {
    const stored = await this.load();
    if (stored.accountId !== accountId || !stored.workers[target]) return false;
    const name = PROXY_SCRIPT_NAMES[target];
    try {
      await this.api.call('DELETE', `/accounts/${segment(accountId)}/workers/scripts/${name}`);
    } catch (error: unknown) {
      // Already gone is the outcome that was wanted.
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    const workers = { ...stored.workers };
    delete workers[target];
    await this.save({ ...stored, workers });
    this.logger(`[cloudflare] the ${name} Worker was removed`, { name });
    return true;
  }

  /** Forget what was deployed, without touching Cloudflare. For a grant that is gone. */
  public async forget(): Promise<void> {
    await this.save({ schemaVersion: SCHEMA_VERSION, accountId: null, subdomain: null, workers: {} });
  }

  /**
   * Refuse a name that is already somebody else's.
   *
   * `stm` and `sillytavern` are short, obvious names, and an account owner may
   * have a Worker of their own called either. The manager has no record of
   * creating this one, so if Cloudflare knows the name, it is not ours - unless
   * the thing answering on it says it is, which covers a manager whose own
   * record was lost with its data directory.
   */
  private async assertNameFree(accountId: string, name: string): Promise<void> {
    let exists: boolean;
    try {
      await this.api.call('GET', `/accounts/${segment(accountId)}/workers/scripts/${name}`);
      exists = true;
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError && error.status === 404) return;
      // Cloudflare could not answer. Deploying over something unknown is the
      // one outcome worth avoiding, so an unclear answer is a no.
      throw error;
    }
    if (!exists) return;
    const subdomain = await this.subdomain(accountId).catch(() => null);
    if (subdomain && await this.isOurs(`https://${name}.${subdomain}.workers.dev`)) return;
    throw new CloudflareApiError(
      'proxy_worker_name_taken',
      409,
      `This Cloudflare account already has a Worker named "${name}" that this manager did not create. Rename or remove it, or the manager cannot publish a fixed address.`,
    );
  }

  /** Whether whatever answers at this address is one of our proxies. */
  private async isOurs(baseUrl: string): Promise<boolean> {
    try {
      const response = await this.fetchImpl(`${baseUrl}${PROXY_VERSION_PATH}`, { headers: { accept: 'application/json' } });
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); return false; }
      const parsed: unknown = await response.json().catch(() => null);
      return isRecord(parsed) && typeof parsed.version === 'number';
    } catch {
      return false;
    }
  }

  /**
   * The account's `workers.dev` subdomain, claimed if the account never had one.
   *
   * The same name the backup Worker is reached on; an existing one is always
   * used as it is, because it is the account's and is visible in the dashboard.
   */
  private async subdomain(accountId: string): Promise<string> {
    try {
      const { result } = await this.api.call('GET', `/accounts/${segment(accountId)}/workers/subdomain`);
      if (isRecord(result) && typeof result.subdomain === 'string' && result.subdomain) return result.subdomain;
    } catch (error: unknown) {
      if (!(error instanceof CloudflareApiError) || error.status !== 404) throw error;
    }
    const { result } = await this.api.call('PUT', `/accounts/${segment(accountId)}/workers/subdomain`, { body: { subdomain: `stm-${accountId.slice(0, 12)}` } });
    if (isRecord(result) && typeof result.subdomain === 'string' && result.subdomain) return result.subdomain;
    throw new CloudflareApiError('worker_no_subdomain', 502, 'Cloudflare did not return a workers.dev subdomain');
  }

  private async deploy(accountId: string, name: string, target: ProxyWorkerTarget, origin: string | null): Promise<void> {
    const form = new FormData();
    form.set('metadata', new Blob([JSON.stringify({
      main_module: 'worker.js',
      compatibility_date: PROXY_WORKER_COMPATIBILITY_DATE,
      bindings: [
        { type: 'plain_text', name: 'ORIGIN', text: origin ?? '' },
        { type: 'plain_text', name: 'TARGET', text: target },
        { type: 'plain_text', name: 'PROXY_VERSION', text: String(PROXY_WORKER_VERSION) },
      ],
    })], { type: 'application/json' }));
    form.set('worker.js', new Blob([PROXY_WORKER_SOURCE], { type: 'application/javascript+module' }), 'worker.js');
    await this.api.call('PUT', `/accounts/${segment(accountId)}/workers/scripts/${name}`, { form });
    // Without this the script is deployed and has no address. Previews stay
    // off: they are a second, guessable hostname onto the same door.
    await this.api.call('POST', `/accounts/${segment(accountId)}/workers/scripts/${name}/subdomain`, { body: { enabled: true, previews_enabled: false } });
  }

  private async load(): Promise<StoredProxyState> {
    if (this.stored) return this.stored;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.stateDirectory, STATE_FILE), 'utf8'));
      this.stored = parseStored(parsed);
    } catch {
      // Missing, or written by something this version cannot read. Either way
      // there is nothing here this manager may claim to own.
      this.stored = { schemaVersion: SCHEMA_VERSION, accountId: null, subdomain: null, workers: {} };
    }
    return this.stored;
  }

  /** Written whole to a temporary file and renamed over, readable only by this user. */
  private async save(next: StoredProxyState): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.stateDirectory, { recursive: true });
      const target = join(this.stateDirectory, STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, target);
      } catch (error: unknown) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      this.stored = next;
    };
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.catch(() => undefined);
    await run;
  }
}

/**
 * The tunnel address as an origin and nothing else.
 *
 * cloudflared announces an origin, but a caller may hand over whatever it has,
 * and a path or a trailing slash on the binding would be silently prepended to
 * every request the Worker forwards.
 */
export function normalizeOrigin(value: string): string {
  return new URL(value).origin;
}

function parseStored(value: unknown): StoredProxyState {
  if (!isRecord(value) || value.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported Cloudflare proxy state');
  const workers: Partial<Record<ProxyWorkerTarget, ProxyWorkerRecord>> = {};
  const listed = isRecord(value.workers) ? value.workers : {};
  for (const [key, entry] of Object.entries(listed)) {
    if (key !== 'manager' && key !== 'sillyTavern') continue;
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.url !== 'string') continue;
    workers[key] = {
      target: key,
      name: entry.name,
      url: entry.url,
      origin: typeof entry.origin === 'string' && entry.origin ? entry.origin : null,
      publishedAt: typeof entry.publishedAt === 'string' ? entry.publishedAt : new Date(0).toISOString(),
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    accountId: typeof value.accountId === 'string' && value.accountId ? value.accountId : null,
    subdomain: typeof value.subdomain === 'string' && value.subdomain ? value.subdomain : null,
    workers,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
