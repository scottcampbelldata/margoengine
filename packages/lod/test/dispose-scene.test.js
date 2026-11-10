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
    { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
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
import { box } from '../../core/dist/extension.js';
import { LODSystem } from '@margoengine/lod';
import { hierarchicalLOD } from '@margoengine/lod/auto';

test("hierarchicalLOD's follow plugin leaves its own scene on remove, not the active scene's same-name plugin", async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  try {
    const system = LODSystem.attach(engine),
      other = engine.createScene('other'),
      a = other.createMesh().setGeometry(box(1, 1, 1)),
      b = other
        .createMesh()
        .setGeometry(box(1, 1, 1))
        .setPosition([100, 0, 0]);
    engine.store.tick(false);
    // Built from the second scene's setup: the follow plugin joins that scene.
    const built = await within(other, () => hierarchicalLOD(system, [a, b], { cell: 50, follow: true })),
      name = [...other.plugins.keys()].find((key) => key.startsWith('lod-follow'));
    assert.ok(name, 'the follow plugin is in the second scene');
    const kept = sentinel(engine, name);
    built.remove();
    survived(engine, kept);
    assert.equal(other.plugins.has(name), false, 'the removed follow plugin stayed in its scene');
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
