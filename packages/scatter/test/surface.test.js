import test from 'node:test';
import assert from 'node:assert/strict';
import { scatterSurface } from '../dist/surface.js';

const triangle = (normal = [0, 1, 0]) => ({
  positions: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0]),
  normals: new Float32Array([...normal, ...normal, ...normal]),
  uvs: new Float32Array([0, 0, 0, 1, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
});
const close = (x, y) => assert.ok(Math.abs(x - y) < 2e-6, `${x} != ${y}`);
test('surface scatter is seeded, area-uniform, preserves UVs, and faces up, cliffs and undersides', () => {
  for (const normal of [
    [0, 1, 0],
    [0, -1, 0],
    [1, 0, 0],
    [0, 0, 1],
    [0.6, 0.8, 0],
  ]) {
    const a = scatterSurface(triangle(normal), 4096, { seed: 37, yaw: [0, 0], offset: 0.25, scale: [2, 2] });
    assert.deepEqual(a, scatterSurface(triangle(normal), 4096, { seed: 37, yaw: [0, 0], offset: 0.25, scale: [2, 2] }));
    for (let i = 0; i < 4096; i++) {
      const at = i * 16;
      for (let k = 0; k < 3; k++) {
        close(a.transforms[at + 4 + k] / 2, normal[k]);
        close(a.transforms[at + 12 + k], a.positions[i * 3 + k] + normal[k] * 0.25);
      }
      close(a.uvs[i * 2], a.positions[i * 3]);
      close(a.uvs[i * 2 + 1], a.positions[i * 3 + 2]);
      assert.ok(
        a.positions[i * 3] >= 0 &&
          a.positions[i * 3 + 2] >= 0 &&
          a.positions[i * 3] + a.positions[i * 3 + 2] <= 1.0000001,
      );
    }
  }
  const upright = scatterSurface(triangle([0, -1, 0]), 1, { align: 0 });
  close(upright.transforms[5], 1);
  const half = scatterSurface(triangle([1, 0, 0]), 1, { align: 0.5, yaw: [0, 0] });
  close(half.transforms[4], Math.SQRT1_2);
  close(half.transforms[5], Math.SQRT1_2);
});

test('surface scatter uses world area after nonuniform transforms, inverse transpose normals and exact painted density', () => {
  const source = {
    positions: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 10, 0, 0, 10, 1, 0, 10, 0, 1]),
    normals: new Float32Array(),
    uvs: new Float32Array(),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
  const matrix = new Float32Array([4, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1]);
  const snapshot = source.positions.slice(),
    out = scatterSurface(source, 20000, { matrix, seed: 56 });
  let first = 0;
  for (let i = 0; i < 20000; i++) if (out.positions[i * 3] < 20) first++;
  assert.ok(Math.abs(first / 20000 - 0.8) < 0.015, `${first}/20000 samples on the 4x area face`);
  assert.deepEqual(source.positions, snapshot);
  const colors = new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1]);
  const weighted = scatterSurface(triangle(), 20000, { weights: [1, 0, 0], colors, seed: 57 });
  let x = 0,
    z = 0,
    red = 0;
  for (let i = 0; i < 20000; i++) {
    x += weighted.positions[i * 3];
    z += weighted.positions[i * 3 + 2];
    red += weighted.colors[i * 4];
  }
  assert.ok(Math.abs(x / 20000 - 0.25) < 0.01);
  assert.ok(Math.abs(z / 20000 - 0.25) < 0.01);
  assert.ok(Math.abs(red / 20000 - 0.5) < 0.01);
  const transformed = scatterSurface(triangle([Math.SQRT1_2, Math.SQRT1_2, 0]), 2, { matrix, yaw: [0, 0] });
  close(transformed.normals[0], 1 / Math.sqrt(17));
  close(transformed.normals[1], 4 / Math.sqrt(17));
});

test('surface scatter refuses malformed and overflowing options, cancellation and singular transforms without mutation', () => {
  const data = triangle(),
    bad = new Float32Array(16),
    identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (const count of [-1, 1.5, 1_000_001, NaN]) assert.throws(() => scatterSurface(data, count), RangeError);
  for (const options of [
    { scale: [0, 1] },
    { scale: [1e-50, 1] },
    { yaw: [1, 0] },
    { align: 1.1 },
    { offset: Infinity },
    { seed: -1 },
    { matrix: bad },
  ])
    assert.throws(() => scatterSurface(data, 1, options), RangeError);
  const abort = new AbortController();
  abort.abort();
  assert.throws(() => scatterSurface(data, 1, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(scatterSurface(data, 0).transforms.length, 0);
  assert.throws(() => scatterSurface(data, 1, { colors: [NaN, 0, 0, 1, 0, 0, 1, 0, 0] }), RangeError);
  const invalidUV = { ...data, uvs: new Float32Array([NaN, 0, NaN, 0, NaN, 0]) };
  assert.throws(() => scatterSurface(invalidUV, 1), RangeError);
  const tooFar = identity.slice();
  tooFar[13] = 3e38;
  assert.throws(() => scatterSurface(data, 1, { matrix: tooFar, offset: 3e38, scale: [1, 1] }), RangeError);
});
