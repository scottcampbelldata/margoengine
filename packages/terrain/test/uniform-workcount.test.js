import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Terrain } from '../dist/index.js';
import { mockGPU, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';

function rig() {
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
  });
  gpu.record(() => terrain.setup(engine));
  const passes = [];
  terrain.registerPasses({ add: (p) => passes.push(p) });
  passes.sort((a, b) => a.order - b.order);
  const view = context(gpu, { samples: 1, format: 'bgra8unorm', shader: '' });
  return { gpu, engine, terrain, view, prepare: passes[0] };
}
const pass = () => ({
  setPipeline() {},
  setBindGroup() {},
  setVertexBuffer() {},
  setIndexBuffer() {},
  drawIndexed() {},
});

// Frames: still camera, a moved camera, a light change, still again, and shadow matrices that change once.
const frames = [
  { frame: 0, light: 3, shadow: 1 },
  { frame: 0, light: 3, shadow: 1 },
  { frame: 0, light: 3, shadow: 1 },
  { frame: 9, light: 3, shadow: 1 },
  { frame: 9, light: 3, shadow: 1 },
  { frame: 9, light: 6, shadow: 1 },
  { frame: 9, light: 6, shadow: 2 },
  { frame: 9, light: 6, shadow: 2 },
];

function replay() {
  const { gpu, engine, terrain, view, prepare } = rig(),
    contents = new Map(),
    hash = createHash('sha256'),
    writes = [];
  for (const { frame, light, shadow } of frames) {
    engine.lighting.direction[3] = light;
    const matrix = Float32Array.from({ length: 16 }, (_, i) => i * shadow + 1);
    const log = gpu.record(() => {
      view.begin(frame);
      prepare.execute(view.c);
      for (let cascade = 0; cascade < 2; cascade++)
        terrain.drawShadow({ context: view.c, pass: pass(), matrix, cascade });
      terrain.drawLocalShadow({ context: view.c, pass: pass(), matrix, layer: 0 });
    });
    const written = log.filter((e) => e[0] === 'writeBuffer');
    writes.push(written.length);
    for (const w of written) contents.set(w[1], w[3]);
    // What the GPU holds in every uniform when the frame's commands run.
    hash.update(JSON.stringify([...contents].sort()));
  }
  return { writes, digest: hash.digest('hex'), buffers: contents.size };
}

test('unchanged ring and shadow uniforms are not uploaded again', () => {
  const { writes } = replay();
  // Parent: 12 writes every frame, 96 in all (3 rings x (1 main + 2 cascades + 1 local layer)).
  assert.deepEqual(writes, [12, 0, 0, 12, 0, 12, 9, 0]);
});

test('every uniform holds the parent bytes at every frame', () => {
  const { digest, buffers } = replay();
  assert.equal(buffers, 12);
  assert.equal(digest, '653e78b09281c96ea35d464ddb70c6a50d61b98c0ba937ef307e3a6ee10a3982');
});
