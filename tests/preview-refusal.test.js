import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../packages/core/dist/extension.js';
import { MargoError } from '../packages/math/dist/errors.js';
import { requireWebGPU } from '../packages/shared/require-webgpu.js';
import { MorphWeightPlayer } from '../packages/animation/dist/morph-gpu.js';
import { VATCrowd } from '../packages/animation/dist/vat.js';
import { Lines } from '../packages/lines/dist/index.js';
import { LineBatches } from '../packages/lines/dist/batch.js';
import { PointsPlugin } from '../packages/points/dist/index.js';
import { SurfelPlugin } from '../packages/points/dist/surfels.js';
import { TextRenderer } from '../packages/text/dist/index.js';
import { WorldPanels } from '../packages/ui/dist/world.js';
import { Selection } from '../packages/selection/dist/index.js';
import { parseGLTF } from '../packages/gltf-pro/dist/index.js';
import { TerrainColors } from '../packages/terrain/dist/index.js';
import { XR } from '../packages/xr/dist/index.js';
import { animatedTriangle } from './support/gltf-pro-fixture.js';

test('the shared requirement rejects preview even when a device is supplied, and accepts both WebGPU-shaped tiers', () => {
  for (const host of [
    { backend: 'webgl2', gpu: null },
    { backend: 'webgl2', gpu: {} },
    { backend: 'webgpu', gpu: null },
  ])
    assert.throws(
      () => requireWebGPU(host, 'Test'),
      (error) =>
        error instanceof MargoError &&
        error.code === 'unsupported' &&
        /https:\/\/margoengine.com\/errors#webgpu/.test(error.message),
    );
  for (const gpu of [{}, { adapterInfo: { vendor: 'margo-webgl2' } }])
    assert.doesNotThrow(() => requireWebGPU({ backend: 'webgpu', gpu }, 'Test'));
});

test('the attachment refusal names the renderer and links the WebGPU help once', () => {
  assert.throws(
    () => requireWebGPU({ backend: 'webgl2', gpu: null }, 'Example renderer'),
    (error) => {
      assert.match(error.message, /Example renderer needs WebGPU/);
      assert.equal(error.message.match(/https:\/\//g).length, 1);
      return error.code === 'unsupported';
    },
  );
});

test('GPU-only optional packages refuse during attachment without retaining a plugin or a pass', async () => {
  const engine = new Engine({ width: 64, height: 64 }, await TransformStore.create(64), {
    backend: 'webgl2',
    add() {},
    remove() {},
    render() {},
    dispose() {},
  });
  try {
    const make = [
      () => new MorphWeightPlayer(),
      () => new VATCrowd({ texels: new Float32Array(8), clips: [{}] }),
      () => new Lines(),
      () => new LineBatches(),
      () => new PointsPlugin(),
      () => new SurfelPlugin(),
      () => new TextRenderer(),
      () => new WorldPanels(),
      () => new Selection(),
    ];
    for (const create of make) {
      const plugin = create();
      assert.throws(
        () => engine.use(plugin),
        (error) =>
          error instanceof MargoError &&
          error.code === 'unsupported' &&
          /https:\/\/margoengine.com\/errors#/.test(error.message),
        plugin.constructor.name,
      );
      assert.equal(engine.plugins.size, 0, plugin.constructor.name);
    }
    const fixture = animatedTriangle();
    assert.throws(
      () => parseGLTF(engine, fixture.doc, fixture.buffers),
      (error) => error.code === 'unsupported' && /https:\/\/margoengine.com\/errors#/.test(error.message),
    );
    assert.equal(engine.plugins.size, 0);
    const mesh = engine.createMesh();
    assert.throws(
      () =>
        TerrainColors.attach(engine, mesh, {
          sand: [0, 0, 0],
          meadow: [
            [0, 0, 0],
            [0, 0, 0],
          ],
          stone: [0, 0, 0],
          shore: [0, 1],
          meadowHeight: [1, 2],
          stoneHeight: [2, 3],
          stoneNormal: [0.5, 1],
          wetHeight: [0, 1],
          wetDarkening: 0.5,
        }),
      (error) => error.code === 'unsupported',
    );
    await assert.rejects(
      XR.create(engine),
      (error) => error.code === 'unsupported' && /https:\/\/margoengine.com\/errors#/.test(error.message),
    );
    let draws = 0;
    engine.frameGraph.execute({
      backend: 'webgl2',
      draw() {
        draws++;
      },
    });
    assert.equal(draws, 1, 'only the built-in main pass remains');
  } finally {
    engine.dispose();
  }
});
