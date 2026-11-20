import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// KB-COMPAT-CPUBUDGET1: on the WebGL2 layer the first Shadows of a page loads its nearest-depth route by import().
// Frames drawn before it settled ran the WebGPU kernel (workgroup atomics), which the layer runs on its CPU tier; the
// dune coast's 4,096 map with four cascades is 128 x 128 x 4 workgroups, past the tier's work budget, so the page threw
// "stopped at its work budget". The reduction now waits for the route and runs on the frame after it arrives. Its own
// file: the route is cached per module once loaded, and this test needs the first load.
test('on the WebGL2 layer the nearest-depth reduction waits for its route instead of running the CPU-tier kernel', async () => {
  const h = optionalGPU(),
    engine = h.engine;
  engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  engine.gpu.limits.maxTextureDimension2D = 8192;
  engine.gpu.limits.maxTextureArrayLayers = 256;
  engine.lighting = { direction: new Float32Array([1, 2, 3, 3]) };
  const kernels = () => h.pipelines.filter((p) => p.compute && /atomic<u32>/.test(p.compute.module.code)).length,
    levels = () => h.resources.filter((t) => t.format === 'r32float' && !t.destroyed).length;
  const shadows = new Shadows({ resolution: 64 });
  shadows.add({ drawShadow() {} });
  engine.use(shadows);
  const frame = () => {
    h.context.shader = 'let linear=direct*vec3f(1);';
    h.context.bindings.length = 0;
    engine.frameGraph.execute(h.context);
  };
  // Frames before import() settles: no reduction, and the WebGPU atomics kernel is never compiled.
  frame();
  frame();
  assert.equal(kernels(), 0, 'no WebGPU atomics kernel while the route loads');
  assert.equal(levels(), 0, 'the route has not built its level yet');
  for (let i = 0; i < 50 && !levels(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    frame();
  }
  assert.equal(levels(), 1, 'the first frame after the route arrives reduces the map on it');
  assert.equal(kernels(), 0, 'the WebGPU atomics kernel is not compiled on the layer');
  shadows.dispose();
  h.cleanup();
});
