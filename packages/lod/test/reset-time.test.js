import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { LODSystem } from '../dist/index.js';

test('LODSystem.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new LODSystem(), { label: 'LODSystem' });
});
