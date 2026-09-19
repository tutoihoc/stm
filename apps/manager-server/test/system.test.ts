import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../../packages/platform/src/index.js';
import type { SystemSnapshot } from '../../../packages/contracts/src/index.js';
import { SystemStore } from '../src/system.js';

/**
 * Wait for the background walk to report the size it is expected to find.
 *
 * The walk does real file I/O, so counting event-loop turns is a guess that
 * comes up short whenever the machine is busy.
 */
async function measured(store: SystemStore, dataBytes: number): Promise<SystemSnapshot> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const snapshot = await store.snapshot();
    if (!snapshot.storage.measuring && snapshot.storage.dataBytes === dataBytes) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the sizes were never measured as ${dataBytes} bytes`);
}

test('the system snapshot reports the host and measures directory sizes in the background', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-system-'));
  const dataRoot = join(root, 'profiles', 'data');
  await mkdir(join(dataRoot, 'chats'), { recursive: true });
  await mkdir(join(dataRoot, 'node_modules'), { recursive: true });
  await writeFile(join(dataRoot, 'chats', 'one.jsonl'), 'x'.repeat(500), 'utf8');
  await writeFile(join(dataRoot, 'chats', 'two.jsonl'), 'x'.repeat(300), 'utf8');
  // Generated trees are not the operator's data and must not be counted.
  await writeFile(join(dataRoot, 'node_modules', 'ignored.bin'), 'x'.repeat(9_000), 'utf8');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const store = new SystemStore({ paths, dataRoot: async () => dataRoot });

  const first = await store.snapshot();
  assert.ok(first.cpu.cores >= 1);
  // One reading of a counter since boot cannot describe the present.
  assert.equal(first.cpu.usagePercent, null);
  assert.equal(first.memory.usedBytes, first.memory.totalBytes - first.memory.freeBytes);
  assert.equal(first.memory.usedBytes >= 0, true);
  assert.equal(first.storage.root, paths.root);
  assert.equal(first.storage.dataBytes, null);

  const second = await measured(store, 800);
  assert.equal(second.storage.dataFileCount, 2);
  assert.ok((second.storage.managerBytes ?? 0) >= 800);
  assert.ok(second.storage.measuredAt !== null);
  assert.ok(second.cpu.usagePercent === null || (second.cpu.usagePercent >= 0 && second.cpu.usagePercent <= 100));

  // Asking again must not wait out the interval the background walk uses.
  await writeFile(join(dataRoot, 'chats', 'three.jsonl'), 'x'.repeat(200), 'utf8');
  store.remeasure();
  const third = await measured(store, 1000);
  assert.equal(third.storage.dataFileCount, 3);
});

test('a profile appearing where there was none is measured without waiting out the interval', async () => {
  /*
   * The first install.
   *
   * The sizes are served from the last walk for five minutes, which is right
   * while the question stays the same. It stopped being the same question the
   * moment a profile existed: the cached answer was about a machine that had
   * none, and the overview went on saying "Measuring..." for the rest of the
   * interval - on the one screen somebody who has just installed is watching
   * for a number.
   */
  const root = await mkdtemp(join(tmpdir(), 'stm-system-new-'));
  const dataRoot = join(root, 'profiles', 'data');
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  let profile: string | null = null;
  const store = new SystemStore({ paths, dataRoot: async () => profile });

  await store.snapshot();
  for (let attempt = 0; attempt < 400 && (await store.snapshot()).storage.measuredAt === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const empty = await store.snapshot();
  assert.ok(empty.storage.measuredAt !== null, 'the machine itself is measured before any profile exists');
  assert.equal(empty.storage.dataBytes, null);

  await mkdir(join(dataRoot, 'chats'), { recursive: true });
  await writeFile(join(dataRoot, 'chats', 'one.jsonl'), 'x'.repeat(640), 'utf8');
  profile = dataRoot;

  // No remeasure() and no waiting: the next ordinary poll notices that what it
  // is being asked about has changed.
  const withProfile = await measured(store, 640);
  assert.equal(withProfile.storage.dataFileCount, 1);
});
