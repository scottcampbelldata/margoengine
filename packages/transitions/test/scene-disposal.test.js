import test from 'node:test';
import assert from 'node:assert/strict';
import { Transitions } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

test('dispose removes only the owning scene and leaves default-scene passes alive', async () => {
  const h = optionalGPU();
  const first = new Transitions();
  h.engine.use(first);
  const plugins = new Map();
  const owner = { removePlugin(name) {
    const plugin = plugins.get(name);
    plugins.delete(name);
    plugin?.dispose();
  } };
  const second = new Transitions();
  plugins.set(second.name, second);
  second.setup(h.engine);
  const sceneOf = h.engine.sceneOf.bind(h.engine);
  h.engine.sceneOf = (plugin) => plugins.get(plugin.name) === plugin ? owner : sceneOf(plugin);
  second.dispose();
  second.dispose();
  assert.equal(plugins.size, 0);
  assert.equal(h.engine.plugins.get(first.name), first);
  h.frame();
  first.dispose();
  await null;
  assert.ok(h.resources.every(resource => resource.destroyed));
});
