// Batch 132 audit: dispose removes a water plugin from the scene it was attached to. The engine's own removePlugin
// acts on the active scene, so a plugin living in another scene removed the active scene's same-name plugin and
// stayed registered in its own. Fails before the fix for every class below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Water } from '../dist/index.js';
import { FFTOcean } from '../dist/fft.js';
import { WaterReflection } from '../dist/reflector.js';
import { WaterScatter } from '../dist/scatter.js';
import { WaterFlow } from '../dist/flow.js';
import { Ripples } from '../dist/ripples.js';
import { WaterRain } from '../dist/rain.js';
import { WaterBodies } from '../dist/bodies.js';

// An engine whose active scene holds a same-name plugin and whose plugin lives in another scene.
function twoScenes(plugin) {
  const calls = [];
  plugin.engine = {
    disposed: false,
    sceneOf: (p) => (p === plugin ? { removePlugin: (name) => calls.push(['own scene', name]) } : undefined),
    removePlugin: (name) => calls.push(['active scene', name]),
  };
  return calls;
}

const surface = new Water(),
  outline = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
const makers = [
  ['Water', () => new Water()],
  ['FFTOcean', () => new FFTOcean()],
  [
    'WaterReflection',
    () => new WaterReflection({ surface, reflector: { texture: undefined, textureMatrix: undefined } }),
  ],
  ['WaterScatter', () => new WaterScatter({ surface })],
  ['WaterFlow', () => new WaterFlow({ surface })],
  ['Ripples', () => new Ripples({ surface })],
  ['WaterRain', () => new WaterRain({ surface })],
  ['WaterBodies', () => new WaterBodies({ surface, bodies: [{ outline }] })],
];

for (const [label, make] of makers)
  test(`${label}.dispose removes it from its own scene, not from the active scene`, () => {
    const plugin = make(),
      calls = twoScenes(plugin);
    plugin.dispose();
    assert.deepEqual(calls, [['own scene', plugin.name]]);
  });
