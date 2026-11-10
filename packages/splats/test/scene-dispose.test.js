// Batch 132 audit: dispose removes a splat plugin from the scene it was attached to. The engine's own
// removePlugin acts on the active scene, so a plugin living in another scene removed the active scene's
// same-name plugin and stayed registered in its own. Fails before the fix for every class below.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { SplatBrush } from '../dist/brush.js';
import { SplatDepth } from '../dist/depth.js';
import { SplatLighting } from '../dist/lighting.js';
import { SplatSequence } from '../dist/animate.js';
import { SplatModifier } from '../dist/modify.js';
import { buildSplatLod, SplatLod } from '../dist/lod.js';

const data = () => ({
  positions: new Float32Array([0, 0, 0, 1, 0, 0]),
  covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1, 0.1, 0, 0, 0.1, 0, 0.1]),
  colors: new Float32Array([1, 0, 0, 1, 0, 1, 0, 1]),
});

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

const makers = [
  ['Splats', async () => new Splats(data())],
  ['SplatBrush', async () => new SplatBrush(new Splats(data()))],
  ['SplatDepth', async () => new SplatDepth(new Splats(data()))],
  ['SplatLighting', async () => new SplatLighting(new Splats(data()))],
  ['SplatSequence', async () => new SplatSequence(new Splats(data()), [data()])],
  ['SplatModifier', async () => SplatModifier.create(new Splats(data()))],
  ['SplatLod', async () => new SplatLod(buildSplatLod(data(), { leafSize: 1024 }))],
];

for (const [label, make] of makers)
  test(`${label}.dispose removes it from its own scene, not from the active scene`, async () => {
    const plugin = await make(),
      calls = twoScenes(plugin);
    plugin.dispose();
    assert.deepEqual(calls, [['own scene', plugin.name]]);
  });
