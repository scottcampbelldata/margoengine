import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../dist/index.js';
import { SplineFrames } from '../dist/frames.js';
import { deformAlongSpline, placeAlongSpline } from '../dist/mesh.js';

test('closed spline tangents, transported frames and mesh consumers agree across the seam', () => {
  for (const kind of ['catmull-rom', 'hermite', 'bspline', 'kochanek-bartels']) {
    const curve = new Spline(
      [
        [0, 0, 0],
        [30, 3, 0],
        [30, 1, 30],
        [0, -2, 30],
      ],
      {
        kind,
        closed: true,
        tangents: [
          [10, 1, -10],
          [10, 1, 10],
          [-10, -1, 10],
          [-10, -1, -10],
        ],
      },
    );
    const start = curve.tangent(0, new Float64Array(3)),
      end = curve.tangent(1, new Float64Array(3));
    assert.deepEqual(end, start);
    const frames = new SplineFrames(curve),
      a = frames.frameAt(0),
      b = frames.frameAt(curve.length);
    for (const key of ['position', 'tangent', 'normal', 'binormal'])
      for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[key][k] - b[key][k]) < 1e-12, `${kind} ${key}`);
    const deformed = deformAlongSpline(curve, new Float64Array([1, 2, 0, 1, 2, curve.length]), {
      normals: new Float64Array([1, 0, 0, 1, 0, 0]),
    });
    for (const key of ['positions', 'normals'])
      for (let k = 0; k < 3; k++)
        assert.ok(Math.abs(deformed[key][k] - deformed[key][k + 3]) < 1e-12, `${kind} deformation ${key}`);
    const placement = placeAlongSpline(curve, { count: 2 });
    assert.deepEqual(placement.matrices.subarray(0, 16), placement.matrices.subarray(16));
  }
});
