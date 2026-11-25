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
import { previewSurface } from '../dist/preview-surface.js';

// A model whose one primitive carries USD straight alpha: enough for the preview-opacity plugin to attach.
const straightAlpha = () => {
  const goes = [];
  return {
    primitives: [{ material: { extras: { usdPreviewStraightAlpha: true } }, definition: {} }],
    onDispose: (callback) => goes.push(callback),
    dispose: () => goes.forEach((callback) => callback()),
  };
};

test("the preview-opacity plugin leaves its own scene with its model, not the active scene's same-name plugin", async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  h.engine.gpu.queue.writeTexture = () => {};
  try {
    const other = engine.createScene('other'),
      model = straightAlpha();
    within(other, () => previewSurface().created(engine, model));
    const name = [...other.plugins.keys()].find((key) => key.startsWith('usd-preview-opacity-'));
    assert.ok(name, 'the plugin is in the second scene');
    const kept = sentinel(engine, name);
    model.dispose();
    survived(engine, kept);
    assert.equal(other.plugins.has(name), false, 'the plugin stayed in its scene after its model went');
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

// A curves() import attaches its Lines and Points plugins after dynamic imports, when the active scene is the default
// one again: they belong in the scene the model is in.
test('curves() puts its lines and points plugins in the model scene and removes them from it', async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  const { Lines } = await import('@margoengine/lines'),
    { PointsPlugin, PointCloud } = await import('@margoengine/points'),
    { curves } = await import('../dist/curves.js');
  // GPU set-up needs a real device; the scene a plugin joins does not.
  const saved = [Lines, PointsPlugin].map((type) => [type, type.prototype.setup, type.prototype.registerPasses]);
  for (const [type] of saved) type.prototype.setup = type.prototype.registerPasses = () => {};
  try {
    const other = engine.createScene('other'),
      goes = [],
      mesh = { visible: true, check() {} },
      data = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
      model = {
        name: 'usd-curves-model',
        setup() {},
        asset: {
          accessor: (index) =>
            index === 1 ? new Float32Array([1, 1, 1]) : index === 2 ? new Float32Array(12).fill(1) : data,
          doc: {
            meshes: [
              {
                extras: {
                  usdCurves: [
                    { kind: 'curve', points: 0, widths: 1, colors: 2 },
                    { kind: 'points', points: 0, widths: 1, colors: 2 },
                  ],
                },
              },
            ],
            nodes: [{ mesh: 0 }],
          },
        },
        nodes: [mesh],
        onDispose: (callback) => goes.push(callback),
      };
    // The model is in `other`; the default scene stays the active one, as it is after the hook's awaits.
    other.use(model);
    assert.equal(engine.sceneOf(model), other);
    PointCloud.prototype.attach = function () {
      return this;
    };
    await curves().created(engine, model);
    const names = ['usd-curves-lines-0', 'usd-curves-points-0'];
    for (const name of names) {
      assert.equal(other.plugins.has(name), true, `${name} missed the model's scene`);
      assert.equal(engine.plugins.has(name), false, `${name} landed in the active scene`);
    }
    const kept = names.map((name) => sentinel(engine, name));
    goes.forEach((callback) => callback());
    for (const plugin of kept) survived(engine, plugin);
    for (const name of names) assert.equal(other.plugins.has(name), false, `${name} stayed in its scene`);
  } finally {
    for (const [type, setup, registerPasses] of saved) Object.assign(type.prototype, { setup, registerPasses });
    engine.dispose();
    h.cleanup();
  }
});
