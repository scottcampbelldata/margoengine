// Regressions for the batch 132 audit of @margoengine/scatter. Each test fails on the code before the audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '@margoengine/core';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { Scatter, ScatterInstances } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

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
