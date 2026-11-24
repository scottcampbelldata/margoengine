import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road, roadPath } from '../dist/index.js';
test('road sweep builds curbs, normalized hard normals, outward triangles and tiled UVs', () => {
  const result = road(
    new Spline([
      [0, 0, 0],
      [0, 0, 20],
    ]),
    { segments: 4, uvMeters: 5 },
  );
  const g = result.geometry;
  assert.equal(result.uvs.at(-1), 4);
  assert.equal(g.indices.length, 4 * 7 * 6);
  for (let i = 0; i < g.vertices.length; i += 6)
    assert.ok(Math.abs(Math.hypot(...g.vertices.subarray(i + 3, i + 6)) - 1) < 1e-6);
  assert.ok(result.section.some((p) => p[1] === 0.15));
  assert.throws(
    () =>
      road(
        new Spline([
          [0, 0, 0],
          [0, 1, 0],
        ]),
      ),
    /vertical/,
  );
  assert.throws(
    () =>
      road(
        new Spline([
          [0, 0, 0],
          [0, 0, 2],
        ]),
        { segments: 0 },
      ),
    { name: 'RangeError', message: /road options/ },
  );
});

test('roadPath gives the centreline and the full width covered, the shape Scatter paths take (GAP-FILM-LOOK)', () => {
  const curve = new Spline([
      [0, 0, 0],
      [0, 0, 20],
    ]),
    path = roadPath(curve, { width: 6, segments: 4 });
  assert.deepEqual(path.points, [
    [0, 0],
    [0, 5],
    [0, 10],
    [0, 15],
    [0, 20],
  ]);
  assert.equal(path.width, 2 * (3 + 0.2 + 0.5), 'both curbs and the default 0.5 margin each side');
  assert.equal(roadPath(curve, { width: 4, curbWidth: 0.5, margin: 0, segments: 1 }).width, 5);
  assert.equal(roadPath(curve, { crossSection: [[-5, 0], [2, 0.1]], margin: 1, segments: 1 }).width, 12, 'the wider side, on both sides');
  for (const bad of [{ width: 0 }, { margin: -1 }, { segments: 0 }, { segments: 1.5 }, { crossSection: [[0, 0]] }])
    assert.throws(() => roadPath(curve, bad), RangeError, JSON.stringify(bad));
});
