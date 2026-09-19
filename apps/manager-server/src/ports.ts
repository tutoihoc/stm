/**
 * The three ports this manager owns, and the rules that keep them apart.
 *
 * Two of them are fixed for the life of the process: the console's own port and
 * the access gateway's are read from the environment at startup, because moving
 * the port you are currently connected through from a page served on it is a
 * way to lose the page. SillyTavern's is the one that can move while the
 * manager runs, so it is the one that has to be checked against the others.
 *
 * The numbers below are what this project asks for. They are not always what it
 * gets: on a shared host something else may already hold one of them, and on a
 * host that publishes a single port the number is not ours to choose at all.
 * The rest of this file is about finding out which, before anything binds.
 */
import { createServer } from 'node:net';

/** Where the console listens. `STM_PORT` moves it; a restart applies it. */
export const MANAGER_PORT = 7860 as const;
/** Where the access gateway listens. `STM_ACCESS_PORT` moves it. */
export const ACCESS_GATEWAY_PORT = 8001 as const;
/**
 * What SillyTavern is started on unless the console has been told otherwise.
 *
 * Not SillyTavern's own 8000. That number is the one every other copy of
 * SillyTavern on the machine also asks for - an existing install started by
 * hand, a second manager, a container someone forwarded - so a console that
 * takes it is the one most likely to find it held, and to hold it against
 * somebody else. 8002 is out of that way, and the console writes it into the
 * profile's `config.yaml` so SillyTavern is asking for it rather than being
 * moved off 8000 afterwards.
 */
export const SILLYTAVERN_PORT = 8002 as const;

/**
 * Ports below this need privileges on Unix that the manager does not ask for,
 * and taking one would fail at the moment SillyTavern is started rather than
 * at the moment the number was typed.
 */
const LOWEST_PORT = 1024;
const HIGHEST_PORT = 65535;

/** Which of the manager's own ports a number would collide with, if any. */
export type PortHolder = 'manager' | 'access' | 'tunnel';

export class PortError extends Error {
  public readonly code: 'port_invalid' | 'port_conflict';
  /** Which port is already taken, for a message that names it. */
  public readonly holder: PortHolder | undefined;

  public constructor(code: PortError['code'], message: string, holder?: PortHolder) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    this.holder = holder;
  }
}

export interface ReservedPorts {
  readonly manager: number;
  readonly access: number;
}

/**
 * Check a port SillyTavern is being moved to, and answer it back.
 *
 * A port the manager already answers on is refused rather than allowed to fail
 * later: whichever of the two started second would find the address in use, and
 * the one that lost would be a service the reader was already using.
 */
export function checkSillyTavernPort(port: unknown, reserved: ReservedPorts): number {
  if (typeof port !== 'number' || !Number.isInteger(port)) {
    throw new PortError('port_invalid', 'The port must be a whole number');
  }
  if (port < LOWEST_PORT || port > HIGHEST_PORT) {
    throw new PortError('port_invalid', `The port must be between ${LOWEST_PORT} and ${HIGHEST_PORT}`);
  }
  if (port === reserved.manager) {
    throw new PortError('port_conflict', `Port ${port} is the manager's own port`, 'manager');
  }
  if (port === reserved.access) {
    throw new PortError('port_conflict', `Port ${port} is the access gateway's port`, 'access');
  }
  return port;
}

/**
 * A port from the environment, or the default when it says nothing usable.
 *
 * An unreadable value falls back rather than refusing to start: the console not
 * coming up at all is a worse answer to a typo in `.env` than the console
 * coming up where it always does.
 */
export function portFromEnvironment(value: string | undefined, fallback: number): number {
  const parsed = Number((value ?? '').trim());
  if (!Number.isInteger(parsed) || parsed < LOWEST_PORT || parsed > HIGHEST_PORT) return fallback;
  return parsed;
}

/**
 * Where a port came from, which decides what to do when it cannot be taken.
 *
 * `configured` is a number somebody wrote down. `platform` is the `PORT` a
 * container host sets because that is the one port it publishes. Either way it
 * is the only address the console is reachable at, so moving off it would leave
 * the console running where nobody can see it, and failing loudly is the better
 * answer.
 *
 * `default` is this project's own number, which nothing outside depends on. If
 * it is taken, the neighbourly thing is to step aside and say where we went.
 *
 * The two demanded kinds are told apart because `platform` says one more thing:
 * that something in front of this process will be connecting to it, from
 * outside the loopback address, which decides what to bind.
 */
export type PortSource = 'configured' | 'platform' | 'default';

export interface ResolvedPort {
  readonly port: number;
  readonly source: PortSource;
}

/** Whether this port is one to bind or fail on, rather than one to move off. */
export function portWasDemanded(source: PortSource): boolean {
  return source !== 'default';
}

/**
 * Which port the console should listen on, and whether it may move.
 *
 * `PORT` is the convention every container host shares: it is set to the one
 * port the platform routes from the outside world, and an application that
 * ignores it is an application the platform reports as failing to start. Read
 * it, and a repository imported into such a host works on the first run with
 * nothing to configure; ignore it, and the console is listening on 7860 behind
 * a door that only opens onto some other number.
 *
 * `STM_PORT` still wins, because somebody who wrote it down meant it.
 */
export function resolveConsolePort(env: NodeJS.ProcessEnv): ResolvedPort {
  // An unreadable value is not a port anything is routing, so it earns no say
  // over where the console listens or whether it may move.
  const configured = readPort(env.STM_PORT);
  if (configured !== null) return { port: configured, source: 'configured' };
  const platform = readPort(env.PORT);
  if (platform !== null) return { port: platform, source: 'platform' };
  return { port: MANAGER_PORT, source: 'default' };
}

/** Which port the access gateway should listen on, and whether it may move. */
export function resolveAccessPort(env: NodeJS.ProcessEnv): ResolvedPort {
  const configured = readPort(env.STM_ACCESS_PORT);
  if (configured !== null) return { port: configured, source: 'configured' };
  return { port: ACCESS_GATEWAY_PORT, source: 'default' };
}

/** A usable port from an environment value, or null for anything else. */
function readPort(value: string | undefined): number | null {
  const trimmed = (value ?? '').trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const port = Number(trimmed);
  if (port < LOWEST_PORT || port > HIGHEST_PORT) return null;
  return port;
}

/**
 * Whether this port can be bound on this address, right now.
 *
 * Asked by binding it and letting go again, because that is the only question
 * the operating system actually answers. A port can be free for one address and
 * held for another - something bound to 127.0.0.1 leaves 0.0.0.0 unbindable but
 * not the other way round - so the address the caller intends to use is the
 * address this is asked on.
 *
 * There is a gap between letting go here and binding for real, and something
 * else could take the port inside it. That race is not worth closing: what this
 * prevents is the common case, a port held for the life of the machine by a
 * service that was there before we started.
 */
export function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    const settle = (free: boolean): void => {
      probe.removeAllListeners();
      if (free) probe.close(() => { resolve(true); });
      else resolve(false);
    };
    probe.once('error', () => { settle(false); });
    probe.once('listening', () => { settle(true); });
    try {
      probe.listen(port, host);
    } catch {
      settle(false);
    }
  });
}

export interface FreePortSearch {
  /** Ports this manager has already spoken for, which are never the answer. */
  readonly reserved: readonly number[];
  readonly host: string;
  /** How far up from the preferred port to look before giving up. */
  readonly attempts?: number;
  readonly isFree?: (port: number, host: string) => Promise<boolean>;
}

/**
 * The preferred port if it is free, otherwise the next free one above it.
 *
 * Counting upwards rather than asking for an ephemeral port, because these
 * numbers are written down: in a bookmark, in a tunnel's target, in whatever
 * the reader told their router. 8001 becoming 8002 is a number somebody can
 * still recognise; 8001 becoming 49banana is not.
 *
 * Returns null when nothing in range is free, which is a machine in a state
 * this cannot fix by trying harder.
 */
export async function findFreePort(preferred: number, search: FreePortSearch): Promise<number | null> {
  const isFree = search.isFree ?? isPortFree;
  const attempts = search.attempts ?? 64;
  const taken = new Set(search.reserved);
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferred + offset;
    if (port > HIGHEST_PORT) return null;
    if (taken.has(port)) continue;
    if (await isFree(port, search.host)) return port;
  }
  return null;
}
