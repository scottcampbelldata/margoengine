import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { XRaySelection } from '../dist/xray.js';

test('XRaySelection.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new XRaySelection(), { label: 'XRaySelection' });
});
