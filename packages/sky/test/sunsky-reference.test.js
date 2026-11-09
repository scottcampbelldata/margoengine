import assert from 'node:assert/strict';
import test from 'node:test';
import { direction, toZUp, skyCases, radianceError } from '../scripts/sunsky-scene.mjs';

test('sunsky coordinate mapping preserves zenith, sun angles and unit directions', () => {
  assert.deepEqual(toZUp([0, 1, 0]), [0, 0, 1]);
  for (const c of skyCases()) {
    assert.equal(c.directions.length, 33);
    assert.ok(Math.abs(Math.hypot(...c.sun) - 1) < 1e-12);
    assert.ok(Math.abs(toZUp(c.sun)[2] - Math.sin((c.elevation * Math.PI) / 180)) < 1e-12);
    for (const d of c.directions) assert.ok(Math.abs(Math.hypot(...d) - 1) < 1e-12);
    assert.deepEqual(c.directions.at(-1), direction(90));
  }
});

test('radiance comparison removes only one zenith luminance scale and retains colour error', () => {
  const a = [
    [2, 1, 3],
    [1, 1, 1],
  ];
  // Power-of-two rescaling is exact in binary; decimal factors add rounding noise.
  assert.equal(
    radianceError(
      a,
      a.map((c) => c.map((v) => v * 8)),
    ).mae,
    0,
  );
  const e = radianceError(
    [
      [1, 2, 3],
      [1, 1, 1],
    ],
    a,
  );
  assert.equal(e.mae, 1 / 3);
  assert.equal(e.max, 1);
  assert.throws(() => radianceError([], []));
  assert.throws(() => radianceError([[0, 0, 0]], [[1, 1, 1]]));
});
