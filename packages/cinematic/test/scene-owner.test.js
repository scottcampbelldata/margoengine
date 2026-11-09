import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '@margoengine/core/extension';
import { Cinematic } from '../dist/index.js';
import { CameraBrain } from '../dist/brain.js';

async function fixture(t) {
  const engine = new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(32),
    {
      backend: 'webgl2',
      add() {},
      remove() {},
      render() {},
      dispose() {},
    },
    undefined,
    null,
  );
  t.after(() => engine.dispose());
  return engine;
}

for (const [name, Plugin] of Object.entries({ Cinematic, CameraBrain })) {
  for (const target of ['default', 'secondary'])
    for (const mode of ['direct', 'owner', 'scene', 'engine']) {
      if (target === 'default' && mode === 'scene') continue;
      test(`${name} ${target} ${mode} disposal releases its registration identity`, async (t) => {
        const engine = await fixture(t);
        const scene = target === 'default' ? engine.scene : engine.createScene('cinematic-owner');
        const plugin = new Plugin();
        scene.use(plugin);
        let removed = 0;
        const sentinel = {
          name: plugin.name,
          setup() {},
          dispose() {
            removed++;
          },
        };
        if (target === 'secondary') engine.use(sentinel);
        plugin.onDeviceRestored?.(engine);
        if (mode === 'direct') plugin.dispose();
        else if (mode === 'owner') scene.removePlugin(plugin.name);
        else if (mode === 'scene') scene.dispose();
        else engine.dispose();
        assert.equal(engine.sceneOf(plugin), undefined);
        if (target === 'secondary' && mode !== 'engine') {
          assert.equal(engine.scene.plugins.get(plugin.name), sentinel);
          assert.equal(removed, 0);
        }
        if (mode === 'direct' || mode === 'owner') {
          const replacement = { name: plugin.name, setup() {} };
          scene.use(replacement);
          plugin.dispose();
          assert.equal(scene.plugins.get(plugin.name), replacement);
        }
      });
    }
  test(`${name} can reattach to another scene and dispose that identity`, async (t) => {
    const engine = await fixture(t);
    const plugin = new Plugin();
    engine.use(plugin);
    plugin.dispose();
    const next = engine.createScene('next');
    next.use(plugin);
    assert.equal(engine.sceneOf(plugin), next);
    const sentinel = { name: plugin.name, setup() {} };
    engine.use(sentinel);
    plugin.dispose();
    assert.equal(engine.sceneOf(plugin), undefined);
    assert.equal(engine.scene.plugins.get(plugin.name), sentinel);
  });
}
