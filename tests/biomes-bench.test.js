// The biomes G1 bench times placement with its world tiles already made, so its world must keep every tile the setup makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PLACEMENT_SETUP, WORLD_CACHE } from '../bench/biomes/placement.mjs';

test('the G1 placement bench keeps its setup tiles: an evicted tile would be timed as placement', () => {
  const { x, z } = PLACEMENT_SETUP,
    tiles = (x[1] - x[0] + 1) * (z[1] - z[0] + 1);
  assert.ok(WORLD_CACHE >= tiles, `cache ${WORLD_CACHE} against ${tiles} setup tiles`);
});
