// Raw indices are checked before Uint32 conversion (which would wrap -1 and truncate 1.5) and before a worker
// build moves the caller's buffers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH, buildBVH, buildAsync, terminateBVHWorker } from '../dist/index.js';

const positions = () => Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0]);
const bad = [NaN, Infinity, -1, 1.5, 2 ** 32, undefined, '1'];

test('invalid raw indices are refused by build and buildAsync', async () => {
  for (const value of bad) {
    assert.throws(() => MeshBVH.build({ positions: positions(), indices: [value, 1, 2] }), RangeError, String(value));
    await assert.rejects(buildAsync({ positions: positions(), indices: [value, 1, 2] }), RangeError, String(value));
  }
  for (const indices of [[], Array(3), [, 1, 2]])
    assert.throws(() => MeshBVH.build({ positions: positions(), indices }), RangeError);
});

test('valid index arrays of any type build the same triangle; Uint32 input is used as is', () => {
  for (const indices of [[0, 1, 2], Uint16Array.of(0, 1, 2), Float64Array.of(0, 1, 2), { 0: 0, 1: 1, 2: 2, length: 3 }])
    assert.deepEqual([...MeshBVH.build({ positions: positions(), indices }).index], [0, 1, 2]);
  const indices = Uint32Array.of(0, 1, 2),
    p = positions();
  assert.equal(MeshBVH.build({ positions: p, indices }).positions, p);
  assert.deepEqual([...MeshBVH.build({ positions: p.slice(0, 9) }).index], [0, 1, 2]);
});

// A stand-in Worker that runs buildBVH on a structured clone, counting posts and transferred buffers.
async function workerHost(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const stats = { construct: 0, post: 0, transfer: 0 };
  class RecordingWorker {
    constructor() {
      stats.construct++;
    }
    postMessage(message, list) {
      stats.post++;
      stats.transfer += list.length;
      const data = structuredClone(message, { transfer: list });
      queueMicrotask(() => {
        try {
          const built = buildBVH(data.positions, data.stride, data.indices, data.options);
          this.onmessage?.({
            data: {
              id: data.id,
              ...built,
              positions: data.returnSource ? data.positions : null,
              indices: data.returnSource ? data.indices : null,
            },
          });
        } catch (error) {
          this.onmessage?.({ data: { id: data.id, error: String(error) } });
        }
      });
    }
    terminate() {}
  }
  terminateBVHWorker();
  Object.defineProperty(globalThis, 'Worker', { value: RecordingWorker, writable: true, configurable: true });
  try {
    return await run(stats);
  } finally {
    terminateBVHWorker();
    if (previous) Object.defineProperty(globalThis, 'Worker', previous);
    else delete globalThis.Worker;
  }
}
test('a worker build refuses bad input before moving the caller buffers', async () => {
  await workerHost(async (stats) => {
    for (const [indices, edit] of [
      [[NaN, 1, 2]],
      [Uint32Array.of(0, 1, 4)],
      [Uint32Array.of(0, 1, 2), (p) => (p[0] = Infinity)],
    ]) {
      const p = positions();
      edit?.(p);
      await assert.rejects(buildAsync({ positions: p, indices }, { transfer: true }), RangeError);
      assert.equal(p.byteLength, 48);
    }
    const buffer = new ArrayBuffer(72),
      p = new Float32Array(buffer, 0, 9),
      shared = new Uint32Array(buffer, 36, 3);
    p.set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    shared.set([0, 1, 2]);
    await assert.rejects(
      buildAsync({ positions: p, normals: new Float64Array(buffer, 0, 9), indices: [0, 1, 2] }, { transfer: true }),
      TypeError,
    );
    await assert.rejects(
      buildAsync(
        { positions: positions().slice(0, 9), normals: new Uint8Array(buffer, 0, 9), indices: shared },
        { transfer: true },
      ),
      TypeError,
    );
    assert.equal(p.byteLength, 36);
    assert.deepEqual(stats, { construct: 0, post: 0, transfer: 0 });
  });
});

test('a valid worker build moves the positions and Uint32 indices, and copies other index types', async () => {
  await workerHost(async () => {
    const p = positions(),
      indices = Uint32Array.of(0, 1, 2);
    assert.deepEqual([...(await buildAsync({ positions: p, indices }, { transfer: true })).index], [0, 1, 2]);
    assert.equal(p.byteLength, 0);
    assert.equal(indices.byteLength, 0);
    const small = Uint16Array.of(0, 1, 2);
    await buildAsync({ positions: positions(), indices: small }, { transfer: true });
    assert.equal(small.byteLength, 6);
  });
});
