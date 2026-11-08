import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainSculpt } from '../dist/sculpt.js';

// A terrain stand-in with four layers: brush options are checked before anything touches an engine.
const terrain = { invalidate() {}, options: { layers: [{}, {}, {}, {}] } };

test('terrain sculpts check their options before attaching', async () => {
  for (const options of [
    { brush: 'dig' },
    { falloff: 'sharp' },
    { radius: 0 },
    { radius: Infinity },
    { strength: 1.5 },
    { strength: -0.1 },
    { amount: 0 },
    { height: NaN },
    { layer: 4 },
    { layer: 1.5 },
    { undoLimit: 1001 },
    { undoLimit: -1 },
  ])
    await assert.rejects(TerrainSculpt.attach(undefined, terrain, options), RangeError, JSON.stringify(options));
  await assert.rejects(TerrainSculpt.attach(undefined, {}, {}), TypeError);
});
