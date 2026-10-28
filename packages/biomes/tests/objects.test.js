// The objects entry without a GPU: argument checks (its drawing is proved on a real GPU by objects-check.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeObjects } from '../dist/objects.js';

test('BiomeObjects.attach checks its engine, placement, heightmap, bounds and distances', async () => {
  const engine = { camera: { position: [0, 0, 0] } },
    placement = { tile() {}, species: [], details: [], tileSize: 256 };
  await assert.rejects(BiomeObjects.attach(engine, {}, {}), TypeError);
  await assert.rejects(BiomeObjects.attach(engine, placement, { bounds: [0, 0, 1, 1] }), TypeError);
  await assert.rejects(
    BiomeObjects.attach(engine, placement, { heightmap: () => undefined, bounds: [0, 0, 1, 1], radius: 0 }),
    RangeError,
  );
});
