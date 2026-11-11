import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../dist/index.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig(options = {}) {
  const gpu = mockGPU(),
    engine = {
      gpu: gpu.device,
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
      stats: { drawCalls: 0 },
      sceneOf: () => undefined,
    };
  const terrain = new Terrain({
    resolution: 8,
    levels: 3,
    size: [32, 32],
    layers: Array.from({ length: 4 }, () => ({ height: [-10, 10], slope: [0, 1], scale: 1 })),
    textures: (device) => {
      const texture = (format, layers = 1) =>
        device.createTexture({ size: [4, 4, layers], format, usage: GPUTextureUsage.TEXTURE_BINDING });
      return { heightmap: texture('r32float'), layers: texture('rgba8unorm', 4) };
    },
    ...options,
  });
  gpu.record(() => terrain.setup(engine));
  const passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: '' });
  return { gpu, engine, terrain, view, prepare: passes[0] };
}

test('a still camera does not redraw the shadow maps when the ring spacing is not exact in float32', () => {
  // cellSize 0.1: the snapped ring corner 3 * 0.1 = 0.30000000000000004 is not a float32, so comparing the uniform's
  // float32 with it read as a ring move on every frame and invalidated Shadows and LocalShadows every frame.
  const { gpu, terrain, view, prepare } = rig({ cellSize: 0.1 });
  const frame = () =>
    gpu.record(() => {
      view.begin(0);
      view.c.camera.position[0] = 0.35;
      view.c.camera.position[2] = 0.35;
      prepare.execute(view.c);
    });
  frame();
  const after = terrain.shadowVersion;
  frame();
  frame();
  assert.equal(terrain.shadowVersion, after);
});
