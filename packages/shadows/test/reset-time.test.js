import test from 'node:test';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';

test('Shadows.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Shadows(), { label: 'Shadows' });
});

test('VirtualShadows.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new VirtualShadows(), { label: 'VirtualShadows' });
});
