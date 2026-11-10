// Regressions for the batch 132 audit of @margoengine/culling. Each test fails on the code before the audit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { box, PbrMaterial } from '@margoengine/core';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { CulledInstances, CulledMeshes } from '../dist/index.js';
import { DynamicInstances } from '../dist/dynamic.js';
import { LodInstances } from '../dist/lod.js';
import { CulledModels } from '../dist/models.js';
import { FrontToBack } from '../dist/sort.js';
import { WebGL2Culling } from '../dist/webgl2.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
};
const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

const plugins = [
  [
    'CulledInstances',
    () => new CulledInstances([{ geometry: box(), material: new PbrMaterial(), transforms: identity() }]),
  ],
  ['DynamicInstances', () => new DynamicInstances({ geometry: box(), material: new PbrMaterial(), capacity: 4 })],
  [
    'LodInstances',
    () => new LodInstances({ levels: [{ geometry: box() }], material: new PbrMaterial(), transforms: identity() }),
  ],
  ['CulledMeshes', () => new CulledMeshes()],
  ['CulledModels', () => new CulledModels()],
  ['FrontToBack', () => new FrontToBack()],
  ['WebGL2Culling', () => new WebGL2Culling()],
];

for (const [label, make] of plugins)
  test(`${label}.dispose leaves the scene it was attached to, not the active scene`, async () => {
    const h = optionalGPU();
    h.engine.gpu.createPipelineLayout ??= (descriptor) => descriptor;
    const engine = new Engine(
      { width: 16, height: 16 },
      await TransformStore.create(4),
      { backend: 'webgpu', gpu: h.engine.gpu, add() {}, remove() {}, dispose() {} },
      {},
      null,
    );
    try {
      const other = engine.createScene('other'),
        plugin = make();
      other.use(plugin);
      assert.equal(engine.sceneOf(plugin), other);
      plugin.dispose();
      assert.equal(other.plugins.size, 0, 'the disposed plugin stayed registered in its scene');
      assert.equal(engine.sceneOf(plugin), undefined);
    } finally {
      engine.dispose();
      h.cleanup();
    }
  });
