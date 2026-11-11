import test from 'node:test';
import assert from 'node:assert/strict';
import { Shadows } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// On the WebGL2 layer the PCSS nearest-depth reduction has its own route (src/compat.ts), loaded by import(). The
// WebGPU kernel's atomics put it on the layer's CPU tier (the whole map read back and looped over in JavaScript).
// Device-recreation soak (scripts/device-recreation-soak.mjs): after a restore, frames drawn before import() settled
// ran that kernel, so the route never built its level texture and the live count went 6, 5, 6 from run to run.
test('on the WebGL2 layer a restored device takes the nearest-depth route from its first frame', async () => {
  const h = optionalGPU(),
    engine = h.engine;
  engine.gpu.adapterInfo = { vendor: 'margo-webgl2' };
  engine.gpu.limits.maxTextureDimension2D = 8192;
  engine.gpu.limits.maxTextureArrayLayers = 256;
  engine.lighting = { direction: new Float32Array([1, 2, 3, 3]) };
  const textures = h.resources,
    kernels = () => h.pipelines.filter((p) => p.compute && /atomic<u32>/.test(p.compute.module.code)).length,
    levels = (from) => textures.slice(from).filter((t) => t.format === 'r32float' && !t.destroyed).length;
  const shadows = new Shadows({ resolution: 64 });
  shadows.add({ drawShadow() {} });
  engine.use(shadows);
  const frame = () => {
    h.context.shader = 'let linear=direct*vec3f(1);';
    h.context.bindings.length = 0;
    engine.frameGraph.execute(h.context);
  };
  // The first attach loads the route; wait for it as a page does between frames.
  for (let i = 0; i < 50 && !levels(0); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    frame();
  }
  assert.equal(levels(0), 1, 'the route builds one 4 x 4 level for a 64 x 64 map');
  for (let restore = 1; restore <= 3; restore++) {
    const from = textures.length,
      before = kernels();
    shadows.onDeviceRestored(engine);
    frame();
    assert.equal(levels(from), 1, `restore ${restore}: the first frame builds the route's level`);
    assert.equal(kernels(), before, `restore ${restore}: the WebGPU atomics kernel is not compiled on the layer`);
  }
  shadows.dispose();
  h.cleanup();
});
