import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseDocument, type Document, type YAMLMap } from 'yaml';
import { logEvent, logLineText, type ConfigDocument, type ConfigSettings, type ConfigSettingsInput, type ConfigUpdateInput, type Installation, type LogSink, type Profile } from '../../contracts/src/index.js';

const CONFIG_SCHEMA_VERSION = 1 as const;
/** SillyTavern's own default, and what the console uses until it is told otherwise. */
/** The port this console runs SillyTavern on; see SILLYTAVERN_PORT in the server. */
const DEFAULT_SILLYTAVERN_PORT = 8002;
/** What SillyTavern falls back on when its config names no port. */
const SILLYTAVERN_OWN_PORT = 8000;
const REDACTED_PASSWORD = '********';
const DEFAULT_BASIC_AUTH_USER = { username: 'user', password: 'password' } as const;
/**
 * The settings the manager owns, and the value each one has to hold.
 *
 * Every one of them is SillyTavern's own default, so this is not a policy the
 * manager invents - it is the manager refusing to move them. `listen` is the
 * important one: SillyTavern stays on the loopback address on every version,
 * and the only way in from anywhere else is the access gateway, which asks for
 * a password first. The two protections SillyTavern ships are left switched
 * off, because neither of them works on every version the manager installs.
 *
 * A key that is simply absent is already at its default, so nothing is written
 * for it. Only a key that is set to something else gets moved back.
 *
 * `port` is managed too, but it is not in this list because its value is not a
 * constant: it is whichever port the console was told to run SillyTavern on.
 */
const MANAGED_DEFAULTS: ReadonlyArray<{ readonly path: readonly string[]; readonly value: boolean }> = [
  { path: ['listen'], value: false },
  { path: ['whitelistMode'], value: true },
  { path: ['basicAuthMode'], value: false },
  { path: ['enableUserAccounts'], value: false },
  // The manager opens the console itself; these are what the older versions
  // read instead of --browserLaunchEnabled, which they ignore.
  { path: ['autorun'], value: false },
  { path: ['browserLaunch', 'enabled'], value: false },
];

export class ConfigError extends Error {
  public readonly code: 'config_missing' | 'invalid_yaml' | 'invalid_config' | 'invalid_security';

  public constructor(code: ConfigError['code'], message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

export interface ConfigStoreOptions {
  readonly logger?: LogSink;
  /**
   * Which port SillyTavern is to be started on, read at each write.
   *
   * The console owns this number, not the file: whoever edits the YAML is
   * editing the copy of it that the console will overwrite. A function rather
   * than a value because the console can move it between two writes.
   */
  readonly managedPort?: () => number;
}

/** Reads and updates the active SillyTavern YAML document without replacing unknown keys. */
export class ConfigStore {
  private readonly logger: LogSink;
  private readonly managedPort: () => number;

  public constructor(options: ConfigStoreOptions = {}) {
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.managedPort = options.managedPort ?? (() => DEFAULT_SILLYTAVERN_PORT);
  }

  public async read(profile: Profile, installation: Installation): Promise<ConfigDocument> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const raw = await readConfig(path);
    const document = parseYaml(raw);
    return toConfigDocument(document, raw, path, installation);
  }

  /**
   * Move the settings the manager owns back to their defaults, if they moved.
   *
   * Called before every start, because the runtime about to be started may be
   * a different version than the one this config was last written for, and
   * because a config restored from a backup carries whatever it was set to on
   * the machine it came from. Returns whether anything had to be written.
   */
  public async applyManagedDefaults(profile: Profile, installation: Installation): Promise<boolean> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const document = parseYaml(await readConfig(path));
    if (!applyManagedDefaults(document, this.managedPort())) return false;
    const nextRaw = String(document);
    await atomicWriteYaml(path, nextRaw);
    this.logger(logEvent('config.managedDefaults', `[config] returned the managed settings in ${path} to their defaults`, { path }));
    return true;
  }

  /**
   * Put the configuration back to the file this version ships with.
   *
   * The template is the runtime's own `default/config.yaml`, so "default"
   * means what this SillyTavern considers default rather than what the
   * manager remembers of some other version. The settings the manager owns go
   * back on top afterwards: the shipped file is written for somebody running
   * SillyTavern by hand, and opens a browser and reads `listen` accordingly.
   */
  public async restoreDefaults(profile: Profile, installation: Installation): Promise<ConfigDocument> {
    const document = parseYaml(await readTemplate(installation.runtimePath));
    applyManagedDefaults(document, this.managedPort());
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const nextRaw = String(document);
    await atomicWriteYaml(path, nextRaw);
    this.logger(logEvent('config.restoredDefaults', `[config] restored ${path} to the defaults shipped with ${installation.resolvedRef}`, { path, ref: installation.resolvedRef }));
    return toConfigDocument(parseYaml(nextRaw), nextRaw, path, installation);
  }

  public async validate(rawYaml: string): Promise<ConfigSettings> {
    const document = parseYaml(rawYaml);
    return extractSettings(document);
  }

  public async update(profile: Profile, installation: Installation, input: ConfigUpdateInput): Promise<ConfigDocument> {
    const path = await resolveConfigPath(profile, installation.runtimePath);
    const previousRaw = await readConfig(path);
    const previousDocument = parseYaml(previousRaw);
    const document = input.rawYaml === undefined ? previousDocument : parseYaml(input.rawYaml);
    if (getPath(document, ['basicAuthUser', 'password']) === REDACTED_PASSWORD) {
      setPath(document, ['basicAuthUser', 'password'], getPath(previousDocument, ['basicAuthUser', 'password']) ?? DEFAULT_BASIC_AUTH_USER.password);
    }
    applySettings(document, input.settings);
    // An edited YAML document can carry anything, including the settings that
    // decide who can reach SillyTavern. Those are not the editor's to move -
    // and neither is the port, which the console hands out so that it cannot
    // collide with the console's own or with the access gateway's.
    applyManagedDefaults(document, this.managedPort());
    const nextRaw = String(document);
    await atomicWriteYaml(path, nextRaw);
    this.logger(logEvent('config.updated', `[config] updated ${path}`, { path }));
    return toConfigDocument(parseYaml(nextRaw), nextRaw, path, installation);
  }
}

async function resolveConfigPath(profile: Profile, runtimePath: string): Promise<string> {
  if (profile.layout === 'data') {
    try { await stat(profile.configPath); return profile.configPath; } catch { /* initialize from the runtime template below */ }
    for (const candidate of [join(runtimePath, 'config.yaml'), join(runtimePath, 'config.yml')]) {
      try {
        await stat(candidate);
        await mkdir(dirname(profile.configPath), { recursive: true });
        await copyFile(candidate, profile.configPath);
        return profile.configPath;
      } catch { /* try the next layout */ }
    }
    return profile.configPath;
  }
  const candidates = [profile.configPath, join(runtimePath, 'config.yaml'), join(runtimePath, 'config.yml')];
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate; } catch { /* try the next layout */ }
  }
  return profile.configPath;
}

/** The untouched file SillyTavern ships, which is what restoring restores. */
async function readTemplate(runtimePath: string): Promise<string> {
  for (const candidate of [join(runtimePath, 'default', 'config.yaml'), join(runtimePath, 'default', 'config.yml')]) {
    try { return await readFile(candidate, 'utf8'); } catch { /* try the next name */ }
  }
  throw new ConfigError('config_missing', 'This SillyTavern does not ship a default configuration to restore');
}

async function readConfig(path: string): Promise<string> {
  try { return await readFile(path, 'utf8'); }
  catch (error: unknown) { throw new ConfigError('config_missing', `SillyTavern config was not found at ${path}`); }
}

function parseYaml(raw: string): Document.Parsed {
  try {
    const document = parseDocument(raw, { prettyErrors: false });
    if (document.errors.length > 0) throw document.errors[0];
    if (!document.contents || !Array.isArray((document.contents as YAMLMap).items)) throw new Error('root must be a mapping');
    return document;
  } catch (error: unknown) {
    throw new ConfigError('invalid_yaml', error instanceof Error ? `SillyTavern config YAML is invalid: ${error.message}` : 'SillyTavern config YAML is invalid');
  }
}

function toConfigDocument(document: Document.Parsed, raw: string, path: string, installation: Installation): ConfigDocument {
  const redacted = parseYaml(raw);
  const password = getPath(redacted, ['basicAuthUser', 'password']);
  if (typeof password === 'string' && password && password !== DEFAULT_BASIC_AUTH_USER.password) {
    setPath(redacted, ['basicAuthUser', 'password'], REDACTED_PASSWORD);
  }
  const settings = extractSettings(document);
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    installationId: installation.id,
    runtimeRef: installation.resolvedRef,
    ...(installation.revision ? { runtimeRevision: installation.revision } : {}),
    path,
    format: path.toLowerCase().endsWith('.yml') ? 'yml' : 'yaml',
    rawYaml: String(redacted),
    settings,
    restartRequired: true,
  };
}

function extractSettings(document: Document.Parsed): ConfigSettings {
  const getBoolean = (path: string[], fallback: boolean): boolean => {
    const value = getPath(document, path);
    return typeof value === 'boolean' ? value : fallback;
  };
  const getString = (path: string[], fallback: string): string => {
    const value = getPath(document, path);
    return typeof value === 'string' ? value : fallback;
  };
  const getNumber = (path: string[], fallback: number): number => {
    const value = getPath(document, path);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const portValue = getPath(document, ['port']);
  return {
    listen: getBoolean(['listen'], false),
    listenAddress: {
      ipv4: getString(['listenAddress', 'ipv4'], '0.0.0.0'),
      ipv6: getString(['listenAddress', 'ipv6'], '[::]'),
    },
    whitelistMode: getBoolean(['whitelistMode'], true),
    // A file that names no port is one SillyTavern would run on its own 8000.
    // That is a statement about the file, not about what this console asks for.
    port: typeof portValue === 'number' ? portValue : SILLYTAVERN_OWN_PORT,
    enableUserAccounts: getBoolean(['enableUserAccounts'], false),
    basicAuthMode: getBoolean(['basicAuthMode'], false),
    sslEnabled: getBoolean(['ssl', 'enabled'], false),
    enableCorsProxy: getBoolean(['enableCorsProxy'], false),
    disableCsrfProtection: getBoolean(['disableCsrfProtection'], false),
    // Every fallback here is SillyTavern's own shipped value, so a config
    // that never mentions a key reads back as what that key already does.
    lazyLoadCharacters: getBoolean(['performance', 'lazyLoadCharacters'], false),
    useDiskCache: getBoolean(['performance', 'useDiskCache'], true),
    memoryCacheCapacity: getString(['performance', 'memoryCacheCapacity'], '100mb'),
    requestCompression: getBoolean(['performance', 'requestCompression', 'enabled'], false),
    extensions: getBoolean(['extensions', 'enabled'], true),
    extensionAutoUpdate: getBoolean(['extensions', 'autoUpdate'], true),
    allowKeysExposure: getBoolean(['allowKeysExposure'], false),
    chatBackups: getBoolean(['backups', 'chat', 'enabled'], true),
    chatBackupCount: getNumber(['backups', 'common', 'numberOfBackups'], 50),
  };
}

/** `0`, or a whole number of kb/mb/gb, which is how SillyTavern writes sizes. */
const MEMORY_CACHE_PATTERN = /^(?:0|[1-9][0-9]{0,4}(?:kb|mb|gb))$/u;
const MAX_CHAT_BACKUPS = 500;

const SETTING_PATHS: { readonly [K in keyof Required<ConfigSettingsInput>]: readonly string[] } = {
  lazyLoadCharacters: ['performance', 'lazyLoadCharacters'],
  useDiskCache: ['performance', 'useDiskCache'],
  memoryCacheCapacity: ['performance', 'memoryCacheCapacity'],
  requestCompression: ['performance', 'requestCompression', 'enabled'],
  extensions: ['extensions', 'enabled'],
  extensionAutoUpdate: ['extensions', 'autoUpdate'],
  allowKeysExposure: ['allowKeysExposure'],
  chatBackups: ['backups', 'chat', 'enabled'],
  chatBackupCount: ['backups', 'common', 'numberOfBackups'],
};

function applySettings(document: Document.Parsed, settings: ConfigUpdateInput['settings']): void {
  if (!settings) return;
  if (settings.memoryCacheCapacity !== undefined && !MEMORY_CACHE_PATTERN.test(settings.memoryCacheCapacity)) {
    throw new ConfigError('invalid_config', 'The character cache size must be 0 or a size like 100mb');
  }
  if (settings.chatBackupCount !== undefined && (!Number.isInteger(settings.chatBackupCount) || settings.chatBackupCount < 1 || settings.chatBackupCount > MAX_CHAT_BACKUPS)) {
    throw new ConfigError('invalid_config', `The number of chat backups must be between 1 and ${MAX_CHAT_BACKUPS}`);
  }
  for (const [key, path] of Object.entries(SETTING_PATHS)) {
    const value = settings[key as keyof ConfigSettingsInput];
    if (value !== undefined) setPath(document, [...path], value);
  }
}

/** Returns whether any managed setting had to be moved back to its default. */
function applyManagedDefaults(document: Document.Parsed, port: number): boolean {
  let changed = false;
  for (const { path, value } of MANAGED_DEFAULTS) {
    const current = getPath(document, [...path]);
    if (current === undefined || current === value) continue;
    setPath(document, [...path], value);
    changed = true;
  }
  // Unlike the settings above, the port is written even when the file does not
  // mention it: an absent `port` is SillyTavern's 8000, which is only the right
  // answer while the console has not been asked for a different one.
  if (getPath(document, ['port']) !== port) {
    setPath(document, ['port'], port);
    changed = true;
  }
  return changed;
}

function getPath(document: Document.Parsed, path: string[]): unknown {
  return document.getIn(path);
}

function setPath(document: Document.Parsed, path: string[], value: unknown): void {
  document.setIn(path, value);
}

async function atomicWriteYaml(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try { await copyFile(path, `${path}.bak`); } catch { /* first write has no previous file */ }
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}
