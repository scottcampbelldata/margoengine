import test from 'node:test';
import assert from 'node:assert/strict';
import { SSS, SSS_MAX_REACH } from '@margoengine/post/sss';

test('SSS checks its options and needs a stack', () => {
  for (const bad of [
    { radius: 0 },
    { radius: Number.NaN },
    { profile: [1, 0.5] },
    { profile: [0, 0, 0] },
    { profile: [1.5, 0.5, 0.2] },
    { strength: -0.1 },
    { taps: 0 },
    { taps: 33 },
    { taps: 2.5 },
  ])
    assert.throws(() => new SSS(bad), RangeError);
  assert.throws(() => new SSS({ enabled: 1 }), TypeError);
  assert.throws(() => new SSS({ mask: {} }), TypeError);
  assert.throws(() => new SSS().setup({ gpu: {} }), /PostStack/);
  assert.equal(SSS_MAX_REACH, 64);
  const effect = new SSS({ radius: 0.02, profile: [1, 0.85, 0.7] });
  effect.dispose();
  effect.dispose();
  assert.throws(() => effect.setup({ gpu: {} }), /disposed/);
});

test('SSS options are read every frame, so a bad change throws at the next frame', () => {
  const effect = new SSS();
  effect.options.taps = 40;
  assert.throws(() => effect['validate'](), RangeError);
});
