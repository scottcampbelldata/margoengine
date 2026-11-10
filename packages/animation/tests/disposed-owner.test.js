import assert from 'node:assert/strict';
import test from 'node:test';
import { fixtures, ownerEngine } from './owner-lifetime.fixture.js';

const moduleRoot = process.env.MARGO_TERMINAL_MODULE_ROOT;
const load = (entry) => import(new URL(moduleRoot ? entry.replace('../dist/', moduleRoot) : entry, import.meta.url).href);
for (const fixture of await fixtures(load)) {
  if (!['VATCrowd', 'SkinnedCrowd', 'AnimationLOD', 'MorphWeightPlayer', 'GLTFInteractivity'].includes(fixture.name)) continue;
  test(`${fixture.name} rejects terminal reattachment without retaining an owner`, async (t) => {
    const engine = await ownerEngine(t);
    let handle;
    try {
      handle = await fixture.create({ engine, scene: engine.scene, dependency: (fn) => fn() });
      if (!engine.sceneOf(handle.plugin)) engine.use(handle.plugin);
      handle.dispose();
      const scene = engine.createScene('terminal-reattach');
      assert.throws(() => scene.use(handle.plugin), { code: 'disposed' });
      assert.equal(engine.sceneOf(handle.plugin), undefined);
      assert.equal(scene.plugins.size, 0);
    } finally { handle?.dispose(); await handle?.cleanup?.(); }
  });
}
