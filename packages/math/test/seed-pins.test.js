// The shared stream of seededRandom starts from a fixed state and restarts from `seed | 0`. This file runs alone so the
// stream is untouched when the first test reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRandom, seededRandom } from '../dist/mathutils.js';

test('seededRandom starts from its fixed default state', () => {
  assert.equal(seededRandom(), 0.3588899802416563);
  assert.equal(seededRandom(), 0.10590326134115458);
});

test('seededRandom(seed) restarts the stream exactly as createRandom(seed) does, for even and odd seeds', () => {
  for (const seed of [2, 8, 1000, -6, 7, 1.7]) {
    const want = createRandom(seed);
    assert.equal(seededRandom(seed), want());
    assert.equal(seededRandom(), want());
  }
});
