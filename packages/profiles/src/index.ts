import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { logEvent, logLineText, type LogSink, type Profile, type ProfileLayout } from '../../contracts/src/index.js';
import { createIoLimiter, ioConcurrency, runPooled } from '../../platform/src/index.js';
import type { IoLimiter, PlatformPaths } from '../../platform/src/index.js';

const PROFILE_STATE_FILE = 'profiles.json';
const PROFILE_SCHEMA_VERSION = 1 as const;
const DEFAULT_USER_HANDLE = 'default-user';
const MIGRATION_COPY_NAMES = new Set(['_migration']);
const LEGACY_RUNTIME_STATIC_NAMES = new Set(['assets', 'css', 'favicon.ico', 'i18n.json', 'img', 'index.html', 'jsconfig.json', 'lib', 'robots.txt', 'script.js', 'scripts', 'sounds', 'st-launcher.ico', 'style.css', 'webfonts']);
/**
 * Names that only ever appear in somebody's data, never in a web root.
 *
 * Old SillyTavern releases kept the user's data inside `public/`, alongside the
 * pages and scripts the browser loads; current ones keep `public/` for the
 * pages alone and the data in `data/`. Both have a `public/`, so its existence
 * says nothing - what says it is whether there is anything of the reader's in
 * there. Chats, characters, worlds and `settings.json` are theirs; `index.html`
 * and `scripts/` are the program's.
 */
const LEGACY_DATA_NAMES = ['settings.json', 'chats', 'characters', 'groups', 'group chats', 'worlds', 'backgrounds', 'User Avatars'];

export interface ProfileStoreOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  readonly logger?: LogSink;
}

export interface ProfileCreateInput {
  readonly name: string;
  readonly installationId: string;
  readonly runtimePath: string;
  readonly layout?: ProfileLayout;
}

interface PersistedProfiles {
  readonly schemaVersion: 1;
  readonly profiles: Profile[];
}

/**
 * Owns profile metadata and profile data roots. Legacy public/ data is copied
 * into the canonical data/default-user/ root during profile initialization or
 * version switching; the original tree is left untouched.
 */
export class ProfileStore {
  readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private readonly logger: LogSink;
  private profiles: Profile[] | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private cleanupTail: Promise<void> = Promise.resolve();

  public constructor(options: ProfileStoreOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
  }

  public async list(): Promise<Profile[]> {
    return (await this.load()).map((profile) => ({ ...profile }));
  }

  public async get(id: string): Promise<Profile | null> {
    return (await this.load()).find((profile) => profile.id === id) ?? null;
  }

  public async getActive(): Promise<Profile | null> {
    return (await this.load()).find((profile) => profile.active) ?? null;
  }

  public async getActiveForInstallation(installationId: string): Promise<Profile | null> {
    return (await this.load()).find((profile) => profile.active && profile.installationId === installationId) ?? null;
  }

  /** Ensure a ready installation always has one usable profile. */
  public async ensureDefault(input: Omit<ProfileCreateInput, 'name' | 'layout'> & { readonly displayName?: string }): Promise<Profile> {
    const profiles = await this.load();
    const forInstallation = profiles.filter((profile) => profile.installationId === input.installationId);
    if (forInstallation.length > 0) {
      const active = forInstallation.find((profile) => profile.active);
      if (active) {
        if (resolve(active.runtimePath) !== resolve(input.runtimePath)) {
          const rebound = await this.rebind(active.id, input.installationId, input.runtimePath);
          return rebound.layout === 'public' ? this.migrateToData(rebound.id) : rebound;
        }
        return active.layout === 'public' ? this.migrateToData(active.id) : { ...active };
      }
      const first = forInstallation[0];
      if (!first) throw new Error('Profile state is empty');
      const activated = await this.activate(first.id);
      return activated.layout === 'public' ? this.migrateToData(activated.id) : activated;
    }
    const active = profiles.find((profile) => profile.active);
    if (active) return this.rebind(active.id, input.installationId, input.runtimePath);
    const created = await this.create({
      name: input.displayName?.trim() || 'Default',
      installationId: input.installationId,
      runtimePath: input.runtimePath,
      layout: 'data',
    }, true);
    // A `public/` with the reader's data in it is an old profile to be carried
    // over. A `public/` with only the program's own pages in it is this
    // version's web root, and copying that into a new profile filled it with
    // twenty-odd megabytes of SillyTavern's own scripts and fonts before
    // anybody had used it - which then went up to the bucket as their data, and
    // left the profile looking used, so a machine that should have had its
    // recovery point put back was told it already had something.
    if (await holdsUserData(join(input.runtimePath, 'public'))) return this.migrateRuntimePublic(created, input.runtimePath);
    return created;
  }

  public async create(input: ProfileCreateInput, activate = false): Promise<Profile> {
    const name = normalizeName(input.name);
    const profiles = await this.load();
    if (profiles.some((profile) => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new ProfileError('profile_name_taken', 'A profile with this name already exists');
    }
    const layout = input.layout ?? 'data';
    const id = randomUUID();
    const profileRoot = join(this.paths.profiles, '.profile-data', id);
    const dataPath = layout === 'data' ? join(profileRoot, 'data') : join(input.runtimePath, 'public');
    const configPath = layout === 'data' ? join(profileRoot, 'config.yaml') : join(input.runtimePath, 'config.yaml');
    if (layout === 'data') await mkdir(dataPath, { recursive: true });
    else await mkdir(dataPath, { recursive: true });
    const now = this.now().toISOString();
    const shouldActivate = activate || profiles.length === 0;
    const profile: Profile = {
      id,
      name,
      installationId: input.installationId,
      runtimePath: resolve(input.runtimePath),
      configPath: resolve(configPath),
      dataPath: resolve(dataPath),
      layout,
      legacyLayout: null,
      active: shouldActivate,
      createdAt: now,
      updatedAt: now,
      activatedAt: shouldActivate ? now : null,
    };
    const next = shouldActivate ? profiles.map((item) => ({ ...item, active: false })) : profiles;
    next.push(profile);
    await this.save(next);
    this.logger(logEvent('profiles.created', `[profiles] created ${profile.name} (${profile.layout})`, { name: profile.name, layout: profile.layout }));
    return { ...profile };
  }

  public async activate(id: string): Promise<Profile> {
    const profiles = await this.load();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProfileError('profile_not_found', 'Profile not found');
    const now = this.now().toISOString();
    const next = profiles.map((profile) => ({
      ...profile,
      active: profile.id === id,
      activatedAt: profile.id === id ? now : profile.activatedAt,
      updatedAt: profile.id === id ? now : profile.updatedAt,
    }));
    await this.save(next);
    this.logger(logEvent('profiles.activated', `[profiles] activated ${target.name}`, { name: target.name }));
    const activated = next.find((profile) => profile.id === id);
    if (!activated) throw new Error('Profile disappeared after activation');
    return { ...activated };
  }

  /** Keep profile data while pointing the profile at a newly installed runtime. */
  public async rebind(id: string, installationId: string, runtimePath: string): Promise<Profile> {
    const profiles = await this.load();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProfileError('profile_not_found', 'Profile not found');
    const resolvedRuntimePath = resolve(runtimePath);
    let dataPath = target.dataPath;
    let configPath = target.configPath;
    let layout = target.layout;
    let legacyLayout = target.legacyLayout ?? null;
    if (target.layout === 'public') {
      const migrated = await this.migrateTreeToData(target);
      dataPath = migrated.dataPath;
      configPath = migrated.configPath;
      layout = 'data';
      legacyLayout = 'public';
    }
    const now = this.now().toISOString();
    const next = profiles.map((profile) => profile.id === id ? {
      ...profile,
      installationId,
      runtimePath: resolvedRuntimePath,
      configPath: resolve(configPath),
      dataPath: resolve(dataPath),
      layout,
      legacyLayout,
      active: true,
      updatedAt: now,
      activatedAt: now,
    } : { ...profile, active: false });
    await this.save(next);
    const rebound = next.find((profile) => profile.id === id);
    if (!rebound) throw new Error('Profile disappeared after rebind');
    this.logger(logEvent('profiles.rebound', `[profiles] rebound ${rebound.name} to ${installationId} (${rebound.layout})`, { name: rebound.name, installation: installationId, layout: rebound.layout }));
    return { ...rebound };
  }

  /** Convert a legacy public/ profile into the canonical data/default-user root. */
  public async migrateToData(id: string): Promise<Profile> {
    const profiles = await this.load();
    const target = profiles.find((profile) => profile.id === id);
    if (!target) throw new ProfileError('profile_not_found', 'Profile not found');
    if (target.layout === 'data') return { ...target };
    const migrated = await this.migrateTreeToData(target);
    const now = this.now().toISOString();
    const next = profiles.map((profile) => profile.id === id ? {
      ...profile,
      layout: 'data' as const,
      dataPath: migrated.dataPath,
      configPath: migrated.configPath,
      legacyLayout: 'public' as const,
      updatedAt: now,
    } : profile);
    await this.save(next);
    const result = next.find((profile) => profile.id === id);
    if (!result) throw new Error('Profile disappeared after migration');
    this.logger(logEvent('profiles.migrated', `[profiles] migrated ${result.name} from public/ to data/${DEFAULT_USER_HANDLE}/`, { name: result.name, handle: DEFAULT_USER_HANDLE }));
    return { ...result };
  }

  /** Prepare canonical data for an older runtime that only understands public/. */
  public async prepareForRuntime(profile: Profile, runtimePath: string): Promise<ProfileLayout> {
    if (profile.layout === 'public') return 'public';
    if (await runtimeSupportsDataRoot(runtimePath)) {
      await this.reclaimMigrationCopy(runtimePath);
      return 'data';
    }
    const source = await resolveUserData(profile.dataPath);
    await syncCanonicalToLegacy(source, runtimePath);
    if (await exists(profile.configPath)) await copyPath(profile.configPath, join(runtimePath, 'config.yaml'));
    await writeLegacyRuntimeConfig(runtimePath);
    this.logger(logEvent('profiles.syncedToRuntime', `[profiles] synchronized ${profile.name} to legacy public/ runtime`, { name: profile.name }));
    return 'public';
  }

  /**
   * Reclaim the copy SillyTavern made before migrating a legacy tree.
   *
   * It is only removed once that migration has demonstrably finished - public/
   * holds nothing but the runtime's own static files again - so a migration that
   * was interrupted keeps the safety net it made for itself.
   */
  private async reclaimMigrationCopy(runtimePath: string): Promise<void> {
    const migration = join(runtimePath, 'backups', '_migration');
    if (!await exists(migration)) return;
    const publicRoot = join(runtimePath, 'public');
    const unmigrated = await exists(publicRoot)
      ? (await readdir(publicRoot)).filter((child) => !LEGACY_RUNTIME_STATIC_NAMES.has(child))
      : [];
    if (unmigrated.length > 0) return;
    this.logger(logEvent('profiles.reclaimingMigrationCopy', '[profiles] reclaiming the SillyTavern migration copy left in the runtime'));
    this.trackCleanup(migration);
  }

  /** Persist changes made by an older runtime back into canonical data/. */
  public async persistFromRuntime(profile: Profile, runtimePath: string, runtimeLayout: ProfileLayout): Promise<void> {
    if (profile.layout !== 'data' || runtimeLayout !== 'public') return;
    const source = join(runtimePath, 'public');
    if (!await exists(source)) return;
    const destination = join(profile.dataPath, DEFAULT_USER_HANDLE);
    await syncLegacyToCanonical(runtimePath, destination);
    const runtimeConfig = join(runtimePath, 'config.yaml');
    if (await exists(runtimeConfig)) await copyPath(runtimeConfig, profile.configPath);
    // Everything is in the profile now, so the runtime's copy is waste. A run
    // that never got here keeps its copy, which is what the next start needs.
    await clearLegacyRuntimeData(runtimePath);
    this.logger(logEvent('profiles.syncedFromRuntime', `[profiles] synchronized legacy public/ changes back to ${profile.name}`, { name: profile.name }));
  }

  /**
   * Older SillyTavern releases materialize every character card as a base64
   * string when the character list is requested. Give large legacy profiles a
   * larger V8 heap without changing the canonical files or modern runtimes.
   */
  public async recommendedLegacyHeapMb(profile: Profile): Promise<number | null> {
    if (profile.layout !== 'data') return null;
    const source = await resolveUserData(profile.dataPath);
    const bytes = await treeByteSize(source);
    if (bytes < 512 * 1024 * 1024) return null;
    const gib = bytes / (1024 ** 3);
    const heapGb = Math.min(16, Math.max(8, Math.ceil(gib * 2 + 4)));
    const heapMb = heapGb * 1024;
    this.logger(logEvent('profiles.legacyHeap', `[profiles] legacy data is ${gib.toFixed(2)} GiB; using a ${heapMb} MiB Node heap`, { size: gib.toFixed(2), heap: heapMb }));
    return heapMb;
  }

  /**
   * Delete the safety snapshots an older version left behind.
   *
   * Those were plain copies of the profile tree: three kept per profile, one
   * more per legacy migration that no prune ever looked at, and one per
   * interrupted run that was kept indefinitely for review. They cost gigabytes
   * to say what a single compressed archive in the backup library says, so
   * nothing writes them any more and what is on disk is pure cost.
   */
  public async removeLegacySnapshots(): Promise<boolean> {
    const root = join(this.paths.profiles, '.snapshots');
    if (!await exists(root)) return false;
    this.logger(logEvent('profiles.removingLegacySnapshots', '[profiles] removing the safety snapshot copies the backup library replaced'));
    this.trackCleanup(root);
    return true;
  }

  private trackCleanup(path: string): void {
    this.cleanupTail = this.cleanupTail
      .then(() => rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 250 }))
      .catch((error: unknown) => { const reason = error instanceof Error ? error.message : 'unknown error'; this.logger(logEvent('profiles.deferredCleanupFailed', `[profiles] deferred cleanup failed for ${path}: ${reason}`, { path, reason })); });
  }

  /** Wait for background deletions. Tests and shutdown need a quiet filesystem. */
  public async settle(): Promise<void> {
    await this.cleanupTail;
  }

  private async migrateRuntimePublic(profile: Profile, runtimePath: string): Promise<Profile> {
    const yamlPath = join(runtimePath, 'config.yaml');
    const legacyConfigPath = await exists(yamlPath) ? yamlPath : join(runtimePath, 'config.yml');
    const legacy: Profile = { ...profile, layout: 'public', dataPath: join(runtimePath, 'public'), configPath: legacyConfigPath };
    const migrated = await this.migrateTreeToData(legacy);
    const now = this.now().toISOString();
    const profiles = await this.load();
    const next = profiles.map((item) => item.id === profile.id ? {
      ...item,
      dataPath: migrated.dataPath,
      configPath: migrated.configPath,
      layout: 'data' as const,
      legacyLayout: 'public' as const,
      updatedAt: now,
    } : item);
    await this.save(next);
    const result = next.find((item) => item.id === profile.id);
    if (!result) throw new Error('Profile disappeared after legacy migration');
    this.logger(logEvent('profiles.migrated', `[profiles] migrated ${result.name} from public/ to data/${DEFAULT_USER_HANDLE}/`, { name: result.name, handle: DEFAULT_USER_HANDLE }));
    return { ...result };
  }

  private async migrateTreeToData(profile: Profile): Promise<{ dataPath: string; configPath: string }> {
    const profileRoot = join(this.paths.profiles, '.profile-data', profile.id);
    const dataPath = join(profileRoot, 'data');
    const userPath = join(dataPath, DEFAULT_USER_HANDLE);
    const configPath = join(profileRoot, 'config.yaml');
    await mkdir(userPath, { recursive: true });
    if (await exists(profile.dataPath)) {
      for (const child of await readdir(profile.dataPath)) await copyPath(join(profile.dataPath, child), join(userPath, child));
    }
    if (await exists(profile.configPath) && resolve(profile.configPath) !== resolve(configPath)) await copyPath(profile.configPath, configPath);
    return { dataPath: resolve(dataPath), configPath: resolve(configPath) };
  }

  private async load(): Promise<Profile[]> {
    if (this.profiles) return this.profiles;
    await mkdir(this.paths.state, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, PROFILE_STATE_FILE), 'utf8'));
      if (!isRecord(parsed) || parsed.schemaVersion !== PROFILE_SCHEMA_VERSION || !Array.isArray(parsed.profiles)) throw new Error('Invalid profile state');
      this.profiles = parsed.profiles.map((profile) => parseProfile(profile));
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      this.profiles = [];
    }
    return this.profiles;
  }

  private async save(profiles: Profile[]): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, PROFILE_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      const payload: PersistedProfiles = { schemaVersion: PROFILE_SCHEMA_VERSION, profiles };
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.profiles = profiles;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

export class ProfileError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (name.length < 1 || name.length > 80) throw new ProfileError('invalid_profile_name', 'Profile name must be between 1 and 80 characters');
  return name;
}

function parseProfile(value: unknown): Profile {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string' || typeof value.installationId !== 'string' || typeof value.runtimePath !== 'string' || typeof value.configPath !== 'string' || typeof value.dataPath !== 'string' || (value.layout !== 'data' && value.layout !== 'public') || (value.legacyLayout !== undefined && value.legacyLayout !== null && value.legacyLayout !== 'data' && value.legacyLayout !== 'public') || typeof value.active !== 'boolean' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || (value.activatedAt !== null && typeof value.activatedAt !== 'string')) {
    throw new Error('Invalid profile state');
  }
  return value as unknown as Profile;
}

async function copyPath(source: string, destination: string, excluded: Set<string> | null = null): Promise<void> {
  await copyTree(source, destination, excluded, 'A linked profile path needs review before switching profiles');
}

/**
 * Copy a tree by planning it first, then running the file copies in parallel.
 *
 * A profile holds thousands of small chat files. Walking and copying them one
 * at a time is the slowest part of taking a snapshot on a hosted volume, where
 * every operation is a network round trip.
 */
async function copyTree(source: string, destination: string, excluded: Set<string> | null, linkMessage: string): Promise<void> {
  const concurrency = ioConcurrency();
  const limiter = createIoLimiter(concurrency);
  const directories: string[] = [];
  const files: Array<{ source: string; destination: string }> = [];
  const plan = async (from: string, to: string): Promise<void> => {
    const details = await limiter.run(() => lstat(from));
    if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', linkMessage);
    if (!details.isDirectory()) { files.push({ source: from, destination: to }); return; }
    directories.push(to);
    const children = (await limiter.run(() => readdir(from))).filter((child) => !excluded?.has(child));
    await Promise.all(children.map((child) => plan(join(from, child), join(to, child))));
  };
  await plan(source, destination);
  if (directories.length === 0) await mkdir(resolve(destination, '..'), { recursive: true });
  // Shallower paths are parents, so creating them first means the deeper
  // mkdir calls have nothing left to build.
  directories.sort((left, right) => left.length - right.length);
  await runPooled(directories, concurrency, async (directory) => { await mkdir(directory, { recursive: true }); });
  await runPooled(files, concurrency, async (item) => { await copySnapshotFile(item.source, item.destination); });
}

/**
 * Copy one file, asking the filesystem to clone it when it can.
 *
 * COPYFILE_FICLONE falls back to a normal copy where reflinks are unsupported,
 * and `copyFile` keeps the bytes inside the kernel either way instead of
 * pulling them through a JavaScript stream.
 */
async function copySnapshotFile(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, fsConstants.COPYFILE_FICLONE);
}

/**
 * Remove the user data a legacy runtime was given, leaving its own static files.
 *
 * The copy is redundant the moment it has been read back, and leaving it costs
 * far more than its own size: a modern release starting in the same directory
 * treats that tree as data to migrate and copies all of it into
 * backups/_migration first, which was 3.5 GB on one profile here.
 */
async function clearLegacyRuntimeData(runtimePath: string): Promise<void> {
  const publicRoot = join(runtimePath, 'public');
  if (await exists(publicRoot)) {
    for (const child of await readdir(publicRoot)) {
      if (!LEGACY_RUNTIME_STATIC_NAMES.has(child)) await rm(join(publicRoot, child), { recursive: true, force: true });
    }
    await rm(join(publicRoot, 'scripts', 'extensions', 'third-party'), { recursive: true, force: true });
  }
  for (const child of ['backups', 'thumbnails', 'vectors']) await rm(join(runtimePath, child), { recursive: true, force: true });
}

async function syncCanonicalToLegacy(source: string, runtimePath: string): Promise<void> {
  const publicRoot = join(runtimePath, 'public');
  await mkdir(publicRoot, { recursive: true });
  await clearLegacyRuntimeData(runtimePath);
  if (!await exists(source)) return;
  for (const child of await readdir(source)) {
    if (child === 'secrets.json') continue;
    const sourcePath = join(source, child);
    if (child === 'extensions') await copyPath(sourcePath, join(publicRoot, 'scripts', 'extensions', 'third-party'));
    else if (['backups', 'thumbnails', 'vectors'].includes(child)) await copyPath(sourcePath, join(runtimePath, child));
    else await copyPath(sourcePath, join(publicRoot, child));
  }
  const sourceSecrets = join(source, 'secrets.json');
  if (await exists(sourceSecrets)) await copyPath(sourceSecrets, join(runtimePath, 'secrets.json'));
}

async function syncLegacyToCanonical(runtimePath: string, destination: string): Promise<void> {
  const source = join(runtimePath, 'public');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  for (const child of await readdir(source)) {
    if (LEGACY_RUNTIME_STATIC_NAMES.has(child)) continue;
    if (child === 'secrets.json') continue;
    await copyPath(join(source, child), join(destination, child));
  }
  const extensionSource = join(source, 'scripts', 'extensions', 'third-party');
  if (await exists(extensionSource)) await copyPath(extensionSource, join(destination, 'extensions'));
  const runtimeSecrets = join(runtimePath, 'secrets.json');
  if (await exists(runtimeSecrets)) await copyPath(runtimeSecrets, join(destination, 'secrets.json'));
  for (const child of ['backups', 'thumbnails', 'vectors']) {
    const rootPath = join(runtimePath, child);
    if (!await exists(rootPath)) continue;
    // SillyTavern's migration copy duplicates the very tree being copied here,
    // so carrying it in would double the profile and put the double in every
    // archive after it.
    await copyPath(rootPath, join(destination, child), child === 'backups' ? MIGRATION_COPY_NAMES : null);
  }
}

async function resolveUserData(dataPath: string): Promise<string> {
  const userPath = join(dataPath, DEFAULT_USER_HANDLE);
  return await exists(userPath) ? userPath : dataPath;
}

async function treeByteSize(root: string): Promise<number> {
  try {
    const details = await lstat(root);
    if (details.isSymbolicLink()) throw new ProfileError('snapshot_failed', 'A linked profile path needs review before starting a legacy runtime');
    if (details.isFile()) return details.size;
    if (!details.isDirectory()) return 0;
    let total = 0;
    for (const child of await readdir(root)) total += await treeByteSize(join(root, child));
    return total;
  } catch (error: unknown) {
    if (isFileNotFound(error)) return 0;
    throw error;
  }
}

async function runtimeSupportsDataRoot(runtimePath: string): Promise<boolean> {
  try { return (await readFile(join(runtimePath, 'server.js'), 'utf8')).includes('dataRoot'); } catch { return false; }
}

/** The first line of the config.conf this manager writes, and nothing else. */
const MANAGER_LEGACY_CONF_MARKER = "require('./default/config.conf')";

async function writeLegacyRuntimeConfig(runtimePath: string): Promise<void> {
  const defaults = join(runtimePath, 'default', 'config.conf');
  if (!await exists(defaults)) {
    // This runtime reads config.yaml. A config.conf left by an older checkout
    // makes its post-install stop merging defaults - "Both config.conf and
    // config.yaml exist. Please delete config.conf manually." - so take back
    // the file this manager wrote. A file it did not write is left alone.
    const ours = join(runtimePath, 'config.conf');
    try {
      if ((await readFile(ours, 'utf8')).includes(MANAGER_LEGACY_CONF_MARKER)) await rm(ours, { force: true });
    } catch { /* nothing of ours to take back */ }
    return;
  }
  let config: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(await readFile(join(runtimePath, 'config.yaml'), 'utf8')) as unknown;
    if (isRecord(parsed)) config = parsed;
  } catch { /* the legacy default remains the fallback */ }
  const overrides = {
    port: 8000,
    // Legacy runtimes do not reliably support account sessions. Keep them
    // local-only instead of falling back to the removed Basic Auth mode.
    listen: false,
    autorun: false,
    enableUserAccounts: config.enableUserAccounts === true,
    enableCorsProxy: config.enableCorsProxy === true,
    disableCsrfProtection: config.disableCsrfProtection === true,
  };
  const payload = `const defaults = require('./default/config.conf');\nmodule.exports = { ...defaults, ${JSON.stringify(overrides).slice(1, -1)} };\n`;
  await writeFile(join(runtimePath, 'config.conf'), payload, { encoding: 'utf8', mode: 0o600 });
}

/**
 * Whether this directory holds somebody's SillyTavern data, as opposed to
 * SillyTavern itself. See LEGACY_DATA_NAMES.
 */
async function holdsUserData(path: string): Promise<boolean> {
  for (const name of LEGACY_DATA_NAMES) {
    if (await exists(join(path, name))) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    return isFileNotFound(error) ? false : Promise.reject(error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
