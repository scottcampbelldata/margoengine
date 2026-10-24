// Half-block shapes (TraceModel.shapes): slabs and stairs are hit on their boxes by the traversal the shader shares
// (traverse.ts), packed into shaped bricks for dense and sparse models, and checked like the voxels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeEngine, materials, simpleScene } from './support.js';

const random = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const attach = (scene) => VoxelPathTracer.attach(fakeEngine().engine, { scene });
// Octant masks (bit x + 2y + 4z), as @margoengine/voxel's shapeOctants gives them.
const SLAB = 0x33,
  TOP_SLAB = 0xcc,
  STAIR_X = 0xbb; // a stair with its back toward +x
const index = (size, x, y, z) => x + size[0] * (z + size[2] * y);
const scene = (models) =>
  simpleScene({
    models,
    instances: models.map((m) => ({
      id: m.id,
      modelId: m.id,
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    })),
    materials: materials([1, 2]),
  });

test('raycast meets slab tops, stair risers and the far side of a slab open part', () => {
  const size = [8, 4, 4],
    voxels = new Uint8Array(8 * 4 * 4),
    shapes = new Uint8Array(voxels.length),
    put = (x, y, z, v, shape = 0) => {
      voxels[index(size, x, y, z)] = v;
      shapes[index(size, x, y, z)] = shape;
    };
  put(1, 1, 1, 1, SLAB);
  put(4, 1, 1, 2, STAIR_X);
  put(6, 1, 1, 1, TOP_SLAB);
  put(7, 1, 1, 1); // a whole cell, its shape 0
  const tracer = attach(scene([{ id: 'm', revision: 1, size, voxels, shapes }]));
  let hit = tracer.raycast([1.5, 10, 1.5], [0, -1, 0]);
  assert.deepEqual([hit.cell, hit.normal, hit.distance, hit.paletteIndex], [[1, 1, 1], [0, 1, 0], 8.5, 1]);
  // Through the slab's open upper half and the stair's open front quarter to its riser at x 4.5.
  hit = tracer.raycast([-1, 1.75, 1.5], [1, 0, 0]);
  assert.deepEqual([hit.cell, hit.normal, hit.point, hit.paletteIndex], [[4, 1, 1], [-1, 0, 0], [4.5, 1.75, 1.5], 2]);
  // Under the top slab: its underside at y 1.5.
  hit = tracer.raycast([6.5, 0.2, 1.5], [0, 1, 0]);
  assert.deepEqual([hit.cell, hit.normal, hit.distance], [[6, 1, 1], [0, -1, 0], 1.3]);
  // Below the top slab, sideways: the whole cell behind it.
  hit = tracer.raycast([5.2, 1.25, 1.5], [1, 0, 0]);
  assert.deepEqual(
    [hit.cell, hit.normal],
    [
      [7, 1, 1],
      [-1, 0, 0],
    ],
  );
  tracer.dispose();
});

test('raycast matches a box-by-box oracle on random shaped models, dense and as blocks', () => {
  const masks = [0, SLAB, TOP_SLAB, STAIR_X, 0x77, 0xf3, 0x3f, 0xee, 0xdd, 0xfc, 0xcf];
  for (let seed = 1; seed <= 4; seed++) {
    const next = random(seed),
      size = [13, 11, 9],
      voxels = new Uint8Array(13 * 11 * 9),
      shapes = new Uint8Array(voxels.length);
    for (let i = 0; i < voxels.length; i++)
      if (next() < 0.25) {
        voxels[i] = 1 + Math.floor(next() * 2);
        shapes[i] = masks[Math.floor(next() * masks.length)];
      }
    // The same contents as two overlapping blocks (the second wins where they overlap).
    const window = (x0, x1) => {
        const n = [x1 - x0, 11, 9],
          v = new Uint8Array(n[0] * 11 * 9),
          s = new Uint8Array(v.length);
        for (let y = 0; y < 11; y++)
          for (let z = 0; z < 9; z++)
            for (let x = x0; x < x1; x++) {
              v[index(n, x - x0, y, z)] = voxels[index(size, x, y, z)];
              s[index(n, x - x0, y, z)] = shapes[index(size, x, y, z)];
            }
        return { origin: [x0, 0, 0], size: n, voxels: v, shapes: s };
      },
      tracers = [
        attach(scene([{ id: 'dense', revision: 1, size, voxels, shapes }])),
        attach(scene([{ id: 'blocks', revision: 1, size, blocks: [window(0, 9), window(6, 13)] }])),
      ];
    // Oracle: the nearest filled octant box along the ray.
    const oracle = (o, d) => {
      let best = Infinity,
        normal = null;
      for (let y = 0; y < 11; y++)
        for (let z = 0; z < 9; z++)
          for (let x = 0; x < 13; x++) {
            const i = index(size, x, y, z);
            if (!voxels[i]) continue;
            const mask = shapes[i] || 255;
            for (let k = 0; k < 8; k++) {
              if (!((mask >> k) & 1)) continue;
              const lo = [x + (k & 1) / 2, y + ((k >> 1) & 1) / 2, z + ((k >> 2) & 1) / 2];
              let t0 = -Infinity,
                t1 = Infinity,
                axis = -1;
              for (let a = 0; a < 3; a++) {
                const ta = (lo[a] - o[a]) / d[a],
                  tb = (lo[a] + 0.5 - o[a]) / d[a],
                  near = Math.min(ta, tb);
                if (near > t0) (t0 = near), (axis = a);
                t1 = Math.min(t1, Math.max(ta, tb));
              }
              if (t0 < t1 && t0 > 0 && t0 < best) {
                best = t0;
                normal = [0, 0, 0];
                normal[axis] = -Math.sign(d[axis]);
              }
            }
          }
      return { best, normal };
    };
    for (let r = 0; r < 300; r++) {
      const o = [-2 + next() * 17, 14, -2 + next() * 13],
        target = [next() * 13, next() * 11, next() * 9],
        d = target.map((v, a) => v - o[a]),
        length = Math.hypot(...d),
        want = oracle(o, d);
      for (const tracer of tracers) {
        const got = tracer.raycast(o, d);
        if (want.best === Infinity) {
          assert.equal(got, null, `ray ${r} of seed ${seed}`);
          continue;
        }
        assert.ok(got, `ray ${r} of seed ${seed} hits`);
        assert.ok(
          Math.abs(got.distance - want.best * length) < 1e-6,
          `ray ${r}: ${got.distance} vs ${want.best * length}`,
        );
        assert.deepEqual(got.normal, want.normal, `ray ${r} normal`);
      }
    }
    for (const tracer of tracers) tracer.dispose();
  }
});

test('shapes are checked: a Uint8Array of one mask per cell', () => {
  const tracer = attach(scene([{ id: 'm', revision: 1, size: [2, 2, 2], voxels: new Uint8Array(8).fill(1) }]));
  const bad = (shapes) => () =>
    tracer.setScene(scene([{ id: 'm', revision: 2, size: [2, 2, 2], voxels: new Uint8Array(8).fill(1), shapes }]));
  assert.throws(bad([0, 0, 0, 0, 0, 0, 0, 0]), TypeError);
  assert.throws(bad(new Uint8Array(7)), TypeError);
  // A model whose every cell is the same slab packs as a shaped brick, never a uniform one.
  tracer.setScene(
    scene([
      {
        id: 'm',
        revision: 3,
        size: [2, 2, 2],
        voxels: new Uint8Array(8).fill(1),
        shapes: new Uint8Array(8).fill(SLAB),
      },
    ]),
  );
  assert.equal(tracer.raycast([0.25, 5, 0.25], [0, -1, 0]).distance, 5 - 1.5);
  tracer.dispose();
});
