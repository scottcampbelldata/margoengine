import test from 'node:test';
import assert from 'node:assert/strict';
import { Spline } from '../../splines/dist/index.js';
import { road } from '../dist/index.js';

test('Gemini three-point closed loop has an exact seam at segments 128', () => {
  const result = road(
    new Spline(
      [
        [-25, 0, 25],
        [-34, 0, 0],
        [-35, 0, -25],
      ],
      { closed: true },
    ),
    { segments: 128 },
  );
  const v = result.geometry.vertices,
    row = (result.section.length - 1) * 2;
  assert.deepEqual(v.slice(0, row * 6), v.slice(128 * row * 6));
});

test('vertical input gives a coded linked error while steep nonvertical ramps work', () => {
  assert.throws(
    () =>
      road(
        new Spline([
          [0, 0, 0],
          [0, 20, 0],
          [0, 40, 0],
        ]),
      ),
    (e) => e.code === 'unsupported' && /nonvertical.*https:\/\/margoengine.com\/errors#geometry/.test(e.message),
  );
  const steep = road(
    new Spline([
      [0, 0, 0],
      [0.1, 20, 0],
      [0.2, 40, 0],
    ]),
  );
  assert.ok(steep.geometry.vertices.every(Number.isFinite));
  assert.ok(steep.geometry.indices.length > 0);
});

