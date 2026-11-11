import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompute } from '@margoengine/compute';
import {
  NO_DISTANCE,
  NO_SEED,
  distanceTransform,
  distanceTransformExact,
  jumpFlood,
  jumpFloodSteps,
  voronoiMap,
} from '@margoengine/compute/distance';
import { squaredDistanceTransformNd } from '../../shared/distance-exact.js';
import { floodErrorRates, makeMask, rng, voronoiAndSigned } from './distance-cases.js';

function brute(mask, shape) {
  const [w, h] = shape,
    seeds = [];
  mask.forEach((m, i) => {
    if (m) seeds.push([i % w, Math.floor(i / w) % h, Math.floor(i / (w * h))]);
  });
  return Float64Array.from(mask, (_, i) => {
    const x = i % w,
      y = Math.floor(i / w) % h,
      z = Math.floor(i / (w * h));
    let best = Infinity;
    for (const [sx, sy, sz] of seeds) best = Math.min(best, (sx - x) ** 2 + (sy - y) ** 2 + (sz - z) ** 2);
    return best;
  });
}

test('the exact transform equals brute force on 200 random masks up to 64^2 and 16^3, nearest cells included', () => {
  const random = rng(11);
  for (let k = 0; k < 200; k++) {
    const three = k % 4 === 3,
      side = () => 1 + Math.floor(random() * (three ? 16 : 64)),
      shape = three ? [side(), side(), side()] : [side(), side()],
      n = shape.reduce((a, b) => a * b, 1),
      mask = new Uint8Array(n),
      density = [0.001, 0.02, 0.3][k % 3];
    for (let i = 0; i < n; i++) mask[i] = random() < density ? 1 : 0;
    mask[Math.floor(random() * n)] = 1;
    const expected = brute(mask, shape),
      grid = Float64Array.from(mask, (m) => (m ? 0 : 1e20)),
      nearest = new Int32Array(n);
    squaredDistanceTransformNd(grid, shape, nearest);
    assert.deepEqual([...grid], [...expected], `shape ${shape}`);
    const [w, h] = shape;
    nearest.forEach((c, i) => {
      assert.equal(mask[c], 1);
      const q = (c % w) - (i % w),
        r = (Math.floor(c / w) % h) - (Math.floor(i / w) % h),
        s = Math.floor(c / (w * h)) - Math.floor(i / (w * h));
      assert.equal(q * q + r * r + s * s, expected[i]);
    });
  }
});

test('distanceTransformExact: the documented example, spacing, no seeds, and the signed zero set', () => {
  const d = distanceTransformExact(new Uint8Array([1, 0, 0, 0, 0, 0]), [3, 2]);
  assert.deepEqual(
    [...d].map((v) => +v.toFixed(3)),
    [0, 1, 2, 1, 1.414, 2.236],
  );
  assert.equal(distanceTransformExact(new Uint8Array([1, 0]), [2, 1], { spacing: 0.25 })[1], 0.25);
  assert.equal(distanceTransformExact(new Uint8Array(4), [2, 2])[3], NO_DISTANCE);
  const mask = new Uint8Array(16).fill(0);
  for (const i of [5, 6, 9, 10]) mask[i] = 1;
  const s = distanceTransformExact(mask, [4, 4], { signed: true });
  mask.forEach((m, i) => assert.equal(s[i] < 0, m === 1));
  assert.equal(s[5], -0.5);
  assert.equal(s[4], 0.5);
  assert.throws(() => distanceTransformExact(new Uint8Array(5), [2, 2]), /needs 4/);
});

test('the pass lists follow the papers: n/2 down to 1, with a 1 first, a 1 last or a 2 and a 1 last', () => {
  assert.deepEqual(jumpFloodSteps(8), [4, 2, 1, 1]);
  assert.deepEqual(jumpFloodSteps(8, 'jfa'), [4, 2, 1]);
  assert.deepEqual(jumpFloodSteps(8, '1+jfa'), [1, 4, 2, 1]);
  assert.deepEqual(jumpFloodSteps(8, 'jfa+2'), [4, 2, 1, 2, 1]);
  assert.deepEqual(jumpFloodSteps(100, 'jfa'), [64, 32, 16, 8, 4, 2, 1]);
  assert.deepEqual(jumpFloodSteps(2, 'jfa'), [1]);
  assert.throws(() => jumpFloodSteps(0), /at least 1/);
  assert.throws(() => jumpFloodSteps(8, 'fast'), /Unknown flood variant/);
});

test('CPU backend flooding meets the error bars on 2D and 3D masks, and no seeds gives NO_SEED', {
  timeout: 300000,
}, async () => {
  using c = await createCompute({ backend: 'cpu' });
  const exact = (grid, shape) => squaredDistanceTransformNd(grid, shape);
  const report = await floodErrorRates(c, exact, 256, 32);
  assert.equal(report.length, 16);
  using none = c.zeros([8, 8], 'u32');
  using flood = await jumpFlood(none);
  assert.ok((await flood.nearest.read()).every((v) => v === NO_SEED));
  assert.ok((await flood.distance.read()).every((v) => v === NO_DISTANCE));
  console.log(
    JSON.stringify(report.map((r) => ({ ...r, wrong: +r.wrong.toExponential(2), worst: +r.worst.toFixed(3) }))),
  );
});

test('CPU backend Voronoi map and signed distance', { timeout: 120000 }, async () => {
  using c = await createCompute({ backend: 'cpu' });
  await voronoiAndSigned(c, 96);
  // Duplicate sites in one cell: the lower index wins; sites outside the grid are rejected.
  const map = await voronoiMap(c, [1, 1, 1, 1, 6, 6], [8, 8]);
  const ids = await map.id.read();
  assert.equal(ids[9], 0);
  assert.equal(ids[63], 2);
  await assert.rejects(voronoiMap(c, [8, 0], [8, 8]), /outside/);
});

test('flood inputs: float and i32 masks, expressions, spacing, shapes, variants and cancellation', async () => {
  using c = await createCompute({ backend: 'cpu' });
  const floats = c.array(
    Float32Array.from({ length: 16 }, (_, i) => (i === 0 ? 0.5 : 0)),
    { shape: [4, 4] },
  );
  using viaFloat = await distanceTransform(floats, { spacing: 2 });
  assert.equal((await viaFloat.read())[1], 2);
  using viaExpression = await distanceTransform(floats.gt(0.25));
  assert.equal((await viaExpression.read())[5], Math.fround(Math.SQRT2));
  using ints = c.array(
    Int32Array.from({ length: 16 }, (_, i) => (i === 15 ? -3 : 0)),
    { shape: [4, 4] },
  );
  using viaInt = await distanceTransform(ints, { variant: 'jfa' });
  assert.equal((await viaInt.read())[14], 1);
  await assert.rejects(distanceTransform(c.zeros([4], 'u32')), /2D or 3D/);
  await assert.rejects(distanceTransform(c.zeros([1, 4], 'u32')), /from 2 to 4096/);
  await assert.rejects(distanceTransform(c.zeros([4, 4], 'u32'), { spacing: 0 }), /Spacing/);
  await assert.rejects(distanceTransform(c.zeros([4, 4], 'u32'), { variant: 'x' }), /Unknown flood variant/);
  await assert.rejects(distanceTransform(c.zeros([600, 600, 4], 'u32')), /from 2 to 512/);
  await assert.rejects(distanceTransform({}), /GpuArray/);
  await assert.rejects(
    distanceTransform(c.zeros([4, 4], 'u32'), { signal: AbortSignal.abort(new Error('stop')) }),
    /stop/,
  );
  assert.deepEqual([...makeMask([2, 2], 4)].length, 4);
});
