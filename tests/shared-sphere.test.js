// shared/sphere.js worldRadius: the world radius every CPU sphere cull uses (clustered LocalShadows' per-map caster
// cull, the LOD imposter cull, gltf-pro's progressive load order). Regression: those took the longest column of the
// node matrix, which is short under shear (a rotated child of a non-uniformly scaled parent), so casters near a cube
// face's edge or range lost their shadow in that face.
import test from 'node:test';
import assert from 'node:assert/strict';
import { worldRadius } from '../packages/shared/sphere.js';

const rotation = (a, b) => {
  const [ca, sa, cb, sb] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)];
  return [ca, sa * cb, sa * sb, -sa, ca * cb, ca * sb, 0, -sb, cb];
};
const mul = (a, b) => {
  const out = new Array(9).fill(0);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) out[c * 3 + r] += a[k * 3 + r] * b[c * 3 + k];
  return out;
};
const matrix = (m3, at = [0, 0, 0]) => {
  const m = new Float32Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[c * 4 + r] = m3[c * 3 + r];
  m.set(at, 12);
  m[15] = 1;
  return m;
};
/** The farthest any point of the unit sphere moves from the centre under the 3x3 at `m` (sampled densely). */
function reach(m) {
  let best = 0;
  const n = 20000,
    golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n,
      r = Math.sqrt(1 - y * y),
      p = [Math.cos(golden * i) * r, y, Math.sin(golden * i) * r];
    best = Math.max(best, Math.hypot(...[0, 1, 2].map((k) => m[k] * p[0] + m[4 + k] * p[1] + m[8 + k] * p[2])));
  }
  return best;
}

test('worldRadius bounds a sphere under rotation, non-uniform scale and shear', () => {
  // Stretched along x by 4 under a 45-degree child turn: the longest column is 2.83, the sphere reaches 4.
  const sheared = matrix(mul([4, 0, 0, 0, 0.1, 0, 0, 0, 1], rotation(Math.PI / 4, 0)));
  const longestColumn = Math.max(...[0, 4, 8].map((o) => Math.hypot(sheared[o], sheared[o + 1], sheared[o + 2])));
  assert.ok(longestColumn < reach(sheared) - 1, 'the old bound is short here');
  assert.ok(worldRadius(sheared, 0, 1) >= reach(sheared));
  let seed = 99;
  const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < 200; i++) {
    const s = [0.05 + 4 * Math.abs(rand()), 0.05 + 4 * Math.abs(rand()), 0.05 + 4 * Math.abs(rand())],
      m3 = mul(
        rotation(4 * rand(), 4 * rand()),
        mul([s[0], 0, 0, 0, s[1], 0, 0, 0, s[2]], rotation(4 * rand(), 4 * rand())),
      ),
      m = matrix(m3, [100 * rand(), 100 * rand(), 100 * rand()]),
      r = 0.1 + Math.abs(rand());
    assert.ok(worldRadius(m, 0, r) >= reach(m) * r, `matrix ${i}`);
  }
  // Exact, but for the float32 pad, under rotation and scale (read at an offset into a matrix array).
  const turned = matrix(mul([2, 0, 0, 0, 2, 0, 0, 0, 2], rotation(0.7, 1.1))),
    store = new Float32Array(32);
  store.set(turned, 16);
  const radius = worldRadius(store, 16, 1.5, 3, 4, 0);
  assert.ok(radius >= 3 && radius <= 3.0002, String(radius));
  // The float32 pad grows with the distance from the origin.
  assert.ok(worldRadius(turned, 0, 1, 1e4, 0, 0) - worldRadius(turned, 0, 1) > 0.09);
});
