import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelOutlines } from '../dist/models.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
const harness = () => {
  const h = optionalGPU();
  h.engine.gpu.createPipelineLayout ??= (descriptor) => descriptor;
  return h;
};

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
// A gltf-pro shaped model: 20-float vertices, one triangle a primitive, GPU buffers as after setup.
const fakeModel = (h, primitives) => ({
  name: 'model',
  setup() {},
  root: { id: 0, matrix: identity },
  primitives: primitives.map(({ id, matrix = identity, ...rest }) => ({
    node: { id, matrix },
    vertices: new Float32Array(60),
    indices: new Uint32Array([0, 1, 2]),
    material: { settings: [0, 0, 0] },
    buffers: { vertex: { label: `vertex ${id}` }, index: { label: `index ${id}` } },
    ...rest,
  })),
});
const recordPasses = (h) => {
  const passes = [];
  h.context.encoder.beginRenderPass = (descriptor) => {
    const calls = [];
    passes.push({ descriptor, calls });
    const record =
      (name) =>
      (...args) =>
        calls.push([name, ...args]);
    return {
      setPipeline: record('pipeline'),
      setBindGroup: record('group'),
      setVertexBuffer: record('vertex'),
      setIndexBuffer: record('index'),
      drawIndexed: record('draw'),
      setViewport: record('viewport'),
      setScissorRect: record('scissor'),
      end: record('end'),
    };
  };
  return passes;
};

test('model outlines draw the deformed vertices, one hull per instance, and skip hidden and line primitives', () => {
  const h = harness(),
    deformed = { label: 'skinned' },
    mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    instances = { count: 3, data: new Float32Array(72) };
  for (let k = 0; k < 3; k++) instances.data.set(identity, k * 24);
  const model = fakeModel(h, [
    { id: 1, deformed, deformedOffset: 512 },
    { id: 2, instances },
    { id: 3 },
    { id: 4, topology: 'line-list' },
    { id: 5, matrix: mirror },
  ]);
  h.engine.store.hidden[3] = 1;
  const outlines = new ModelOutlines({ models: [model], outline: 0.5, color: [0, 1, 0] });
  h.engine.use(outlines);
  const passes = recordPasses(h);
  h.frame();
  assert.equal(passes.length, 1, 'one render pass for every hull');
  const { descriptor, calls } = passes[0];
  assert.equal(descriptor.colorAttachments[0].loadOp, 'load');
  assert.equal(descriptor.depthStencilAttachment.depthLoadOp, 'load');
  const vertices = calls.filter((c) => c[0] === 'vertex').map((c) => [c[2].label, c[3]]),
    draws = calls.filter((c) => c[0] === 'draw');
  // Skinned: the deformer's buffer at its offset, not the bind pose. Hidden node 3 and the line primitive draw nothing.
  assert.deepEqual(vertices, [
    ['skinned', 512],
    ['vertex 2', 0],
    ['vertex 5', 0],
  ]);
  assert.deepEqual(
    draws.map((d) => [d[2], d[5]]),
    [
      [1, 0],
      [3, 1],
      [1, 4],
    ],
    'instance count and first slot of each run',
  );
  // The hull culls front faces; a mirrored node turns its winding round, so it binds the pipeline culling back.
  const bound = calls.filter((c) => c[0] === 'pipeline').map((c) => c[1]);
  assert.deepEqual(
    bound.map((p) => p.primitive.cullMode),
    ['front', 'back'],
  );
  assert.equal(bound[0].depthStencil.depthWriteEnabled, false);
  // Width and colour reach the uniform: camera (16 floats), rgb, width.
  const uniform = h.bufferWrites.find((w) => w.bytes === 80);
  assert.deepEqual([...new Float32Array(uniform.buffer.data, 64, 4)], [0, 1, 0, 0.5]);
  outlines.dispose();
});

test('model outlines follow every model on the engine by default, live options, and release on dispose', () => {
  const h = harness(),
    model = fakeModel(h, [{ id: 1 }]);
  h.engine.plugins ??= new Map();
  h.engine.plugins.set('model', model);
  const outlines = ModelOutlines.attach(h.engine),
    passes = recordPasses(h);
  h.frame();
  assert.equal(passes.length, 1);
  outlines.outline = 0;
  h.frame();
  assert.equal(passes.length, 1, 'outline 0 draws nothing');
  assert.throws(() => (outlines.outline = -1), RangeError);
  assert.throws(() => (outlines.color = [2, 0, 0]), RangeError);
  assert.throws(() => new ModelOutlines({ models: [{}] }), TypeError);
  outlines.outline = 0.1;
  h.frame();
  assert.equal(passes.length, 2);
  outlines.onDeviceRestored(h.engine);
  h.frame();
  assert.equal(passes.length, 3, 'draws again after a device restore');
  outlines.dispose();
  assert.ok(h.resources.filter((r) => r.destroy).every((r) => r.destroyed));
});
