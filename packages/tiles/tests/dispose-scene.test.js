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
import { TilesRenderer } from '../dist/index.js';
import { TileFeatures } from '../dist/features.js';
import { PointsPlugin } from '../../points/dist/index.js';
import { memoryFetch } from './generator.js';

const tileset = () =>
  memoryFetch(
    new Map([
      [
        'tileset.json',
        new TextEncoder().encode(
          JSON.stringify({
            asset: { version: '1.1' },
            geometricError: 10,
            root: { boundingVolume: { box: [0, 0, 0, 5, 0, 0, 0, 5, 0, 0, 0, 5] }, geometricError: 0 },
          }),
        ),
      ],
    ]),
  );

test("TilesRenderer.dispose removes it and its points plugin from its own scene, not the active scene's", async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  try {
    const memory = tileset(),
      // Loaded without attaching, then attached to the second scene.
      renderer = await TilesRenderer.load({ use() {} }, memory.url, { fetch: memory.fetch }),
      other = engine.createScene('other');
    other.use(renderer);
    // Point-cloud tiles make the points plugin after an import: it belongs in the renderer's scene too.
    // Its GPU set-up needs a real device; the scene it joins does not.
    const { setup, registerPasses } = PointsPlugin.prototype;
    PointsPlugin.prototype.setup = PointsPlugin.prototype.registerPasses = () => {};
    try {
      await renderer['loadPoints'](engine);
    } finally {
      Object.assign(PointsPlugin.prototype, { setup, registerPasses });
    }
    const points = `${renderer.name}-points`;
    assert.equal(other.plugins.has(points), true, "the points plugin missed the renderer's scene");
    const kept = sentinel(engine, renderer.name),
      keptPoints = sentinel(engine, points);
    renderer.dispose();
    survived(engine, kept);
    survived(engine, keptPoints);
    assert.equal(other.plugins.size, 0, 'the disposed renderer or its points plugin stayed in its scene');
  } finally {
    engine.dispose();
    h.cleanup();
  }
});

test("TileFeatures.dispose removes it from its own scene, not the active scene's same-name plugin", async () => {
  const h = optionalGPU(),
    engine = await realEngine(h);
  try {
    const other = engine.createScene('other'),
      features = within(other, () => new TileFeatures(engine)),
      kept = sentinel(engine, features.name);
    features.dispose();
    survived(engine, kept);
    assert.equal(other.plugins.has(features.name), false, 'the disposed controller stayed in its scene');
  } finally {
    engine.dispose();
    h.cleanup();
  }
});
