import { networkHost, startManagerServer } from './server.js';
import { bootstrapBanner } from './banner.js';
import { ensurePanelBuilt, openInBrowser } from './bootstrap.js';

await ensurePanelBuilt();

/**
 * Stop everything this process owns, then leave.
 *
 * Declared before the server starts because the launcher can ask for a
 * shutdown as soon as the first request lands, which is earlier than the
 * signal handlers at the bottom of this file are installed.
 */
let closing = false;
const shutdown = async (reason: string): Promise<void> => {
  if (closing) return;
  closing = true;
  console.log(`[manager] shutting down (${reason})`);
  await manager.close();
  process.exit(0);
};

const manager = await startManagerServer({ onShutdownRequest: () => { void shutdown('the launcher asked'); } });
const url = `http://127.0.0.1:${manager.port}`;

/*
 * Say where the console is, once, in the place the operator is already looking.
 *
 * The lines above this are the log: a missing `.env`, the gateway's port, a
 * panel build. They are worth keeping and worth nobody having to read. What
 * somebody who has just installed this needs is the address, the address their
 * phone can use, and how to stop the thing again.
 *
 * Colour is for a terminal only. Piped into a file or a service manager's
 * journal, this is plain text.
 */
const persisted = await manager.store.getPersisted();
const lan = await networkHost();
const lanUrl = lan ? `http://${lan}:${manager.port}` : undefined;
const colour = Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb';
console.log(bootstrapBanner({
  title: `ST Manager ${persisted.managerVersion}`,
  addresses: [
    { label: 'On this computer', url },
    ...(lanUrl ? [{ label: 'On this Wi-Fi', url: lanUrl }] : []),
  ],
  stopHint: 'Press Ctrl+C to stop.',
  colour,
  ...(process.stdout.columns ? { width: process.stdout.columns } : {}),
}));

/**
 * Report a fault instead of letting it end the process in silence.
 *
 * Node ends the process on an unhandled rejection, and there was no handler
 * here, so one rejected promise anywhere - a background sweep, a failed
 * recovery after a failed install - closed the console and wrote nothing to
 * the log to say why. What the operator saw was SillyTavern unreachable, no
 * way to install a different version, and no record of the cause.
 *
 * The work that can damage data runs in the SillyTavern child, not here. The
 * manager's job after a fault is to still be there: to serve the console, to
 * show the line below, and to let a different version be installed.
 */
const reportFault = (kind: string, error: unknown): void => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  for (const line of detail.split('\n')) manager.logger(`[manager] ${kind}: ${line.trim()}`);
};

process.on('uncaughtException', (error: unknown) => { reportFault('uncaught exception', error); });
process.on('unhandledRejection', (reason: unknown) => { reportFault('unhandled rejection', reason); });

await openInBrowser(url, { logger: manager.logger });

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
