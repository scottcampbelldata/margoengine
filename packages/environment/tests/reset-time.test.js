import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { VolumetricFog } from '../dist/volumetric.js';
import { Reflector } from '../dist/reflector.js';

test('VolumetricFog.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new VolumetricFog({ wind: [1, 0, 0.5] }), {
    label: 'VolumetricFog',
    use: (f) => Object.assign(f, { valid: true, frameIndex: 7 }),
  });
});

test('Reflector.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Reflector(), { label: 'Reflector' });
});
