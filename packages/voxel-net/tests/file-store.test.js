// FileChunkStore (a ChunkStore on disk) and the VoxelServer `store` option taking it: edits survive a restart, a
// client sees them, and a server without a store keeps today's behaviour (edits last as long as the process).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { VoxelChunk, VoxelWorld } from '@margoengine/voxel';
import { VoxelNetClient } from '../dist/index.js';
import { connectWebSocket, VoxelServer } from '../dist/server.js';
import { FileChunkStore } from '../dist/file-store.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks(),
  LOG = blocks.id('log'),
  FLAT = { amplitude: 0, caves: 0, trees: 0, height: 8, seaLevel: -10 },
  wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function folder(t) {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'margo-file-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const chunkWith = (x, y, z, state) => {
  const chunk = new VoxelChunk();
  chunk.set(x, y, z, state);
  return chunk;
};
async function start(options) {
  const server = new VoxelServer({ blocks, workers: 2, generator: FLAT, spawn: () => [8, 8], ...options }),
    { port } = await server.listen(0);
  return { server, url: `ws://127.0.0.1:${port}` };
}
async function join(url) {
  const conn = await connectWebSocket(url),
    world = new VoxelWorld({ blocks }),
    client = new VoxelNetClient(world, { send: (d) => conn.send(d), close: () => conn.close() }, { view: 2 });
  conn.onmessage = (d) => client.receive(d);
  return { client, conn, world };
}
async function drive(client, done, ms = 10_000) {
  const end = performance.now() + ms;
  let last = performance.now();
  while (performance.now() < end && !done()) {
    await wait(16);
    const now = performance.now();
    client.update((now - last) / 1000, { keys: 0, yaw: 0, pitch: 0 });
    last = now;
  }
  return done();
}

test('FileChunkStore keeps a chunk per file, reads it back, and get sees every put and delete before it', async (t) => {
  const dir = pathJoin(await folder(t), 'world', 'chunks'), // created on the first put
    store = new FileChunkStore(dir);
  assert.equal(await store.get(0, 0, 0), undefined, 'nothing stored yet');
  const first = chunkWith(1, 2, 3, 5);
  const put = store.put(-1, 4, 7, first);
  first.set(1, 2, 3, 9); // after put returns: not saved
  assert.equal((await store.get(-1, 4, 7)).get(1, 2, 3), 5, 'the chunk as it was when put was called');
  await put;
  store.put(-1, 4, 7, chunkWith(0, 0, 0, 6)); // not awaited: the next get still sees it
  assert.equal((await store.get(-1, 4, 7)).get(0, 0, 0), 6);
  assert.equal((await store.get(-1, 4, 7)).get(1, 2, 3), 0);
  store.delete(-1, 4, 7);
  assert.equal(await store.get(-1, 4, 7), undefined, 'deleted');
  await store.put(2, 0, 0, chunkWith(31, 31, 31, 3));
  await store.flush();
  assert.deepEqual(await readdir(dir), ['2,0,0.chunk'], 'one file per chunk, no temporary file left');
  assert.equal((await new FileChunkStore(dir).get(2, 0, 0)).get(31, 31, 31), 3, 'a second store reads the same folder');
  await store.delete(2, 0, 0);
  await store.delete(2, 0, 0); // deleting what is not there is fine
  assert.deepEqual(await readdir(dir), []);
});

test('FileChunkStore names its misuse and reports disk failures from put and the next flush only', async (t) => {
  const dir = await folder(t);
  assert.throws(() => new FileChunkStore(''), TypeError);
  const store = new FileChunkStore(dir);
  assert.throws(() => store.put(0.5, 0, 0, new VoxelChunk()), RangeError);
  assert.throws(() => store.put(2 ** 26, 0, 0, new VoxelChunk()), RangeError);
  assert.throws(() => store.put(0, 0, 0, {}), TypeError);
  await assert.rejects(() => store.get(0, '1', 0), RangeError);
  assert.throws(() => store.delete(NaN, 0, 0), RangeError);
  // A damaged file is an error, not a missing chunk.
  await writeFile(pathJoin(dir, '0,0,0.chunk'), Uint8Array.of(1, 2, 3));
  await assert.rejects(() => store.get(0, 0, 0), RangeError);
  // A file where the folder should be: the write fails, put rejects, and the next flush rejects once.
  const blocked = pathJoin(dir, 'in-the-way');
  await writeFile(blocked, 'x');
  const broken = new FileChunkStore(pathJoin(blocked, 'chunks'));
  await assert.rejects(() => broken.put(0, 0, 0, new VoxelChunk()));
  await assert.rejects(() => broken.flush());
  await broken.flush();
});

test('a server on a FileChunkStore keeps edits across a restart and a client sees them', {
  timeout: 60_000,
}, async (t) => {
  const dir = pathJoin(await folder(t), 'chunks'),
    cells = [
      [8, 12, 8],
      [40, 12, 8],
    ],
    first = await start({ store: new FileChunkStore(dir) }),
    a = await join(first.url);
  assert.ok(await drive(a.client, () => a.client.spawned), 'first client spawned');
  for (const [x, y, z] of cells) first.server.world.setBlock(x, y, z, LOG);
  a.client.close();
  const errors = [];
  first.server.onError = (e) => errors.push(e);
  await first.server.close(); // saves the edited chunks
  assert.deepEqual(errors, []);
  assert.deepEqual((await readdir(dir)).sort(), ['0,0,0.chunk', '1,0,0.chunk']);

  // A new server on the same folder: nothing was edited in this process, the generator's flat ground is under it.
  const second = await start({ store: new FileChunkStore(dir) });
  t.after(() => second.server.close());
  const b = await join(second.url);
  assert.ok(await drive(b.client, () => b.client.spawned), 'second client spawned');
  for (const cell of cells) assert.equal(second.server.world.getBlock(...cell), LOG, `server holds ${cell}`);
  assert.ok(
    await drive(b.client, () => cells.every((c) => b.world.getBlock(...c) === LOG)),
    'the client sees the edits',
  );
  assert.equal(b.world.getBlock(9, 12, 8), 0, "next to them the world is the generator's");
  b.client.close();
});

test('without a store a restart forgets edits, as before', { timeout: 60_000 }, async () => {
  const first = await start({}),
    a = await join(first.url);
  assert.ok(await drive(a.client, () => a.client.spawned));
  first.server.world.setBlock(8, 12, 8, LOG);
  a.client.close();
  await first.server.close();
  const second = await start({}),
    b = await join(second.url);
  assert.ok(await drive(b.client, () => b.client.spawned));
  assert.notEqual(second.server.world.getBlock(8, 12, 8), LOG, 'edits last as long as the process');
  b.client.close();
  await second.server.close();
});

test('the store option takes a VoxelEditStore or a ChunkStore and names anything else', async () => {
  const bad = (store) => () => new VoxelServer({ blocks, store });
  assert.throws(bad({ save() {} }), /VoxelEditStore|save\(key, chunk\) and load\(key\)/);
  assert.throws(bad({ get() {}, put() {} }), TypeError, 'a ChunkStore needs delete and flush too');
  assert.throws(bad('world/'), TypeError);
  for (const store of [
    { save() {}, load() {} },
    { get() {}, put() {}, delete() {}, flush() {} },
  ])
    await new VoxelServer({ blocks, store }).close();
});
