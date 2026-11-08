import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainStream } from '../dist/stream.js';

// An engine stand-in: the options are checked before the stream touches anything but the camera.
const engine = { camera: { position: [0, 0, 0] } },
  layers = Array.from({ length: 4 }, () => ({ height: [-1, 1], slope: [0, 1], scale: 1 })),
  base = { layers, tileSize: 64, tileTexels: 64, load: async () => null, colors: () => ({}) };

test('terrain streams check their options before attaching', () => {
  for (const options of [
    { tileSize: 0 },
    { tileSize: Infinity },
    { tileTexels: 1 },
    { tileTexels: 1025 },
    { tileTexels: 64.5 },
    { window: 3 },
    { window: 18 },
    { window: 0 },
    { weights: 5 },
    { weights: 1, layers: [...layers, layers[0]] },
    { budget: 0 },
    { concurrency: 65 },
    { fill: NaN },
    { origin: [0, Infinity] },
  ])
    assert.throws(() => TerrainStream.attach(engine, { ...base, ...options }), RangeError, JSON.stringify(options));
  assert.throws(() => TerrainStream.attach(engine, { ...base, load: undefined }), TypeError);
  assert.throws(() => TerrainStream.attach(engine, { ...base, colors: 1 }), TypeError);
  // The terrain's own options are checked by the terrain it makes.
  assert.throws(() => TerrainStream.attach(engine, { ...base, layers: layers.slice(0, 3) }), RangeError);
});
