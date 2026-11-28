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
  // All levels start with the first primary bough: the same root and direction, its reach grown by the ring's length
  // factor (1.1 middle, 1.3 far) so the ring keeps the near ring's foliage area.
  const mid = (p, i) => [0, 1, 2].map((k) => (p[i + k] + p[i + 3 + k]) / 2);
  const root = mid(near.positions, 0),
    reach = mid(near.positions, 18).map((v, k) => v - root[k]);
  for (const [mesh, long] of [
    [middle, 1.1],
    [far, 1.3],
  ]) {
    mid(mesh.positions, 0).forEach((v, k) => assert.ok(Math.abs(v - root[k]) < 1e-5, 'same root'));
    mid(mesh.positions, 6).forEach((v, k) => assert.ok(Math.abs(v - root[k] - long * reach[k]) < 1e-4, 'same reach'));
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

// Above the Treeline look round 4: the far ring dropped half the sprays and kept their size, so firs seen from 700 m
// up were bare grey stems with a few cards. Each ring now covers about the near ring's foliage area.
test('fir spray rings keep the foliage area of the near ring', () => {
  const area = ({ positions, indices }) => {
    let sum = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]].map((k) => positions.slice(k * 3, k * 3 + 3));
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
        v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      sum += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    return sum;
  };
  for (const options of [{}, { height: 9, crownBase: 1.1, radius: 1.6, seed: 5 }]) {
    const [near, middle, far] = generateFirSprayLevels(options).map(area);
    assert.ok(Math.abs(middle / near - 1) < 0.12, `middle ring area ${(middle / near).toFixed(3)} of the near ring`);
    assert.ok(Math.abs(far / near - 1) < 0.15, `far ring area ${(far / near).toFixed(3)} of the near ring`);
  }
});
