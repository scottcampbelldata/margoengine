import test from 'node:test';
import assert from 'node:assert/strict';
import { Transitions } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

test('test-page 25: real Engine default-scene disposal permits immediate reattachment', async () => {
  const h = optionalGPU();
  const engine = new Engine(
    { width: 16, height: 16 },
    await TransformStore.create(4),
    { backend: 'webgpu', gpu: h.engine.gpu, dispose() {} },
    {},
    null,
  );
  try {
    const first = Transitions.attach(engine);
    assert.equal(engine.sceneOf(first), engine.scene);
    first.dispose();
    first.dispose();
    assert.equal(engine.plugins.size, 0);
    assert.equal(engine.sceneOf(first), undefined);
    const replacement = Transitions.attach(engine);
    assert.equal(engine.plugins.get(replacement.name), replacement);
    replacement.dispose();
    assert.equal(engine.plugins.size, 0);
    assert.ok(h.resources.every((resource) => resource.destroyed));
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test('dispose removes only the owning scene and leaves default-scene passes alive', async () => {
  const h = optionalGPU();
  const first = new Transitions();
  h.engine.use(first);
  const plugins = new Map();
  const owner = {
    removePlugin(name) {
      const plugin = plugins.get(name);
      plugins.delete(name);
      plugin?.dispose();
    },
  };
  const second = new Transitions();
  plugins.set(second.name, second);
  second.setup(h.engine);
  const sceneOf = h.engine.sceneOf.bind(h.engine);
  h.engine.sceneOf = (plugin) => (plugins.get(plugin.name) === plugin ? owner : sceneOf(plugin));
  second.dispose();
  second.dispose();
  assert.equal(plugins.size, 0);
  assert.equal(h.engine.plugins.get(first.name), first);
  h.frame();
  first.dispose();
  await null;
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
