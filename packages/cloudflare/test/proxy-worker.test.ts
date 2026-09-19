import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CloudflareApi, CloudflareApiError } from '../src/api.js';
import { PROXY_SCRIPT_NAMES, PROXY_VERSION_PATH, PROXY_WORKER_SOURCE, PROXY_WORKER_VERSION } from '../src/proxy-worker-script.js';
import { normalizeOrigin, ProxyWorkerManager } from '../src/proxy-worker.js';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

interface Script {
  readonly bindings: Record<string, string>;
  readonly source: string;
  subdomainEnabled: boolean;
}

interface FakeAccount {
  subdomain: string | null;
  scripts: Map<string, Script>;
  calls: string[];
}

/** Cloudflare's Worker script endpoints over an in-memory account. */
function fakeCloudflare(initial: Partial<FakeAccount> = {}): { account: FakeAccount; api: CloudflareApi; apiFetch: typeof fetch } {
  const account: FakeAccount = { subdomain: 'acme', scripts: new Map(), calls: [], ...initial };
  const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  const fail = (status: number, code: number) => Response.json({ success: false, errors: [{ code, message: 'nope' }], result: null }, { status });
  const apiFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof URL ? input.toString() : String(input));
    const method = init?.method ?? 'GET';
    // Any account, not just the first one: a test moves between two of them.
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/[0-9a-f]{32}/u, '');
    account.calls.push(`${method} ${path}`);
    if (path === '/workers/subdomain') {
      if (method === 'GET') return account.subdomain ? ok({ subdomain: account.subdomain }) : fail(404, 10007);
      account.subdomain = (JSON.parse(String(init?.body)) as { subdomain: string }).subdomain;
      return ok({ subdomain: account.subdomain });
    }
    const scriptMatch = /^\/workers\/scripts\/([^/]+)(\/subdomain)?$/u.exec(path);
    if (scriptMatch) {
      const name = scriptMatch[1]!;
      if (scriptMatch[2]) {
        const existing = account.scripts.get(name);
        if (existing) existing.subdomainEnabled = true;
        return ok({ enabled: true });
      }
      if (method === 'GET') return account.scripts.has(name) ? ok({ id: name }) : fail(404, 10007);
      if (method === 'DELETE') return account.scripts.delete(name) ? ok(null) : fail(404, 10007);
      if (method === 'PUT') {
        const form = init?.body as FormData;
        const metadata = JSON.parse(await (form.get('metadata') as Blob).text()) as { bindings: Array<{ type: string; name: string; text: string }> };
        const bindings: Record<string, string> = {};
        for (const binding of metadata.bindings) bindings[binding.name] = binding.text;
        account.scripts.set(name, { bindings, source: await (form.get('worker.js') as Blob).text(), subdomainEnabled: false });
        return ok({ id: name });
      }
    }
    return fail(404, 10007);
  };
  return { account, api: new CloudflareApi({ accessToken: async () => 'token', fetchImpl: apiFetch }), apiFetch };
}

async function stateDirectory(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'stm-proxy-'));
}

test('a tunnel gets a fixed address, and keeps it when the tunnel changes', async () => {
  const { account, api } = fakeCloudflare();
  const directory = await stateDirectory();
  const proxy = new ProxyWorkerManager({ api, stateDirectory: directory });

  const first = await proxy.publish(ACCOUNT, 'sillyTavern', 'https://cedar-married-designer-ticket.trycloudflare.com');
  assert.equal(first.url, `https://${PROXY_SCRIPT_NAMES.sillyTavern}.acme.workers.dev`);
  assert.equal(account.scripts.get('sillytavern')?.bindings.ORIGIN, 'https://cedar-married-designer-ticket.trycloudflare.com');
  // Without this the script is deployed and has no address at all.
  assert.equal(account.scripts.get('sillytavern')?.subdomainEnabled, true);

  // The whole point: cloudflared hands out a different hostname every time it
  // starts, and the address the reader keeps does not move with it.
  const second = await proxy.publish(ACCOUNT, 'sillyTavern', 'https://spectrum-volleyball-melissa-cottage.trycloudflare.com');
  assert.equal(second.url, first.url);
  assert.equal(account.scripts.get('sillytavern')?.bindings.ORIGIN, 'https://spectrum-volleyball-melissa-cottage.trycloudflare.com');
  assert.equal(await proxy.urlFor('sillyTavern'), first.url);

  // And the two doors are two scripts, because they are given to different people.
  const manager = await proxy.publish(ACCOUNT, 'manager', 'https://quick-manager-link.trycloudflare.com');
  assert.equal(manager.url, `https://${PROXY_SCRIPT_NAMES.manager}.acme.workers.dev`);
  assert.deepEqual([...account.scripts.keys()].sort(), ['sillytavern', 'stm']);
});

test('the address survives the manager restarting, without redeploying to find out', async () => {
  const { api } = fakeCloudflare();
  const directory = await stateDirectory();
  const published = await new ProxyWorkerManager({ api, stateDirectory: directory }).publish(ACCOUNT, 'manager', 'https://one.trycloudflare.com');

  const after = new ProxyWorkerManager({ api, stateDirectory: directory });
  assert.equal(await after.urlFor('manager'), published.url);
  assert.deepEqual((await after.records()).map((record) => record.target), ['manager']);

  const stored = JSON.parse(await readFile(join(directory, 'cloudflare-proxy.json'), 'utf8')) as { accountId: string; subdomain: string };
  assert.equal(stored.accountId, ACCOUNT);
  assert.equal(stored.subdomain, 'acme');
});

test('a Worker of the account owner\'s by the same name is never replaced', async () => {
  // `stm` is a short, obvious name, and somebody may well already have one.
  // Deploying over it would replace their work with ours.
  const { account, api } = fakeCloudflare();
  account.scripts.set('stm', { bindings: {}, source: 'export default { fetch: () => new Response("mine") }', subdomainEnabled: true });
  const proxy = new ProxyWorkerManager({
    api,
    stateDirectory: await stateDirectory(),
    // Whatever answers on that name is not one of ours.
    fetchImpl: async () => new Response('mine', { status: 200 }),
  });
  await assert.rejects(
    () => proxy.publish(ACCOUNT, 'manager', 'https://one.trycloudflare.com'),
    (error: unknown) => error instanceof CloudflareApiError && error.code === 'proxy_worker_name_taken',
  );
  assert.equal(account.scripts.get('stm')?.source.includes('mine'), true);
  assert.equal(await proxy.urlFor('manager'), null);
});

test('a proxy this manager lost the record of is recognised as its own', async () => {
  // A data directory that did not survive a restart, with the Worker still
  // deployed and still answering. Refusing here would leave the reader with an
  // address that works and a manager that will not admit to it.
  const { account, api } = fakeCloudflare();
  account.scripts.set('stm', { bindings: { ORIGIN: 'https://old.trycloudflare.com' }, source: PROXY_WORKER_SOURCE, subdomainEnabled: true });
  const proxy = new ProxyWorkerManager({
    api,
    stateDirectory: await stateDirectory(),
    fetchImpl: async (input) => String(input).endsWith(PROXY_VERSION_PATH)
      ? Response.json({ version: PROXY_WORKER_VERSION, target: 'manager', origin: 'https://old.trycloudflare.com' })
      : new Response('no', { status: 404 }),
  });
  const record = await proxy.publish(ACCOUNT, 'manager', 'https://new.trycloudflare.com');
  assert.equal(record.url, 'https://stm.acme.workers.dev');
  assert.equal(account.scripts.get('stm')?.bindings.ORIGIN, 'https://new.trycloudflare.com');
});

test('a tunnel that has been turned off leaves an address that says so', async () => {
  const { account, api } = fakeCloudflare();
  const proxy = new ProxyWorkerManager({ api, stateDirectory: await stateDirectory() });
  await proxy.publish(ACCOUNT, 'sillyTavern', 'https://one.trycloudflare.com');
  const off = await proxy.publish(ACCOUNT, 'sillyTavern', null);
  assert.equal(off.origin, null);
  // Not the old origin: that hostname is gone from DNS, and forwarding to it
  // would hand the reader a Cloudflare error about a name they never saw.
  assert.equal(account.scripts.get('sillytavern')?.bindings.ORIGIN, '');
});

test('signing out of the account takes the Workers with it', async () => {
  const { account, api } = fakeCloudflare();
  const directory = await stateDirectory();
  const proxy = new ProxyWorkerManager({ api, stateDirectory: directory });
  await proxy.publish(ACCOUNT, 'manager', 'https://one.trycloudflare.com');
  await proxy.publish(ACCOUNT, 'sillyTavern', 'https://two.trycloudflare.com');

  assert.equal(await proxy.remove(ACCOUNT, 'manager'), true);
  assert.equal(await proxy.remove(ACCOUNT, 'sillyTavern'), true);
  assert.deepEqual([...account.scripts.keys()], []);
  // Nothing left to remove is not a failure.
  assert.equal(await proxy.remove(ACCOUNT, 'manager'), false);
  assert.deepEqual(await proxy.records(), []);
});

test('a different account is a different subdomain and different scripts', async () => {
  const other = 'fedcba9876543210fedcba9876543210';
  const { account, api } = fakeCloudflare();
  const directory = await stateDirectory();
  const proxy = new ProxyWorkerManager({ api, stateDirectory: directory, fetchImpl: async () => new Response('no', { status: 404 }) });
  await proxy.publish(ACCOUNT, 'manager', 'https://one.trycloudflare.com');
  account.subdomain = 'other-account';
  account.scripts.clear();
  const moved = await proxy.publish(other, 'manager', 'https://two.trycloudflare.com');
  assert.equal(moved.url, 'https://stm.other-account.workers.dev');
  assert.equal(await proxy.urlFor('manager'), moved.url);
});

test('an account with no workers.dev subdomain is given one', async () => {
  const { account, api } = fakeCloudflare({ subdomain: null });
  const proxy = new ProxyWorkerManager({ api, stateDirectory: await stateDirectory() });
  const record = await proxy.publish(ACCOUNT, 'manager', 'https://one.trycloudflare.com');
  assert.equal(account.subdomain, `stm-${ACCOUNT.slice(0, 12)}`);
  assert.equal(record.url, `https://stm.${account.subdomain}.workers.dev`);
});

test('whatever the caller hands over, the binding is an origin and nothing more', () => {
  // A path or a query on the binding would be silently prepended to every
  // request the Worker forwards.
  assert.equal(normalizeOrigin('https://one.trycloudflare.com/'), 'https://one.trycloudflare.com');
  assert.equal(normalizeOrigin('https://one.trycloudflare.com/some/path?x=1'), 'https://one.trycloudflare.com');
});
