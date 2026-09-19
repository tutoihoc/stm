import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { getPlatformPaths } from '../../platform/src/index.js';
import { RuntimeError, RuntimeManager, extractZipSafely, gitFetchAttempts } from '../src/index.js';
import { logLineText } from '../../contracts/src/index.js';

const exec = promisify(execFile);

function zip(entries: Array<{ name: string; body: string }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = Buffer.from(entry.body, 'utf8');
    const compressed = deflateRawSync(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(0, 14); header.writeUInt32LE(0, 18); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(compressed.length, 22); header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    // Correct the CRC and sizes after writing fixed-width fields.
    header.writeUInt32LE(crc32(body), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(body.length, 22);
    local.push(header, name, compressed);

    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(crc32(body), 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(body.length, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + compressed.length;
  }
  const localBuffer = Buffer.concat(local); const centralBuffer = Buffer.concat(central); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(localBuffer.length, 16);
  return Buffer.concat([localBuffer, centralBuffer, end]);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) { crc ^= byte; for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}

async function freePort(): Promise<number> {
  const server = createNetServer();
  return new Promise<number>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate a test port')); return; }
      server.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

test('version discovery keeps latest, release, staging, and tags', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtime = new RuntimeManager({ paths, fetch: async () => new Response(JSON.stringify([{ tag_name: '1.2.3', name: 'v1.2.3', published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false }] ), { status: 200 }) });
  const versions = await runtime.listVersions();
  assert.deepEqual(versions.slice(0, 3).map((item) => item.selector), ['latest', 'release', 'staging']);
  assert.equal(versions[0]?.label, 'v1.2.3 (latest)');
  assert.equal(versions[3]?.selector, '1.2.3');
});

test('a first installation can be stopped, and takes back everything it wrote', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-stop-'));
  const repository = join(root, 'source');
  await exec('git', ['init', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'stm@test.local']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'STM Test']);
  await writeFile(join(repository, 'package.json'), '{"name":"sillytavern","scripts":{"start":"node server.js"}}', 'utf8');
  await writeFile(join(repository, 'server.js'), 'module.exports = "one";\n', 'utf8');
  await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'one']); await exec('git', ['-C', repository, 'tag', '1.0.0']);
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: join(root, 'manager') } });

  // Stopped while npm is the thing taking the minutes, which is where a first
  // install spends nearly all of its time and where somebody who started it by
  // mistake will reach for the button.
  const stopping = new AbortController();
  let reachedDependencies = false;
  const runtime = new RuntimeManager({
    paths,
    useGit: true,
    repositoryUrl: repository,
    healthCheck: async () => undefined,
    installDependencies: async (runtimePath, _onLine, signal) => {
      reachedDependencies = true;
      // Half a node_modules, of the kind a killed npm leaves behind.
      await mkdir(join(runtimePath, 'node_modules', 'half-written'), { recursive: true });
      stopping.abort();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
      if (signal?.aborted) throw new RuntimeError('install_canceled', 'The installation was stopped');
    },
  });

  const queued = runtime.queueInstall('1.0.0', undefined, undefined, stopping.signal);
  const stopped = await queued.promise;
  assert.equal(reachedDependencies, true);
  assert.equal(stopped.errorCode, 'install_canceled');
  // Not reported as a failure: nothing went wrong, somebody changed their mind.
  assert.equal(stopped.error, null);

  // Nothing of it is left: no checkout, no dependencies, no record standing in
  // the list, and nothing named as the installation to run.
  await assert.rejects(() => stat(join(paths.profiles, 'runtime')));
  assert.deepEqual(await runtime.listInstallations(), []);
  assert.equal(await runtime.getActiveInstallation(), null);

  // And the machine is in a state a second attempt can use.
  const installed = await runtime.install('1.0.0');
  assert.equal(installed.status, 'ready');
});

test('safe extraction strips GitHub root and rejects zip slip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-extract-'));
  const archive = join(root, 'source.zip');
  await writeFile(archive, zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"SillyTavern"}' }, { name: 'SillyTavern-abc/配置/角色.txt', body: 'xin chào' }]));
  const destination = join(root, 'out');
  await extractZipSafely(archive, destination);
  assert.equal(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')).name, 'SillyTavern');
  assert.equal(await readFile(join(destination, '配置', '角色.txt'), 'utf8'), 'xin chào');
  await writeFile(archive, zip([{ name: '../escape.txt', body: 'blocked' }]));
  await assert.rejects(() => extractZipSafely(archive, destination), (error: unknown) => error instanceof RuntimeError && error.code === 'unsafe_archive');
});

test('successful installation writes marker only after dependency install and activates it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-success-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]);
  let dependencyInstallCalled = false;
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => { dependencyInstallCalled = true; },
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'ready');
  assert.equal(dependencyInstallCalled, true);
  assert.equal((await stat(installation.markerPath)).isFile(), true);
  assert.equal((await runtime.getActiveInstallation())?.id, installation.id);
});

test('failed npm install never leaves an installation marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"SillyTavern","scripts":{"start":"node server.js"}}' }]);
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => { throw new RuntimeError('npm_failed', 'dependency install failed'); },
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'failed');
  await assert.rejects(() => stat(installation.markerPath));
  // The panel says this one in the reader's language, so the code has to
  // survive from the refusal to the record. A failure without one - a line npm
  // printed on its way out - is shown as npm wrote it.
  assert.equal(installation.errorCode, 'npm_failed');
  assert.equal(installation.error, 'dependency install failed');
});

test('a failure that is not the manager refusing carries no code to translate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-plain-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"SillyTavern","scripts":{"start":"node server.js"}}' }]);
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => { throw new Error('npm ERR! code ELIFECYCLE'); },
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'failed');
  assert.equal(installation.errorCode, undefined);
  assert.equal(installation.error, 'npm ERR! code ELIFECYCLE');
});

test('health check prepares a data root for older SillyTavern runtimes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-health-check-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const port = await freePort();
  const archive = zip([
    { name: 'SillyTavern-legacy/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' },
    {
      name: 'SillyTavern-legacy/server.js',
      body: [
        "const http = require('node:http');",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const args = process.argv;",
        "const dataRoot = args[args.indexOf('--dataRoot') + 1];",
        "const port = Number(args[args.indexOf('--port') + 1]);",
        "fs.writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), 'test-secret');",
        "http.createServer((_request, response) => response.end('ok')).listen(port, '127.0.0.1');",
      ].join('\n'),
    },
  ]);
  const runtime = new RuntimeManager({
    paths,
    healthCheckPort: port,
    healthCheckTimeoutMs: 5_000,
    installDependencies: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.13.2', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'ready');
  assert.equal((await stat(installation.markerPath)).isFile(), true);
  await assert.rejects(() => stat(join(installation.runtimePath, '.health-check-data')));
});

test('health check forwards startup diagnostics when a runtime exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-health-failure-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const port = await freePort();
  const archive = zip([
    { name: 'SillyTavern-legacy/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' },
    { name: 'SillyTavern-legacy/public/index.html', body: '<!doctype html>' },
    { name: 'SillyTavern-legacy/server.js', body: "console.error('legacy boot failed'); process.exit(1);" },
  ]);
  const lines: string[] = [];
  const runtime = new RuntimeManager({
    paths,
    healthCheckPort: port,
    healthCheckTimeoutMs: 5_000,
    installDependencies: async () => undefined,
    logger: (line) => lines.push(logLineText(line)),
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.13.2', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'failed');
  assert.match(installation.error ?? '', /legacy boot failed/u);
  assert.ok(lines.some((line) => line.includes('legacy boot failed')));
});

test('only one installation job runs at a time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-install-busy-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  let release: (() => void) | undefined;
  const runtime = new RuntimeManager({ paths, healthCheck: async () => undefined, installDependencies: async () => new Promise<void>((resolvePromise) => { release = resolvePromise; }), fetch: async (input) => input.toString().includes('/releases') ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }])) : new Response(new Uint8Array(zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]))) });
  const first = runtime.queueInstall('latest');
  assert.throws(() => runtime.queueInstall('staging'), (error: unknown) => error instanceof RuntimeError && error.code === 'installation_busy');
  while (!release) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  release?.();
  await first.promise;
});

test('shared Git checkout switches refs without creating one runtime per version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-git-'));
  const repository = join(root, 'source');
  await exec('git', ['init', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'stm@test.local']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'STM Test']);
  await writeFile(join(repository, 'package.json'), '{"name":"sillytavern","scripts":{"start":"node server.js"}}', 'utf8');
  await writeFile(join(repository, 'server.js'), 'module.exports = "one";\n', 'utf8');
  await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'one']); await exec('git', ['-C', repository, 'tag', '1.0.0']);
  await writeFile(join(repository, 'server.js'), 'module.exports = "two";\n', 'utf8');
  await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'two']); await exec('git', ['-C', repository, 'tag', '2.0.0']);
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: join(root, 'manager') } });
  const runtime = new RuntimeManager({ paths, useGit: true, repositoryUrl: repository, installDependencies: async () => undefined, healthCheck: async () => undefined });
  const first = await runtime.install('1.0.0');
  const second = await runtime.install('2.0.0');
  const third = await runtime.install('1.0.0');
  assert.equal(first.runtimePath, second.runtimePath);
  assert.equal(second.runtimePath, third.runtimePath);
  assert.equal((await readFile(join(third.runtimePath, 'server.js'), 'utf8')).replaceAll('\r\n', '\n'), 'module.exports = "one";\n');
  assert.equal((await runtime.listInstallations()).filter((item) => item.status === 'ready').length, 3);
});

test('a version change falls back to a complete pack when a fetch keeps failing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-refetch-'));
  const repository = join(root, 'source');
  await exec('git', ['init', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'stm@test.local']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'STM Test']);
  await writeFile(join(repository, 'server.js'), 'module.exports = "one";\n', 'utf8');
  await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'one']); await exec('git', ['-C', repository, 'tag', '1.0.0']);
  await writeFile(join(repository, 'server.js'), 'module.exports = "two";\n', 'utf8');
  await exec('git', ['-C', repository, 'add', '.']); await exec('git', ['-C', repository, 'commit', '-m', 'two']); await exec('git', ['-C', repository, 'tag', '2.0.0']);
  const work = join(root, 'work');
  await exec('git', ['init', work]);
  await exec('git', ['-C', work, 'remote', 'add', 'origin', repository]);
  const first = gitFetchAttempts(work, 'tags', '1.0.0', 'refs/stm/tags/1.0.0');
  assert.equal(first.length, 3);
  assert.equal(first[0]?.note, null);
  assert.deepEqual(first[0]?.args, first[1]?.args);
  await exec('git', [...(first[0]?.args ?? [])]);
  // The checkout now holds objects, so a plain fetch of another version asks
  // for a thin pack - the shape a Studio volume cannot reread. The last attempt
  // asks for the whole pack instead, and that is the one that has to work.
  const change = gitFetchAttempts(work, 'tags', '2.0.0', 'refs/stm/tags/2.0.0');
  const last = change.at(-1);
  assert.ok(last);
  assert.ok(last.args.includes('--refetch'));
  assert.ok(last.note);
  await exec('git', [...last.args]);
  const revision = await exec('git', ['-C', work, 'rev-parse', '--verify', 'refs/stm/tags/2.0.0^{commit}']);
  assert.match(revision.stdout.trim(), /^[0-9a-f]{40,64}$/u);
});

test('migrates an older per-installation runtime onto the shared checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-runtime-migrate-'));
  const repository = join(root, 'source');
  await exec('git', ['init', repository]);
  await exec('git', ['-C', repository, 'config', 'user.email', 'stm@test.local']);
  await exec('git', ['-C', repository, 'config', 'user.name', 'STM Test']);
  await writeFile(join(repository, 'package.json'), '{"name":"sillytavern","scripts":{"start":"node server.js"}}', 'utf8');
  await writeFile(join(repository, 'server.js'), 'module.exports = "shared";\n', 'utf8');
  await exec('git', ['-C', repository, 'add', '.']);
  await exec('git', ['-C', repository, 'commit', '-m', 'shared']);
  await exec('git', ['-C', repository, 'tag', '1.0.0']);
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: join(root, 'manager') } });
  const legacy = new RuntimeManager({
    paths,
    useGit: false,
    fetch: async () => new Response(new Uint8Array(zip([
      { name: 'SillyTavern-old/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' },
      { name: 'SillyTavern-old/server.js', body: 'module.exports = "legacy";\n' },
    ]))),
    installDependencies: async () => undefined,
    healthCheck: async () => undefined,
  });
  const oldInstallation = await legacy.install('1.0.0');
  assert.match(oldInstallation.runtimePath, /profiles[\\/]\S+[\\/]runtime/u);
  const shared = new RuntimeManager({ paths, useGit: true, repositoryUrl: repository, installDependencies: async () => undefined, healthCheck: async () => undefined });
  const migrated = await shared.migrateLegacyInstallation(oldInstallation);
  assert.equal(migrated.runtimePath, join(paths.profiles, 'runtime'));
  assert.equal((await readFile(join(migrated.runtimePath, 'server.js'), 'utf8')).replaceAll('\r\n', '\n'), 'module.exports = "shared";\n');
  assert.equal((await shared.getActiveInstallation())?.runtimePath, migrated.runtimePath);
});

test('removing SillyTavern deletes the program and leaves the profile data alone', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'stm-uninstall-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]);
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => undefined,
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const installation = await runtime.install('latest');
  assert.equal(installation.status, 'ready');

  // A profile keeps its characters and chats beside the runtime, not inside
  // it. This is the whole promise of the uninstall button, so it is what the
  // test checks.
  const profileData = join(paths.profiles, 'profile-1', 'data');
  await mkdir(profileData, { recursive: true });
  await writeFile(join(profileData, 'chat.jsonl'), 'a chat nobody asked to delete\n', 'utf8');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });

  await runtime.removeInstallations();

  assert.equal(await stat(installation.runtimePath).then(() => false, () => true), true, 'the runtime is gone');
  assert.deepEqual(await runtime.listInstallations(), [], 'no installation records are left');
  assert.equal(await runtime.getActiveInstallation(), null, 'nothing is active any more');
  assert.equal(await readFile(join(profileData, 'chat.jsonl'), 'utf8'), 'a chat nobody asked to delete\n');
});

test('SillyTavern cannot be removed out from under an install that is running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-uninstall-busy-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]);
  let release = () => undefined as void;
  const held = new Promise<void>((resolve) => { release = () => resolve(); });
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => { await held; },
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const queued = runtime.queueInstall('latest');
  await assert.rejects(() => runtime.removeInstallations(), (error: unknown) => error instanceof RuntimeError && error.code === 'installation_busy');
  release();
  await queued.promise;
});

test('work run before the download can say what it is doing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-before-install-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const archive = zip([{ name: 'SillyTavern-abc/package.json', body: '{"name":"sillytavern","scripts":{"start":"node server.js"}}' }]);
  const runtime = new RuntimeManager({
    paths,
    installDependencies: async () => undefined,
    healthCheck: async () => undefined,
    fetch: async (input) => input.toString().includes('/releases')
      ? new Response(JSON.stringify([{ tag_name: '1.0.0', draft: false, prerelease: false }]), { status: 200 })
      : new Response(new Uint8Array(archive), { status: 200, headers: { 'content-type': 'application/zip' } }),
  });
  const steps: string[] = [];
  let ran = false;
  const queued = runtime.queueInstall(
    'latest',
    (progress) => { steps.push(`${progress.progress}:${progress.step.code}`); },
    async (report) => { ran = true; await report(4, { code: 'install.safetyCopy', message: 'Copying your data before switching version' }); },
  );
  // The id is handed back before any of that work starts, which is what lets
  // the request answer straight away and the panel start polling.
  assert.match(queued.id, /^[0-9a-f-]{36}$/u);
  await queued.promise;
  assert.equal(ran, true);
  assert.ok(steps.includes('4:install.safetyCopy'), `expected the reported step, saw ${steps.join(', ')}`);
});
