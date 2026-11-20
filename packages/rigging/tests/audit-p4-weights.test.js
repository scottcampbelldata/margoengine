// Audit p4 regressions for automatic rigs and weights (R10 to R16).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { WeightMap } from '../dist/index.js';
import { voxelWeights } from '../dist/voxel-weights.js';
import { transferWeights } from '../dist/transfer.js';
import { autoRig } from '../dist/autorig.js';
import { jointHulls } from '../dist/hulls.js';
import { weld } from '../src/mesh.ts';
import { chain, merge, tube } from './fixtures.js';

const row = (weights, v) => Array.from(weights.values.subarray(v * weights.boneCount, (v + 1) * weights.boneCount));

test('R10: a mirror-symmetric mesh and rig get mirror-equal voxel weights', async () => {
  const left = tube({ cx: -0.4 }),
    right = tube({ cx: 0.4 }),
    mesh = merge(left, right),
    joints = [
      { name: 'hips', parent: -1, position: [0, 2.3, 0] },
      { name: 'left', parent: 0, position: [-0.4, 2, 0] },
      { name: 'leftEnd', parent: 1, position: [-0.4, 0, 0] },
      { name: 'right', parent: 0, position: [0.4, 2, 0] },
      { name: 'rightEnd', parent: 3, position: [0.4, 0, 0] },
    ],
    // 1.2 / (2.3 / 64) cells across: not a whole number, so an uncentred grid has its spare part on one side only.
    { weights } = await voxelWeights(mesh, joints, { resolution: 64, skip: ['hips'] }),
    count = left.positions.length / 3,
    p = mesh.positions;
  let worst = 0;
  for (let v = 0; v < count; v++) {
    let mirror = -1;
    for (let u = count; u < 2 * count; u++)
      if (
        Math.abs(p[u * 3] + p[v * 3]) < 1e-6 &&
        Math.abs(p[u * 3 + 1] - p[v * 3 + 1]) < 1e-6 &&
        Math.abs(p[u * 3 + 2] - p[v * 3 + 2]) < 1e-6
      )
        mirror = u;
    assert.ok(mirror >= 0, `vertex ${v} has a mirror`);
    const a = row(weights, v),
      b = row(weights, mirror);
    worst = Math.max(worst, Math.abs(a[1] - b[3]), Math.abs(a[2] - b[4]));
  }
  assert.ok(worst < 1e-6, `mirror vertices differ by ${worst}`);
});

test('R11: a steep falloff keeps every row finite and summing to 1', async () => {
  for (const falloff of [200, 2000]) {
    const { weights } = await voxelWeights(tube(), chain, { resolution: 24, falloff });
    for (let v = 0; v < weights.vertexCount; v++) {
      const r = row(weights, v),
        sum = r.reduce((a, b) => a + b);
      assert.ok(r.every(Number.isFinite) && Math.abs(sum - 1) < 1e-5, `falloff ${falloff} vertex ${v}: ${r}`);
    }
  }
});

test('R12: the transfer fill reaches the harmonic answer along a long strip', async () => {
  // A flat zigzag strip along x: vertex k at (k / 2, 0, k mod 2), triangles (k, k + 1, k + 2), so every inner vertex
  // has edges to k +- 1 (length sqrt 1.25) and k +- 2 (length 1). Only its four end vertices on each side lie on the
  // source, two patches carrying bone 0 (left) and bone 1 (right); the 393 between are filled.
  const n = 401,
    positions = [],
    indices = [];
  for (let k = 0; k < n; k++) positions.push(k / 2, 0, k % 2);
  for (let k = 0; k + 2 < n; k++) indices.push(...(k % 2 ? [k + 1, k, k + 2] : [k, k + 1, k + 2]));
  const patch = (x0, x1) => [x0, 0, -0.5, x1, 0, -0.5, x1, 0, 1.5, x0, 0, 1.5],
    source = {
      positions: Float32Array.from([...patch(-1, 1.6), ...patch(198.4, 201)]),
      indices: Uint32Array.of(0, 2, 1, 0, 3, 2, 4, 6, 5, 4, 7, 6),
      weights: new WeightMap(8, 2, [1, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0, 1]),
    };
  const { weights, filled } = await transferWeights(
    source,
    { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
    { maxDistance: 0.001 },
  );
  assert.equal(filled, n - 8);
  // The exact answer: sum_j w_ij (x_i - x_j) = 0 at every open vertex, by Gaussian elimination.
  const open = n - 8,
    a = Array.from({ length: open }, () => new Float64Array(open + 1)),
    edges = [
      [1, 1 / Math.sqrt(1.25)],
      [2, 1],
    ];
  for (let r = 0; r < open; r++) {
    const k = r + 4;
    for (const [step, w] of edges)
      for (const j of [k - step, k + step]) {
        a[r][r] += w;
        if (j >= 4 && j < n - 4) a[r][j - 4] -= w;
        else if (j >= n - 4) a[r][open] += w; // a matched vertex with bone 1 = 1
      }
  }
  for (let c = 0; c < open; c++)
    for (let r = c + 1; r < Math.min(open, c + 3); r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k <= open; k++) a[r][k] -= f * a[c][k];
    }
  const exact = new Float64Array(open);
  for (let r = open - 1; r >= 0; r--) {
    let sum = a[r][open];
    for (let k = r + 1; k < Math.min(open, r + 3); k++) sum -= a[r][k] * exact[k];
    exact[r] = sum / a[r][r];
  }
  let worst = 0;
  for (let r = 0; r < open; r++) worst = Math.max(worst, Math.abs(weights.get(r + 4, 1) - exact[r]));
  assert.ok(worst < 1e-3, `the fill is ${worst} from the harmonic answer`);
});

test('R13: a forward along up is refused with a RangeError, not a NaN rig', async () => {
  for (const forward of [
    [0, 2, 0],
    [0, -1, 0],
    [0, Infinity, 0],
  ])
    await assert.rejects(autoRig(tube(), { forward, weights: 'none' }), { name: 'RangeError' });
});

test('R14: the jointHulls TSDoc example runs as written and gives the two hulls it claims', () => {
  const source = readFileSync(new URL('../src/hulls.ts', import.meta.url), 'utf8'),
    block = source.slice(source.indexOf('```ts', source.indexOf('The convex hull of the vertices each joint')));
  const code = block
    .slice(5, block.indexOf('```', 5))
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, ''))
    .filter((line) => !line.startsWith('import '))
    .join('\n');
  assert.match(code, /hulls\.length; \/\/ 2/);
  const hulls = new Function('jointHulls', `${code}\nreturn hulls;`)(jointHulls);
  assert.equal(hulls.length, 2);
  assert.equal(hulls[1].joint, 1);
});

test('R15: toInfluences refuses a non-finite weight and reads a negative one as 0', () => {
  assert.throws(() => new WeightMap(1, 2, [Infinity, 0]).toInfluences(), /not finite; call normalize/);
  assert.throws(() => new WeightMap(1, 2, [NaN, 1]).toInfluences(), RangeError);
  const { joints, weights } = new WeightMap(1, 3, [0.5, -0.2, 0.5]).toInfluences(2);
  assert.deepEqual(Array.from(joints), [0, 2]);
  assert.deepEqual(Array.from(weights), [0.5, 0.5]);
});

test('R16: welding joins points closer than the tolerance across a cell boundary, and only those', () => {
  const size = Math.SQRT2,
    reach = 0.01 * size,
    near = (gap) => {
      const middle = reach / 2;
      return weld(
        {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, middle - gap / 2, 0.5, 0.5, middle + gap / 2, 0.5, 0.5],
          indices: [0, 1, 2, 3, 4, 0],
        },
        0.01,
      );
    };
  // 2e-4 apart around x = reach / 2, where rounding by reach puts them in different cells.
  assert.equal(near(2e-4).point[3], near(2e-4).point[4]);
  assert.equal(near(0.9 * reach).point[3], near(0.9 * reach).point[4]);
  assert.notEqual(near(1.1 * reach).point[3], near(1.1 * reach).point[4]);
  const exact = weld({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], indices: [0, 1, 2, 3, 1, 2] }, 0);
  assert.deepEqual(Array.from(exact.point), [0, 1, 2, 0]);
});
