import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePanorama, panoramaDirection, panoramaPNG } from '../dist/panorama.js';

test('spherical landmarks, wrap, poles and yaw have the specified orientation', () => {
  const near = (actual, expected) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-12));
  for (const [u, v, direction] of [
    [0.5, 0.5, [0, 0, -1]],
    [0.75, 0.5, [1, 0, 0]],
    [0.25, 0.5, [-1, 0, 0]],
    [0, 0.5, [0, 0, 1]],
    [1, 0.5, [0, 0, 1]],
    [0.3, 0, [0, 1, 0]],
    [0.8, 1, [0, -1, 0]],
  ])
    near(panoramaDirection(u, v), direction);
  near(panoramaDirection(0.5, 0.5, Math.PI / 2), [1, 0, 0]);
  near(panoramaDirection(12.75, 0.5), [1, 0, 0]);
});

test('bad coordinates, malformed captures, HDR PNGs and cancelled operations reject before GPU work', async () => {
  for (const args of [
    [NaN, 0],
    [0, -0.1],
    [0, 1.1],
    [0, 0, Infinity],
  ])
    assert.throws(() => panoramaDirection(...args), RangeError);
  for (const width of [0, 3, 1.5, NaN]) await assert.rejects(capturePanorama({}, { width }), RangeError);
  await assert.rejects(capturePanorama({}, { format: 'unknown' }), TypeError);
  await assert.rejects(panoramaPNG({ format: 'linear' }), TypeError);
  await assert.rejects(
    panoramaPNG({ format: 'srgb', width: 4, height: 2, data: new Uint8ClampedArray(2) }),
    RangeError,
  );
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(capturePanorama({}, { signal }), /cancelled/);
  await assert.rejects(panoramaPNG({}, signal), /cancelled/);
});
