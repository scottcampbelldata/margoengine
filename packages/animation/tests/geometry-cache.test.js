// Geometry cache: the chunked format round trips through any byte splits, and the player streams, waits and swaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { GeometryCachePlayer, encodeGeometryCache, readGeometryCache } from '../dist/geometry-cache.js';
import { near } from './support/models.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

/** A triangle fan of `sides` around the origin at height `frame`, for `frames` frames. */
function fan(sides, frames, first = 0) {
  const n = sides + 1,
    positions = new Float32Array(frames * n * 3),
    indices = [];
  for (let f = 0; f < frames; f++) {
    positions.set([0, 0, first + f], f * n * 3);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      positions.set([Math.cos(a), Math.sin(a), first + f], (f * n + 1 + s) * 3);
    }
  }
  for (let s = 0; s < sides; s++) indices.push(0, 1 + s, 1 + ((s + 1) % sides));
  return { frameCount: frames, positions, indices: new Uint32Array(indices) };
}
const collect = async (iterable) => {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out;
};
async function* pieces(bytes, size) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

test('a cache reads back chunk by chunk, whatever size its bytes arrive in', async () => {
  const uvs = new Float32Array(5 * 2).map((_, i) => i / 10),
    file = encodeGeometryCache(24, [
      { ...fan(4, 3), uvs },
      { frameCount: 2, positions: fan(4, 2, 3).positions },
      fan(6, 2, 5),
    ]);
  for (const size of [1, 7, 64, 100000]) {
    const chunks = await collect(readGeometryCache(pieces(file, size)));
    assert.deepEqual(
      chunks.map((c) => [c.firstFrame, c.frameCount, c.vertexCount, c.indices.length, c.rate, c.totalFrames]),
      [
        [0, 3, 5, 12, 24, 7],
        [3, 2, 5, 12, 24, 7],
        [5, 2, 7, 18, 24, 7],
      ],
      `pieces of ${size}`,
    );
    assert.deepEqual([...chunks[1].indices], [...chunks[0].indices], 'a chunk with no indices repeats the last');
    assert.equal(chunks[1].uvs, chunks[0].uvs, 'and the UVs, at the same vertex count');
    assert.equal(chunks[2].uvs.length, 14, 'another vertex count has its own');
    near([...chunks[0].uvs], [...uvs], 1e-7);
    near([...chunks[0].positions.subarray(0, 6)], [0, 0, 0, 1, 0, 0], 1e-7);
    near([...chunks[0].bounds], [-1, -1, 0, 1, 1, 2], 1e-6);
    // Stored without normals: a flat fan faces +Z.
    near([...chunks[0].normals.subarray(0, 3)], [0, 0, 1], 1e-6);
  }
});

test('stored normals are used as they are, and a browser stream reads like any other', async () => {
  const chunk = fan(3, 1),
    normals = new Float32Array(chunk.positions.length).map((_, i) => +(i % 3 === 0)),
    file = encodeGeometryCache(30, [{ ...chunk, normals }]),
    [read] = await collect(readGeometryCache(new Blob([file]).stream()));
  near([...read.normals], [...normals], 0);
  assert.equal((await collect(readGeometryCache(file))).length, 1, 'a plain array too');
});

test('a damaged or cut off file is refused with the fix, before allocating', async () => {
  const file = encodeGeometryCache(30, [fan(3, 2), fan(3, 2, 2)]),
    edit = (at, value) => {
      const copy = file.slice();
      new DataView(copy.buffer).setUint32(at, value, true);
      return copy;
    },
    failed = (error) => error.code === 'failed' && /export the file again/.test(error.message);
  await assert.rejects(collect(readGeometryCache(edit(0, 1))), failed, 'magic');
  await assert.rejects(collect(readGeometryCache(edit(4, 9))), failed, 'version');
  await assert.rejects(collect(readGeometryCache(edit(16, 1))), failed, 'chunk magic');
  await assert.rejects(collect(readGeometryCache(edit(20, 0xffffffff))), failed, 'chunk size');
  await assert.rejects(collect(readGeometryCache(edit(24, 5))), failed, 'frame gap');
  await assert.rejects(collect(readGeometryCache(file.subarray(0, 10))), failed, 'cut in the header');
  await assert.rejects(collect(readGeometryCache(file.subarray(0, file.length - 4))), failed, 'cut in a chunk');
  const first = 16 + 64 + new DataView(file.buffer).getUint32(20, true);
  await assert.rejects(collect(readGeometryCache(file.subarray(0, first))), /ends at frame 2 of 4/, 'a missing chunk');
  await assert.rejects(collect(readGeometryCache(new Uint8Array(0))), failed, 'empty');
  await assert.rejects(
    collect(readGeometryCache(file, { maxChunkBytes: 8 })),
    /over maxChunkBytes/,
    'a chunk over the limit',
  );
  const nan = file.slice();
  new Float32Array(nan.buffer, 16 + 64 + 36, 1)[0] = NaN;
  await assert.rejects(collect(readGeometryCache(nan)), /non-finite/);
  const noIndices = encodeGeometryCache(30, [{ frameCount: 1, positions: fan(3, 1).positions }]);
  await assert.rejects(collect(readGeometryCache(noIndices)), /no indices/);
  const wide = fan(3, 1);
  wide.indices = wide.indices.slice();
  wide.indices[0] = 99;
  await assert.rejects(collect(readGeometryCache(encodeGeometryCache(30, [wide]))), /index past its vertices/);
  assert.throws(() => encodeGeometryCache(0, [fan(3, 1)]), /frame rate above 0/);
  assert.throws(() => encodeGeometryCache(30, []), /at least one chunk/);
  assert.throws(() => encodeGeometryCache(30, [{ frameCount: 2, positions: new Float32Array(9) }]), /Invalid geometry chunk/);
});

test('an abort stops the read with its reason', async () => {
  const abort = new AbortController(),
    file = encodeGeometryCache(30, [fan(3, 1), fan(3, 1, 1)]),
    reader = readGeometryCache(file, { signal: abort.signal });
  await reader.next();
  abort.abort(new Error('stop'));
  await assert.rejects(reader.next(), /stop/);
  await assert.rejects(collect(readGeometryCache(file, { signal: AbortSignal.abort(new Error('early')) })), /early/);
});

async function gpuEngine(t) {
  const gpu = optionalGPU(),
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
      store,
      { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    device = gpu.engine.gpu,
    writes = new Map(),
    writeBuffer = device.queue.writeBuffer;
  device.queue.writeBuffer = function (buffer, offset, data, ...rest) {
    writes.set(buffer, data.slice());
    return writeBuffer.call(this, buffer, offset, data, ...rest);
  };
  t.after(() => {
    device.queue.writeBuffer = writeBuffer;
    engine.dispose();
    gpu.cleanup();
  });
  store.tick(false);
  return { engine, writes };
}
/** The mesh's height on the GPU: vertex 0's z in the last upload. */
const height = (player, writes) => writes.get(player.model.primitives[0].deformed)[2];
const settled = () => new Promise((resolve) => setImmediate(resolve));

test('frames play on the clock, interpolate, and cross chunks of one mesh without a swap', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    file = encodeGeometryCache(10, [fan(4, 3), { frameCount: 3, positions: fan(4, 3, 3).positions }]),
    player = await GeometryCachePlayer.attach(engine, file);
  await player.done;
  assert.equal(engine.plugins.get(player.name), player);
  assert.equal(player.duration, 0.6);
  const p = player.model.primitives[0];
  assert.ok(p.deformed, 'the mesh draws from the player');
  assert.equal(player.model.primitives.length, 1);
  player.onPreUpdate(0.1);
  near([height(player, writes)], [1], 1e-5);
  player.onPreUpdate(0.05);
  near([height(player, writes)], [1.5], 1e-5, 'half way between frames');
  player.onPreUpdate(0.1);
  near([height(player, writes)], [2.5], 1e-5, 'interpolates into the next chunk');
  const uploads = player.stats.uploads;
  player.playing = false;
  player.onPreUpdate(0.1);
  assert.equal(player.stats.uploads, uploads, 'a paused frame uploads nothing');
  assert.equal(player.stats.swaps, 0);
  player.playing = true;
  player.onPreUpdate(0.3);
  near([height(player, writes)], [5], 1e-5, 'past the last frame there is nothing to mix towards');
  player.onPreUpdate(0.2);
  near([height(player, writes)], [1.5], 1e-4, 'loops');
  player.dispose();
  assert.equal(player.model.disposed, true, 'the player owns the mesh');
  assert.equal(engine.plugins.has(player.name), false);
  player.dispose();
});

test('a chunk of another topology swaps the mesh at its first frame, and the triangles change with it', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    file = encodeGeometryCache(10, [fan(4, 2), fan(6, 2, 2), fan(3, 2, 4)]),
    player = await GeometryCachePlayer.attach(engine, file, { loop: false, ahead: 3 }),
    p = player.model.primitives[0];
  await player.done;
  assert.equal(p.indices.length, 12);
  player.onPreUpdate(0.15);
  near([height(player, writes)], [1], 1e-5, 'holds the last frame of a chunk: there is no mesh to mix towards');
  assert.equal(player.stats.swaps, 0);
  player.onPreUpdate(0.05);
  assert.equal(player.stats.swaps, 1);
  assert.equal(p.indices.length, 18, 'the new triangles');
  assert.equal(p.vertices.length, 7 * 20);
  assert.ok(p.deformed.size >= 7 * 80, 'the output grew');
  assert.equal(writes.get(p.deformed).length, 7 * 20);
  near([height(player, writes)], [2], 1e-5);
  near([...player.bounds.subarray(2, 3), ...player.bounds.subarray(5, 6)], [2, 3], 1e-6, 'the chunk bounds');
  player.onPreUpdate(0.2);
  assert.equal(p.indices.length, 9, 'a smaller mesh too');
  assert.equal(writes.get(p.deformed).length, 4 * 20, 'uploads only its vertices');
  player.onPreUpdate(5);
  assert.equal(player.playing, false, 'stops at the end');
  near([height(player, writes)], [5], 1e-5, 'on the last frame');
  player.dispose();
});

test('the reader stays only `ahead` chunks in front, the clock waits for a late chunk, and played chunks go', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    file = encodeGeometryCache(10, Array.from({ length: 8 }, (_, i) => fan(3, 2, i * 2))),
    size = (file.length - 16) / 8,
    gates = [];
  let pulled = 0;
  async function* slow() {
    yield file.subarray(0, 16 + size);
    for (let i = 1; i < 8; i++) {
      pulled = i;
      await new Promise((resolve) => gates.push(resolve));
      yield file.subarray(16 + size * i, 16 + size * (i + 1));
    }
  }
  const player = await GeometryCachePlayer.attach(engine, () => slow(), { ahead: 2, loop: false });
  await settled();
  assert.equal(pulled, 1, 'waits at the second chunk');
  // The clock reaches the end of chunk 0 and waits: nothing has arrived.
  player.onPreUpdate(0.3);
  assert.equal(player.stats.stalls, 1);
  assert.ok(player.time < 0.21, 'time held');
  near([height(player, writes)], [0], 1e-5, 'the last frame stays up');
  gates.shift()();
  await settled();
  gates.shift()();
  await settled();
  await settled();
  assert.equal(player['chunks'].length, 3, 'two ahead of the one playing');
  assert.equal(gates.length, 0, 'then the reader sleeps, asking for no more');
  const before = pulled;
  await settled();
  assert.equal(pulled, before);
  player.onPreUpdate(0.2);
  near([height(player, writes)], [2], 1e-5);
  await settled();
  assert.equal(player['chunks'].some((c) => c.firstFrame === 0), false, 'a played chunk is let go');
  player.dispose();
  await player.done;
});

test('a source that can start again does, for a seek back and a loop; a stream keeps what it read', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    file = encodeGeometryCache(10, Array.from({ length: 4 }, (_, i) => fan(3, 2, i * 2)));
  let opened = 0;
  const player = await GeometryCachePlayer.attach(
    engine,
    () => {
      opened++;
      return file;
    },
    { ahead: 1 },
  );
  await settled();
  player.seek(0.65);
  for (let i = 0; i < 20 && Math.floor(height(player, writes)) !== 6; i++) {
    player.onPreUpdate(0);
    await settled();
  }
  near([height(player, writes)], [6.5], 1e-5);
  assert.equal(opened, 1);
  player.seek(0);
  player.onPreUpdate(0);
  assert.equal(height(player, writes), 0, 'the first chunk stays held for the next lap');
  assert.equal(opened, 1);
  // Regression: the chunk that was playing sat ahead of the clock and used up `ahead`, so the reader slept for good.
  player.seek(0.65).onPreUpdate(0);
  for (let i = 0; i < 20 && Math.floor(height(player, writes)) !== 6; i++) {
    player.onPreUpdate(0);
    await settled();
  }
  player.seek(0.25);
  for (let i = 0; i < 20 && Math.floor(height(player, writes)) !== 2; i++) {
    player.onPreUpdate(0);
    await settled();
  }
  near([height(player, writes)], [2.5], 1e-5);
  assert.equal(opened, 2, 'one more read, however many frames it took');
  assert.throws(() => player.seek(-1), /finite seconds/);
  assert.throws(() => player.onPreUpdate(NaN), /finite seconds/);
  player.dispose();

  const kept = await GeometryCachePlayer.attach(engine, pieces(file, 64), { ahead: 8 });
  await kept.done;
  kept.seek(0.65).onPreUpdate(0);
  kept.seek(0).onPreUpdate(0);
  assert.equal(height(kept, writes), 0, 'all of it is still here');
  assert.equal(kept['chunks'].length, 4);
  kept.dispose();
});

test('a loop wraps without waiting: the next lap reads while the first chunk plays', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    file = encodeGeometryCache(8, Array.from({ length: 4 }, (_, i) => fan(3, 2, i * 2)));
  let opened = 0;
  const player = await GeometryCachePlayer.attach(
    engine,
    () => {
      opened++;
      return file;
    },
    { ahead: 1 },
  );
  for (let lap = 0; lap < 3; lap++)
    for (let frame = 0; frame < 8; frame++) {
      await settled();
      await settled();
      player.onPreUpdate(frame || lap ? 0.125 : 0);
      near([height(player, writes)], [frame], 1e-4, `lap ${lap} frame ${frame}`);
    }
  assert.equal(player.stats.stalls, 0);
  assert.equal(opened, 3, 'one read a lap');
  player.dispose();

  // One chunk is all of it: nothing to read again.
  let once = 0;
  const small = await GeometryCachePlayer.attach(
    engine,
    () => {
      once++;
      return encodeGeometryCache(10, [fan(3, 4)]);
    },
    { ahead: 1 },
  );
  await small.done;
  small.onPreUpdate(1.05);
  await settled();
  assert.equal(once, 1);
  small.dispose();
});

test('a failure mid stream rejects done and leaves the last frame up; open rejects a bad start', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    file = encodeGeometryCache(10, [fan(3, 2), fan(3, 2, 2)]),
    size = (file.length - 16) / 2;
  async function* broken() {
    yield file.subarray(0, 16 + size);
    throw new Error('network gone');
  }
  const player = await GeometryCachePlayer.attach(engine, broken());
  await assert.rejects(player.done, /network gone/);
  assert.equal(player.failure.message, 'network gone');
  player.onPreUpdate(0.1);
  player.onPreUpdate(0.5);
  assert.equal(player.stats.stalls, 0, 'nothing to wait for');
  near([height(player, writes)], [1], 1e-5);
  player.dispose();

  const abort = new AbortController(),
    late = await GeometryCachePlayer.attach(engine, broken(), { signal: abort.signal });
  await assert.rejects(late.done, /network gone/);
  late.dispose();
  await assert.rejects(GeometryCachePlayer.attach(engine, new Uint8Array(4)), /ends inside a chunk/);
  await assert.rejects(GeometryCachePlayer.attach(engine, file, { ahead: 0 }), /ahead must be a whole number/);
  await assert.rejects(GeometryCachePlayer.attach(engine, file, { signal: AbortSignal.abort(new Error('no')) }), /no/);
});

test('a player needs WebGPU, and says so', async () => {
  const engine = new Engine(
    { width: 1, height: 1, getContext() {} },
    await TransformStore.create(8),
    { backend: 'webgl2', add() {}, remove() {}, dispose() {}, render() {} },
    undefined,
    null,
  );
  await assert.rejects(
    GeometryCachePlayer.attach(engine, encodeGeometryCache(10, [fan(3, 1)])),
    (error) => error.code === 'unsupported',
  );
});

test('after a device restore the mesh draws from a new buffer with the frame on show', async (t) => {
  const { engine, writes } = await gpuEngine(t),
    player = await GeometryCachePlayer.attach(engine, encodeGeometryCache(10, [fan(4, 4)]));
  player.onPreUpdate(0.1);
  const old = player.model.primitives[0].deformed;
  player.onDeviceRestored(engine);
  assert.notEqual(player.model.primitives[0].deformed, old);
  near([height(player, writes)], [1], 1e-5);
  player.dispose();
});
