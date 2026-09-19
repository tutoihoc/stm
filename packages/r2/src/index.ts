import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, logEvent, logLineText, type LogSink, type Profile, type R2CheckResult, type R2CloudflareUsage, type R2Config, type R2ConnectionMode, type R2UsageResponse, type R2UsageWarning, type R2EnvironmentField, type R2Object, type R2SnapshotSummary, type R2Usage, type TransferProgress } from '../../contracts/src/index.js';
import { parseS3Endpoint, R2_FREE_TIER, readR2Usage } from '../../cloudflare/src/index.js';
import { ioConcurrency, runPooled } from '../../platform/src/index.js';
import type { PlatformPaths } from '../../platform/src/index.js';
import type { CloudflareConnection, KnownBucket } from './cloudflare-connection.js';
import { BlobLedger } from './ledger.js';
import { S3ObjectStore, type R2Credentials } from './s3.js';
import { R2Error, type Billing, type ObjectRecord, type ObjectStore } from './store.js';
import {
  blobKey,
  decodeBlob,
  decodeSnapshot,
  encodeBlob,
  encodeSnapshot,
  referencedHashes,
  shouldCompress,
  snapshotKey,
  type FileChunk,
  type HashedFile,
  type R2Snapshot,
} from './sync.js';

export { R2Error } from './store.js';
export type { ObjectRecord, ObjectStore } from './store.js';
export { CloudflareConnection } from './cloudflare-connection.js';
export type { KnownBucket } from './cloudflare-connection.js';

const R2_STATE_FILE = 'r2-config.json';
/** The connection settings `.env` may provide, and the variable for each. */
const ENVIRONMENT_FIELDS: ReadonlyArray<{ readonly field: R2EnvironmentField; readonly variable: string }> = [
  { field: 'endpoint', variable: 'STM_R2_ENDPOINT' },
  { field: 'bucket', variable: 'STM_R2_BUCKET' },
  { field: 'accessKeyId', variable: 'STM_R2_ACCESS_KEY_ID' },
  { field: 'secretAccessKey', variable: 'STM_R2_SECRET_ACCESS_KEY' },
];
const R2_LEDGER_FILE = 'r2-blobs.log';
const R2_SCHEMA_VERSION = 2 as const;
const MASKED_SECRET = '********';
const OBJECT_PREFIX = 'sillytavern-manager/';
const BLOB_PREFIX = `${OBJECT_PREFIX}blobs/`;
const SNAPSHOT_PREFIX = `${OBJECT_PREFIX}snapshots/`;
/** How long Cloudflare's usage figures are reused before asking again. */
const CLOUD_USAGE_TTL_MS = 15 * 60 * 1000;
/** How old those figures may be and still count towards the ceilings before a backup. */
const CLOUD_USAGE_GUARD_MAX_AGE_MS = 60 * 60 * 1000;
/** A figure this close to its limit is worth saying something about. */
const WARNING_RATIO = 0.8;
/** One listing page. R2 caps it here too, so asking for more changes nothing. */
const LIST_PAGE_KEYS = 1000;

/**
 * Defaults chosen against what Cloudflare gives away: 10 GB of storage and a
 * million charged writes a month.
 *
 * Storage is the binding constraint, not operations. Sending only changed
 * chunks means a five-minute schedule costs a handful of small writes per run
 * and nothing at all when nothing changed, so the interval is set by how much
 * work is acceptable to lose rather than by what the quota can bear.
 */
const DEFAULTS = {
  hotIntervalMinutes: 5,
  coldIntervalHours: 6,
  reconcileIntervalHours: 24,
  // Thirty days back: the newest day closely, then one point a day. The panel
  // offers retention as a few plain choices rather than three numbers, so the
  // default has to be one of those choices.
  keepRecent: 24,
  keepDaily: 30,
  keepWeekly: 0,
  // Four fifths of what Cloudflare gives away, in the same decimal units it
  // quotes: 10 GB of storage, a million charged writes, ten million reads.
  maxStorageBytes: 8_000_000_000,
  maxWriteOperations: 800_000,
  maxReadOperations: 8_000_000,
} as const;

interface StoredUsage {
  readonly storageBytes: number;
  readonly blobCount: number;
  readonly snapshotCount: number;
  readonly writeOperations: number;
  readonly readOperations: number;
  readonly periodStartedAt: string;
  readonly legacyObjectCount: number;
  readonly legacyBytes: number;
  readonly lastReconciledAt: string | null;
}

interface StoredR2Config {
  readonly schemaVersion: 2;
  readonly mode: R2ConnectionMode;
  /**
   * Which bucket the chunk ledger describes.
   *
   * The ledger is what lets a backup skip chunks the bucket already holds. Kept
   * across a switch to another bucket, it would skip chunks the new bucket has
   * never seen, and every recovery point written there would point at nothing.
   */
  readonly ledgerTarget: string | null;
  readonly enabled: boolean;
  readonly endpoint: string | null;
  readonly bucket: string | null;
  readonly accessKeyId: string | null;
  readonly secretAccessKey: string | null;
  readonly hotIntervalMinutes: number;
  readonly coldIntervalHours: number;
  readonly reconcileIntervalHours: number;
  readonly keepRecent: number;
  readonly keepDaily: number;
  readonly keepWeekly: number;
  readonly maxStorageBytes: number;
  readonly maxWriteOperations: number;
  readonly maxReadOperations: number;
  readonly lastUploadAt: string | null;
  /** The cold tier runs on its own clock, so it is remembered separately. */
  readonly lastColdUploadAt: string | null;
  readonly lastFingerprint: string | null;
  /**
   * The newest recovery point this manager wrote, so the next run does not have
   * to list the bucket to find it.
   *
   * A listing is a charged operation and the frequent run makes one every few
   * minutes for an answer it already knew. It is a cache like the chunk ledger:
   * if it names something the bucket no longer has, the listing is still there
   * to fall back on.
   */
  readonly lastSnapshot: { readonly profileId: string; readonly id: string } | null;
  /** What the manager restored by itself on the way up; see R2Config.lastRecovery. */
  readonly lastRecovery: { readonly at: string; readonly createdAt: string; readonly fileCount: number; readonly sizeBytes?: number } | null;
  readonly usage: StoredUsage;
}

export interface R2ManagerOptions {
  readonly paths: PlatformPaths;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly logger?: LogSink;
  readonly fetchImpl?: typeof fetch;
  /** The signed-in connection, when this manager has a Cloudflare OAuth client. */
  readonly cloudflare?: CloudflareConnection;
}

export interface R2UpdateInput {
  readonly mode?: R2ConnectionMode;
  readonly enabled?: boolean;
  readonly endpoint?: string | null;
  readonly bucket?: string | null;
  readonly accessKeyId?: string | null;
  readonly secretAccessKey?: string | null;
  readonly hotIntervalMinutes?: number;
  readonly coldIntervalHours?: number;
  readonly reconcileIntervalHours?: number;
  readonly keepRecent?: number;
  readonly keepDaily?: number;
  readonly keepWeekly?: number;
  readonly maxStorageBytes?: number;
  readonly maxWriteOperations?: number;
  readonly maxReadOperations?: number;
}

/** One file to consider sending, and where its bytes are on this machine. */
export interface SyncSource {
  readonly file: HashedFile;
  readonly path: string;
}

export interface R2SyncInput {
  readonly profile: Profile;
  /** The files walked and hashed this run. */
  readonly sources: readonly SyncSource[];
  /**
   * Files this run did not look at, taken from the previous snapshot unchanged.
   *
   * This is what lets the frequent run touch only chats and settings while every
   * snapshot it writes is still a complete recovery point: the parts it skipped
   * are already in the bucket, so naming them costs nothing.
   */
  readonly carried?: readonly HashedFile[];
  readonly fingerprint: string;
  readonly tier?: 'hot' | 'cold';
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

export interface R2SyncResult {
  readonly snapshot: R2SnapshotSummary;
  readonly fileCount: number;
  readonly uploadedChunks: number;
  readonly uploadedBytes: number;
  readonly reusedChunks: number;
  readonly usage: R2Usage;
}

export interface R2ReconcileResult {
  readonly blobCount: number;
  readonly collectedBlobs: number;
  readonly collectedBytes: number;
  readonly usage: R2Usage;
}

export class R2Manager {
  readonly paths: PlatformPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly logger: LogSink;
  private readonly fetchImpl: typeof fetch;
  private readonly ledger: BlobLedger;
  private readonly cloudflare: CloudflareConnection | null;
  private configState: StoredR2Config | null = null;
  /** The local backup interval an older version kept in this file, until it is handed over. */
  private legacyLocalInterval: number | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Held for a sync or a reconcile, never both.
   *
   * Collecting unreferenced chunks reads the snapshots to decide what is still
   * wanted. A sync running beside it has uploaded chunks whose snapshot is not
   * written yet, and those would look exactly like garbage.
   */
  private busy: Promise<unknown> = Promise.resolve();
  /**
   * Charged requests made since they were last written down.
   *
   * The count used to live on the client, and every method that made its own
   * client threw its count away with it - which is how listing the bucket, the
   * most expensive thing the panel did, counted as nothing at all. It belongs
   * to the manager, because the manager is what outlives a request.
   */
  private charges = { write: 0, read: 0 };
  private cloudUsage: { readonly at: number; readonly usage: R2CloudflareUsage } | null = null;
  private chargesWrittenAt = 0;

  public constructor(options: R2ManagerOptions) {
    this.paths = options.paths;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? ((line) => console.log(logLineText(line)));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.ledger = new BlobLedger({ path: join(this.paths.state, R2_LEDGER_FILE) });
    this.cloudflare = options.cloudflare ?? null;
  }

  public async getConfig(): Promise<R2Config> {
    return await this.toPublic(await this.load());
  }

  public async update(requested: R2UpdateInput): Promise<R2Config> {
    const current = await this.load();
    // A connection field set in `.env` belongs to `.env`. The panel shows it
    // and cannot change it, so a stale form cannot quietly replace it either.
    const locked = new Set<string>(this.environmentFields());
    const input = Object.fromEntries(Object.entries(requested).filter(([key]) => !locked.has(key))) as R2UpdateInput;
    if (input.mode !== undefined && input.mode !== 'keys' && input.mode !== 'cloudflare') throw new R2Error('invalid_r2_mode', 'The R2 connection mode is not valid');
    if (input.mode === 'cloudflare' && !this.cloudflare) throw new R2Error('cloudflare_not_available', 'This manager has no Cloudflare sign-in configured');
    const next: StoredR2Config = {
      ...current,
      ...(input.mode !== undefined ? { mode: input.mode } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.endpoint !== undefined ? { endpoint: normalizeNullable(input.endpoint) } : {}),
      ...(input.bucket !== undefined ? { bucket: normalizeNullable(input.bucket) } : {}),
      ...(input.accessKeyId !== undefined ? { accessKeyId: preserveSecret(input.accessKeyId, current.accessKeyId) } : {}),
      ...(input.secretAccessKey !== undefined ? { secretAccessKey: preserveSecret(input.secretAccessKey, current.secretAccessKey) } : {}),
      ...(input.hotIntervalMinutes !== undefined ? { hotIntervalMinutes: integerInRange(input.hotIntervalMinutes, 1, 7 * 24 * 60, 'frequent upload interval') } : {}),
      ...(input.coldIntervalHours !== undefined ? { coldIntervalHours: integerInRange(input.coldIntervalHours, 1, 30 * 24, 'full upload interval') } : {}),
      ...(input.reconcileIntervalHours !== undefined ? { reconcileIntervalHours: integerInRange(input.reconcileIntervalHours, 1, 30 * 24, 'reconcile interval') } : {}),
      ...(input.keepRecent !== undefined ? { keepRecent: integerInRange(input.keepRecent, 1, 1000, 'recent retention') } : {}),
      ...(input.keepDaily !== undefined ? { keepDaily: integerInRange(input.keepDaily, 0, 365, 'daily retention') } : {}),
      ...(input.keepWeekly !== undefined ? { keepWeekly: integerInRange(input.keepWeekly, 0, 520, 'weekly retention') } : {}),
      ...(input.maxStorageBytes !== undefined ? { maxStorageBytes: integerInRange(input.maxStorageBytes, 1024 * 1024, 1024 ** 4, 'storage ceiling') } : {}),
      ...(input.maxWriteOperations !== undefined ? { maxWriteOperations: integerInRange(input.maxWriteOperations, 1000, 1_000_000_000, 'write ceiling') } : {}),
      ...(input.maxReadOperations !== undefined ? { maxReadOperations: integerInRange(input.maxReadOperations, 1000, 1_000_000_000, 'read ceiling') } : {}),
    };
    validateStoredConfig(next);
    await this.save(next);
    return await this.toPublic(next);
  }

  /**
   * The R2 bucket the S3 settings name, when they name one.
   *
   * Signing in to Cloudflare carries on in this bucket if it is in the account
   * signed in to, so switching to a sign-in keeps the recovery points in view.
   */
  public async keysBucket(): Promise<KnownBucket | null> {
    const config = await this.load();
    const parsed = config.endpoint && config.bucket ? parseS3Endpoint(config.endpoint) : null;
    return parsed && config.bucket ? { accountId: parsed.accountId, jurisdiction: parsed.jurisdiction, bucket: config.bucket } : null;
  }

  /**
   * Read the bucket once, and say what is in it.
   *
   * This is the one thing the panel asks when somebody wants to know whether
   * the connection works. It settles that by doing the thing a backup does -
   * listing the bucket - so a listing that comes back is proof rather than a
   * guess, and the counts it comes back with replace the ones the manager has
   * been keeping in its head since the last time it looked. That is what the
   * separate "Refresh" was for.
   *
   * What it does not do is delete anything. Collecting chunks no recovery point
   * names is a sweep that reads every index, runs on its own daily clock, and
   * has no business happening because somebody pressed Check.
   *
   * A bucket that cannot be reached is the answer, not an error: it comes back
   * in `failure` so the panel can show it where the figures would have been.
   */
  public async inspect(): Promise<R2CheckResult> {
    const checkedAt = this.now().toISOString();
    const bucket = await this.bucketName();
    try {
      const config = await this.requireUsable();
      const objects = await this.listAll(config, OBJECT_PREFIX);
      const found = summarizeObjects(objects);
      const previous = await this.currentPeriod(config);
      const usage: StoredUsage = {
        ...previous,
        storageBytes: found.totalBytes,
        blobCount: found.blobs.size,
        snapshotCount: found.snapshotKeys.length,
        legacyObjectCount: found.legacyObjectCount,
        legacyBytes: found.legacyBytes,
      };
      await this.save({ ...(await this.load()), usage });
      await this.recordCharges();
      this.logger(logEvent('r2.checked', `[r2] the bucket answered: ${objects.length} object(s), ${formatBytes(found.totalBytes)}, ${found.snapshotKeys.length} recovery point(s)`, { objects: objects.length, size: formatBytes(found.totalBytes), points: found.snapshotKeys.length }));
      return {
        ok: true,
        checkedAt,
        bucket,
        objectCount: objects.length,
        totalBytes: found.totalBytes,
        snapshotCount: found.snapshotKeys.length,
        legacyObjectCount: found.legacyObjectCount,
        legacyBytes: found.legacyBytes,
        usage: toPublicUsage(usage),
        failure: null,
      };
    } catch (error: unknown) {
      await this.recordCharges().catch(() => undefined);
      const code = error instanceof R2Error ? error.code : 'r2_check_failed';
      const message = error instanceof Error ? error.message : 'The bucket could not be read';
      this.logger(logEvent('r2.checkFailed', `[r2] the bucket could not be read: ${message}`, { reason: message }));
      return { ok: false, checkedAt, bucket, objectCount: 0, totalBytes: 0, snapshotCount: 0, legacyObjectCount: 0, legacyBytes: 0, usage: null, failure: { code, message } };
    }
  }

  /** What to call the bucket on screen, whichever way it is connected. */
  private async bucketName(): Promise<string | null> {
    const config = await this.load();
    if (config.mode === 'cloudflare') return (await this.cloudflare?.target())?.bucket ?? null;
    return config.bucket;
  }

  /**
   * Every object under the manager's prefix.
   *
   * One listing per thousand objects, each one charged, so this is for when
   * somebody asked to see the bucket - not for telling the panel how many
   * things are in it. The counts it keeps answer that for free.
   */
  public async listObjects(): Promise<R2Object[]> {
    const config = await this.load();
    try {
      return (await this.listAll(config, OBJECT_PREFIX)).map(toPublicObject);
    } finally {
      await this.recordCharges();
    }
  }

  /**
   * Send whatever of this profile the bucket does not already hold.
   *
   * Nothing is compared against the bucket during the run: the ledger says what
   * is already there, which is the difference between a handful of writes and
   * one per file. The snapshot naming every chunk is written last, so a run
   * killed halfway leaves chunks nothing points at - wasted space that the next
   * reconcile collects, never a recovery point with holes in it.
   */
  public async syncProfile(input: R2SyncInput): Promise<R2SyncResult> {
    return await this.exclusive(async () => {
      const config = await this.onTarget(await this.requireUsable());
      const usage = await this.currentPeriod(config);
      // Cloudflare sees what this manager's own count cannot: another machine
      // on the same bucket, or objects put there some other way. The larger of
      // the two is the one to hold the ceiling against.
      const cloud = config.mode === 'cloudflare' ? await this.recentCloudUsage() : null;
      const storageUsed = Math.max(usage.storageBytes, cloud?.bucket.storageBytes ?? 0);
      const writesUsed = Math.max(usage.writeOperations, cloud?.bucket.operations.classA ?? 0);
      if (storageUsed >= config.maxStorageBytes) {
        throw new R2Error('r2_storage_ceiling', `The bucket is holding ${formatBytes(storageUsed)}, at or above the ${formatBytes(config.maxStorageBytes)} ceiling. Lower retention or raise the ceiling.`);
      }
      if (writesUsed >= config.maxWriteOperations) {
        throw new R2Error('r2_operation_ceiling', `${writesUsed} charged writes have been used this month, at or above the ${config.maxWriteOperations} ceiling.`);
      }

      const planned = planUpload(input.sources, this.ledger);
      const client = this.client(config);
      let uploadedChunks = 0;
      let uploadedBytes = 0;
      let completed = 0;
      // What is left to send, which is the only number that says how long this
      // will take. A count of files cannot: one of them is a settings file and
      // the next is a twenty megabyte character card.
      let sentBytes = 0;
      const dropped = new Set<string>();
      const uploadedHashes: string[] = [];
      await runPooled(planned.files, ioConcurrency(), async (entry) => {
        throwIfStopped(input.signal);
        const sent = await this.uploadChunks(client, entry);
        if (sent === null) {
          // Gone since the walk. Naming it in the snapshot would point at a
          // chunk that was never stored, so the file leaves this recovery point.
          dropped.add(entry.source.file.name);
        } else {
          uploadedChunks += sent.hashes.length;
          uploadedBytes += sent.bytes;
          uploadedHashes.push(...sent.hashes);
        }
        completed += 1;
        // Measured as the data it holds rather than as what went over the wire,
        // so the total is known before the first byte is compressed.
        sentBytes += plannedBytes(entry);
        input.onProgress?.({ completedBytes: sentBytes, totalBytes: planned.bytes, completedItems: completed, totalItems: planned.files.length });
      });
      // Only after the bytes are in the bucket, and only once, so an interrupted
      // run never records a chunk it did not finish sending.
      await this.ledger.add(uploadedHashes);

      const files = mergeFiles(input.sources, input.carried ?? [], dropped);
      const createdAt = this.now().toISOString();
      const snapshot: R2Snapshot = {
        schemaVersion: 1,
        id: snapshotId(createdAt, files),
        createdAt,
        profileId: input.profile.id,
        profileName: input.profile.name,
        layout: input.profile.layout,
        fingerprint: input.fingerprint,
        files,
      };
      const body = await encodeSnapshot(snapshot);
      const key = snapshotKey(OBJECT_PREFIX, input.profile.id, snapshot.id);
      await client.putObject(key, body, 'application/gzip');

      const nextUsage: StoredUsage = {
        ...usage,
        storageBytes: usage.storageBytes + uploadedBytes + body.byteLength,
        blobCount: usage.blobCount + uploadedChunks,
        snapshotCount: usage.snapshotCount + 1,
      };
      await this.save({
        ...config,
        lastUploadAt: createdAt,
        ...(input.tier === 'cold' ? { lastColdUploadAt: createdAt } : {}),
        lastFingerprint: input.fingerprint,
        lastSnapshot: { profileId: input.profile.id, id: snapshot.id },
        usage: nextUsage,
      });
      await this.recordCharges();
      if (dropped.size > 0) this.logger(logEvent('r2.skippedMissingFiles', `[r2] skipped ${dropped.size} file(s) removed while the upload was running`, { count: dropped.size }));
      this.logger(logEvent('r2.synced', `[r2] sent ${uploadedChunks} changed chunk(s), ${formatBytes(uploadedBytes)}, of ${files.length} file(s)`, { chunks: uploadedChunks, bytes: formatBytes(uploadedBytes), files: files.length }));
      return {
        snapshot: {
          id: snapshot.id,
          profileId: snapshot.profileId,
          createdAt: snapshot.createdAt,
          indexBytes: body.byteLength,
          fileCount: files.length,
          dataBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
        },
        fileCount: files.length,
        uploadedChunks,
        uploadedBytes,
        reusedChunks: planned.reused,
        usage: toPublicUsage(nextUsage),
      };
    });
  }

  /** The recovery points in the bucket, newest first. */
  public async listSnapshots(profileId?: string): Promise<R2SnapshotSummary[]> {
    const config = await this.load();
    const prefix = profileId ? `${SNAPSHOT_PREFIX}${profileId}/` : SNAPSHOT_PREFIX;
    try {
      return (await this.listAll(config, prefix))
        .map((object) => toSnapshotSummary(object))
        .filter((summary): summary is R2SnapshotSummary => summary !== null)
        .sort((left, right) => right.id.localeCompare(left.id));
    } finally {
      await this.recordCharges();
    }
  }

  /**
   * The recovery point to compare this run against, without asking the bucket.
   *
   * Listing is a charged operation, and the frequent run would make one every
   * few minutes to be told what it wrote itself last time. The stored answer is
   * a cache: anything unexpected about it falls back to the listing, which is
   * still the truth.
   */
  public async latestSnapshot(profileId: string): Promise<R2Snapshot | null> {
    const config = await this.load();
    const remembered = config.lastSnapshot?.profileId === profileId ? config.lastSnapshot.id : null;
    if (remembered) {
      try {
        return await this.readSnapshot(profileId, remembered);
      } catch {
        // Pruned, or never landed. The listing below settles it.
      }
    }
    const listed = (await this.listSnapshots(profileId))[0];
    return listed ? await this.readSnapshot(profileId, listed.id) : null;
  }

  /**
   * Whether there are more recovery points than retention allows.
   *
   * Answered from the local count so that the listing thinning needs is made
   * only when there is something to thin, rather than after every upload.
   */
  public async pruneDue(): Promise<boolean> {
    const config = await this.load();
    return config.usage.snapshotCount > config.keepRecent + config.keepDaily + config.keepWeekly;
  }

  /** Read one recovery point, for showing what it holds or for restoring it. */
  public async readSnapshot(profileId: string, snapshotIdentifier: string): Promise<R2Snapshot> {
    const config = await this.load();
    try {
      return await decodeSnapshot(await this.client(config).getObject(snapshotKey(OBJECT_PREFIX, profileId, snapshotIdentifier)));
    } finally {
      await this.recordCharges();
    }
  }

  /** Fetch one stored chunk, already decoded back to the bytes it holds. */
  public async readBlob(hash: string): Promise<Buffer> {
    const config = await this.load();
    const blob = await decodeBlob(await this.client(config).getObject(blobKey(OBJECT_PREFIX, hash)));
    // A restore is one of these per file. Writing the counters down after each
    // one would be thousands of state writes for a figure nobody reads that
    // often, so they are folded in a few times a minute instead.
    await this.recordCharges({ atMostEvery: 5_000 });
    return blob;
  }

  /**
   * Thin the recovery points down to what retention asks for.
   *
   * Deleting the index is free and does not free any space on its own - the
   * chunks it named are still there, shared with every other snapshot that
   * wants them. Working out which ones nobody wants any more is the reconcile's
   * job, because it is the expensive half.
   */
  public async pruneSnapshots(profileId: string): Promise<R2SnapshotSummary[]> {
    return await this.exclusive(async () => {
      const config = await this.load();
      const snapshots = await this.listSnapshots(profileId);
      const keep = selectRetained(snapshots, config);
      const removed = snapshots.filter((snapshot) => !keep.has(snapshot.id));
      if (removed.length === 0) return [];
      const client = this.client(config);
      for (const snapshot of removed) await client.deleteObject(snapshotKey(OBJECT_PREFIX, profileId, snapshot.id));
      const usage = await this.currentPeriod(config);
      await this.save({
        ...config,
        usage: {
          ...usage,
          snapshotCount: Math.max(0, usage.snapshotCount - removed.length),
        },
      });
      await this.recordCharges();
      this.logger(logEvent('r2.pruned', `[r2] dropped ${removed.length} superseded recovery point(s)`, { count: removed.length }));
      return removed;
    });
  }

  /**
   * Make what the manager believes match what the bucket holds, and take back
   * the space nothing points at any more.
   *
   * This is the only operation that lists the whole store, and the only one
   * whose cost grows with how much is in it, which is why it runs on its own
   * slow clock rather than with every backup.
   */
  public async reconcile(): Promise<R2ReconcileResult> {
    return await this.exclusive(async () => {
      const config = await this.requireUsable();
      const client = this.client(config);
      const objects = await this.listAll(config, OBJECT_PREFIX, client);
      const { blobs, snapshotKeys, legacyObjectCount, legacyBytes } = summarizeObjects(objects);

      const snapshots: R2Snapshot[] = [];
      for (const key of snapshotKeys) {
        try {
          snapshots.push(await decodeSnapshot(await client.getObject(key)));
        } catch (error: unknown) {
          // One damaged index must not make every chunk look collectable.
          throw new R2Error('r2_unreadable_snapshot', `A recovery point could not be read, so nothing was collected: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
      const wanted = referencedHashes(snapshots);
      let collectedBlobs = 0;
      let collectedBytes = 0;
      const collected: string[] = [];
      for (const [hash, object] of blobs) {
        if (wanted.has(hash)) continue;
        await client.deleteObject(object.key);
        collected.push(hash);
        collectedBlobs += 1;
        collectedBytes += object.sizeBytes;
      }
      for (const hash of collected) blobs.delete(hash);
      await this.ledger.load();
      await this.ledger.reconcile(blobs.keys());

      const snapshotBytesTotal = objects.filter((object) => object.key.startsWith(SNAPSHOT_PREFIX)).reduce((sum, object) => sum + object.sizeBytes, 0);
      const blobBytesTotal = [...blobs.values()].reduce((sum, object) => sum + object.sizeBytes, 0);
      const previous = await this.currentPeriod(config);
      const usage: StoredUsage = {
        storageBytes: blobBytesTotal + snapshotBytesTotal + legacyBytes,
        blobCount: blobs.size,
        snapshotCount: snapshots.length,
        writeOperations: previous.writeOperations,
        readOperations: previous.readOperations,
        periodStartedAt: previous.periodStartedAt,
        legacyObjectCount,
        legacyBytes,
        lastReconciledAt: this.now().toISOString(),
      };
      await this.save({ ...(await this.load()), ledgerTarget: await this.storageTarget(config), usage });
      await this.recordCharges();
      this.logger(logEvent('r2.reconciled', `[r2] ${blobs.size} stored chunk(s), ${formatBytes(usage.storageBytes)}; collected ${collectedBlobs}`, { chunks: blobs.size, size: formatBytes(usage.storageBytes), collected: collectedBlobs }));
      return { blobCount: blobs.size, collectedBlobs, collectedBytes, usage: toPublicUsage(usage) };
    });
  }

  /**
   * Remove the whole-ZIP archives the previous scheme uploaded.
   *
   * Never automatic. They are the operator's backups, taken under a design that
   * no longer runs, and deciding they are worthless is not this manager's call
   * to make on its own.
   */
  public async deleteLegacyObjects(): Promise<{ removed: number; bytes: number }> {
    return await this.exclusive(async () => {
      const config = await this.requireUsable();
      const client = this.client(config);
      const objects = await this.listAll(config, OBJECT_PREFIX, client);
      const legacy = objects.filter((object) => !object.key.startsWith(BLOB_PREFIX) && !object.key.startsWith(SNAPSHOT_PREFIX));
      let bytes = 0;
      for (const object of legacy) {
        await client.deleteObject(object.key);
        bytes += object.sizeBytes;
      }
      const usage = await this.currentPeriod(config);
      await this.save({
        ...config,
        usage: {
          ...usage,
          storageBytes: Math.max(0, usage.storageBytes - bytes),
          legacyObjectCount: 0,
          legacyBytes: 0,
        },
      });
      await this.recordCharges();
      this.logger(logEvent('r2.legacyRemoved', `[r2] removed ${legacy.length} archive(s) in the old whole-file format, ${formatBytes(bytes)}`, { count: legacy.length, size: formatBytes(bytes) }));
      return { removed: legacy.length, bytes };
    });
  }

  public async deleteObject(key: string): Promise<void> {
    if (!key.startsWith(OBJECT_PREFIX) || key.includes('..')) throw new R2Error('invalid_object_key', 'The R2 object key is invalid');
    const config = await this.load();
    await this.client(config).deleteObject(key);
    await this.recordCharges();
  }

  /**
   * What Cloudflare's analytics say the signed-in bucket and its account used
   * this month, with warnings for anything close to a limit.
   *
   * Asked for at most every fifteen minutes unless `refresh` says otherwise: the
   * analytics API has a limit of its own, and the figures lag anyway. A query
   * that fails still returns the last figures, with the error beside them.
   */
  public async cloudflareUsage(options: { readonly refresh?: boolean } = {}): Promise<R2UsageResponse> {
    const config = await this.load();
    if (config.mode !== 'cloudflare' || !this.cloudflare) return { usage: null, unavailable: 'keys_mode', error: null };
    const status = await this.cloudflare.status();
    if (status.state !== 'connected') return { usage: null, unavailable: 'not_connected', error: null };
    if (!status.analyticsGranted) return { usage: null, unavailable: 'analytics_not_granted', error: null };
    const cached = this.cloudUsage;
    if (cached && !options.refresh && this.now().getTime() - cached.at < CLOUD_USAGE_TTL_MS) return { usage: cached.usage, unavailable: null, error: null };
    try {
      const target = await this.cloudflare.target();
      if (!target) return { usage: null, unavailable: 'not_connected', error: null };
      const now = this.now();
      // Analytics name a bucket bound to a jurisdiction with the jurisdiction in front.
      const bucketName = target.jurisdiction === 'default' ? target.bucket : `${target.jurisdiction}_${target.bucket}`;
      const report = await readR2Usage(this.cloudflare.cloudflareApi(), target.account.id, bucketName, now);
      const usage: R2CloudflareUsage = { ...report, fetchedAt: now.toISOString(), freeTier: { ...R2_FREE_TIER }, warnings: usageWarnings(report, config) };
      this.cloudUsage = { at: now.getTime(), usage };
      return { usage, unavailable: null, error: null };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The usage figures could not be read';
      return { usage: cached?.usage ?? null, unavailable: cached ? null : 'query_failed', error: message };
    }
  }

  /** Cloudflare's figures if they are recent enough to hold a ceiling against, fetched if not. */
  private async recentCloudUsage(): Promise<R2CloudflareUsage | null> {
    const cached = this.cloudUsage;
    if (cached && this.now().getTime() - cached.at < CLOUD_USAGE_GUARD_MAX_AGE_MS) return cached.usage;
    // A backup never waits on, or fails because of, the analytics being down.
    const fetched = await this.cloudflareUsage().catch(() => null);
    return fetched?.usage && this.now().getTime() - Date.parse(fetched.usage.fetchedAt) < CLOUD_USAGE_GUARD_MAX_AGE_MS ? fetched.usage : null;
  }

  /**
   * Write down that the manager put a recovery point back by itself.
   *
   * Said once, on the card, because it happened while nobody was watching and
   * the reader would otherwise have to work out from the chat history whether
   * their data came back.
   */
  public async recordRecovery(recovery: { readonly createdAt: string; readonly fileCount: number; readonly sizeBytes?: number }): Promise<void> {
    const config = await this.load();
    await this.save({ ...config, lastRecovery: { at: this.now().toISOString(), createdAt: recovery.createdAt, fileCount: recovery.fileCount, ...(recovery.sizeBytes === undefined ? {} : { sizeBytes: recovery.sizeBytes }) } });
  }

  public async markFingerprint(fingerprint: string): Promise<void> {
    const config = await this.load();
    await this.save({ ...config, lastFingerprint: fingerprint });
  }

  /** Upload every chunk of one file the bucket is missing, or report the file is gone. */
  private async uploadChunks(client: ObjectStore, entry: PlannedFile): Promise<{ hashes: string[]; bytes: number } | null> {
    let handle;
    try {
      handle = await open(entry.source.path, 'r');
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw error;
    }
    try {
      const hashes: string[] = [];
      let bytes = 0;
      const compress = shouldCompress(entry.source.file.name);
      for (const chunk of entry.chunks) {
        const raw = Buffer.allocUnsafe(chunk.length);
        const { bytesRead } = await handle.read(raw, 0, chunk.length, chunk.offset);
        // The file changed under the walk. The snapshot describes what was
        // hashed, so a short read means this file no longer matches it.
        if (bytesRead !== chunk.length) return null;
        const body = await encodeBlob(raw, compress);
        await client.putObject(blobKey(OBJECT_PREFIX, chunk.hash), body, 'application/octet-stream');
        hashes.push(chunk.hash);
        bytes += body.byteLength;
      }
      return { hashes, bytes };
    } catch (error: unknown) {
      if (isFileNotFound(error)) return null;
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async listAll(config: StoredR2Config, prefix: string, client?: ObjectStore): Promise<ObjectRecord[]> {
    const target = client ?? this.client(config);
    const objects: ObjectRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await target.listObjects(prefix, LIST_PAGE_KEYS, cursor);
      objects.push(...page.objects);
      cursor = page.cursor;
    } while (cursor);
    return objects;
  }

  private async requireUsable(): Promise<StoredR2Config> {
    const config = await this.load();
    if (!config.enabled) throw new R2Error('r2_disabled', 'R2 backup is switched off');
    if (config.mode === 'cloudflare') {
      const status = await this.cloudflare?.status();
      if (status?.state === 'reconnect_required') throw new R2Error('cloudflare_reconnect_required', 'Reconnect to Cloudflare to continue backing up');
      if (status?.state !== 'connected') throw new R2Error('r2_not_configured', 'Connect to Cloudflare and choose an account first');
    } else {
      toCredentials(config);
    }
    return config;
  }

  /**
   * Where objects go right now, as the chunk ledger needs to know it.
   *
   * An R2 bucket is named the same way whether it is reached with S3 keys or
   * through a sign-in, so moving between the two on one bucket keeps the ledger.
   */
  private async storageTarget(config: StoredR2Config): Promise<string> {
    if (config.mode === 'cloudflare') {
      const target = await this.cloudflare?.target();
      if (!target) throw new R2Error('r2_not_configured', 'Connect to Cloudflare and choose an account first');
      return `cloudflare:${target.account.id}/${target.jurisdiction}/${target.bucket}`;
    }
    const credentials = toCredentials(config);
    return canonicalTarget(`s3:${credentials.endpoint.replace(/\/+$/u, '')}/${credentials.bucket}`);
  }

  /**
   * The config for a run, with the ledger made to describe the bucket being written.
   *
   * A different bucket is read before anything is sent to it: the ledger is
   * rebuilt from the chunks it already holds, so a bucket that has this
   * profile's data costs a listing rather than every chunk again, and an empty
   * one gets everything. A config from before this was recorded is taken to
   * describe the keys bucket it was already using, so upgrading costs nothing.
   */
  private async onTarget(config: StoredR2Config): Promise<StoredR2Config> {
    await this.ledger.load();
    const target = await this.storageTarget(config);
    const recorded = config.ledgerTarget === null ? null : canonicalTarget(config.ledgerTarget);
    if (recorded === target || (recorded === null && config.mode === 'keys')) {
      if (config.ledgerTarget === target) return config;
      const adopted = { ...config, ledgerTarget: target };
      await this.save(adopted);
      return adopted;
    }
    const found = summarizeObjects(await this.listAll(config, OBJECT_PREFIX));
    await this.ledger.reconcile(found.blobs.keys());
    const switched: StoredR2Config = {
      ...config,
      ledgerTarget: target,
      lastUploadAt: null,
      lastColdUploadAt: null,
      lastFingerprint: null,
      lastSnapshot: null,
      usage: {
        ...config.usage,
        storageBytes: found.totalBytes,
        blobCount: found.blobs.size,
        snapshotCount: found.snapshotKeys.length,
        legacyObjectCount: found.legacyObjectCount,
        legacyBytes: found.legacyBytes,
        lastReconciledAt: null,
      },
    };
    await this.save(switched);
    this.logger(logEvent('r2.targetChanged', `[r2] backups now go to a different bucket, which already holds ${found.blobs.size} chunk(s); only what it is missing is sent`, { chunks: found.blobs.size }));
    return switched;
  }

  /** The usage counters, with the charged-write count reset when the month turns over. */
  private async currentPeriod(config: StoredR2Config): Promise<StoredUsage> {
    const period = monthStart(this.now());
    if (config.usage.periodStartedAt === period) return config.usage;
    return { ...config.usage, writeOperations: 0, periodStartedAt: period };
  }

  private client(config: StoredR2Config): ObjectStore {
    const count = (kind: Billing): void => {
      if (kind === 'charged') this.charges.write += 1;
      else if (kind === 'read') this.charges.read += 1;
    };
    if (config.mode === 'cloudflare') {
      if (!this.cloudflare) throw new R2Error('cloudflare_not_available', 'This manager has no Cloudflare sign-in configured');
      return this.cloudflare.objectStore(count);
    }
    return new S3ObjectStore(toCredentials(config), this.fetchImpl, count);
  }

  /**
   * Write down what has been charged since the last time.
   *
   * Called at the end of every operation that talks to R2, including the ones
   * that only read, so the figure the panel shows is the whole bill rather than
   * the part that happened to pass through a saved result.
   */
  private async recordCharges(options: { readonly atMostEvery?: number } = {}): Promise<void> {
    if (this.charges.write === 0 && this.charges.read === 0) return;
    const since = this.now().getTime() - this.chargesWrittenAt;
    if (options.atMostEvery !== undefined && since < options.atMostEvery) return;
    this.chargesWrittenAt = this.now().getTime();
    const config = await this.load();
    const usage = await this.currentPeriod(config);
    const taken = this.charges;
    this.charges = { write: 0, read: 0 };
    await this.save({
      ...config,
      usage: { ...usage, writeOperations: usage.writeOperations + taken.write, readOperations: usage.readOperations + taken.read },
    });
  }

  /** Run one whole-store operation at a time, whatever else is asked for meanwhile. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.busy.then(operation, operation);
    this.busy = run.catch(() => undefined);
    return await run;
  }

  private async toPublic(config: StoredR2Config): Promise<R2Config> {
    const cloudflare = this.cloudflare ? await this.cloudflare.status() : null;
    return {
      mode: config.mode,
      cloudflare,
      enabled: config.enabled,
      endpoint: config.endpoint,
      bucket: config.bucket,
      environmentFields: this.environmentFields(),
      configured: config.mode === 'cloudflare'
        ? cloudflare?.state === 'connected'
        : Boolean(config.endpoint && config.bucket && config.accessKeyId && config.secretAccessKey),
      lastUploadAt: config.lastUploadAt,
      accessKeyIdMasked: config.accessKeyId ? maskSecret(config.accessKeyId) : null,
      secretAccessKeyConfigured: Boolean(config.secretAccessKey),
      schedule: {
        hotIntervalMinutes: config.hotIntervalMinutes,
        coldIntervalHours: config.coldIntervalHours,
        reconcileIntervalHours: config.reconcileIntervalHours,
      },
      retention: { keepRecent: config.keepRecent, keepDaily: config.keepDaily, keepWeekly: config.keepWeekly },
      limits: { maxStorageBytes: config.maxStorageBytes, maxWriteOperations: config.maxWriteOperations, maxReadOperations: config.maxReadOperations },
      usage: toPublicUsage(config.usage),
      lastFingerprint: config.lastFingerprint,
      lastRecovery: config.lastRecovery,
    };
  }

  /**
   * The local backup interval this file still holds from an older version.
   *
   * It is not an R2 setting and never was: it decides how often a ZIP is taken
   * on this machine, bucket or no bucket. The backup library owns it now, and
   * the server hands this value over once, then calls forgetLegacyLocalInterval.
   */
  public async legacyLocalIntervalMinutes(): Promise<number | null> {
    await this.load();
    return this.legacyLocalInterval;
  }

  public async forgetLegacyLocalInterval(): Promise<void> {
    const config = await this.load();
    if (this.legacyLocalInterval === null) return;
    this.legacyLocalInterval = null;
    await this.save(config);
  }

  /** When the cold tier is next owed a run, which the scheduler asks about. */
  public async coldDue(): Promise<boolean> {
    const config = await this.load();
    if (!config.lastColdUploadAt) return true;
    const elapsed = this.now().getTime() - Date.parse(config.lastColdUploadAt);
    return !Number.isFinite(elapsed) || elapsed >= config.coldIntervalHours * 60 * 60 * 1000;
  }

  /** Whether a listing of the whole store is owed, which is the only costly sweep. */
  public async reconcileDue(): Promise<boolean> {
    const config = await this.load();
    if (!config.usage.lastReconciledAt) return true;
    const elapsed = this.now().getTime() - Date.parse(config.usage.lastReconciledAt);
    return !Number.isFinite(elapsed) || elapsed >= config.reconcileIntervalHours * 60 * 60 * 1000;
  }

  private async load(): Promise<StoredR2Config> {
    if (this.configState) return this.configState;
    await mkdir(this.paths.state, { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(join(this.paths.state, R2_STATE_FILE), 'utf8'));
      this.legacyLocalInterval = isRecord(parsed) && typeof parsed.localIntervalMinutes === 'number' ? parsed.localIntervalMinutes : null;
      const stored = this.withEnvironment(parseStoredConfig(parsed));
      validateStoredConfig(stored);
      this.configState = stored;
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw error;
      // A complete connection in `.env` is somebody asking for R2 backups, so
      // the first start takes it as switched on. The panel can still turn it off.
      const seeded: StoredR2Config = {
        ...this.withEnvironment(defaultStoredConfig(this.now())),
        enabled: this.environmentFields().length === ENVIRONMENT_FIELDS.length,
      };
      validateStoredConfig(seeded);
      await this.save(seeded);
    }
    if (!this.configState) throw new Error('R2 configuration could not be loaded');
    return this.configState;
  }

  /**
   * The connection fields `.env` sets.
   *
   * `.env` is read on every start rather than copied once into the state file.
   * Copying it meant editing `.env` afterwards changed nothing, and the secret
   * ended up written in a second place the operator never put it.
   */
  private environmentFields(): R2EnvironmentField[] {
    return ENVIRONMENT_FIELDS.filter(({ variable }) => nullableEnvironment(this.env[variable]) !== null).map(({ field }) => field);
  }

  private withEnvironment(config: StoredR2Config): StoredR2Config {
    const next: Record<string, unknown> = { ...config };
    for (const { field, variable } of ENVIRONMENT_FIELDS) {
      const value = nullableEnvironment(this.env[variable]);
      if (value !== null) next[field] = value;
    }
    return next as unknown as StoredR2Config;
  }

  private async save(config: StoredR2Config): Promise<void> {
    const operation = async (): Promise<void> => {
      await mkdir(this.paths.state, { recursive: true });
      const target = join(this.paths.state, R2_STATE_FILE);
      const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      // What `.env` supplies stays in `.env`: the file records nothing for it.
      const onDisk: Record<string, unknown> = { ...config };
      for (const field of this.environmentFields()) onDisk[field] = null;
      await writeFile(temporary, `${JSON.stringify(onDisk, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, target);
      this.configState = config;
    };
    const previous = this.writeQueue;
    this.writeQueue = previous.then(operation, operation);
    await this.writeQueue;
  }
}

function usageWarnings(report: Pick<R2CloudflareUsage, 'bucket' | 'account'>, config: StoredR2Config): R2UsageWarning[] {
  const warnings: R2UsageWarning[] = [];
  const check = (scope: R2UsageWarning['scope'], metric: R2UsageWarning['metric'], used: number | null, limit: number): void => {
    if (used !== null && limit > 0 && used >= limit * WARNING_RATIO) warnings.push({ scope, metric, used, limit });
  };
  check('account', 'storage', report.account.storageBytes, R2_FREE_TIER.storageBytes);
  check('account', 'classA', report.account.operations.classA, R2_FREE_TIER.classA);
  check('account', 'classB', report.account.operations.classB, R2_FREE_TIER.classB);
  check('bucket', 'storage', report.bucket.storageBytes, config.maxStorageBytes);
  check('bucket', 'classA', report.bucket.operations.classA, config.maxWriteOperations);
  check('bucket', 'classB', report.bucket.operations.classB, config.maxReadOperations);
  return warnings;
}

interface PlannedFile {
  readonly source: SyncSource;
  readonly chunks: readonly FileChunk[];
}

interface UploadPlan {
  readonly files: readonly PlannedFile[];
  readonly reused: number;
  /** How much data has to go, for saying how long that will take. */
  readonly bytes: number;
}

function plannedBytes(entry: PlannedFile): number {
  let total = 0;
  for (const chunk of entry.chunks) total += chunk.length;
  return total;
}

/**
 * Decide what actually has to be sent.
 *
 * A chunk shared by two files is claimed by the first one here rather than
 * being raced for during the upload: identical content is identical wherever it
 * came from, so sending it once is both correct and the point.
 */
function planUpload(sources: readonly SyncSource[], ledger: BlobLedger): UploadPlan {
  const claimed = new Set<string>();
  const files: PlannedFile[] = [];
  let reused = 0;
  for (const source of sources) {
    const chunks = source.file.chunks.filter((chunk) => {
      if (ledger.has(chunk.hash) || claimed.has(chunk.hash)) { reused += 1; return false; }
      claimed.add(chunk.hash);
      return true;
    });
    if (chunks.length > 0) files.push({ source, chunks });
  }
  return { files, reused, bytes: files.reduce((sum, entry) => sum + plannedBytes(entry), 0) };
}

/** The complete file list for a snapshot: what this run walked, plus what it carried. */
function mergeFiles(sources: readonly SyncSource[], carried: readonly HashedFile[], dropped: ReadonlySet<string>): HashedFile[] {
  const files = new Map<string, HashedFile>();
  for (const file of carried) if (!dropped.has(file.name)) files.set(file.name, file);
  for (const source of sources) if (!dropped.has(source.file.name)) files.set(source.file.name, source.file);
  return [...files.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Which recovery points survive: the newest few, then one a day, then one a week.
 *
 * Thinning rather than expiring is what makes a five-minute schedule affordable
 * to keep: an hour ago is worth every point, last month is worth one.
 */
function selectRetained(snapshots: readonly R2SnapshotSummary[], config: { keepRecent: number; keepDaily: number; keepWeekly: number }): Set<string> {
  const ordered = [...snapshots].sort((left, right) => right.id.localeCompare(left.id));
  const keep = new Set<string>(ordered.slice(0, config.keepRecent).map((snapshot) => snapshot.id));
  const claimFirst = (limit: number, bucket: (snapshot: R2SnapshotSummary) => string): void => {
    const seen = new Set<string>();
    for (const snapshot of ordered) {
      const period = bucket(snapshot);
      if (seen.has(period)) continue;
      seen.add(period);
      if (seen.size > limit) return;
      keep.add(snapshot.id);
    }
  };
  claimFirst(config.keepDaily, (snapshot) => snapshot.createdAt.slice(0, 10));
  claimFirst(config.keepWeekly, (snapshot) => isoWeek(snapshot.createdAt));
  return keep;
}

/** The ISO week a timestamp falls in, so "one a week" means the same week to everyone. */
function isoWeek(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp.slice(0, 10);
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Thursday decides the year a week belongs to, which is what makes the turn
  // of the year one week rather than two partial ones.
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = Date.UTC(target.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function toSnapshotSummary(object: ObjectRecord): R2SnapshotSummary | null {
  const rest = object.key.slice(SNAPSHOT_PREFIX.length);
  const separator = rest.indexOf('/');
  if (separator <= 0 || !rest.endsWith('.json.gz')) return null;
  const identifier = rest.slice(separator + 1, -'.json.gz'.length);
  if (!identifier) return null;
  const totals = SNAPSHOT_TOTALS.exec(identifier);
  return {
    id: identifier,
    profileId: rest.slice(0, separator),
    createdAt: snapshotTimestamp(identifier),
    indexBytes: object.sizeBytes,
    fileCount: totals ? Number(totals[1]) : null,
    dataBytes: totals ? Number(totals[2]) : null,
  };
}

/**
 * How many files a recovery point names and how much data they hold, read
 * from its name.
 *
 * A listing is all the panel can afford to ask for - reading every index to
 * learn its size is a charged read each. The object's own size is the index,
 * a couple of hundred kilobytes, which the table used to show as the size of a
 * recovery point that then took hundreds of megabytes to bring back. Points
 * written before this carry no totals, and say so rather than guess.
 */
const SNAPSHOT_TOTALS = /\.f(\d+)\.b(\d+)$/u;

/**
 * Snapshot names are timestamps with the punctuation a key cannot carry.
 *
 * Naming them this way means a listing comes back in chronological order and
 * retention never has to read a single index to know what is oldest.
 */
function snapshotId(createdAt: string, files: readonly HashedFile[]): string {
  const dataBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return `${createdAt.replace(/[:.]/gu, '-')}.f${files.length}.b${dataBytes}`;
}

function snapshotTimestamp(identifier: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:\.f\d+\.b\d+)?$/u.exec(identifier);
  return match ? `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z` : identifier;
}

function monthStart(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00.000Z`;
}

function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new R2Error('r2_upload_stopped', 'The upload was stopped');
}

/** What a listing of the manager's prefix holds, sorted by kind. */
function summarizeObjects(objects: readonly ObjectRecord[]): { blobs: Map<string, ObjectRecord>; snapshotKeys: string[]; legacyObjectCount: number; legacyBytes: number; totalBytes: number } {
  const blobs = new Map<string, ObjectRecord>();
  const snapshotKeys: string[] = [];
  let legacyObjectCount = 0;
  let legacyBytes = 0;
  let totalBytes = 0;
  for (const object of objects) {
    totalBytes += object.sizeBytes;
    if (object.key.startsWith(BLOB_PREFIX)) {
      const hash = object.key.slice(object.key.lastIndexOf('/') + 1);
      if (/^[0-9a-f]{64}$/u.test(hash)) blobs.set(hash, object);
      continue;
    }
    if (object.key.startsWith(SNAPSHOT_PREFIX)) { snapshotKeys.push(object.key); continue; }
    // Whole-ZIP archives from the version before this one. They are not
    // read and not deleted behind the operator's back; the panel offers it.
    legacyObjectCount += 1;
    legacyBytes += object.sizeBytes;
  }
  return { blobs, snapshotKeys, legacyObjectCount, legacyBytes, totalBytes };
}

/**
 * A ledger target in the form that names an R2 bucket the same way however it
 * is reached: an S3 endpoint on R2 becomes the account, jurisdiction and bucket.
 */
function canonicalTarget(target: string): string {
  const match = /^s3:(.+)\/([^/]+)$/u.exec(target);
  const parsed = match?.[1] ? parseS3Endpoint(match[1]) : null;
  return parsed && match?.[2] ? `cloudflare:${parsed.accountId}/${parsed.jurisdiction}/${match[2]}` : target;
}

function toCredentials(config: StoredR2Config): R2Credentials {
  if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new R2Error('r2_not_configured', 'Configure the R2 endpoint, bucket, access key, and secret key first');
  return { endpoint: config.endpoint, bucket: config.bucket, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
}

function validateStoredConfig(config: StoredR2Config): void {
  if (config.endpoint !== null) {
    let parsed: URL;
    try { parsed = new URL(config.endpoint); } catch { throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must be a valid HTTPS URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must use HTTPS');
    if (parsed.search || parsed.hash) throw new R2Error('invalid_r2_endpoint', 'R2 endpoint must not contain a query or fragment');
  }
  if (config.bucket !== null && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(config.bucket)) throw new R2Error('invalid_r2_bucket', 'R2 bucket name is invalid');
}

/**
 * Read the stored settings, including one written by the version that uploaded
 * whole ZIP files.
 *
 * What the operator typed is kept - the endpoint, the bucket and the keys are
 * not something to make them find again. The schedule and retention are not:
 * they described a different scheme, and carrying "keep 7 archives" forward
 * into one where a recovery point is an index would mean nothing.
 */
function parseStoredConfig(value: unknown): StoredR2Config {
  if (!isRecord(value)) throw new Error('Unsupported R2 configuration schema');
  const defaults = defaultStoredConfig(new Date());
  if (value.schemaVersion === 1) {
    const migrated: StoredR2Config = {
      ...defaults,
      enabled: typeof value.enabled === 'boolean' ? value.enabled : false,
      endpoint: typeof value.endpoint === 'string' ? value.endpoint : null,
      bucket: typeof value.bucket === 'string' ? value.bucket : null,
      accessKeyId: typeof value.accessKeyId === 'string' ? value.accessKeyId : null,
      secretAccessKey: typeof value.secretAccessKey === 'string' ? value.secretAccessKey : null,
    };
    validateStoredConfig(migrated);
    return migrated;
  }
  if (value.schemaVersion !== R2_SCHEMA_VERSION) throw new Error('Unsupported R2 configuration schema');
  const usage = isRecord(value.usage) ? value.usage : {};
  // Account ID was asked for and never used: the endpoint already names the
  // account. A file that still has one keeps nothing of it.
  const current: Record<string, unknown> = { ...value };
  delete current.accountId;
  // The local backup interval moved to the backup library; see legacyLocalIntervalMinutes.
  delete current.localIntervalMinutes;
  const config: StoredR2Config = {
    ...defaults,
    ...current,
    schemaVersion: R2_SCHEMA_VERSION,
    usage: { ...defaults.usage, ...usage } as StoredUsage,
  } as StoredR2Config;
  validateStoredConfig(config);
  return config;
}

function defaultStoredConfig(now: Date): StoredR2Config {
  return {
    schemaVersion: R2_SCHEMA_VERSION,
    mode: 'keys',
    ledgerTarget: null,
    enabled: false,
    endpoint: null,
    bucket: null,
    accessKeyId: null,
    secretAccessKey: null,
    ...DEFAULTS,
    lastUploadAt: null,
    lastColdUploadAt: null,
    lastFingerprint: null,
    lastSnapshot: null,
    lastRecovery: null,
    usage: {
      storageBytes: 0,
      blobCount: 0,
      snapshotCount: 0,
      writeOperations: 0,
      readOperations: 0,
      periodStartedAt: monthStart(now),
      legacyObjectCount: 0,
      legacyBytes: 0,
      lastReconciledAt: null,
    },
  };
}

function toPublicUsage(usage: StoredUsage): R2Usage {
  return { ...usage };
}

function normalizeNullable(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function preserveSecret(value: string | null, previous: string | null): string | null {
  if (value === MASKED_SECRET) return previous;
  return normalizeNullable(value);
}

function integerInRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new R2Error('invalid_r2_schedule', `The ${label} is out of range`);
  return value;
}

function maskSecret(value: string): string {
  if (value.length <= 4) return MASKED_SECRET;
  return `${value.slice(0, 2)}${MASKED_SECRET}${value.slice(-2)}`;
}

function toPublicObject(object: ObjectRecord): R2Object {
  return { key: object.key, sizeBytes: object.sizeBytes, lastModified: object.lastModified, etag: object.etag };
}



function nullableEnvironment(value: string | undefined): string | null {
  return value?.trim() || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && (error.code === 'ENOENT' || error.code === 'EISDIR');
}
