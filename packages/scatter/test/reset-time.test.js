import test from 'node:test';
import { box } from '@margoengine/core';
import { assertResetLikeFresh } from '../../../tests/support/clock-reset.js';
import { Scatter, ScatterInstances } from '../dist/index.js';

test('Scatter.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new Scatter(box(1, 1, 1), { count: 16, wind: [1, 0, 0.5, 6] }), { label: 'Scatter' });
});

test('ScatterInstances.resetTime leaves it as a fresh one, before and after a seek (GAP-FILM-RESET)', () => {
  assertResetLikeFresh(() => new ScatterInstances(() => []), { label: 'ScatterInstances' });
});

test('TrampledScatter and GrassScatter reset as fresh ones (GAP-FILM-RESET)', async () => {
  const { TrampledScatter } = await import('../dist/interact.js'),
    { GrassScatter } = await import('../dist/grass.js');
  assertResetLikeFresh(() => new TrampledScatter(box(1, 1, 1), { count: 16 }), { label: 'TrampledScatter' });
  assertResetLikeFresh(() => new GrassScatter({ count: 16 }), { label: 'GrassScatter' });
});
