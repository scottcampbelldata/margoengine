// The sky fog under a cloud cover (Fauld recut, 2026-11-24): a 2 to 4 degree November sun under an overcast washed the
// whole valley gold, because the haze took the clear sky's colour behind the cloud. Under cover it takes the light of
// the cloud's underside by the cover's share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudHaze } from '../dist/index.js';
import { overcastDeck } from '../dist/clouds.js';

test('fog under a full cloud cover is the deck light, not the clear sky gold; no clouds keeps the sky colour', () => {
  const gold = [0.8, 0.45, 0.12],
    sun = [1, 0.82, 0.62],
    T = 1 / (1 + 20 * 0.075);
  const under = cloudHaze(gold, sun, 0.07, 0, 1, T),
    deck = overcastDeck(sun, 0.07, 0, 20, 1);
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(under[i] - (deck[i] + [0.006, 0.01, 0.02][i] * T)) < 1e-9, `channel ${i}`);
  // Far less saturated than the clear sky's gold: blue over red rises from 0.15 to 0.6 or more.
  assert.ok(under[2] / under[0] > 0.6 && gold[2] / gold[0] < 0.2, `blue over red ${under[2] / under[0]}`);
  assert.deepEqual(cloudHaze(gold, sun, 0.07, 0, 0.9, 0), gold, 'no clouds option: the clear sky');
  assert.deepEqual(cloudHaze(gold, sun, 0.07, 0, 0, T), gold, 'no cover: the clear sky');
  const half = cloudHaze(gold, sun, 0.07, 0, 0.5, T);
  for (let i = 0; i < 3; i++)
    assert.ok(Math.abs(half[i] - (gold[i] + under[i]) / 2) < 1e-9, 'half cover mixes halfway');
});
