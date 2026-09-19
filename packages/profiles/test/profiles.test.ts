import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import { ProfileStore, ProfileError } from '../src/index.js';

test('creates a data profile without moving runtime data and persists active selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-data-'));
  const runtimePath = join(root, 'runtime');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Main', installationId: 'install-1', runtimePath }, true);
  assert.equal(profile.layout, 'data');
  assert.equal(profile.active, true);
  assert.equal(await stat(profile.dataPath).then((details) => details.isDirectory()), true);
  const reloaded = new ProfileStore({ paths });
  assert.equal((await reloaded.getActive())?.id, profile.id);
  const persisted = JSON.parse(await readFile(join(paths.state, 'profiles.json'), 'utf8')) as { profiles: Array<{ dataPath: string }> };
  assert.equal(persisted.profiles[0]?.dataPath, profile.dataPath);
});

test('copies legacy public layout into the canonical data profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-public-'));
  const runtimePath = join(root, 'runtime');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  await mkdir(runtimePath, { recursive: true });
  // An old SillyTavern: the pages and the reader's data in one directory.
  await mkdir(join(runtimePath, 'public', 'chats'), { recursive: true });
  await writeFile(join(runtimePath, 'public', 'settings.json'), '{}', 'utf8');
  await writeFile(join(runtimePath, 'public', 'index.html'), '<!doctype html>', 'utf8');
  await writeFile(join(runtimePath, 'public', 'chats', 'chat.json'), '{}', 'utf8');
  const profile = await store.ensureDefault({ installationId: 'install-1', runtimePath });
  assert.equal(profile.layout, 'data');
  assert.equal(profile.legacyLayout, 'public');
  assert.equal(profile.dataPath.endsWith(join('data')), true);
  assert.equal(await readFile(join(profile.dataPath, 'default-user', 'chats', 'chat.json'), 'utf8'), '{}');
  assert.equal(await readFile(join(runtimePath, 'public', 'chats', 'chat.json'), 'utf8'), '{}');
});

test('a modern public/ is the program, not a profile, and is left where it is', async () => {
  /*
   * Every SillyTavern has a `public/`. Only the old ones keep data in it.
   *
   * Taking its existence as the signal meant a first install copied the web
   * root - index.html, the scripts, the fonts - into a brand new profile: tens
   * of megabytes of the program filed as the reader's data, uploaded to their
   * bucket as their data, and a profile that looked used before it had been.
   * That last part is what stopped a machine set up from nothing having its
   * recovery point put back: it is only ever put into a profile with nothing
   * in it, and this one was full of SillyTavern.
   */
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-modern-'));
  const runtimePath = join(root, 'runtime');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  await mkdir(join(runtimePath, 'public', 'scripts'), { recursive: true });
  await writeFile(join(runtimePath, 'public', 'index.html'), '<!doctype html>', 'utf8');
  await writeFile(join(runtimePath, 'public', 'script.js'), 'export {};', 'utf8');
  await writeFile(join(runtimePath, 'public', 'scripts', 'power-user.js'), 'export {};', 'utf8');

  const profile = await store.ensureDefault({ installationId: 'install-1', runtimePath });
  assert.equal(profile.layout, 'data');
  assert.equal(profile.legacyLayout, null);
  assert.deepEqual(await readdir(profile.dataPath), [], 'a new profile starts with nothing in it');
});

test('activation switches the active profile and leaves each profile’s data alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-snapshot-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const first = await store.create({ name: 'First', installationId: 'install-1', runtimePath: join(root, 'runtime') }, true);
  await writeFile(join(first.dataPath, 'chat.json'), '{"hello":"world"}', 'utf8');
  const second = await store.create({ name: 'Second', installationId: 'install-1', runtimePath: join(root, 'runtime') });
  await store.activate(second.id);
  assert.equal((await store.getActive())?.id, second.id);
  assert.equal(await readFile(join(first.dataPath, 'chat.json'), 'utf8'), '{"hello":"world"}');
});

test('duplicate profile names are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-name-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  await store.create({ name: 'Main', installationId: 'install-1', runtimePath: join(root, 'runtime') });
  await assert.rejects(() => store.create({ name: ' main ', installationId: 'install-1', runtimePath: join(root, 'runtime') }), (error: unknown) => error instanceof ProfileError && error.code === 'profile_name_taken');
});

test('rebinding a data profile to a new installation preserves its data root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-rebind-data-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Main', installationId: 'install-old', runtimePath: join(root, 'old-runtime') }, true);
  await writeFile(join(profile.dataPath, 'chat.json'), '{"version":1}', 'utf8');
  const rebound = await store.rebind(profile.id, 'install-new', join(root, 'new-runtime'));
  assert.equal(rebound.installationId, 'install-new');
  assert.equal(rebound.dataPath, profile.dataPath);
  assert.equal(await readFile(join(rebound.dataPath, 'chat.json'), 'utf8'), '{"version":1}');
});

test('rebinding a legacy public profile migrates data and config to the canonical root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-rebind-public-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const oldRuntime = join(root, 'old-runtime');
  const newRuntime = join(root, 'new-runtime');
  const store = new ProfileStore({ paths });
  await mkdir(join(oldRuntime, 'public'), { recursive: true });
  await writeFile(join(oldRuntime, 'public', 'chat.json'), '{"version":1}', 'utf8');
  await writeFile(join(oldRuntime, 'config.yaml'), 'listen: false\n', 'utf8');
  const profile = await store.create({ name: 'Legacy', installationId: 'install-old', runtimePath: oldRuntime, layout: 'public' }, true);
  const rebound = await store.rebind(profile.id, 'install-new', newRuntime);
  assert.equal(rebound.layout, 'data');
  assert.equal(rebound.legacyLayout, 'public');
  assert.equal(await readFile(join(rebound.dataPath, 'default-user', 'chat.json'), 'utf8'), '{"version":1}');
  assert.equal(await readFile(rebound.configPath, 'utf8'), 'listen: false\n');
});

test('bridges canonical data to an older runtime that only uses public/', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-legacy-bridge-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const runtimePath = join(root, 'runtime');
  await mkdir(runtimePath, { recursive: true });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Default', installationId: 'install-1', runtimePath }, true);
  await mkdir(join(profile.dataPath, 'default-user'), { recursive: true });
  await writeFile(join(profile.dataPath, 'default-user', 'chat.json'), '{"version":2}', 'utf8');
  await writeFile(join(runtimePath, 'server.js'), "console.log('legacy');", 'utf8');
  await mkdir(join(runtimePath, 'public'), { recursive: true });
  await writeFile(join(runtimePath, 'public', 'index.html'), '<!doctype html>', 'utf8');
  await writeFile(join(profile.dataPath, 'default-user', 'secrets.json'), '{"api_key":"keep"}', 'utf8');
  assert.equal(await store.prepareForRuntime(profile, runtimePath), 'public');
  assert.equal(await readFile(join(runtimePath, 'public', 'index.html'), 'utf8'), '<!doctype html>');
  assert.equal(await readFile(join(runtimePath, 'secrets.json'), 'utf8'), '{"api_key":"keep"}');
  assert.equal(await readFile(join(runtimePath, 'public', 'chat.json'), 'utf8'), '{"version":2}');
  await writeFile(join(runtimePath, 'public', 'chat.json'), '{"version":3}', 'utf8');
  await store.persistFromRuntime(profile, runtimePath, 'public');
  assert.equal(await readFile(join(profile.dataPath, 'default-user', 'chat.json'), 'utf8'), '{"version":3}');
});

test('the profile snapshot copies an older version wrote are reclaimed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-snapshot-retention-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const snapshots = join(paths.profiles, '.snapshots');
  // A complete copy, the legacy one no prune ever looked at, and the partial
  // one an interrupted run left behind and kept indefinitely.
  for (const name of ['profile-abc-2026-09-13T03-40-08-227Z', 'legacy-abc-2026-09-13T03-12-28-067Z', 'profile-abc-2026-09-13T04-29-45-615Z']) {
    await mkdir(join(snapshots, name, 'data'), { recursive: true });
    await writeFile(join(snapshots, name, 'data', 'chat.json'), '{"version":0}', 'utf8');
  }

  assert.equal(await store.removeLegacySnapshots(), true);
  await store.settle();
  await assert.rejects(() => readdir(snapshots));
  // Nothing is left to reclaim on the next start.
  assert.equal(await store.removeLegacySnapshots(), false);
});

test('a legacy runtime leaves no second copy of the data behind it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-legacy-copies-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Default', installationId: 'install-1', runtimePath: join(root, 'runtime') }, true);
  const runtimePath = join(root, 'legacy-runtime');
  const publicRoot = join(runtimePath, 'public');
  await mkdir(join(publicRoot, 'characters'), { recursive: true });
  await mkdir(join(runtimePath, 'backups', '_migration', '2026-09-13', 'chats'), { recursive: true });
  await writeFile(join(publicRoot, 'characters', 'card.png'), 'card', 'utf8');
  await writeFile(join(runtimePath, 'backups', 'chat-backup.jsonl'), '{"line":1}', 'utf8');
  // SillyTavern's own copy of the tree it migrated, which must not be carried in.
  await writeFile(join(runtimePath, 'backups', '_migration', '2026-09-13', 'chats', 'copy.jsonl'), '{"line":1}', 'utf8');
  // A static file of the runtime's own, which is not the operator's data.
  await mkdir(join(publicRoot, 'scripts'), { recursive: true });
  await writeFile(join(publicRoot, 'scripts', 'script.js'), 'run();', 'utf8');

  await store.persistFromRuntime(profile, runtimePath, 'public');
  const userData = join(profile.dataPath, 'default-user');
  assert.equal(await readFile(join(userData, 'characters', 'card.png'), 'utf8'), 'card');
  assert.equal(await readFile(join(userData, 'backups', 'chat-backup.jsonl'), 'utf8'), '{"line":1}');
  await assert.rejects(() => readdir(join(userData, 'backups', '_migration')));

  // The runtime keeps its own files and nothing of the operator's, so a modern
  // release starting here has no legacy tree to migrate and copy again.
  await store.settle();
  assert.deepEqual((await readdir(publicRoot)).sort(), ['scripts']);
  await assert.rejects(() => readdir(join(runtimePath, 'backups')));
});

test('a migration copy is reclaimed once the migration it protected has finished', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-profile-migration-copy-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new ProfileStore({ paths });
  const profile = await store.create({ name: 'Default', installationId: 'install-1', runtimePath: join(root, 'runtime') }, true);
  const runtimePath = join(root, 'modern-runtime');
  const migration = join(runtimePath, 'backups', '_migration', '2026-09-13');
  await mkdir(migration, { recursive: true });
  await writeFile(join(migration, 'copy.jsonl'), '{"line":1}', 'utf8');
  // A data-root runtime, which is what makes the copy reclaimable at all.
  await mkdir(join(runtimePath, 'public', 'scripts'), { recursive: true });
  await writeFile(join(runtimePath, 'server.js'), 'const dataRoot = true;', 'utf8');
  await writeFile(join(runtimePath, 'package.json'), JSON.stringify({ version: '1.16.0' }), 'utf8');

  // A tree still waiting to be migrated keeps its safety net.
  await mkdir(join(runtimePath, 'public', 'characters'), { recursive: true });
  await store.prepareForRuntime(profile, runtimePath);
  await store.settle();
  assert.ok(await readdir(migration));

  await rm(join(runtimePath, 'public', 'characters'), { recursive: true, force: true });
  await store.prepareForRuntime(profile, runtimePath);
  await store.settle();
  await assert.rejects(() => readdir(migration));
});
