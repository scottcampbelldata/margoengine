import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainMaterials } from '../dist/layers-pbr.js';

// A terrain stand-in with four layers: the options are checked before anything touches an engine.
const terrain = { options: { layers: [{}, {}, {}, {}] } },
  textures = () => ({});

test('terrain materials check their options before attaching', () => {
  for (const options of [
    { textures, heightBlend: 1.5 },
    { textures, heightBlend: -0.1 },
    { textures, layers: [{ normal: 2.5 }] },
    { textures, layers: [{ occlusion: 1.2 }] },
    { textures, layers: [{ roughness: -1 }] },
    { textures, layers: [{}, {}, {}, {}, {}] },
  ])
    assert.throws(() => TerrainMaterials.attach(undefined, terrain, options), RangeError, JSON.stringify(options));
  assert.throws(() => TerrainMaterials.attach(undefined, terrain, {}), TypeError);
  assert.throws(() => TerrainMaterials.attach(undefined, {}, { textures }), TypeError);
});
