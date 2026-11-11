import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sphere } from '../packages/stage/dist/index.js';

test('Stage sphere packing remains byte-identical across radii and minimum/maximum segment counts', () => {
  // Vertices and indices are unchanged since before core rounded bounds outward (2026-11-10); the four digests that
  // moved differ only in the radius, now the first float32 at or above the farthest stored vertex.
  for (const [radius, segments, digest] of [
    [0.125, 3, 'ae418155f74191414916cbdecbd0f0e1187830260247880565131d35c38a74b4'],
    [1, 5, '33f7e043ce7a1c8c3bacdff9e4f5c8a8fe13d8beb0a762adf45750ba8cecf09d'],
    [2.5, 32, 'f3e4227d4c8234e8b62677b7e3a40da8359d2f15a03a7f009fd21c5f16b69358'],
    [0.7, 128, '48670f13bdfd26a3767d4b38ba90fc80040d070a9747d3832c6108f61fee0fee'],
    [1, 256, '6eae251f55f9ddab2763d1dc2b2ca2c4d40ae779a1128b02ed6b434f09a4b00c'],
  ]) {
    const geometry = sphere(radius, segments),
      hash = createHash('sha256');
    for (const array of [geometry.vertices, geometry.indices, geometry.bounds])
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    assert.equal(hash.digest('hex'), digest);
    const [x, y, z, r] = geometry.bounds,
      v = geometry.vertices;
    for (let i = 0; i < v.length; i += 6) assert.ok(Math.hypot(v[i] - x, v[i + 1] - y, v[i + 2] - z) <= r);
  }
  for (const radius of [0, -1, NaN, Infinity, 1e40]) assert.throws(() => sphere(radius), /radius/);
  for (const segments of [2, 3.5, 257, NaN]) assert.throws(() => sphere(1, segments), /segments/);
});

test('Stage sphere evaluates latitude trigonometry once per ring', () => {
  const sin = Math.sin,
    cos = Math.cos;
  let sine = 0,
    cosine = 0;
  try {
    Math.sin = (value) => {
      sine++;
      return sin(value);
    };
    Math.cos = (value) => {
      cosine++;
      return cos(value);
    };
    sphere(1, 32);
  } finally {
    Math.sin = sin;
    Math.cos = cos;
  }
  assert.equal(sine, 578);
  assert.equal(cosine, 578);
});
