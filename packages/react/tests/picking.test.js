import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const created = [];
class Picking {
  static forEngine(engine) {
    return engine.plugins.get('picking');
  }
  static attach(engine, options) {
    const picker = new Picking(engine, options);
    engine.plugins.set('picking', picker);
    created.push(picker);
    return picker;
  }
  constructor(engine, options) {
    this.engine = engine;
    this.options = options;
    this.sources = new Set();
    this.disposals = 0;
  }
  add(model) {
    assert.ok(!this.sources.has(model));
    this.sources.add(model);
    return () => this.sources.delete(model);
  }
  dispose() {
    this.disposals++;
    this.sources.clear();
    this.engine.plugins.delete('picking');
  }
}
mock.module('@margoengine/selection', { namedExports: { Picking } });
const { preparePicking, releasePicking } = await import('../dist/picking.js');
const fixture = () => {
  const plugins = new Map();
  return {
    engine: { disposed: false, plugins, hasPlugin: (name) => plugins.has(name) },
    resources: { models: new Set() },
    frames: { callbacks: new Set() },
  };
};

test('one owned GPU picker tracks all current models and releases its sources and frame callback', async () => {
  const { engine, resources, frames } = fixture(),
    first = { disposed: false },
    second = { disposed: false };
  resources.models.add(first);
  await preparePicking(engine, resources, frames);
  const picker = engine.plugins.get('picking');
  assert.deepEqual(picker.options, { capture: false });
  resources.models.add(second);
  resources.models.delete(first);
  await preparePicking(engine, resources, frames);
  assert.equal(engine.plugins.get('picking'), picker);
  assert.deepEqual([...picker.sources], [second]);
  assert.equal(frames.callbacks.size, 1);
  releasePicking(engine);
  releasePicking(engine);
  assert.equal(picker.disposals, 1);
  assert.equal(picker.sources.size, 0);
  assert.equal(frames.callbacks.size, 0);
});
test('a configured native picker is borrowed without changing its options or disposing caller sources', async () => {
  const { engine, resources, frames } = fixture(),
    callerModel = { disposed: false },
    reactModel = { disposed: false };
  const external = Picking.attach(engine, { capture: true });
  external.add(callerModel);
  resources.models.add(reactModel);
  await preparePicking(engine, resources, frames);
  assert.equal(engine.plugins.get('picking'), external);
  assert.deepEqual(external.options, { capture: true });
  assert.equal(external.sources.size, 2);
  releasePicking(engine);
  assert.equal(external.disposals, 0);
  assert.deepEqual([...external.sources], [callerModel]);
  assert.equal(frames.callbacks.size, 0);
  external.dispose();
});
test('releasing a pending picker import prevents late plugin construction', async () => {
  const { engine, resources, frames } = fixture(),
    before = created.length;
  resources.models.add({ disposed: false });
  const pending = preparePicking(engine, resources, frames);
  releasePicking(engine);
  await pending;
  assert.equal(created.length, before);
  assert.equal(engine.plugins.size, 0);
  assert.equal(frames.callbacks.size, 0);
});
