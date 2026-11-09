import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../dist/index.js';
import { TAAUpscale } from '../dist/upscale.js';
import { unjitteredCamera } from '../../shared/temporal-camera.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { wgsl } from '../../core/src/shaders.ts';
for (const Type of [TAA, TAAUpscale])
  test(`${Type.name} exposes the unjittered source only on its temporary wrapper`, () => {
    const gpu = mockGPU(),
      engine = {
        gpu: gpu.device,
        hasPlugin: () => false,
        meshes: new Map(),
        stats: { drawCalls: 0 },
        sceneOf() {
          return undefined;
        },
        removePlugin() {},
        store: { visible: new Uint8Array(1), hidden: new Uint8Array(1), parents: new Int32Array(1).fill(-1) },
      };
    const effect = new Type(),
      passes = [];
    effect.setup(engine);
    effect.registerPasses({
      add(p) {
        passes.push(p);
      },
    });
    const view = context(gpu, { samples: 4, shader: wgsl });
    view.begin(0);
    const camera = view.c.camera;
    const source = Array.from(camera.matrix);
    passes[0].execute(view.c);
    assert.notEqual(view.c.camera, camera);
    assert.equal(unjitteredCamera(view.c.camera), camera);
    assert.deepEqual(Array.from(camera.matrix), source, 'raster jitter never mutates the source projection');
    for (const pass of passes.slice(1)) pass.execute(view.c);
    assert.equal(view.c.camera, camera, 'temporal resolve restores the source');
    effect.dispose();
  });
