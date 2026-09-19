import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { delimiter, join } from 'node:path';
import { describeExit, logEvent, logLineText, STOP_REASON_TEXT, stopReasonCode, type LogSink, type StopReason, type TunnelMode, type TunnelState } from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const execFileAsync = promisify(execFile);
const CLOUDFLARED_RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
/** What the tunnel should be doing, so a manager restart does not take the link down with it. */
const TUNNEL_STATE_FILE = 'tunnel-config.json';
/**
 * The cloudflared fetch in flight, per directory it is being fetched into.
 *
 * There is more than one tunnel now - SillyTavern's and the console's - and
 * they are started independently, so both can arrive here at once on a machine
 * that has no cloudflared yet. The download is safe either way, because it
 * lands on a temporary name and is renamed into place, but two of them is twice
 * the bytes on a connection somebody is waiting on; and on Termux it is two
 * package installs at once, which is not safe at all.
 */
const binaryInFlight = new Map<string, Promise<string>>();
const TUNNEL_SCHEMA_VERSION = 1 as const;
/**
 * How cloudflared talks to Cloudflare's edge.
 *
 * `auto` is cloudflared's own choice, which is QUIC, which is UDP. `http2` is
 * TCP, which is slower to recover from a dropped packet and is the only thing
 * that connects on a network where UDP does not leave the machine.
 */
export type TunnelTransport = 'auto' | 'http2';
/**
 * How long a tunnel may sit at "starting" before QUIC is blamed for it.
 *
 * A network that drops UDP gives cloudflared nothing to fail on: the packets
 * leave and no answer comes back, so it retries the handshake until it gives up
 * minutes later, and the link people are waiting for is an error 1033 page the
 * whole time. Long enough not to punish a slow first connection, short enough
 * that the reader has not walked away.
 */
const QUIC_PATIENCE_MS = 25_000;
/**
 * Lines that mean the edge could not be reached over QUIC.
 *
 * cloudflared says this several ways depending on version and on where the
 * block is - a refused handshake, a datagram that never arrived, its own advice
 * to pass the flag this class is about to pass.
 */
const QUIC_FAILURE = /failed to (?:create|dial|connect).{0,40}quic|quic.{0,40}(?:timeout|timed out|connection refused|no recent network activity)|--protocol http2/iu;
/**
 * What Cloudflare's edge answers for a tunnel whose connections never came up.
 *
 * Error 1033 is served with HTTP 530 and says "Argo Tunnel error" in the page.
 * It is what a reader sees when cloudflared announced an address - so this
 * manager reports the tunnel as running, and the link is on the card - while
 * the edge has no registered connection to send the request down. On a network
 * that drops outbound UDP this is the shape the failure takes when cloudflared
 * gets far enough to be handed a hostname and no further: the log says nothing
 * wrong, the address exists, and every visit to it is an error page.
 */
const EDGE_TUNNEL_ERROR_STATUS = 530;
const EDGE_TUNNEL_ERROR_BODY = /error\s*1033|argo tunnel error/iu;
/**
 * When to ask the edge whether the address it just handed out actually works,
 * how many times, and how many refusals in a row settle it.
 *
 * The first ask waits, because an address is announced a second or two before
 * every edge knows about it and a check that ran immediately would condemn a
 * tunnel that was about to be fine. Two refusals in a row rather than one, for
 * the same reason.
 */
const EDGE_CHECK_DELAY_MS = 4_000;
const EDGE_CHECK_ATTEMPTS = 6;
const EDGE_FAILURE_STREAK = 2;
/**
 * How long to wait before reconnecting, per consecutive failure.
 *
 * cloudflared keeps its own edge connections alive, so reaching this at all
 * means the process itself went away - the host slept, the network dropped for
 * longer than cloudflared tolerates, or something killed it. Retrying at once
 * is right for the first case and wrong for a machine that is simply offline,
 * so the wait grows and then sits at a minute.
 */
const RECONNECT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

interface StoredTunnelState {
  readonly schemaVersion: 1;
  readonly mode: TunnelMode;
  readonly token: string | null;
  /**
   * What the last start settled on, so a machine that has already been found
   * to block UDP does not spend the patience above rediscovering it on every
   * restart. Absent in a file written before this existed, which reads as
   * `auto` and costs one slow start.
   */
  readonly transport?: TunnelTransport;
}

/**
 * Which cloudflared build this machine needs.
 *
 * Cloudflare ships a single static binary per platform, except on macOS where
 * it is only a .tgz - unpacking that would need a dependency, so point at
 * Homebrew rather than failing somewhere obscure later.
 */
function cloudflaredAsset(platform: NodeJS.Platform = process.platform, architecture: string = process.arch): { file: string; exe: string } {
  const mapped = { x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' }[architecture as 'x64' | 'arm64' | 'arm' | 'ia32'];
  if (!mapped) throw new Error(`cloudflared has no build for the ${architecture} architecture`);
  if (platform === 'win32') return { file: `cloudflared-windows-${mapped}.exe`, exe: 'cloudflared.exe' };
  if (platform === 'darwin') throw new Error('Install cloudflared with `brew install cloudflared`, then set STM_CLOUDFLARED_PATH.');
  return { file: `cloudflared-linux-${mapped}`, exe: 'cloudflared' };
}

/** An ELF executable with a fixed load address, which Android's loader will not run. */
const ELF_TYPE_FIXED_ADDRESS = 2;
/** Termux's own prefix, for the installs that start without its environment. */
const TERMUX_PREFIX = '/data/data/com.termux/files/usr';
/** How long to let Termux's package manager work before giving up on it. */
const PACKAGE_INSTALL_TIMEOUT_MS = 600_000;

/**
 * Whether Android can start the file at `path` by itself.
 *
 * Android runs position-independent executables only, and Cloudflare's own
 * Linux builds are not position-independent. One started directly on Termux
 * exits at once with
 *
 *   error: "<path>/cloudflared" has unexpected e_type: 2
 *
 * which reads like a broken download and is not one - no retry can fix it. The
 * file is fine; only the way it is started has to change, and `termux-chroot`
 * from the `proot` package starts exactly this kind of binary. So this answers
 * one question: run it directly, or run it through proot.
 */
async function startsOnAndroid(path: string, termux: boolean): Promise<boolean> {
  if (!termux) return true;
  const header = Buffer.alloc(18);
  try {
    const handle = await open(path, 'r');
    try { await handle.read(header, 0, header.length, 0); } finally { await handle.close(); }
  } catch {
    // Unreadable is not the same as unusable. Leave the answer to the loader.
    return true;
  }
  // A wrapper script, or anything else that is not an ELF binary, is the
  // loader's business rather than this check's.
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return true;
  const type = header[5] === 2 ? header.readUInt16BE(16) : header.readUInt16LE(16);
  return type !== ELF_TYPE_FIXED_ADDRESS;
}

/**
 * The public address in a line of cloudflared output, without any path.
 *
 * cloudflared announces the address once in a banner, and then names it again
 * in every request line it logs - including the failures, as `dest=https://
 * host/user/images/Assistant/....mp4`. The pattern used to allow a path after
 * the hostname, so whichever file someone had just opened was appended to the
 * public link shown in the console, and the link changed again the next time
 * anything was logged. The address is the origin; the path belongs to whoever
 * was browsing.
 */
export function parseTunnelUrl(line: string): string | undefined {
  return /https:\/\/[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.trycloudflare\.com/u.exec(line)?.[0];
}

export interface TunnelManagerOptions {
  readonly paths: PlatformPaths;
  /**
   * What cloudflared publishes.
   *
   * For SillyTavern this is the access gateway, never SillyTavern itself: a
   * tunnel points at whatever answers, and SillyTavern answers with no password
   * of its own. The console publishes itself, because it has a password.
   *
   * A function where the address is not known when this is built - the console
   * does not learn which port it took until it has taken it.
   */
  readonly targetUrl?: string | (() => string);
  /**
   * Where to remember what this tunnel should be doing, under the state
   * directory. Each tunnel needs its own file, or the second to start would
   * overwrite what the first was told.
   */
  readonly stateFile?: string;
  readonly logger?: LogSink;
  readonly now?: () => Date;
  readonly binaryPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly beforeStart?: () => Promise<void>;
  /** Injectable for tests; defaults to the global fetch. */
  readonly fetchImpl?: typeof globalThis.fetch;
  /** Injectable for tests, so no real cloudflared has to be launched. */
  readonly spawnImpl?: typeof spawn;
  /** How long to wait before each reconnect attempt; shortened by tests. */
  readonly reconnectDelaysMs?: readonly number[];
  /**
   * Called whenever the public address changes, including to null.
   *
   * A Quick Tunnel's address is a different one every time cloudflared starts,
   * so anything that stands in front of it - a Worker with a fixed name, for
   * instance - has to be told. Called after the state has been updated, and
   * never twice for the same address.
   */
  readonly onUrl?: (url: string | null) => void;
  /** How long a tunnel may sit at "starting" before QUIC is blamed; shortened by tests. */
  readonly quicPatienceMs?: number;
  /** How long to wait between asks of the edge; shortened by tests. */
  readonly edgeCheckDelayMs?: number;
  /** How many times to ask before letting it be; lowered by tests. */
  readonly edgeCheckAttempts?: number;
}

export class TunnelManager {
  private readonly paths: PlatformPaths;
  private readonly logger: LogSink;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;
  private readonly configuredBinaryPath: string | undefined;
  private readonly resolveTargetUrl: () => string;
  private readonly stateFile: string;
  private readonly beforeStart: (() => Promise<void>) | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly onUrl: ((url: string | null) => void) | undefined;
  /** The address last announced to `onUrl`, so the same one is not announced twice. */
  private announcedUrl: string | null = null;
  private readonly quicPatienceMs: number;
  private readonly edgeCheckDelayMs: number;
  private readonly edgeCheckAttempts: number;
  private child: ChildProcess | null = null;
  /** Whether the running child is proot rather than cloudflared itself. */
  private wrapped = false;
  /** Set once Termux has been asked for its own cloudflared, so it is asked once. */
  private askedForPackage = false;
  private token: string | undefined;
  private buffer = '';
  private state: TunnelState = { mode: 'off', status: 'stopped', url: null, startedAt: null, error: null };
  /** Set while a stop this manager asked for is in flight, so the exit can say so. */
  private stopReason: StopReason | null = null;
  /** The pending reconnect, and how many have failed in a row before it. */
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  /** Set once the manager is shutting down, so nothing reconnects behind it. */
  private closed = false;
  /** What this machine has been found to need; see TunnelTransport. */
  private transport: TunnelTransport = 'auto';
  /** Runs out if the tunnel is still at "starting" long after it should not be. */
  private quicTimer: NodeJS.Timeout | null = null;
  /**
   * The address the edge is being asked about, while it is being asked.
   *
   * One check at a time, and only for the address that is current: a tunnel
   * that restarted while a check was in flight has a different address, and
   * the old check must not switch transport on the new one's behalf.
   */
  private edgeChecking: string | null = null;
  /**
   * Set between deciding to switch transport and the child actually going away.
   *
   * The exit that follows is one this manager asked for, so it must not be
   * reported as cloudflared dying on its own, and it must come back at once
   * rather than through the backoff - somebody is watching a link that does
   * not work yet.
   */
  private switchingTransport: Exclude<TunnelMode, 'off'> | null = null;

  public constructor(options: TunnelManagerOptions) {
    this.paths = options.paths;
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
    this.configuredBinaryPath = options.binaryPath ?? this.env.STM_CLOUDFLARED_PATH;
    const target = options.targetUrl ?? 'http://127.0.0.1:8001';
    this.resolveTargetUrl = typeof target === 'function' ? target : (): string => target;
    this.stateFile = options.stateFile ?? TUNNEL_STATE_FILE;
    this.beforeStart = options.beforeStart;
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.reconnectDelaysMs = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : RECONNECT_DELAYS_MS;
    this.onUrl = options.onUrl;
    this.quicPatienceMs = options.quicPatienceMs ?? QUIC_PATIENCE_MS;
    this.edgeCheckDelayMs = options.edgeCheckDelayMs ?? EDGE_CHECK_DELAY_MS;
    this.edgeCheckAttempts = options.edgeCheckAttempts ?? EDGE_CHECK_ATTEMPTS;
  }

  public getState(): TunnelState { return { ...this.state }; }

  public async start(mode: Exclude<TunnelMode, 'off'> = 'quick', token?: string): Promise<TunnelState> {
    if (this.child) return this.getState();
    this.clearReconnect();
    try { await this.beforeStart?.(); } catch (error: unknown) { return this.fail(mode, error instanceof Error ? error.message : 'Tunnel security requirements are not met'); }
    const selectedToken = token?.trim() || this.token;
    if (mode === 'named' && !selectedToken) return this.fail(mode, 'A Named Tunnel token is required');
    if (mode === 'named') this.token = selectedToken;
    let plan: Awaited<ReturnType<TunnelManager['launchPlan']>>;
    try {
      plan = await this.launchPlan();
    } catch (error: unknown) {
      return this.fail(mode, error instanceof Error ? error.message : 'cloudflared is unavailable');
    }
    const transport = this.chooseTransport();
    // A phone is where QUIC is blocked and IPv6 is half-configured, and
    // cloudflared answers both by sitting at "Registering tunnel" until it gives
    // up. HTTP/2 over IPv4 is the combination that connects there - and it is
    // the same combination that connects inside a container host whose outbound
    // UDP goes nowhere, which is why this is no longer only a phone's answer.
    const overEdge = transport === 'http2' ? ['--protocol', 'http2', '--edge-ip-version', '4'] : [];
    const targetUrl = this.resolveTargetUrl();
    const args = [...plan.prefix, 'tunnel', '--no-autoupdate', ...overEdge, ...(mode === 'quick'
      ? ['--url', targetUrl]
      : ['run', '--token', selectedToken!])];
    await this.remember(mode, mode === 'named' ? selectedToken ?? null : null);
    this.state = { mode, status: 'starting', url: null, startedAt: this.now().toISOString(), error: null };
    const target = targetUrl.replace(/^https?:\/\//u, '');
    this.logger(mode === 'quick'
      ? logEvent('cloudflared.startingQuick', `[cloudflared] starting Quick Tunnel to ${target}`, { target })
      : logEvent('cloudflared.startingNamed', `[cloudflared] starting Named Tunnel to ${target}`, { target }));
    // proot keeps cloudflared as a child of its own, and a signal sent to the
    // wrapper alone leaves the tunnel running. Its own process group is what
    // makes stopping it stop the tunnel too, without a `pkill` that would also
    // take down a cloudflared nobody here started.
    const child = this.spawnImpl(plan.command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: plan.env, ...(plan.wrapped ? { detached: true } : {}) });
    this.wrapped = plan.wrapped;
    this.child = child;
    // A UDP block produces no error line to match on, only silence, so the only
    // way to notice it is to notice that nothing has happened for too long.
    if (transport === 'auto') {
      this.quicTimer = setTimeout(() => {
        this.quicTimer = null;
        if (this.child === child && this.state.status === 'starting') {
          this.useHttp2('the tunnel did not come up over QUIC');
        }
      }, this.quicPatienceMs);
      this.quicTimer.unref();
    }
    const consume = (chunk: string) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/u);
      this.buffer = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    child.once('error', (error) => {
      this.logger(logEvent('cloudflared.spawnFailed', `[cloudflared] ${error.message}`, { reason: error.message }));
      this.state = { ...this.state, status: 'error', error: 'cloudflared could not start' };
      this.child = null;
    });
    child.once('close', (code, signal) => {
      if (this.buffer.trim()) this.handleLine(this.buffer);
      this.buffer = '';
      this.clearQuicTimer();
      // Asked for by this manager, to come straight back on the other
      // transport. Nothing about it is news, so none of the reporting below
      // runs and the backoff is not touched: this is the same attempt.
      const switching = this.switchingTransport;
      if (switching && this.child === child) {
        this.switchingTransport = null;
        this.child = null;
        void this.start(switching, this.token).then((state) => {
          if (state.status === 'error') this.scheduleReconnect(switching);
        }).catch(() => { this.scheduleReconnect(switching); });
        return;
      }
      const reason = this.stopReason;
      this.stopReason = null;
      const exit = describeExit(code, signal);
      const owned = this.child === child;
      if (owned) {
        this.child = null;
        if (this.state.status !== 'error' && this.state.status !== 'stopped') {
          this.state = { ...this.state, status: reason || code === 0 ? 'stopped' : 'error', error: reason || code === 0 ? null : `cloudflared exited on its own (${exit})` };
        }
      }
      this.logger(reason
        ? logEvent(`cloudflared.${stopReasonCode(reason)}`, `[cloudflared] stopped: ${STOP_REASON_TEXT[reason]}`)
        : logEvent('cloudflared.exited', `[cloudflared] exited on its own (${exit})`, { detail: exit }));
      // Nobody asked for this. The link is what people have open, so put it
      // back rather than waiting for someone to notice the switch moved.
      if (owned && !reason) this.scheduleReconnect(mode);
    });
    return this.getState();
  }

  public async stop(reason: StopReason = 'requested'): Promise<TunnelState> {
    this.clearReconnect();
    this.clearQuicTimer();
    // A stop that arrives mid-switch is the operator's, and it wins.
    this.switchingTransport = null;
    // Whatever address was being checked is not the current one any more.
    this.edgeChecking = null;
    const child = this.child;
    if (!child) { this.state = { ...this.state, status: 'stopped', url: null }; this.announce(null); return this.getState(); }
    this.stopReason = reason;
    this.state = { ...this.state, status: 'stopped', url: null, error: null };
    this.announce(null);
    this.signal(child, 'SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('close', () => { clearTimeout(timer); resolve(); });
    });
    if (this.child === child && child.exitCode === null) this.signal(child, 'SIGKILL');
    this.child = null;
    return this.getState();
  }

  /**
   * Shut down without forgetting that the tunnel was wanted.
   *
   * The manager going down is not the operator turning the tunnel off, so the
   * stored mode survives and `resume` brings it back on the next start.
   */
  public async close(): Promise<void> {
    this.closed = true;
    await this.stop('shutdown');
  }

  public async restart(reason: StopReason = 'restart'): Promise<TunnelState> {
    const mode = this.state.mode;
    if (mode === 'off') return this.getState();
    await this.stop(reason);
    return this.start(mode);
  }

  /**
   * Turn the tunnel off, and remember that it is off.
   *
   * This is the only path that forgets the mode. Everything else - a restart, a
   * restore, the manager shutting down - leaves it stored, because none of them
   * mean the operator no longer wants a public address.
   */
  public async disable(): Promise<TunnelState> {
    await this.remember('off', null);
    const state = await this.stop('requested');
    this.state = { ...state, mode: 'off' };
    return this.getState();
  }

  /**
   * Start the tunnel again if it was on when the manager last went down.
   *
   * A Quick Tunnel gets a fresh address every time cloudflared starts, so this
   * is what keeps a manager restart from silently leaving the link dead; with a
   * Named Tunnel the address is the same one as before.
   */
  public async resume(): Promise<TunnelState> {
    const stored = await this.readStored();
    if (!stored) return this.getState();
    // Read even when the tunnel is off, because what this machine's network
    // does is true whether or not a tunnel was running when it was learned.
    if (stored.transport === 'http2') this.transport = 'http2';
    if (stored.mode === 'off') return this.getState();
    if (stored.mode === 'named') this.token = stored.token ?? undefined;
    this.logger(logEvent('cloudflared.resuming', '[cloudflared] restoring the tunnel that was running before'));
    const state = await this.start(stored.mode, stored.token ?? undefined);
    if (state.status === 'error') this.scheduleReconnect(stored.mode);
    return state;
  }

  private handleLine(line: string): void {
    const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim();
    if (!clean) return;
    const url = parseTunnelUrl(clean);
    if (url && this.state.mode === 'quick') {
      this.state = { ...this.state, status: 'running', url, error: null };
      this.announce(url);
    }
    // A Named Tunnel never announces a trycloudflare address - its hostname is
    // the one configured in Cloudflare - so without this it stayed at
    // "starting" for as long as it ran, and nothing could tell a working tunnel
    // from one that never came up.
    if (this.state.mode === 'named' && /registered tunnel connection/iu.test(clean)) this.state = { ...this.state, status: 'running', error: null };
    if (this.state.status === 'running') {
      this.reconnectAttempt = 0;
      // cloudflared is satisfied, so nothing is waiting to be blamed for a
      // start that never finished. Whether the address it handed out actually
      // reaches this machine is a separate question, asked below.
      this.clearQuicTimer();
      if (url && this.child) this.watchEdge(url, this.child);
    } else if (this.quicTimer && QUIC_FAILURE.test(clean)) {
      // Said out loud rather than waited out, which is the faster half of the
      // same answer.
      this.useHttp2('cloudflared could not reach the edge over QUIC');
    }
    this.logger(`[cloudflared] ${clean}`);
  }

  /**
   * Which transport the next start should use.
   *
   * `STM_TUNNEL_PROTOCOL` settles it for anyone who already knows what their
   * network does. Termux is asked for HTTP/2 without being measured, because a
   * phone is where this has always been true and a slow first start there is
   * one nobody needs to sit through again.
   */
  private chooseTransport(): TunnelTransport {
    const configured = this.env.STM_TUNNEL_PROTOCOL?.trim().toLowerCase();
    if (configured === 'http2') return 'http2';
    if (configured === 'quic' || configured === 'auto') return 'auto';
    if (this.paths.platform === 'termux') return 'http2';
    return this.transport;
  }

  /**
   * Give up on QUIC for this machine and come straight back over HTTP/2.
   *
   * Remembered rather than retried each time: a network that blocks outbound
   * UDP blocks it for as long as the manager is on it, and the alternative is
   * every restart costing the same silent wait before the same answer.
   */
  private useHttp2(reason: string): void {
    this.clearQuicTimer();
    const mode = this.state.mode;
    if (this.transport === 'http2' || this.switchingTransport || mode === 'off') return;
    this.transport = 'http2';
    this.logger(logEvent('cloudflared.transportSwitched', `[cloudflared] ${reason}; trying again over HTTP/2`, { reason }));
    void this.remember(mode, mode === 'named' ? this.token ?? null : null);
    const child = this.child;
    if (!child) { void this.start(mode, this.token); return; }
    this.switchingTransport = mode;
    this.signal(child, 'SIGTERM');
  }

  /**
   * Say where the tunnel is, once per address.
   *
   * Whatever stands in front of a Quick Tunnel has to be redeployed for every
   * new address, and each redeploy is a write to somebody's Cloudflare
   * account - so an address that has not changed is not announced, and a
   * listener that throws is not allowed to take the tunnel down with it.
   */
  private announce(url: string | null): void {
    if (this.announcedUrl === url) return;
    this.announcedUrl = url;
    try { this.onUrl?.(url); } catch { /* the tunnel is not the listener's keeper */ }
  }

  private clearQuicTimer(): void {
    if (this.quicTimer) clearTimeout(this.quicTimer);
    this.quicTimer = null;
  }

  /**
   * Check that the address cloudflared announced actually answers, and change
   * transport if it does not.
   *
   * A tunnel can be up as far as this manager can tell - cloudflared printed a
   * hostname, the switch says running, the link is on the card - and be an
   * error 1033 page for everyone who opens it. That happens when the process
   * got a name from the API but never registered a connection at the edge,
   * which on a network that drops outbound UDP is exactly how far QUIC gets.
   * Nothing in the log says so, because from cloudflared's side nothing failed;
   * the only place the truth exists is at the address itself.
   *
   * Only an answer from Cloudflare's edge counts. A request that fails here
   * proves nothing about the tunnel - the manager may be behind a proxy that
   * will not reach trycloudflare.com at all - so it is retried and never acted
   * on. And only while there is somewhere else to go: once the tunnel is on
   * HTTP/2, a 1033 is not something a transport change can fix.
   */
  private watchEdge(url: string, child: ChildProcess): void {
    if (this.transport === 'http2' || this.edgeChecking === url) return;
    this.edgeChecking = url;
    void this.askEdgeRepeatedly(url, child).finally(() => {
      if (this.edgeChecking === url) this.edgeChecking = null;
    });
  }

  private async askEdgeRepeatedly(url: string, child: ChildProcess): Promise<void> {
    let refusals = 0;
    for (let attempt = 0; attempt < this.edgeCheckAttempts; attempt += 1) {
      await new Promise((resolve) => { const timer = setTimeout(resolve, this.edgeCheckDelayMs); timer.unref?.(); });
      // A restart, a stop or a switch happened while this was waiting. Whatever
      // is running now is not what this check was about.
      if (this.closed || this.child !== child || this.state.url !== url || this.switchingTransport) return;
      const verdict = await this.askEdge(url);
      if (verdict === 'answered') return;
      if (verdict === 'unknown') { refusals = 0; continue; }
      refusals += 1;
      if (refusals >= EDGE_FAILURE_STREAK) {
        if (this.child !== child || this.state.url !== url) return;
        this.useHttp2('the link answered with Cloudflare error 1033, so the tunnel never reached the edge');
        return;
      }
    }
  }

  /**
   * One ask. `answered` means something served the request - including a
   * refusal from the gateway behind the tunnel, which is proof the tunnel
   * carried it. `refused` is the edge saying it has no tunnel to send it down.
   */
  private async askEdge(url: string): Promise<'answered' | 'refused' | 'unknown'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'user-agent': 'sillytavern-manager' } });
      if (response.status !== EDGE_TUNNEL_ERROR_STATUS) {
        await response.body?.cancel().catch(() => undefined);
        return 'answered';
      }
      // 530 is Cloudflare's status for a whole family of errors. Only 1033
      // means the tunnel itself, so the page is read rather than guessed at.
      const body = await response.text().catch(() => '');
      return EDGE_TUNNEL_ERROR_BODY.test(body) ? 'refused' : 'answered';
    } catch {
      return 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Bring the tunnel back after an exit nobody asked for.
   *
   * The attempt itself can fail - the machine may still be offline - so a
   * failed attempt schedules the next one rather than giving up.
   */
  private scheduleReconnect(mode: Exclude<TunnelMode, 'off'>): void {
    if (this.closed || this.reconnectTimer || this.child) return;
    const delay = this.reconnectDelaysMs[Math.min(this.reconnectAttempt, this.reconnectDelaysMs.length - 1)] ?? 60_000;
    this.reconnectAttempt += 1;
    const seconds = Math.round(delay / 1000);
    this.logger(logEvent('cloudflared.reconnecting', `[cloudflared] reconnecting in ${seconds}s`, { seconds }));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.start(mode).then((state) => { if (state.status === 'error') this.scheduleReconnect(mode); }).catch(() => this.scheduleReconnect(mode));
    }, delay);
    // The manager must still be able to exit while one of these is pending.
    this.reconnectTimer.unref();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /** Record what the tunnel should be doing, for the next time the manager starts. */
  private async remember(mode: TunnelMode, token: string | null): Promise<void> {
    const stored: StoredTunnelState = { schemaVersion: TUNNEL_SCHEMA_VERSION, mode, token, transport: this.transport };
    const target = join(this.paths.state, this.stateFile);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.paths.state, { recursive: true });
      // The Named Tunnel token is a credential, so it gets the same treatment
      // as the R2 keys next to it rather than a world-readable file.
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined);
      // Not being able to remember this is not a reason to refuse to open the
      // tunnel; it only costs the automatic restore on the next start.
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger(logEvent('cloudflared.stateNotSaved', `[cloudflared] the tunnel setting could not be saved: ${reason}`, { reason }));
    }
  }

  private async readStored(): Promise<StoredTunnelState | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, this.stateFile), 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (record.schemaVersion !== TUNNEL_SCHEMA_VERSION) return null;
      const mode = record.mode;
      if (mode !== 'off' && mode !== 'quick' && mode !== 'named') return null;
      const token = typeof record.token === 'string' && record.token.trim() ? record.token.trim() : null;
      if (mode === 'named' && !token) return null;
      const transport = record.transport === 'http2' ? 'http2' : 'auto';
      return { schemaVersion: TUNNEL_SCHEMA_VERSION, mode, token, transport };
    } catch {
      return null;
    }
  }

  /**
   * The cloudflared binary, downloaded on first use if it is not here yet.
   *
   * Requiring the operator to install it first meant the tunnel simply did not
   * work on Termux, or anywhere else it was missing, and it was the only reason
   * the container image had to bake the binary in. It is one static file, so
   * fetching it once into the manager's own bin directory costs less than every
   * install carrying it.
   */
  public async ensureBinary(): Promise<string> {
    // One at a time per directory, so two tunnels starting together share the
    // answer instead of each fetching it. A failure reaches both callers, which
    // is right: neither of them has a cloudflared to run.
    const key = this.paths.bin;
    const running = binaryInFlight.get(key);
    if (running) return running;
    const attempt = this.locateOrInstallBinary();
    binaryInFlight.set(key, attempt);
    try { return await attempt; } finally { binaryInFlight.delete(key); }
  }

  private async locateOrInstallBinary(): Promise<string> {
    const termux = this.paths.platform === 'termux';
    const existing = await this.findBinary();
    // Termux packages a build of cloudflared that Android starts unaided. It
    // costs a sixth of the download and needs no proot in front of it, so it is
    // worth one ask - here, and again for a binary that would otherwise be
    // wrapped, but never more than once per run.
    if (existing && (!termux || this.askedForPackage || await startsOnAndroid(existing, true))) return existing;
    if (termux) {
      this.askedForPackage = true;
      if (await this.installPackage('cloudflared')) {
        const packaged = await this.findBinary();
        if (packaged && await startsOnAndroid(packaged, true)) return packaged;
      }
      if (existing) return existing;
    }
    const asset = cloudflaredAsset();
    const target = join(this.paths.bin, asset.exe);
    const temporary = `${target}.${randomUUID()}.part`;
    await mkdir(this.paths.bin, { recursive: true });
    this.logger(logEvent('cloudflared.downloading', `[cloudflared] downloading ${asset.file}`, { file: asset.file }));
    const response = await this.fetchImpl(`${CLOUDFLARED_RELEASE}/${asset.file}`, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`cloudflared could not be downloaded (HTTP ${response.status})`);
    try {
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), createWriteStream(temporary, { mode: 0o755 }));
      await rename(temporary, target);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
    if (process.platform !== 'win32') await chmod(target, 0o755);
    this.logger(logEvent('cloudflared.installed', `[cloudflared] installed to ${target}`, { path: target }));
    return target;
  }

  /**
   * The cloudflared to use, preferring one this device can start unaided.
   *
   * On Android a build that needs proot still works, so it is a fallback here
   * rather than a rejection: the launch plan wraps it. Anywhere else every
   * candidate starts unaided and the first one found wins, as before.
   */
  private async findBinary(): Promise<string | null> {
    const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const termux = this.paths.platform === 'termux';
    let needsProot: string | null = null;
    for (const candidate of [this.configuredBinaryPath, join(this.paths.bin, exe), exe]) {
      if (!candidate) continue;
      const path = await this.locate(candidate);
      if (!path) continue;
      if (await startsOnAndroid(path, termux)) return path;
      needsProot ??= path;
    }
    return needsProot;
  }

  /**
   * How to start cloudflared here: what to run, what to put in front of the
   * tunnel arguments, and the environment it needs.
   *
   * Android is the only place this is not simply the binary itself. Cloudflare
   * publishes no build Android starts on its own, so the one downloaded here
   * runs under `termux-chroot`, which is what the `proot` package is for. Inside
   * that view of the filesystem the usual certificate paths do not exist, so the
   * bundle Termux ships is named outright - without it every edge connection
   * fails to verify and the tunnel never comes up.
   */
  private async launchPlan(): Promise<{ command: string; prefix: readonly string[]; env: NodeJS.ProcessEnv; wrapped: boolean }> {
    const binary = await this.ensureBinary();
    const plan = { command: binary, prefix: [] as readonly string[], env: this.env, wrapped: false };
    if (this.paths.platform !== 'termux' || await startsOnAndroid(await this.locate(binary) ?? binary, true)) return plan;
    const chroot = await this.findChroot() ?? (await this.installPackage('proot') ? await this.findChroot() : null);
    if (!chroot) throw new Error('cloudflared needs proot on Android. Install it with `pkg install proot`, then turn the tunnel on again.');
    this.logger(logEvent('cloudflared.throughProot', '[cloudflared] starting it through termux-chroot, which is how Android runs this build'));
    const certificates = await this.locate(join(this.env.PREFIX ?? TERMUX_PREFIX, 'etc', 'tls', 'cert.pem'));
    return {
      command: chroot,
      prefix: [binary],
      env: certificates ? { ...this.env, SSL_CERT_FILE: certificates } : this.env,
      wrapped: true,
    };
  }

  /** Where `proot` puts termux-chroot, which is next to Termux's own programs. */
  private async findChroot(): Promise<string | null> {
    const prefix = this.env.PREFIX;
    return (prefix ? await this.locate(join(prefix, 'bin', 'termux-chroot')) : null) ?? await this.locate('termux-chroot');
  }

  /**
   * Install one Termux package, if this is Termux and `pkg` is there to do it.
   *
   * Nobody opened the manager to set up a tunnel dependency by hand, so this
   * asks for what is missing rather than telling the operator to. It answers
   * whether the package is now there, and never throws: every caller has
   * somewhere else to go.
   */
  private async installPackage(name: string): Promise<boolean> {
    if (this.paths.platform !== 'termux') return false;
    const pkg = await this.locate('pkg');
    if (!pkg) return false;
    this.logger(logEvent('cloudflared.installingPackage', `[cloudflared] installing ${name} with pkg`, { package: name }));
    const env = { ...this.env, DEBIAN_FRONTEND: 'noninteractive' };
    const run = (args: readonly string[]): Promise<unknown> => execFileAsync(pkg, [...args], { env, timeout: PACKAGE_INSTALL_TIMEOUT_MS });
    try {
      try {
        await run(['install', '-y', name]);
      } catch {
        // A device that has not seen the repository for a while does not know
        // the package exists. Refresh the lists once and ask again before
        // deciding this route is closed.
        await run(['update', '-y']).catch(() => undefined);
        await run(['install', '-y', name]);
      }
      this.logger(logEvent('cloudflared.packageInstalled', `[cloudflared] ${name} is installed`, { package: name }));
      return true;
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger(logEvent('cloudflared.packageNotInstalled', `[cloudflared] ${name} could not be installed: ${reason}`, { package: name, reason }));
      return false;
    }
  }

  /**
   * Where a program actually is, given a path or a bare name.
   *
   * This walks PATH itself rather than asking `which`, because `which` is a
   * package on Termux and a fresh install does not have it: asking for it there
   * answered "nothing is installed" about `pkg` itself, which is how the
   * automatic setup came to tell people to run `pkg install proot` by hand.
   * Termux's own bin directory is checked first, since that is where its
   * programs are whether or not PATH was inherited.
   */
  private async locate(candidate: string): Promise<string | null> {
    const found = async (path: string): Promise<string | null> => access(path).then(() => path).catch(() => null);
    if (candidate.includes('/') || candidate.includes('\\')) return found(candidate);
    const names = process.platform === 'win32' && !/\.[A-Za-z0-9]+$/u.test(candidate)
      ? [candidate, `${candidate}.exe`, `${candidate}.cmd`, `${candidate}.bat`]
      : [candidate];
    const directories = [
      ...(this.paths.platform === 'termux' ? [join(this.env.PREFIX ?? TERMUX_PREFIX, 'bin')] : []),
      ...(this.env.PATH ?? '').split(delimiter).map((entry) => entry.trim().replace(/^"|"$/gu, '')).filter((entry) => entry.length > 0),
    ];
    for (const directory of directories) {
      for (const name of names) {
        const path = await found(join(directory, name));
        if (path) return path;
      }
    }
    return null;
  }

  /** Signal the tunnel, taking the process group with it when proot is in front. */
  private signal(child: ChildProcess, signal: NodeJS.Signals): void {
    if (this.wrapped && typeof child.pid === 'number') {
      try { process.kill(-child.pid, signal); return; } catch { /* the group is already gone, or this is not POSIX */ }
    }
    child.kill(signal);
  }

  private fail(mode: Exclude<TunnelMode, 'off'>, error: string): TunnelState {
    this.state = { mode, status: 'error', url: null, startedAt: null, error };
    this.logger(logEvent('cloudflared.failed', `[cloudflared] ${error}`, { reason: error }));
    return this.getState();
  }
}
