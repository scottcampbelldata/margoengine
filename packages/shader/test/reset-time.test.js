import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { ShaderClock } from '../dist/index.js';

test('ShaderClock.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new ShaderClock(), { label: 'ShaderClock' });
});
