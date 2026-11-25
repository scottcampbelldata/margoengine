import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { Lines } from '../dist/index.js';
import { Trail } from '../dist/trail.js';

test('Lines.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Lines(), { label: 'Lines' });
});

test('Trail.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Trail(), {
    label: 'Trail',
    // `stale` re-uploads the samples: none after a reset, as a fresh trail draws none.
    ignore: ['stale'],
    use: (t) => Object.assign(t, { used: 3, start: 1 }),
  });
});
