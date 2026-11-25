import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { Tonemap } from '../dist/index.js';

test('Tonemap.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Tonemap({ grain: 0.1 }), { label: 'Tonemap' });
});
