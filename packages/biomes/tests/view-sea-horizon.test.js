// A view's water reaches to the horizon only where the sea leaves the world. A landlocked world with rivers used to
// draw the sea's horizon at sea level past its edge: a flat blue plane beyond the far ground (KB-BIOMES-WORLDEDGE1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';
import { BiomeWorld } from '../dist/index.js';
import { BiomeView } from '../dist/view.js';
import { WATER_LOOKS, applyWaterSettings } from '@margoengine/water/settings';

for (const [label, relief, horizon] of [
  ['a landlocked valley', { seed: 3, relief: 200, base: 900, rivers: 1 }, false],
  // Its south edge stands 28 m under the sea.
  ['a coast', { seed: 3, relief: 900, base: 300, rivers: 1, coast: 'south' }, true],
])
  test(`river water over ${label} has horizon ${horizon} (KB-BIOMES-WORLDEDGE1)`, { timeout: 120000 }, async () => {
    const adapter = await nodeLifetimeAdapter();
    try {
      const { engine } = await adapter.create();
      const world = await BiomeWorld.create({
        size: [4096, 4096],
        workers: 0,
        height: { relief },
      });
      const view = await BiomeView.attach(engine, world, {
        objects: false,
        canopy: 0,
        textureResolution: 16,
        water: { rivers: 'auto' },
      });
      assert.equal(view.water.options.horizon, horizon);
      // KB-BIOMES-LOOKFAMILY1: inland water raises the waves of a wind, so a look's wind rows apply; a sea keeps its
      // two swell trains.
      if (horizon) assert.equal(view.water.options.waves.length, 2);
      else applyWaterSettings(view.water, WATER_LOOKS.animatedFeature);
      view.dispose();
      world.dispose();
      engine.dispose();
    } finally {
      adapter.close();
    }
  });
