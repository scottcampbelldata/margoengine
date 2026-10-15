import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';
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
    /dimensions/,
  );
});
