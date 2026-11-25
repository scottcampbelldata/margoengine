import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { TAA } from '../dist/index.js';
import { TAAUpscale } from '../dist/upscale.js';

test('TAA.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new TAA(), {
    label: 'TAA',
    use: (t) => Object.assign(t, { valid: true, sample: 5, frame: 9, front: 1 }),
  });
});

test('TAAUpscale.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new TAAUpscale(), {
    label: 'TAAUpscale',
    use: (t) => Object.assign(t, { valid: true, frame: 9, front: 1 }),
  });
});
