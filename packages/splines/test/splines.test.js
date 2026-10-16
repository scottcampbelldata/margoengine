import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../dist/index.js';
test('all cubic types reproduce straight endpoints, unit tangents and distance parameterization', () => {
  const options = [
    {
      points: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      options: {},
    },
    {
      points: [
        [0, 0, 0],
        [2, 0, 0],
        [8, 0, 0],
        [10, 0, 0],
      ],
      options: { kind: 'bezier' },
    },
    {
      points: [
        [0, 0, 0],
        [10, 0, 0],
      ],
      options: {
        kind: 'hermite',
        tangents: [
          [10, 0, 0],
          [10, 0, 0],
        ],
      },
    },
  ];
  for (const fixture of options) {
    const curve = new Spline(fixture.points, fixture.options),
      out = new Float64Array(3);
    assert.deepEqual([...curve.at(0, out)], [0, 0, 0]);
    assert.deepEqual([...curve.at(1, out)], [10, 0, 0]);
    assert.ok(Math.abs(curve.length - 10) < 1e-9);
    assert.ok(Math.abs(curve.atDistance(5, out)[0] - 5) < 1e-3);
    assert.deepEqual([...curve.tangent(0.5, out)], [1, 0, 0]);
    assert.equal(curve.at(0.5, out), out);
  }
});
test('closed curves join at the seam, arc caches update and malformed inputs reject', () => {
  const curve = new Spline(
    [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    { closed: true },
  );
  assert.deepEqual([...curve.at(0)], [...curve.at(1)]);
  const length = curve.length;
  curve.points[3] = 2;
  curve.updateArcLengths();
  assert.ok(curve.length > length);
  assert.throws(() => curve.at(-1), /parameter/);
  assert.throws(
    () =>
      new Spline(
        [
          [0, 0, 0],
          [1, 0, 0],
        ],
        { kind: 'bezier' },
      ),
    /Bezier/,
  );
});
