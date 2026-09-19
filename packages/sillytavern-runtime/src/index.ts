import { createWriteStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createServer as createProbeServer } from 'node:net';
import {
  logEvent, logLineText,
  type Installation,
  type InstallationStatus,
  type LogEvent,
  type LogSink,
  type VersionChannel,
  type VersionOption,
  type VersionSelector,
} from '../../contracts/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';

const REPOSITORY = 'SillyTavern/SillyTavern';
const INSTALLATIONS_FILE = 'installations.json';
const ACTIVE_FILE = 'active-installation.json';
const MARKER_FILE = '.stm-installation.json';
const GITHUB_API = 'https://api.github.com';
const MAX_ZIP_DIRECTORY_BYTES = 64 * 1024 * 1024;
const GIT_REPOSITORY = `https://github.com/${REPOSITORY}.git`;
const DEPENDENCY_MARKER = '.stm-dependencies.json';
/** SillyTavern's own default, used when no console has said where it runs. */
/** The port this console runs SillyTavern on; see SILLYTAVERN_PORT in the server. */
const DEFAULT_SILLYTAVERN_PORT = 8002;

/** How work running before the download says what it is doing. */
export type BeforeInstallReport = (progress: number, step: LogEvent) => Promise<void>;

export interface InstallationProgress {
  readonly status: InstallationStatus;
  readonly progress: number;
  /** English step text, plus the catalog key the panel translates it with. */
  readonly step: LogEvent;
}

export interface RuntimeManagerOptions {
  readonly paths: PlatformPaths;
  readonly fetch?: typeof globalThis.fetch;
  readonly now?: () => Date;
  readonly logger?: LogSink;
  readonly githubApiBaseUrl?: string;
  readonly npmCommand?: string;
  readonly installDependencies?: (runtimePath: string, onLine: (line: string) => void, signal?: AbortSignal) => Promise<void>;
  readonly healthCheck?: (runtimePath: string, onLine?: (line: string) => void) => Promise<void>;
  readonly healthCheckTimeoutMs?: number;
  /**
   * Which port to check a fresh installation on.
   *
   * A function where the console supplies it, because the console can move
   * SillyTavern between two installs and a port captured here would have the
   * check refusing over whatever happens to hold the old one. Tests pass a
   * number, which is the port they bound.
   */
  readonly healthCheckPort?: number | (() => number);
  /** Production uses one shared Git checkout. Tests can force the zip fallback. */
  readonly useGit?: boolean;
  readonly gitCommand?: string;
  readonly repositoryUrl?: string;
}

interface ReleasePayload {
  readonly tag_name?: unknown;
  readonly name?: unknown;
  readonly published_at?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
}

interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compression: number;
  readonly localOffset: number;
  readonly directory: boolean;
  readonly symlink: boolean;
}

export class RuntimeManager {
  readonly paths: PlatformPaths;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly logger: LogSink;
  private readonly githubApiBaseUrl: string;
  private readonly npmCommand: string;
  private readonly installDependencies: (runtimePath: string, onLine: (line: string) => void, signal?: AbortSignal) => Promise<void>;
  private readonly healthCheck: (runtimePath: string, onLine?: (line: string) => void) => Promise<void>;
  private readonly healthCheckTimeoutMs: number;
  private readonly useGit: boolean;
  private readonly gitCommand: string;
  private readonly repositoryUrl: string;
  private installations: Installation[] | null = null;
  private versionsCache: { expiresAt: number; options: VersionOption[] } | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private inFlightId: string | null = null;

  public constructor(options: RuntimeManagerOptions) {
    this.paths = options.paths;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.githubApiBaseUrl = (options.githubApiBaseUrl ?? GITHUB_API).replace(/\/$/u, '');
    this.npmCommand = options.npmCommand ?? 'npm';
    this.installDependencies = options.installDependencies ?? ((path, log, signal) => runNpmInstall(path, this.npmCommand, log, signal));
    // SillyTavern performs content seeding and frontend compilation on its first
    // launch. Two minutes is too short for a free ModelScope/low-CPU workspace.
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? 300_000;
    this.useGit = options.useGit ?? options.fetch === undefined;
    this.gitCommand = options.gitCommand ?? 'git';
    this.repositoryUrl = options.repositoryUrl ?? GIT_REPOSITORY;
    const configured = options.healthCheckPort;
    const healthCheckPort = typeof configured === 'function' ? configured : (): number => configured ?? DEFAULT_SILLYTAVERN_PORT;
    this.healthCheck = options.healthCheck
      ? options.healthCheck
      : (runtimePath, onLine) => probeRuntime(runtimePath, this.healthCheckTimeoutMs, healthCheckPort(), (line) => {
        if (onLine) onLine(line); else this.logger(`[sillytavern] ${line}`);
      });
  }

  public async listVersions(forceRefresh = false): Promise<VersionOption[]> {
    if (!forceRefresh && this.versionsCache && this.versionsCache.expiresAt > Date.now()) {
      return this.versionsCache.options;
    }
    const response = await this.fetcher(`${this.githubApiBaseUrl}/repos/${REPOSITORY}/releases?per_page=100`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'sillytavern-manager' },
    });
    if (!response.ok) {
      throw new RuntimeError('github_unavailable', `GitHub returned HTTP ${response.status}`);
    }
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      throw new RuntimeError('github_invalid_response', 'GitHub returned an invalid release list');
    }
    const releases = payload
      .filter(isReleasePayload)
      .filter((release) => release.draft !== true && release.prerelease !== true)
      .map((release) => ({
        tag: typeof release.tag_name === 'string' ? release.tag_name : '',
        name: typeof release.name === 'string' && release.name.length > 0 ? release.name : null,
        publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      }))
      .filter((release) => release.tag.length > 0);
    const latest = releases[0];
    const options: VersionOption[] = [
      {
        selector: 'latest',
        label: `${latest?.name ?? latest?.tag ?? 'Latest release'} (latest)`,
        ref: latest?.tag ?? 'release',
        channel: 'release',
        tag: latest?.tag ?? null,
        publishedAt: latest?.publishedAt ?? null,
      },
      { selector: 'release', label: 'Release branch', ref: 'release', channel: 'release', tag: null, publishedAt: null },
      { selector: 'staging', label: 'Staging branch', ref: 'staging', channel: 'staging', tag: null, publishedAt: null },
      ...releases.map((release) => ({
        selector: release.tag,
        label: release.name ? `${release.name} (${release.tag})` : release.tag,
        ref: release.tag,
        channel: 'release' as const,
        tag: release.tag,
        publishedAt: release.publishedAt,
      })),
    ];
    this.versionsCache = { expiresAt: Date.now() + 60_000, options };
    return options;
  }

  public async listInstallations(): Promise<Installation[]> {
    const installations = await this.loadInstallations();
    return installations.map((installation) => ({ ...installation }));
  }

  public async getInstallation(id: string): Promise<Installation | null> {
    const installations = await this.loadInstallations();
    return installations.find((installation) => installation.id === id) ?? null;
  }

  public async getActiveInstallation(): Promise<Installation | null> {
    try {
      const raw = await readFile(join(this.paths.state, ACTIVE_FILE), 'utf8');
      const id = JSON.parse(raw) as unknown;
      return typeof id === 'string' ? this.getInstallation(id) : null;
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * Move an installation created before the shared Git checkout existed onto
   * the shared runtime. The old copy is left in place until every validation
   * step succeeds; callers can remove stale copies afterwards.
   */
  public async migrateLegacyInstallation(installation: Installation): Promise<Installation> {
    if (!this.useGit || resolve(installation.runtimePath) === resolve(this.runtimePathFor(installation.id))) return installation;
    if (installation.status !== 'ready') return installation;
    const runtimePath = this.runtimePathFor(installation.id);
    const markerPath = join(runtimePath, MARKER_FILE);
    await mkdir(runtimePath, { recursive: true });
    await rm(markerPath, { force: true });
    const revision = await this.prepareGitCheckout(runtimePath, installation.resolvedRef, this.logger, installation.revision);
    await this.installDependenciesIfNeeded(runtimePath, this.logger);
    await this.healthCheck(runtimePath, this.logger);
    const migrated = {
      ...installation,
      revision,
      runtimePath,
      markerPath,
      updatedAt: this.now().toISOString(),
      activatedAt: this.now().toISOString(),
    } satisfies Installation;
    await this.writeMarker(migrated);
    await this.upsert(migrated);
    await this.writeActiveInstallation(migrated.id);
    this.logger(logEvent('installer.migratedToSharedCheckout', `[installer] migrated ${installation.resolvedRef} to the shared Git checkout`, { ref: installation.resolvedRef }));
    return migrated;
  }

  /** Remove pre-shared-checkout runtime copies after their data has been rebound. */
  public async cleanupLegacyRuntimeCopies(exceptId: string): Promise<void> {
    if (!this.useGit) return;
    const shared = resolve(this.runtimePathFor(exceptId));
    for (const installation of await this.listInstallations()) {
      const candidate = resolve(installation.runtimePath);
      if (installation.id === exceptId || candidate === shared) continue;
      const parent = resolve(this.paths.profiles, installation.id);
      if (!candidate.startsWith(`${parent}\\`) && !candidate.startsWith(`${parent}/`)) continue;
      await rm(parent, { recursive: true, force: true });
      await this.upsert({ ...installation, status: 'failed', step: 'Runtime moved to shared checkout', error: 'This legacy runtime copy was removed after switching to the shared Git checkout', updatedAt: this.now().toISOString() });
      this.logger(logEvent('installer.removedLegacyCopy', `[installer] removed legacy runtime copy ${installation.id}`, { id: installation.id }));
    }
  }

  /**
   * Take SillyTavern off the disk, leaving every profile where it is.
   *
   * This is the way back from a runtime that will not start or will not
   * install over itself: remove it and install again. It deletes the checkout
   * and forgets every installation record, and it touches nothing under a
   * profile - the next install rebinds the profile that is already there, with
   * its characters and chats untouched.
   *
   * Callers must stop SillyTavern first, and must not call it while an install
   * is in flight; both are refused here rather than left to race.
   */
  public async removeInstallations(): Promise<void> {
    if (this.inFlightId) throw new RuntimeError('installation_busy', 'An installation is already in progress');
    const installations = await this.listInstallations();
    const roots = new Set<string>();
    for (const installation of installations) {
      roots.add(resolve(installation.runtimePath));
      // A pre-shared-checkout install kept its runtime under its own folder;
      // that folder is the installation's and goes with it.
      if (!this.useGit) roots.add(resolve(this.paths.profiles, installation.id));
    }
    roots.add(resolve(this.runtimePathFor(installations[0]?.id ?? 'runtime')));
    for (const root of roots) {
      // Never step outside the profiles tree, whatever a record claims its
      // runtime path was.
      const base = resolve(this.paths.profiles);
      if (root !== base && !root.startsWith(`${base}/`) && !root.startsWith(`${base}\\`)) continue;
      if (root === base) continue;
      await rm(root, { recursive: true, force: true });
    }
    await this.writeInstallations([]);
    await rm(join(this.paths.state, ACTIVE_FILE), { force: true });
    this.versionsCache = null;
    this.logger(logEvent('installer.removed', '[installer] SillyTavern was removed; profiles were left alone'));
  }

  public async activateInstallation(id: string): Promise<Installation> {
    const installation = await this.getInstallation(id);
    if (!installation || installation.status !== 'ready') throw new RuntimeError('installation_not_ready', 'The selected SillyTavern installation is not ready');
    if (this.useGit && resolve(installation.runtimePath) === resolve(this.runtimePathFor(id))) {
      await rm(installation.markerPath, { force: true });
      await this.prepareGitCheckout(installation.runtimePath, installation.resolvedRef, this.logger, installation.revision);
      await this.installDependenciesIfNeeded(installation.runtimePath, this.logger);
      await this.healthCheck(installation.runtimePath, this.logger);
      await this.writeMarker(installation);
    } else await assertInstallationMarker(installation);
    await this.writeActiveInstallation(id);
    return installation;
  }

  public async install(
    selector: VersionSelector,
    onProgress?: (progress: InstallationProgress) => void,
  ): Promise<Installation> {
    return this.queueInstall(selector, onProgress).promise;
  }

  public queueInstall(
    selector: VersionSelector,
    onProgress?: (progress: InstallationProgress) => void,
    beforeInstall?: (report: BeforeInstallReport) => Promise<void>,
    /** Stops the install and takes back everything it wrote; see INSTALL_CANCELED. */
    signal?: AbortSignal,
  ): { id: string; promise: Promise<Installation> } {
    if (this.inFlightId) throw new RuntimeError('installation_busy', 'An installation is already in progress');
    const id = randomUUID();
    this.inFlightId = id;
    const promise = this.installWithId(id, selector, onProgress, beforeInstall, signal).finally(() => { this.inFlightId = null; });
    return { id, promise };
  }

  private async installWithId(
    id: string,
    selector: VersionSelector,
    onProgress?: (progress: InstallationProgress) => void,
    beforeInstall?: (report: BeforeInstallReport) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<Installation> {
    const now = this.now().toISOString();
    const initial: Installation = {
      id, selector, resolvedRef: selector, channel: selector === 'staging' ? 'staging' : 'release',
      runtimePath: this.runtimePathFor(id), markerPath: join(this.runtimePathFor(id), MARKER_FILE),
      status: 'queued', progress: 0, step: 'Waiting to start', stepCode: 'install.waiting', error: null, createdAt: now, updatedAt: now, activatedAt: null,
    };
    await this.upsert(initial);
    const update = async (status: InstallationStatus, progress: number, step: LogEvent, error: string | null = null, errorCode?: string): Promise<Installation> => {
      const current = await this.getInstallation(id);
      if (!current) throw new Error('Installation record disappeared');
      const next: Installation = { ...current, status, progress, step: step.message, stepCode: step.code, ...(step.params ? { stepParams: step.params } : {}), error, ...(errorCode ? { errorCode } : {}), updatedAt: this.now().toISOString() };
      await this.upsert(next); onProgress?.({ status, progress, step }); this.logger(logEvent(step.code, `[installer:${id}] ${step.message}`, step.params)); return next;
    };

    const stagingRoot = join(this.paths.tmp, `installation-${id}`);
    let finalRoot: string | null = null;
    const previous = await this.getActiveInstallation();
    let checkoutChanged = false;
    try {
      throwIfCanceled(signal);
      const resolved = await this.resolveSelector(selector);
      await update('queued', 2, logEvent('install.resolved', `Resolved ${resolved.ref}`, { ref: resolved.ref }));
      await beforeInstall?.((progress, step) => update('queued', progress, step).then(() => undefined));
      throwIfCanceled(signal);
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(stagingRoot, { recursive: true });
      let extractedPath: string;
      let revision: string | undefined;
      if (this.useGit) {
        await update('downloading', 15, logEvent('install.preparingCheckout', `Preparing shared Git checkout for ${resolved.ref}`, { ref: resolved.ref }));
        const sharedPath = this.runtimePathFor(id);
        checkoutChanged = true;
        await rm(join(sharedPath, MARKER_FILE), { force: true });
        revision = await this.prepareGitCheckout(sharedPath, resolved.ref, (line) => this.logger(`[installer:${id}] ${line}`), undefined, signal);
        await update('extracting', 48, logEvent('install.checkedOut', `Checked out ${resolved.ref}`, { ref: resolved.ref }));
        extractedPath = sharedPath;
        finalRoot = sharedPath;
      } else {
        const zipPath = join(stagingRoot, 'source.zip');
        await update('downloading', 5, logEvent('install.downloading', `Downloading ${resolved.ref}`, { ref: resolved.ref }));
        await this.downloadZip(resolved.ref, zipPath, (progress) => onProgress?.({ status: 'downloading', progress: 5 + progress * 0.4, step: logEvent('install.downloadingArchive', 'Downloading source archive') }), signal);
        await update('extracting', 48, logEvent('install.extracting', 'Extracting source archive'));
        extractedPath = join(stagingRoot, 'runtime');
        await mkdir(extractedPath, { recursive: true });
        await extractZipSafely(zipPath, extractedPath, (progress) => onProgress?.({ status: 'extracting', progress: 48 + progress * 0.2, step: logEvent('install.extracting', 'Extracting source archive') }), signal);
      }
      await update('installing', 70, logEvent('install.installingDependencies', 'Installing SillyTavern dependencies'));
      await this.installDependenciesIfNeeded(extractedPath, (line) => this.logger(`[installer:${id}] ${line}`), signal);
      await update('health_check', 90, logEvent('install.checking', 'Checking the installation'));
      throwIfCanceled(signal);
      await this.healthCheck(extractedPath, (line) => this.logger(`[installer:${id}] ${line}`));
      throwIfCanceled(signal);
      if (!this.useGit) {
        finalRoot = this.runtimePathFor(id);
        await mkdir(join(this.paths.profiles, id), { recursive: true });
        await rm(finalRoot, { recursive: true, force: true });
        await rename(extractedPath, finalRoot);
      }
      const installedRoot = finalRoot ?? this.runtimePathFor(id);
      const ready = await update('ready', 100, logEvent('install.ready', 'Installation ready'));
      const activated = { ...ready, ...(revision ? { revision } : {}), resolvedRef: resolved.ref, channel: resolved.channel, runtimePath: installedRoot, markerPath: join(installedRoot, MARKER_FILE), activatedAt: this.now().toISOString(), updatedAt: this.now().toISOString() } satisfies Installation;
      await this.writeMarker(activated);
      await this.upsert(activated);
      await this.writeActiveInstallation(id);
      this.logger(logEvent('installer.ready', `[installer:${id}] installation ${resolved.ref} is ready`, { ref: resolved.ref }));
      return activated;
    } catch (error: unknown) {
      /*
       * Stopped, rather than broken.
       *
       * Everything this install wrote goes back: the staging directory below,
       * and - when there was nothing here before it - the shared checkout and
       * the half-built node_modules inside it. A first install that is stopped
       * has to leave the machine as it found it, or the next attempt meets a
       * checkout it did not make and refuses to touch it. When there was a
       * previous installation, that one is put back instead and its files are
       * not this attempt's to remove.
       */
      if (error instanceof RuntimeError && error.code === INSTALL_CANCELED) {
        const stopped = await this.cleanUpCanceledInstall(id, previous, checkoutChanged);
        await rm(stagingRoot, { recursive: true, force: true });
        return stopped;
      }
      const message = error instanceof RuntimeError ? error.message : error instanceof Error ? error.message : 'Installation failed';
      // Only a refusal this manager wrote carries a code. A line from git or
      // npm is that program's own words and is shown as it arrived.
      const failed = await update('failed', 100, logEvent('install.failed', 'Installation failed'), message, error instanceof RuntimeError ? error.code : undefined);
      if (finalRoot && !this.useGit) await rm(finalRoot, { recursive: true, force: true });
      if (checkoutChanged && previous) {
        try { await this.activateInstallation(previous.id); this.logger(logEvent('installer.previousRestored', '[installer] previous runtime restored')); }
        catch (rollbackError: unknown) { const reason = rollbackError instanceof Error ? rollbackError.message : 'unknown error'; this.logger(logEvent('installer.rollbackFailed', `[installer] rollback failed: ${reason}`, { reason })); }
      }
      this.logger(logEvent('installer.failed', `[installer:${id}] failed: ${message}`, { reason: message }));
      return failed;
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }

  /**
   * Put the machine back the way a stopped install found it.
   *
   * With a previous installation there is one to go back to, so it is
   * reactivated and the runtime stays where it is. With none, this install
   * made the checkout, and what it made comes out - including the
   * dependencies, because a node_modules killed partway through is worse than
   * none at all: it looks installed and is not.
   */
  private async cleanUpCanceledInstall(id: string, previous: Installation | null, checkoutChanged: boolean): Promise<Installation> {
    const record = await this.getInstallation(id);
    const now = this.now().toISOString();
    if (!previous && checkoutChanged) {
      const base = resolve(this.paths.profiles);
      const root = resolve(this.runtimePathFor(id));
      if (root !== base && (root.startsWith(base + '/') || root.startsWith(base + '\\'))) {
        await rm(root, { recursive: true, force: true });
        this.logger(logEvent('installer.canceledCleanup', `[installer:${id}] the stopped installation was removed`, { id }));
      }
      await rm(join(this.paths.state, ACTIVE_FILE), { force: true });
    } else if (previous) {
      try { await this.activateInstallation(previous.id); this.logger(logEvent('installer.previousRestored', '[installer] previous runtime restored')); }
      catch (error: unknown) { const reason = error instanceof Error ? error.message : 'unknown error'; this.logger(logEvent('installer.rollbackFailed', `[installer] rollback failed: ${reason}`, { reason })); }
    }
    // The record goes rather than standing in the list as a failure nobody had.
    const remaining = (await this.listInstallations()).filter((installation) => installation.id !== id);
    await this.writeInstallations(remaining);
    this.logger(logEvent('installer.canceled', `[installer:${id}] the installation was stopped`, { id }));
    return { ...(record ?? {} as Installation), id, status: 'failed', progress: 0, step: 'Installation stopped', stepCode: 'install.canceled', error: null, errorCode: INSTALL_CANCELED, updatedAt: now };
  }

  private runtimePathFor(id: string): string {
    return this.useGit ? join(this.paths.profiles, 'runtime') : join(this.paths.profiles, id, 'runtime');
  }

  private async installDependenciesIfNeeded(runtimePath: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
    throwIfCanceled(signal);
    const fingerprint = await dependencyFingerprint(runtimePath);
    const markerPath = join(runtimePath, 'node_modules', DEPENDENCY_MARKER);
    if (await pathExists(join(runtimePath, 'node_modules'))) {
      try {
        const marker = JSON.parse(await readFile(markerPath, 'utf8')) as unknown;
        if (isRecord(marker) && marker.schemaVersion === 1 && marker.fingerprint === fingerprint) {
          onLine('Using cached SillyTavern dependencies');
          return;
        }
      } catch { /* missing or stale marker: install below */ }
    }
    await this.installDependencies(runtimePath, onLine, signal);
    throwIfCanceled(signal);
    await mkdir(join(runtimePath, 'node_modules'), { recursive: true });
    const temporary = `${markerPath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, fingerprint })}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, markerPath);
  }

  private async writeMarker(installation: Installation): Promise<void> {
    const marker = { schemaVersion: 1, installationId: installation.id, resolvedRef: installation.resolvedRef, revision: installation.revision, installedAt: this.now().toISOString() };
    const temporary = `${installation.markerPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, installation.markerPath);
  }

  private async prepareGitCheckout(runtimePath: string, ref: string, onLine: (line: string) => void, pinnedRevision?: string, signal?: AbortSignal): Promise<string> {
    throwIfCanceled(signal);
    await mkdir(dirname(runtimePath), { recursive: true });
    const gitDir = join(runtimePath, '.git');
    if (!await pathExists(gitDir)) {
      await mkdir(runtimePath, { recursive: true });
      if ((await readdir(runtimePath)).length > 0) throw new RuntimeError('runtime_not_managed', 'The shared runtime directory is not empty and is not a Git checkout');
      await runGit(this.gitCommand, ['init', runtimePath], onLine);
      await runGit(this.gitCommand, ['-C', runtimePath, 'remote', 'add', 'origin', this.repositoryUrl], onLine);
    }
    const top = await runGit(this.gitCommand, ['-C', runtimePath, 'rev-parse', '--show-toplevel'], () => undefined);
    const [checkoutRoot, managedRoot] = await Promise.all([realpath(top.trim()), realpath(runtimePath)]);
    const sameRoot = process.platform === 'win32'
      ? checkoutRoot.toLowerCase() === managedRoot.toLowerCase()
      : checkoutRoot === managedRoot;
    if (!sameRoot) throw new RuntimeError('runtime_not_managed', 'Refusing to change a checkout outside the manager runtime');
    const moving = ref === 'release' || ref === 'staging';
    const localRef = `refs/stm/${moving ? 'heads' : 'tags'}/${ref}`;
    let revision = pinnedRevision;
    if (!revision && !moving) revision = await runGit(this.gitCommand, ['-C', runtimePath, 'rev-parse', '--verify', `${localRef}^{commit}`], () => undefined).then((value) => value.trim()).catch(() => undefined);
    if (!revision) {
      onLine(`Fetching ${ref}`);
      let failure: unknown;
      for (const attempt of gitFetchAttempts(runtimePath, moving ? 'heads' : 'tags', ref, localRef)) {
        if (attempt.note) {
          // An interrupted or refused fetch leaves a half-written packfile
          // behind. Remove only Git's temporary pack files; the objects that
          // earlier fetches wrote are still good.
          onLine(attempt.note);
          await removeTemporaryGitPacks(runtimePath);
        }
        try { await runGit(this.gitCommand, attempt.args, onLine); failure = undefined; break; }
        catch (error: unknown) { failure ??= error; }
      }
      // The first failure is the one that says what went wrong; a later attempt
      // only ever reports that the same fetch failed again.
      if (failure !== undefined) throw failure;
      revision = (await runGit(this.gitCommand, ['-C', runtimePath, 'rev-parse', '--verify', `${localRef}^{commit}`], () => undefined)).trim();
    } else onLine(`Using cached source ${ref}`);
    if (!/^[a-f0-9]{40,64}$/u.test(revision)) throw new RuntimeError('invalid_revision', 'Git returned an invalid revision');
    await runGit(this.gitCommand, ['-C', runtimePath, 'clean', '-fd', '-e', 'node_modules', '-e', 'public', '-e', 'data', '-e', 'backups', '-e', 'thumbnails', '-e', 'vectors', '-e', 'secrets.json', '-e', 'config.conf'], onLine);
    await runGit(this.gitCommand, ['-C', runtimePath, 'checkout', '--force', '--detach', revision], onLine);
    return revision;
  }

  public async resolveSelector(selector: VersionSelector): Promise<{ ref: string; channel: VersionChannel }> {
    if (selector === 'latest') {
      const latest = (await this.listVersions())[0];
      return { ref: latest?.ref ?? 'release', channel: 'release' };
    }
    if (selector === 'release' || selector === 'staging') return { ref: selector, channel: selector as VersionChannel };
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(selector) || selector.includes('..')) {
      throw new RuntimeError('invalid_version', 'The selected version is invalid');
    }
    return { ref: selector, channel: 'release' as const };
  }

  private async downloadZip(ref: string, target: string, onProgress: (progress: number) => void, signal?: AbortSignal): Promise<void> {
    throwIfCanceled(signal);
    const url = `https://github.com/${REPOSITORY}/zipball/${encodeURIComponent(ref)}`;
    const response = await this.fetcher(url, { headers: { accept: 'application/zip', 'user-agent': 'sillytavern-manager' }, redirect: 'follow', ...(signal ? { signal } : {}) });
    if (!response.ok || !response.body) throw new RuntimeError('download_failed', `GitHub archive download failed (HTTP ${response.status})`);
    const expected = Number(response.headers.get('content-length') ?? 0);
    let received = 0;
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    source.on('data', (chunk: Buffer) => { received += chunk.length; if (expected > 0) onProgress(Math.min(1, received / expected)); });
    await pipeline(source, createWriteStream(target, { mode: 0o600 }));
    onProgress(1);
  }

  private async loadInstallations(): Promise<Installation[]> {
    if (this.installations) return this.installations;
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, INSTALLATIONS_FILE), 'utf8'));
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.installations)) throw new Error('Invalid installation state');
      this.installations = (parsed.installations as Installation[]).map((installation) =>
        installation.status === 'ready' || installation.status === 'failed' ? installation : {
          ...installation, status: 'failed', step: 'Installation interrupted', error: 'The manager stopped before the installation completed', updatedAt: this.now().toISOString(),
        });
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      this.installations = [];
    }
    return this.installations;
  }

  private async upsert(installation: Installation): Promise<void> {
    const operation = async () => {
      const installations = await this.loadInstallations();
      const index = installations.findIndex((item) => item.id === installation.id);
      if (index < 0) installations.push(installation); else installations[index] = installation;
      await this.persistInstallations(installations);
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }

  /** Replace the whole record list, through the same queue as a single write. */
  private async writeInstallations(installations: Installation[]): Promise<void> {
    const operation = async () => {
      this.installations = installations;
      await this.persistInstallations(installations);
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }

  private async persistInstallations(installations: Installation[]): Promise<void> {
    await mkdir(this.paths.state, { recursive: true });
    const target = join(this.paths.state, INSTALLATIONS_FILE);
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, installations }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private async writeActiveInstallation(id: string): Promise<void> {
    await mkdir(this.paths.state, { recursive: true });
    const target = join(this.paths.state, ACTIVE_FILE);
    const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(id)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }
}

export class RuntimeError extends Error {
  public readonly code: string;
  public constructor(code: string, message: string) { super(message); this.code = code; }
}

/**
 * The code a stopped install carries, so it is told apart from one that broke.
 *
 * A first install is a Git fetch, an `npm install` and a start of SillyTavern:
 * minutes on a fast machine and a good deal longer on a phone. Somebody who
 * started it by mistake, or on the wrong version, had no way out but to leave
 * the manager running until it finished. Stopping is not a failure and is not
 * reported as one - but everything it half-wrote still has to go.
 */
export const INSTALL_CANCELED = 'install_canceled';

function canceled(): RuntimeError {
  return new RuntimeError(INSTALL_CANCELED, 'The installation was stopped');
}

function throwIfCanceled(signal?: AbortSignal): void {
  if (signal?.aborted) throw canceled();
}

async function probeRuntime(
  runtimePath: string,
  timeoutMs: number,
  port = DEFAULT_SILLYTAVERN_PORT,
  onLine?: (line: string) => void,
): Promise<void> {
  let packageJson: unknown;
  try { packageJson = JSON.parse(await readFile(join(runtimePath, 'package.json'), 'utf8')); } catch { throw new RuntimeError('health_check_failed', 'The installation does not contain a valid package.json'); }
  if (!isRecord(packageJson) || packageJson.name !== 'sillytavern' || !isRecord(packageJson.scripts) || typeof packageJson.scripts.start !== 'string') {
    throw new RuntimeError('health_check_failed', 'The SillyTavern start script is missing');
  }
  await assertPortAvailable(port);
  const supportsDataRoot = (await readFile(join(runtimePath, 'server.js'), 'utf8')).includes('dataRoot');
  const dataRoot = supportsDataRoot ? join(tmpdir(), 'sillytavern-manager-health', randomUUID()) : null;
  if (dataRoot) await mkdir(dataRoot, { recursive: true });
  else if (!await pathExists(join(runtimePath, 'public', 'index.html'))) throw new RuntimeError('health_check_failed', 'Legacy SillyTavern runtime is missing public/index.html');
  const output: string[] = [];
  const appendOutput = (chunk: string) => {
    const lines = chunk.split(/\r?\n/u);
    for (const line of lines) {
      const clean = line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '').trim();
      if (!clean) continue;
      output.push(clean);
      if (output.length > 80) output.shift();
      onLine?.(clean);
    }
  };
  const args = ['server.js', '--port', String(port), '--listen', 'false', '--browserLaunchEnabled', 'false'];
  if (dataRoot) args.push('--dataRoot', dataRoot);
  const child = spawn(process.execPath, args, { cwd: runtimePath, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', appendOutput);
  child.stderr?.on('data', appendOutput);
  try {
    await waitForHttp(`http://127.0.0.1:${port}/`, child, timeoutMs, () => output);
  } finally {
    await stopChild(child);
    if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
  }
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const probe = createProbeServer();
    probe.once('error', () => { probe.close(); reject(new RuntimeError('health_check_failed', `Port ${port} is already in use`)); });
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolvePromise()));
  });
}

async function waitForHttp(url: string, child: ChildProcess, timeoutMs: number, getOutput: () => string[]): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      const details = getOutput().slice(-8).join(' | ');
      throw new RuntimeError('health_check_failed', details.length > 0 ? `SillyTavern exited during the health check: ${details}` : 'SillyTavern exited during the health check');
    }
    try { const response = await fetch(url); if (response.ok) return; } catch { /* startup is still in progress */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const details = getOutput().slice(-8).join(' | ');
  throw new RuntimeError('health_check_failed', details.length > 0 ? `SillyTavern did not become ready in time: ${details}` : 'SillyTavern did not become ready in time');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolvePromise) => { const timer = setTimeout(resolvePromise, 2_000); child.once('exit', () => { clearTimeout(timer); resolvePromise(); }); });
  if (child.exitCode === null) child.kill('SIGKILL');
}

export interface GitFetchAttempt {
  readonly args: readonly string[];
  /** What the log says before this attempt; the first attempt is already announced. */
  readonly note: string | null;
}

/**
 * Every way this manager knows to fetch one ref, in the order it tries them.
 *
 * A fetch into a checkout that already holds objects offers those objects to
 * the server, which answers with a thin pack; Git then rereads the temporary
 * packfile it has just written in order to rewrite its header and checksum.
 * The network-backed volume a ModelScope Studio keeps its data on can fail that
 * reread even though the write went through, and says so in the only words it
 * has:
 *
 *   fatal: Failed to checksum '.git/objects/pack/tmp_pack_XXXXXX': No such file or directory
 *
 * The first install never meets this, because an empty checkout has nothing to
 * offer and the pack it gets back is already complete - only a change of
 * version does. `--refetch` offers nothing either, so the pack arrives complete
 * and Git leaves its temporary file alone. That costs the whole download again,
 * which is why it comes last rather than first.
 */
export function gitFetchAttempts(runtimePath: string, namespace: 'heads' | 'tags', ref: string, localRef: string): readonly GitFetchAttempt[] {
  const fetchArgs = (...extra: readonly string[]): readonly string[] =>
    ['-C', runtimePath, 'fetch', '--depth=1', '--no-tags', ...extra, 'origin', `+refs/${namespace}/${ref}:${localRef}`];
  return [
    { args: fetchArgs(), note: null },
    { args: fetchArgs(), note: 'Git fetch failed; cleaning temporary pack files and retrying' },
    { args: fetchArgs('--refetch'), note: 'Git fetch failed again; asking for a complete pack, which this filesystem can write without rereading it' },
  ];
}

async function removeTemporaryGitPacks(runtimePath: string): Promise<void> {
  const packDirectory = join(runtimePath, '.git', 'objects', 'pack');
  let names: string[];
  try { names = await readdir(packDirectory); } catch { return; }
  await Promise.all(names.filter((name) => name.includes('tmp_pack') || name.endsWith('.tmp')).map((name) => rm(join(packDirectory, name), { force: true })));
}

async function runNpmInstall(runtimePath: string, npmCommand: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<void> {
  throwIfCanceled(signal);
  const cacheDirectory = join(tmpdir(), 'sillytavern-manager-npm-cache');
  await mkdir(cacheDirectory, { recursive: true });
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(npmCommand, ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--progress=false'], {
      cwd: runtimePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
      // Node kills the child when this fires, which is the whole of what
      // stopping an install means while npm is the thing taking the minutes.
      ...(signal ? { signal } : {}),
      env: {
        ...process.env,
        npm_config_cache: cacheDirectory,
        npm_config_update_notifier: 'false',
        TMPDIR: cacheDirectory,
      },
    });
    const consume = (stream: NodeJS.ReadableStream) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => { pending += chunk; const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? ''; for (const line of lines) if (line.trim()) onLine(line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '')); });
      stream.on('end', () => { if (pending.trim()) onLine(pending.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '')); });
    };
    consume(child.stdout); consume(child.stderr);
    // An abort arrives here as the spawn's own AbortError. It is not npm
    // failing, and must not be reported as one.
    child.once('error', (error) => reject(signal?.aborted ? canceled() : new RuntimeError('npm_failed', `Could not start npm: ${error.message}`)));
    child.once('close', (code) => code === 0 ? resolvePromise() : reject(signal?.aborted ? canceled() : new RuntimeError('npm_failed', `npm install exited with code ${code ?? 'unknown'}`)));
  });
}

async function runGit(gitCommand: string, args: readonly string[], onLine: (line: string) => void, signal?: AbortSignal): Promise<string> {
  throwIfCanceled(signal);
  return new Promise<string>((resolvePromise, reject) => {
    let output = '';
    const child = spawn(gitCommand, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...(signal ? { signal } : {}) });
    child.stdout.on('data', (chunk: Buffer | string) => { output = (output + chunk.toString()).slice(-16_384); });
    const consume = (stream: NodeJS.ReadableStream) => {
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => { pending += chunk; const lines = pending.split(/\r?\n/u); pending = lines.pop() ?? ''; for (const line of lines) if (line.trim()) onLine(line.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '')); });
      stream.on('end', () => { if (pending.trim()) onLine(pending.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/gu, '')); });
    };
    consume(child.stdout); consume(child.stderr);
    child.once('error', (error) => reject(signal?.aborted ? canceled() : new RuntimeError('git_failed', `Could not start git: ${error.message}`)));
    child.once('close', (code) => code === 0 ? resolvePromise(output) : reject(signal?.aborted ? canceled() : new RuntimeError('git_failed', `git command exited with code ${code ?? 'unknown'}`)));
  });
}

export async function extractZipSafely(zipPath: string, destination: string, onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<void> {
  const entries = await readZipDirectory(zipPath);
  const files = entries.filter((entry) => !entry.directory);
  const topLevels = new Set(files.map((entry) => entry.name.split('/')[0]).filter((value): value is string => Boolean(value)));
  const stripRoot = topLevels.size === 1 && files.every((entry) => entry.name.split('/').length > 1) ? [...topLevels][0] : null;
  const written = new Set<string>();
  let completed = 0;
  for (const entry of entries) {
    throwIfCanceled(signal);
    if (entry.directory) continue;
    if (entry.symlink) throw new RuntimeError('unsafe_archive', `Symlink entry is not allowed: ${entry.name}`);
    validateArchiveEntryName(entry.name);
    const relativeName = stripRoot && entry.name.startsWith(`${stripRoot}/`) ? entry.name.slice(stripRoot.length + 1) : entry.name;
    const target = safeArchivePath(destination, relativeName);
    if (written.has(target)) throw new RuntimeError('unsafe_archive', `Duplicate archive entry: ${entry.name}`);
    written.add(target);
    await mkdir(resolve(target, '..'), { recursive: true });
    await extractEntry(zipPath, entry, target);
    completed += 1;
    onProgress?.(files.length === 0 ? 1 : completed / files.length);
  }
}

async function readZipDirectory(zipPath: string): Promise<ZipEntry[]> {
  const details = await stat(zipPath);
  const tailLength = Math.min(details.size, 65_557);
  const handle = await open(zipPath, 'r');
  try {
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tail.length, details.size - tail.length);
    const eocdOffset = findSignature(tail, 0x06054b50);
    if (eocdOffset < 0) throw new RuntimeError('invalid_archive', 'The downloaded file is not a ZIP archive');
    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const directorySize = tail.readUInt32LE(eocdOffset + 12);
    const directoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (directorySize > MAX_ZIP_DIRECTORY_BYTES || entryCount === 0xffff || directoryOffset === 0xffffffff) throw new RuntimeError('archive_too_large', 'ZIP64 archives are not supported for SillyTavern installations');
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directory.length, directoryOffset);
    const entries: ZipEntry[] = [];
    let offset = 0;
    for (let index = 0; index < entryCount; index += 1) {
      if (directory.readUInt32LE(offset) !== 0x02014b50) throw new RuntimeError('invalid_archive', 'The ZIP central directory is corrupt');
      const flags = directory.readUInt16LE(offset + 8);
      const compression = directory.readUInt16LE(offset + 10);
      const compressedSize = directory.readUInt32LE(offset + 20);
      const uncompressedSize = directory.readUInt32LE(offset + 24);
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const localOffset = directory.readUInt32LE(offset + 42);
      const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength);
      const name = (flags & 0x800 ? nameBytes.toString('utf8') : nameBytes.toString('utf8')).replaceAll('\\', '/');
      const externalAttributes = directory.readUInt32LE(offset + 38);
      entries.push({ name, compressedSize, uncompressedSize, compression, localOffset, directory: name.endsWith('/') || (externalAttributes & 0x10) !== 0, symlink: (externalAttributes >>> 16 & 0xf000) === 0xa000 });
      offset += 46 + nameLength + extraLength + commentLength;
      if (offset > directory.length) throw new RuntimeError('invalid_archive', 'The ZIP central directory is corrupt');
    }
    return entries;
  } finally { await handle.close(); }
}

async function extractEntry(zipPath: string, entry: ZipEntry, target: string): Promise<void> {
  if (entry.compressedSize === 0) {
    if (entry.uncompressedSize !== 0 || entry.compression !== 0) throw new RuntimeError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
    await writeFile(target, Buffer.alloc(0), { mode: 0o600 });
    return;
  }
  const handle = await open(zipPath, 'r');
  let dataOffset: number;
  try {
    const local = Buffer.alloc(30);
    await handle.read(local, 0, local.length, entry.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) throw new RuntimeError('invalid_archive', 'The ZIP local header is corrupt');
    dataOffset = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally { await handle.close(); }
  const source = createReadStream(zipPath, { start: dataOffset, end: dataOffset + entry.compressedSize - 1 });
  const destination = createWriteStream(target, { mode: 0o600 });
  if (entry.compression === 0) await pipeline(source, destination);
  else if (entry.compression === 8) await pipeline(source, createInflateRaw(), destination);
  else throw new RuntimeError('unsupported_archive', `ZIP compression ${entry.compression} is not supported`);
  const details = await stat(target);
  if (details.size !== entry.uncompressedSize) throw new RuntimeError('invalid_archive', `Archive entry size mismatch: ${entry.name}`);
}

function safeArchivePath(root: string, entryName: string): string {
  if (entryName.includes('\0')) throw new RuntimeError('unsafe_archive', 'Archive contains a NUL byte');
  const normalized = entryName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) throw new RuntimeError('unsafe_archive', `Absolute archive path is not allowed: ${entryName}`);
  const pieces = normalized.split('/').filter((piece) => piece.length > 0 && piece !== '.');
  if (pieces.includes('..')) throw new RuntimeError('unsafe_archive', `Parent archive path is not allowed: ${entryName}`);
  const candidate = resolve(root, ...pieces);
  const rootResolved = resolve(root);
  const relativeCandidate = relative(rootResolved, candidate);
  if (relativeCandidate.startsWith('..') || relativeCandidate.split(sep).includes('..')) throw new RuntimeError('unsafe_archive', `Archive path escapes destination: ${entryName}`);
  return candidate;
}

function validateArchiveEntryName(entryName: string): void {
  const normalized = entryName.replaceAll('\\', '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..')) {
    throw new RuntimeError('unsafe_archive', `Unsafe archive path: ${entryName}`);
  }
}

function findSignature(buffer: Buffer, signature: number): number {
  for (let index = buffer.length - 4; index >= 0; index -= 1) if (buffer.readUInt32LE(index) === signature) return index;
  return -1;
}

function isReleasePayload(value: unknown): value is ReleasePayload { return isRecord(value); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function isFileNotFound(error: unknown): boolean { return isRecord(error) && error.code === 'ENOENT'; }

async function dependencyFingerprint(runtimePath: string): Promise<string> {
  const hash = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) {
    try {
      hash.update(name, 'utf8');
      hash.update(await readFile(join(runtimePath, name)));
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
    }
  }
  return hash.digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error: unknown) { return isFileNotFound(error) ? false : Promise.reject(error); }
}

export async function assertInstallationMarker(installation: Installation): Promise<void> {
  let marker: unknown;
  try { marker = JSON.parse(await readFile(installation.markerPath, 'utf8')); }
  catch { throw new RuntimeError('installation_marker_missing', 'The SillyTavern installation marker is missing'); }
  if (!isRecord(marker) || marker.installationId !== installation.id || marker.resolvedRef !== installation.resolvedRef || (installation.revision && marker.revision !== installation.revision)) throw new RuntimeError('installation_marker_mismatch', 'The runtime checkout does not match this installation');
}
