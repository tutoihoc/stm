import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPlatformPaths } from '../../platform/src/index.js';
import type { Profile } from '../../contracts/src/index.js';
import { R2Manager, type SyncSource } from '../src/index.js';
import { decodeSnapshot, hashFile } from '../src/sync.js';

const CREDENTIALS = {
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'stm-test-bucket',
  accessKeyId: 'access-key-1234',
  secretAccessKey: 'secret-key-5678',
  enabled: true,
} as const;

function profile(): Profile {
  return {
    id: 'profile-1', name: 'Default', installationId: 'install-1', runtimePath: '/runtime', configPath: '/runtime/config.yaml',
    dataPath: '/runtime/data', layout: 'data', active: true, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', activatedAt: null,
  };
}

/** An in-memory bucket that answers the parts of S3 this manager speaks. */
function fakeBucket(): { fetchImpl: typeof fetch; objects: Map<string, Buffer>; requests: { list: number; put: number; get: number; delete: number } } {
  const objects = new Map<string, Buffer>();
  const requests = { list: 0, put: 0, get: 0, delete: 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers as HeadersInit);
    assert.match(headers.get('authorization') ?? '', /AWS4-HMAC-SHA256 Credential=access-key-1234\//u);
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (method === 'GET' && url.searchParams.get('list-type') === '2') {
      requests.list += 1;
      const prefix = url.searchParams.get('prefix') ?? '';
      const after = url.searchParams.get('continuation-token');
      const maxKeys = Number(url.searchParams.get('max-keys') ?? 1000);
      const matching = [...objects.keys()].filter((name) => name.startsWith(prefix)).sort();
      const start = after ? matching.indexOf(after) + 1 : 0;
      const page = matching.slice(start, start + maxKeys);
      const truncated = start + page.length < matching.length;
      const contents = page.map((name) => `<Contents><Key>${name}</Key><Size>${objects.get(name)?.byteLength ?? 0}</Size><LastModified>2026-09-11T00:00:00.000Z</LastModified><ETag>"etag"</ETag></Contents>`).join('');
      const next = truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : '';
      return new Response(`<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${next}${contents}</ListBucketResult>`, { status: 200 });
    }
    if (method === 'PUT') {
      requests.put += 1;
      objects.set(key, Buffer.from(await new Response(init?.body ?? null).arrayBuffer()));
      return new Response('', { status: 200 });
    }
    if (method === 'GET') {
      requests.get += 1;
      const body = objects.get(key);
      if (!body) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
      return new Response(new Uint8Array(body), { status: 200 });
    }
    if (method === 'DELETE') {
      requests.delete += 1;
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('', { status: 200 });
  };
  return { fetchImpl, objects, requests };
}

async function createManager(options: { fetchImpl?: typeof fetch; now?: () => Date } = {}): Promise<{ manager: R2Manager; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'stm-r2-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const manager = new R2Manager({ paths, env: { STM_DATA_DIR: root }, logger: () => undefined, ...options });
  await manager.update({ ...CREDENTIALS });
  return { manager, root };
}

async function source(root: string, name: string, body: string | Buffer): Promise<SyncSource> {
  const path = join(root, name.replaceAll('/', '-'));
  await writeFile(path, body);
  const file = await hashFile(name, path);
  assert.ok(file);
  return { file, path };
}

test('R2 config masks credentials and preserves ******** updates', async () => {
  const { manager } = await createManager();
  const before = await manager.getConfig();
  assert.equal(before.configured, true);
  assert.equal(before.accessKeyIdMasked, 'ac********34');
  assert.equal(before.secretAccessKeyConfigured, true);
  await manager.update({ accessKeyId: '********', secretAccessKey: '********' });
  const after = await manager.getConfig();
  assert.equal(after.accessKeyIdMasked, before.accessKeyIdMasked);
  assert.equal(after.secretAccessKeyConfigured, true);
});

test('connection settings in .env win, and are never copied into the state file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-r2-env-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  const env = {
    STM_R2_ENDPOINT: CREDENTIALS.endpoint,
    STM_R2_BUCKET: CREDENTIALS.bucket,
    STM_R2_ACCESS_KEY_ID: CREDENTIALS.accessKeyId,
    STM_R2_SECRET_ACCESS_KEY: CREDENTIALS.secretAccessKey,
  };
  const manager = new R2Manager({ paths, env, logger: () => undefined });
  const config = await manager.getConfig();
  assert.equal(config.configured, true);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.environmentFields, ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey']);

  await manager.update({ bucket: 'someone-else', enabled: false });
  const after = await manager.getConfig();
  assert.equal(after.bucket, CREDENTIALS.bucket);
  assert.equal(after.enabled, false);
  const onDisk = await readFile(join(paths.state, 'r2-config.json'), 'utf8');
  assert.equal(onDisk.includes(CREDENTIALS.secretAccessKey), false);
  assert.equal(onDisk.includes(CREDENTIALS.accessKeyId), false);
});

test('a different bucket gets every chunk, because the ledger described the old one', async () => {
  const first = fakeBucket();
  const second = fakeBucket();
  const fetchImpl: typeof fetch = async (input, init) => (new URL(String(input)).pathname.split('/')[1] === 'stm-other-bucket' ? second.fetchImpl : first.fetchImpl)(input, init);
  const { manager, root } = await createManager({ fetchImpl });
  const chat = await source(root, 'chats/one.jsonl', 'x'.repeat(5000));
  const card = await source(root, 'characters/a.png', Buffer.alloc(3000, 1));
  await manager.syncProfile({ profile: profile(), sources: [chat, card], fingerprint: 'one' });
  assert.equal(first.requests.put, 3);
  // Same bucket: the ledger knows both chunks, so only the new index goes up.
  await manager.syncProfile({ profile: profile(), sources: [chat, card], fingerprint: 'two' });
  assert.equal(first.requests.put, 4);

  await manager.update({ bucket: 'stm-other-bucket' });
  await manager.syncProfile({ profile: profile(), sources: [chat, card], fingerprint: 'three' });
  assert.equal(second.requests.put, 3, 'both chunks and the index go to the new bucket');
  assert.equal(first.requests.put, 4);
  assert.equal((await manager.getConfig()).usage.snapshotCount, 1);
});

test('keysBucket parses an R2 S3 endpoint into an account, bucket and jurisdiction', async () => {
  const accountId = '0123456789abcdef0123456789abcdef';
  const { manager } = await createManager();
  // Default endpoint: jurisdiction is 'default'.
  await manager.update({ endpoint: `https://${accountId}.r2.cloudflarestorage.com`, bucket: 'stm' });
  const kb = await manager.keysBucket();
  assert.deepEqual(kb, { accountId, bucket: 'stm', jurisdiction: 'default' });
  // EU jurisdiction endpoint.
  await manager.update({ endpoint: `https://${accountId}.eu.r2.cloudflarestorage.com` });
  const kbEu = await manager.keysBucket();
  assert.equal(kbEu?.jurisdiction, 'eu');
  // Non-R2 endpoint returns null.
  await manager.update({ endpoint: 'https://s3.amazonaws.com', bucket: 'other' });
  assert.equal(await manager.keysBucket(), null);
});

test('a recovery point lists the data it holds, not just the size of its index', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const chat = await source(root, 'chats/one.jsonl', 'x'.repeat(5000));
  const card = await source(root, 'characters/a.png', Buffer.alloc(3000, 1));
  await manager.syncProfile({ profile: profile(), sources: [chat, card], fingerprint: 'sized' });
  const [listed] = await manager.listSnapshots('profile-1');
  assert.ok(listed);
  assert.equal(listed.fileCount, 2);
  assert.equal(listed.dataBytes, 8000);
  assert.equal((await manager.readSnapshot('profile-1', listed.id)).files.length, 2);
});

test('settings written by the whole-archive version keep their credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stm-r2-old-'));
  const paths = getPlatformPaths({ platform: 'linux', env: { STM_DATA_DIR: root } });
  await mkdir(paths.state, { recursive: true });
  // What the previous scheme stored. The endpoint and keys are what the
  // operator typed; the schedule described a design that no longer exists.
  await writeFile(join(paths.state, 'r2-config.json'), JSON.stringify({
    schemaVersion: 1, enabled: true, endpoint: CREDENTIALS.endpoint, bucket: CREDENTIALS.bucket, accountId: 'account-1',
    accessKeyId: 'access-key-1234', secretAccessKey: 'secret-key-5678',
    localIntervalMinutes: 30, r2IntervalHours: 24, fullIntervalDays: 7, maxBackups: 7, retentionDays: 30,
    lastUploadAt: '2026-09-01T00:00:00.000Z', lastFingerprint: 'old', estimatedBytes: 12345,
  }));
  const manager = new R2Manager({ paths, env: {}, logger: () => undefined });
  const config = await manager.getConfig();
  assert.equal(config.configured, true);
  assert.equal(config.accessKeyIdMasked, 'ac********34');
  assert.equal(config.enabled, true);
  // Not an R2 setting: it is handed to the backup library once, then dropped.
  assert.equal(await manager.legacyLocalIntervalMinutes(), 30);
  await manager.forgetLegacyLocalInterval();
  assert.equal(await manager.legacyLocalIntervalMinutes(), null);
  assert.equal((await readFile(join(paths.state, 'r2-config.json'), 'utf8')).includes('localIntervalMinutes'), false);
  assert.equal(config.schedule.hotIntervalMinutes, 5);
  assert.equal(config.retention.keepRecent, 24);
  assert.equal(config.usage.storageBytes, 0);
});

test('a second backup sends only what changed, and still records every file', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const settings = await source(root, 'settings.json', '{"a":1}');
  const chat = await source(root, 'chats/one.jsonl', 'first line\n');
  const card = await source(root, 'characters/Assistant.png', 'card bytes');

  const first = await manager.syncProfile({ profile: profile(), sources: [settings, chat, card], fingerprint: 'one' });
  assert.equal(first.uploadedChunks, 3);
  assert.equal(first.fileCount, 3);

  // One chat grows. Everything else is already in the bucket, and the ledger
  // is what says so - no request is made to find out.
  const grown = await source(root, 'chats/one.jsonl', 'first line\nsecond line\n');
  const putsBefore = bucket.requests.put;
  const second = await manager.syncProfile({ profile: profile(), sources: [settings, grown, card], fingerprint: 'two' });
  assert.equal(second.uploadedChunks, 1);
  assert.equal(second.reusedChunks, 2);
  // One chunk and one index: nothing else went over the wire.
  assert.equal(bucket.requests.put - putsBefore, 2);

  const snapshots = await manager.listSnapshots('profile-1');
  assert.equal(snapshots.length, 2);
  const latest = await manager.readSnapshot('profile-1', snapshots[0]!.id);
  assert.deepEqual(latest.files.map((file) => file.name), ['characters/Assistant.png', 'chats/one.jsonl', 'settings.json']);
  assert.equal(latest.fingerprint, 'two');

  // Every chunk the newest recovery point names has to be readable, or it is
  // not a recovery point.
  for (const file of latest.files) for (const chunk of file.chunks) assert.ok((await manager.readBlob(chunk.hash)).byteLength > 0);
});

test('a frequent run carries the files it did not look at, so its snapshot is whole', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const chat = await source(root, 'chats/one.jsonl', 'hello\n');
  const image = await source(root, 'user/images/big.png', 'image bytes');
  await manager.syncProfile({ profile: profile(), sources: [chat, image], fingerprint: 'one', tier: 'cold' });

  // The five-minute run reads chats and nothing else. The image is named from
  // the last recovery point rather than re-read, and is still restorable.
  const grown = await source(root, 'chats/one.jsonl', 'hello\nagain\n');
  const hot = await manager.syncProfile({ profile: profile(), sources: [grown], carried: [image.file], fingerprint: 'two', tier: 'hot' });
  assert.equal(hot.fileCount, 2);
  const snapshots = await manager.listSnapshots('profile-1');
  const latest = await manager.readSnapshot('profile-1', snapshots[0]!.id);
  assert.deepEqual(latest.files.map((file) => file.name), ['chats/one.jsonl', 'user/images/big.png']);
  assert.equal((await manager.readBlob(latest.files[1]!.chunks[0]!.hash)).toString(), 'image bytes');
});

test('a file deleted mid-upload leaves the recovery point rather than breaking it', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const present = await source(root, 'settings.json', '{"a":1}');
  const vanished = await source(root, 'chats/gone.jsonl', 'gone\n');
  const result = await manager.syncProfile({
    profile: profile(),
    sources: [present, { file: vanished.file, path: join(root, 'never-existed') }],
    fingerprint: 'one',
  });
  assert.equal(result.fileCount, 1);
  const latest = await manager.readSnapshot('profile-1', (await manager.listSnapshots('profile-1'))[0]!.id);
  assert.deepEqual(latest.files.map((file) => file.name), ['settings.json']);
});

test('retention thins recovery points and the sweep takes back what nothing names', async () => {
  const bucket = fakeBucket();
  let clock = Date.parse('2026-09-14T00:00:00.000Z');
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl, now: () => new Date(clock) });
  await manager.update({ keepRecent: 1, keepDaily: 0, keepWeekly: 0 });

  const first = await source(root, 'chats/one.jsonl', 'version one\n');
  await manager.syncProfile({ profile: profile(), sources: [first], fingerprint: 'one' });
  clock += 60_000;
  const second = await source(root, 'chats/one.jsonl', 'version two\n');
  await manager.syncProfile({ profile: profile(), sources: [second], fingerprint: 'two' });
  assert.equal((await manager.listSnapshots('profile-1')).length, 2);

  const removed = await manager.pruneSnapshots('profile-1');
  assert.equal(removed.length, 1);
  assert.equal((await manager.listSnapshots('profile-1')).length, 1);

  // The first version's chunk is still stored: dropping an index frees nothing
  // on its own, because chunks are shared. The sweep is what frees it.
  const orphan = first.file.chunks[0]!.hash;
  assert.ok([...bucket.objects.keys()].some((key) => key.endsWith(orphan)));
  const swept = await manager.reconcile();
  assert.equal(swept.collectedBlobs, 1);
  assert.equal(swept.blobCount, 1);
  assert.ok(![...bucket.objects.keys()].some((key) => key.endsWith(orphan)));

  // What survives has to still be readable afterwards.
  assert.equal((await manager.readBlob(second.file.chunks[0]!.hash)).toString(), 'version two\n');
});

test('archives from the old scheme are counted, left alone, and removed only on request', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  bucket.objects.set('sillytavern-manager/backup-1.zip', Buffer.alloc(2048));
  bucket.objects.set('sillytavern-manager/backup-1.manifest.json', Buffer.alloc(64));
  await manager.syncProfile({ profile: profile(), sources: [await source(root, 'settings.json', '{}')], fingerprint: 'one' });

  const usage = (await manager.reconcile()).usage;
  assert.equal(usage.legacyObjectCount, 2);
  assert.equal(usage.legacyBytes, 2048 + 64);
  // Still there: they are the operator's backups, taken under a design that no
  // longer runs, and the sweep does not get to decide they are worthless.
  assert.ok(bucket.objects.has('sillytavern-manager/backup-1.zip'));

  const cleaned = await manager.deleteLegacyObjects();
  assert.equal(cleaned.removed, 2);
  assert.ok(!bucket.objects.has('sillytavern-manager/backup-1.zip'));
  assert.equal((await manager.getConfig()).usage.legacyObjectCount, 0);
});

test('a store larger than one listing page is listed whole', async () => {
  const bucket = fakeBucket();
  const { manager } = await createManager({ fetchImpl: bucket.fetchImpl });
  // A page holds a thousand keys. Stopping at the first one made every chunk
  // past it look absent, which would mean uploading all of them again.
  for (let index = 0; index < 1001; index += 1) bucket.objects.set(`sillytavern-manager/blobs/aa/${String(index).padStart(64, '0')}`, Buffer.alloc(1));
  assert.equal((await manager.listObjects()).length, 1001);
  assert.equal((await manager.reconcile()).blobCount, 0, 'nothing names them, so the sweep takes them all');
});

test('a bucket at the storage ceiling refuses to grow', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  // Named .png so it is stored as it is: the point is the bytes in the bucket,
  // not how well they happen to deflate.
  const image = await source(root, 'user/images/big.png', randomBytes(2 * 1024 * 1024));
  await manager.syncProfile({ profile: profile(), sources: [image], fingerprint: 'one' });
  const used = (await manager.getConfig()).usage.storageBytes;
  assert.ok(used > 1024 * 1024);

  // A free account is only free while it stays under the quota, so the ceiling
  // stops the backup rather than letting the bill start.
  await manager.update({ maxStorageBytes: 1024 * 1024 });
  const chat = await source(root, 'chats/one.jsonl', 'hello\n');
  await assert.rejects(() => manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'two' }), /ceiling/u);
});

test('an upload reports the bytes it still has to send, not just a file count', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  // A settings file and a character card. Counting files would call this half
  // done after the settings file, which is wrong by four orders of magnitude.
  const settings = await source(root, 'settings.json', '{"a":1}');
  const card = await source(root, 'characters/Assistant.png', randomBytes(512 * 1024));
  const seen: Array<{ completedBytes: number; totalBytes: number; completedItems: number; totalItems: number }> = [];

  const result = await manager.syncProfile({
    profile: profile(), sources: [settings, card], fingerprint: 'one',
    onProgress: (progress) => seen.push({ ...progress }),
  });

  const expected = settings.file.sizeBytes + card.file.sizeBytes;
  assert.equal(seen.length, 2);
  assert.equal(seen[0]?.totalBytes, expected, 'the total is known before the first byte goes');
  assert.equal(seen.at(-1)?.completedBytes, expected);
  assert.equal(seen.at(-1)?.completedItems, 2);
  assert.equal(result.uploadedChunks, 2);

  // Nothing to send means nothing to wait for, and no progress claiming otherwise.
  const quiet: unknown[] = [];
  await manager.syncProfile({ profile: profile(), sources: [settings, card], fingerprint: 'two', onProgress: (progress) => quiet.push(progress) });
  assert.deepEqual(quiet, []);
});

test('the run after an upload does not pay to be told what it just wrote', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const chat = await source(root, 'chats/one.jsonl', 'hello\n');
  await manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'one' });

  // A listing is a charged operation, and at one run every five minutes this
  // one was spent asking the bucket for an answer already on disk.
  const listsBefore = bucket.requests.list;
  const latest = await manager.latestSnapshot('profile-1');
  assert.equal(latest?.files.length, 1);
  assert.equal(bucket.requests.list - listsBefore, 0);

  // Retention only needs a listing when there is something to thin, which the
  // local count answers.
  assert.equal(await manager.pruneDue(), false);
  await manager.update({ keepRecent: 1, keepDaily: 0, keepWeekly: 0 });
  await manager.syncProfile({ profile: profile(), sources: [await source(root, 'chats/one.jsonl', 'hello again\n')], fingerprint: 'two' });
  assert.equal(await manager.pruneDue(), true);
});

test('a remembered recovery point that is gone falls back to the listing', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  await manager.syncProfile({ profile: profile(), sources: [await source(root, 'settings.json', '{"a":1}')], fingerprint: 'one' });
  // Someone deleted it from the bucket. The cache is a cache; the bucket is
  // still what is true.
  for (const key of [...bucket.objects.keys()]) if (key.includes('/snapshots/')) bucket.objects.delete(key);
  assert.equal(await manager.latestSnapshot('profile-1'), null);
});

test('every charged request is counted, including the listings that were free before', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  await manager.syncProfile({ profile: profile(), sources: [await source(root, 'settings.json', '{"a":1}')], fingerprint: 'one' });

  // Listing used to make its own client and throw the tally away with it, so
  // the most expensive thing the panel did counted as nothing at all.
  const before = (await manager.getConfig()).usage;
  const listsBefore = bucket.requests.list;
  await manager.listObjects();
  await manager.listSnapshots('profile-1');
  const listed = bucket.requests.list - listsBefore;
  assert.ok(listed >= 2);
  const after = (await manager.getConfig()).usage;
  assert.equal(after.writeOperations - before.writeOperations, listed);
});

test('reading a recovery point back is counted as reads, not as writes', async () => {
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const chat = await source(root, 'chats/one.jsonl', 'hello\n');
  const card = await source(root, 'characters/Assistant.png', 'card');
  await manager.syncProfile({ profile: profile(), sources: [chat, card], fingerprint: 'one' });
  const before = (await manager.getConfig()).usage;

  // A restore is one of these per file, and the free allowance for them is
  // separate from the one for writes. Charging them to the wrong counter made
  // a restore look like it had used up the backup budget.
  const snapshot = (await manager.listSnapshots('profile-1'))[0]!;
  await manager.readSnapshot('profile-1', snapshot.id);
  for (const hash of [chat.file.chunks[0]!.hash, card.file.chunks[0]!.hash]) await manager.readBlob(hash);
  await manager.listSnapshots('profile-1');

  const after = (await manager.getConfig()).usage;
  assert.ok(after.readOperations - before.readOperations >= 3, `expected at least three reads, got ${after.readOperations - before.readOperations}`);
});

test('the bucket lists every profile it holds, and one check reports what is in it', async () => {
  /*
   * A machine set up today has a profile identifier the bucket has never seen.
   *
   * Asking the bucket for its own recovery points then comes back with none,
   * over a bucket holding somebody's whole history - which is exactly the
   * moment, just after connecting, when they most need to see it is there.
   */
  const bucket = fakeBucket();
  const { manager, root } = await createManager({ fetchImpl: bucket.fetchImpl });
  const chat = await source(root, 'chats/one.jsonl', 'x'.repeat(5000));
  const older = { ...profile(), id: 'profile-from-a-machine-that-is-gone' };
  await manager.syncProfile({ profile: older, sources: [chat], fingerprint: 'one' });
  await manager.syncProfile({ profile: profile(), sources: [chat], fingerprint: 'two' });

  const mine = await manager.listSnapshots(profile().id);
  assert.equal(mine.length, 1);
  const all = await manager.listSnapshots();
  assert.equal(all.length, 2);
  assert.deepEqual([...new Set(all.map((snapshot) => snapshot.profileId))].sort(), ['profile-1', 'profile-from-a-machine-that-is-gone']);

  // One look, and what it found stays: the three buttons this replaced each
  // answered part of this and said so in a notification that went away.
  const listings = bucket.requests.list;
  const check = await manager.inspect();
  assert.equal(check.ok, true);
  assert.equal(check.failure, null);
  assert.equal(check.bucket, CREDENTIALS.bucket);
  assert.equal(check.snapshotCount, 2);
  assert.equal(check.objectCount, bucket.objects.size);
  assert.equal(check.totalBytes, [...bucket.objects.values()].reduce((sum, body) => sum + body.byteLength, 0));
  assert.ok(bucket.requests.list > listings, 'the bucket is actually read');
  // The counts the card shows are the ones that were just listed, not the ones
  // the manager had been keeping in its head since it last looked.
  const config = await manager.getConfig();
  assert.equal(config.usage.snapshotCount, check.snapshotCount);
  assert.equal(config.usage.storageBytes, check.totalBytes);
});

test('a bucket that cannot be read reports the reason instead of throwing it away', async () => {
  const fetchImpl: typeof fetch = async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
  const { manager } = await createManager({ fetchImpl });
  const check = await manager.inspect();
  assert.equal(check.ok, false);
  assert.equal(check.usage, null);
  assert.ok(check.failure, 'the refusal is a finding, not a broken request');
  assert.ok((check.failure?.message ?? '').length > 0);
});
