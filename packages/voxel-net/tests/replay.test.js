import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { VoxelWorld } from '@margoengine/voxel';
import { VoxelServer } from '../dist/server.js';
import { connectVoxelNet, VoxelNetClient, decodeServerMessage, encodeServerMessage } from '../dist/index.js';
import {
  VoxelRecorder,
  recordVoxelFile,
  readVoxelRecording,
  decodeVoxelRecording,
  VoxelReplay,
} from '../dist/replay.js';
import { testBlocks } from './blocks.js';

const blocks = testBlocks();
async function until(fn) {
  const signal = AbortSignal.timeout(10000);
  while (!fn()) await delay(10, undefined, { signal });
}
function memorySink() {
  const parts = [];
  return {
    parts,
    sink: {
      write: async (data) => {
        parts.push(data.slice());
      },
      close: async () => {},
    },
    bytes: () => Buffer.concat(parts),
  };
}
function source() {
  let send;
  return {
    tickRate: 20,
    onSend: (fn) => {
      send = fn;
      return () => {
        send = undefined;
      };
    },
    emit: (data, tick = 1, player = 1) => send?.({ id: player }, data, tick),
  };
}
test('file records all server streams and a fresh client reconstructs the exact observed world and app messages', {
  timeout: 30000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'margo-replay-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const server = new VoxelServer({
    blocks,
    workers: 1,
    generator: new URL('./flat-generator.js', import.meta.url),
    spawn: () => [16, 16],
  });
  t.after(() => server.close());
  const path = join(dir, 'session.mvr');
  const offMutator = server.onSend((_player, data) => data.fill(0));
  t.after(offMutator);
  const recorder = await recordVoxelFile(server, path);
  t.after(() => recorder.close());
  const { port } = await server.listen();
  const live = connectVoxelNet(`ws://127.0.0.1:${port}`, new VoxelWorld({ blocks }), { view: 2 });
  t.after(() => live.close());
  live.onError = (e) => assert.fail(e);
  const apps = [];
  live.onApp = (data) => apps.push([...data]);
  await until(() => live.spawned && live.loaded);
  server.broadcast(Uint8Array.of(42, 0, 255));
  await until(() => apps.length === 1);
  await recorder.close();
  const recording = await readVoxelRecording(path);
  const id = server.players[0].id;
  assert.ok(recording.records.some((r) => decodeServerMessage(r.data).type === 'chunk'));
  assert.deepEqual(decodeVoxelRecording(await readFile(path)), recording);
  const replayed = new VoxelNetClient(new VoxelWorld({ blocks }), { send: () => {}, close: () => {} }, { view: 2 });
  t.after(() => replayed.close());
  replayed.onError = (e) => assert.fail(e);
  const replayApps = [];
  replayed.onApp = (data) => replayApps.push([...data]);
  const replay = new VoxelReplay(recording, id, replayed);
  assert.equal(replay.done, false);
  replay.advanceTo(recording.records.at(-1).tick);
  assert.equal(replay.done, true);
  assert.equal(replayed.spawned, true);
  assert.deepEqual(replayApps, apps);
  assert.deepEqual([...replayed.player.position], [...live.player.position]);
  const liveChunks = new Map(),
    replayChunks = new Map();
  const snapshot = (target) => (x, y, z, chunk) => {
    if (chunk) target.set(`${x},${y},${z}`, chunk.pack());
    else target.delete(`${x},${y},${z}`);
  };
  const offLive = live.world.onChunk(snapshot(liveChunks));
  const offReplay = replayed.world.onChunk(snapshot(replayChunks));
  t.after(offLive);
  t.after(offReplay);
  await until(() => replayChunks.size === liveChunks.size && liveChunks.size > 0);
  assert.deepEqual(replayChunks, liveChunks);
  const played = [];
  const timed = new VoxelReplay(recording, id, { receive: (data) => played.push(data) });
  await timed.play({ speed: 10000, maxDuration: 1000 });
  assert.deepEqual(
    played,
    recording.records.filter((r) => r.player === id).map((r) => r.data),
  );
  assert.throws(() => timed.advanceTo(-1), /forward/);
  const cancelled = new VoxelReplay(recording, id, { receive: () => assert.fail('cancelled replay delivered bytes') });
  await assert.rejects(cancelled.play({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(recordVoxelFile(server, path), { code: 'EEXIST' });
  await assert.rejects(readVoxelRecording(path, { maxBytes: 32 }), /maxBytes/);
  await assert.rejects(readVoxelRecording(path, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});
test('message order, byte ownership, footer, version, frame sizes and tick ordering are enforced', async () => {
  const server = source(),
    memory = memorySink(),
    recorder = new VoxelRecorder(server, memory.sink);
  const data = encodeServerMessage({ type: 'app', data: Uint8Array.of(10) });
  server.emit(data, 10);
  data.fill(255);
  server.emit(encodeServerMessage({ type: 'heartbeat' }), 10, 2);
  await recorder.close();
  const bytes = memory.bytes(),
    decoded = decodeVoxelRecording(bytes);
  const owned = decodeVoxelRecording(Buffer.from(bytes));
  assert.equal(owned.records[0].data.constructor, Uint8Array);
  assert.equal(decoded.records[0].tick, 10);
  assert.equal(decodeServerMessage(decoded.records[0].data).data[0], 10);
  assert.deepEqual(
    decoded.records.map((r) => r.player),
    [1, 2],
  );
  for (const length of [0, 15, 31, bytes.length - 1, bytes.length - 16])
    assert.throws(() => decodeVoxelRecording(bytes.subarray(0, length)), RangeError);
  const badVersion = Uint8Array.from(bytes);
  badVersion[4] = 255;
  assert.throws(() => decodeVoxelRecording(badVersion), /version/);
  const badOrder = Uint8Array.from(bytes);
  new DataView(badOrder.buffer, badOrder.byteOffset).setFloat64(16, 100, true);
  assert.throws(() => decodeVoxelRecording(badOrder), /tick order/);
  assert.throws(() => decodeVoxelRecording(Buffer.concat([bytes, Buffer.from([1])])), /footer/);
  assert.throws(() => new VoxelReplay(decoded, 1, { receive: () => {} }), /welcome/);
  bytes.fill(0);
  assert.equal(decodeServerMessage(decoded.records[0].data).data[0], 10, 'Buffer inputs cannot alias decoded records');
});
test('sink failure and overflow stop capture and reject flush and close without hiding data loss', async () => {
  const server = source(),
    errors = [],
    failure = new RangeError('fixture sink failed');
  let closed = false;
  const recorder = new VoxelRecorder(server, {
    write: async () => {
      throw failure;
    },
    close: async () => {
      closed = true;
    },
  });
  recorder.onError = (error) => errors.push(error);
  await assert.rejects(recorder.flush(), (e) => e === failure);
  await assert.rejects(recorder.close(), (e) => e === failure);
  assert.equal(closed, true);
  assert.deepEqual(errors, [failure]);
  const noisy = source(),
    mem = memorySink(),
    overflow = new VoxelRecorder(noisy, mem.sink, { maxPendingBytes: 16 });
  const events = [];
  overflow.onError = (error) => events.push(error);
  noisy.emit(encodeServerMessage({ type: 'heartbeat' }));
  await assert.rejects(overflow.close(), /sink is too slow/);
  assert.equal(events.length, 1);
  assert.throws(() => decodeVoxelRecording(mem.bytes()), /truncated/);
});
