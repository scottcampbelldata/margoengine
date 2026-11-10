import test from 'node:test';
import assert from 'node:assert/strict';
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
    levels: 2,
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
  view.begin(0);
  passes[0].execute(view.c);
  view.end();
  return { gpu, terrain, view };
}
const pass = () => {
  const calls = [];
  const note =
    (name) =>
    (...a) =>
      calls.push([name, ...a]);
  return {
    calls,
    setPipeline: note('setPipeline'),
    setBindGroup: note('setBindGroup'),
    setVertexBuffer: note('setVertexBuffer'),
    setIndexBuffer: note('setIndexBuffer'),
    drawIndexed: note('drawIndexed'),
  };
};

test('terrain casts into clustered local shadow maps: reversed depth, one uniform set per ring and layer', () => {
  const { gpu, terrain, view } = rig();
  const matrix = (k) => Float32Array.from({ length: 16 }, (_, i) => i + k);
  const draw = (layer, k) => {
    const p = pass();
    const log = gpu.record(() => terrain.drawLocalShadow({ context: view.c, pass: p, matrix: matrix(k), layer }));
    return { p, log };
  };
  const a = draw(0, 100);
  const pipelines = a.log.filter((e) => e[0] === 'renderPipeline');
  assert.equal(pipelines.length, 1, 'the local pipeline is built on first use');
  assert.deepEqual(pipelines[0][2].depthStencil, {
    depthCompare: 'greater',
    depthWriteEnabled: true,
    format: 'depth32float',
  });
  assert.equal(a.log.filter((e) => e[0] === 'buffer').length, 2, 'one uniform per ring for layer 0');
  const writes = a.log.filter((e) => e[0] === 'writeBuffer');
  assert.equal(writes.length, 2);
  for (const w of writes)
    assert.equal(w[3].slice(0, 128), Buffer.from(matrix(100).buffer).toString('hex'), 'the layer matrix leads');
  assert.equal(a.p.calls.filter((c) => c[0] === 'drawIndexed').length, 2);
  // A second layer in the same frame keeps its own buffers, so layer 0's matrix survives until the encoder runs.
  const b = draw(1, 200);
  assert.equal(b.log.filter((e) => e[0] === 'renderPipeline').length, 0);
  const made = b.log.filter((e) => e[0] === 'buffer').map((e) => e[1]);
  assert.equal(made.length, 2);
  const written = b.log.filter((e) => e[0] === 'writeBuffer').map((e) => e[1]);
  assert.deepEqual(written, made);
  assert.ok(!writes.some((w) => written.includes(w[1])));
  const groups = (p) => p.calls.filter((c) => c[0] === 'setBindGroup').map((c) => c[2]);
  assert.ok(groups(a.p).every((g) => !groups(b.p).includes(g)));
  // Next frame reuses layer 0's buffers.
  const c = draw(0, 300);
  assert.equal(c.log.filter((e) => e[0] === 'buffer').length, 0);
  assert.deepEqual(
    c.log.filter((e) => e[0] === 'writeBuffer').map((e) => e[1]),
    writes.map((w) => w[1]),
  );
  assert.throws(() => draw(-1, 0), RangeError);
  assert.throws(() => draw(1.5, 0), RangeError);
  const log = gpu.record(() => terrain.dispose());
  const destroyed = new Set(log.filter((e) => e[0] === 'destroy').map((e) => e[1]));
  for (const id of [...made, ...writes.map((w) => w[1])]) assert.ok(destroyed.has(id), 'local uniforms are released');
  assert.equal(pass().calls.length, 0);
  const after = pass();
  terrain.drawLocalShadow({ context: view.c, pass: after, matrix: matrix(0), layer: 0 });
  assert.equal(after.calls.length, 0, 'a disposed terrain draws nothing');
});
