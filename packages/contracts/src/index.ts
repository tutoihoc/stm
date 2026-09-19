export * from './table-query.js';
export * from './table-fields.js';

export type PlatformKind = 'windows' | 'linux' | 'termux' | 'docker' | 'modelscope' | 'unknown';

/** The ports this project ships with, before anything moves them. */
export interface ManagerPorts {
  readonly manager: 7860;
  readonly sillyTavern: 8002;
  /** Where the guarded door to SillyTavern listens; see AccessGatewayState. */
  readonly access: 8001;
}

/**
 * The ports a running manager is actually using.
 *
 * `port` is SillyTavern's, which the console can move. The reserved pair is
 * fixed for the life of the process and comes back with it so the panel can
 * show what a rejected number collided with, and say where to change those two
 * instead - the environment, not this page.
 */
export interface PortSettings {
  readonly port: number;
  readonly reserved: {
    readonly manager: number;
    readonly access: number;
  };
}

export interface ManagerState {
  readonly schemaVersion: 1;
  readonly managerVersion: string;
  readonly installId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly adminConfigured: boolean;
  readonly setupAcceptedAt: string | null;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  readonly platform: PlatformKind;
  readonly storageRoot: string;
  readonly storageDurable: boolean;
}

export interface AdminSession {
  readonly expiresAt: string;
  readonly csrfToken: string;
}

export interface SetupStatus {
  readonly setupRequired: boolean;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  readonly notice: {
    readonly telemetry: string;
    readonly terms: string;
    readonly disclaimer: string;
  };
}

export interface HealthResponse {
  readonly status: 'ok';
  readonly manager: {
    readonly version: string;
    /** Where the console is actually listening, which `STM_PORT` can move. */
    readonly port: number;
  };
  readonly setupRequired: boolean;
  readonly uptimeSeconds: number;
  readonly storage: {
    readonly durable: boolean;
  };
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * What the manager does on its own way up, as opposed to what SillyTavern is
 * configured to do once it is running.
 *
 * Kept apart from ConfigSettings because those are written into the installed
 * runtime's own config.yaml and belong to the version installed. This belongs
 * to the manager and outlives every version it installs.
 */
export interface StartupSettings {
  /** Start SillyTavern when the manager starts. On unless it is turned off. */
  readonly autoStartSillyTavern: boolean;
}

export type VersionSelector = 'latest' | 'release' | 'staging' | (string & {});

export type VersionChannel = 'release' | 'staging';

export interface VersionOption {
  readonly selector: VersionSelector;
  readonly label: string;
  readonly ref: string;
  readonly channel: VersionChannel;
  readonly tag: string | null;
  readonly publishedAt: string | null;
}

export type InstallationStatus =
  | 'queued'
  | 'downloading'
  | 'extracting'
  | 'installing'
  | 'health_check'
  | 'ready'
  | 'failed';

export interface Installation {
  readonly id: string;
  readonly selector: VersionSelector;
  readonly resolvedRef: string;
  readonly revision?: string;
  readonly channel: VersionChannel;
  readonly runtimePath: string;
  readonly markerPath: string;
  readonly status: InstallationStatus;
  readonly progress: number;
  /** English step text; `stepCode` is what the panel shows when it has one. */
  readonly step: string;
  readonly stepCode?: string;
  readonly stepParams?: MessageParams;
  readonly error: string | null;
  /**
   * The manager's own code for that failure, when the manager is what failed.
   *
   * `error` is a sentence, and whose sentence it is varies: a refusal the
   * manager wrote, a line git printed, whatever npm said on its way out. The
   * panel translates the first kind and shows the other two as the program
   * that produced them wrote them - translating another project's output makes
   * it impossible to search for. A code is present only for the first kind.
   */
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export type ProfileLayout = 'data' | 'public';

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly installationId: string;
  readonly runtimePath: string;
  readonly configPath: string;
  readonly dataPath: string;
  readonly layout: ProfileLayout;
  /** Set when a legacy public/ tree was copied into the canonical data/ root. */
  readonly legacyLayout?: ProfileLayout | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly activatedAt: string | null;
}

export type RestoreMode = 'merge' | 'replace';

export type BackupSource = 'created' | 'uploaded';

/**
 * Why an archive exists, which is what a reader sorts a backup library by.
 *
 * `source` only said whether this machine wrote it, so a backup somebody took
 * on purpose, one the schedule took, and the safety copy a restore took were
 * the same row with different suffixes on their names.
 */
export type BackupKind = 'manual' | 'scheduled' | 'before-restore' | 'before-switch' | 'r2' | 'uploaded';

export const BACKUP_KINDS: readonly BackupKind[] = ['manual', 'scheduled', 'before-restore', 'before-switch', 'r2', 'uploaded'];

/**
 * The kind of an archive, including one written before kinds were recorded.
 *
 * Those are read off the suffix their name was given, which is all an older
 * library has; their names are left as they are.
 */
export function backupKind(backup: Pick<BackupManifest, 'kind' | 'name' | 'source'>): BackupKind {
  if (backup.kind) return backup.kind;
  const name = backup.name.replace(/\.zip$/u, '');
  if (/-r2-[^-]/u.test(name)) return 'r2';
  if (backup.source === 'uploaded') return 'uploaded';
  if (name.endsWith('-scheduled')) return 'scheduled';
  if (name.endsWith('-prerestore')) return 'before-restore';
  if (name.endsWith('-preswitch')) return 'before-switch';
  return 'manual';
}

/** The word a default name carries for each kind: short, lower case, no spaces. */
const KIND_SLUG: Record<Exclude<BackupKind, 'uploaded'>, string> = {
  manual: 'manual',
  scheduled: 'auto',
  'before-restore': 'before-restore',
  'before-switch': 'before-switch',
  r2: 'r2',
};

/**
 * A name for an archive nobody named: `Main_auto_2026-09-16_14-30.zip`.
 *
 * Profile, kind, then the date and time in the machine's own clock, so the
 * names sort by time within a kind, read at a glance, and survive as file
 * names on every system a download might land on. The older names ended in a
 * UTC timestamp or an opaque R2 id, which read as noise and sorted by neither.
 */
export function defaultBackupName(profileName: string, kind: Exclude<BackupKind, 'uploaded'>, at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  const time = `${pad(at.getHours())}-${pad(at.getMinutes())}`;
  return `${profileName}_${KIND_SLUG[kind]}_${date}_${time}.zip`;
}

export interface BackupManifest {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly profileId: string;
  readonly profileName: string;
  readonly layout: ProfileLayout;
  readonly sizeBytes: number;
  readonly checksumSha256: string;
  readonly fileCount: number;
  readonly source: BackupSource;
  /** Absent on archives written before kinds were recorded; see `backupKind`. */
  readonly kind?: BackupKind;
  /**
   * The manager chose the name, so the panel may show it in the reader's own
   * language instead. Gone once somebody renames it.
   */
  readonly autoNamed?: boolean;
  readonly fingerprint?: string;
}

/** A connection setting that can come from `.env` instead of the panel. */
export type R2EnvironmentField = 'endpoint' | 'bucket' | 'accessKeyId' | 'secretAccessKey';

/**
 * How often the manager takes a local backup of the active profile.
 *
 * It used to sit in the R2 settings, which made it look like part of R2 and
 * left anyone without a bucket unable to change it, though it ran for them all
 * the same. It is the backup library's setting, and lives there.
 */
export interface LocalBackupSchedule {
  /** Minutes between scheduled backups; `0` means the schedule is off. */
  readonly intervalMinutes: number;
}

/**
 * How the bucket was connected.
 *
 * `keys` is an endpoint, bucket and S3 key pair entered by hand or set in
 * `.env`, which stays available for anyone who does not want to sign in.
 * `cloudflare` is a bucket the manager set up after signing in to Cloudflare.
 */
export type R2ConnectionMode = 'keys' | 'cloudflare';

export type CloudflareConnectionState = 'disconnected' | 'choose_account' | 'connected' | 'reconnect_required';

/**
 * Something about the account itself that stands between it and a backup.
 *
 * `r2_not_enabled` is the one that actually happens: R2 is not part of a
 * Cloudflare account until somebody accepts its terms once in the dashboard,
 * and until they do, a sign-in that granted every permission asked for still
 * cannot make a bucket. Told apart from an ordinary failure because it is the
 * only one the reader fixes in a minute, on a page this can send them to.
 */
export type CloudflareAccountProblem = 'r2_not_enabled';

export interface CloudflareAccountRef {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareConnectionStatus {
  readonly state: CloudflareConnectionState;
  readonly account: CloudflareAccountRef | null;
  readonly bucket: string | null;
  /** Offered while the user has to pick which account backups go to. */
  readonly accounts: readonly CloudflareAccountRef[];
  /** Which way data went last, once anything has; null before the first transfer. */
  readonly dataPath: 'worker' | 'rest' | null;
  /** Why data goes over the slow REST API instead of the Worker, when it does. */
  readonly restReason: 'workers_not_granted' | 'worker_unavailable' | null;
  readonly analyticsGranted: boolean;
  readonly connectedAt: string | null;
  readonly lastError: string | null;
  /** Something about the account that has to be dealt with on Cloudflare, not here. */
  readonly problem: CloudflareAccountProblem | null;
}

/**
 * What the machine this manager is on does with what is written to it.
 *
 * A console running on somebody's own computer keeps its data because the disk
 * keeps it. A console running on a hosting platform may be on a filesystem that
 * belongs to the container rather than to the account: it is created when the
 * machine starts and thrown away when it stops, and hosts that stop a machine
 * after an idle period stop it with everything in it. The console cannot make
 * that storage durable. What it can do is say so, and offer the one thing that
 * fixes it - a copy somewhere that is not this machine.
 */
export interface StorageDurabilityReport {
  /** Whether what is written here survives this machine being restarted. */
  readonly durable: boolean;
  /** What the data directory is on, when that is what decided it. */
  readonly filesystem: string | null;
}

export interface R2Config {
  readonly mode: R2ConnectionMode;
  /** Null when this manager has no Cloudflare OAuth client configured. */
  readonly cloudflare: CloudflareConnectionStatus | null;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  /** Set in `.env`, so the panel shows them and cannot change them. */
  readonly environmentFields: readonly R2EnvironmentField[];
  readonly configured: boolean;
  readonly lastUploadAt: string | null;
  readonly accessKeyIdMasked: string | null;
  readonly secretAccessKeyConfigured: boolean;
  readonly schedule: {
    /**
     * How often the small, precious part of the profile is sent: chats,
     * settings, worlds and character cards. Only changed chunks go, so this can
     * be minutes rather than a day.
     */
    readonly hotIntervalMinutes: number;
    /** How often everything else goes - images and attachments, large and rarely touched. */
    readonly coldIntervalHours: number;
    /** How often a listing replaces what the manager believes the bucket holds. */
    readonly reconcileIntervalHours: number;
  };
  /**
   * How many recovery points survive, oldest thinned first.
   *
   * Snapshots share every chunk they have in common, so keeping more of them
   * costs the changes between them rather than a copy each.
   */
  readonly retention: {
    readonly keepRecent: number;
    readonly keepDaily: number;
    readonly keepWeekly: number;
  };
  /** What the manager refuses to exceed, so a free account stays a free account. */
  readonly limits: {
    readonly maxStorageBytes: number;
    readonly maxWriteOperations: number;
    /**
     * Reads are reported against this but never refused because of it.
     *
     * The reads are a restore. Refusing to give someone their data back to
     * avoid a small bill is the wrong trade, and the ceiling that would do it
     * is worse than the bill.
     */
    readonly maxReadOperations: number;
  };
  readonly usage: R2Usage;
  readonly lastFingerprint: string | null;
  /**
   * The recovery point the manager brought back on its own, if it ever did.
   *
   * A machine that does not keep its disk restores itself on the way up, before
   * anybody opens the console. That is the whole point of putting the bucket in
   * `.env` - but done silently it is indistinguishable from a machine that
   * happened to still have the data, and the reader has no way to tell whether
   * what they are looking at is yesterday's work or a fresh installation that
   * looks like it. So it is written down and said.
   */
  readonly lastRecovery: {
    readonly at: string;
    /** When the point that came back was taken. */
    readonly createdAt: string;
    readonly fileCount: number;
    /**
     * How much came back, which is what the card says.
     *
     * A file count answers a question nobody asked: 790 files is not a size,
     * not a duration, and not something a reader can weigh against what they
     * remember having. Absent on a recovery recorded before this was kept.
     */
    readonly sizeBytes?: number;
  } | null;
}

export interface R2OperationCounts {
  readonly classA: number;
  readonly classB: number;
  readonly free: number;
  /** Action types Cloudflare's pricing page does not list. Shown, not guessed into a class. */
  readonly unclassified: number;
}

export interface R2UsageScope {
  /** Object data plus metadata at the latest sample; null when Cloudflare had none. */
  readonly storageBytes: number | null;
  readonly objectCount: number | null;
  readonly measuredAt: string | null;
  /** Month to date, from the start of the calendar month in UTC. */
  readonly operations: R2OperationCounts;
}

export interface R2UsageWarning {
  /**
   * `account` is measured against Cloudflare's free tier, which the whole
   * account shares; `bucket` against the ceilings set in the manager.
   */
  readonly scope: 'account' | 'bucket';
  readonly metric: 'storage' | 'classA' | 'classB';
  readonly used: number;
  readonly limit: number;
}

/**
 * What Cloudflare's analytics say a signed-in bucket and its account used.
 *
 * Usage, not billing. There is no API for the bill or for what is left of the
 * free tier; a billing period need not start on the first of the month; storage
 * is billed as an average over the month while this is the size now; and the
 * figures lag by some minutes. Warnings are early signs, not a statement of cost.
 */
export interface R2CloudflareUsage {
  readonly fetchedAt: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly bucket: R2UsageScope & { readonly name: string };
  readonly account: R2UsageScope;
  readonly freeTier: { readonly storageBytes: number; readonly classA: number; readonly classB: number };
  readonly warnings: readonly R2UsageWarning[];
}

export interface R2UsageResponse {
  readonly usage: R2CloudflareUsage | null;
  /** Why there are no figures from Cloudflare, when there are none. */
  readonly unavailable: 'keys_mode' | 'not_connected' | 'analytics_not_granted' | 'query_failed' | null;
  readonly error: string | null;
}

export interface R2Usage {
  readonly storageBytes: number;
  readonly blobCount: number;
  readonly snapshotCount: number;
  /** Charged writes and listings this calendar month, counted locally. */
  readonly writeOperations: number;
  /** Charged reads this calendar month. A restore is roughly one per file. */
  readonly readOperations: number;
  readonly periodStartedAt: string;
  /** Archives left in the bucket by the version that uploaded whole ZIP files. */
  readonly legacyObjectCount: number;
  readonly legacyBytes: number;
  readonly lastReconciledAt: string | null;
}

/**
 * A size in the units the thing being measured is actually sold in.
 *
 * Cloudflare quotes a bucket in GB and gives away 10 of them, decimal, and
 * network rates are decimal everywhere. Dividing by 1024 and writing "GB"
 * understates a bucket by seven percent - enough that the panel and the
 * Cloudflare dashboard disagreed about the same bucket and neither looked
 * wrong. One function, so they cannot disagree again.
 */
export function formatBytes(value: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1000 && unit < units.length - 1) { size /= 1000; unit += 1; }
  return `${unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

/**
 * How far a transfer has got, in bytes as well as in things.
 *
 * A count of files says nothing about how long is left when the files are a
 * settings file and a twenty megabyte character card. Bytes are what the wait
 * is actually made of.
 */
export interface TransferProgress {
  readonly completedBytes: number;
  readonly totalBytes: number;
  readonly completedItems: number;
  readonly totalItems: number;
}

/** One recovery point in the bucket, as a listing can describe it without reading it. */
export interface R2SnapshotSummary {
  readonly id: string;
  readonly profileId: string;
  readonly createdAt: string;
  /** The index object alone, which is not what bringing the point back costs. */
  readonly indexBytes: number;
  /** Files the point names, or null for a point written before this was recorded. */
  readonly fileCount: number | null;
  /** The data those files hold: what bringing the point back downloads. */
  readonly dataBytes: number | null;
}

/**
 * What one look at the bucket found, so the answer can be shown rather than flashed.
 *
 * The panel used to offer three buttons that all did some of this - "Test
 * connection", "Check the bucket", "Refresh" - and each answered with a toast
 * that said it had worked and then went away. Three buttons, one question, and
 * no lasting answer to it. This is the one question: is the bucket reachable,
 * and what is in it. Its answer stays on the card.
 *
 * `failure` rides inside a successful response on purpose: an unreachable
 * bucket is a finding, not a broken request, and it belongs on the card beside
 * the figures it replaces.
 */
export interface R2CheckResult {
  readonly ok: boolean;
  readonly checkedAt: string;
  /** The bucket that answered, named as the reader knows it. */
  readonly bucket: string | null;
  readonly objectCount: number;
  readonly totalBytes: number;
  readonly snapshotCount: number;
  /** Archives left by the version that uploaded whole ZIP files, which nothing reads. */
  readonly legacyObjectCount: number;
  readonly legacyBytes: number;
  /** The manager's own counters, brought back in line with what was listed. */
  readonly usage: R2Usage | null;
  readonly failure: { readonly code: string; readonly message: string } | null;
}

export interface R2Object {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified: string | null;
  readonly etag: string | null;
}

export interface BackupFilePreview {
  readonly name: string;
  readonly sizeBytes: number;
}

export interface RestorePreview {
  readonly layout: ProfileLayout;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly files: readonly BackupFilePreview[];
  /**
   * What is worth knowing before restoring, as catalogued events.
   *
   * These were English sentences written by the server and printed into the
   * restore dialog exactly as they arrived, so a reader who had the rest of
   * the console in Vietnamese met one paragraph of English at the one moment
   * that cannot be undone.
   */
  readonly warnings: readonly LogEvent[];
}

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export type JobKind = 'installation' | 'backup' | 'restore';

export interface Job {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly progress: number;
  /** English step text; `stepCode` is what the panel shows when it has one. */
  readonly step: string;
  readonly stepCode?: string;
  readonly stepParams?: MessageParams;
  readonly installationId: string | null;
  /**
   * The archive a finished job produced, when it produced one.
   *
   * Set by fetching a recovery point out of R2: what arrives is an ordinary
   * backup, and the panel opens the same restore question over it that an
   * uploaded zip gets. Without this the panel would have to guess which of the
   * archives in the library was the one it just asked for.
   */
  readonly resultBackupId?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly error: string | null;
}

/** Values substituted into a translated log line or progress step. */
export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * A line the manager wrote itself, carrying both its English text and the
 * catalog key the panel translates it with.
 *
 * Output produced by another program - SillyTavern, cloudflared, npm, git - is
 * passed through as a plain string and shown exactly as it was written. Only
 * what this project authors is translated.
 */
export interface LogEvent {
  readonly code: string;
  readonly message: string;
  readonly params?: MessageParams;
}

export type LogLine = string | LogEvent;

/** Where a component sends its output; the manager decides what to do with it. */
export type LogSink = (line: LogLine) => void;

export function logEvent(code: string, message: string, params?: MessageParams): LogEvent {
  return params === undefined ? { code, message } : { code, message, params };
}

export function isLogEvent(line: LogLine): line is LogEvent {
  return typeof line === 'object' && line !== null;
}

export function logLineText(line: LogLine): string {
  return isLogEvent(line) ? line.message : line;
}

export interface LogEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly source: 'manager' | 'sillytavern' | 'cloudflared' | 'installer' | 'backup';
  readonly level: 'info' | 'warn' | 'error';
  /** English rendering. Always present, and what the durable log file keeps. */
  readonly message: string;
  /** Catalog key under `logs.`, absent for third-party output. */
  readonly code?: string;
  readonly params?: MessageParams;
}

export type LogSourceFilter = LogEntry['source'] | 'all';

export type ProcessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

export interface ProcessState {
  readonly status: ProcessStatus;
  readonly installationId: string | null;
  readonly profileId: string | null;
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly error: string | null;
  /** Set when the manager is what failed; see `Installation.errorCode`. */
  readonly errorCode?: string;
  /**
   * What a start or a stop is doing right now, as a `logs.process.*` code.
   *
   * Read off SillyTavern's own output while it starts - compiling the
   * frontend, loading plugins, opening the port - so the console can say
   * which of those it is waiting on instead of one sentence for all of them.
   * Only present while the state is `starting` or `stopping`.
   */
  readonly stepCode?: string;
  readonly stepParams?: MessageParams;
}

/**
 * Why the manager asked a process it owns to stop.
 *
 * A stop looks identical from the outside whether the operator pressed Stop,
 * a restore needed the data held still, or a different version was being
 * installed - the exit code is null in every one of those cases. Recording the
 * reason at the point the stop is requested is the only place that knows.
 */
export type StopReason =
  | 'requested'
  | 'restart'
  | 'install'
  | 'uninstall'
  | 'restore'
  | 'profileSwitch'
  | 'configChange'
  | 'passwordChange'
  | 'shutdown'
  | 'startupFailed';

export const STOP_REASON_TEXT: Readonly<Record<StopReason, string>> = {
  requested: 'you asked it to stop',
  restart: 'restarting it',
  install: 'installing a different SillyTavern version',
  uninstall: 'removing SillyTavern',
  restore: 'restoring a backup',
  profileSwitch: 'switching profile',
  configChange: 'applying a configuration change',
  passwordChange: 'applying the new SillyTavern password',
  shutdown: 'the manager is shutting down',
  startupFailed: 'it did not finish starting',
};

/** The catalog key for a stop reason, for example `stoppedRequested`. */
export function stopReasonCode(reason: StopReason): string {
  return `stopped${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
}

/** How a process that nobody asked to stop went away. */
export function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `signal ${signal}`;
  return code === null ? 'no exit code' : `exit code ${code}`;
}

export type TunnelMode = 'off' | 'quick' | 'named';
export type TunnelStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface TunnelState {
  readonly mode: TunnelMode;
  readonly status: TunnelStatus;
  readonly url: string | null;
  readonly startedAt: string | null;
  readonly error: string | null;
  /**
   * A fixed address in front of this tunnel, when there is one.
   *
   * A Quick Tunnel's own address is random and is a different one every time
   * cloudflared starts, so it cannot be the address anybody keeps: a bookmark
   * from yesterday answers `DNS_PROBE_FINISHED_NXDOMAIN`, because the hostname
   * has gone from DNS rather than merely stopped answering. Given a Cloudflare
   * sign-in, the manager puts a Worker on the account's own `workers.dev`
   * subdomain and redeploys it at each new tunnel, so this address stays the
   * same. It is the one to show and the one to share; `url` above is still the
   * truth about where the traffic actually goes, and is worth showing beside it.
   *
   * Absent where nothing decorates the state - the tunnel manager itself does
   * not know about any of this - and null when no Worker is deployed.
   */
  readonly proxyUrl?: string | null;
}

/**
 * What SillyTavern's configuration says, and the part of it worth offering.
 *
 * The first group is reported and never written: the manager owns those, and
 * the console shows them so it is clear why they cannot be moved. SillyTavern
 * stays on the loopback address behind the access gateway, on port 8000, with
 * its own two password mechanisms off because the gateway replaces both.
 *
 * The second group is what somebody running SillyTavern actually reaches for.
 * They are not the settings this page used to offer - HTTPS, the CORS proxy
 * and switching CSRF protection off. Under the manager the first of those
 * breaks the gateway, which speaks plain HTTP to the loopback address and is
 * behind Cloudflare's TLS already; the last has nothing to gain and a name
 * that ends in "NOT RECOMMENDED" in SillyTavern's own file. Anyone who really
 * wants one of them still has config.yaml.
 */
export interface ConfigSettings {
  readonly listen: boolean;
  readonly listenAddress: {
    readonly ipv4: string;
    readonly ipv6: string;
  };
  readonly whitelistMode: boolean;
  readonly port: number;
  readonly enableUserAccounts: boolean;
  readonly basicAuthMode: boolean;
  readonly sslEnabled: boolean;
  readonly enableCorsProxy: boolean;
  readonly disableCsrfProtection: boolean;
  /** Parse character cards on demand rather than all at once. */
  readonly lazyLoadCharacters: boolean;
  /** Keep parsed cards on disk between runs. */
  readonly useDiskCache: boolean;
  /** How much memory parsed cards may use, as SillyTavern writes it: `100mb`. */
  readonly memoryCacheCapacity: string;
  /** Compress large uploads - the one that matters over a tunnel. */
  readonly requestCompression: boolean;
  readonly extensions: boolean;
  readonly extensionAutoUpdate: boolean;
  /** Whether a stored provider key can be read back out of SillyTavern. */
  readonly allowKeysExposure: boolean;
  /** SillyTavern's own per-chat backups, which the manager then backs up too. */
  readonly chatBackups: boolean;
  readonly chatBackupCount: number;
}

/** The settings the console may write. Everything else is read-only or YAML. */
export type ConfigSettingsInput = Partial<Pick<ConfigSettings,
  | 'lazyLoadCharacters'
  | 'useDiskCache'
  | 'memoryCacheCapacity'
  | 'requestCompression'
  | 'extensions'
  | 'extensionAutoUpdate'
  | 'allowKeysExposure'
  | 'chatBackups'
  | 'chatBackupCount'
>>;

export interface ConfigDocument {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly runtimeRef: string;
  readonly runtimeRevision?: string;
  readonly path: string;
  readonly format: 'yaml' | 'yml';
  /** First non-loopback IPv4 address found on the manager host, for LAN setup. */
  readonly networkHost?: string;
  /** YAML retains Basic Auth keys; any custom Basic Auth password is masked. */
  readonly rawYaml: string;
  readonly settings: ConfigSettings;
  readonly restartRequired: boolean;
}

export interface ConfigUpdateInput {
  readonly rawYaml?: string;
  readonly settings?: ConfigSettingsInput;
}

export type AccessGatewayStatus = 'stopped' | 'running' | 'error';

/**
 * The guarded door in front of SillyTavern.
 *
 * SillyTavern stays bound to the loopback address on every version, and this is
 * the listener that anything else reaches: it asks for a password once, keeps a
 * session, and passes the rest through. It replaces both of the mechanisms
 * SillyTavern itself offers - Basic Auth, a browser dialog with no way to sign
 * out and nothing the manager can present, and user accounts, which only exist
 * from 1.12 on and so left every older version with no password at all.
 */
export interface AccessGatewayState {
  readonly status: AccessGatewayStatus;
  /** The bound address, or null while it is not listening. */
  readonly host: string | null;
  readonly port: number;
  /** Whether it is reachable from the local network rather than this machine. */
  readonly lan: boolean;
  readonly passwordConfigured: boolean;
  /**
   * Whether that credential is a six-digit passcode rather than a password.
   *
   * The public sign-in page needs to know which of the two to ask for, and it
   * only ever sees the hash. A door set up before passcodes existed keeps the
   * field it was set up with rather than locking its owner out.
   */
  readonly passcode: boolean;
  /**
   * How many browsers hold a session through this door right now.
   *
   * The settings page offers to end all of them at once, and a count is what
   * makes that offer mean something: it is the difference between "sign out
   * every device" and "sign out the three devices that are signed in".
   */
  readonly sessions: number;
  readonly error: string | null;
}

/** The complete allowlist written by the SillyTavern fetch instrumentation. */
export interface UsageEvent {
  readonly schemaVersion: 1;
  readonly timestamp: string;
  readonly provider: string;
  /** The completion API format observed on the route (for example google or openai). */
  readonly completionSource?: string | null;
  readonly model: string | null;
  readonly endpointHost: string | null;
  readonly stream: boolean;
  readonly maxTokens: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly reasoningTokens?: number | null;
  readonly status: number | null;
  readonly durationMs: number;
}

export interface MetricsTotals {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reasoningTokens: number;
  /** Input tokens covered by a provider's cache accounting. */
  readonly cacheEligibleInputTokens: number;
  /** Requests that returned cache read/write metadata. */
  readonly cacheObservedRequests: number;
  /** cacheReadTokens / cacheEligibleInputTokens, or null when unavailable. */
  readonly cacheHitRate: number | null;
  readonly streamRequests: number;
  readonly errors: number;
  readonly errorRate: number;
  readonly averageLatencyMs: number;
}

export interface MetricsBucket extends MetricsTotals {
  readonly key: string;
  readonly provider?: string;
  readonly model?: string;
  readonly completionSource?: string | null;
}

/** Host readings for the status panel. Null means the platform would not answer. */
export interface SystemSnapshot {
  readonly generatedAt: string;
  readonly cpu: {
    readonly cores: number;
    /** Share of CPU time out of idle since the previous reading. */
    readonly usagePercent: number | null;
  };
  readonly memory: {
    readonly totalBytes: number;
    readonly freeBytes: number;
    readonly usedBytes: number;
  };
  readonly storage: {
    readonly root: string;
    readonly totalBytes: number | null;
    readonly freeBytes: number | null;
    /** Everything the manager keeps, archives and profiles included. */
    readonly managerBytes: number | null;
    /** The active profile's user data, which is what SillyTavern reads. */
    readonly dataBytes: number | null;
    readonly dataFileCount: number | null;
    /** When the directory sizes were last walked, or null before the first walk. */
    readonly measuredAt: string | null;
    /** True while a walk is in flight, so the panel can say so. */
    readonly measuring: boolean;
  };
}

export interface MetricsSnapshot {
  readonly generatedAt: string;
  readonly range: { readonly from: string; readonly to: string };
  readonly totals: MetricsTotals;
  readonly daily: readonly MetricsBucket[];
  readonly providers: readonly MetricsBucket[];
  readonly models: readonly MetricsBucket[];
}

/** A privacy-filtered batch queued for the future telemetry endpoint. */
export interface TelemetryBatch {
  readonly schemaVersion: 1;
  readonly installId: string;
  readonly appVersion: string;
  readonly platform: PlatformKind;
  readonly sentAt: string;
  readonly events: readonly UsageEvent[];
}

/** Transport envelope signed by the installation-specific telemetry key. */
export interface TelemetryEnvelope {
  readonly schemaVersion: 1;
  readonly installId: string;
  readonly sentAt: string;
  readonly nonce: string;
  readonly signature: string;
  readonly batch: TelemetryBatch;
}
