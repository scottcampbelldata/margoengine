// Animated tiles: the pure frame evaluator and the animator that uploads only the tiles whose frame changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Material, createMesh, tileAnimationFrame, tileAnimator } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const corners = (u) => [u, 0, u + 0.1, 0, u + 0.1, 0.1, u, 0.1];
// Binary-exact durations, so boundaries are exact: frames cover [0, 0.25), [0.25, 0.75), [0.75, 1).
const blink = { frames: [0.25, 0.5, 0.25].map((duration, i) => ({ duration, uvs: corners(i / 4) })) };

test('tileAnimationFrame switches on frame boundaries, loops both ways and honours start frames and seconds', () => {
  const at = (t, start) => tileAnimationFrame(blink, t, start);
  assert.deepEqual(
    [0, 0.2499, 0.25, 0.7499, 0.75, 0.9999, 1, 2.3, -0.25, -1].map((t) => at(t)),
    [0, 0, 1, 1, 2, 2, 0, 1, 2, 0],
  );
  assert.deepEqual(
    [0, 0.5, 0.75].map((t) => at(t, { frame: 1 })),
    [1, 2, 0],
    'start frame 1 begins 0.25 s in',
  );
  assert.deepEqual(
    [0, 0.2, 0.45].map((t) => at(t, { seconds: 0.8 })),
    [2, 0, 1],
  );
  assert.equal(tileAnimationFrame({ frames: [{ duration: 3, uvs: corners(0) }] }, 1e9), 0, 'one frame never changes');
  for (const duration of [0, -1, Number.NaN, Infinity])
    assert.throws(() => tileAnimationFrame({ frames: [{ duration, uvs: corners(0) }] }, 0), RangeError);
  assert.throws(() => tileAnimationFrame({ frames: [] }, 0), RangeError);
  assert.throws(() => at(Number.NaN), RangeError);
  assert.throws(() => at(0, { frame: 3 }), RangeError);
  assert.throws(() => at(0, { frame: 0.5 }), RangeError);
  assert.throws(() => at(0, { seconds: Infinity }), RangeError);
  assert.throws(() => tileAnimationFrame({}, 0), TypeError);
});

test('tileAnimator uploads only the vertices of tiles whose frame changed, merging neighbouring tiles', async () => {
  const h = optionalGPU(),
    device = h.engine.gpu,
    writes = [];
  device.queue.writeBuffer = (buffer, offset, data, dataOffset = 0, size = data.length - dataOffset) => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset + dataOffset * 4, size * 4);
    writes.push([offset, bytes.byteLength]);
    new Uint8Array(buffer.data).set(bytes, offset);
  };
  const engine = new Engine(
    { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  try {
    const geometry = { positions: [], normals: [], uvs: new Float32Array(24) };
    for (let i = 0; i < 12; i++) geometry.positions.push(i, i % 3, 0), geometry.normals.push(0, 0, 1);
    const mesh = createMesh(engine, geometry, new Material()),
      slow = { frames: [1, 1].map((duration, i) => ({ duration, uvs: corners(0.5 + i / 4) })) },
      play = tileAnimator(mesh, geometry, [
        { vertex: 0, animation: blink },
        { vertex: 4, animation: slow },
        { vertex: 8, animation: blink },
      ]);
    writes.length = 0;
    assert.equal(play(0), 3);
    assert.deepEqual(writes, [[0, 12 * 80]], 'the first call writes every tile, adjacent tiles as one range');
    writes.length = 0;
    assert.equal(play(0.1), 0);
    assert.deepEqual(writes, [], 'no frame changed, nothing uploads');
    assert.equal(play(0.3), 2);
    assert.deepEqual(
      writes,
      [
        [0, 320],
        [8 * 80, 320],
      ],
      'the unchanged middle tile splits the upload',
    );
    const vertices = mesh.primitives[0].vertices;
    assert.deepEqual([...geometry.uvs.slice(16, 24)], [...new Float32Array(corners(0.25))]);
    assert.deepEqual([vertices[8 * 20 + 12], vertices[11 * 20 + 13]], [0.25, Math.fround(0.1)]);
    writes.length = 0;
    assert.equal(play(1), 3, 'blink loops to frame 0 while slow reaches frame 1');
    assert.deepEqual(writes, [[0, 12 * 80]]);
    assert.throws(() => tileAnimator(mesh, geometry, [{ vertex: 9, animation: blink }]), RangeError);
    assert.throws(
      () => tileAnimator(mesh, geometry, [{ vertex: 0, animation: { frames: [{ duration: 1, uvs: [0, 0] }] } }]),
      RangeError,
    );
    assert.throws(() => tileAnimator({}, geometry, []), TypeError);
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
