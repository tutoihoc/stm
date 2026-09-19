import { Readable } from 'node:stream';
import { readdir } from 'node:fs/promises';
import { logEvent, type BackupManifest, type LogSink, type Profile, type R2SnapshotSummary, type RestorePreview, type TransferProgress } from '../../../packages/contracts/src/index.js';
import { BackupStore, type ImportEntry } from '../../../packages/backup/src/index.js';
import { R2Manager } from '../../../packages/r2/src/index.js';
import type { HashedFile } from '../../../packages/r2/src/sync.js';
import { ioConcurrency } from '../../../packages/platform/src/index.js';

/**
 * How large a file may be and still be fetched ahead of when it is needed.
 *
 * A profile is mostly small files, and fetching them one at a time means one
 * network round trip each: eleven thousand of those in a row is most of an
 * hour of waiting on latency rather than on bandwidth. Reading ahead fixes
 * that, and the size limit is what stops reading ahead from holding several
 * large files in memory at once - those are few, and their round trips are
 * already paid for by the megabytes that follow them.
 */
const PREFETCH_MAX_FILE_BYTES = 8 * 1024 * 1024;

export interface FetchSnapshotOptions {
  readonly profile: Profile;
  readonly r2: R2Manager;
  readonly backups: BackupStore;
  readonly snapshotId: string;
  /**
   * Which profile in the bucket the recovery point belongs to, when that is not
   * the profile it is being brought back into.
   *
   * Profile identifiers are made on the machine that made the profile, so a
   * machine whose disk was emptied comes back with a new one and finds its own
   * recovery points filed under a name it no longer has. The stored chunks are
   * shared across every profile in the bucket, so reading a point from one and
   * restoring it into another costs nothing extra and is what makes a wiped
   * machine recoverable at all.
   */
  readonly sourceProfileId?: string;
  readonly logger?: LogSink;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

/**
 * Bring one recovery point back from R2 into the local backup library.
 *
 * It arrives as an ordinary archive, which is the point: restoring it is then
 * the path that already exists and has been proven, rather than a second way
 * of writing into a profile that would have to be made safe all over again.
 */
export async function fetchSnapshotToLibrary(options: FetchSnapshotOptions): Promise<{ manifest: BackupManifest; preview: RestorePreview }> {
  const { profile, r2, backups, snapshotId } = options;
  const snapshot = await r2.readSnapshot(options.sourceProfileId ?? profile.id, snapshotId);
  const files = [...snapshot.files].sort((left, right) => left.name.localeCompare(right.name));
  // Known before the first request, because the recovery point records the size
  // of everything it names. That is what makes an estimate possible at all.
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  options.logger?.(logEvent('r2.fetching', `[r2] fetching recovery point ${snapshot.createdAt} (${files.length} files)`, { createdAt: snapshot.createdAt, files: files.length }));
  let completedBytes = 0;
  const result = await backups.importFromEntries(profile, {
    kind: 'r2',
    takenAt: snapshot.createdAt,
    total: files.length,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? {
      onProgress: ({ completed }: { completed: number; total: number }) => {
        completedBytes += files[completed - 1]?.sizeBytes ?? 0;
        options.onProgress?.({ completedBytes, totalBytes, completedItems: completed, totalItems: files.length });
      },
    } : {}),
    entries: entriesFor(r2, files, options.signal),
  });
  options.logger?.(logEvent('r2.fetched', `[r2] recovery point ${snapshot.createdAt} is in the backup library as ${result.manifest.name}`, { createdAt: snapshot.createdAt, name: result.manifest.name }));
  return result;
}

/**
 * The archive entries for a recovery point, in order, reading ahead where it pays.
 *
 * Order matters because the archive is written as it is produced, so this
 * cannot simply fetch whatever finishes first.
 */
async function* entriesFor(r2: R2Manager, files: readonly HashedFile[], signal?: AbortSignal): AsyncGenerator<ImportEntry> {
  for await (const { file, buffered } of readAhead(r2, files, Math.max(1, ioConcurrency()), signal)) {
    yield {
      name: file.name,
      // A file small enough to have been read ahead is already here. A large
      // one is streamed a chunk at a time, so its size is never its cost in
      // memory.
      body: buffered ? Readable.from([buffered]) : Readable.from(chunkStream(r2, file, signal)),
    };
  }
}

async function* chunkStream(r2: R2Manager, file: HashedFile, signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (const chunk of file.chunks) {
    throwIfStopped(signal);
    yield await r2.readBlob(chunk.hash);
  }
}

/**
 * Fetch up to `limit` files at once while handing them back in the original order.
 *
 * Every started fetch is settled before it is looked at, so one that fails does
 * not reject with nobody listening - an unhandled rejection ends the manager
 * process, and this runs against a network that does fail.
 */
async function* readAhead(r2: R2Manager, files: readonly HashedFile[], limit: number, signal?: AbortSignal): AsyncGenerator<{ file: HashedFile; buffered: Buffer | null }> {
  type Settled = { file: HashedFile; buffered: Buffer | null; error?: unknown };
  const inFlight: Array<Promise<Settled>> = [];
  let next = 0;
  const fill = (): void => {
    while (inFlight.length < limit && next < files.length) {
      const file = files[next]!;
      next += 1;
      inFlight.push(load(r2, file, signal).then(
        (buffered) => ({ file, buffered }),
        (error: unknown) => ({ file, buffered: null, error }),
      ));
    }
  };
  fill();
  while (inFlight.length > 0) {
    const settled = await inFlight.shift()!;
    fill();
    if (settled.error !== undefined) throw settled.error;
    yield settled;
  }
}

async function load(r2: R2Manager, file: HashedFile, signal?: AbortSignal): Promise<Buffer | null> {
  throwIfStopped(signal);
  if (file.sizeBytes > PREFETCH_MAX_FILE_BYTES) return null;
  if (file.chunks.length === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for (const chunk of file.chunks) parts.push(await r2.readBlob(chunk.hash));
  return Buffer.concat(parts);
}

function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('The download was stopped');
}

export interface RecoverProfileOptions {
  readonly profile: Profile;
  readonly r2: R2Manager;
  readonly backups: BackupStore;
  readonly logger?: LogSink;
  /** Puts the fetched archive into the profile; the caller owns stopping SillyTavern. */
  readonly restore: (archivePath: string) => Promise<void>;
}

/**
 * Bring the newest recovery point back into a profile that has nothing in it.
 *
 * This is what makes a machine that does not keep its disk usable for more than
 * one sitting. Such a host starts every time from the repository as it was
 * checked in: no profile, no chats, no settings - and no stored R2 settings
 * either, which is why the ones that matter here are the ones read from the
 * environment, because the environment is the only part that survives. Given
 * those, the console can notice on the way up that the bucket holds a profile
 * this machine has lost, and put it back before SillyTavern is started on an
 * empty one.
 *
 * Two things make it safe to do without asking. It runs only when the profile
 * holds nothing, so there is nothing it can overwrite; and the recovery point
 * it picks is the newest in the bucket, which is the one the reader would have
 * picked. Anything else - a profile with data in it, a bucket with no recovery
 * points, a fetch that fails - leaves the profile exactly as it was and says so
 * in the log.
 *
 * Returns the recovery point that came back and the archive it arrived as, or
 * null when there was nothing to do.
 */
export async function recoverProfileFromR2(options: RecoverProfileOptions): Promise<{ manifest: BackupManifest; point: R2SnapshotSummary } | null> {
  const { profile, r2, backups, logger } = options;
  if (!await isProfileEmpty(profile)) return null;
  let candidate;
  try {
    // Every profile in the bucket, not this one: the identifier this machine
    // just made for itself has never been written to the bucket, so asking for
    // its own points would always come back empty.
    [candidate] = await r2.listSnapshots();
  } catch (error: unknown) {
    // A bucket that cannot be reached on the way up is not a reason to refuse
    // to start. The profile is empty either way, and the reader can restore by
    // hand once the console is open.
    logger?.(logEvent('r2.recoveryUnavailable', `[r2] the bucket could not be checked for a recovery point: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    return null;
  }
  if (!candidate) return null;
  logger?.(logEvent('r2.recovering', `[r2] this profile is empty and the bucket holds a recovery point from ${candidate.createdAt}; bringing it back`, { createdAt: candidate.createdAt }));
  try {
    const { manifest } = await fetchSnapshotToLibrary({
      profile, r2, backups,
      snapshotId: candidate.id,
      sourceProfileId: candidate.profileId,
      ...(logger ? { logger } : {}),
    });
    const archivePath = await backups.getArchivePath(manifest.id);
    if (!archivePath) throw new Error('the fetched recovery point could not be found in the backup library');
    await options.restore(archivePath);
    logger?.(logEvent('r2.recovered', `[r2] the recovery point from ${candidate.createdAt} is back in this profile`, { createdAt: candidate.createdAt }));
    return { manifest, point: candidate };
  } catch (error: unknown) {
    logger?.(logEvent('r2.recoveryFailed', `[r2] the recovery point could not be brought back: ${error instanceof Error ? error.message : 'unknown error'}`, { reason: error instanceof Error ? error.message : 'unknown error' }));
    return null;
  }
}

/**
 * Whether this profile holds nothing worth keeping.
 *
 * A profile directory that a manager has only just made is empty; one that
 * SillyTavern has been started on once is not. Asked by reading the directory
 * rather than by measuring it, because the question is "is there anything here"
 * and walking a profile of eleven thousand files to answer it would be the
 * slowest thing on the way up.
 */
async function isProfileEmpty(profile: Profile): Promise<boolean> {
  try {
    return (await readdir(profile.dataPath)).length === 0;
  } catch {
    // No directory at all is as empty as a directory can be, but it is also the
    // shape of a profile something else is wrong with. Leave it alone.
    return false;
  }
}
