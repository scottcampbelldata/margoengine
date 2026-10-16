import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';

test('a graded straight road preserves analytic corner positions, hard normals, UV distances and winding', () => {
  const curve = new Spline([
      [0, 0, 0],
      [3, 4, 0],
    ]),
    section = [
      [-2, 0],
      [-2, 0.4],
      [-1.7, 0.4],
      [-1.7, 0],
      [1.7, 0],
      [1.7, 0.4],
      [2, 0.4],
      [2, 0],
    ],
    segments = 8;
  const result = road(curve, { segments, crossSection: section, uvMeters: 2 }),
    { vertices, indices } = result.geometry,
    offsets = [0];
  for (let i = 1; i < section.length; i++)
    offsets[i] = offsets[i - 1] + Math.hypot(section[i][0] - section[i - 1][0], section[i][1] - section[i - 1][1]);
  for (let row = 0; row <= segments; row++)
    for (let strip = 0; strip < 7; strip++) {
      const lateral = section[strip + 1][0] - section[strip][0],
        height = section[strip + 1][1] - section[strip][1],
        normal = [-0.8 * lateral, 0.6 * lateral, 0.6 * height],
        length = Math.hypot(...normal);
      for (let side = 0; side < 2; side++) {
        const index = row * 14 + strip * 2 + side,
          corner = section[strip + side],
          expected = [(3 * row) / segments, (4 * row) / segments + corner[1], -corner[0]];
        for (let axis = 0; axis < 3; axis++) {
          assert.ok(Math.abs(vertices[index * 6 + axis] - expected[axis]) < 1e-6);
          assert.ok(Math.abs(vertices[index * 6 + 3 + axis] - normal[axis] / length) < 1e-6);
        }
        assert.equal(result.uvs[index * 2], Math.fround(offsets[strip + side] / 2));
        assert.ok(Math.abs(result.uvs[index * 2 + 1] - (2.5 * row) / segments) < 1e-6);
      }
    }
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 6,
      b = indices[i + 1] * 6,
      c = indices[i + 2] * 6,
      ab = [],
      ac = [];
    for (let axis = 0; axis < 3; axis++) {
      ab[axis] = vertices[b + axis] - vertices[a + axis];
      ac[axis] = vertices[c + axis] - vertices[a + axis];
    }
    const cross = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    assert.ok(
      cross.reduce((sum, value, axis) => sum + value * vertices[a + 3 + axis], 0) > 0,
      'triangle orientation must agree with its outward hard normal',
    );
  }
  section[0][0] = 100;
  assert.equal(result.section[0][0], -2, 'returned section owns its coordinate copies');
  const firstBytes = vertices.slice();
  road(curve, { segments: 1 });
  assert.deepEqual(vertices, firstBytes, 'later sweeps must not reuse returned vertex storage');
});

test('road generation retains minimum/maximum topology budgets and invalid-profile rejection', () => {
  const curve = new Spline([
      [0, 0, 0],
      [0, 0, 20],
    ]),
    minimum = road(curve, {
      segments: 1,
      crossSection: [
        [-1, 0],
        [1, 0],
      ],
    });
  assert.equal(minimum.geometry.vertices.length / 6, 4);
  assert.deepEqual(Array.from(minimum.geometry.indices), [0, 2, 1, 1, 2, 3]);
  const maximum = road(curve, { segments: 4096 });
  assert.equal(maximum.geometry.vertices.length / 6, 4097 * 14);
  assert.equal(maximum.geometry.indices.length, 4096 * 42);
  for (const options of [
    { segments: 4097 },
    { uvMeters: 0 },
    {
      crossSection: [
        [0, 0],
        [0, 0],
      ],
    },
    {
      crossSection: [
        [0, 0],
        [1, NaN],
      ],
    },
  ])
    assert.throws(() => road(curve, options), /dimensions|cross-section/);
});
