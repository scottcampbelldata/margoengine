import test from 'node:test';
import assert from 'node:assert/strict';
import { GlWorldPanels, WorldPanels, WorldPanel } from '../dist/world-gl.js';
import { WorldPanel as ExistingPanel } from '../dist/world.js';
import { makeUi } from './helpers.js';
test('world-gl preserves panel identity and registers a raw WebGL2 draw without a WebGPU device', () => {
  assert.equal(WorldPanels, GlWorldPanels);
  assert.equal(WorldPanel, ExistingPanel);
  const ui = makeUi(),
    panel = new WorldPanel(ui),
    renderer = new GlWorldPanels({ input: false });
  renderer.setup({ sceneOf: () => undefined, backend: 'webgl2' });
  renderer.add(panel);
  const passes = [];
  renderer.registerPasses({ add: (p) => passes.push(p) });
  assert.equal(passes.length, 1);
  assert.equal(passes[0].name, 'ui-world:draw');
  renderer.onPreUpdate(0);
  assert.equal(renderer.list[0], panel);
  renderer.remove(panel);
  assert.equal(renderer.list.length, 0);
  renderer[Symbol.dispose]();
  ui.dispose();
});
test('world-gl static attach uses the engine plugin lifecycle', () => {
  let plugin;
  const engine = {
    use: (p) => {
      plugin = p;
      p.setup({ sceneOf: () => undefined, backend: 'webgl2' });
      return engine;
    },
  };
  const renderer = GlWorldPanels.attach(engine, { input: false, name: 'test-world' });
  assert.equal(renderer, plugin);
  assert.equal(renderer.name, 'test-world');
  renderer.dispose();
});
