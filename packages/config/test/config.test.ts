import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Installation, Profile } from '../../contracts/src/index.js';
import { ConfigError, ConfigStore } from '../src/index.js';

async function fixture(): Promise<{ store: ConfigStore; profile: Profile; installation: Installation; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-config-'));
  const runtimePath = join(root, 'runtime');
  const configPath = join(root, 'profile', 'config.yaml');
  await mkdir(runtimePath, { recursive: true });
  await mkdir(join(root, 'profile'), { recursive: true });
  await writeFile(configPath, '# keep this comment\nlisten: false\nport: 8000\nbasicAuthMode: false\nbasicAuthUser:\n  username: user\n  password: old-secret\nssl:\n  enabled: false\n', 'utf8');
  const now = new Date().toISOString();
  const installation: Installation = { id: 'install-1', selector: 'latest', resolvedRef: '1.18.0', channel: 'release', runtimePath, markerPath: join(runtimePath, '.stm-installation.json'), status: 'ready', progress: 100, step: 'ready', error: null, createdAt: now, updatedAt: now, activatedAt: now };
  const profile: Profile = { id: 'profile-1', name: 'Default', installationId: installation.id, runtimePath, configPath, dataPath: join(root, 'profile', 'data'), layout: 'data', active: true, createdAt: now, updatedAt: now, activatedAt: now };
  return { store: new ConfigStore({ logger: () => undefined }), profile, installation, configPath };
}

test('config document retains Basic Auth keys and masks a custom password', async () => {
  const { store, profile, installation } = await fixture();
  const document = await store.read(profile, installation);
  assert.equal(document.runtimeRef, '1.18.0');
  assert.equal(document.settings.listen, false);
  assert.equal(document.settings.enableUserAccounts, false);
  assert.match(document.rawYaml, /basicAuthMode: false/u);
  assert.match(document.rawYaml, /username: user/u);
  assert.match(document.rawYaml, /password: ['"]?\*{8}['"]?/u);
  assert.equal(document.rawYaml.includes('old-secret'), false);
});

test('settings update atomically without disturbing comments or unknown keys', async () => {
  const { store, profile, installation, configPath } = await fixture();
  const document = await store.update(profile, installation, { settings: { lazyLoadCharacters: true } });
  assert.equal(document.settings.lazyLoadCharacters, true);
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /# keep this comment/u);
  assert.match(raw, /lazyLoadCharacters: true/u);
  assert.match(raw, /username: user/u);
  assert.equal((parseYaml(raw) as { basicAuthUser: { password: string } }).basicAuthUser.password, 'old-secret');
  assert.equal(await readFile(`${configPath}.bak`, 'utf8').then((value) => value.includes('# keep this comment')), true);
});

test('saving masked raw YAML keeps the stored Basic Auth password', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\nbasicAuthMode: false\nbasicAuthUser:\n  username: admin\n  password: old-secret\n', 'utf8');
  const document = await store.read(profile, installation);
  assert.equal(document.rawYaml.includes('old-secret'), false);
  await store.update(profile, installation, { rawYaml: document.rawYaml });
  const raw = await readFile(configPath, 'utf8');
  assert.match(raw, /username: admin/u);
  assert.equal((parseYaml(raw) as { basicAuthUser: { password: string } }).basicAuthUser.password, 'old-secret');
  assert.equal(raw.includes('********'), false);
});

test('an edited YAML document cannot open SillyTavern to the network itself', async () => {
  // Everything reaches SillyTavern through the access gateway, which asks for
  // a password. A config that binds SillyTavern to every interface, or turns
  // on one of its own half-usable protections, would be a way around that.
  const { store, profile, installation, configPath } = await fixture();
  const document = await store.update(profile, installation, {
    rawYaml: 'listen: true\nport: 8000\nwhitelistMode: false\nbasicAuthMode: true\nenableUserAccounts: true\n',
  });
  assert.equal(document.settings.listen, false);
  assert.equal(document.settings.whitelistMode, true);
  assert.equal(document.settings.basicAuthMode, false);
  assert.equal(document.settings.enableUserAccounts, false);
  assert.equal(document.rawYaml, await readFile(configPath, 'utf8'));
});

test('a config written for a newer version is made startable for an older one', async () => {
  // SillyTavern before 1.12 exits with code 1 when listen is on and neither
  // whitelisting nor Basic Auth is, which is exactly what a config written for
  // an accounts-based version looks like. Switching down to it used to look
  // like the version being broken.
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: true\nport: 8000\nwhitelistMode: false\nenableUserAccounts: true\n', 'utf8');

  assert.equal(await store.applyManagedDefaults(profile, installation), true);
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.listen, false);
  assert.equal(raw.whitelistMode, true);
  assert.equal(raw.enableUserAccounts, false);
  // Already right, so a second start writes nothing at all.
  assert.equal(await store.applyManagedDefaults(profile, installation), false);
});

test('a runtime is not left opening its own browser window', async () => {
  const { store, profile, installation, configPath } = await fixture();
  await writeFile(configPath, 'listen: false\nport: 8000\nautorun: true\nbrowserLaunch:\n  enabled: true\n', 'utf8');
  assert.equal(await store.applyManagedDefaults(profile, installation), true);
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.autorun, false);
  assert.equal(raw.browserLaunch.enabled, false);
});

test('the settings the console offers land on the keys SillyTavern reads', async () => {
  const { store, profile, installation, configPath } = await fixture();

  // A config that mentions none of them reads back as SillyTavern's own
  // defaults, so nothing appears to have been turned off by being absent.
  const before = await store.read(profile, installation);
  assert.equal(before.settings.useDiskCache, true);
  assert.equal(before.settings.memoryCacheCapacity, '100mb');
  assert.equal(before.settings.chatBackupCount, 50);
  assert.equal(before.settings.lazyLoadCharacters, false);

  const saved = await store.update(profile, installation, {
    settings: { requestCompression: true, memoryCacheCapacity: '250mb', allowKeysExposure: true, chatBackupCount: 20 },
  });
  assert.equal(saved.settings.requestCompression, true);
  assert.equal(saved.settings.memoryCacheCapacity, '250mb');
  assert.equal(saved.settings.allowKeysExposure, true);
  assert.equal(saved.settings.chatBackupCount, 20);

  const raw = parseYaml(await readFile(configPath, 'utf8')) as {
    performance: { requestCompression: { enabled: boolean }; memoryCacheCapacity: string };
    allowKeysExposure: boolean;
    backups: { common: { numberOfBackups: number } };
  };
  assert.equal(raw.performance.requestCompression.enabled, true);
  assert.equal(raw.performance.memoryCacheCapacity, '250mb');
  assert.equal(raw.allowKeysExposure, true);
  assert.equal(raw.backups.common.numberOfBackups, 20);
});

test('a size or a count that SillyTavern could not read is refused', async () => {
  const { store, profile, installation, configPath } = await fixture();
  const original = await readFile(configPath, 'utf8');

  for (const settings of [{ memoryCacheCapacity: 'lots' }, { memoryCacheCapacity: '100 mb' }, { chatBackupCount: 0 }, { chatBackupCount: 5000 }, { chatBackupCount: 2.5 }]) {
    await assert.rejects(store.update(profile, installation, { settings }), (error: unknown) => error instanceof ConfigError && error.code === 'invalid_config');
  }
  // And a refusal leaves the file exactly as it was.
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('keys a version does not understand are not invented for it', async () => {
  const { store, profile, installation, configPath } = await fixture();
  // Already on the port the console hands out, so there is nothing to change.
  await writeFile(configPath, 'listen: false\nport: 8002\n', 'utf8');
  assert.equal(await store.applyManagedDefaults(profile, installation), false);
  await store.update(profile, installation, { settings: { lazyLoadCharacters: true } });
  const raw = parseYaml(await readFile(configPath, 'utf8'));
  assert.equal(raw.enableUserAccounts, undefined);
  assert.equal(raw.basicAuthMode, undefined);
  assert.equal(raw.whitelistMode, undefined, 'an absent key already holds its default');
});

test('the managed port cannot be moved out from under the manager', async () => {
  const { store, profile, installation } = await fixture();
  // The console hands the port out, having checked it against its own and the
  // gateway's, so an edited document is put back rather than refused.
  const saved = await store.update(profile, installation, { rawYaml: 'listen: false\nport: 9000\n' });
  assert.equal(saved.settings.port, 8002);
});

test('the port the console was given is the one written, even into a file that never mentioned it', async () => {
  const { configPath, profile, installation } = await fixture();
  let port = 8123;
  const store = new ConfigStore({ managedPort: () => port, logger: () => undefined });
  await store.update(profile, installation, { settings: { lazyLoadCharacters: true } });
  assert.equal(parseYaml(await readFile(configPath, 'utf8')).port, 8123);

  // And it follows the console when the console moves it again.
  port = 8200;
  assert.equal(await store.applyManagedDefaults(profile, installation), true, 'the file still says the old port, so it is rewritten');
  assert.equal(parseYaml(await readFile(configPath, 'utf8')).port, 8200);
  assert.equal(await store.applyManagedDefaults(profile, installation), false, 'and once it agrees, nothing is written');
});
