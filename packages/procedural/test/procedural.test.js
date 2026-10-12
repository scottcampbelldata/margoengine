import test from 'node:test';
import assert from 'node:assert/strict';
import {Noise, marchingCubes} from '../dist/index.js';
test('seeded 3D noise is deterministic, continuous at cell boundaries and finite', () => {
  const a = new Noise(13), b = new Noise(13), c = new Noise(14);
  for (const kind of ['simplex', 'perlin', 'worley']) {
    assert.equal(a[kind](0.25, 1.5, -2.7), b[kind](0.25, 1.5, -2.7)); assert.notEqual(a[kind](0.25, 1.5, -2.7), c[kind](0.25, 1.5, -2.7));
    assert.ok(Math.abs(a[kind](1 - 1e-6, 0.2, 0.3) - a[kind](1 + 1e-6, 0.2, 0.3)) < 1e-3);
    assert.throws(() => a[kind](NaN, 0, 0), /finite/);
  }
});
test('Marching Cubes extracts a sphere with radial normals and returns null for an empty field', () => {
  const geometry = marchingCubes((x, y, z) => x * x + y * y + z * z - 0.25, {resolution: [16, 16, 16]}); assert.ok(geometry.indices.length > 100);
  for (let i = 0; i < geometry.vertices.length; i += 6) {
    const v = geometry.vertices; assert.ok(Math.abs(Math.hypot(v[i], v[i + 1], v[i + 2]) - 0.5) < 0.02);
    assert.ok(v[i] * v[i + 3] + v[i + 1] * v[i + 4] + v[i + 2] * v[i + 5] > 0.45);
  }
  assert.equal(marchingCubes(() => 1, {resolution: [3, 3, 3]}), null); assert.throws(() => marchingCubes(() => NaN), /finite/);
});
