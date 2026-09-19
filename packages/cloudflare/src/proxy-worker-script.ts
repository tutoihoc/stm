/**
 * The Worker that stands in front of a Quick Tunnel and forwards to it.
 *
 * A Quick Tunnel's address is random and changes every time cloudflared
 * starts, which makes it useless as the address somebody keeps: a bookmark
 * from yesterday is a dead hostname today, and the one they were sent by a
 * friend answers `DNS_PROBE_FINISHED_NXDOMAIN` because the name no longer
 * exists in DNS at all. A Worker on the account's own `workers.dev` subdomain
 * has a name that does not move. It is deployed once and redeployed with the
 * new origin whenever the tunnel changes, so the address people hold on to
 * stays the same while the thing behind it comes and goes.
 *
 * What it does is deliberately nothing more than forwarding. Every request
 * arrives at the tunnel with the method, headers and body it was made with,
 * and every answer comes back untouched - so the access gateway behind it sets
 * its own cookies, serves its own sign-in and streams its own responses exactly
 * as it would to a browser that had the tunnel address.
 *
 * `ORIGIN` is the tunnel address, and is empty when there is no tunnel: the
 * Worker then says so rather than forwarding into nothing, because a reader who
 * opens their own address wants to know the tunnel is off, not to read a
 * Cloudflare error page about a hostname they have never heard of.
 *
 * The one thing it adds to a request is `X-Forwarded-Host`. The console checks
 * that a request that carries an `Origin` came from an address it answers on,
 * and through here those two never match on their own: the browser's origin is
 * this Worker, and `Host` by the time it arrives is the tunnel's random
 * hostname. Without the header the console refuses its own sign-in form with
 * `origin_rejected` - the address opens, shows the page, and cannot be signed
 * in to, which is exactly as useless as not opening at all.
 *
 * Bump `PROXY_WORKER_VERSION` whenever the source changes; a manager that finds
 * an older version deployed replaces it.
 */
export const PROXY_WORKER_VERSION = 2;

/**
 * The two names, and what each one is in front of.
 *
 * Fixed rather than generated, because the whole point is an address that can
 * be remembered and written down. They become
 * `https://stm.<subdomain>.workers.dev` and
 * `https://sillytavern.<subdomain>.workers.dev`.
 */
export const PROXY_SCRIPT_NAMES = {
  manager: 'stm',
  sillyTavern: 'sillytavern',
} as const;

export type ProxyWorkerTarget = keyof typeof PROXY_SCRIPT_NAMES;

export const PROXY_WORKER_TARGETS: readonly ProxyWorkerTarget[] = ['manager', 'sillyTavern'];

/** The path the manager asks a deployed script about itself on. */
export const PROXY_VERSION_PATH = '/__stm-proxy/version';

export const PROXY_WORKER_COMPATIBILITY_DATE = '2026-09-01';

export const PROXY_WORKER_SOURCE = `const VERSION = ${PROXY_WORKER_VERSION};
const VERSION_PATH = ${JSON.stringify(PROXY_VERSION_PATH)};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Asked by the manager, to find out what is deployed here and what it is
    // pointed at. Answered before anything is forwarded, so it works even
    // while the tunnel behind this is down.
    if (url.pathname === VERSION_PATH) {
      return json({ version: VERSION, target: env.TARGET || null, origin: env.ORIGIN || null });
    }
    const origin = typeof env.ORIGIN === 'string' ? env.ORIGIN.trim() : '';
    if (!origin) return offline(env);
    let upstream;
    try { upstream = new URL(origin); } catch { return offline(env); }
    // The path, the query and everything else about the request are the
    // reader's; only where it is sent changes.
    const target = new URL(url.pathname + url.search, upstream.origin);
    try {
      /*
       * The original request, at a different address.
       *
       * Built from \`request\` rather than copied field by field, because that
       * is what carries a WebSocket upgrade through - and the console shows
       * SillyTavern in a frame that streams. \`redirect: 'manual'\` keeps a
       * redirect the origin issues as an answer for the browser to follow
       * through this Worker, instead of following it here and returning the
       * result of a different address.
       */
      const forwarded = new Request(target, request);
      // What the browser actually typed, which nothing downstream can work out
      // for itself once Host has become the tunnel's. Left alone on an upgrade:
      // a WebSocket handshake is the one request the runtime is particular
      // about, nothing behind this checks the origin of one, and carrying the
      // socket matters more than labelling it.
      if (!request.headers.get('upgrade')) {
        forwarded.headers.set('x-forwarded-host', url.host);
        forwarded.headers.set('x-forwarded-proto', url.protocol.replace(':', ''));
      }
      return await fetch(forwarded, { redirect: 'manual' });
    } catch (error) {
      return json({ error: 'origin_unreachable', message: String(error && error.message || error).slice(0, 200) }, 502);
    }
  },
};

/**
 * The tunnel is off, or was never there.
 *
 * A plain page rather than an error, because this is the expected state of a
 * machine that is switched off: the address is right and there is nothing
 * behind it yet.
 */
function offline(env) {
  const name = env.TARGET === 'manager' ? 'the manager console' : 'SillyTavern';
  return new Response(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Not open right now</title>'
    + '<style>:root{color-scheme:light dark}body{margin:0;display:grid;place-items:center;min-height:100vh;'
    + 'font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:32rem;padding:24px;text-align:center}'
    + 'h1{font-size:1.25rem;margin:0 0 8px}p{margin:0;opacity:.7}</style></head><body><main>'
    + '<h1>This address is not open right now</h1>'
    + '<p>' + name + ' is not being shared to the internet at the moment. '
    + 'Turn the link on in the manager and this address will work again.</p>'
    + '</main></body></html>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
`;
