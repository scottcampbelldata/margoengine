// BiomeView, BiomeObjects and FarForest attach after awaiting their imports. Attached from a secondary scene's setup,
// every part they register must land in that scene, not in whichever scene is active once the imports are in; and a
// view whose scene removes its registration must end with it (owner/lifetime sweep, 2026-11-15, KB-OWN-BIOMES1/2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nodeLifetimeAdapter } from '../../../tests/support/owner-lifetime-node.js';
import { BiomeWorld } from '../dist/index.js';
import { BiomeView } from '../dist/view.js';

const attachFrom = (scene, engine, world, options) => {
  let pending;
  const scope = {
    name: 'test:attach-from',
    setup() {
      pending = BiomeView.attach(engine, world, options);
    },
  };
  scene.use(scope);
  scene.removePlugin(scope.name);
  return pending;
};

for (const [label, options] of [
  ['terrain only', { objects: false, water: false, canopy: 0 }],
  ['objects and far stand-ins', { water: false, far: { radius: 600 }, radius: 300 }],
])
  test(`BiomeView (${label}) attached from a secondary scene registers every part there`, {
    timeout: 120000,
  }, async () => {
    const adapter = await nodeLifetimeAdapter();
    try {
      const { engine } = await adapter.create();
      const scene = engine.createScene(),
        before = new Set(engine.scene.plugins.keys());
      const world = await BiomeWorld.create({ size: [512, 512], workers: 0 });
      const view = await attachFrom(scene, engine, world, options);
      assert.deepEqual(
        [...engine.scene.plugins.keys()].filter((name) => !before.has(name)),
        [],
      );
      assert.equal(engine.sceneOf(view.terrain), scene);
      assert.ok([...scene.plugins.keys()].some((name) => name.startsWith('biomes-view:')));
      view.dispose();
      assert.deepEqual([...scene.plugins.keys()], []);
      world.dispose();
      engine.dispose();
    } finally {
      adapter.close();
    }
  });

test('a BiomeView whose scene removes its registration is disposed with it', { timeout: 120000 }, async () => {
  const adapter = await nodeLifetimeAdapter();
  try {
    const { engine } = await adapter.create();
    const world = await BiomeWorld.create({ size: [512, 512], workers: 0 });
    const view = await BiomeView.attach(engine, world, { objects: false, water: false, canopy: 0 });
    const name = [...engine.scene.plugins.keys()].find((n) => n.startsWith('biomes-view:'));
    engine.scene.removePlugin(name);
    // dispose() ran: the terrain left too, and streaming stopped.
    assert.equal(engine.sceneOf(view.terrain), undefined);
    assert.equal(view.streaming.pending, 0);
    world.dispose();
    engine.dispose();
  } finally {
    adapter.close();
  }
});
