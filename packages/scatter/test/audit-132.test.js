// Regressions for the batch 132 audit of @margoengine/scatter. Each test fails on the code before the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Scatter, ScatterInstances } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { compatChunk } from '../../../tests/support/compat-chunk.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };

// `engine.removePlugin(name)` acts on the active scene, so a Scatter or ScatterInstances attached to another scene
// stayed registered there after dispose (its hooks still ran on released buffers), and a same-name plugin in the
// active scene was removed instead.
for (const [label, make] of [
  ['Scatter', () => new Scatter(box(), { count: 4 })],
  ['ScatterInstances', () => new ScatterInstances(() => [])],
])
  test(`${label}.dispose removes it from its own scene, not the active scene's same-name plugin`, async () => {
    const h = optionalGPU(),
      engine = new Engine(
        { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
        await TransformStore.create(4),
        { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, render() {}, dispose() {} },
        {},
        null,
      );
    try {
      const other = engine.createScene('other'),
        plugin = make(),
        kept = { name: plugin.name, disposed: 0, setup() {}, dispose: () => kept.disposed++ };
      other.use(plugin);
      engine.use(kept);
      plugin.dispose();
      assert.equal(other.plugins.has(plugin.name), false, 'the disposed plugin stayed in its scene');
      assert.equal(engine.plugins.get(plugin.name), kept, 'the active scene lost its own plugin');
      assert.equal(kept.disposed, 0);
    } finally {
      engine.dispose();
      h.cleanup();
    }
  });

// Batch 132b: ScatterRoute (the WebGL2 layer's route) built each cascade count's shadow lists, prefix and counts into
// the route-wide owned list, so changing the cascade count left the old set alive until the scatter was released.
test('ScatterRoute frees the previous shadow lists when the cascade count changes', async () => {
  // The route is a lazy chunk with a content hash in its name.
  const { ScatterRoute } = await compatChunk(new URL('../dist/', import.meta.url), 'ScatterRoute');
  const h = optionalGPU(),
    d = h.engine.gpu,
    buffer = (size) => d.createBuffer({ size, usage: 128 }),
    rings = [buffer(64), buffer(64), buffer(64)],
    route = new ScatterRoute({
      device: d,
      cull: new Scatter(box(), { count: 2 }).cullCode(),
      count: 2,
      capacity: 2,
      uniform: buffer(352),
      rings,
      commands: buffer(60),
      exclusions: buffer(16),
      vertices: [buffer(24), buffer(24), buffer(24)],
      indices: [buffer(12), buffer(12), buffer(12)],
      indexCounts: [3, 3, 3],
      values: new Float32Array(80),
      shadowCode: '',
      shadowListCode: '',
      shadowDepth: () => ({}),
    }),
    live = () => h.resources.filter((r) => !r.destroyed).length,
    matrices = new Float32Array(64);
  route.prepareShadow(h.context.encoder, matrices, 2, 1);
  const two = live();
  route.prepareShadow(h.context.encoder, matrices, 3, 1);
  route.prepareShadow(h.context.encoder, matrices, 2, 1);
  assert.equal(live(), two);
  route.destroy();
  h.cleanup();
});
