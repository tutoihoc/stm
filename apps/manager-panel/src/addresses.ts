import type { AccessGatewayState, TunnelState } from '../../../packages/contracts/src/index.js';

/**
 * SillyTavern itself, which only this machine can reach.
 *
 * The port is asked for rather than assumed: it used to be written in here as
 * 8000, so moving SillyTavern left every link on the overview pointing at a
 * port it had left.
 */
export function localHost(sillyTavernPort: number): string {
  return `127.0.0.1:${sillyTavernPort}`;
}

/** One place SillyTavern answers, as a link and as something short enough to show. */
export interface ReachableAddress {
  readonly kind: 'tunnel' | 'lan' | 'local';
  readonly url: string;
  /** The URL without its scheme, which is all a reader needs to recognise it. */
  readonly host: string;
  /**
   * Where this address actually forwards to, when it is not itself the door.
   *
   * Set only for the fixed Worker address: the traffic goes through it to
   * whatever Quick Tunnel is up at the time, and that tunnel's own address is
   * worth being able to see - it is what the logs say and what is actually
   * being proxied - without being the address anybody is offered.
   */
  readonly via?: string;
}

/**
 * Every address SillyTavern can be opened at right now, best first.
 *
 * The tunnel reaches it from anywhere, the network address from anything in
 * the house, and the loopback address only from the machine it is on - so that
 * is the order a link is chosen in. The console used to open the loopback
 * address whatever else was on, which from a phone is an address that goes
 * nowhere.
 *
 * `onThisMachine` is whether the console is being read on the machine it is
 * running on, and it decides whether the loopback address is an address at all.
 * It is not, anywhere else: not from a phone on the same Wi-Fi, and least of
 * all on a hosted studio, where the console is a page served from a container
 * in a data centre and `127.0.0.1` is the reader's own laptop. Offered there,
 * it was a link that could only ever fail, shown as the best address available
 * and used by the Open button - so the one press that was supposed to open
 * SillyTavern was the one press guaranteed not to. An empty list is the honest
 * answer, and the console can then offer the thing that would actually work.
 */
export function reachableAddresses(tunnel: Pick<TunnelState, 'url' | 'proxyUrl'>, security: Pick<AccessGatewayState, 'lan' | 'port'>, networkHost: string, sillyTavernPort: number, onThisMachine: boolean): ReachableAddress[] {
  const addresses: ReachableAddress[] = [];
  /*
   * The fixed address wins over the tunnel's own.
   *
   * A Quick Tunnel's hostname is a different one every time cloudflared
   * starts, so it is the wrong thing to put in front of somebody: the link
   * they save, send or scan stops working the next time the machine is
   * restarted, and stops as `DNS_PROBE_FINISHED_NXDOMAIN`. The Worker address
   * is the same one for good, and forwards to whichever tunnel is up. Where
   * there is no Cloudflare sign-in there is no Worker, and the tunnel's own
   * address is the only address there is.
   */
  if (tunnel.proxyUrl) addresses.push({ kind: 'tunnel', url: tunnel.proxyUrl, host: bareHost(tunnel.proxyUrl), ...(tunnel.url ? { via: bareHost(tunnel.url) } : {}) });
  else if (tunnel.url) addresses.push({ kind: 'tunnel', url: tunnel.url, host: bareHost(tunnel.url) });
  if (security.lan) {
    const host = `${networkHost}:${security.port}`;
    addresses.push({ kind: 'lan', url: `http://${host}`, host });
  }
  if (!onThisMachine) return addresses;
  const local = localHost(sillyTavernPort);
  addresses.push({ kind: 'local', url: `http://${local}`, host: local });
  return addresses;
}

/** An address as a reader recognises it: no scheme, no trailing slash. */
export function bareHost(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/\/$/u, '');
}

/**
 * `example.trycloudflare.com` as `exam...flare.com`.
 *
 * The beginning says which tunnel it is and the end says what kind of address
 * it is; the middle is what a phone has no room for. The full address is in
 * the remote access card, one card further down.
 */
export function shortenHost(host: string): string {
  const head = 4;
  const tail = 9;
  // An IP address with its middle taken out is no address at all, and it is
  // never long enough to need it.
  if (/^[0-9.:]+$/u.test(host)) return host;
  return host.length > head + tail + 5 ? `${host.slice(0, head)}...${host.slice(-tail)}` : host;
}
