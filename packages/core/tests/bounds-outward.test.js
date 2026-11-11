import test from 'node:test';
import assert from 'node:assert/strict';
import { Geometry, TransformStore } from '../dist/extension.js';

// Positions at 2^24 + k: float32 stores 2^24 + 1 as 2^24 and 2^24 + 3 as 2^24 + 4, so a sphere measured on the
// float64 inputs (centre 2^24 + 2, radius 1) misses the stored vertices by 1.
const big = 2 ** 24,
  up = [0, 1, 0, 0, 1, 0, 0, 1, 0],
  geometry = new Geometry([big + 1, 0, 0, big + 3, 0, 0, big + 2, 0.5, 0], up, [0, 1, 2]),
  // Centre (0.5, 0, 0), radius 1, exact; moved by 2^24 and scaled by 3 the centre 2^24 + 1.5 rounds to 2^24 + 2.
  local = new Geometry([-0.5, 0, 0, 1.5, 0, 0, 0.5, 0.5, 0], up, [0, 1, 2]);

test('a geometry bounding sphere holds every stored float32 vertex', () => {
  const [x, y, z, r] = geometry.bounds;
  for (let i = 0; i < 3; i++) {
    const v = geometry.vertices.subarray(i * 6, i * 6 + 3);
    assert.ok(Math.hypot(v[0] - x, v[1] - y, v[2] - z) <= r, `vertex ${i} (${[...v]}) outside ${[x, y, z, r]}`);
  }
});

test('the kernel world sphere holds every transformed stored vertex (translation 2^24, scale 3)', async () => {
  const store = await TransformStore.create(4),
    id = 0;
  try {
    store.active[id] = 1;
    const t = store.transforms;
    t.x[id] = big;
    t.qw[id] = 1;
    t.sx[id] = t.sy[id] = t.sz[id] = 3;
    store.parents[id] = -1;
    store.bounds.set(local.bounds, id * 4);
    store.tick(false);
    // World spheres follow the local ones (columns 31 to 34 of packages/kernel/src/lib.rs, one value per entity).
    const world = new Float32Array(store.bounds.buffer, store.bounds.byteOffset + 4 * store.capacity * 4, 4 * store.capacity),
      [cx, cy, cz, r] = [0, 1, 2, 3].map((k) => world[k * store.capacity + id]),
      m = store.matrices.subarray(id * 16, id * 16 + 16);
    for (let i = 0; i < 3; i++) {
      const v = local.vertices.subarray(i * 6, i * 6 + 3),
        p = [0, 1, 2].map((k) => m[k] * v[0] + m[4 + k] * v[1] + m[8 + k] * v[2] + m[12 + k]);
      assert.ok(Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) <= r, `vertex ${i} outside the world sphere`);
    }
  } finally {
    store.dispose();
  }
});
