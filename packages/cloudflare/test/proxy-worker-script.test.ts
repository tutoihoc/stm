import test from 'node:test';
import assert from 'node:assert/strict';
import { PROXY_VERSION_PATH, PROXY_WORKER_SOURCE, PROXY_WORKER_VERSION } from '../src/proxy-worker-script.js';

interface WorkerModule {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

/** The deployed source, loaded the way the Workers runtime would: as an ES module. */
async function loadProxy(): Promise<WorkerModule> {
  const module = await import(`data:text/javascript;base64,${Buffer.from(PROXY_WORKER_SOURCE, 'utf8').toString('base64')}`) as { default: WorkerModule };
  return module.default;
}

/**
 * Stand in for the network, so the Worker's own `fetch` is what is measured.
 *
 * Restored after each test: a leaked global fetch would silently break every
 * test that runs after this file.
 */
function interceptFetch(handler: (request: Request) => Promise<Response> | Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request && init === undefined ? input : new Request(input as RequestInfo, init);
    return await handler(request);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test('every request reaches the tunnel with its own method, path, query and body', async (t) => {
  const proxy = await loadProxy();
  const seen: Array<{ url: string; method: string; body: string; header: string | null; forwardedHost: string | null; forwardedProto: string | null }> = [];
  t.after(interceptFetch(async (request) => {
    seen.push({
      url: request.url,
      method: request.method,
      body: await request.text(),
      header: request.headers.get('x-from-browser'),
      forwardedHost: request.headers.get('x-forwarded-host'),
      forwardedProto: request.headers.get('x-forwarded-proto'),
    });
    return new Response('from the tunnel', { status: 201, headers: { 'x-from-origin': 'yes' } });
  }));

  const answer = await proxy.fetch(
    new Request('https://stm.acme.workers.dev/api/v1/chat?stream=1', { method: 'POST', body: 'hello', headers: { 'x-from-browser': 'yes' } }),
    { ORIGIN: 'https://cedar-married-designer-ticket.trycloudflare.com', TARGET: 'sillyTavern' },
  );

  // Where it went: the tunnel's host, everything else the reader's.
  assert.deepEqual(seen.map((entry) => entry.url), ['https://cedar-married-designer-ticket.trycloudflare.com/api/v1/chat?stream=1']);
  assert.equal(seen[0]?.method, 'POST');
  assert.equal(seen[0]?.body, 'hello');
  assert.equal(seen[0]?.header, 'yes', 'the browser\'s own headers travel with it');

  /*
   * The address the browser actually used, which nothing downstream can work
   * out once Host has become the tunnel's. The console checks that a request
   * carrying an Origin came from an address it answers on, and without this it
   * refuses its own sign-in form with `origin_rejected`.
   */
  assert.equal(seen[0]?.forwardedHost, 'stm.acme.workers.dev');
  assert.equal(seen[0]?.forwardedProto, 'https');

  // And what came back is what the origin said, untouched: the access gateway
  // behind the tunnel sets its own cookies and statuses.
  assert.equal(answer.status, 201);
  assert.equal(answer.headers.get('x-from-origin'), 'yes');
  assert.equal(await answer.text(), 'from the tunnel');
});

test('with no tunnel behind it, the address says so instead of forwarding', async (t) => {
  const proxy = await loadProxy();
  let reached = false;
  t.after(interceptFetch(() => { reached = true; return new Response('nope'); }));

  for (const env of [{ ORIGIN: '', TARGET: 'manager' }, { TARGET: 'manager' }, { ORIGIN: 'not a url', TARGET: 'manager' }]) {
    const answer = await proxy.fetch(new Request('https://stm.acme.workers.dev/'), env);
    assert.equal(answer.status, 503);
    const page = await answer.text();
    assert.ok(page.includes('not open'), JSON.stringify(env));
    // Named, so a reader who has two of these addresses knows which one this is.
    assert.ok(page.includes('the manager console'), JSON.stringify(env));
  }
  assert.equal(reached, false, 'nothing is forwarded into nowhere');

  const sillyTavern = await proxy.fetch(new Request('https://sillytavern.acme.workers.dev/'), { ORIGIN: '', TARGET: 'sillyTavern' });
  assert.ok((await sillyTavern.text()).includes('SillyTavern'));
});

test('the Worker says what it is, so the manager can tell its own from a stranger', async (t) => {
  const proxy = await loadProxy();
  t.after(interceptFetch(() => new Response('should not be reached')));
  // Answered before anything is forwarded, so it works while the tunnel is down.
  const answer = await proxy.fetch(new Request(`https://stm.acme.workers.dev${PROXY_VERSION_PATH}`), { ORIGIN: '', TARGET: 'manager' });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { version: PROXY_WORKER_VERSION, target: 'manager', origin: null });
});

test('a tunnel that cannot be reached is reported as such, not as a blank failure', async (t) => {
  const proxy = await loadProxy();
  t.after(interceptFetch(() => { throw new Error('connection refused'); }));
  const answer = await proxy.fetch(
    new Request('https://stm.acme.workers.dev/'),
    { ORIGIN: 'https://gone.trycloudflare.com', TARGET: 'manager' },
  );
  assert.equal(answer.status, 502);
  assert.deepEqual(await answer.json(), { error: 'origin_unreachable', message: 'connection refused' });
});

test('a redirect the origin issues is handed to the browser, not followed here', async (t) => {
  const proxy = await loadProxy();
  let redirectMode: RequestRedirect | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    redirectMode = init?.redirect;
    return new Response(null, { status: 302, headers: { location: '/sign-in' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  // Followed inside the Worker, the browser would be handed the contents of a
  // different address and would never see the redirect - so the gateway's
  // sign-in flow would happen invisibly and set its cookies on nothing.
  const answer = await proxy.fetch(new Request('https://stm.acme.workers.dev/'), { ORIGIN: 'https://one.trycloudflare.com', TARGET: 'manager' });
  assert.equal(redirectMode, 'manual');
  assert.equal(answer.status, 302);
  assert.equal(answer.headers.get('location'), '/sign-in');
});

test('a WebSocket handshake is carried through untouched', async (t) => {
  const proxy = await loadProxy();
  let upgraded: { url: string; upgrade: string | null; forwardedHost: string | null } | null = null;
  t.after(interceptFetch((request) => {
    upgraded = { url: request.url, upgrade: request.headers.get('upgrade'), forwardedHost: request.headers.get('x-forwarded-host') };
    return new Response(null, { status: 101 });
  }));

  await proxy.fetch(
    new Request('https://sillytavern.acme.workers.dev/socket', { headers: { upgrade: 'websocket', connection: 'Upgrade' } }),
    { ORIGIN: 'https://one.trycloudflare.com', TARGET: 'sillyTavern' },
  );

  // The handshake is the one request the runtime is particular about, and it
  // reaches the tunnel as it was made. Nothing behind this checks the origin
  // of a socket, so it loses nothing by not being labelled.
  assert.equal((upgraded as { upgrade: string | null } | null)?.upgrade, 'websocket');
  assert.equal((upgraded as { url: string } | null)?.url, 'https://one.trycloudflare.com/socket');
  assert.equal((upgraded as { forwardedHost: string | null } | null)?.forwardedHost, null);
});
