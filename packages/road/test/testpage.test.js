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

