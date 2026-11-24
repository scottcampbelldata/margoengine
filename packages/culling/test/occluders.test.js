import test from 'node:test';
import assert from 'node:assert/strict';
import { box, PbrMaterial } from '@margoengine/core';
import { CulledInstances } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { wgsl } from '../../core/src/shaders.ts';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const parts = () =>
  new CulledInstances(
    [{ geometry: box(), material: new PbrMaterial(), transforms: new Float32Array(identity) }],
    { culling: 'occlusion' },
  );
function harness() {
  const h = optionalGPU();
  globalThis.GPUTextureUsage = { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 };
  h.context.shader = wgsl;
  h.context.descriptor = {
    multisample: { count: 4 },
    depthStencil: { format: 'depth32float' },
    vertex: { buffers: [] },
    fragment: { targets: [] },
  };
  h.context.camera.matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -0.001, -1, 0, 0, 1, 0]);
  h.engine.lighting = { direction: new Float32Array([0, 1, 0, 1]), radiance: new Float32Array([1, 1, 1, 0.2]) };
  h.engine.store = { parents: [], hidden: [] };
  h.engine.gpu.createBindGroupLayout = (d) => d;
  h.engine.gpu.createPipelineLayout = (d) => d;
  h.engine.geometryBuffers = () => ({ vertex: { v: 1 }, index: { i: 1 } });
  const draws = [],
    begin = h.context.encoder.beginRenderPass;
  h.context.encoder.beginRenderPass = (descriptor) => {
    const pass = begin(descriptor);
    let pipeline, offset;
    pass.setPipeline = (p) => (pipeline = p);
    pass.setBindGroup = (_, __, offsets) => (offset = offsets?.[0]);
    pass.drawIndexed = (count, instances) => draws.push({ count, instances, pipeline, offset });
    return pass;
  };
  return { ...h, draws, run: () => h.engine.frameGraph.execute(h.context) };
}
const primitive = (extra = {}) => ({
  node: { id: 1, matrix: identity },
  vertex: {},
  index: {},
  count: 36,
  stride: 80,
  ...extra,
});

test('a core mesh and a model occlude: front faces only, depth greater-equal, at the scene sample count', () => {
  const h = harness(),
    p = parts();
  h.engine.use(p);
  p.addOccluder({ id: 7, geometry: box(), matrix: identity });
  p.addOccluder({ shadowPrimitives: [primitive()] });
  h.run();
  assert.equal(h.draws.length, 2);
  assert.deepEqual(h.draws.map((d) => d.offset), [0, 256], 'each draw has its own matrix');
  const { pipeline } = h.draws[1];
  assert.equal(pipeline.primitive.cullMode, 'back');
  assert.equal(pipeline.multisample.count, 4);
  assert.equal(pipeline.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pipeline.vertex.buffers[0].arrayStride, 80);
  assert.equal(h.draws[0].pipeline.vertex.buffers[0].arrayStride, 24);
  const created = { ...h.counts };
  for (let i = 0; i < 10; i++) h.run();
  assert.equal(h.counts.buffers, created.buffers, 'no per-frame buffers');
  assert.equal(h.counts.groups, created.groups);
});

test('a mirrored matrix flips the front face, so it is still the shown side that occludes', () => {
  const h = harness(),
    p = parts();
  h.engine.use(p);
  p.addOccluder({ id: 7, geometry: box(), matrix: mirror });
  h.run();
  assert.equal(h.draws[0].pipeline.primitive.frontFace, 'cw');
});

test('what the frame does not show as solid does not occlude', () => {
  const h = harness(),
    p = parts(),
    blended = {};
  h.engine.use(p);
  p.addOccluder({
    shadowPrimitives: [
      primitive({ cutoff: 0.5 }),
      primitive({ alpha: 0.4 }),
      primitive({ topology: 'line-list' }),
      primitive({ displacement: {} }),
      primitive({ clip: {} }),
      primitive({ primitive: blended }),
      primitive({ instances: { count: 3, mirrored: true, upload: () => ({}) } }),
      primitive({ instances: { count: 0, upload: () => ({}) } }),
    ],
    tintPrimitives: [{ primitive: blended }],
  });
  h.run();
  assert.equal(h.draws.length, 0);
});

test('instanced primitives draw their rows; a hidden node, a disposed source and a removed one stop', () => {
  const h = harness(),
    p = parts(),
    rows = { rows: 1 },
    model = { shadowPrimitives: [primitive({ instances: { count: 3, upload: () => rows } })] },
    gone = { disposed: false, shadowPrimitives: [primitive()] };
  h.engine.use(p);
  p.addOccluder(model).addOccluder(gone);
  h.run();
  assert.equal(h.draws[0].instances, 3);
  assert.equal(h.draws[0].pipeline.vertex.entryPoint, 'rows');
  h.draws.length = 0;
  gone.disposed = true;
  h.run();
  assert.equal(h.draws.length, 1);
  h.draws.length = 0;
  p.removeOccluder(model);
  h.run();
  assert.equal(h.draws.length, 0);
});

test('drawOccluder sources draw themselves, in the occluder pass only', () => {
  const h = harness(),
    p = parts(),
    calls = [];
  h.engine.use(p);
  p.addOccluder({ drawOccluder: (context) => calls.push(context.samples) });
  h.run();
  assert.deepEqual(calls, [4]);
  p.culling = 'frustum';
  h.run();
  assert.equal(calls.length, 1, 'frustum culling has no occluder pass');
});

test('more occluders than slots grow the uniform; anything else is refused', () => {
  const h = harness(),
    p = parts();
  h.engine.use(p);
  for (let i = 0; i < 20; i++) p.addOccluder({ id: i, geometry: box(), matrix: identity });
  h.run();
  assert.equal(h.draws.length, 20);
  assert.ok(h.resources.some((r) => r.size === 32 * 256 && !r.destroyed));
  assert.throws(() => p.addOccluder({}), /Invalid occluder/);
  assert.throws(() => p.addOccluder(null), /Invalid occluder/);
});
