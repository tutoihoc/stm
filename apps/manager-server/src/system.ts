import { cpus, freemem, totalmem } from 'node:os';
import { lstat, readdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemSnapshot } from '../../../packages/contracts/src/index.js';
import { createIoLimiter, ioConcurrency } from '../../../packages/platform/src/index.js';
import type { PlatformPaths } from '../../../packages/platform/src/index.js';

/**
 * How long a measured directory size is served before it is taken again.
 *
 * Sizing a profile means stat-ing every file in it, which on a hosted volume
 * costs seconds. That is far too slow to do on each poll of a dashboard, and
 * the number barely moves between chats, so it is measured in the background
 * and served from the last result.
 */
const SIZE_TTL_MS = 5 * 60 * 1000;
const EXCLUDED_FROM_SIZE = new Set(['.git', 'node_modules']);

interface CpuSample {
  readonly idle: number;
  readonly total: number;
}

interface MeasuredSize {
  readonly bytes: number;
  readonly fileCount: number;
  readonly measuredAt: string;
}

export interface SystemStoreOptions {
  readonly paths: PlatformPaths;
  readonly now?: () => Date;
  /** The active profile's user-data directory, when a profile is active. */
  readonly dataRoot?: () => Promise<string | null>;
}

export class SystemStore {
  private readonly paths: PlatformPaths;
  private readonly now: () => Date;
  private readonly dataRoot: () => Promise<string | null>;
  private lastCpu: CpuSample | null = null;
  private managerSize: MeasuredSize | null = null;
  private dataSize: MeasuredSize | null = null;
  private measuring = false;
  /** A check is in flight, which is not yet a walk: the walk may be skipped. */
  private checking = false;
  /**
   * The profile directory the last walk covered, so a different one is noticed.
   *
   * The sizes are served from the last walk for five minutes, which is right
   * while the question stays the same. It stops being the same question the
   * moment a profile appears where there was none - the first install - or the
   * active profile changes: the cached answer is then about a directory nobody
   * is asking about, and the panel sat on "Measuring..." until the interval ran
   * out, on the one screen where a new user is watching for a number. The walk
   * is redone when the subject of it changes.
   */
  private measuredRoot: string | null = null;
  private measuredRootKnown = false;

  public constructor(options: SystemStoreOptions) {
    this.paths = options.paths;
    this.now = options.now ?? (() => new Date());
    this.dataRoot = options.dataRoot ?? (async () => null);
  }

  public async snapshot(): Promise<SystemSnapshot> {
    const storage = await this.readStorage();
    const totalBytes = totalmem();
    const freeBytes = freemem();
    this.scheduleSizeRefresh();
    return {
      generatedAt: this.now().toISOString(),
      cpu: {
        cores: cpus().length,
        usagePercent: this.readCpuUsage(),
      },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes: totalBytes - freeBytes,
      },
      storage: {
        root: this.paths.root,
        ...storage,
        managerBytes: this.managerSize?.bytes ?? null,
        dataBytes: this.dataSize?.bytes ?? null,
        dataFileCount: this.dataSize?.fileCount ?? null,
        measuredAt: this.dataSize?.measuredAt ?? this.managerSize?.measuredAt ?? null,
        measuring: this.measuring,
      },
    };
  }

  /**
   * Percentage of CPU time spent out of idle since the previous call.
   *
   * `os.cpus()` reports totals since boot, so a single reading says nothing
   * about now; the first call establishes the baseline and returns null.
   */
  private readCpuUsage(): number | null {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus()) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    const previous = this.lastCpu;
    this.lastCpu = { idle, total };
    if (!previous) return null;
    const totalDelta = total - previous.total;
    const idleDelta = idle - previous.idle;
    if (totalDelta <= 0) return null;
    return Math.round(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) * 10) / 10;
  }

  private async readStorage(): Promise<{ totalBytes: number | null; freeBytes: number | null }> {
    try {
      const details = await statfs(this.paths.root);
      return { totalBytes: details.blocks * details.bsize, freeBytes: details.bavail * details.bsize };
    } catch {
      // A volume that refuses statfs still leaves every other reading useful.
      return { totalBytes: null, freeBytes: null };
    }
  }

  /**
   * Take the sizes again now instead of waiting out the interval.
   *
   * The interval is long because a walk is expensive, but an operator who has
   * just deleted a backup wants to see it gone, not in five minutes.
   */
  public remeasure(): void {
    this.scheduleSizeRefresh(true);
  }

  private scheduleSizeRefresh(force = false): void {
    if (this.checking) return;
    const measuredAt = this.dataSize?.measuredAt ?? this.managerSize?.measuredAt;
    const fresh = !force && measuredAt !== undefined && this.now().getTime() - Date.parse(measuredAt) < SIZE_TTL_MS;
    this.checking = true;
    void (async () => {
      try {
        const root = await this.dataRoot();
        // Asked after the freshness check rather than before it, because it is
        // the one thing that can make a fresh reading stale: a reading of a
        // directory that is no longer the one being asked about. Nothing is
        // reported as being measured until this decides there is a walk.
        if (fresh && this.measuredRootKnown && this.measuredRoot === root) return;
        this.measuring = true;
        const limiter = createIoLimiter(ioConcurrency());
        const [manager, data] = await Promise.all([
          measureTree(this.paths.root, limiter),
          root ? measureTree(root, limiter) : Promise.resolve({ bytes: 0, fileCount: 0 }),
        ]);
        const stamp = this.now().toISOString();
        this.managerSize = { ...manager, measuredAt: stamp };
        this.dataSize = root ? { ...data, measuredAt: stamp } : null;
        this.measuredRoot = root;
        this.measuredRootKnown = true;
      } catch {
        // Keep the previous reading; the next poll asks again.
      } finally {
        this.measuring = false;
        this.checking = false;
      }
    })();
  }
}

async function measureTree(root: string, limiter: { run: <R>(operation: () => Promise<R>) => Promise<R> }): Promise<{ bytes: number; fileCount: number }> {
  let bytes = 0;
  let fileCount = 0;
  const visit = async (current: string): Promise<void> => {
    let children;
    try {
      children = await limiter.run(() => readdir(current, { withFileTypes: true }));
    } catch {
      return;
    }
    await Promise.all(children.map(async (child) => {
      if (EXCLUDED_FROM_SIZE.has(child.name)) return;
      const full = join(current, child.name);
      if (child.isSymbolicLink()) return;
      if (child.isDirectory()) { await visit(full); return; }
      try {
        const details = await limiter.run(() => lstat(full));
        bytes += details.size;
        fileCount += 1;
      } catch {
        // A file removed while walking simply does not count.
      }
    }));
  };
  await visit(root);
  return { bytes, fileCount };
}
