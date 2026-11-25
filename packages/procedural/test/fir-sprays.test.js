import assert from 'node:assert/strict';
import test from 'node:test';
import { generateFirSprayLevels } from '../dist/fir-sprays.js';

test('fir spruce sprays preserve seeded boughs and their atlas regions through three distance levels', () => {
  const regions = [[0.2, 0.3, 0.7, 0.8]];
  const [near, middle, far] = generateFirSprayLevels({ regions });
  assert.deepEqual(generateFirSprayLevels({ regions }), [near, middle, far]);
  assert.notDeepEqual(generateFirSprayLevels({ seed: 17, regions })[0].positions, near.positions);
  assert.ok(near.indices.length > middle.indices.length && middle.indices.length > far.indices.length);

  for (const mesh of [near, middle, far]) {
    const vertices = mesh.positions.length / 3;
    assert.equal(mesh.uvs.length, vertices * 2);
    assert.equal(mesh.normals.length, vertices * 3);
    assert.ok(mesh.positions.every(Number.isFinite));
    assert.ok(mesh.indices.every((index) => index < vertices));
    assert.ok(
      mesh.uvs.every((value, i) => value >= regions[0][i % 2] - 1e-6 && value <= regions[0][(i % 2) + 2] + 1e-6),
    );
    for (let i = 0; i < mesh.normals.length; i += 3)
      assert.ok(Math.abs(Math.hypot(mesh.normals[i], mesh.normals[i + 1], mesh.normals[i + 2]) - 1) < 1e-6);
  }
  // All levels start with the first primary bough and preserve its root and tip.
  for (const mesh of [middle, far]) {
    assert.deepEqual(mesh.positions.slice(0, 6), near.positions.slice(0, 6));
    assert.deepEqual(mesh.positions.slice(6, 12), near.positions.slice(18, 24));
  }
  const doubled = generateFirSprayLevels({ height: 37.28, crownBase: 11, radius: 6.58 })[0];
  assert.ok(Math.max(...doubled.positions.filter((_, i) => i % 3 === 1)) > 36);
});

test('fir sprays reject invalid dimensions, seed, or UV rectangles', () => {
  for (const options of [
    { height: 0 },
    { radius: Number.POSITIVE_INFINITY },
    { crownBase: 19 },
    { seed: -1 },
    { regions: [] },
    { regions: [[0, 0.8, 0.4, 0.7]] },
    { regions: [[0, 0, 1.1, 1]] },
  ])
    assert.throws(() => generateFirSprayLevels(options), RangeError);
});
