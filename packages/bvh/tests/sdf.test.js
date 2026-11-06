import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '../dist/tree.js';
import { MeshSDF, bakeSDF, bakeSDFAsync } from '../dist/sdf.js';

function sphere(segments = 48, rings = 32, radius = 1) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const phi = (Math.PI * r) / rings,
        theta = (2 * Math.PI * (s % segments)) / segments;
      positions.push(
        radius * Math.sin(phi) * Math.cos(theta),
        radius * Math.cos(phi),
        -radius * Math.sin(phi) * Math.sin(theta),
      );
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return MeshBVH.build({ positions, indices });
}

function cube(half = 1, flip = false) {
  const positions = [];
  for (const x of [-half, half]) for (const y of [-half, half]) for (const z of [-half, half]) positions.push(x, y, z);
  const quads = [
      [0, 1, 3, 2],
      [4, 6, 7, 5],
      [0, 4, 5, 1],
      [2, 3, 7, 6],
      [0, 2, 6, 4],
      [1, 5, 7, 3],
    ],
    indices = [];
  for (const [a, b, c, d] of quads) indices.push(...(flip ? [a, c, b, a, d, c] : [a, b, c, a, c, d]));
  return MeshBVH.build({ positions, indices });
}

test('a sphere bakes the distance to its surface, negative inside', () => {
  const sdf = bakeSDF(sphere(), { resolution: 24 }),
    [sx, sy, sz] = sdf.size;
  assert.deepEqual(sdf.size, [24, 24, 24]);
  let worst = 0;
  for (let z = 0; z < sz; z++)
    for (let y = 0; y < sy; y++)
      for (let x = 0; x < sx; x++) {
        const p = [x, y, z].map((v, k) => sdf.min[k] + v * sdf.spacing[k]),
          exact = Math.hypot(...p) - 1;
        worst = Math.max(worst, Math.abs(sdf.data[x + y * sx + z * sx * sy] - exact));
      }
  assert.ok(worst < 0.02, `worst sample ${worst}`);
  assert.ok(sdf.distance([0, 0, 0]) < -0.9);
  assert.ok(sdf.distance([1.15, 0, 0]) > 0.1);
});

test('samples read back exactly on the grid and linearly between', () => {
  const data = Float32Array.from({ length: 27 }, (_, i) => i),
    sdf = new MeshSDF(data, [3, 3, 3], [0, 0, 0], [2, 2, 2]);
  assert.equal(sdf.distance([1, 1, 1]), 13);
  assert.equal(sdf.distance([2, 2, 2]), 26);
  assert.equal(sdf.distance([0.5, 0, 0]), 0.5);
  assert.equal(sdf.distance([0, 0.5, 0]), 1.5);
  assert.equal(sdf.distance([0, 0, 0.5]), 4.5);
  assert.equal(sdf.distance([2, 1, 1]), 14, 'the far face reads its own sample');
  assert.throws(() => new MeshSDF(data, [2, 2, 2], [0, 0, 0], [1, 1, 1]), RangeError);
});

test('outside the grid the way to the grid adds on', () => {
  const sdf = bakeSDF(cube(), { resolution: 9, padding: 0.25 }),
    edge = sdf.max[0];
  assert.ok(Math.abs(sdf.distance([edge + 3, 0, 0]) - (edge - 1 + 3)) < 1e-5);
});

test('the gradient points away from the surface and project lands on it', () => {
  const sdf = bakeSDF(sphere(), { resolution: 32 });
  for (const p of [
    [1.1, 0.2, 0.1],
    [0.3, -0.4, 0.5],
    [-0.1, 0.1, -1.15],
  ]) {
    const n = sdf.gradient(p),
      length = Math.hypot(...p),
      dot = (n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / length;
    assert.ok(dot > 0.99, `gradient ${n} at ${p}: ${dot}`);
    assert.ok(Math.abs(Math.hypot(...sdf.project(p)) - 1) < 0.02);
  }
  assert.deepEqual(new MeshSDF(new Float32Array(8), [2, 2, 2], [0, 0, 0], [1, 1, 1]).gradient([0.5, 0.5, 0.5]), [0, 0, 0]);
});

test('resolution keeps cells cubic on a long box, or takes three numbers', () => {
  const positions = [0, 0, 0, 8, 0, 0, 0, 2, 0, 0, 0, 1],
    indices = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    bvh = MeshBVH.build({ positions, indices }),
    sdf = bakeSDF(bvh, { resolution: 17, padding: 0 });
  assert.equal(sdf.size[0], 17);
  assert.ok(Math.abs(sdf.spacing[0] - sdf.spacing[1]) < 0.1);
  assert.deepEqual(bakeSDF(bvh, { resolution: [3, 4, 5] }).size, [3, 4, 5]);
});

test('a flat mesh gets a box with thickness, and bounds bake only that box', () => {
  const plane = MeshBVH.build({ positions: [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], indices: [0, 1, 2, 0, 2, 3] }),
    sdf = bakeSDF(plane, { signed: false, resolution: 9 });
  assert.ok(sdf.max[2] > sdf.min[2]);
  assert.ok(Math.abs(sdf.distance([0, 0, 0.1]) - 0.1) < 1e-2);
  assert.ok(Math.abs(sdf.distance([0, 0, -0.1]) - 0.1) < 1e-2, 'no sign on an open mesh');
  const part = bakeSDF(cube(), { bounds: { min: [0, 0, 0], max: [2, 2, 2] }, resolution: 5 });
  assert.deepEqual(part.min, [0, 0, 0]);
  assert.deepEqual(part.max, [2, 2, 2]);
});

test('a small hole leaves the inside inside, which ray parity would lose', () => {
  const whole = cube();
  const indices = [...whole.index].slice(3),
    positions = [...whole.positions],
    holed = MeshBVH.build({ positions, indices });
  const sdf = bakeSDF(holed, { resolution: 9, accuracy: Infinity });
  assert.ok(sdf.distance([0.2, 0.2, 0.2]) < 0);
});

test('the async bake answers the same samples, reports progress and can stop', async () => {
  const bvh = sphere(24, 16),
    options = { resolution: 16 },
    seen = [],
    sdf = await bakeSDFAsync(bvh, { ...options, onProgress: (done) => seen.push(done) });
  assert.deepEqual(sdf.data, bakeSDF(bvh, options).data);
  assert.equal(seen.at(-1), 1);
  assert.ok(seen.every((value, i) => i === 0 || value >= seen[i - 1]));
  await assert.rejects(bakeSDFAsync(bvh, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  const controller = new AbortController();
  await assert.rejects(
    bakeSDFAsync(bvh, { resolution: 48, signal: controller.signal, onProgress: () => controller.abort() }),
    { name: 'AbortError' },
  );
});

test('bad settings say what to pass', () => {
  const bvh = cube();
  assert.throws(() => bakeSDF(bvh, { resolution: 1 }), RangeError);
  assert.throws(() => bakeSDF(bvh, { resolution: [2, 2, 2.5] }), RangeError);
  assert.throws(() => bakeSDF(bvh, { padding: -1 }), RangeError);
  assert.throws(() => bakeSDF(bvh, { accuracy: 0 }), RangeError);
  assert.throws(() => bakeSDF(bvh, { bounds: { min: [0, 0, 0], max: [0, 1, 1] } }), RangeError);
});

test('toTexture uploads half floats by default and full floats on request', () => {
  const writes = [],
    device = {
      limits: { maxTextureDimension3D: 2048 },
      createTexture: (descriptor) => ({ descriptor }),
      queue: { writeTexture: (target, data, layout, size) => writes.push({ target, data, layout, size }) },
    };
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, STORAGE_BINDING: 8, COPY_DST: 2, COPY_SRC: 1 };
  const values = [0, 1, -2, 0.5, 65504, 1e9, 1e-7, -0.000061035156],
    sdf = new MeshSDF(Float32Array.from(values), [2, 2, 2], [0, 0, 0], [1, 1, 1]),
    texture = sdf.toTexture(device);
  assert.equal(texture.descriptor.format, 'r16float');
  assert.equal(texture.descriptor.dimension, '3d');
  assert.deepEqual([...writes[0].data], [0, 0x3c00, 0xc000, 0x3800, 0x7bff, 0x7bff, 0x0002, 0x8400]);
  assert.equal(writes[0].layout.bytesPerRow, 4);
  sdf.toTexture(device, { format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING });
  assert.equal(writes[1].data, sdf.data);
  assert.equal(writes[1].layout.bytesPerRow, 8);
  assert.throws(() => sdf.toTexture(device, { format: 'rgba8unorm' }), TypeError);
  assert.throws(() => sdf.toTexture({ ...device, limits: { maxTextureDimension3D: 1 } }), RangeError);
});
