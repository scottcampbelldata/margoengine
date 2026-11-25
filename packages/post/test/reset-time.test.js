import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { HeatHaze } from '../dist/heat-haze.js';
import { Stylize } from '../dist/stylize.js';

test('HeatHaze.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new HeatHaze(), { label: 'HeatHaze' });
});

test('Stylize.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Stylize(), { label: 'Stylize' });
});
