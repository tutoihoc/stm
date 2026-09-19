/**
 * Whether the console is being read somewhere its own address may not work.
 *
 * On a laptop or a phone the console is opened at a loopback address, or at a
 * LAN address from another device in the house. Both are addresses the reader
 * already has and that already work, so there is nothing to offer them.
 *
 * Hosted is the other case: a workspace, a forwarded port, a preview frame
 * whose real address is a URL nobody is shown. There the address in the bar is
 * the platform's, it can be scoped to a session, rewritten in the headers the
 * console reads itself from, or simply gone tomorrow - and a Cloudflare
 * sign-in has to come back to something. That is when the console's own link
 * is worth suggesting.
 */

/** Where the offer is remembered, per browser. */
const DECLINED_KEY = 'stm-manager-tunnel-declined';

type HostingStorage = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * Whether this hostname is one the reader reached without a platform in the
 * middle: this machine, or a device on the same network.
 */
export function isLocalHostname(hostname: string): boolean {
  // Both brackets, so `[::1]` is not left as `::1]`.
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0') return true;
  // A name ending in .local is mDNS, which does not leave the network it is on.
  if (host.endsWith('.local')) return true;
  const ipv6 = /^f[cd][0-9a-f]{2}:/u.test(host) || host.startsWith('fe80:');
  if (ipv6) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (!ipv4) return false;
  const first = Number(ipv4[1]);
  const second = Number(ipv4[2]);
  return first === 127
    || first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    // Carrier-grade NAT, which is the range Tailscale hands out.
    || (first === 100 && second >= 64 && second <= 127);
}

/**
 * Whether this hostname is the machine the console is running on.
 *
 * Narrower than `isLocalHostname`, and a different question: that one asks
 * whether the reader got here without a platform in the middle, which a phone
 * on the same Wi-Fi did. This asks whether the reader is *on* the machine - the
 * only place a loopback address means anything, and the only place SillyTavern
 * can be shown in a frame on this console's own origin.
 *
 * Written out rather than compared against two strings, because `[::1]` and
 * `127.0.0.2` are this machine too and were being treated as somewhere else.
 */
export function isThisMachine(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0' || host === '') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host);
}

export interface TunnelOfferInput {
  /** The address the console is being read at, from the browser. */
  readonly hostname: string;
  /** Whether the console's own tunnel is already meant to be open. */
  readonly tunnelWanted: boolean;
  /** Whether the reader has turned this offer down before. */
  readonly declined: boolean;
}

/**
 * Whether to offer the console's own link, unprompted.
 *
 * Asked once, and only where it would help. A reader on their own machine is
 * never asked, which is most readers - on Android the console is the phone's
 * own, and opening it to the internet is something to go looking for rather
 * than something to be offered.
 */
export function shouldOfferManagerTunnel(input: TunnelOfferInput): boolean {
  if (input.declined || input.tunnelWanted) return false;
  return !isLocalHostname(input.hostname);
}

export function readTunnelOfferDeclined(storage?: HostingStorage): boolean {
  try {
    return storage?.getItem(DECLINED_KEY) === 'yes';
  } catch {
    return false;
  }
}

export function saveTunnelOfferDeclined(storage?: HostingStorage): void {
  try {
    storage?.setItem(DECLINED_KEY, 'yes');
  } catch {
    // Without storage the offer comes back next time. That is a dialog nobody
    // wanted rather than a console nobody can reach, so it is the safe way
    // round - and it is one click to dismiss again.
  }
}
