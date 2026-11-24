import assert from 'node:assert/strict';
import { test } from 'node:test';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

// Regressions for the wrong-scene dispose bug: `engine.removePlugin(name)` acts on the active scene, so disposing a
// plugin attached to another scene removed the active scene's same-name plugin and left the disposed one running.
const realEngine = async (h) =>
  new Engine(
    { width: 16, height: 16 },
    await TransformStore.create(4),
    { backend: 'webgpu', gpu: h.engine.gpu, dispose() {} },
    {},
    null,
  );
globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
if (!globalThis.navigator?.gpu)
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: { getPreferredCanvasFormat: () => 'bgra8unorm' },
    configurable: true,
  });
// Runs `make` while `scene` is the active scene, as a loader called from that scene's plugin setup does.
const within = (scene, make) => {
  let made;
  scene.use({
    name: 'dispose-scene:within',
    setup() {
      made = make();
    },
  });
  scene.removePlugin('dispose-scene:within');
  return made;
};
// A plugin of the same name in the active (default) scene, which the dispose must leave alone.
const sentinel = (engine, name) => {
  const plugin = {
    name,
    disposed: 0,
    setup() {},
    dispose() {
      plugin.disposed++;
    },
  };
  engine.use(plugin);
  return plugin;
};
const survived = (engine, plugin) => {
  assert.equal(engine.plugins.get(plugin.name), plugin, 'the active scene lost its own same-name plugin');
  assert.equal(plugin.disposed, 0, "the active scene's same-name plugin was disposed");
};
import { GrassField, Planet } from '../dist/index.js';

// The GPU set-up needs a real device; the dispose path only needs the engine it records.
class BareGrass extends GrassField {
  setup(engine) {
    this.engine = engine;
  }
}

test("GrassField.dispose removes it from its own scene, not the active scene's same-name plugin", async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  try {
    const other = engine.createScene('other'),
      grass = within(other, () => new BareGrass({ engine }, { blades: 4 })),
      kept = sentinel(engine, grass.name);
    grass.dispose();
    survived(engine, kept);
    assert.equal(other.plugins.has(grass.name), false, 'the disposed grass stayed in its scene');
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

// Answers only by rejecting once its request is aborted.
const neverAnswers = (_, init) =>
  new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal.reason)));

test("Planet.dispose removes it from its own scene, not the active scene's same-name plugin", async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  try {
    const other = engine.createScene('other'),
      // Planet.create attaches before its maps load; a fetch that never answers keeps it loading.
      loading = within(other, () => Planet.create(engine, { dayMap: 'day.png', fetch: neverAnswers })),
      planet = other.plugins.get('planet'),
      kept = sentinel(engine, planet.name);
    planet.dispose();
    await assert.rejects(loading);
    survived(engine, kept);
    assert.equal(other.plugins.has(planet.name), false, 'the disposed planet stayed in its scene');
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
