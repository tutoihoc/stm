import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import { StateStore } from '../src/state.js';
import { preferredNetworkHost, startManagerServer, type ManagerServer } from '../src/server.js';
import type { AccessGatewayState, Installation, ProcessState, TunnelState, VersionOption } from '../../../packages/contracts/src/index.js';
import type { TunnelManager } from '../../../packages/tunnel/src/index.js';
import type { ProxyWorkerManager } from '../../../packages/cloudflare/src/index.js';
import { decodeState } from '../../../packages/cloudflare/src/index.js';
import type { RuntimeManager } from '../../../packages/sillytavern-runtime/src/index.js';
import type { ProcessSupervisor } from '../src/supervisor.js';
import { SILLYTAVERN_PORT } from '../src/ports.js';

async function createServer(options: {
  bootstrapPassword?: string;
  platform?: 'linux' | 'modelscope';
  /** An existing data directory, for starting the same manager again. */
  root?: string;
  /** Runs before the server starts, for leaving files an older version wrote. */
  prepare?: (paths: ReturnType<typeof getPlatformPaths>) => Promise<void>;
  /** Stands in for the console's own tunnel, so no cloudflared is launched. */
  managerTunnel?: FakeTunnel;
  /** Stands in for the Workers that give the tunnels a fixed address. */
  proxy?: { urlFor(target: 'manager' | 'sillyTavern'): Promise<string | null> };
  /** As `STM_PUBLIC_ORIGIN` would name it. */
  publicOrigin?: string;
} = {}): Promise<ManagerServer> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'stm-manager-'));
  const basePaths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const paths = options.platform === 'modelscope' ? { ...basePaths, platform: 'modelscope' as const } : basePaths;
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  await options.prepare?.(paths);
  const store = new StateStore({ paths });
  return startManagerServer({
    host: '127.0.0.1',
    port: 0,
    paths,
    store,
    env: options.bootstrapPassword ? { STM_ADMIN_PASSWORD: options.bootstrapPassword } : {},
    secureCookies: false,
    accessPort: 0,
    staticRoot,
    logger: () => undefined,
    ...(options.managerTunnel ? { managerTunnel: options.managerTunnel as unknown as TunnelManager } : {}),
    ...(options.proxy ? { proxy: options.proxy as unknown as ProxyWorkerManager } : {}),
    ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}),
  });
}

/**
 * A tunnel that reports whatever address the test gives it.
 *
 * Only the part the server reads is here: which mode it is in and what address
 * it is answering on. Starting a real one would download cloudflared and open
 * a link to the internet from a test run.
 */
interface FakeTunnel {
  getState(): TunnelState;
  start(mode: 'quick' | 'named'): Promise<TunnelState>;
  disable(): Promise<TunnelState>;
  resume(): Promise<TunnelState>;
  close(): Promise<void>;
  /** Hand it the address cloudflared would have announced, or take it away. */
  publish(url: string | null): void;
}

function fakeTunnel(): FakeTunnel {
  let state: TunnelState = { mode: 'off', status: 'stopped', url: null, startedAt: null, error: null };
  return {
    getState: () => state,
    start: async (mode) => { state = { ...state, mode, status: 'starting' }; return state; },
    disable: async () => { state = { mode: 'off', status: 'stopped', url: null, startedAt: null, error: null }; return state; },
    resume: async () => state,
    close: async () => undefined,
    publish: (url) => { state = { ...state, url, status: url ? 'running' : state.status }; },
  };
}

test('ModelScope proxy origins are accepted while unrelated origins remain blocked', async (t) => {
  const manager = await createServer({ platform: 'modelscope', bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const proxied = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://www.modelscope.ai' } });
  assert.equal(proxied.status, 200);
  const studioFrame = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://locmay-stm.ms.fun' } });
  assert.equal(studioFrame.status, 200);
  const unrelated = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(unrelated.status, 403);
  assert.equal((await unrelated.json() as { error: { code: string } }).error.code, 'origin_rejected');
});

test('the console trusts its own fixed address, and signs in through it', async (t) => {
  /*
   * A browser at the Worker's address sends that as its `Origin`, while `Host`
   * by the time the request arrives is the tunnel's random hostname - so the
   * two never match and the console refused its own sign-in form with
   * `origin_rejected`. The address opened, showed the page, and could not be
   * used, which is worse than not opening: it looks like the password is wrong.
   */
  const tunnel = fakeTunnel();
  const manager = await createServer({
    bootstrapPassword: 'correct horse battery staple',
    managerTunnel: tunnel,
    proxy: { urlFor: async (target) => target === 'manager' ? 'https://stm.acme.workers.dev' : 'https://sillytavern.acme.workers.dev' },
  });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  await tunnel.start('quick');
  tunnel.publish('https://inspector-moss-hints-pitch.trycloudflare.com');

  const throughWorker = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://stm.acme.workers.dev' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(throughWorker.status, 200);

  // The tunnel behind it still works, and a stranger still does not.
  const throughTunnel = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://inspector-moss-hints-pitch.trycloudflare.com' } });
  assert.equal(throughTunnel.status, 200);
  const unrelated = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://stm.someone-else.workers.dev' } });
  assert.equal(unrelated.status, 403);

  /*
   * And a Worker with nothing behind it is not an address the console answers
   * on. With the tunnel off it serves its own "not open" page to everybody, so
   * naming it here would be claiming a way in that does not exist.
   */
  await tunnel.disable();
  const shut = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://stm.acme.workers.dev' } });
  assert.equal(shut.status, 403);
});

/** Set the password on a fresh manager, or sign in to one that has it. */
async function signIn(base: string, password = 'correct horse battery staple'): Promise<{ cookie: string; csrfToken: string }> {
  const status = await (await fetch(`${base}/api/v1/setup/status`)).json() as { setupRequired: boolean };
  const response = status.setupRequired
    ? await fetch(`${base}/api/v1/setup/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password, termsAccepted: true, telemetryAccepted: true }) })
    : await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(response.ok, true, `signing in answered ${response.status}`);
  const body = await response.json() as { session: { csrfToken: string } };
  return { cookie: cookieFrom(response), csrfToken: body.session.csrfToken };
}

function serverUrl(manager: ManagerServer): string {
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie');
  assert.ok(header);
  const match = /stm_session=[^;]+/.exec(header);
  assert.ok(match);
  return match[0];
}

test('setup, login, CSRF, health, and logout work on the manager port', async (t) => {
  const manager = await createServer();
  t.after(() => manager.close());
  const base = serverUrl(manager);

  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  // The port it is actually listening on, not the one it would have taken by
  // default: `STM_PORT` can move it, and a test asks for an ephemeral one.
  assert.equal((await health.json() as { manager: { port: number } }).manager.port, manager.port);

  const panel = await fetch(`${base}/`);
  assert.equal(panel.status, 200);
  assert.match(panel.headers.get('content-type') ?? '', /text\/html/);

  const setupStatus = await fetch(`${base}/api/v1/setup/status`);
  assert.equal(setupStatus.status, 200);
  assert.equal((await setupStatus.json() as { setupRequired: boolean }).setupRequired, true);

  const setup = await fetch(`${base}/api/v1/setup/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple', termsAccepted: true, telemetryAccepted: true }),
  });
  assert.equal(setup.status, 201);
  const setupBody = await setup.json() as { session: { csrfToken: string } };
  const cookie = cookieFrom(setup);

  const unauthenticated = await fetch(`${base}/api/v1/profiles`);
  assert.equal(unauthenticated.status, 401);
  const protectedResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  assert.equal(protectedResponse.status, 200);
  assert.deepEqual((await protectedResponse.json() as { profiles: unknown[] }).profiles, []);
  await manager.metrics.append({ schemaVersion: 1, timestamp: new Date().toISOString(), provider: 'openai', model: 'gpt-test', endpointHost: 'api.openai.com', stream: false, maxTokens: 128, inputTokens: 4, outputTokens: 6, totalTokens: 10, status: 200, durationMs: 25 });
  const metricsResponse = await fetch(`${base}/api/v1/metrics?days=7`, { headers: { cookie } });
  assert.equal(metricsResponse.status, 200);
  assert.equal((await metricsResponse.json() as { totals: { requests: number; totalTokens: number } }).totals.requests, 1);
  const missingProfileActivation = await fetch(`${base}/api/v1/profiles/missing/activate`, { method: 'POST', headers: { cookie, 'x-csrf-token': setupBody.session.csrfToken } });
  assert.equal(missingProfileActivation.status, 404);
  assert.equal((await missingProfileActivation.json() as { error: { code: string } }).error.code, 'profile_not_found');

  const csrfFailure = await fetch(`${base}/api/v1/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.equal(csrfFailure.status, 403);
  const logout = await fetch(`${base}/api/v1/auth/logout`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': setupBody.session.csrfToken },
  });
  assert.equal(logout.status, 200);

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  assert.ok(cookieFrom(login));
});

test('STM_ADMIN_PASSWORD bootstraps a fresh installation without exposing the password', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const status = await fetch(`${base}/api/v1/setup/status`);
  assert.equal((await status.json() as { setupRequired: boolean }).setupRequired, false);
  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(login.status, 200);
  const payload = await login.json() as Record<string, unknown>;
  assert.equal(JSON.stringify(payload).includes('correct horse'), false);
});

test('a fresh manager without an environment secret accepts first-run password setup', async (t) => {
  const manager = await createServer();
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const setup = await fetch(`${base}/api/v1/setup/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '123456', termsAccepted: true, telemetryAccepted: true }),
  });
  assert.equal(setup.status, 201);
});

test('starting SillyTavern with the manager is on by default, and stays where it is put', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-startup-'));
  const manager = await createServer({ root, bootstrapPassword: 'correct horse battery staple' });
  const base = serverUrl(manager);
  const auth = await signIn(base);

  // On, because the manager exists to run SillyTavern and a console that has
  // to be told every time is one step in front of the thing people opened.
  const initial = await fetch(`${base}/api/v1/startup`, { headers: { cookie: auth.cookie } });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json() as { startup: { autoStartSillyTavern: boolean } }).startup.autoStartSillyTavern, true);

  const off = await fetch(`${base}/api/v1/startup`, { method: 'PUT', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ autoStartSillyTavern: false }) });
  assert.equal(off.status, 200);
  assert.equal((await off.json() as { startup: { autoStartSillyTavern: boolean } }).startup.autoStartSillyTavern, false);

  // Anything that is not a yes or a no is refused rather than read as one.
  const nonsense = await fetch(`${base}/api/v1/startup`, { method: 'PUT', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ autoStartSillyTavern: 'yes' }) });
  assert.equal(nonsense.status, 400);

  // And it is a setting, so it outlives the process that was told it.
  await manager.close();
  const again = await createServer({ root });
  t.after(() => again.close());
  const restarted = await fetch(`${serverUrl(again)}/api/v1/startup`, { headers: { cookie: (await signIn(serverUrl(again))).cookie } });
  assert.equal((await restarted.json() as { startup: { autoStartSillyTavern: boolean } }).startup.autoStartSillyTavern, false);
});

test('the startup setting is not readable without signing in', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const anonymous = await fetch(`${serverUrl(manager)}/api/v1/startup`);
  assert.equal(anonymous.status, 401);
});

test('authenticated admins can change the manager password without losing persistence', async (t) => {
  const manager = await createServer({ bootstrapPassword: '123456' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const changed = await fetch(`${base}/api/v1/auth/password`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ password: '654321', confirmPassword: '654321' }) });
  assert.equal(changed.status, 200);
  const oldLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '123456' }) });
  assert.equal(oldLogin.status, 401);
  const newLogin = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: '654321' }) });
  assert.equal(newLogin.status, 200);
});

test('R2 settings are authenticated, masked, and preserve masked credentials', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const saved = await fetch(`${base}/api/v1/r2`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, endpoint: 'http://127.0.0.1:9999', bucket: 'stm-test-bucket', accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678' }) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { config: { configured: boolean; accessKeyIdMasked: string; secretAccessKeyConfigured: boolean } };
  assert.equal(savedBody.config.configured, true);
  assert.equal(savedBody.config.accessKeyIdMasked, 'ac********34');
  assert.equal(savedBody.config.secretAccessKeyConfigured, true);
  const preserved = await fetch(`${base}/api/v1/r2`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ accessKeyId: '********', secretAccessKey: '********' }) });
  assert.equal(preserved.status, 200);
  const visible = await fetch(`${base}/api/v1/r2`, { headers: { cookie } });
  const visibleText = await visible.text();
  assert.equal(visible.status, 200);
  assert.equal(visibleText.includes('secret-key-5678'), false);
  assert.equal(visibleText.includes('access-key-1234'), false);
});

test('SillyTavern can be moved to another port, but never onto one the manager holds', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-port-api-'));
  const manager = await createServer({ root, bootstrapPassword: 'correct horse battery staple' });
  // Closed by hand below to reopen the same directory, so the cleanup only runs
  // if the test gave up before getting there.
  let stillOpen = true;
  t.after(async () => { if (stillOpen) await manager.close(); });
  const base = serverUrl(manager);
  const auth = await signIn(base);
  const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, origin: base, 'content-type': 'application/json' };
  const put = (port: unknown): Promise<Response> => fetch(`${base}/api/v1/config/port`, { method: 'PUT', headers, body: JSON.stringify({ port }) });

  const before = await (await fetch(`${base}/api/v1/config/port`, { headers: { cookie: auth.cookie } })).json() as { port: number; reserved: { manager: number } };
  /*
   * Not the preferred number, necessarily.
   *
   * A port this project only prefers steps aside when the machine already holds
   * it, which is the whole point of `settlePort` - so pinning the number here
   * made the test fail on any machine already running a SillyTavern. What the
   * panel has to be told is the port in use, whichever it turned out to be.
   */
  assert.ok(before.port >= SILLYTAVERN_PORT && before.port < SILLYTAVERN_PORT + 64, `SillyTavern is on ${before.port}`);
  assert.notEqual(before.port, manager.port);
  assert.equal(before.reserved.manager, manager.port, 'the panel is told which port the console itself holds');

  // The console answers on this one, so SillyTavern may not have it.
  const clash = await put(manager.port);
  assert.equal(clash.status, 400);
  assert.equal((await clash.json() as { error: { code: string } }).error.code, 'port_conflict');

  const privileged = await put(80);
  assert.equal(privileged.status, 400);
  assert.equal((await privileged.json() as { error: { code: string } }).error.code, 'port_invalid');

  const moved = await put(8123);
  assert.equal(moved.status, 200);
  assert.equal((await moved.json() as { port: number }).port, 8123);
  assert.equal((await (await fetch(`${base}/api/v1/config/port`, { headers: { cookie: auth.cookie } })).json() as { port: number }).port, 8123);

  // It has to outlive the process, or the next start would go back to 8000
  // while the door carried on pointing at 8123.
  stillOpen = false;
  await manager.close();
  const again = await createServer({ root });
  t.after(() => again.close());
  const reopened = serverUrl(again);
  const session = await signIn(reopened);
  assert.equal((await (await fetch(`${reopened}/api/v1/config/port`, { headers: { cookie: session.cookie } })).json() as { port: number }).port, 8123);
});

test('config follows the active runtime, and sharing waits for an access password', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-config-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(join(runtimePath, 'src'), { recursive: true });
  // 1.18 has user accounts, and the store tells versions apart by this file.
  await writeFile(join(runtimePath, 'src', 'users.js'), 'export const users = true;', 'utf8');
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.18.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const processState: ProcessState = { status: 'running', installationId: installation.id, profileId: 'profile-1', pid: 123, startedAt: now, error: null };
  const fakeSupervisor = { getState: () => processState, restart: async () => processState, start: async () => processState, stop: async () => ({ ...processState, status: 'stopped' }), close: async () => undefined } as unknown as ProcessSupervisor;
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilePayload = await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ configPath: string }> };
  const profile = profilePayload.profiles[0]; assert.ok(profile);
  await writeFile(profile.configPath, '# current version config\nlisten: false\nport: 8000\nbasicAuthMode: true\nbasicAuthUser:\n  username: user\n  password: old-secret\n', 'utf8');
  const visible = await fetch(`${base}/api/v1/config`, { headers: { cookie } });
  assert.equal(visible.status, 200);
  const visibleBody = await visible.json() as { runtimeRef: string; rawYaml: string; settings: { listen: boolean; enableUserAccounts: boolean } };
  assert.equal(visibleBody.runtimeRef, '1.18.0');
  assert.equal(visibleBody.settings.enableUserAccounts, false);
  assert.match(visibleBody.rawYaml, /basicAuthUser:/u);
  assert.equal(visibleBody.rawYaml.includes('old-secret'), false);
  // Nothing may be published until there is a password on the door in front
  // of it, whichever SillyTavern version is installed.
  const blocked = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'public_access_password_required');
  const saved = await fetch(`${base}/api/v1/config`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ settings: { lazyLoadCharacters: true } }) });
  assert.equal(saved.status, 200);
  const savedBody = await saved.json() as { config: { rawYaml: string; settings: { listen: boolean; basicAuthMode: boolean; lazyLoadCharacters: boolean } } };
  assert.equal(savedBody.config.settings.lazyLoadCharacters, true);
  assert.equal(savedBody.config.settings.listen, false, 'SillyTavern stays on the loopback address');
  assert.equal(savedBody.config.settings.basicAuthMode, false, 'and its own half-usable protection stays off');
  assert.match(savedBody.config.rawYaml, /basicAuthUser:/u);
  assert.equal(savedBody.config.rawYaml.includes('old-secret'), false);
});

test('only one concurrent first-run setup can create the admin', async (t) => {
  const manager = await createServer();
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const payload = JSON.stringify({ password: 'correct horse battery staple', termsAccepted: true, telemetryAccepted: true });
  const responses = await Promise.all([
    fetch(`${base}/api/v1/setup/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
    fetch(`${base}/api/v1/setup/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort((left, right) => left - right), [201, 409]);
});

test('authenticated installation endpoints return versions and a pollable job', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath: join(root, 'runtime'), markerPath: join(root, 'runtime', '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const versions: VersionOption[] = [{ selector: 'latest', label: '1.2.3', ref: '1.2.3', channel: 'release', tag: '1.2.3', publishedAt: now }];
  const fakeRuntime = {
    listVersions: async () => versions,
    listInstallations: async () => [installation],
    getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
    queueInstall: () => ({ id: 'install-2', promise: Promise.resolve(installation) }),
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const list = await fetch(`${base}/api/v1/versions`, { headers: { cookie } });
  assert.deepEqual((await list.json() as { versions: VersionOption[] }).versions, versions);
  const create = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(create.status, 202);
  const jobId = (await create.json() as { job: { id: string } }).job.id;
  const job = await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } });
  assert.equal(job.status, 200);
  const allLogs = await fetch(`${base}/api/v1/logs?source=all&after=0`, { headers: { cookie } });
  assert.equal(allLogs.status, 200);
  const allLogEntries = (await allLogs.json() as { entries: Array<{ source: string }> }).entries;
  assert.ok(allLogEntries.some((entry) => entry.source === 'manager'));
  const invalidLogs = await fetch(`${base}/api/v1/logs?source=unknown&after=0`, { headers: { cookie } });
  assert.equal(invalidLogs.status, 400);
  const process = await fetch(`${base}/api/v1/process`, { headers: { cookie } });
  assert.equal(process.status, 200);
  assert.ok(['stopped', 'error'].includes((await process.json() as { status: string }).status));
  const processStart = await fetch(`${base}/api/v1/process/start`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(processStart.status, 200);
  assert.equal((await processStart.json() as { status: string }).status, 'error');
  const tunnelStart = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(tunnelStart.status, 409);
});

test('local backup endpoints create, preview, download, and restore a profile archive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-backup-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilesResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  const profile = (await profilesResponse.json() as { profiles: Array<{ dataPath: string; configPath: string }> }).profiles[0];
  assert.ok(profile);
  const profileDataRoot = join(profile.dataPath, 'default-user');
  await mkdir(profileDataRoot, { recursive: true });
  await writeFile(join(profileDataRoot, 'settings.json'), '{"theme":"dark"}', 'utf8');
  await writeFile(profile.configPath, 'listen: false\n', 'utf8');
  const create = await fetch(`${base}/api/v1/backups`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(create.status, 202);
  const createJob = await create.json() as { jobId: string };
  let manifest: { id: string; fileCount: number } | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/${createJob.jobId}`, { headers: { cookie } });
    const job = await jobResponse.json() as { state: string; error?: string };
    if (job.state === 'succeeded') {
      const backupsResponse = await fetch(`${base}/api/v1/backups`, { headers: { cookie } });
      manifest = (await backupsResponse.json() as { backups: Array<{ id: string; fileCount: number }> }).backups[0] ?? null;
      break;
    }
    if (job.state === 'failed') throw new Error(job.error ?? 'backup job failed');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.ok(manifest);
  assert.equal(manifest.fileCount, 2);
  // "Back up now" on data that has not changed writes nothing.
  const early = await fetch(`${base}/api/v1/backups`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'scheduled' }) });
  assert.equal(early.status, 200);
  assert.equal((await early.json() as { unchanged?: boolean }).unchanged, true);
  const preview = await fetch(`${base}/api/v1/backups/${manifest.id}/preview`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json() as { fileCount: number }).fileCount, 2);
  const download = await fetch(`${base}/api/v1/backups/${manifest.id}/download`, { headers: { cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') ?? '', /application\/zip/);
  const archiveBytes = await download.arrayBuffer();
  const importedPreview = await fetch(`${base}/api/v1/backups/import/preview`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/zip' }, body: archiveBytes });
  assert.equal(importedPreview.status, 200);
  const importedBody = await importedPreview.json() as { fileCount: number; backup: { id: string; source: string } };
  assert.equal(importedBody.fileCount, 2);
  assert.equal(importedBody.backup.source, 'uploaded');
  const chunkUploadId = 'server-chunk-upload-1';
  const bytes = new Uint8Array(archiveBytes);
  const split = Math.max(1, Math.ceil(bytes.length / 2));
  for (let index = 0; index < 2; index += 1) {
    const chunk = await fetch(`${base}/api/v1/backups/import/chunk?uploadId=${chunkUploadId}&index=${index}`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/octet-stream' }, body: bytes.slice(index * split, Math.min(bytes.length, (index + 1) * split)) });
    assert.equal(chunk.status, 200);
  }
  const finishedUpload = await fetch(`${base}/api/v1/backups/import/finish`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: chunkUploadId, name: 'chunked-upload.zip', expectedBytes: bytes.length }) });
  assert.equal(finishedUpload.status, 200);
  const chunkedBody = await finishedUpload.json() as { backup: { id: string; source: string } };
  assert.equal(chunkedBody.backup.source, 'uploaded');
  const removedChunked = await fetch(`${base}/api/v1/backups/${chunkedBody.backup.id}`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(removedChunked.status, 200);
  const renamed = await fetch(`${base}/api/v1/backups/${importedBody.backup.id}`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Uploaded copy' }) });
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json() as { name: string }).name, 'Uploaded copy.zip');
  const listed = await fetch(`${base}/api/v1/backups`, { headers: { cookie } });
  assert.equal((await listed.json() as { backups: unknown[] }).backups.length, 2);
  const removed = await fetch(`${base}/api/v1/backups/${importedBody.backup.id}`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(removed.status, 200);
  const restore = await fetch(`${base}/api/v1/backups/${manifest.id}/restore`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'replace' }) });
  assert.equal(restore.status, 202);
  const restoreJob = await restore.json() as { jobId: string };
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/${restoreJob.jobId}`, { headers: { cookie } });
    const job = await jobResponse.json() as { state: string; error?: string };
    if (job.state === 'succeeded') break;
    if (job.state === 'failed') throw new Error(job.error ?? 'restore job failed');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.equal(await readFile(join(profile.dataPath, 'default-user', 'settings.json'), 'utf8'), '{"theme":"dark"}');
});

test('installing a new version rebinds the active data profile and keeps its files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-version-profile-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const oldRuntime = join(root, 'old-runtime'); const newRuntime = join(root, 'new-runtime');
  await mkdir(oldRuntime, { recursive: true }); await mkdir(newRuntime, { recursive: true });
  const now = new Date().toISOString();
  const oldInstallation: Installation = { id: 'install-old', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath: oldRuntime, markerPath: join(oldRuntime, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const newInstallation: Installation = { ...oldInstallation, id: 'install-new', resolvedRef: '2.0.0', runtimePath: newRuntime, markerPath: join(newRuntime, '.stm-installation.json') };
  await writeFile(newInstallation.markerPath, '{}', 'utf8');
  let activeInstallation = oldInstallation;
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [oldInstallation, newInstallation], getActiveInstallation: async () => activeInstallation,
    getInstallation: async (id: string) => id === oldInstallation.id ? oldInstallation : id === newInstallation.id ? newInstallation : null,
    queueInstall: () => ({ id: newInstallation.id, promise: Promise.resolve(newInstallation).then((installation) => { activeInstallation = installation; return installation; }) }),
  } as unknown as RuntimeManager;
  let processState: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  const fakeSupervisor = {
    getState: () => processState,
    start: async () => { processState = { ...processState, status: 'running', installationId: newInstallation.id }; return processState; },
    stop: async () => { processState = { ...processState, status: 'stopped' }; return processState; },
    restart: async () => processState,
    close: async () => undefined,
  } as unknown as ProcessSupervisor;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilesResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  const profile = (await profilesResponse.json() as { profiles: Array<{ id: string; dataPath: string; installationId: string }> }).profiles[0];
  assert.ok(profile);
  await writeFile(join(profile.dataPath, 'chat.json'), '{"message":"keep"}', 'utf8');
  const installResponse = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(installResponse.status, 202);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/${newInstallation.id}`, { headers: { cookie } });
    if (jobResponse.ok && (await jobResponse.json() as { state: string }).state === 'succeeded') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  const afterResponse = await fetch(`${base}/api/v1/profiles`, { headers: { cookie } });
  const afterBody = await afterResponse.text();
  assert.equal(afterResponse.status, 200, afterBody);
  const after = (JSON.parse(afterBody) as { profiles: Array<{ installationId: string; dataPath: string }> }).profiles[0];
  assert.equal(after?.installationId, newInstallation.id);
  assert.equal(after?.dataPath, profile.dataPath);
  assert.equal(await readFile(join(profile.dataPath, 'chat.json'), 'utf8'), '{"message":"keep"}');
});

test('a failed install that also fails to restart leaves the manager serving', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-recovery-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.0.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = {
    listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation,
    getInstallation: async (id: string) => id === installation.id ? installation : null,
    queueInstall: () => ({ id: 'install-2', promise: Promise.reject(new Error('the download failed')) }),
  } as unknown as RuntimeManager;
  // Recovery runs because the install already failed, and here it fails too -
  // which used to reject with nobody listening and end the manager process.
  const processState: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  const fakeSupervisor = {
    getState: () => processState,
    start: async () => { throw new Error('the runtime will not start'); },
    stop: async () => processState,
    restart: async () => { throw new Error('the runtime will not start'); },
    close: async () => undefined,
  } as unknown as ProcessSupervisor;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login); const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const installResponse = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(installResponse.status, 202);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const jobResponse = await fetch(`${base}/api/v1/jobs/install-2`, { headers: { cookie } });
    if (jobResponse.ok && (await jobResponse.json() as { state: string }).state === 'failed') break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  // The console is what the operator installs a different version from, so it
  // has to answer after all of that.
  const health = await fetch(`${base}/api/v1/health`);
  assert.equal(health.status, 200);
  const versions = await fetch(`${base}/api/v1/installations`, { headers: { cookie } });
  assert.equal(versions.status, 200);
});

test('one password opens SillyTavern on any version, and nothing is shared before it is set', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-access-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  // No src/users.js and no default/config.yaml: a pre-1.12 runtime, the case
  // that used to have no way to set a password at all.
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: '1.11.0', resolvedRef: '1.11.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const processState: ProcessState = { status: 'running', installationId: installation.id, profileId: 'profile-1', pid: 321, startedAt: now, error: null };
  const fakeSupervisor = { getState: () => processState, restart: async () => processState, start: async () => processState, stop: async () => ({ ...processState, status: 'stopped' }), close: async () => undefined } as unknown as ProcessSupervisor;
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profilePayload = await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ configPath: string }> };
  const profile = profilePayload.profiles[0];
  assert.ok(profile);
  await writeFile(profile.configPath, 'listen: false\nport: 8000\n', 'utf8');

  const before = await (await fetch(`${base}/api/v1/access/security`, { headers: { cookie } })).json() as AccessGatewayState;
  assert.equal(before.passwordConfigured, false);
  assert.equal(before.status, 'running', 'the door is up even on a version that has no password of its own');
  assert.equal(before.lan, false);

  // Neither way of sharing opens while the door has no password.
  for (const request of [
    fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) }),
    fetch(`${base}/api/v1/access/network`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ lan: true }) }),
  ]) {
    const response = await request;
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'public_access_password_required');
  }

  // Anything but six digits is refused: the sign-in page on the far end has a
  // keypad and nothing else to type with.
  for (const rejected of ['a-real-secret', '12345', '1234567', '12345a']) {
    const response = await fetch(`${base}/api/v1/access/password`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ password: rejected, confirmPassword: rejected }) });
    assert.equal(response.status, 400, rejected);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'invalid_passcode', rejected);
  }

  const saved = await fetch(`${base}/api/v1/access/password`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ password: '417203', confirmPassword: '417203' }) });
  assert.equal(saved.status, 200);
  const savedState = await saved.json() as AccessGatewayState;
  assert.equal(savedState.passwordConfigured, true);
  assert.equal(savedState.passcode, true, 'the sign-in page is told to ask for a passcode');
  // The passcode belongs to the manager, so it never lands in SillyTavern's
  // own configuration where a restore or a version switch could carry it off.
  assert.equal((await readFile(profile.configPath, 'utf8')).includes('417203'), false);

  const opened = await fetch(`${base}/api/v1/access/network`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ lan: true }) });
  assert.equal(opened.status, 200);
  const state = await opened.json() as AccessGatewayState;
  assert.equal(state.lan, true);
  assert.equal(state.host, '0.0.0.0');
  const allowed = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'quick' }) });
  assert.notEqual(allowed.status, 409);
});

test('sharing opens before SillyTavern does, because what is published is the door', async (t) => {
  /*
   * The tunnel publishes the access gateway, which is up from the moment the
   * console is. Refusing to open it until SillyTavern answered made the public
   * address depend on the one thing it was built not to depend on, and left
   * somebody setting a machine up unable to do the two steps in the order that
   * suited them - the switch was simply dead, with no way to find out why.
   */
  const root = await mkdtemp(join(tmpdir(), 'stm-share-early-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const stopped: ProcessState = { status: 'stopped', installationId: null, profileId: null, pid: null, startedAt: null, error: null };
  const fakeSupervisor = { getState: () => stopped, restart: async () => stopped, start: async () => stopped, stop: async () => stopped, close: async () => undefined } as unknown as ProcessSupervisor;
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [], getActiveInstallation: async () => null, getInstallation: async () => null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, tunnel: fakeTunnel() as unknown as TunnelManager, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const headers = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

  // Nothing installed and nothing running.
  assert.equal((await (await fetch(`${base}/api/v1/process`, { headers: { cookie } })).json() as ProcessState).status, 'stopped');

  // The PIN is the one thing that cannot wait: it is what stands between the
  // internet and the data.
  const early = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(early.status, 409);
  assert.equal((await early.json() as { error: { code: string } }).error.code, 'public_access_password_required');

  assert.equal((await fetch(`${base}/api/v1/access/password`, { method: 'POST', headers, body: JSON.stringify({ password: '417203', confirmPassword: '417203' }) })).status, 200);

  const tunnel = await fetch(`${base}/api/v1/tunnel`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(tunnel.status, 200, 'the address is ready before the thing behind it is');
  assert.equal((await tunnel.json() as TunnelState).mode, 'quick');

  const lan = await fetch(`${base}/api/v1/access/network`, { method: 'PUT', headers, body: JSON.stringify({ lan: true }) });
  assert.equal(lan.status, 200);
  assert.equal((await lan.json() as AccessGatewayState).lan, true);
});

test('the console will not be opened to the internet without a manager password', async (t) => {
  const manager = await createServer();
  t.after(() => manager.close());
  // The route cannot even be reached before the password exists, so the refusal
  // that matters is the tunnel's own: it is what a resume on the next start
  // goes through, and what would otherwise put an unguarded console online.
  const refused = await manager.managerTunnel.start('quick');
  assert.equal(refused.status, 'error');
  assert.match(refused.error ?? '', /manager password/u);
  assert.equal(refused.url, null);
});

test('the console tunnel is separate from SillyTavern’s, and its address is trusted while it is open', async (t) => {
  const tunnelUrl = 'https://busy-lake-1234.trycloudflare.com';
  const managerTunnel = fakeTunnel();
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple', managerTunnel });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const auth = await signIn(base);
  const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, origin: base, 'content-type': 'application/json' };

  assert.equal((await (await fetch(`${base}/api/v1/manager-tunnel`, { headers: { cookie: auth.cookie } })).json() as TunnelState).mode, 'off');

  // Before it is open, a request claiming to come from that address is a
  // stranger, exactly as any other unknown origin is.
  const early = await fetch(`${base}/api/v1/health`, { headers: { origin: tunnelUrl } });
  assert.equal(early.status, 403);

  const opened = await fetch(`${base}/api/v1/manager-tunnel`, { method: 'PUT', headers, body: JSON.stringify({ mode: 'quick' }) });
  assert.equal(opened.status, 200);
  managerTunnel.publish(tunnelUrl);

  // Now it is one of the console's own addresses: cloudflared leaves its own
  // Host header on the request, so without this every write would be refused.
  const throughTunnel = await fetch(`${base}/api/v1/health`, { headers: { origin: tunnelUrl } });
  assert.equal(throughTunnel.status, 200);
  const stranger = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(stranger.status, 403);

  // And it is where a Cloudflare sign-in is told to come back to.
  const connect = await fetch(`${base}/api/v1/r2/cloudflare/connect`, { method: 'POST', headers });
  assert.equal(connect.status, 200);
  const url = new URL((await connect.json() as { url: string }).url);
  assert.equal(decodeState(url.searchParams.get('state') ?? '')?.returnOrigin, tunnelUrl);

  // SillyTavern's own tunnel is untouched by any of it.
  assert.equal((await (await fetch(`${base}/api/v1/tunnel`, { headers: { cookie: auth.cookie } })).json() as TunnelState).mode, 'off');

  managerTunnel.publish(null);
  const closed = await fetch(`${base}/api/v1/health`, { headers: { origin: tunnelUrl } });
  assert.equal(closed.status, 403, 'a link that is no longer open is no longer one of our addresses');
});

test('an address somebody wrote down outranks one the console opened for itself', async (t) => {
  const tunnelUrl = 'https://busy-lake-1234.trycloudflare.com';
  const configured = 'https://stm.example.com';
  const managerTunnel = fakeTunnel();
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple', managerTunnel, publicOrigin: configured });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const auth = await signIn(base);
  managerTunnel.publish(tunnelUrl);

  // Both are addresses this console answers at, so requests from either are
  // its own rather than a stranger's.
  for (const origin of [configured, tunnelUrl]) {
    assert.equal((await fetch(`${base}/api/v1/health`, { headers: { origin } })).status, 200, origin);
  }

  // But a sign-in goes back to the one that was written down: a tunnel is the
  // console guessing, and STM_PUBLIC_ORIGIN is somebody saying.
  const connect = await fetch(`${base}/api/v1/r2/cloudflare/connect`, { method: 'POST', headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, origin: base } });
  assert.equal(connect.status, 200);
  const url = new URL((await connect.json() as { url: string }).url);
  assert.equal(decodeState(url.searchParams.get('state') ?? '')?.returnOrigin, configured);
});

test('a running backup can be stopped, and a finished one cannot', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-stop-job-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profile = (await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ dataPath: string }> }).profiles[0];
  assert.ok(profile);
  // Enough files that the stop lands while the archive is still being written.
  const dataRoot = join(profile.dataPath, 'default-user');
  await mkdir(dataRoot, { recursive: true });
  for (let index = 0; index < 600; index += 1) {
    await writeFile(join(dataRoot, `note-${index}.json`), JSON.stringify({ index, filler: 'x'.repeat(8192) }), 'utf8');
  }

  const started = await fetch(`${base}/api/v1/backups`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 202);
  const { jobId } = await started.json() as { jobId: string };
  const stopped = await fetch(`${base}/api/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(stopped.status, 200);

  const deadline = Date.now() + 15_000;
  let job = await (await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } })).json() as { state: string; error: string | null };
  while (job.state === 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    job = await (await fetch(`${base}/api/v1/jobs/${jobId}`, { headers: { cookie } })).json() as { state: string; error: string | null };
  }
  assert.equal(job.state, 'canceled');
  assert.equal(job.error, null, 'the operator stopping the work is not an error to report');
  // A stopped backup leaves no half-written entry in the library.
  assert.deepEqual((await (await fetch(`${base}/api/v1/backups`, { headers: { cookie } })).json() as { backups: unknown[] }).backups, []);

  const again = await fetch(`${base}/api/v1/jobs/${jobId}/cancel`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(again.status, 409);
  const missing = await fetch(`${base}/api/v1/jobs/job-nothing/cancel`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(missing.status, 404);
});

test('the launcher shutdown route exists only for the launcher that started the manager', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-shutdown-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  let asked = 0;
  const manager = await startManagerServer({
    host: '127.0.0.1',
    port: 0,
    paths,
    env: { STM_ADMIN_PASSWORD: 'correct horse battery staple', STM_SHUTDOWN_TOKEN: 'launcher-secret' },
    secureCookies: false,
    accessPort: 0,
    logger: () => undefined,
    onShutdownRequest: () => { asked += 1; },
  });
  t.after(() => manager.close());
  const base = serverUrl(manager);

  // Nothing on the machine that has not been told the token can reach it, and
  // it is not even visible as a route to anything that has not.
  const anonymous = await fetch(`${base}/api/v1/shutdown`, { method: 'POST' });
  assert.equal(anonymous.status, 404);
  const wrong = await fetch(`${base}/api/v1/shutdown`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'guess' } });
  assert.equal(wrong.status, 404);
  assert.equal(asked, 0);

  const right = await fetch(`${base}/api/v1/shutdown`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'launcher-secret' } });
  assert.equal(right.status, 202);
  assert.equal(asked, 1);
});

test('no launcher token means no shutdown route at all', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const response = await fetch(`${serverUrl(manager)}/api/v1/shutdown`, { method: 'POST', headers: { 'x-stm-shutdown-token': 'anything' } });
  assert.equal(response.status, 404);
});

test('a legacy runtime that rewrites the profile config on stop does not lose the save', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-legacy-order-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: '1.10.10', resolvedRef: '1.10.10', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const fakeRuntime = { listVersions: async () => [], listInstallations: async () => [installation], getActiveInstallation: async () => installation, getInstallation: async (id: string) => id === installation.id ? installation : null } as unknown as RuntimeManager;

  let processState: ProcessState = { status: 'running', installationId: installation.id, profileId: 'profile-1', pid: 555, startedAt: now, error: null };
  let profileConfigPath = '';
  const runtimeConfigPath = join(runtimePath, 'config.yaml');
  const fakeSupervisor = {
    getState: () => processState,
    start: async () => {
      // Starting copies the profile's config into the runtime, the way
      // preparing a legacy runtime does.
      if (profileConfigPath) await writeFile(runtimeConfigPath, await readFile(profileConfigPath, 'utf8'), 'utf8');
      processState = { ...processState, status: 'running' };
      return processState;
    },
    stop: async () => {
      // And stopping copies the runtime's own config back over the profile's,
      // which is what used to overwrite anything written before the restart.
      try { await writeFile(profileConfigPath, await readFile(runtimeConfigPath, 'utf8'), 'utf8'); } catch { /* nothing written yet */ }
      processState = { ...processState, status: 'stopped' };
      return processState;
    },
    restart: async () => processState,
    close: async () => undefined,
  } as unknown as ProcessSupervisor;

  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const login = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;
  const profile = (await (await fetch(`${base}/api/v1/profiles`, { headers: { cookie } })).json() as { profiles: Array<{ configPath: string }> }).profiles[0];
  assert.ok(profile);
  profileConfigPath = profile.configPath;
  const startingConfig = 'listen: false\nport: 8000\nperformance:\n  lazyLoadCharacters: false\n';
  await writeFile(profileConfigPath, startingConfig, 'utf8');
  await writeFile(runtimeConfigPath, startingConfig, 'utf8');

  const saved = await fetch(`${base}/api/v1/config`, { method: 'PUT', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ settings: { lazyLoadCharacters: true } }) });
  assert.equal(saved.status, 200);
  for (const path of [profileConfigPath, runtimeConfigPath]) {
    assert.match(await readFile(path, 'utf8'), /lazyLoadCharacters: true/u, `the save survived in ${path}`);
  }
});

test('the LAN address offered is one another device can actually reach', () => {
  const wifi = { family: 'IPv4' as const, internal: false, address: '192.168.1.25' };
  const linkLocal = { family: 'IPv4' as const, internal: false, address: '169.254.83.107' };
  const loopback = { family: 'IPv4' as const, internal: true, address: '127.0.0.1' };
  const sixth = { family: 'IPv6' as const, internal: false, address: 'fe80::1' };

  const hotspot = { family: 'IPv4' as const, internal: false, address: '192.168.137.1' };

  // A virtual adapter that assigned itself a link-local address listed first
  // is what put an unreachable host behind the LAN link and its QR code.
  assert.equal(preferredNetworkHost([loopback, linkLocal, wifi, sixth]), '192.168.1.25');
  // Windows Mobile Hotspot is just as private as the Wi-Fi address and just as
  // useless for reaching this machine, so the range alone cannot decide it.
  assert.equal(preferredNetworkHost([hotspot, wifi], '192.168.1.25'), '192.168.1.25');
  assert.equal(preferredNetworkHost([wifi, hotspot], '192.168.137.1'), '192.168.137.1', 'a machine that really does leave by the hotspot says so');
  // A route out through an address no interface reports is not an answer.
  assert.equal(preferredNetworkHost([hotspot, wifi], '10.9.9.9'), '192.168.137.1');
  assert.equal(preferredNetworkHost([loopback, sixth]), undefined);
  assert.equal(preferredNetworkHost([linkLocal]), undefined, 'nothing is better than an address that goes nowhere');
  // A routable address on a network that is not one of the private ranges is
  // still the right answer when it is all there is.
  assert.equal(preferredNetworkHost([{ family: 'IPv4', internal: false, address: '100.103.121.60' }]), '100.103.121.60');
});

test('a list answers the page it was asked for, and the whole list when it was not', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-paging-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const now = new Date().toISOString();
  const base = {
    selector: 'latest' as const, channel: 'release' as const, runtimePath: join(root, 'rt'),
    markerPath: join(root, 'rt', '.stm-installation.json'), status: 'ready' as const, progress: 100,
    step: 'Installation ready', error: null, createdAt: now, updatedAt: now,
  };
  // Named so that sorting by ref has a different answer from the order they
  // are listed in, and so that "1.9.0" against "1.18.0" catches a plain string
  // comparison pretending to be a version sort.
  const installations: Installation[] = [
    { ...base, id: 'i-a', resolvedRef: '1.18.0', activatedAt: now },
    { ...base, id: 'i-b', resolvedRef: '1.9.0', activatedAt: null },
    { ...base, id: 'i-c', resolvedRef: '1.12.3', activatedAt: null },
  ];
  const fakeRuntime = {
    listVersions: async () => [],
    listInstallations: async () => installations,
    getActiveInstallation: async () => installations[0],
    getInstallation: async (id: string) => installations.find((item) => item.id === id) ?? null,
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const url = serverUrl(manager);
  const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const listed = async (query: string) => await (await fetch(`${url}/api/v1/installations${query}`, { headers: { cookie } })).json() as {
    installations: Installation[]; activeInstallationId: string | null; page: { page: number; pageSize: number; total: number; pageCount: number };
  };

  // No parameters: the whole list, described as one page, exactly as the panel
  // has always received it.
  const all = await listed('');
  assert.deepEqual(all.installations.map((row) => row.id), ['i-a', 'i-b', 'i-c']);
  assert.deepEqual(all.page, { page: 1, pageSize: 3, total: 3, pageCount: 1 });
  assert.equal(all.activeInstallationId, 'i-a');

  const second = await listed('?page=2&pageSize=2');
  assert.deepEqual(second.installations.map((row) => row.id), ['i-c']);
  assert.deepEqual(second.page, { page: 2, pageSize: 2, total: 3, pageCount: 2 });
  // The active pointer names a row that is not on this page, and still travels
  // with it - the panel needs it to mark the row wherever it turns up.
  assert.equal(second.activeInstallationId, 'i-a');

  const sorted = await listed('?sort=resolvedRef&direction=asc&pageSize=50');
  assert.deepEqual(sorted.installations.map((row) => row.resolvedRef), ['1.9.0', '1.12.3', '1.18.0']);
  const reversed = await listed('?sort=resolvedRef&direction=desc&pageSize=50');
  assert.deepEqual(reversed.installations.map((row) => row.resolvedRef), ['1.18.0', '1.12.3', '1.9.0']);

  const searched = await listed('?q=1.12');
  assert.deepEqual(searched.installations.map((row) => row.id), ['i-c']);
  assert.equal(searched.page.total, 1);

  // A page past the end is the last page, not an empty table with no way back.
  assert.equal((await listed('?page=99&pageSize=2')).page.page, 2);
  // And a caller cannot ask the manager to walk everything it has at once.
  assert.equal((await listed('?pageSize=100000')).page.pageSize, 200);
});

test('an empty list still answers with one page', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const url = serverUrl(manager);
  const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const payload = await (await fetch(`${url}/api/v1/backups?page=1&pageSize=10`, { headers: { cookie } })).json() as {
    backups: unknown[]; page: { page: number; total: number; pageCount: number };
  };
  assert.deepEqual(payload.backups, []);
  // One page, so the table has somewhere to draw its empty state.
  assert.deepEqual(payload.page, { page: 1, pageSize: 10, total: 0, pageCount: 1 });

  // The same list without a query: still one page, and never a page size of
  // zero for whatever divides by it.
  const unpaged = await (await fetch(`${url}/api/v1/backups`, { headers: { cookie } })).json() as { page: { pageSize: number; pageCount: number } };
  assert.equal(unpaged.page.pageSize, 1);
  assert.equal(unpaged.page.pageCount, 1);
});

test('SillyTavern can be removed, and the request does not wait for the safety copy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-uninstall-api-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.2.3', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'Installation ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  let removed = false;
  let stopped: string | undefined;
  const processState: ProcessState = { status: 'running', installationId: installation.id, profileId: 'profile-1', pid: 1, startedAt: now, error: null };
  const fakeSupervisor = {
    getState: () => processState,
    start: async () => processState,
    stop: async (reason: string) => { stopped = reason; return { ...processState, status: 'stopped' }; },
    close: async () => undefined,
  } as unknown as ProcessSupervisor;

  // A safety copy that never finishes. If the request waited for it, the
  // response below would never arrive - which is exactly what it used to do.
  let beforeInstall: ((report: (progress: number, step: unknown) => Promise<void>) => Promise<void>) | undefined;
  const fakeRuntime = {
    listVersions: async () => [],
    listInstallations: async () => removed ? [] : [installation],
    getActiveInstallation: async () => removed ? null : installation,
    getInstallation: async (id: string) => !removed && id === installation.id ? installation : null,
    removeInstallations: async () => { removed = true; },
    queueInstall: (_selector: string, _onProgress: unknown, before?: typeof beforeInstall) => {
      beforeInstall = before;
      return { id: 'install-2', promise: new Promise<Installation>(() => undefined) };
    },
  } as unknown as RuntimeManager;

  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false,
    accessPort: 0, runtime: fakeRuntime, supervisor: fakeSupervisor, logger: () => undefined });
  t.after(() => manager.close());
  const url = serverUrl(manager);
  const login = await fetch(`${url}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse battery staple' }) });
  const cookie = cookieFrom(login);
  const csrf = (await login.json() as { session: { csrfToken: string } }).session.csrfToken;

  const queued = await fetch(`${url}/api/v1/installations`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(queued.status, 202, 'the install is accepted without waiting for the copy');
  assert.equal((await queued.json() as { installationId: string }).installationId, 'install-2');
  assert.equal(typeof beforeInstall, 'function', 'stopping and copying were handed to the job');

  const uninstall = await fetch(`${url}/api/v1/installations`, { method: 'DELETE', headers: { cookie, 'x-csrf-token': csrf } });
  assert.equal(uninstall.status, 200);
  assert.deepEqual(await uninstall.json(), { ok: true, installations: [], activeInstallationId: null });
  assert.equal(stopped, 'uninstall', 'SillyTavern is stopped before its files go');
  assert.deepEqual((await (await fetch(`${url}/api/v1/installations`, { headers: { cookie } })).json() as { installations: unknown[] }).installations, []);

  // Without the CSRF header it is refused, like every other change.
  const unguarded = await fetch(`${url}/api/v1/installations`, { method: 'DELETE', headers: { cookie } });
  assert.equal(unguarded.status, 403);
});

test('an install already running is handed to a page that did not start it, and can be stopped there', async (t) => {
  /*
   * Two ways a console meets an install it knows nothing about: the page was
   * reloaded during one, and a manager that had just been set up installed
   * SillyTavern by itself on first run. Either way the card has to show the
   * job and offer the way out of it, or the reader is left watching a version
   * list while minutes of work happen invisibly behind it.
   */
  const root = await mkdtemp(join(tmpdir(), 'stm-manager-adopt-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  let cancelled: AbortSignal | null = null;
  const fakeRuntime = {
    listVersions: async () => [],
    listInstallations: async () => [],
    getActiveInstallation: async () => null,
    getInstallation: async () => null,
    queueInstall: (_selector: string, _onProgress: unknown, _before: unknown, signal?: AbortSignal) => {
      cancelled = signal ?? null;
      return { id: 'install-9', promise: new Promise<Installation>(() => undefined) };
    },
  } as unknown as RuntimeManager;
  const manager = await startManagerServer({ host: '127.0.0.1', port: 0, paths, env: { STM_ADMIN_PASSWORD: 'correct horse battery staple' }, secureCookies: false, accessPort: 0, runtime: fakeRuntime, logger: () => undefined });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const auth = await signIn(base);
  const headers = { cookie: auth.cookie, 'x-csrf-token': auth.csrfToken, 'content-type': 'application/json' };

  // Nothing running: nothing to adopt, and the panel shows the version list.
  const idle = await fetch(`${base}/api/v1/installations`, { headers: { cookie: auth.cookie } });
  assert.equal((await idle.json() as { activeJob: unknown }).activeJob, null);

  const queued = await fetch(`${base}/api/v1/installations`, { method: 'POST', headers, body: JSON.stringify({ version: 'latest' }) });
  assert.equal(queued.status, 202);

  // A page that has just loaded asks the same question and is told what is
  // happening, which installation it is for, and the job to follow.
  const listed = await fetch(`${base}/api/v1/installations`, { headers: { cookie: auth.cookie } });
  const active = (await listed.json() as { activeJob: { id: string; kind: string; state: string; installationId: string } | null }).activeJob;
  assert.equal(active?.kind, 'installation');
  assert.equal(active?.state, 'running');
  assert.equal(active?.installationId, 'install-9');

  // And the Stop button on that card reaches the install itself.
  const stop = await fetch(`${base}/api/v1/jobs/${active?.id}/cancel`, { method: 'POST', headers });
  assert.equal(stop.status, 200);
  assert.equal((cancelled as AbortSignal | null)?.aborted, true, 'the runtime was told to stop, not just the job marked');
});

test('the local backup schedule is read and changed over HTTP, and survives a restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-manager-schedule-'));
  const first = await createServer({ root });
  let firstClosed = false;
  t.after(async () => { if (!firstClosed) await first.close(); });
  const base = serverUrl(first);

  assert.equal((await fetch(`${base}/api/v1/backups/schedule`)).status, 401);
  const { cookie, csrfToken } = await signIn(base);
  const put = (body: unknown, headers: Record<string, string> = { 'x-csrf-token': csrfToken }) => fetch(`${base}/api/v1/backups/schedule`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const read = async () => {
    const response = await fetch(`${base}/api/v1/backups/schedule`, { headers: { cookie } });
    assert.equal(response.status, 200);
    return (await response.json() as { schedule: { intervalMinutes: number } }).schedule.intervalMinutes;
  };

  assert.equal(await read(), 30);

  // A change without the CSRF token is refused and changes nothing.
  assert.notEqual((await put({ intervalMinutes: 360 }, {})).status, 200);
  assert.equal(await read(), 30);

  const saved = await put({ intervalMinutes: 360 });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json() as { schedule: { intervalMinutes: number } }).schedule.intervalMinutes, 360);

  for (const invalid of [{ intervalMinutes: -1 }, { intervalMinutes: 7 * 24 * 60 + 1 }, { intervalMinutes: 1.5 }, { intervalMinutes: '360' }, {}]) {
    const refused = await put(invalid);
    assert.equal(refused.status, 400, JSON.stringify(invalid));
    assert.equal((await refused.json() as { error: { code: string } }).error.code, 'invalid_backup_schedule');
  }
  assert.equal(await read(), 360);

  // Kept with the backup library, and nowhere in the R2 settings.
  const library = JSON.parse(await readFile(join(first.store.paths.state, 'backups.json'), 'utf8')) as { schedule?: { intervalMinutes: number } };
  assert.equal(library.schedule?.intervalMinutes, 360);
  const r2 = await (await fetch(`${base}/api/v1/r2`, { headers: { cookie } })).json() as { config: { schedule: Record<string, unknown> } };
  assert.equal('localIntervalMinutes' in r2.config.schedule, false);

  await first.close();
  firstClosed = true;
  const second = await createServer({ root });
  t.after(() => second.close());
  const again = await signIn(serverUrl(second));
  const reread = await fetch(`${serverUrl(second)}/api/v1/backups/schedule`, { headers: { cookie: again.cookie } });
  assert.equal((await reread.json() as { schedule: { intervalMinutes: number } }).schedule.intervalMinutes, 360);
});

test('an interval an older version kept with the R2 settings moves to the backup library on start', async (t) => {
  const manager = await createServer({
    prepare: async (paths) => {
      await mkdir(paths.state, { recursive: true });
      await writeFile(join(paths.state, 'r2-config.json'), JSON.stringify({
        schemaVersion: 2, enabled: false, endpoint: null, bucket: null, accessKeyId: null, secretAccessKey: null, localIntervalMinutes: 30,
      }), 'utf8');
    },
  });
  t.after(() => manager.close());
  const base = serverUrl(manager);
  const { cookie } = await signIn(base);

  const response = await fetch(`${base}/api/v1/backups/schedule`, { headers: { cookie } });
  assert.equal((await response.json() as { schedule: { intervalMinutes: number } }).schedule.intervalMinutes, 30);
  // Handed over once: the R2 file no longer carries it.
  assert.equal((await readFile(join(manager.store.paths.state, 'r2-config.json'), 'utf8')).includes('localIntervalMinutes'), false);
});

test('a console behind a proxy is reached at the address the browser used, not the one we see', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);

  // A proxy that rewrites Host leaves the browser's own address here instead.
  // Without reading it, every request from the panel it is serving looks like
  // one from a stranger and the console answers nothing at all.
  const forwarded = await fetch(`${base}/api/v1/health`, {
    headers: { origin: 'https://console.example.net', 'x-forwarded-host': 'console.example.net' },
  });
  assert.equal(forwarded.status, 200);

  // A chain of proxies appends to the header; the browser's is the first.
  const chained = await fetch(`${base}/api/v1/health`, {
    headers: { origin: 'https://console.example.net', 'x-forwarded-host': 'console.example.net, inner.internal' },
  });
  assert.equal(chained.status, 200);

  // And it is still only that address: a header naming one host does not let a
  // different one through behind it.
  const stranger = await fetch(`${base}/api/v1/health`, {
    headers: { origin: 'https://evil.example', 'x-forwarded-host': 'console.example.net' },
  });
  assert.equal(stranger.status, 403);
});

test('a session started over HTTPS that a proxy terminated is one a frame can keep', async (t) => {
  const manager = await createServer({ bootstrapPassword: 'correct horse battery staple' });
  t.after(() => manager.close());
  const base = serverUrl(manager);

  // This connection is plain HTTP, and the browser's was not. Only the proxy's
  // header says so, and the cookie's attributes depend on the answer: a console
  // read inside another site's frame needs SameSite=None, which needs Secure.
  const secure = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.get('set-cookie') ?? '', /SameSite=None; Secure/);

  // On a machine somebody is sitting at, none of that applies and the cookie
  // stays as narrow as it has always been.
  const plain = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'correct horse battery staple' }),
  });
  assert.equal(plain.status, 200);
  assert.match(plain.headers.get('set-cookie') ?? '', /SameSite=Lax/);
  assert.doesNotMatch(plain.headers.get('set-cookie') ?? '', /Secure/);
});

test('a host that names the port it publishes gets a console that answers on it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-manager-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  // No host given, so the manager picks one. PORT is how a container platform
  // says it will be connecting from in front of this process, and nothing in
  // front of a container can reach the container's own loopback address.
  const manager = await startManagerServer({
    port: 0, paths, staticRoot, accessPort: 0, logger: () => undefined,
    store: new StateStore({ paths }),
    env: { PORT: '3000' },
  });
  t.after(() => manager.close());
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '0.0.0.0');
});

test('a console on a machine somebody is sitting at stays on the loopback address', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-manager-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const staticRoot = join(root, 'panel');
  await mkdir(staticRoot, { recursive: true });
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Manager panel</title>', 'utf8');
  // A port written down by hand is not a platform in front of anything, so it
  // must not open the console to the house network on its own.
  const manager = await startManagerServer({
    port: 0, paths, staticRoot, accessPort: 0, logger: () => undefined,
    store: new StateStore({ paths }),
    env: { STM_PORT: '9000' },
  });
  t.after(() => manager.close());
  const address = manager.server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
});
