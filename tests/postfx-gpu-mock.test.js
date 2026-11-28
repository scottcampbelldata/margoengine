// The GPU test mock's engine refuses a plugin as core's Engine.use does. Until 2026-11-28 a second plugin under a taken
// name went in, its pass name clashed ("Invalid pass") and the rollback deleted the plugin that held the name, so a test
// could not see the refusal core gives (KB-SKY-CLOUDTWO1 was found on a real engine, not in the mock).
import test from 'node:test';
import assert from 'node:assert/strict';
import { gpuHarness } from './support/postfx-gpu.js';

const plugin = (name) => ({
  name,
  setup() {},
  registerPasses(graph) {
    graph.add({ name, order: 1, execute() {} });
  },
  disposed: 0,
  dispose() {
    this.disposed++;
  },
});

test('the mock refuses a taken plugin name before anything changes, as core does', () => {
  const { engine } = gpuHarness(),
    first = plugin('one'),
    second = plugin('one');
  assert.equal(engine.use(first), engine);
  assert.throws(() => engine.use(second), { name: 'TypeError', message: /Invalid plugin/ });
  assert.equal(engine.plugins.get('one'), first, 'the plugin holding the name stays');
  assert.equal(first.disposed, 0);
  assert.equal(second.disposed, 0, 'a refused plugin was never set up, so it is not disposed');
  assert.throws(() => engine.use(first), /Invalid plugin/, 'a plugin already in use');
  assert.throws(() => engine.use({ name: 'two' }), /Invalid plugin/, 'a plugin without setup');
  assert.throws(() => engine.use({ name: '', setup() {} }), /Invalid plugin/, 'a plugin without a name');
});
