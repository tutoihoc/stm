import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn as spawnType } from 'node:child_process';
import { getPlatformPaths } from '../../platform/src/index.js';
import { parseTunnelUrl, TunnelManager } from '../src/index.js';

const binaryName = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';

async function createPaths(): Promise<ReturnType<typeof getPlatformPaths>> {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-'));
  return getPlatformPaths({ env: { STM_DATA_DIR: root } });
}

/** A cloudflared that never runs, so the manager's own behaviour is what is under test. */
interface FakeCloudflared extends EventEmitter {
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  exitCode: number | null;
  kill(signal?: NodeJS.Signals): boolean;
}

function fakeCloudflared(): FakeCloudflared {
  const child = new EventEmitter() as FakeCloudflared;
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    // A real process does not exit inside the call that signals it, and a fake
    // that does would let a missing `close` listener pass unnoticed.
    kill(): boolean { setImmediate(() => { child.exitCode = 0; child.emit('close', null, 'SIGTERM'); }); return true; },
  });
  return child;
}

/** A binary that is already present, so nothing is downloaded during a test. */
async function installFakeBinary(paths: ReturnType<typeof getPlatformPaths>): Promise<void> {
  await mkdir(paths.bin, { recursive: true });
  await writeFile(join(paths.bin, binaryName), 'fake cloudflared', { mode: 0o755 });
}

/**
 * A network that is not there.
 *
 * Every tunnel that reaches "running" asks the address it was handed whether
 * it really answers, and no test may reach out to trycloudflare.com to find
 * out. A request that fails proves nothing about the tunnel, so this is also
 * what the manager is meant to do nothing about.
 */
const offline = (async () => { throw new Error('the network must not be reached'); }) as unknown as typeof globalThis.fetch;

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = (): void => {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`timed out waiting for ${label}`)); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

test('cloudflared is downloaded on first use and reused afterwards', async () => {
  const paths = await createPaths();
  let requests = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    requests += 1;
    assert.match(String(url), /cloudflare\/cloudflared\/releases\/latest\/download\//u);
    return new Response('#!/bin/true\n', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });

  const first = await tunnel.ensureBinary();
  assert.equal(first, join(paths.bin, binaryName));
  assert.equal(await readFile(first, 'utf8'), '#!/bin/true\n');
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o111, 0o111);

  // A second start must not fetch it again, and must not leave a part file.
  assert.equal(await tunnel.ensureBinary(), first);
  assert.equal(requests, 1);
  assert.deepEqual((await readdir(paths.bin)).sort(), [binaryName]);
});

test('a binary already on disk is used without a download', async () => {
  const paths = await createPaths();
  await mkdir(paths.bin, { recursive: true });
  await writeFile(join(paths.bin, binaryName), 'already here', { mode: 0o755 });
  const fetchImpl = (async () => { throw new Error('the network must not be reached'); }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });
  assert.equal(await tunnel.ensureBinary(), join(paths.bin, binaryName));
});

/**
 * A Linux binary with the load address Cloudflare's own builds use (2, fixed)
 * or the one Android insists on (3, position-independent).
 */
function elfBinary(type: 2 | 3): Buffer {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0);
  header.writeUInt16LE(type, 16);
  header.writeUInt16LE(183, 18);
  return header;
}

test('on Termux a build Android will not start is run through proot instead', async () => {
  // A Termux prefix, which is how the manager knows it is on Android at all.
  const prefix = await mkdtemp(join(tmpdir(), 'com.termux-'));
  const root = join(prefix, 'var', 'sillytavern-manager');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root, PREFIX: prefix } });
  // Cloudflare's own build: the one the manager downloads, and the one Android
  // refuses to start on its own.
  const cloudflared = join(prefix, binaryName);
  await writeFile(cloudflared, elfBinary(2), { mode: 0o755 });
  await mkdir(join(prefix, 'bin'), { recursive: true });
  const chroot = join(prefix, 'bin', 'termux-chroot');
  await writeFile(chroot, 'proot stub', { mode: 0o755 });
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]): ChildProcess => {
    spawns.push({ command, args });
    return fakeCloudflared() as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({ paths, binaryPath: cloudflared, spawnImpl, env: { PATH: '', PREFIX: prefix }, logger: () => undefined });

  const state = await tunnel.start('quick');
  assert.equal(state.status, 'starting');
  assert.equal(spawns[0]?.command, chroot);
  assert.deepEqual(spawns[0]?.args.slice(0, 2), [cloudflared, 'tunnel']);
  // A phone is where QUIC is blocked and IPv6 is half-configured.
  assert.deepEqual(spawns[0]?.args.slice(2), ['--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4', '--url', 'http://127.0.0.1:8001']);
  await tunnel.close();
});

test('on Termux a build Android starts by itself needs no proot in front of it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-tunnel-termux-native-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root, PREFIX: '/data/data/com.termux/files/usr' } });
  // What `pkg install cloudflared` leaves behind: a position-independent build.
  const packaged = join(root, binaryName);
  await writeFile(packaged, elfBinary(3), { mode: 0o755 });
  const spawns: Array<{ command: string; args: readonly string[] }> = [];
  const spawnImpl = ((command: string, args: readonly string[]): ChildProcess => {
    spawns.push({ command, args });
    return fakeCloudflared() as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({ paths, binaryPath: packaged, spawnImpl, env: { PATH: '' }, logger: () => undefined });

  await tunnel.start('quick');
  assert.equal(spawns[0]?.command, packaged);
  assert.equal(spawns[0]?.args[0], 'tunnel');
  await tunnel.close();
});

test('a cloudflared on PATH is found without any help from the system', async () => {
  // Termux has no `which` until someone installs it, so PATH is walked here.
  const paths = await createPaths();
  const elsewhere = await mkdtemp(join(tmpdir(), 'stm-tunnel-path-'));
  const onPath = join(elsewhere, binaryName);
  await writeFile(onPath, 'already here', { mode: 0o755 });
  const fetchImpl = (async () => { throw new Error('the network must not be reached'); }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: elsewhere }, logger: () => undefined });
  assert.equal(await tunnel.ensureBinary(), onPath);
});

test('a fixed-address binary is left alone off Android, where the loader runs it', async () => {
  const paths = await createPaths();
  await mkdir(paths.bin, { recursive: true });
  await writeFile(join(paths.bin, binaryName), elfBinary(2), { mode: 0o755 });
  const fetchImpl = (async () => { throw new Error('the network must not be reached'); }) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });
  assert.equal(await tunnel.ensureBinary(), join(paths.bin, binaryName));
});

test('a failed download reports the status and leaves nothing behind', async () => {
  const paths = await createPaths();
  const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, fetchImpl, env: { PATH: '' }, logger: () => undefined });
  await assert.rejects(() => tunnel.ensureBinary(), /HTTP 503/u);

  const state = await tunnel.start('quick');
  assert.equal(state.status, 'error');
  assert.match(state.error ?? '', /HTTP 503/u);
});

test('the public address is the address, not whatever someone just opened', () => {
  // cloudflared names the address once in a banner and then again in every
  // request it logs. Allowing a path after the hostname meant the link shown
  // in the console became whichever file was fetched last, and changed again
  // on the next line - which is what made it look like it would not sit still.
  const banner = '2026-09-14T03:17:39Z INF |  https://cedar-married-designer-ticket.trycloudflare.com                    |';
  assert.equal(parseTunnelUrl(banner), 'https://cedar-married-designer-ticket.trycloudflare.com');

  const request = '2026-09-14T03:47:36Z ERR Request failed error="Incoming request ended abruptly" connIndex=0 dest=https://surgical-similarly-meters-astronomy.trycloudflare.com/user/images/Assistant/1786509894388_5328437723185702.mp4 event=0';
  assert.equal(parseTunnelUrl(request), 'https://surgical-similarly-meters-astronomy.trycloudflare.com');

  const root = 'ERR dest=https://spectrum-volleyball-melissa-cottage.trycloudflare.com/ event=0';
  assert.equal(parseTunnelUrl(root), 'https://spectrum-volleyball-melissa-cottage.trycloudflare.com');

  assert.equal(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...'), undefined);
});

test('an exit nobody asked for is reconnected, and a requested stop is not', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const lines: string[] = [];
  const spawnImpl = ((): ChildProcess => {
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({
    paths,
    spawnImpl,
    env: { PATH: '' },
    reconnectDelaysMs: [5],
    fetchImpl: offline,
    logger: (line) => { lines.push(typeof line === 'string' ? line : line.message); },
  });

  await tunnel.start('quick');
  assert.equal(children.length, 1);
  children[0]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the first tunnel to come up');

  // cloudflared going away on its own is the case the operator never sees: the
  // link people have open stops working and nothing says so.
  children[0]!.emit('close', 1, null);
  await waitFor(() => children.length === 2, 'a reconnect');
  assert.ok(lines.some((line) => line.includes('reconnecting in')));
  children[1]!.stdout.write('INF |  https://spectrum-volleyball-melissa-cottage.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the replacement tunnel to come up');

  // Turning it off is a decision, not a fault, so nothing must reopen it.
  await tunnel.disable();
  assert.equal(tunnel.getState().mode, 'off');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(children.length, 2);
  await tunnel.close();
});

test('a tunnel that was on comes back when the manager starts again', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const spawnImpl = (() => fakeCloudflared() as unknown as ChildProcess) as unknown as typeof spawnType;
  const options = { paths, spawnImpl, env: { PATH: '' }, logger: () => undefined };

  // Nothing stored yet: a first start must not open anything by itself.
  assert.equal((await new TunnelManager(options).resume()).mode, 'off');

  const first = new TunnelManager(options);
  await first.start('quick');
  // The manager going down is not the operator turning the tunnel off.
  await first.close();

  const second = new TunnelManager(options);
  assert.equal((await second.resume()).mode, 'quick');
  await second.disable();

  // ...and once it is off, it stays off across a restart too.
  assert.equal((await new TunnelManager(options).resume()).mode, 'off');
});

test('two tunnels starting together fetch cloudflared once between them', async () => {
  const paths = await createPaths();
  let requests = 0;
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async () => {
    requests += 1;
    // Hold the first fetch open so the second call arrives while it is still
    // in flight, which is the case the shared promise exists for.
    await held;
    return new Response('#!/bin/true\n', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const options = { paths, fetchImpl, env: { PATH: '' }, logger: () => undefined };
  const forSillyTavern = new TunnelManager(options);
  const forConsole = new TunnelManager({ ...options, stateFile: 'manager-tunnel-config.json' });

  const both = Promise.all([forSillyTavern.ensureBinary(), forConsole.ensureBinary()]);
  release();
  const [a, b] = await both;
  assert.equal(a, join(paths.bin, binaryName));
  assert.equal(b, a);
  assert.equal(requests, 1, 'the second tunnel waits for the first fetch rather than starting its own');
  assert.deepEqual((await readdir(paths.bin)).sort(), [binaryName], 'and no part file is left behind');

  // Once it is there, a later start reuses it without another fetch.
  assert.equal(await forConsole.ensureBinary(), a);
  assert.equal(requests, 1);
});

test('each tunnel remembers its own mode, and publishes its own address', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const started: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    started.push([...args]);
    return fakeCloudflared() as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const options = { paths, spawnImpl, env: { PATH: '' }, logger: () => undefined };
  const forSillyTavern = new TunnelManager({ ...options, targetUrl: 'http://127.0.0.1:8001' });
  // The console does not know its port until it has bound one, so it hands
  // over a function rather than an address.
  let consolePort = 7860;
  const forConsole = new TunnelManager({ ...options, stateFile: 'manager-tunnel-config.json', targetUrl: () => `http://127.0.0.1:${consolePort}` });

  await forSillyTavern.start('quick');
  consolePort = 7999;
  await forConsole.start('quick');
  assert.deepEqual(started.map((args) => args.at(-1)), ['http://127.0.0.1:8001', 'http://127.0.0.1:7999']);

  // Two files, so turning one off does not turn the other off on the next start.
  const stored = (await readdir(paths.state)).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(stored, ['manager-tunnel-config.json', 'tunnel-config.json']);
  await forConsole.disable();
  assert.equal(JSON.parse(await readFile(join(paths.state, 'manager-tunnel-config.json'), 'utf8')).mode, 'off');
  assert.equal(JSON.parse(await readFile(join(paths.state, 'tunnel-config.json'), 'utf8')).mode, 'quick');

  await forSillyTavern.close();
  await forConsole.close();
});

test('a network that blocks QUIC gets HTTP/2, once it has been noticed and ever after', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const invocations: string[][] = [];
  const lines: string[] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    invocations.push([...args]);
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const options = {
    paths,
    spawnImpl,
    env: { PATH: '' },
    reconnectDelaysMs: [5],
    fetchImpl: offline,
    logger: (line: Parameters<typeof lines.push>[0] | { message: string }) => {
      lines.push(typeof line === 'string' ? line : line.message);
    },
  };
  const tunnel = new TunnelManager(options as unknown as ConstructorParameters<typeof TunnelManager>[0]);

  // The first attempt is cloudflared's own choice, which is QUIC.
  await tunnel.start('quick');
  assert.equal(invocations.length, 1);
  assert.ok(!invocations[0]!.includes('--protocol'), 'the first attempt does not second-guess cloudflared');

  // cloudflared saying the edge is unreachable over QUIC is the fast half of
  // the answer: no waiting, straight to the transport that works.
  children[0]!.stderr.write('ERR failed to dial to edge with quic: timeout: no recent network activity\n');
  await waitFor(() => invocations.length === 2, 'a second attempt over HTTP/2');
  assert.deepEqual(invocations[1]!.slice(0, 6), ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4']);
  assert.ok(lines.some((line) => line.includes('HTTP/2')), 'and the log says why it changed');

  children[1]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the tunnel to come up over HTTP/2');
  // The switch is not a failure, so it must not have eaten the backoff that a
  // real disconnection later depends on.
  assert.ok(!lines.some((line) => line.includes('reconnecting in')));
  await tunnel.close();

  // What this machine's network does outlasts the process that learned it: a
  // manager started again here goes straight to HTTP/2 rather than spending
  // the wait a second time.
  const after = new TunnelManager(options as unknown as ConstructorParameters<typeof TunnelManager>[0]);
  await after.resume();
  await waitFor(() => invocations.length === 3, 'the resumed tunnel');
  assert.ok(invocations[2]!.includes('--protocol'), 'the remembered transport is used from the first attempt');
  await after.close();
});

test('a tunnel that says nothing at all is given up on too, and asked again over HTTP/2', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    invocations.push([...args]);
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  // A blocked UDP path produces no error to match on - the packets leave and
  // nothing comes back - so silence for long enough has to count as an answer.
  const tunnel = new TunnelManager({ paths, spawnImpl, env: { PATH: '' }, quicPatienceMs: 20, fetchImpl: offline, logger: () => undefined });

  await tunnel.start('quick');
  assert.ok(!invocations[0]!.includes('--protocol'));
  await waitFor(() => invocations.length === 2, 'the silent attempt to be given up on');
  assert.ok(invocations[1]!.includes('--protocol'));

  children[1]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the tunnel to come up over HTTP/2');
  // And a tunnel that is up is never taken down for being slow to start.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(invocations.length, 2);
  await tunnel.close();
});

test('a link that answers with error 1033 is a tunnel that never reached the edge', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const invocations: string[][] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    invocations.push([...args]);
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  // Cloudflare's own answer for a hostname with no tunnel behind it: HTTP 530,
  // and the page says which of the many 530s it is.
  const fetchImpl = (async (url: string | URL | Request) => {
    asked.push(String(url));
    return new Response('<html><body>Error 1033</body></html>', { status: 530 });
  }) as unknown as typeof globalThis.fetch;
  const options = {
    paths, spawnImpl, fetchImpl,
    env: { PATH: '' },
    reconnectDelaysMs: [5],
    edgeCheckDelayMs: 5,
    logger: (line: string | { message: string }) => { lines.push(typeof line === 'string' ? line : line.message); },
  };
  const tunnel = new TunnelManager(options as unknown as ConstructorParameters<typeof TunnelManager>[0]);

  await tunnel.start('quick');
  // cloudflared is satisfied: it printed an address and said nothing wrong.
  // Everything this manager could see says the tunnel is up.
  children[0]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the tunnel to report running');

  await waitFor(() => invocations.length === 2, 'the tunnel to be started again over HTTP/2');
  assert.deepEqual(invocations[1]!.slice(0, 6), ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4']);
  assert.ok(asked.every((url) => url === 'https://cedar-married-designer-ticket.trycloudflare.com'), 'only the announced address is asked about');
  assert.ok(lines.some((line) => line.includes('1033')), 'and the log says what the link answered');

  children[1]!.stdout.write('INF |  https://spectrum-volleyball-melissa-cottage.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().url === 'https://spectrum-volleyball-melissa-cottage.trycloudflare.com', 'the replacement address');
  // Already on HTTP/2, so a link that still answers 1033 has nowhere left to
  // go: it must not start the tunnel over and over.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(invocations.length, 2);
  await tunnel.close();

  // And what was learned outlives the process that learned it.
  assert.equal(JSON.parse(await readFile(join(paths.state, 'tunnel-config.json'), 'utf8')).transport, 'http2');
});

test('a link the manager itself cannot reach is not blamed on the transport', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    invocations.push([...args]);
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  // The manager may sit behind a proxy that will not reach trycloudflare.com
  // at all. That says nothing about whether the tunnel works for anybody else,
  // so it must not cost the reader a restart onto the slower transport.
  const tunnel = new TunnelManager({ paths, spawnImpl, fetchImpl: offline, env: { PATH: '' }, edgeCheckDelayMs: 5, edgeCheckAttempts: 3, logger: () => undefined });

  await tunnel.start('quick');
  children[0]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the tunnel to report running');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(invocations.length, 1, 'the tunnel is left alone');
  await tunnel.close();
});

test('a link that answers anything else is a working tunnel, whatever the status', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const children: FakeCloudflared[] = [];
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    invocations.push([...args]);
    const child = fakeCloudflared();
    children.push(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  // The gateway behind the tunnel refuses anyone without the PIN. A refusal
  // travelled down the tunnel to get here, which is the whole question.
  const fetchImpl = (async () => new Response('sign in', { status: 401 })) as unknown as typeof globalThis.fetch;
  const tunnel = new TunnelManager({ paths, spawnImpl, fetchImpl, env: { PATH: '' }, edgeCheckDelayMs: 5, edgeCheckAttempts: 3, logger: () => undefined });

  await tunnel.start('quick');
  children[0]!.stdout.write('INF |  https://cedar-married-designer-ticket.trycloudflare.com  |\n');
  await waitFor(() => tunnel.getState().status === 'running', 'the tunnel to report running');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(invocations.length, 1);
  await tunnel.close();
});

test('a network already known to need HTTP/2 is not measured again', async () => {
  const paths = await createPaths();
  await installFakeBinary(paths);
  const invocations: string[][] = [];
  const spawnImpl = ((_command: string, args: readonly string[]): ChildProcess => {
    invocations.push([...args]);
    return fakeCloudflared() as unknown as ChildProcess;
  }) as unknown as typeof spawnType;
  const tunnel = new TunnelManager({ paths, spawnImpl, env: { PATH: '', STM_TUNNEL_PROTOCOL: 'http2' }, logger: () => undefined });
  await tunnel.start('quick');
  assert.ok(invocations[0]!.includes('--protocol'));
  await tunnel.close();

  // And the other way: somebody who knows their network is fine can keep QUIC,
  // which is the faster transport when it is available.
  const quic = new TunnelManager({ paths, spawnImpl, env: { PATH: '', STM_TUNNEL_PROTOCOL: 'quic' }, logger: () => undefined });
  await quic.start('quick');
  assert.ok(!invocations[1]!.includes('--protocol'));
  await quic.close();
});
