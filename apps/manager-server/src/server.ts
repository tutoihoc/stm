import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { createSocket } from 'node:dgram';
import { extname, join, relative, resolve, sep } from 'node:path';
import { applyQuery, backupSearchText, backupSortValue, installationSearchText, installationSortValue, pageInfo, parseTableQuery, snapshotSearchText, snapshotSortValue, logEvent, logLineText, type ApiErrorBody, type ConfigUpdateInput, type HealthResponse, type Installation, type Job, type JobState, type LogEntry, type LogEvent, type LogLine, type LogSink, type LogSourceFilter, type ManagerPorts, type PortSettings, type Profile, type ProfileLayout, type SetupStatus, type StartupSettings, type TunnelState, type VersionSelector } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, storageDurability, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { INSTALL_CANCELED, RuntimeError, RuntimeManager, type InstallationProgress } from '../../../packages/sillytavern-runtime/src/index.js';
import { hashPassword, MIN_PASSWORD_LENGTH, validatePasscode, validatePassword, verifyPassword } from './password.js';
import { RateLimiter } from './rate-limit.js';
import { parseSessionCookie, SessionStore, clearSessionCookie, sessionCookie } from './sessions.js';
import { StateStore } from './state.js';
import { LOG_LIMITS, LogBuffer } from './log-buffer.js';
import { SystemStore } from './system.js';
import { panelStaticRoot } from './bootstrap.js';
import { ProcessSupervisor } from './supervisor.js';
import { AccessGateway } from './gateway.js';
import { ACCESS_GATEWAY_PORT, checkSillyTavernPort, findFreePort, isPortFree, MANAGER_PORT, PortError, portWasDemanded, resolveAccessPort, resolveConsolePort, SILLYTAVERN_PORT, type ResolvedPort } from './ports.js';
import { previewImage, previewLogo, previewManifest } from './preview.js';
import { TunnelManager } from '../../../packages/tunnel/src/index.js';
import { ProfileError, ProfileStore } from '../../../packages/profiles/src/index.js';
import { BackupError, BackupStore } from '../../../packages/backup/src/index.js';
import { CloudflareConnection, R2Error, R2Manager, type R2UpdateInput } from '../../../packages/r2/src/index.js';
import { CloudflareApiError, CloudflareOAuthError, CloudflareRateLimitError, DEFAULT_SCOPES, PROXY_WORKER_TARGETS, ProxyWorkerManager, type ProxyWorkerTarget } from '../../../packages/cloudflare/src/index.js';
import { BackupScheduler, syncProfileToR2 } from './r2-scheduler.js';
import { fetchSnapshotToLibrary, recoverProfileFromR2 } from './r2-restore.js';
import { TransferMeter } from './progress.js';
import { MetricsStore } from './metrics.js';
import { instrumentationLoaderPath } from '../../../packages/instrumentation/src/index.js';
import { ConfigError, ConfigStore } from '../../../packages/config/src/index.js';
import { DEFAULT_TELEMETRY_ENDPOINT, DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT, TelemetryTransport } from '../../../packages/telemetry/src/index.js';
import { LEGAL_META } from '../../../packages/legal/src/index.js';

const MAX_JSON_BYTES = 128 * 1024;
/** Both named by the legal package, so what is reported is what is shown. */
const TERMS_VERSION = LEGAL_META.effective;
const TELEMETRY_NOTICE_VERSION = LEGAL_META.effective;
const COOKIE_NAME = 'stm_session';

const NOTICE = {
  telemetry: 'This free software collects limited usage metadata to support the project. It never sends API keys, prompts, chats, model responses, or request logs.',
  terms: 'By continuing, you acknowledge the terms and the disclaimer.',
  disclaimer: 'You are responsible for your SillyTavern data, credentials, providers, backups, and compliance with applicable service terms.',
} as const;


/**
 * The Cloudflare OAuth client this project registered.
 *
 * A public client: it has no secret, so shipping its ID is how it is meant to be
 * used. Anyone running their own manager can register a client in their own
 * Cloudflare account and point `STM_CLOUDFLARE_OAUTH_CLIENT_ID` at it, or set it
 * empty to turn signing in to Cloudflare off and keep to S3 keys.
 */
const DEFAULT_CLOUDFLARE_CLIENT_ID = 'b55fd7c6239ab201abe3cbdf58012dbc';
/**
 * Where Cloudflare sends the browser back to.
 *
 * Cloudflare only accepts a redirect it has registered, matched exactly, and a
 * manager can be on any port and any address. The registered one is a page on
 * the project's domain that forwards to the origin the sign-in started from.
 */
const DEFAULT_CLOUDFLARE_REDIRECT_URI = 'https://stm.phamloc.top/oauth/cloudflare/callback';
/** Where the relay, or Cloudflare itself for a loopback client, sends the browser on this manager. */
export const CLOUDFLARE_CALLBACK_PATH = '/oauth/cloudflare/callback';

const PROTECTED_PATHS = new Set([
  '/api/v1/versions',
  '/api/v1/installations',
  '/api/v1/profiles',
  '/api/v1/backups',
  '/api/v1/config',
  '/api/v1/config/port',
  '/api/v1/access/security',
  '/api/v1/access/password',
  '/api/v1/access/network',
  '/api/v1/access/sessions',
  '/api/v1/access/embed-session',
  '/api/v1/preview',
  '/api/v1/preview/image',
  '/api/v1/auth/password',
  '/api/v1/metrics',
  '/api/v1/system',
  '/api/v1/system/measure',
  '/api/v1/startup',
  '/api/v1/tunnel',
  '/api/v1/manager-tunnel',
  '/api/v1/r2',
]);

export interface ManagerServerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly paths?: PlatformPaths;
  readonly store?: StateStore;
  readonly sessions?: SessionStore;
  readonly rateLimiter?: RateLimiter;
  readonly managerVersion?: string;
  readonly secureCookies?: boolean;
  /** Null keeps to the request headers; absent reads the environment. */
  readonly publicOrigin?: string | null;
  readonly staticRoot?: string;
  readonly logger?: LogSink;
  readonly runtime?: RuntimeManager;
  readonly logBuffer?: LogBuffer;
  readonly supervisor?: ProcessSupervisor;
  readonly tunnel?: TunnelManager;
  /** The console's own tunnel, separate from the one that publishes SillyTavern. */
  readonly managerTunnel?: TunnelManager;
  readonly gateway?: AccessGateway;
  /** Overridable so tests can bind an ephemeral port instead of 8001. */
  readonly accessPort?: number;
  readonly profileStore?: ProfileStore;
  readonly backupStore?: BackupStore;
  readonly r2?: R2Manager;
  /** Null turns signing in to Cloudflare off; absent builds it from the environment. */
  readonly cloudflare?: CloudflareConnection | null;
  /**
   * The Workers that give the tunnels a fixed address.
   *
   * Absent builds one from the Cloudflare sign-in, which is the only way it
   * happens outside a test: a test that wants the console to know its own
   * fixed address should not have to hold an OAuth grant to say so.
   */
  readonly proxy?: ProxyWorkerManager | null;
  readonly metrics?: MetricsStore;
  readonly config?: ConfigStore;
  readonly telemetry?: TelemetryTransport;
  /**
   * Called when a launcher that knows STM_SHUTDOWN_TOKEN asks to shut down.
   *
   * Windows has no SIGTERM, so a launcher closing its window can only kill this
   * process - which leaves SillyTavern and cloudflared running with nothing
   * owning them. This gives it a way to ask instead.
   */
  readonly onShutdownRequest?: () => void;
}

export interface ManagerServer {
  readonly server: Server;
  /** Writes a line to the manager log, so a fault can say what it was. */
  readonly logger: LogSink;
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly runtime: RuntimeManager;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  readonly gateway: AccessGateway;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly metrics: MetricsStore;
  readonly config: ConfigStore;
  readonly telemetry: TelemetryTransport;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * The ports this process is actually using, as the routes see them.
 *
 * The console's and the gateway's are fixed for the life of the process, which
 * is why they are numbers; SillyTavern's can move, which is why it is a pair of
 * functions rather than a value read once at startup.
 */
/**
 * An outside address the environment named, and how much authority it carries.
 *
 * `configured` is somebody having written `STM_PUBLIC_ORIGIN` down, which
 * outranks anything the console worked out for itself - including a tunnel it
 * opened. `platform` is the console recognising where it is running, which a
 * tunnel deliberately opened afterwards should outrank in turn: the usual
 * reason to open one is that the platform's own address did not work.
 */
interface EnvironmentOrigin {
  readonly origin: string;
  readonly source: 'configured' | 'platform';
}

interface ServerPorts {
  readonly manager: number;
  readonly access: number;
  readonly sillyTavern: () => number;
  readonly setSillyTavern: (port: number) => void;
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly pathname: string;
  readonly searchParams: URLSearchParams;
  readonly originTrusted: boolean;
  /** Every address the panel is reached at from outside, best first. */
  readonly publicOrigins: readonly string[];
  readonly ports: ServerPorts;
  readonly sessionToken: string | undefined;
}

export async function startManagerServer(options: ManagerServerOptions = {}): Promise<ManagerServer> {
  const env = options.env ?? process.env;
  const paths = options.paths ?? getPlatformPaths({ env });
  const store = options.store ?? new StateStore(
    options.managerVersion ? { paths, managerVersion: options.managerVersion } : { paths },
  );
  const sessions = options.sessions ?? new SessionStore();
  const rateLimiter = options.rateLimiter ?? new RateLimiter();
  const baseLogger: LogSink = options.logger ?? ((line) => console.log(logLineText(line)));
  const jobs = new JobStore(options.logBuffer ?? new LogBuffer(paths));
  const logger: LogSink = (line) => { jobs.append('manager', line); baseLogger(line); };
  /**
   * The port SillyTavern runs on, as everything that needs it reads it.
   *
   * A variable rather than a constant because the console can move it while it
   * runs, and the gateway, the supervisor, the installer's health check and the
   * config writer all have to see the same answer. Its stored value is read
   * below, once the state file has been loaded; until then the shipped port
   * stands.
   */
  let sillyTavernPort: number = SILLYTAVERN_PORT;
  const runtime = options.runtime ?? new RuntimeManager({ paths, healthCheckPort: () => sillyTavernPort, logger: (line) => { jobs.append('installer', line); baseLogger(line); } });
  const profiles = options.profileStore ?? new ProfileStore({ paths, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  const backups = options.backupStore ?? new BackupStore({ paths, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  const cloudflare = options.cloudflare !== undefined ? options.cloudflare : cloudflareConnectionFromEnvironment(paths, env);
  const r2 = options.r2 ?? new R2Manager({ paths, env, ...(cloudflare ? { cloudflare } : {}), logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  /*
   * The fixed addresses in front of the tunnels, when there is a Cloudflare
   * account to put them in.
   *
   * A Quick Tunnel's hostname is random and different every time cloudflared
   * starts, so the address somebody was given yesterday is gone today - and
   * gone as `DNS_PROBE_FINISHED_NXDOMAIN`, because the name is no longer in
   * DNS at all. A Worker on the account's own `workers.dev` subdomain has a
   * name that does not move, and is redeployed at whatever the current tunnel
   * is. Null when nobody has signed in to Cloudflare: there is then nowhere to
   * put one, and the tunnel address is the only address there is.
   */
  /**
   * The console's own fixed address, as a plain string.
   *
   * Kept here rather than asked of `proxy` where it is needed: `publicOrigins`
   * is answered inside a request and cannot wait on a file read, and this
   * changes about as often as somebody signs in to Cloudflare.
   */
  let managerProxyOrigin: string | null = null;
  const proxy = options.proxy !== undefined ? options.proxy : (cloudflare
    ? new ProxyWorkerManager({
      api: cloudflare.cloudflareApi(),
      stateDirectory: paths.state,
      logger: (message, params) => logger(logEvent('cloudflare.proxyPublished', message, params)),
    })
    : null);
  /**
   * Point one of those Workers at the address a tunnel has just announced.
   *
   * Everything about this is best effort. Publishing is a write to somebody
   * else's Cloudflare account over a network that fails, and the tunnel works
   * perfectly well without it - so a failure is written down and the tunnel's
   * own address goes on being the address. It is also why nothing awaits this:
   * a deploy takes seconds, and the switch that started the tunnel must not
   * wait for one.
   */
  const followTunnel = async (target: ProxyWorkerTarget, url: string | null, options: { readonly create?: boolean } = {}): Promise<void> => {
    if (!proxy || !cloudflare) return;
    const account = await cloudflare.workersAccount();
    if (!account) return;
    // Nothing to keep pointing anywhere: no tunnel now, none before, and no
    // reason given to make one. `create` is what a fresh sign-in passes, so
    // the reader is given their permanent address before they first use it.
    if (url === null && !options.create && await proxy.urlFor(target) === null) return;
    try {
      const record = await proxy.publish(account.id, target, url);
      if (target === 'manager') managerProxyOrigin = record.url;
    } catch (error: unknown) {
      logger(logEvent('cloudflare.proxyFailed', `[cloudflare] the fixed address for ${target === 'manager' ? 'the console' : 'SillyTavern'} could not be updated: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    }
  };
  /**
   * Make sure both fixed addresses exist and point where they should.
   *
   * Called when a Cloudflare account has just been connected, which is the
   * moment the manager first has somewhere to put them - and the moment to
   * tell the reader what their two permanent addresses are, whether or not
   * either tunnel happens to be on yet.
   */
  const publishProxies = (): void => {
    void followTunnel('sillyTavern', tunnel.getState().url, { create: true });
    void followTunnel('manager', managerTunnel.getState().url, { create: true });
  };
  // What was deployed the last time this manager ran, so its own address is
  // known before the tunnel has come back and asked for a redeploy.
  void proxy?.urlFor('manager').then((url) => { managerProxyOrigin = url; }).catch(() => undefined);
  const metrics = options.metrics ?? new MetricsStore(paths);
  const config = options.config ?? new ConfigStore({ managedPort: () => sillyTavernPort, logger: (line) => { jobs.append('manager', line); baseLogger(line); } });
  // Where the console binds, which is also which addresses its ports have to be
  // free on. Read here rather than at `listen` below, because everything from
  // the gateway's frame policy to SillyTavern's port is settled against a
  // console port that has already been proven bindable.
  const consolePortChoice = resolveConsolePort(env);
  /*
   * Which addresses to answer on.
   *
   * The loopback address on a machine somebody is sitting at, so the console is
   * not on the house network until they say so. Every address in a container,
   * because the only thing that can reach a container's loopback is the
   * container - Docker and ModelScope have always been that case, and a host
   * that named the port it publishes in `PORT` is the same case wearing a
   * different name: something in front of this process is going to connect to
   * it, and it will not be connecting from inside.
   */
  const defaultHost = paths.platform === 'docker' || paths.platform === 'modelscope' || consolePortChoice.source === 'platform' ? '0.0.0.0' : '127.0.0.1';
  const host = options.host ?? env.STM_HOST ?? defaultHost;
  /**
   * The console's own port, settled before anything else asks for one.
   *
   * Only from the environment, and only at startup: moving the port from a page
   * that is served on it would take that page down with it. A port the host
   * demanded is bound or the start fails, because on a host that publishes one
   * port, listening anywhere else is listening where nobody can knock.
   */
  const consolePort = options.port ?? await settlePort({
    resolved: consolePortChoice,
    host,
    reserved: [],
    // Nothing to move for, so nothing to say. The line that matters is the one
    // below, and only when the port actually moved.
    onMove: (from, to) => logger(logEvent('manager.portMoved', `[manager] port ${from} is already in use; the console is on ${to} instead`, { from, to })),
    onDemandedTaken: (port) => logger(logEvent('manager.portTaken', `[manager] port ${port} was asked for and is already in use; starting there anyway and letting it fail`, { port })),
  });
  /**
   * The access gateway's port, which steps aside the same way.
   *
   * Probed on every address rather than on the one it will bind, because a
   * service holding the port on this machine alone still holds it, and moving
   * for that is cheaper than a gateway that reports an error nobody expected.
   */
  const accessPort = options.accessPort ?? await settlePort({
    resolved: resolveAccessPort(env),
    host: '0.0.0.0',
    reserved: [consolePort],
    onMove: (from, to) => logger(logEvent('gateway.portMoved', `[gateway] port ${from} is already in use; the access gateway is on ${to} instead`, { from, to })),
    onDemandedTaken: (port) => logger(logEvent('gateway.portTaken', `[gateway] port ${port} was asked for and is already in use`, { port })),
  });
  // The console shows SillyTavern in a frame, and the console is the only
  // page allowed to. Both spellings of the loopback address are named because
  // which one is in the address bar is the reader's choice, not ours, and an
  // origin is compared as written.
  /** Filled in once the listener is up; an ephemeral port is not known before that. */
  let boundPort: number = consolePort;
  const gateway = options.gateway ?? new AccessGateway({
    port: accessPort,
    targetPort: sillyTavernPort,
    frameAncestors: [`http://127.0.0.1:${consolePort}`, `http://localhost:${consolePort}`],
    // The sign-in page shows SillyTavern's own mark, read from whatever
    // version is installed rather than kept in this repository.
    brandLogo: async () => {
      const installation = await runtime.getActiveInstallation();
      if (!installation || installation.status !== 'ready') return null;
      return join(installation.runtimePath, 'public', 'img', 'logo.png');
    },
    logger: (line) => { jobs.append('manager', line); baseLogger(line); },
  });
  const supervisor = options.supervisor ?? new ProcessSupervisor({
    runtime,
    port: () => sillyTavernPort,
    profileResolver: (installation) => profiles.getActiveForInstallation(installation.id),
    profileLifecycle: {
      prepare: async (profile, runtimePath) => {
        const installation = await runtime.getInstallation(profile.installationId);
        if (installation) {
          try {
            // The runtime about to be started may be older or newer than the
            // one this config was written for, and an older one refuses to
            // start at all if `listen` was left on for a newer one. Settle
            // that before anything copies the config into the runtime.
            await config.applyManagedDefaults(profile, installation);
          } catch (error: unknown) {
            if (!(error instanceof ConfigError) || error.code !== 'config_missing') throw error;
          }
        }
        // Preparing a legacy runtime rewrites the whole user directory, so no
        // backup may be reading it while this runs.
        return backups.runExclusive(() => profiles.prepareForRuntime(profile, runtimePath));
      },
      // Persisting one back deletes that directory and rebuilds it, which is
      // even less survivable for a backup walking it.
      persist: (profile, runtimePath, runtimeLayout) => backups.runExclusive(() => profiles.persistFromRuntime(profile, runtimePath, runtimeLayout)),
      legacyHeapMb: (profile) => profiles.recommendedLegacyHeapMb(profile),
    },
    instrumentationPath: instrumentationLoaderPath,
    metricsFile: metrics.filePath,
    logger: (line) => { jobs.append('sillytavern', line); baseLogger(line); },
  });
  const tunnel = options.tunnel ?? new TunnelManager({
    paths,
    env,
    targetUrl: `http://127.0.0.1:${accessPort}`,
    onUrl: (url) => { void followTunnel('sillyTavern', url); },
    beforeStart: async () => {
      if (!gateway.getState().passwordConfigured) throw new Error('Set the SillyTavern password before opening a public tunnel');
      if (gateway.getState().status !== 'running') await gateway.start();
    },
    logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); },
  });
  /**
   * The console's own public address, for where the platform will not give it
   * one that works.
   *
   * SillyTavern's tunnel publishes the access gateway; this one publishes the
   * console itself, on a link of its own rather than a path under that one. The
   * two are handed out to different people - a chat link is shared, a console
   * link is not - and cloudflared tells this one its address, which is how the
   * console comes to know where it is on a platform that will not say.
   *
   * It refuses to open without the manager password. The gateway's tunnel
   * refuses without the SillyTavern password for the same reason, and this side
   * can install software and read the whole data directory.
   */
  const managerTunnel = options.managerTunnel ?? new TunnelManager({
    paths,
    env,
    stateFile: 'manager-tunnel-config.json',
    // Read at start rather than now: an ephemeral port is not known until the
    // listener has taken one.
    targetUrl: () => `http://127.0.0.1:${boundPort}`,
    onUrl: (url) => { void followTunnel('manager', url); },
    beforeStart: async () => {
      if ((await store.getPersisted()).adminPasswordHash === null) {
        throw new Error('Set the manager password before opening the console to the internet');
      }
    },
    logger: (line) => { jobs.append('cloudflared', line); baseLogger(line); },
  });
  // The local backup interval used to be stored with the R2 settings. Hand an
  // old value over to the backup library before the scheduler first reads it.
  // An unreadable R2 file must not stop the manager starting over this.
  try {
    const legacyLocalInterval = await r2.legacyLocalIntervalMinutes();
    if (legacyLocalInterval !== null) {
      await backups.adoptLegacySchedule(legacyLocalInterval);
      await r2.forgetLegacyLocalInterval();
    }
  } catch {
    // The default interval applies, and the R2 routes report the file's problem.
  }
  const scheduler = new BackupScheduler({ backups, profiles, r2, logger: (line) => { jobs.append('backup', line); baseLogger(line); } });
  scheduler.start();
  // Uploads interrupted by a closed tab leave gigabyte part files whose id no
  // longer exists anywhere. A day is long enough for a slow connection to
  // finish one and short enough that the volume does not fill up with them.
  void backups.sweepStaleUploads(24 * 60 * 60 * 1000).catch(() => undefined);
  // A backup killed mid-write leaves its partial archive, and an import killed
  // between moving the file and recording it leaves the whole upload.
  void backups.sweepOrphanArchives().catch(() => undefined);
  // Archives written before retention existed are still on the volume, and the
  // scheduler only prunes once it next writes one.
  void profiles.getActive().then((profile) => profile && backups.pruneCreated(profile.id)).catch(() => undefined);
  // Profile snapshots were uncompressed copies of the same recovery point the
  // backup library holds compressed. Nothing writes them now; take back the
  // space the old ones are still using.
  void profiles.removeLegacySnapshots().catch(() => undefined);
  const system = new SystemStore({
    paths,
    dataRoot: async () => {
      const profile = await profiles.getActive();
      return profile ? profile.dataPath : null;
    },
  });
  const secureCookies = options.secureCookies ?? env.STM_SECURE_COOKIES === '1';
  const environmentOrigin: EnvironmentOrigin | null = options.publicOrigin !== undefined
    ? (options.publicOrigin === null ? null : { origin: options.publicOrigin, source: 'configured' })
    : publicOriginFromEnvironment(env, consolePort);
  /**
   * Every address the console can be reached at from outside, best first.
   *
   * More than one can be true at once - a Codespace that also has the tunnel
   * open is reachable both ways - so this is a list rather than an answer.
   * Requests from any of them are trusted; the first is the one a sign-in is
   * sent back to. See EnvironmentOrigin for why the order is what it is.
   */
  const publicOrigins = (): readonly string[] => {
    const tunnelUrl = managerTunnel.getState().url?.replace(/\/$/u, '');
    const ordered = [
      ...(environmentOrigin?.source === 'configured' ? [environmentOrigin.origin] : []),
      /*
       * The Worker in front of the tunnel, ahead of the tunnel itself.
       *
       * Ahead, because it is the address that does not change, so it is the
       * one a sign-in should come back to and the one worth being in a link.
       * Named at all, because a browser at the Worker's address sends that as
       * its `Origin` while `Host` by then is the tunnel's random hostname:
       * without this the console refuses its own sign-in form, and the address
       * opens, shows the page, and cannot be used.
       *
       * Only while the tunnel is up. With nothing behind it the Worker answers
       * every request with its own "not open right now" page, so calling it an
       * address the console can be reached at would be untrue.
       */
      ...(tunnelUrl && managerProxyOrigin ? [managerProxyOrigin] : []),
      ...(tunnelUrl ? [tunnelUrl] : []),
      ...(environmentOrigin?.source === 'platform' ? [environmentOrigin.origin] : []),
    ];
    return ordered;
  };
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : panelStaticRoot(env);
  // Said once, at the top of the log, where somebody setting this up is
  // already looking. The console says it again where it can be acted on.
  const durability = storageDurability(paths.root);
  if (!durability.durable) {
    logger(logEvent('storage.notDurable', `[manager] ${paths.root} is on ${durability.filesystem ?? 'temporary storage'}, which this machine does not keep across a restart; connect Cloudflare R2 so backups are held somewhere else`, { path: paths.root, filesystem: durability.filesystem ?? 'unknown' }));
  }
  let persisted = await store.load();
  // A stored port that would now collide - because `STM_PORT` or
  // `STM_ACCESS_PORT` moved since it was chosen - is dropped rather than
  // obeyed: two services fighting for one port is worse than SillyTavern
  // being somewhere other than where it was left.
  try {
    sillyTavernPort = checkSillyTavernPort(persisted.sillyTavernPort, { manager: consolePort, access: accessPort });
  } catch (error: unknown) {
    logger(logEvent('config.portReset', `[config] SillyTavern's port ${persisted.sillyTavernPort} is no longer usable (${error instanceof Error ? error.message : 'unknown reason'}); using ${SILLYTAVERN_PORT}`, { port: persisted.sillyTavernPort }));
    sillyTavernPort = SILLYTAVERN_PORT;
  }
  /*
   * And a port that is free in this manager's own bookkeeping but held by
   * something else on the machine moves too.
   *
   * SillyTavern is started by us and reports its failures through us, so an
   * address already in use here reads as "SillyTavern will not start" with the
   * real reason several screens up the log. Some hosts run their own service on
   * 8000; the reader did not put it there and cannot move it. Moving is the
   * only answer that leaves everything else - the gateway, the tunnel, the
   * frame - working exactly as before, because all of them ask this variable
   * where SillyTavern is rather than assuming.
   */
  if (!await isPortFree(sillyTavernPort, '127.0.0.1')) {
    const moved = await findFreePort(sillyTavernPort + 1, { reserved: [consolePort, accessPort], host: '127.0.0.1' });
    if (moved === null) {
      logger(logEvent('config.portBusy', `[config] port ${sillyTavernPort} is in use and no free port was found near it; SillyTavern will start there and may fail`, { port: sillyTavernPort }));
    } else {
      logger(logEvent('config.portMoved', `[config] port ${sillyTavernPort} is already in use; SillyTavern is on ${moved} instead`, { from: sillyTavernPort, to: moved }));
      sillyTavernPort = moved;
      await store.setSillyTavernPort(moved);
      persisted = await store.load();
    }
  }
  gateway.setTargetPort(sillyTavernPort);
  /*
   * Whether this process is a test.
   *
   * `NODE_TEST_CONTEXT` is the reliable half: Node's test runner gives each
   * file a child process, and that child sees neither `--test` in its own
   * argv nor `NODE_ENV=test` - so the three checks that were here answered
   * "no" in every test that mattered. The others stay for a suite run some
   * other way.
   */
  const testRuntime = process.env.NODE_TEST_CONTEXT !== undefined
    || process.env.NODE_ENV === 'test'
    || process.argv.includes('--test')
    || process.execArgv.includes('--test');
  const telemetryEndpoint = env.STM_TELEMETRY_ENDPOINT ?? (testRuntime ? undefined : DEFAULT_TELEMETRY_ENDPOINT);
  const telemetryEnrollmentEndpoint = env.STM_TELEMETRY_ENROLLMENT_ENDPOINT ?? (testRuntime ? undefined : DEFAULT_TELEMETRY_ENROLLMENT_ENDPOINT);
  const telemetry = options.telemetry ?? new TelemetryTransport({
    paths,
    metricsFile: metrics.filePath,
    installId: persisted.installId,
    appVersion: persisted.managerVersion,
    platform: paths.platform,
    ...(telemetryEndpoint ? { endpoint: telemetryEndpoint } : {}),
    ...(telemetryEnrollmentEndpoint ? { enrollmentEndpoint: telemetryEnrollmentEndpoint } : {}),
    ...(env.STM_TELEMETRY_ENROLLMENT_TOKEN ? { enrollmentToken: env.STM_TELEMETRY_ENROLLMENT_TOKEN } : {}),
    // No logger. Whether the project's receiver is up is nothing the person
    // running this can act on, and a receiver that is down printed the same
    // line into their terminal every ten seconds.
  });
  try {
    await telemetry.start();
  } catch {
    // Telemetry that cannot start is telemetry that does not run. Nothing else
    // depends on it, so there is nothing to report.
  }

  const environmentPassword = env.STM_ADMIN_PASSWORD;
  if (environmentPassword && !persisted.adminPasswordHash) {
    const passwordError = validatePassword(environmentPassword);
    if (passwordError) {
      throw new Error(`STM_ADMIN_PASSWORD is invalid: ${passwordError}`);
    }
    await store.bootstrapAdminPassword(hashPassword(environmentPassword));
    persisted = await store.getPersisted();
    logger(logEvent('setup.passwordBootstrapped', '[setup] admin password bootstrapped from STM_ADMIN_PASSWORD'));
  }
  const shutdownToken = env.STM_SHUTDOWN_TOKEN?.trim() || null;
  /*
   * Whether a manager with its password just set installs SillyTavern itself.
   *
   * Not under the test runner, where a password is set dozens of times and a
   * Git fetch against the real network is nobody's intention, and not for
   * anyone who asks for it to be left alone.
   */
  const autoInstall = !testRuntime && env.STM_AUTO_INSTALL !== '0';
  const startedAt = Date.now();
  const server = createServer((request, response) => {
    void handleRequest({
      request,
      response,
      store,
      sessions,
      rateLimiter,
      startedAt,
      secureCookies,
      publicOrigins: publicOrigins(),
      ports: {
        // The port that was actually bound, which is not the one asked for when
        // the caller asked for an ephemeral one.
        manager: boundPort,
        access: accessPort,
        sillyTavern: () => sillyTavernPort,
        setSillyTavern: (port) => { sillyTavernPort = port; gateway.setTargetPort(port); },
      },
      staticRoot,
      platform: paths.platform,
      logger,
      runtime,
      jobs,
      supervisor,
      tunnel,
      managerTunnel,
      gateway,
      profiles,
      backups,
      r2,
      cloudflare,
      metrics,
      config,
      system,
      proxy,
      publishProxies,
      shutdownToken,
      autoInstall,
      onShutdownRequest: options.onShutdownRequest,
    }).catch((error: unknown) => {
      if (error instanceof RequestError) {
        sendError(response, error.statusCode, error.code, error.message);
        return;
      }
      if (error instanceof BackupError) {
        sendError(response, 400, error.code, error.message);
        return;
      }
      if (error instanceof R2Error) {
        sendError(response, error.code === 'r2_not_configured' ? 409 : 400, error.code, error.message);
        return;
      }
      if (error instanceof ConfigError) {
        sendError(response, error.code === 'config_missing' ? 409 : 400, error.code, error.message);
        return;
      }
      if (error instanceof CloudflareRateLimitError) {
        response.setHeader('retry-after', String(error.retryAfterSeconds));
        sendError(response, 429, error.code, error.message);
        return;
      }
      if (error instanceof CloudflareApiError || error instanceof CloudflareOAuthError) {
        // Cloudflare answered, and not with what was needed: a gateway problem,
        // not a fault in this manager.
        sendError(response, 502, error.code, error.message);
        return;
      }
      logger(logEvent('manager.requestFailed', `[manager] request failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
      if (!response.headersSent) {
        sendError(response, 500, 'internal_error', 'The manager could not complete the request');
      } else {
        response.destroy();
      }
    });
  });
  // Backups and SillyTavern streaming can last longer than Node's defaults.
  // Chunked uploads keep individual requests small, while these settings avoid
  // killing a slow Studio connection mid-request or mid-stream.
  server.requestTimeout = 0;
  server.timeout = 0;
  server.headersTimeout = 120_000;
  server.keepAliveTimeout = 120_000;
  const port = consolePort;
  await listen(server, host, port);
  const address = server.address();
  const actualPort = address && typeof address !== 'string' ? address.port : port;
  boundPort = actualPort;
  // The door opens with the manager rather than with SillyTavern, so its
  // address is the same one every time and a saved bookmark keeps working.
  gateway.setPassword(persisted.accessPasswordHash, persisted.accessPasscode);
  await gateway.start(persisted.accessLanEnabled);
  // The tunnel publishes the gateway, not SillyTavern, so it can come back as
  // soon as the gateway is listening - it does not have to wait for SillyTavern
  // and it does not go away again when SillyTavern is restarted.
  void tunnel.resume().catch((error: unknown) => logger(logEvent('cloudflared.resumeFailed', `[cloudflared] the tunnel could not be restored: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
  // The console's own link comes back the same way, and only now: its target is
  // the port that was bound a few lines above.
  void managerTunnel.resume().catch((error: unknown) => logger(logEvent('cloudflared.resumeFailed', `[cloudflared] the console's tunnel could not be restored: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
  const activeInstallation = await runtime.getActiveInstallation();
  if (activeInstallation?.status === 'ready') {
    // There is one, however it got here, so the manager has no first install
    // left to do. Claiming it now is what stops an upgrade of the manager from
    // deciding, on a machine set up long before this existed, that nothing has
    // been installed yet.
    await store.claimFirstInstall();
    let readyInstallation = activeInstallation;
    try {
      readyInstallation = await runtime.migrateLegacyInstallation?.(activeInstallation) ?? activeInstallation;
      await profiles.ensureDefault({ installationId: readyInstallation.id, runtimePath: readyInstallation.runtimePath });
      const activeProfile = await profiles.getActive();
      // Before the config is written and before SillyTavern is started, so what
      // comes back is what gets configured and started rather than something
      // laid over a profile already in use.
      if (activeProfile) await recoverEmptyProfile(() => Promise.resolve(activeProfile), r2, backups, jobs);
      // Reading it first turns a missing config into the handled error below
      // rather than a fault during startup.
      const currentConfig = activeProfile ? await config.read(activeProfile, readyInstallation) : null;
      if (activeProfile && currentConfig) await config.applyManagedDefaults(activeProfile, readyInstallation);
      await runtime.cleanupLegacyRuntimeCopies?.(readyInstallation.id);
    } catch (error: unknown) {
      logger(logEvent('installer.legacyMigrationFailed', `[installer] legacy runtime migration failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    }
    // Started with the manager unless somebody has said not to. Off is for
    // whoever runs SillyTavern themselves, or opens the console only to look
    // at backups on a machine they do not want a second process on.
    if (persisted.autoStartSillyTavern) {
      void supervisor.start().catch((error: unknown) => logger(logEvent('sillytavern.autoStartFailed', `[sillytavern] automatic startup failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' })));
    } else {
      logger(logEvent('sillytavern.autoStartOff', '[sillytavern] not started: starting it with the manager is switched off'));
    }
  } else {
    /*
     * Nothing installed, and a bucket set up in `.env` that already holds data.
     *
     * This is the machine that starts from nothing every time. It cannot be
     * given its profile back yet - a profile is made against an installation,
     * and there is not one - but it can say, before anybody wonders, that the
     * data is not lost and that installing is what brings it back. Said in the
     * log rather than made into a question: the settings are in `.env` because
     * somebody put them there, which is the decision already taken.
     */
    void announceRecoverable(r2, logger);
  }

  return {
    server,
    logger,
    store,
    sessions,
    runtime,
    port: actualPort,
    supervisor,
    tunnel,
    managerTunnel,
    gateway,
    profiles,
    backups,
    r2,
    metrics,
    config,
    telemetry,
    close: async () => { await telemetry.close(); await scheduler.close(); await tunnel.close(); await managerTunnel.close(); await gateway.close(); await supervisor.close(); await backups.settle(); await profiles.settle(); await closeServer(server); },
  };
}

async function handleRequest(options: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: StateStore;
  readonly sessions: SessionStore;
  readonly rateLimiter: RateLimiter;
  readonly startedAt: number;
  readonly secureCookies: boolean;
  readonly publicOrigins: readonly string[];
  readonly ports: ServerPorts;
  readonly staticRoot: string;
  readonly platform: PlatformPaths['platform'];
  readonly logger: LogSink;
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly tunnel: TunnelManager;
  readonly managerTunnel: TunnelManager;
  readonly gateway: AccessGateway;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly cloudflare: CloudflareConnection | null;
  readonly metrics: MetricsStore;
  readonly config: ConfigStore;
  readonly system: SystemStore;
  readonly proxy: ProxyWorkerManager | null;
  /** Put the fixed addresses in place, for a Cloudflare account just connected. */
  readonly publishProxies: () => void;
  readonly shutdownToken: string | null;
  /**
   * Whether the manager may install SillyTavern by itself on a first run.
   *
   * Off under the test runner and for anyone who sets `STM_AUTO_INSTALL=0`:
   * the install is a Git fetch and an `npm install` against the real network,
   * which is not something a test that sets a password has asked for.
   */
  readonly autoInstall: boolean;
  readonly onShutdownRequest: (() => void) | undefined;
}): Promise<void> {
  const { request, response, store, sessions, rateLimiter, startedAt, publicOrigins, ports, staticRoot, platform, logger, runtime, jobs, supervisor, tunnel, managerTunnel, gateway, profiles, backups, r2, cloudflare, metrics, config, system, proxy, publishProxies, shutdownToken, autoInstall, onShutdownRequest } = options;
  // Whether the browser's side of this connection is HTTPS, which is not the
  // same question as whether ours is: a hosted console is reached over HTTPS
  // that a proxy terminates before us, and only the proxy's own header says so.
  const secureCookies = options.secureCookies || requestIsSecure(request);
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const pathname = url.pathname;
  const context: RequestContext = {
    request,
    response,
    pathname,
    searchParams: url.searchParams,
    originTrusted: isTrustedOrigin(request, platform, publicOrigins),
    publicOrigins,
    ports,
    sessionToken: parseSessionCookie(headerValue(request.headers.cookie), COOKIE_NAME),
  };

  if (pathname === CLOUDFLARE_CALLBACK_PATH && (request.method ?? 'GET') === 'GET') {
    await handleCloudflareCallback(context, sessions, cloudflare, r2, options.logger);
    return;
  }
  if (!pathname.startsWith('/api/v1/')) {
    await servePanel(request, response, pathname, staticRoot);
    return;
  }
  if (!context.originTrusted) {
    sendError(response, 403, 'origin_rejected', 'Request origin is not allowed');
    return;
  }

  const method = request.method ?? 'GET';
  if (pathname === '/api/v1/health' && method === 'GET') {
    const state = await store.getPersisted();
    const health: HealthResponse = {
      status: 'ok',
      manager: { version: state.managerVersion, port: ports.manager },
      setupRequired: state.adminPasswordHash === null,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      // Asked of the filesystem the data is actually on, rather than of the
      // platform's name: the same image is durable with a volume mounted at the
      // data directory and not without one, and its name says neither.
      storage: { durable: storageDurability(store.paths.root).durable },
    };
    sendJson(response, 200, health);
    return;
  }

  if (pathname === '/api/v1/shutdown' && method === 'POST') {
    // Absent unless a launcher started this process and shared a secret with
    // it, so the panel's own origin cannot reach it and neither can anything
    // else on the machine that has not been told the token.
    const supplied = headerValue(request.headers['x-stm-shutdown-token']);
    if (!shutdownToken || !supplied || !constantTimeStringEqual(supplied, shutdownToken)) {
      sendError(response, 404, 'not_found', 'Route not found');
      return;
    }
    sendJson(response, 202, { ok: true });
    onShutdownRequest?.();
    return;
  }

  if (pathname === '/api/v1/setup/status' && method === 'GET') {
    const state = await store.getPersisted();
    const status: SetupStatus = {
      setupRequired: state.adminPasswordHash === null,
      termsVersion: TERMS_VERSION,
      telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION,
      notice: NOTICE,
    };
    sendJson(response, 200, status);
    return;
  }

  if (pathname === '/api/v1/setup/password' && method === 'POST') {
    await handlePasswordSetup(context, store, sessions, rateLimiter, secureCookies, async () => {
      /*
       * A manager that has just been set up has nothing installed, and one
       * obvious next step.
       *
       * Making the reader find and press Install is asking them to confirm the
       * only thing this program does. It runs once per installation of the
       * manager - claimed under the state file's own write queue - so somebody
       * who later removes SillyTavern on purpose does not find it putting
       * itself back. The console follows the job it produces the same way it
       * follows one somebody pressed for, and can stop it.
       */
      if (!autoInstall) return;
      if ((await runtime.listInstallations()).length > 0) return;
      if (!await store.claimFirstInstall()) return;
      try {
        await beginInstallation({ runtime, jobs, supervisor, profiles, backups, r2, system }, 'latest');
        logger(logEvent('installer.firstRun', '[installer] installing SillyTavern, because this manager has just been set up and has none'));
      } catch (error: unknown) {
        // Nothing is owed here: the console shows Install, and the reader can
        // press it. A first run must not fail over this.
        logger(logEvent('installer.firstRunFailed', `[installer] the first installation could not be started: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
      }
    });
    return;
  }

  if (pathname === '/api/v1/auth/login' && method === 'POST') {
    await handleLogin(context, store, sessions, rateLimiter, secureCookies);
    return;
  }

  if (pathname === '/api/v1/auth/session' && method === 'GET') {
    const session = requireSession(context, sessions);
    if (!session) return;
    sendJson(response, 200, { session });
    return;
  }

  if (pathname === '/api/v1/auth/logout' && method === 'POST') {
    const session = requireSession(context, sessions);
    if (!session) {
      return;
    }
    if (!requireCsrf(context, session.csrfToken)) {
      return;
    }
    sessions.revoke(context.sessionToken);
    response.setHeader('Set-Cookie', clearSessionCookie(secureCookies));
    sendJson(response, 200, { ok: true });
    return;
  }

  const needsAuth = isProtectedPath(pathname);
  if (needsAuth) {
    const session = requireSession(context, sessions);
    if (!session) {
      return;
    }
    if (method !== 'GET' && !requireCsrf(context, session.csrfToken)) {
      return;
    }
    await handleRuntimeRequest(context, store, runtime, jobs, supervisor, tunnel, managerTunnel, gateway, profiles, backups, r2, cloudflare, metrics, config, system, proxy, publishProxies, logger);
    return;
  }

  sendError(response, 404, 'not_found', 'Route not found');
}

async function handleRuntimeRequest(context: RequestContext, store: StateStore, runtime: RuntimeManager, jobs: JobStore, supervisor: ProcessSupervisor, tunnel: TunnelManager, managerTunnel: TunnelManager, gateway: AccessGateway, profiles: ProfileStore, backups: BackupStore, r2: R2Manager, cloudflare: CloudflareConnection | null, metrics: MetricsStore, config: ConfigStore, system: SystemStore, proxy: ProxyWorkerManager | null, publishProxies: () => void, logger: LogSink): Promise<void> {
  const { pathname, ports, request, response, searchParams } = context;
  const method = request.method ?? 'GET';
  if (pathname === '/api/v1/auth/password' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || typeof body.confirmPassword !== 'string' || body.password !== body.confirmPassword) {
      sendError(response, 400, 'password_confirmation_mismatch', 'Enter the same manager password twice');
      return;
    }
    const passwordError = validatePassword(body.password);
    if (passwordError) {
      sendError(response, 400, 'invalid_password', passwordError);
      return;
    }
    const changed = await store.changeAdminPassword(hashPassword(body.password));
    if (!changed) {
      sendError(response, 409, 'setup_required', 'Create the manager admin password before changing it');
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === '/api/v1/config/validate' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.rawYaml !== 'string') { sendError(response, 400, 'invalid_input', 'A YAML document is required'); return; }
    sendJson(response, 200, { valid: true, settings: await config.validate(body.rawYaml) });
    return;
  }
  if (pathname === '/api/v1/config' && (method === 'GET' || method === 'PUT')) {
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (!profile || !installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'Install SillyTavern before editing its configuration'); return; }
    if (method === 'GET') { sendJson(response, 200, await decorateConfig(await config.read(profile, installation))); return; }
    const input = parseConfigUpdateInput(await readJson(request));
    const wasRunning = supervisor.getState().status === 'running';
    // Stop before writing. A runtime old enough to keep its own copy of the
    // config has that copy synchronized back into the profile when it stops,
    // so a config written first is overwritten by the restart that was meant
    // to apply it - which is why nothing the panel saved ever took effect.
    if (wasRunning) await supervisor.stop('configChange');
    const saved = await config.update(profile, installation, input);
    const process = wasRunning ? await supervisor.start() : supervisor.getState();
    sendJson(response, 200, { config: await decorateConfig(saved), process, tunnel: tunnel.getState() });
    return;
  }
  /**
   * Move SillyTavern to another port.
   *
   * Its own route rather than a field of the config editor, because the number
   * has to be checked against the console's port and the gateway's before
   * anything is written, and because moving it means restarting SillyTavern:
   * leaving the door pointed at a port nothing answers on would read as
   * SillyTavern having crashed.
   */
  if (pathname === '/api/v1/config/port' && method === 'GET') {
    // The reserved pair comes back with it: the panel needs to say which port
    // is taken and by what, rather than only that the number was refused.
    const settings: PortSettings = { port: ports.sillyTavern(), reserved: { manager: ports.manager, access: ports.access } };
    sendJson(response, 200, settings);
    return;
  }
  if (pathname === '/api/v1/config/port' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body)) { sendError(response, 400, 'invalid_input', 'A port is required'); return; }
    let port: number;
    try {
      port = checkSillyTavernPort(body.port, { manager: ports.manager, access: ports.access });
    } catch (error: unknown) {
      if (error instanceof PortError) { sendError(response, 400, error.code, error.message); return; }
      throw error;
    }
    if (port === ports.sillyTavern()) { sendJson(response, 200, { port, process: supervisor.getState() }); return; }
    const wasRunning = supervisor.getState().status === 'running';
    if (wasRunning) await supervisor.stop('configChange');
    await store.setSillyTavernPort(port);
    ports.setSillyTavern(port);
    // Write it into the file too, so a reader of config.yaml is not told one
    // thing while SillyTavern is started with another.
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (profile && installation?.status === 'ready') {
      try { await config.applyManagedDefaults(profile, installation); }
      catch (error: unknown) { if (!(error instanceof ConfigError) || error.code !== 'config_missing') throw error; }
    }
    const process = wasRunning ? await supervisor.start() : supervisor.getState();
    sendJson(response, 200, { port, process });
    return;
  }
  if (pathname === '/api/v1/config/reset' && method === 'POST') {
    const profile = await profiles.getActive();
    const installation = await runtime.getActiveInstallation();
    if (!profile || !installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'Install SillyTavern before editing its configuration'); return; }
    // Same order as a save, and for the same reason: a runtime that keeps its
    // own copy of the config writes it back when it stops.
    const wasRunning = supervisor.getState().status === 'running';
    if (wasRunning) await supervisor.stop('configChange');
    const restored = await config.restoreDefaults(profile, installation);
    const process = wasRunning ? await supervisor.start() : supervisor.getState();
    sendJson(response, 200, { config: await decorateConfig(restored), process, tunnel: tunnel.getState() });
    return;
  }
  if (pathname === '/api/v1/access/security' && method === 'GET') {
    sendJson(response, 200, gateway.getState());
    return;
  }
  if (pathname === '/api/v1/access/password' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.password !== 'string' || typeof body.confirmPassword !== 'string' || body.password !== body.confirmPassword) {
      sendError(response, 400, 'password_confirmation_mismatch', 'Enter the same SillyTavern password twice');
      return;
    }
    const invalid = validatePasscode(body.password);
    if (invalid) { sendError(response, 400, 'invalid_passcode', invalid); return; }
    const passwordHash = hashPassword(body.password);
    await store.setAccessPassword(passwordHash, true);
    // Whoever was already inside is signed out, so a password changed because
    // it was shared too widely takes effect immediately rather than at the
    // next restart.
    gateway.setPassword(passwordHash, true);
    if (gateway.getState().status !== 'running') await gateway.start();
    sendJson(response, 200, gateway.getState());
    return;
  }
  /*
   * A way into SillyTavern for the console that is already signed in.
   *
   * The cookie is set here, on the manager's own origin, and the gateway on
   * its own port reads it - which works because cookies are scoped by host and
   * not by port, so one set for 127.0.0.1 is sent to every port on it. That is
   * the whole trick: the embedded view needs no PIN because the session behind
   * it was issued to somebody who had already given the console's password.
   */
  if (pathname === '/api/v1/access/embed-session' && method === 'POST') {
    if (gateway.getState().status !== 'running') await gateway.start();
    const { token, maxAgeSeconds } = gateway.issueSession();
    response.setHeader('Set-Cookie', gateway.sessionCookie(request, token, maxAgeSeconds));
    sendJson(response, 200, gateway.getState());
    return;
  }
  /*
   * The reader's own wallpaper and characters, for the still on the overview.
   *
   * Read-only, and only ever the two directories `preview.ts` names. The
   * manifest is one request and each image is another, so the console can show
   * the frame before the pictures arrive rather than waiting on all of them.
   */
  if (pathname === '/api/v1/preview' && method === 'GET') {
    const profile = await profiles.getActive();
    if (!profile) { sendJson(response, 200, { background: null, theme: null, recent: [] }); return; }
    sendJson(response, 200, await previewManifest(userDataRoot(profile)));
    return;
  }
  if (pathname === '/api/v1/preview/image' && method === 'GET') {
    const kind = searchParams.get('kind');
    const name = searchParams.get('name');
    // The mark belongs to the installed copy of SillyTavern rather than to a
    // profile, so it is fetched from the runtime and needs no name.
    if (kind === 'logo') {
      const installation = await runtime.getActiveInstallation();
      const mark = installation && installation.status === 'ready' ? await previewLogo(installation.runtimePath) : null;
      if (!mark) { sendError(response, 404, 'not_found', 'There is no SillyTavern mark to show'); return; }
      sendImage(response, mark);
      return;
    }
    if ((kind !== 'background' && kind !== 'avatar') || !name) { sendError(response, 400, 'invalid_input', 'A preview image needs a kind and a name'); return; }
    const profile = await profiles.getActive();
    const image = profile ? await previewImage(userDataRoot(profile), kind, name) : null;
    if (!image) { sendError(response, 404, 'not_found', 'That preview image is not there'); return; }
    sendImage(response, image);
    return;
  }
  if (pathname === '/api/v1/access/sessions' && method === 'DELETE') {
    gateway.signOutEveryone();
    sendJson(response, 200, gateway.getState());
    return;
  }
  if (pathname === '/api/v1/access/network' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.lan !== 'boolean') { sendError(response, 400, 'invalid_input', 'Local network access must be on or off'); return; }
    if (body.lan && !gateway.getState().passwordConfigured) {
      sendError(response, 409, 'public_access_password_required', 'Set the SillyTavern password before enabling network access');
      return;
    }
    await store.setAccessLan(body.lan);
    sendJson(response, 200, await gateway.setLan(body.lan));
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'GET') {
    // This used to list the bucket to show how many objects were in it. With
    // nine thousand of them that is ten charged listings for every load of the
    // page - more charged operations than a day of backups - to display a
    // number the manager already keeps. `/api/v1/r2/objects` still lists, for
    // when somebody actually asked to see the contents.
    // The durability of this machine's disk rides along with the backup
    // settings because it is the same question: whether a copy somewhere else
    // is a precaution or the only thing keeping the data.
    sendJson(response, 200, { config: await r2.getConfig(), storage: storageDurability(store.paths.root) });
    return;
  }
  if (pathname === '/api/v1/r2' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body)) { sendError(response, 400, 'invalid_input', 'A JSON object is required'); return; }
    const input: R2UpdateInput = {
      ...(body.mode === 'keys' || body.mode === 'cloudflare' ? { mode: body.mode } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.endpoint === 'string' || body.endpoint === null ? { endpoint: body.endpoint as string | null } : {}),
      ...(typeof body.bucket === 'string' || body.bucket === null ? { bucket: body.bucket as string | null } : {}),
      ...(typeof body.accessKeyId === 'string' || body.accessKeyId === null ? { accessKeyId: body.accessKeyId as string | null } : {}),
      ...(typeof body.secretAccessKey === 'string' || body.secretAccessKey === null ? { secretAccessKey: body.secretAccessKey as string | null } : {}),
      ...(typeof body.hotIntervalMinutes === 'number' ? { hotIntervalMinutes: body.hotIntervalMinutes } : {}),
      ...(typeof body.coldIntervalHours === 'number' ? { coldIntervalHours: body.coldIntervalHours } : {}),
      ...(typeof body.reconcileIntervalHours === 'number' ? { reconcileIntervalHours: body.reconcileIntervalHours } : {}),
      ...(typeof body.keepRecent === 'number' ? { keepRecent: body.keepRecent } : {}),
      ...(typeof body.keepDaily === 'number' ? { keepDaily: body.keepDaily } : {}),
      ...(typeof body.keepWeekly === 'number' ? { keepWeekly: body.keepWeekly } : {}),
      ...(typeof body.maxStorageBytes === 'number' ? { maxStorageBytes: body.maxStorageBytes } : {}),
      ...(typeof body.maxWriteOperations === 'number' ? { maxWriteOperations: body.maxWriteOperations } : {}),
    };
    sendJson(response, 200, { config: await r2.update(input) });
    return;
  }
  if (pathname === '/api/v1/r2/usage' && method === 'GET') {
    sendJson(response, 200, await r2.cloudflareUsage({ refresh: searchParams.get('refresh') === '1' }));
    return;
  }
  if (pathname.startsWith('/api/v1/r2/cloudflare')) {
    await handleCloudflareRequest(context, cloudflare, r2, proxy, publishProxies, logger);
    return;
  }
  // The one question about the bucket: is it reachable, and what is in it. It
  // replaced three buttons that each answered part of it and then said so in a
  // notification that went away.
  if (pathname === '/api/v1/r2/check' && method === 'POST') {
    sendJson(response, 200, { check: await r2.inspect(), config: await r2.getConfig() });
    return;
  }
  if (pathname === '/api/v1/r2/objects' && method === 'GET') {
    sendJson(response, 200, { objects: await r2.listObjects() });
    return;
  }
  if (pathname === '/api/v1/r2/objects' && method === 'DELETE') {
    const body = await readJson(request);
    const key = isRecord(body) && typeof body.key === 'string' ? body.key : '';
    if (!key) { sendError(response, 400, 'invalid_object_key', 'An R2 object key is required'); return; }
    await r2.deleteObject(key);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === '/api/v1/r2/snapshots' && method === 'GET') {
    /*
     * Every recovery point in the bucket, not this profile's.
     *
     * A profile identifier is made on the machine that made the profile, so a
     * machine that has just been set up - a hosted one that starts empty, a new
     * computer, a reinstall - has an identifier the bucket has never seen. Asking
     * for its own points came back with none, and the panel said the bucket was
     * empty over a bucket holding a year of them. The one moment somebody most
     * needs to see what is there is the moment they have just connected, and it
     * was the one moment this showed nothing.
     *
     * The chunks are shared across every profile in the bucket, so a point from
     * another one costs no more to bring back and restores the same way. Which
     * profile each belongs to comes back with it, for the panel to say so.
     */
    const profile = await profiles.getActive();
    const snapshots = await r2.listSnapshots().catch(() => []);
    sendList(response, 'snapshots', snapshots, searchParams, { searchText: snapshotSearchText, sortValue: snapshotSortValue }, { activeProfileId: profile?.id ?? null });
    return;
  }
  const snapshotMatch = /^\/api\/v1\/r2\/snapshots\/([^/]+)\/fetch$/u.exec(pathname);
  if (snapshotMatch && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before fetching a recovery point'); return; }
    const snapshotId = snapshotMatch[1] ?? '';
    // Which profile in the bucket it belongs to, when that is not this one.
    // Sent by the panel from the row it was pressed on; a point of this
    // profile's own needs nothing and says nothing.
    const fetchBody = await readJson(request);
    const sourceProfileId = isRecord(fetchBody) && typeof fetchBody.profileId === 'string' && fetchBody.profileId ? fetchBody.profileId : profile.id;
    // Fetching lands it in the backup library rather than writing it straight
    // into the profile. Restoring is then the path that already exists, with
    // its preview, its safety snapshot and its merge-or-replace choice.
    // It produces a backup in the library, so that is the kind of job it is.
    const { job, signal } = jobs.createOperation('backup', logEvent('job.fetchingRecoveryPoint', 'Fetching the recovery point from R2'));
    const meter = new TransferMeter();
    void fetchSnapshotToLibrary({
      profile, r2, backups, snapshotId, sourceProfileId, signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(job.id, percent, logEvent('job.fetchingChunks', `Fetching ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
    })
      // The archive it landed as, so the panel can offer to put it back rather
      // than leaving the reader to find it in the library themselves.
      .then(({ manifest }) => jobs.finishOperation(job.id, 'succeeded', null, { backupId: manifest.id }))
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'The recovery point could not be fetched'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/r2/legacy' && method === 'DELETE') {
    sendJson(response, 200, await r2.deleteLegacyObjects());
    return;
  }
  if (pathname === '/api/v1/r2/reconcile' && method === 'POST') {
    sendJson(response, 200, await r2.reconcile());
    return;
  }
  // One R2 backup now, whatever the clock says. It sends the whole profile
  // rather than the frequent subset, because someone asking for it by hand is
  // asking for a complete recovery point.
  if ((pathname === '/api/v1/r2/upload' || pathname === '/api/v1/r2/sync') && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before uploading to R2'); return; }
    // A first upload of a profile is gigabytes and many minutes. Answering it
    // synchronously meant the panel had an indeterminate bar and no way to
    // stop - indistinguishable from a hang, and the reasonable response to a
    // hang is to kill it, which is the one thing that makes it take longer.
    const { job, signal } = jobs.createOperation('backup', logEvent('job.sendingToR2', 'Sending to R2'));
    const meter = new TransferMeter();
    void syncProfileToR2({
      profile, backups, r2, tier: 'cold', signal,
      logger: (line) => jobs.append('backup', line),
      onProgress: (progress) => {
        const { percent, params } = meter.update(progress);
        jobs.updateOperation(job.id, percent, logEvent('job.sendingChunks', `Sending ${String(params.done)} of ${String(params.total)} - ${String(params.rate)}, ${String(params.eta)} left`, params));
      },
    })
      .then(() => jobs.finishOperation(job.id, 'succeeded', null))
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'The R2 backup failed'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/logs' && method === 'GET') {
    const afterValue = Number(searchParams.get('after') ?? 0);
    const sourceParam = searchParams.get('source') ?? 'all';
    if (!Number.isSafeInteger(afterValue) || afterValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
    if (!isLogSourceFilter(sourceParam)) { sendError(response, 400, 'invalid_source', 'The log source is invalid'); return; }
    const source = sourceParam === 'all' ? null : sourceParam;
    // `before` reads backwards through what is still retained, so a reader that
    // scrolls up can pull in older lines instead of only following new ones.
    const beforeParam = searchParams.get('before');
    if (beforeParam !== null) {
      const beforeValue = Number(beforeParam);
      const limitValue = Number(searchParams.get('limit') ?? LOG_LIMITS.historyEntries);
      if (!Number.isSafeInteger(beforeValue) || beforeValue < 0) { sendError(response, 400, 'invalid_cursor', 'The log cursor is invalid'); return; }
      if (!Number.isSafeInteger(limitValue) || limitValue < 1) { sendError(response, 400, 'invalid_limit', 'The log limit is invalid'); return; }
      sendJson(response, 200, jobs.logHistory(beforeValue, source, limitValue));
      return;
    }
    sendJson(response, 200, jobs.logs(afterValue, source));
    return;
  }
  if (pathname === '/api/v1/metrics' && method === 'GET') {
    const requestedDays = Number(searchParams.get('days') ?? 30);
    if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 90) {
      sendError(response, 400, 'invalid_metrics_range', 'Metrics range must be between 1 and 90 days');
      return;
    }
    sendJson(response, 200, await metrics.snapshot(new Date(), requestedDays));
    return;
  }
  if (pathname === '/api/v1/versions' && method === 'GET') {
    const versions = await runtime.listVersions();
    sendJson(response, 200, { versions });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'GET') {
    const [installations, active] = await Promise.all([runtime.listInstallations(), runtime.getActiveInstallation()]);
    // The active pointer travels with the page: it names a row that may not be
    // on it, and the panel needs it to mark the row wherever it turns up.
    sendList(response, 'installations', installations, searchParams, { searchText: installationSearchText, sortValue: installationSortValue }, { activeInstallationId: active?.id ?? null, activeJob: jobs.activeInstallation() });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'DELETE') {
    await supervisor.stop('uninstall');
    try {
      await runtime.removeInstallations();
    } catch (error: unknown) {
      if (error instanceof RuntimeError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    sendJson(response, 200, { ok: true, installations: [], activeInstallationId: null });
    return;
  }
  if (pathname === '/api/v1/installations' && method === 'POST') {
    const body = await readJson(request);
    const selector = isRecord(body) && typeof body.version === 'string' ? body.version : null;
    if (!selector || !isVersionSelector(selector)) {
      sendError(response, 400, 'invalid_version', 'A valid SillyTavern version must be selected');
      return;
    }
    try {
      const started = await beginInstallation({ runtime, jobs, supervisor, profiles, backups, r2, system }, selector as VersionSelector);
      sendJson(response, 202, { installationId: started.installationId, job: started.job });
    } catch (error: unknown) {
      if (error instanceof RuntimeError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  if (pathname === '/api/v1/profiles' && method === 'GET') {
    const activeInstallation = await runtime.getActiveInstallation();
    if (activeInstallation?.status === 'ready') await profiles.ensureDefault({ installationId: activeInstallation.id, runtimePath: activeInstallation.runtimePath });
    const items = await profiles.list();
    sendJson(response, 200, { profiles: items, activeProfileId: items.find((profile) => profile.active)?.id ?? null });
    return;
  }
  if (pathname === '/api/v1/profiles' && method === 'POST') {
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : '';
    const layout = isRecord(body) && (body.layout === 'data' || body.layout === 'public') ? body.layout as ProfileLayout : undefined;
    const requestedInstallationId = isRecord(body) && typeof body.installationId === 'string' ? body.installationId : null;
    const installation = requestedInstallationId ? await runtime.getInstallation(requestedInstallationId) : await runtime.getActiveInstallation();
    if (!installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'Install SillyTavern before creating a profile'); return; }
    try {
      const profile = await profiles.create({ ...(layout ? { layout } : {}), name, installationId: installation.id, runtimePath: installation.runtimePath });
      sendJson(response, 201, profile);
    } catch (error: unknown) {
      if (error instanceof ProfileError) { sendError(response, 400, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  const profileActivationMatch = /^\/api\/v1\/profiles\/([^/]+)\/activate$/u.exec(pathname);
  if (profileActivationMatch && method === 'POST') {
    const profile = await profiles.get(profileActivationMatch[1] ?? '');
    if (!profile) { sendError(response, 404, 'profile_not_found', 'Profile not found'); return; }
    const installation = await runtime.getInstallation(profile.installationId);
    if (!installation || installation.status !== 'ready') { sendError(response, 409, 'installation_required', 'The profile installation is not ready'); return; }
    const current = await profiles.getActive();
    await supervisor.stop('profileSwitch');
    let snapshot: Awaited<ReturnType<BackupStore['create']>> | null = null;
    try {
      if (current && current.id !== profile.id) snapshot = await backups.createSafetyCopy(current, { kind: 'before-switch' });
      await runtime.activateInstallation(installation.id);
      const activated = await profiles.activate(profile.id);
      const process = await supervisor.start();
      sendJson(response, 200, { profile: activated, process, safetySnapshot: snapshot });
    } catch (error: unknown) {
      if (error instanceof ProfileError) { sendError(response, 409, error.code, error.message); return; }
      throw error;
    }
    return;
  }
  if (pathname === '/api/v1/backups' && method === 'GET') {
    const activeProfile = await profiles.getActive();
    const list = activeProfile ? await backups.list(activeProfile.id) : [];
    sendList(response, 'backups', list, searchParams, { searchText: backupSearchText, sortValue: backupSortValue });
    return;
  }
  if (pathname === '/api/v1/backups' && method === 'POST') {
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before creating a backup'); return; }
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name : undefined;
    /*
     * Two things are asked for here. `scheduled` is "Back up now": the
     * automatic backup, taken without waiting for the schedule, which replaces
     * the previous automatic one like any other. Anything else is a manual
     * backup, kept until somebody deletes it.
     *
     * An automatic backup of data that has not changed since the newest backup
     * would be an identical archive, so it is not written; the reply says so.
     */
    const kind = isRecord(body) && body.kind === 'scheduled' ? 'scheduled' : 'manual';
    if (kind === 'scheduled') {
      const fingerprint = await backups.fingerprint(profile);
      const newest = (await backups.list(profile.id))
        .filter((manifest) => manifest.source === 'created')
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
      if (newest?.fingerprint === fingerprint) { sendJson(response, 200, { unchanged: true, backup: newest }); return; }
    }
    const { job, signal } = jobs.createOperation('backup', logEvent('job.preparingBackup', 'Preparing backup'));
    void backups.create(profile, {
      ...(name && kind === 'manual' ? { name } : {}),
      kind,
      signal,
      onProgress: ({ completed, total }) => jobs.updateOperation(job.id, total > 0 ? (completed / total) * 90 : 50, logEvent('job.compressingFiles', `Compressing files (${completed}/${total})`, { completed, total })),
    }).then((manifest) => { jobs.updateOperation(job.id, 95, logEvent('job.savingLibrary', 'Saving backup library')); jobs.finishOperation(job.id, 'succeeded', null); return manifest; })
      .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'Backup failed'));
    sendJson(response, 202, { jobId: job.id, job });
    return;
  }
  if (pathname === '/api/v1/backups/schedule' && method === 'GET') {
    sendJson(response, 200, { schedule: await backups.getSchedule() });
    return;
  }
  if (pathname === '/api/v1/backups/schedule' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.intervalMinutes !== 'number') { sendError(response, 400, 'invalid_backup_schedule', 'intervalMinutes must be a number'); return; }
    sendJson(response, 200, { schedule: await backups.setSchedule({ intervalMinutes: body.intervalMinutes }) });
    return;
  }
  if (pathname === '/api/v1/backups/import/chunk' && method === 'POST') {
    const uploadId = searchParams.get('uploadId') ?? '';
    const index = Number(searchParams.get('index') ?? '');
    const chunk = await backups.appendUploadChunk(uploadId, index, request);
    sendJson(response, 200, { ok: true, ...chunk });
    return;
  }
  if (pathname === '/api/v1/backups/import/chunk' && method === 'DELETE') {
    const uploadId = searchParams.get('uploadId') ?? '';
    await backups.removeUpload(uploadId);
    sendJson(response, 200, { ok: true });
    return;
  }
  if (pathname === '/api/v1/backups/import/finish' && method === 'POST') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.uploadId !== 'string' || typeof body.name !== 'string') {
      sendError(response, 400, 'invalid_upload', 'Upload id and file name are required');
      return;
    }
    const expectedBytes = typeof body.expectedBytes === 'number' ? body.expectedBytes : undefined;
    const archivePath = await backups.finishUpload(body.uploadId, expectedBytes);
    let retained = false;
    try {
      const profile = await profiles.getActive();
      if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before importing a backup'); return; }
      const imported = await backups.importArchive(profile, archivePath, body.name);
      retained = true;
      sendJson(response, 200, { ...imported.preview, backup: imported.manifest });
    } finally {
      if (!retained) await backups.removeTemporary(archivePath);
    }
    return;
  }
  const backupImportPreview = pathname === '/api/v1/backups/import/preview';
  const backupImportRestore = pathname === '/api/v1/backups/import/restore';
  if ((backupImportPreview || backupImportRestore) && method === 'POST') {
    const archivePath = await backups.saveUpload(request);
    let retained = false;
    try {
      const profile = await profiles.getActive();
      if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before importing a backup'); return; }
      const imported = await backups.importArchive(profile, archivePath, headerValue(request.headers['x-backup-name']));
      retained = true;
      if (backupImportPreview) { sendJson(response, 200, { ...imported.preview, backup: imported.manifest }); return; }
      const mode = headerValue(request.headers['x-restore-mode']);
      if (mode !== 'merge' && mode !== 'replace') { sendError(response, 400, 'invalid_restore_mode', 'Restore mode must be merge or replace'); return; }
      const libraryPath = await backups.getArchivePath(imported.manifest.id);
      if (!libraryPath) { sendError(response, 500, 'backup_archive_missing', 'The uploaded archive could not be stored'); return; }
      const result = await restoreWithProcess({ profile, backups, archivePath: libraryPath, mode, supervisor });
      sendJson(response, 200, result);
    } finally {
      if (!retained) await backups.removeTemporary(archivePath);
    }
    return;
  }
  const backupMatch = /^\/api\/v1\/backups\/([^/]+)(?:\/(preview|restore|download))?$/u.exec(pathname);
  if (backupMatch) {
    const id = backupMatch[1] ?? '';
    const manifest = await backups.get(id);
    if (!manifest) { sendError(response, 404, 'backup_not_found', 'Backup not found'); return; }
    const action = backupMatch[2];
    if (!action && method === 'DELETE') {
      await backups.remove(id);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (!action && (method === 'PUT' || method === 'PATCH')) {
      const body = await readJson(request);
      const name = isRecord(body) && typeof body.name === 'string' ? body.name : '';
      if (!name.trim()) { sendError(response, 400, 'invalid_backup_name', 'Backup name is required'); return; }
      sendJson(response, 200, await backups.rename(id, name));
      return;
    }
    const archivePath = await backups.getArchivePath(id);
    if (!archivePath) { sendError(response, 410, 'backup_archive_missing', 'The backup archive is missing'); return; }
    if (!action && method === 'GET') { sendJson(response, 200, manifest); return; }
    if (action === 'download' && method === 'GET') {
      const details = await stat(archivePath);
      response.statusCode = 200;
      response.setHeader('Content-Type', 'application/zip');
      response.setHeader('Content-Length', details.size.toString(10));
      response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(manifest.name)}`);
      createReadStream(archivePath).pipe(response);
      return;
    }
    const profile = await profiles.getActive();
    if (!profile) { sendError(response, 409, 'profile_required', 'Create or activate a profile before restoring a backup'); return; }
    if (action === 'preview' && method === 'POST') { sendJson(response, 200, await backups.preview(archivePath, profile.layout)); return; }
    if (action === 'restore' && method === 'POST') {
      const body = await readJson(request);
      const mode = isRecord(body) && (body.mode === 'merge' || body.mode === 'replace') ? body.mode : null;
      if (!mode) { sendError(response, 400, 'invalid_restore_mode', 'Restore mode must be merge or replace'); return; }
      const { job, signal } = jobs.createOperation('restore', logEvent('job.preparingRestore', 'Preparing restore'));
      void restoreWithProcess({ profile, backups, archivePath, mode, supervisor, signal, onProgress: (progress, step) => jobs.updateOperation(job.id, progress, step) })
        .then(() => jobs.finishOperation(job.id, 'succeeded', null))
        .catch((error: unknown) => jobs.finishOperation(job.id, 'failed', error instanceof Error ? error.message : 'Restore failed', { evenIfCanceled: error instanceof RestoreRollbackError, stepCode: error instanceof RestoreRollbackError ? 'job.rollbackFailed' : undefined }));
      sendJson(response, 202, { jobId: job.id, job });
      return;
    }
  }
  const installationMatch = /^\/api\/v1\/installations\/([^/]+)(?:\/(start|stop|restart))?$/u.exec(pathname);
  if (installationMatch) {
    const installation = await runtime.getInstallation(installationMatch[1] ?? '');
    if (!installation) { sendError(response, 404, 'installation_not_found', 'Installation not found'); return; }
    const action = installationMatch[2];
    if (method === 'GET' && !action) { sendJson(response, 200, installation); return; }
    if (action && method === 'POST') {
      if (action === 'start') { sendJson(response, 200, await supervisor.start()); return; }
      const state = action === 'stop' ? await supervisor.stop() : await supervisor.restart();
      sendJson(response, 200, state);
      return;
    }
  }
  if (pathname === '/api/v1/process' && method === 'GET') { sendJson(response, 200, supervisor.getState()); return; }
  if (pathname === '/api/v1/process/start' && method === 'POST') { sendJson(response, 200, await supervisor.start()); return; }
  // SillyTavern stopping does not close the door in front of it. The tunnel
  // publishes the access gateway, which stays up and says SillyTavern is not
  // answering yet - so the public address survives a stop, a restart and a
  // version switch instead of being replaced by a different random one.
  if (pathname === '/api/v1/process/stop' && method === 'POST') { sendJson(response, 200, await supervisor.stop('requested')); return; }
  if (pathname === '/api/v1/process/restart' && method === 'POST') { sendJson(response, 200, await supervisor.restart()); return; }
  /*
   * The tunnel, and the fixed address in front of it.
   *
   * The Worker's address is added here rather than kept by the tunnel manager,
   * which knows nothing about Cloudflare accounts and should not. The panel
   * shows the fixed one and keeps the tunnel's own beside it, because that is
   * where the traffic really goes and it is worth being able to see.
   */
  if (pathname === '/api/v1/tunnel' && method === 'GET') { sendJson(response, 200, await withProxyUrl(tunnel.getState(), proxy, 'sillyTavern')); return; }
  if (pathname === '/api/v1/tunnel' && method === 'PUT') {
    const body = await readJson(request);
    const mode = isRecord(body) && (body.mode === 'off' || body.mode === 'quick' || body.mode === 'named') ? body.mode : null;
    if (!mode) { sendError(response, 400, 'invalid_tunnel_mode', 'Tunnel mode must be off, quick, or named'); return; }
    /*
     * SillyTavern does not have to be running, or installed.
     *
     * What the tunnel publishes is the access gateway, which is up from the
     * moment the manager is - the comment above `/process/stop` says so, and it
     * is why a public address survives a stop, a restart and a version switch.
     * Refusing to open it until SillyTavern answers contradicted that: it made
     * the address depend on the one thing it was built not to depend on, and
     * left somebody setting a machine up unable to do the two steps in the
     * order that suits them. Opened early, the gateway answers that SillyTavern
     * is not there yet, and starts serving it the moment it is.
     *
     * The PIN is a different matter and still required: it is what stands
     * between the internet and the data, and there is no sense in which it can
     * wait.
     */
    if (mode !== 'off' && !gateway.getState().passwordConfigured) { sendError(response, 409, 'public_access_password_required', 'Set the SillyTavern password before opening a public tunnel'); return; }
    const state = mode === 'off' ? await tunnel.disable() : await tunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, await withProxyUrl(state, proxy, 'sillyTavern'));
    return;
  }
  /**
   * The console's own public link.
   *
   * Separate from the one above in every way that matters: it publishes the
   * console rather than the gateway, it has its own stored mode, and it waits
   * on the manager password rather than SillyTavern's. It does not wait on
   * SillyTavern running at all - the reason to open it is usually that the
   * platform's own address does not work, which is a problem the console has
   * whether or not anything is installed yet.
   */
  if (pathname === '/api/v1/manager-tunnel' && method === 'GET') { sendJson(response, 200, await withProxyUrl(managerTunnel.getState(), proxy, 'manager')); return; }
  if (pathname === '/api/v1/manager-tunnel' && method === 'PUT') {
    const body = await readJson(request);
    const mode = isRecord(body) && (body.mode === 'off' || body.mode === 'quick' || body.mode === 'named') ? body.mode : null;
    if (!mode) { sendError(response, 400, 'invalid_tunnel_mode', 'Tunnel mode must be off, quick, or named'); return; }
    // This link reaches the console, which installs software, reads the whole
    // data directory and holds the Cloudflare tokens. A password is the only
    // thing between it and whoever finds the address.
    if (mode !== 'off' && (await store.getPersisted()).adminPasswordHash === null) {
      sendError(response, 409, 'manager_password_required', 'Set the manager password before opening the console to the internet');
      return;
    }
    const state = mode === 'off' ? await managerTunnel.disable() : await managerTunnel.start(mode, isRecord(body) && typeof body.token === 'string' ? body.token : undefined);
    sendJson(response, 200, await withProxyUrl(state, proxy, 'manager'));
    return;
  }
  /*
   * What the manager does with SillyTavern when it starts.
   *
   * One switch, in its own route rather than folded into SillyTavern's own
   * settings: those are written into the runtime's config.yaml and belong to
   * the version installed, and this one belongs to the manager and outlives
   * every version it installs.
   */
  if (pathname === '/api/v1/startup' && method === 'GET') {
    const state = await store.getPersisted();
    sendJson(response, 200, { startup: { autoStartSillyTavern: state.autoStartSillyTavern } satisfies StartupSettings });
    return;
  }
  if (pathname === '/api/v1/startup' && method === 'PUT') {
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.autoStartSillyTavern !== 'boolean') {
      sendError(response, 400, 'invalid_input', 'autoStartSillyTavern must be true or false');
      return;
    }
    await store.setAutoStartSillyTavern(body.autoStartSillyTavern);
    sendJson(response, 200, { startup: { autoStartSillyTavern: body.autoStartSillyTavern } satisfies StartupSettings });
    return;
  }
  if (pathname === '/api/v1/system' && method === 'GET') {
    sendJson(response, 200, await system.snapshot());
    return;
  }
  if (pathname === '/api/v1/system/measure' && method === 'POST') {
    system.remeasure();
    sendJson(response, 202, await system.snapshot());
    return;
  }
  if (pathname === '/api/v1/jobs/active' && method === 'GET') {
    sendJson(response, 200, { job: jobs.activeOperation() });
    return;
  }
  const jobCancelMatch = /^\/api\/v1\/jobs\/([^/]+)\/cancel$/u.exec(pathname);
  if (jobCancelMatch && method === 'POST') {
    const id = jobCancelMatch[1] ?? '';
    if (!jobs.get(id)) { sendError(response, 404, 'job_not_found', 'Job not found'); return; }
    if (!jobs.cancel(id)) { sendError(response, 409, 'job_not_running', 'That job has already finished'); return; }
    sendJson(response, 200, jobs.get(id));
    return;
  }
  const jobMatch = /^\/api\/v1\/jobs\/([^/]+)$/u.exec(pathname);
  if (jobMatch && method === 'GET') {
    const job = jobs.get(jobMatch[1] ?? '');
    if (!job) { sendError(response, 404, 'job_not_found', 'Job not found'); return; }
    sendJson(response, 200, job);
    return;
  }
  if (PROTECTED_PATHS.has(pathname)) {
    sendError(response, 501, 'not_implemented', 'This manager feature is not available in Batch 3');
    return;
  }
  sendError(response, 404, 'not_found', 'Route not found');
}

/**
 * A tunnel's state with the fixed address in front of it attached.
 *
 * Null rather than absent when there is no Worker, so a panel can tell "no
 * fixed address" from "this manager does not know about them".
 */
async function withProxyUrl(state: TunnelState, proxy: ProxyWorkerManager | null, target: ProxyWorkerTarget): Promise<TunnelState> {
  return { ...state, proxyUrl: proxy ? await proxy.urlFor(target).catch(() => null) : null };
}

/** What starting an installation needs, whoever asked for it. */
interface InstallationDeps {
  readonly runtime: RuntimeManager;
  readonly jobs: JobStore;
  readonly supervisor: ProcessSupervisor;
  readonly profiles: ProfileStore;
  readonly backups: BackupStore;
  readonly r2: R2Manager;
  readonly system: SystemStore;
}

/**
 * Queue an installation and everything that has to happen around one.
 *
 * Its own function because there are two ways in now: somebody pressing
 * Install, and a manager that has just had its password set and has nothing
 * installed at all. Both need the same safety copy, the same rebinding, the
 * same recovery of an empty profile out of the bucket, and the same restart
 * afterwards - and a second copy of that would be a second chance to get one
 * of them wrong.
 *
 * Throws RuntimeError when an installation is already in flight; the caller
 * decides what that means for its own answer.
 */
async function beginInstallation(deps: InstallationDeps, selector: VersionSelector): Promise<{ installationId: string; job: Job }> {
  const { runtime, jobs, supervisor, profiles, backups, r2, system } = deps;
  const previousProfile = await profiles.getActive();
  const previousInstallation = await runtime.getActiveInstallation();
  let queuedId = '';
  let queued: { id: string; promise: Promise<Installation> };
  // Made here rather than by the job registry, because the work has to be
  // handed the signal at the moment it is queued and the job is named after
  // the installation the queue hands back.
  const stopping = new AbortController();
  try {
    /*
     * Stopping SillyTavern and copying the profile happen inside the job,
     * not inside this request.
     *
     * They used to run before the response was written, so a 202 meaning
     * "accepted, watch the progress" did not arrive until a full copy of the
     * profile had been written to disk - minutes, on a large one, with the
     * panel holding its confirmation dialog open and nothing on screen
     * saying a backup was being taken. The order of the work is unchanged;
     * only the reply no longer waits for it.
     */
    queued = runtime.queueInstall(
      selector,
      (progress) => jobs.updateFromProgress(queuedId, progress),
      async (report) => {
        await supervisor.stop('install');
        if (!previousProfile) return;
        await report(4, logEvent('install.safetyCopy', 'Copying your data before switching version'));
        await backups.createSafetyCopy(previousProfile, { kind: 'before-switch' });
      },
      stopping.signal,
    );
  } catch (error: unknown) {
    await supervisor.start().catch(() => supervisor.getState());
    throw error;
  }
  queuedId = queued.id;
  const job = jobs.create(queued.id, stopping);
  void queued.promise.then(async (installation) => {
    jobs.finish(queued.id, installation.status === 'ready' ? 'succeeded' : 'failed', installation.error);
    /*
     * Stopped, and put back the way it was found.
     *
     * The runtime has already taken out whatever this attempt wrote. What is
     * left is not to go on as if it had finished: no rebinding, no profile
     * recovered into an installation that does not exist, and SillyTavern
     * started again only when there was one before this to start.
     */
    if (installation.errorCode === INSTALL_CANCELED) {
      if (previousInstallation) await supervisor.start().catch(() => supervisor.getState());
      return;
    }
    if (installation.status === 'ready') {
      if (previousProfile) await profiles.rebind(previousProfile.id, installation.id, installation.runtimePath);
      else {
        // A first install on a machine that starts empty every time. If the
        // bucket holds what this machine used to have, it goes back now,
        // before SillyTavern is started on an empty profile.
        // The profile is made inside, so the slot is held before it exists
        // and the scheduler cannot find it half-restored.
        await recoverEmptyProfile(() => profiles.ensureDefault({ installationId: installation.id, runtimePath: installation.runtimePath }), r2, backups, jobs);
      }
      await runtime.cleanupLegacyRuntimeCopies?.(installation.id);
      // There is a profile now where a moment ago there was none, and on the
      // overview its size is the line somebody who has just installed is
      // watching. Walked now rather than on whatever poll next falls due.
      system.remeasure();
    }
    await supervisor.start();
  }).catch(async (error: unknown) => {
    jobs.finish(queued.id, 'failed', error instanceof Error ? error.message : 'Installation failed');
    // Putting SillyTavern back is best effort: this path only runs because
    // something already failed, and a second failure inside it rejected with
    // nobody listening - which ends the manager process and takes the console
    // down with it, leaving no way to install a different version.
    await supervisor.start().catch(() => supervisor.getState());
  });
  return { installationId: queued.id, job };
}

/** Each apply-phase step gets its own percentage so a slow phase still shows the bar moving. */
const RESTORE_STEP_PROGRESS: Record<string, number> = {
  'restore.restoringFiles': 85,
  'restore.removingObsolete': 87,
  'restore.finalizing': 88,
};

/**
 * A restore was stopped partway and could not be put back the way it was.
 *
 * The one outcome of a stop that leaves the profile mixed, so it is reported
 * as a failure even though the operator asked for the stop.
 */
export class RestoreRollbackError extends Error {
  public constructor(reason: string) {
    super(`The restore was stopped, and the data could not be put back as it was: ${reason}`);
    this.name = 'RestoreRollbackError';
  }
}

/**
 * Stop SillyTavern, take the safety copy, restore, and start it again.
 *
 * Stopped before any file is written, there is nothing to undo: the safety
 * copy is abandoned and the profile is untouched. Stopped while files are
 * being written, the profile is part old and part new, so the safety copy is
 * restored over it before SillyTavern comes back - a stop always leaves the
 * data the way it was before Restore was pressed. That undo is not itself
 * stoppable; stopping it would leave exactly the mixture it exists to remove.
 */
export async function restoreWithProcess(options: {
  readonly profile: Awaited<ReturnType<ProfileStore['getActive']>> & {};
  readonly backups: BackupStore;
  readonly archivePath: string;
  readonly mode: 'merge' | 'replace';
  readonly supervisor: ProcessSupervisor;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: number, step: LogEvent) => void;
}): Promise<{ preview: Awaited<ReturnType<BackupStore['restore']>>; safetySnapshot: Awaited<ReturnType<BackupStore['create']>>; process: ReturnType<ProcessSupervisor['getState']> }> {
  const { profile, backups, archivePath, mode, supervisor, signal, onProgress } = options;
  // Claim the backup store before stopping anything. Otherwise the scheduler's
  // next tick sees an idle store and starts a full backup that the restore then
  // has to wait out.
  const releaseOperationSlot = backups.reserve();
  onProgress?.(5, logEvent('job.stoppingSillyTavern', 'Stopping SillyTavern'));
  await supervisor.stop('restore');
  let safetyCopy: Awaited<ReturnType<BackupStore['create']>> | null = null;
  let writing = false;
  try {
    // A safety copy has to exist before the restore overwrites anything, but it
    // does not have to be a second copy of every file. Writing one compressed
    // archive is a single large sequential write; copying the tree file by file
    // measured 639 seconds on a ModelScope volume for the same data. It only
    // An unchanged profile can reuse the backup it already has.
    onProgress?.(15, logEvent('job.creatingSafetySnapshot', 'Creating safety snapshot'));
    const safetySnapshot = safetyCopy = await backups.createSafetyCopy(profile, {
      kind: 'before-restore',
      ...(signal ? { signal } : {}),
      onProgress: ({ completed, total }) => onProgress?.(15 + (total > 0 ? (completed / total) * 10 : 0), logEvent('job.backingUpCurrentData', `Backing up current data (${completed}/${total})`, { completed, total })),
    });
    onProgress?.(25, logEvent('job.restoringData', 'Restoring data'));
    writing = true;
    const preview = await backups.restore(profile, archivePath, {
      mode,
      ...(signal ? { signal } : {}),
      onProgress: ({ completed, total }) => onProgress?.(25 + (total > 0 ? (completed / total) * 60 : 60), logEvent('job.restoringFiles', `Restoring files (${completed}/${total})`, { completed, total })),
      onStatus: (step) => onProgress?.(RESTORE_STEP_PROGRESS[step.code] ?? 86, step),
    });
    onProgress?.(90, logEvent('job.startingSillyTavern', 'Starting SillyTavern'));
    const process = await supervisor.start();
    onProgress?.(100, logEvent('job.restoreComplete', 'Restore complete'));
    return { preview, safetySnapshot, process };
  } catch (error) {
    // Nothing was written, or what was written has been put back: the profile
    // is what the safety copy holds, so the copy is no longer a safety copy.
    const settle = async () => { if (safetyCopy) await backups.reclassifyAsScheduled(safetyCopy.id).catch(() => undefined); };
    if (!writing) await settle();
    if (writing && signal?.aborted && safetyCopy) {
      try {
        onProgress?.(88, logEvent('job.rollingBack', 'Putting the data back as it was before the restore'));
        const safetyPath = await backups.getArchivePath(safetyCopy.id);
        if (!safetyPath) throw new Error('the safety copy is missing');
        await backups.restore(profile, safetyPath, { mode: 'replace' });
        await settle();
      } catch (rollbackError: unknown) {
        await supervisor.start().catch(() => supervisor.getState());
        throw new RestoreRollbackError(rollbackError instanceof Error ? rollbackError.message : 'unknown error');
      }
    }
    await supervisor.start().catch(() => supervisor.getState());
    throw error;
  } finally {
    releaseOperationSlot();
  }
}

/**
 * Where SillyTavern keeps the reader's own files inside a profile.
 *
 * A profile written in the canonical layout holds them under default-user; the
 * legacy public/ layout is already that root itself.
 */
/**
 * An image the reader already owns, sent back to their own browser.
 *
 * Kept for a few minutes: it is their wallpaper and their character cards,
 * which do not change while they are looking at the overview, and re-reading
 * a megabyte off the disk on every visit to the page buys nothing.
 */
function sendImage(response: ServerResponse, image: { bytes: Buffer; contentType: string }): void {
  response.writeHead(200, {
    'content-type': image.contentType,
    'content-length': image.bytes.byteLength,
    'cache-control': 'private, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  });
  response.end(image.bytes);
}

function userDataRoot(profile: Profile): string {
  return profile.layout === 'data' ? join(profile.dataPath, 'default-user') : profile.dataPath;
}

function cloudflareConnectionFromEnvironment(paths: PlatformPaths, env: NodeJS.ProcessEnv): CloudflareConnection | null {
  const clientId = (env.STM_CLOUDFLARE_OAUTH_CLIENT_ID ?? DEFAULT_CLOUDFLARE_CLIENT_ID).trim();
  if (!clientId) return null;
  const redirectUri = env.STM_CLOUDFLARE_OAUTH_REDIRECT_URI?.trim() || DEFAULT_CLOUDFLARE_REDIRECT_URI;
  const scopes = env.STM_CLOUDFLARE_OAUTH_SCOPES?.split(/[\s,]+/u).filter(Boolean) ?? Object.values(DEFAULT_SCOPES);
  return new CloudflareConnection({ paths, client: { clientId, redirectUri, scopes } });
}

/**
 * Connect, choose an account, disconnect, and read where things stand.
 *
 * Whatever changes the connection also says what backups use: connecting makes
 * the signed-in bucket the one backed up to, and disconnecting it switches R2
 * backups off rather than leaving them failing on a schedule.
 */
async function handleCloudflareRequest(context: RequestContext, cloudflare: CloudflareConnection | null, r2: R2Manager, proxy: ProxyWorkerManager | null, publishProxies: () => void, logger: LogSink): Promise<void> {
  const { pathname, request, response } = context;
  const method = request.method ?? 'GET';
  if (!cloudflare) { sendError(response, 404, 'cloudflare_not_available', 'This manager has no Cloudflare sign-in configured'); return; }
  if (pathname === '/api/v1/r2/cloudflare' && method === 'GET') {
    sendJson(response, 200, { cloudflare: await cloudflare.status() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/connect' && method === 'POST') {
    // The origin the panel is open on, so the relay can send the browser back
    // to the same place - this machine, the LAN address or the tunnel. A
    // port-forwarding proxy leaves the loopback address it connects to in both
    // headers, so a known outside address is taken over what they say.
    const origin = context.publicOrigins[0] ?? headerValue(request.headers.origin) ?? `http://${headerValue(request.headers.host) ?? 'localhost'}`;
    let returnOrigin: string;
    try { returnOrigin = new URL(origin).origin; } catch { sendError(response, 400, 'invalid_origin', 'The panel origin could not be read'); return; }
    sendJson(response, 200, { url: cloudflare.beginConnect(returnOrigin) });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/buckets' && method === 'GET') {
    // The account's buckets, so the panel can offer them rather than ask the
    // user to type a name that has to match one exactly.
    sendJson(response, 200, { buckets: await cloudflare.listBuckets() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/bucket' && method === 'POST') {
    const body = await readJson(request);
    const name = isRecord(body) && typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) { sendError(response, 400, 'invalid_bucket', 'A bucket name is required'); return; }
    const status = await cloudflare.chooseBucket(name);
    sendJson(response, 200, { cloudflare: status, config: await r2.getConfig() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/account' && method === 'POST') {
    const body = await readJson(request);
    const accountId = isRecord(body) && typeof body.accountId === 'string' ? body.accountId : '';
    if (!/^[0-9a-f]{32}$/u.test(accountId)) { sendError(response, 400, 'invalid_account', 'A Cloudflare account ID is required'); return; }
    const status = await cloudflare.chooseAccount(accountId, await r2.keysBucket());
    if (status.state === 'connected') {
      await r2.update({ mode: 'cloudflare', enabled: true });
      // There is somewhere to put the fixed addresses now. Not waited for: a
      // deploy takes seconds and the reader is waiting to see their account
      // connected, not to see two Workers appear.
      publishProxies();
    }
    sendJson(response, 200, { cloudflare: status, config: await r2.getConfig() });
    return;
  }
  if (pathname === '/api/v1/r2/cloudflare/disconnect' && method === 'POST') {
    /*
     * The Workers go before the grant does, because afterwards there is no
     * grant to remove them with.
     *
     * Signing out has to leave nothing of ours behind in somebody's account -
     * a Worker nobody can explain, still answering on their own subdomain, is
     * the worst thing to find there. Best effort all the same: a removal that
     * fails must not stop the sign-out the reader asked for, and the Worker
     * that is left is one they can delete in the dashboard.
     */
    const account = proxy ? await cloudflare.workersAccount().catch(() => null) : null;
    if (proxy && account) {
      for (const target of PROXY_WORKER_TARGETS) {
        await proxy.remove(account.id, target).catch((error: unknown) => {
          logger(logEvent('cloudflare.proxyRemoveFailed', `[cloudflare] a fixed address Worker could not be removed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
          return false;
        });
      }
    }
    const result = await cloudflare.disconnect();
    await proxy?.forget().catch(() => undefined);
    if ((await r2.getConfig()).mode === 'cloudflare') await r2.update({ enabled: false });
    sendJson(response, 200, { ...result, config: await r2.getConfig() });
    return;
  }
  sendError(response, 404, 'not_found', 'Route not found');
}

/**
 * Where the browser lands after Cloudflare, straight or through the relay.
 *
 * It is a page load, not an API call, so it answers with a redirect to the
 * panel carrying the outcome. The session cookie is `SameSite=Lax`, which a
 * top-level navigation back from Cloudflare still carries, so only a signed-in
 * admin can finish connecting this manager.
 */
async function handleCloudflareCallback(context: RequestContext, sessions: SessionStore, cloudflare: CloudflareConnection | null, r2: R2Manager, logger: LogSink): Promise<void> {
  const { response, searchParams } = context;
  const redirect = (outcome: string, code?: string): void => {
    const query = new URLSearchParams({ cloudflare: outcome, ...(code ? { cloudflare_error: code } : {}) });
    response.writeHead(303, {
      location: `/?${query.toString()}#data`,
      'cache-control': 'no-store',
      // The address this was reached at holds the authorization code.
      'referrer-policy': 'no-referrer',
    });
    response.end();
  };
  if (!cloudflare) { redirect('error', 'cloudflare_not_available'); return; }
  if (!sessions.get(context.sessionToken)) { redirect('error', 'login_required'); return; }
  try {
    const status = await cloudflare.completeConnect({
      state: searchParams.get('state') ?? '',
      code: searchParams.get('code'),
      error: searchParams.get('error'),
      errorDescription: searchParams.get('error_description'),
    }, await r2.keysBucket());
    if (status.state === 'connected') await r2.update({ mode: 'cloudflare', enabled: true });
    redirect(status.state);
  } catch (error: unknown) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'cloudflare_connect_failed';
    logger(logEvent('r2.cloudflareConnectFailed', `[r2] connecting to Cloudflare failed: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    redirect('error', code);
  }
}

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PATHS.has(pathname)
    || pathname.startsWith('/api/v1/installations/')
    || pathname.startsWith('/api/v1/jobs/')
    || pathname.startsWith('/api/v1/logs')
    || pathname.startsWith('/api/v1/process')
    || pathname.startsWith('/api/v1/profiles/')
    || pathname.startsWith('/api/v1/backups/')
    || pathname.startsWith('/api/v1/r2/')
    || pathname.startsWith('/api/v1/config/');
}

function parseConfigUpdateInput(value: unknown): ConfigUpdateInput {
  if (!isRecord(value)) throw new RequestError(400, 'invalid_input', 'A configuration update is required');
  if (typeof value.rawYaml === 'string') return { rawYaml: value.rawYaml };
  const settings = value.settings;
  if (!isRecord(settings)) throw new RequestError(400, 'invalid_input', 'Configuration settings are required');
  const flags = [
    'lazyLoadCharacters', 'useDiskCache', 'requestCompression',
    'extensions', 'extensionAutoUpdate', 'allowKeysExposure', 'chatBackups',
  ] as const;
  const input: Record<string, unknown> = {};
  for (const flag of flags) if (typeof settings[flag] === 'boolean') input[flag] = settings[flag];
  if (typeof settings.memoryCacheCapacity === 'string') input.memoryCacheCapacity = settings.memoryCacheCapacity;
  if (typeof settings.chatBackupCount === 'number') input.chatBackupCount = settings.chatBackupCount;
  // The values themselves are checked where they are written, so one rule
  // covers the console, a stray API call and a restored profile alike.
  return { settings: input as NonNullable<ConfigUpdateInput['settings']> };
}

async function decorateConfig(document: Awaited<ReturnType<ConfigStore['read']>>): Promise<Awaited<ReturnType<ConfigStore['read']>>> {
  const host = await networkHost();
  return host ? { ...document, networkHost: host } : document;
}

/**
 * This machine's address on the network around it, or nothing when it has none.
 *
 * The panel asks for it with the configuration; the banner printed at startup
 * asks for it too, and the two must not disagree about which of several
 * adapters is the real one.
 */
export async function networkHost(): Promise<string | undefined> {
  return preferredNetworkHost(Object.values(networkInterfaces()).flatMap((entries) => entries ?? []), await routedAddress());
}

/**
 * The address another device on this network can actually reach.
 *
 * Taking the first non-loopback address found handed out 169.254.83.107 - a
 * link-local address a virtual adapter assigned itself when nothing answered
 * it. Preferring a private range instead handed out 192.168.137.1, the Windows
 * Mobile Hotspot adapter: just as private, and just as useless for reaching
 * this machine from the Wi-Fi everything else is on. Either way the LAN link
 * and the code to scan pointed somewhere unreachable, which looks exactly like
 * the feature not working.
 *
 * So `routed` decides it when it is known: the address of the interface the
 * operating system itself would use to leave this machine, which is the one
 * the phone in the same room shares. The ranges are only the fallback.
 */
export function preferredNetworkHost(entries: ReadonlyArray<{ family: string | number; internal: boolean; address: string }>, routed?: string | undefined): string | undefined {
  const candidates = entries
    .filter((entry) => (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => entry.address)
    // Self-assigned when no address was ever handed out, so nothing routes to it.
    .filter((address) => !address.startsWith('169.254.'));
  if (routed && candidates.includes(routed)) return routed;
  const isPrivate = (address: string): boolean => {
    if (address.startsWith('192.168.') || address.startsWith('10.')) return true;
    const second = Number(address.split('.')[1]);
    return address.startsWith('172.') && second >= 16 && second <= 31;
  };
  return candidates.find(isPrivate) ?? candidates[0];
}

/**
 * Which interface this machine leaves by, without sending anything.
 *
 * Connecting a UDP socket transmits no packet; it only makes the operating
 * system choose the route, and the local address it picked is then readable.
 * Nothing here depends on that address being reachable or even existing.
 */
async function routedAddress(): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const socket = createSocket('udp4');
    let settled = false;
    const finish = (address?: string): void => {
      if (settled) return;
      settled = true;
      try { socket.close(); } catch { /* already closed */ }
      resolve(address && address !== '0.0.0.0' ? address : undefined);
    };
    const timer = setTimeout(() => finish(), 300);
    timer.unref?.();
    socket.once('error', () => finish());
    try {
      socket.connect(53, '8.8.8.8', () => {
        let address: string | undefined;
        try { address = socket.address().address; } catch { /* nothing bound */ }
        clearTimeout(timer);
        finish(address);
      });
    } catch { finish(); }
  });
}

function isVersionSelector(value: string): boolean {
  return value === 'latest' || value === 'release' || value === 'staging' || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(value);
}

function isLogSourceFilter(value: string): value is LogSourceFilter {
  return value === 'all' || value === 'manager' || value === 'sillytavern' || value === 'cloudflared' || value === 'installer' || value === 'backup';
}

async function handlePasswordSetup(
  context: RequestContext,
  store: StateStore,
  sessions: SessionStore,
  rateLimiter: RateLimiter,
  secureCookies: boolean,
  /** Run once the password is saved, after the answer is on its way back. */
  afterSetup?: () => Promise<void>,
): Promise<void> {
  if (!checkRateLimit(context, rateLimiter)) {
    return;
  }
  const state = await store.getPersisted();
  if (state.adminPasswordHash) {
    sendError(context.response, 409, 'already_configured', 'The manager admin password is already configured');
    return;
  }
  const body = await readJson(context.request);
  if (!isRecord(body)) {
    sendError(context.response, 400, 'invalid_input', 'A JSON object is required');
    return;
  }
  const password = body.password;
  const passwordError = validatePassword(password);
  if (passwordError) {
    sendError(context.response, 400, 'invalid_password', passwordError);
    return;
  }
  if (typeof password !== 'string') {
    sendError(context.response, 400, 'invalid_password', 'Password is required');
    return;
  }
  if (body.termsAccepted !== true || body.telemetryAccepted !== true) {
    sendError(context.response, 400, 'notice_acceptance_required', 'Terms and the telemetry notice must be accepted');
    return;
  }
  const saved = await store.saveAdminPassword(hashPassword(password));
  if (!saved) {
    sendError(context.response, 409, 'already_configured', 'The manager admin password is already configured');
    return;
  }
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, secureCookies));
  const session = created.session;
  sendJson(context.response, 201, { ok: true, setupRequired: false, session });
  // After the answer, not before it: what follows takes minutes, and the
  // reader is waiting to be let into the console.
  if (afterSetup) await afterSetup().catch(() => undefined);
}

async function handleLogin(
  context: RequestContext,
  store: StateStore,
  sessions: SessionStore,
  rateLimiter: RateLimiter,
  secureCookies: boolean,
): Promise<void> {
  if (!checkRateLimit(context, rateLimiter)) {
    return;
  }
  const state = await store.getPersisted();
  if (!state.adminPasswordHash) {
    sendError(context.response, 409, 'setup_required', 'Create the manager admin password first');
    return;
  }
  const body = await readJson(context.request);
  const password = isRecord(body) && typeof body.password === 'string' ? body.password : '';
  if (!verifyPassword(password, state.adminPasswordHash)) {
    sendError(context.response, 401, 'invalid_credentials', 'The password is incorrect');
    return;
  }
  const created = sessions.create();
  context.response.setHeader('Set-Cookie', sessionCookie(created.token, secureCookies));
  sendJson(context.response, 200, { ok: true, session: created.session });
}

function requireSession(context: RequestContext, sessions: SessionStore): { csrfToken: string } | null {
  const session = sessions.get(context.sessionToken);
  if (!session) {
    sendError(context.response, 401, 'unauthorized', 'Manager admin authentication is required');
    return null;
  }
  return session;
}

function requireCsrf(context: RequestContext, csrfToken: string): boolean {
  const supplied = headerValue(context.request.headers['x-csrf-token']);
  if (!supplied || !constantTimeStringEqual(supplied, csrfToken)) {
    sendError(context.response, 403, 'csrf_failed', 'A valid CSRF token is required');
    return false;
  }
  return true;
}

function checkRateLimit(context: RequestContext, rateLimiter: RateLimiter): boolean {
  const key = context.request.socket.remoteAddress ?? 'unknown';
  const result = rateLimiter.check(key);
  if (!result.allowed) {
    context.response.setHeader('Retry-After', result.retryAfterSeconds.toString(10));
    sendError(context.response, 429, 'rate_limited', 'Too many attempts; try again later');
    return false;
  }
  return true;
}

function isTrustedOrigin(request: IncomingMessage, platform: PlatformPaths['platform'], publicOrigins: readonly string[]): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) {
    return true;
  }
  if (origin === 'null') {
    return false;
  }
  try {
    const parsed = new URL(origin);
    const host = headerValue(request.headers.host);
    if (host && parsed.host === host) return true;
    // A port-forwarding proxy rewrites `Host` to the loopback address it
    // connects to, so the panel's own origin no longer matches it.
    if (publicOrigins.includes(parsed.origin)) return true;
    // A proxy that rewrites `Host` is meant to leave the address the browser
    // actually used here. Believing it costs nothing a browser can spend: a
    // page on another site cannot put this header on a request without asking
    // permission first, in a preflight this console never grants.
    const forwardedHost = forwardedValue(request, 'x-forwarded-host');
    if (forwardedHost && parsed.host === forwardedHost) return true;
    return platform === 'modelscope' && isModelScopeOrigin(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the browser reached the console over HTTPS.
 *
 * Not the same question as whether this process is speaking TLS. A console on
 * a hosting platform is behind a proxy that terminates HTTPS and forwards plain
 * HTTP over the loopback, so the connection here is the insecure half of a
 * secure request, and the header the proxy adds is the only record of the other
 * half. It decides whether the session cookie may say `Secure`, and with it
 * whether the cookie survives being read inside a frame.
 */
function requestIsSecure(request: IncomingMessage): boolean {
  const forwarded = forwardedValue(request, 'x-forwarded-proto');
  if (forwarded) return forwarded === 'https';
  return 'encrypted' in request.socket;
}

/**
 * The first entry of a forwarded header.
 *
 * Each proxy a request passes through appends its own, so a chain arrives as
 * `https, http` - and the first is the one the browser used, which is the only
 * one any of this cares about.
 */
function forwardedValue(request: IncomingMessage, header: 'x-forwarded-host' | 'x-forwarded-proto'): string | null {
  const raw = headerValue(request.headers[header]);
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim().toLowerCase();
  return first ? first : null;
}

/**
 * The address the panel is reached at from outside, when the request cannot say.
 *
 * A manager behind a port-forwarding proxy sees `Host` rewritten to the loopback
 * address the proxy connects to; GitHub Codespaces rewrites `Origin` to match,
 * which leaves nothing in the request that names the address the browser used.
 * The Cloudflare sign-in would then be sent back to a loopback address that is
 * not the reader's machine. `STM_PUBLIC_ORIGIN` settles it for any proxy, and a
 * Codespace already names itself in the environment.
 */
export function publicOriginFromEnvironment(env: NodeJS.ProcessEnv, port: number): EnvironmentOrigin | null {
  const configured = env.STM_PUBLIC_ORIGIN?.trim();
  if (configured) {
    let parsed: URL;
    try { parsed = new URL(configured); } catch { throw new Error(`STM_PUBLIC_ORIGIN is not a valid URL: ${configured}`); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`STM_PUBLIC_ORIGIN must be an http or https address: ${configured}`);
    }
    return { origin: parsed.origin, source: 'configured' };
  }
  const codespace = env.CODESPACE_NAME?.trim();
  const forwardingDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (codespace && forwardingDomain) {
    return { origin: `https://${codespace}-${port.toString(10)}.${forwardingDomain}`, source: 'platform' };
  }
  return null;
}

function isModelScopeOrigin(hostname: string): boolean {
  return hostname === 'modelscope.ai'
    || hostname.endsWith('.modelscope.ai')
    || hostname === 'ms.fun'
    || hostname.endsWith('.ms.fun');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_JSON_BYTES) {
      throw new RequestError(413, 'payload_too_large', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'invalid_json', 'Request body must be valid JSON');
  }
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) {
    return;
  }
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(body);
}

/**
 * Answer a list request, paged only if it asked to be.
 *
 * A caller that sends no paging parameters gets the whole list and a `page`
 * block describing it as one page - which is what every caller in the panel
 * did before this existed, and what the overview still does when it wants the
 * most recent backup out of the list. Quietly starting to answer those with
 * the first ten rows would hide data nobody asked to hide.
 */
function sendList<Row>(
  response: ServerResponse,
  key: string,
  rows: readonly Row[],
  searchParams: URLSearchParams,
  options: { searchText: (row: Row) => string; sortValue: (row: Row, column: string) => string | number | boolean | null | undefined },
  extra: Record<string, unknown> = {},
): void {
  const query = parseTableQuery(searchParams);
  if (!query) {
    sendJson(response, 200, {
      [key]: rows,
      // Unpaged, the page holds everything - but never a size of zero, which
      // is a division waiting to happen in whatever reads this next.
      page: { page: 1, pageSize: Math.max(rows.length, 1), total: rows.length, pageCount: 1 },
      ...extra,
    });
    return;
  }
  const result = applyQuery(rows, query, options);
  sendJson(response, 200, { [key]: result.rows, page: pageInfo(result, query.pageSize), ...extra });
}

function sendError(response: ServerResponse, statusCode: number, code: string, message: string): void {
  const body: ApiErrorBody = { error: { code, message } };
  sendJson(response, statusCode, body);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}


interface SettlePortOptions {
  readonly resolved: ResolvedPort;
  readonly host: string;
  readonly reserved: readonly number[];
  readonly onMove: (from: number, to: number) => void;
  readonly onDemandedTaken: (port: number) => void;
}

/**
 * The port to actually use, once the machine has had a say.
 *
 * A port somebody wrote down, or that the host published, is used whether or
 * not it is free: it is the only address that works, so binding it and failing
 * says what is wrong, while quietly listening elsewhere would not. A port that
 * is only this project's own preference moves out of the way instead, because
 * nothing outside this process knows that number yet.
 */
async function settlePort(options: SettlePortOptions): Promise<number> {
  const { port, source } = options.resolved;
  if (await isPortFree(port, options.host)) return port;
  if (portWasDemanded(source)) {
    options.onDemandedTaken(port);
    return port;
  }
  const moved = await findFreePort(port + 1, { reserved: options.reserved, host: options.host });
  // Nothing free in range is a machine no retry here can improve, so the
  // preferred port goes ahead and reports its own failure in the usual place.
  if (moved === null) return port;
  options.onMove(port, moved);
  return moved;
}

/**
 * Put a profile that has nothing in it back from the bucket, if it can be.
 *
 * Called wherever a default profile has just been settled and before
 * SillyTavern is started on it. On a machine that keeps its disk this does
 * nothing after the first install, because the profile is never empty again.
 * On a machine that does not, it is the difference between coming back to
 * yesterday's chats and coming back to a new installation.
 *
 * Restored straight into the profile rather than through the path the panel
 * uses, which stops SillyTavern and takes a safety copy first: SillyTavern is
 * not running yet at either call site, and a safety copy of an empty profile is
 * a slow way to archive nothing.
 */
/**
 * Say that the bucket holds data this machine has not got, before it is asked.
 *
 * Costs one listing, and only on a start with nothing installed, which is the
 * one start where it answers a question somebody is about to have.
 */
async function announceRecoverable(r2: R2Manager, logger: LogSink): Promise<void> {
  try {
    const config = await r2.getConfig();
    if (!config.enabled || !config.configured) return;
    const snapshots = await r2.listSnapshots();
    const newest = snapshots[0];
    if (!newest) return;
    logger(logEvent('r2.awaitingInstall', `[r2] the bucket holds ${snapshots.length} recovery point(s), the newest from ${newest.createdAt}; installing SillyTavern brings the newest one back automatically`, { count: snapshots.length, createdAt: newest.createdAt }));
  } catch {
    // A bucket that cannot be reached on the way up is not worth a line here:
    // the console is about to be open, and it says so there.
  }
}

async function recoverEmptyProfile(settle: () => Promise<Profile>, r2: R2Manager, backups: BackupStore, jobs: JobStore): Promise<void> {
  /*
   * The backup slot is held from before the profile exists.
   *
   * Bringing a profile back takes a minute or two of downloading, and the
   * scheduler ticks every minute. Without this it woke up in the middle of one,
   * found a profile holding the four files that had arrived so far, and wrote
   * that to the bucket as a recovery point - which is then the newest one
   * there, and the one the next wiped machine would be given back. A backup of
   * a profile caught mid-restore is worse than no backup: it is the shape of
   * the reader's data with nothing in it.
   *
   * Reserved rather than queued: the restore inside this takes the slot itself,
   * and waiting for a slot this already holds would wait forever.
   */
  const release = backups.reserve();
  try {
    const profile = await settle();
    const config = await r2.getConfig();
    // Nowhere to recover from. On a machine that is wiped between runs this is
    // the case where the R2 settings went with everything else, which is why the
    // ones that survive - from the environment - are the ones that matter here.
    if (!config.enabled || !config.configured) return;
    const restored = await recoverProfileFromR2({
      profile, r2, backups,
      logger: (line) => jobs.append('backup', line),
      restore: async (archivePath) => { await backups.restore(profile, archivePath, { mode: 'replace' }); },
    });
    // Nobody was watching while this ran. The card says it happened, and says it
    // of the recovery point rather than of the archive that carried it here:
    // when the data was taken is what the reader is trying to work out.
    if (restored) await r2.recordRecovery({ createdAt: restored.point.createdAt, fileCount: restored.manifest.fileCount, sizeBytes: restored.manifest.sizeBytes });
  } finally {
    release();
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function servePanel(request: IncomingMessage, response: ServerResponse, pathname: string, staticRoot: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendError(response, 405, 'method_not_allowed', 'Only GET is supported for the manager panel');
    return;
  }
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendError(response, 400, 'invalid_path', 'The requested path is invalid');
    return;
  }
  const candidate = resolve(staticRoot, `.${decodedPath === '/' ? '/index.html' : decodedPath}`);
  const relativeCandidate = relative(staticRoot, candidate);
  if (relativeCandidate.startsWith('..') || relativeCandidate.includes(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    sendError(response, 404, 'not_found', 'Route not found');
    return;
  }

  let filePath = candidate;
  try {
    const details = await stat(filePath);
    if (!details.isFile()) {
      throw new Error('Not a file');
    }
  } catch {
    filePath = join(staticRoot, 'index.html');
    try {
      const details = await stat(filePath);
      if (!details.isFile()) {
        throw new Error('Panel entry is not a file');
      }
    } catch {
      sendError(response, 404, 'panel_unavailable', 'The manager panel has not been built yet');
      return;
    }
  }

  const body = await readFile(filePath);
  response.statusCode = 200;
  response.setHeader('Content-Type', contentTypeFor(filePath));
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', cacheControlFor(filePath));
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  response.end(body);
}

/**
 * How long the browser may keep a static file.
 *
 * Only the bundler's output carries a content hash in its name, so only it can
 * be kept forever. The brand icons and the manifest keep their names across
 * every release, and a year-long `immutable` on those meant a changed icon was
 * never picked up again on a machine that had loaded the old one once.
 */
function cacheControlFor(filePath: string): string {
  if (filePath.endsWith('index.html')) return 'no-cache';
  const inBundle = filePath.includes(`${sep}assets${sep}`);
  return inBundle ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
}

function contentTypeFor(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extension] ?? 'application/octet-stream';
}

class JobStore {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();

  public constructor(private readonly logBuffer = new LogBuffer()) {}

  public append(source: LogEntry['source'], line: LogLine, level: LogEntry['level'] = 'info'): void {
    this.logBuffer.append(source, line, level);
  }

  public logs(after: number, source: LogEntry['source'] | null): { entries: LogEntry[]; nextCursor: number } {
    return this.logBuffer.read(after, source);
  }

  public logHistory(before: number, source: LogEntry['source'] | null, limit: number): { entries: LogEntry[]; hasMore: boolean } {
    return this.logBuffer.readBefore(before, source, limit);
  }

  /**
   * An installation job, and the controller that stops it.
   *
   * A first install is a Git fetch, an `npm install` and a start of
   * SillyTavern - minutes, and a good deal more than that on a phone. It used
   * to be the one long job in this manager with no way out of it: a restore or
   * an upload could be stopped, and the thing somebody is most likely to have
   * started by mistake could not.
   */
  public create(installationId: string, controller?: AbortController): Job {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${installationId}`,
      kind: 'installation',
      state: 'running',
      progress: 0,
      step: 'Starting installation',
      stepCode: 'install.starting',
      installationId,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.jobs.set(job.id, job);
    if (controller) this.controllers.set(job.id, controller);
    return job;
  }

  /**
   * Start an operation the operator can stop.
   *
   * A restore or a large upload runs for minutes in the server, and until now
   * the only way out of one started by mistake was to kill the manager. The
   * returned signal is what the work watches.
   */
  public createOperation(kind: 'backup' | 'restore', step: LogEvent): { job: Job; signal: AbortSignal } {
    const now = new Date().toISOString();
    const job: Job = {
      id: `job-${randomUUID()}`,
      kind,
      state: 'running',
      progress: 0,
      step: step.message,
      stepCode: step.code,
      ...(step.params ? { stepParams: step.params } : {}),
      installationId: null,
      createdAt: now,
      updatedAt: now,
      error: null,
    };
    this.jobs.set(job.id, job);
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    return { job, signal: controller.signal };
  }

  /** Ask a running operation to stop. False when there is nothing to stop. */
  public cancel(id: string): boolean {
    const current = this.jobs.get(id);
    const controller = this.controllers.get(id);
    if (!current || !controller || current.state !== 'running') return false;
    controller.abort();
    this.jobs.set(id, { ...current, step: 'Stopping', stepCode: 'job.stopping', updatedAt: new Date().toISOString() });
    return true;
  }

  public wasCanceled(id: string): boolean { return this.controllers.get(id)?.signal.aborted === true; }

  public get(id: string): Job | null { return this.jobs.get(id) ?? null; }

  /**
   * The backup or restore a reloading panel should reattach to.
   *
   * A restore runs for minutes in the server, not the browser, so a reload
   * must not look like nothing is happening - the operator would start it
   * again on top of the one already running.
   */
  /**
   * The installation that is running, for a panel that did not start it.
   *
   * A reloaded page, or one that came back to a manager which installed
   * SillyTavern by itself on first run: both need the job to follow, and to
   * stop it if they want to.
   */
  public activeInstallation(): Job | null {
    for (const job of this.jobs.values()) if (job.state === 'running' && job.kind === 'installation') return job;
    return null;
  }

  public activeOperation(): Job | null {
    let newest: Job | null = null;
    for (const job of this.jobs.values()) {
      if (job.state !== 'running' || (job.kind !== 'backup' && job.kind !== 'restore')) continue;
      if (!newest || job.createdAt > newest.createdAt) newest = job;
    }
    return newest;
  }

  public updateFromProgress(installationId: string, progress: InstallationProgress): void {
    const id = `job-${installationId}`;
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, progress: progress.progress, step: progress.step.message, stepCode: progress.step.code, ...(progress.step.params ? { stepParams: progress.step.params } : {}), updatedAt: new Date().toISOString() });
  }

  public finish(installationId: string, state: 'succeeded' | 'failed', error: string | null): void {
    const id = `job-${installationId}`;
    const current = this.jobs.get(id);
    if (!current) return;
    // Asked for, so it is not a failure and carries no error to explain.
    const settled: JobState = state === 'failed' && this.wasCanceled(id) ? 'canceled' : state;
    this.controllers.delete(id);
    this.jobs.set(id, {
      ...current,
      state: settled,
      progress: settled === 'succeeded' ? 100 : current.progress,
      step: settled === 'succeeded' ? 'Installation ready' : settled === 'canceled' ? 'Installation stopped' : 'Installation failed',
      stepCode: settled === 'succeeded' ? 'install.ready' : settled === 'canceled' ? 'install.canceled' : 'install.failed',
      error: settled === 'canceled' ? null : error,
      updatedAt: new Date().toISOString(),
    });
  }

  public updateOperation(id: string, progress: number, step: LogEvent): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, progress: Math.max(0, Math.min(100, Math.round(progress))), step: step.message, stepCode: step.code, ...(step.params ? { stepParams: step.params } : {}), updatedAt: new Date().toISOString() });
  }

  /**
   * `evenIfCanceled` keeps a failure that happened after a stop reported as one.
   * `backupId` names an archive the job produced, for a panel that has to act on it.
   */
  public finishOperation(id: string, state: 'succeeded' | 'failed', error: string | null, options: { readonly evenIfCanceled?: boolean; readonly stepCode?: string | undefined; readonly backupId?: string | undefined } = {}): void {
    const current = this.jobs.get(id);
    if (!current) return;
    const settled: JobState = state === 'failed' && this.wasCanceled(id) && !options.evenIfCanceled ? 'canceled' : state;
    const step = settled === 'succeeded' ? 'Completed' : settled === 'canceled' ? 'Stopped' : 'Failed';
    const stepCode = options.stepCode ?? (settled === 'succeeded' ? 'job.completed' : settled === 'canceled' ? 'job.stopped' : 'job.failed');
    this.controllers.delete(id);
    this.jobs.set(id, { ...current, state: settled, progress: settled === 'succeeded' ? 100 : current.progress, step, stepCode, ...(options.backupId ? { resultBackupId: options.backupId } : {}), error: settled === 'canceled' ? null : error, updatedAt: new Date().toISOString() });
  }
}

class RequestError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  public constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const managerPorts: ManagerPorts = {
  access: ACCESS_GATEWAY_PORT,
  manager: MANAGER_PORT,
  sillyTavern: SILLYTAVERN_PORT,
};

export const minimumAdminPasswordLength = MIN_PASSWORD_LENGTH;
