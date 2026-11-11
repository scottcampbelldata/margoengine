import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Shadows } from '../dist/index.js';
import { VirtualShadows } from '../dist/virtual.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// dispose() must leave the scene the plugin lives in, not the engine's active scene.
for (const [name, make] of [['Shadows', () => new Shadows({ resolution: 64 })], ['VirtualShadows', () => new VirtualShadows()]])
  test(`${name}.dispose() removes itself from a non-active scene`, async (t) => {
    const gpu = optionalGPU(),
      engine = new Engine(
        { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
        await TransformStore.create(16),
        { backend: 'webgpu', gpu: gpu.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
        undefined,
        null,
      );
    t.after(() => { engine.dispose(); gpu.cleanup(); });
    const scene = engine.createScene('other'), plugin = make();
    scene.use(plugin);
    assert.equal(engine.sceneOf(plugin), scene);
    plugin.dispose();
    assert.equal(engine.sceneOf(plugin), undefined);
    assert.equal(scene.plugins.has(plugin.name), false);
  });
