import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { Ripples } from '../dist/ripples.js';

test('ripple construction and event queue reject invalid input atomically', () => {
  const surface = new Water({ waves: [{ direction: [1, 0], amplitude: 0, wavelength: 10 }] });
  for (const options of [
    { resolution: 16.5 },
    { speed: NaN },
    { damping: -1 },
    { size: 0 },
    { size: 1, resolution: 512, speed: 100 },
    { followCamera: 1 },
  ])
    assert.throws(() => new Ripples({ surface, ...options }));
  assert.throws(() => new Ripples({}), /surface/);
  const ripples = new Ripples({ surface, size: 16, resolution: 16 });
  assert.throws(() => ripples.disturb(NaN, 0), /position/);
  assert.throws(() => ripples.disturb(0, 0, 0.5), /radius/);
  assert.throws(() => ripples.wake([0], [0, 0]), /pairs/);
  for (let i = 0; i < 64; i++) ripples.disturb(0, 0);
  assert.throws(() => ripples.disturb(0, 0), /queue full/);
  ripples.dispose();
  ripples.dispose();
  assert.throws(() => ripples.disturb(0, 0), { code: 'disposed' });
  surface.dispose();
});

test('ripple reads require a rendered field and honour an already aborted signal', async () => {
  const ripples = new Ripples({ surface: new Water() });
  await assert.rejects(ripples.readFrame(), { code: 'state' });
  const signal = AbortSignal.abort();
  await assert.rejects(ripples.readFrame({ signal }), { name: 'AbortError' });
  ripples.dispose();
});
