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
// A gltf/pbr shaped model: 20-float vertices, one triangle a primitive, GPU buffers as after setup.
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
  // Each draw row: world matrix (16 floats), then its style, rgb and width.
  const rows = h.bufferWrites.find((w) => w.bytes === 5 * 80);
  assert.deepEqual([...new Float32Array(rows.buffer.data, 64, 4)], [0, 1, 0, 0.5]);
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

test('position rings link every copy of a vertex at one position, round to itself', async () => {
  const { positionRings } = await import('../dist/models.js');
  // A cube's corner split three ways by its hard edges, a lone vertex, and -0 matching 0.
  const v = new Float32Array(5 * 20);
  [
    [1, 1, 1],
    [1, 1, 1],
    [0, 2, 0],
    [1, 1, 1],
    [-0, 2, 0],
  ].forEach((p, i) => v.set(p, i * 20));
  assert.deepEqual([...positionRings(v)], [1, 3, 4, 0, 2]);
  assert.deepEqual([...positionRings(new Float32Array(20))], [0]);
});

test('smooth outlines bind the vertices drawn and their rings; a buffer without STORAGE draws plain', () => {
  const h = harness(),
    STORAGE = 128,
    deformed = { label: 'skinned', usage: STORAGE | 32 },
    model = fakeModel(h, [
      { id: 1, deformed, deformedOffset: 256 },
      { id: 2, buffers: { vertex: { label: 'no storage', usage: 32 }, index: {} } },
    ]),
    outlines = new ModelOutlines({ models: [model] }),
    groups = [];
  const create = h.engine.gpu.createBindGroup;
  h.engine.gpu.createBindGroup = (descriptor) => {
    groups.push(descriptor);
    return create(descriptor);
  };
  h.engine.use(outlines);
  const passes = recordPasses(h);
  h.frame();
  const calls = passes[0].calls,
    ring = groups.find((g) => g.entries[1]?.resource.buffer && g.entries[0].resource.buffer === deformed);
  assert.ok(ring, 'group 1 binds the deformed vertices');
  assert.equal(ring.entries[0].resource.offset, 256);
  assert.equal(ring.entries[0].resource.size, 60 * 4);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'pipeline').map((c) => c[1].layout.bindGroupLayouts.length),
    [2, 1],
    'smooth pipeline for the storage buffer, plain for the other',
  );
  assert.equal(calls.filter((c) => c[0] === 'group' && c[1] === 1).length, 1);
  outlines.smooth = false;
  h.frame();
  assert.deepEqual(
    passes[1].calls.filter((c) => c[0] === 'pipeline').map((c) => c[1].layout.bindGroupLayouts.length),
    [1],
  );
  outlines.dispose();
  assert.ok(h.resources.filter((r) => r.destroy).every((r) => r.destroyed));
});

test('per-material width and colour by name, a material without a line, and vertex colours flagged', () => {
  const h = harness(),
    model = fakeModel(h, [
      { id: 1, material: { settings: [0, 0, 0], name: 'hair' } },
      { id: 2, material: { settings: [0, 0, 0], name: 'eyes' } },
      { id: 3, material: { settings: [0, 0, 0], name: 'skin' } },
    ]),
    outlines = new ModelOutlines({
      models: [model],
      outline: 0.1,
      color: [0, 0, 1],
      materials: { hair: { outline: 0.3, color: [1, 0, 0] }, eyes: { outline: 0 } },
      vertexColors: true,
    });
  h.engine.use(outlines);
  const passes = recordPasses(h);
  h.frame();
  assert.equal(passes[0].calls.filter((c) => c[0] === 'draw').length, 2, "'eyes' has no line");
  const rows = h.bufferWrites.find((w) => w.bytes === 2 * 80),
    style = (k) => [...new Float32Array(rows.buffer.data, k * 80 + 64, 4)].map((v) => Math.round(v * 100) / 100);
  assert.deepEqual(style(0), [1, 0, 0, 0.3], 'hair: its own width and colour');
  assert.deepEqual(style(1), [0, 0, 1, 0.1], 'skin: the defaults');
  const frame = h.bufferWrites.find((w) => w.bytes === 80 && w.buffer.size === 80);
  assert.equal(new Float32Array(frame.buffer.data, 64, 1)[0], 1, 'vertex colours on');
  assert.throws(() => (outlines.materials = { hair: { outline: 11 } }), RangeError);
  assert.throws(() => (outlines.materials = { hair: null }), TypeError);
  // Every material at 0: nothing to draw, no pass.
  outlines.outline = 0;
  outlines.materials = {};
  h.frame();
  assert.equal(passes.length, 1);
  outlines.dispose();
});

// Batch 132 audit: the draw rows went to offset 0 of one storage buffer for every view, and `queue.writeBuffer` runs
// before the frame's commands, so with two views of one frame seeing different models (render layers) the first view's
// hulls read the second view's rows: the wrong primitive's matrix, colour and width.
test('each view of a frame keeps its own draw rows', () => {
  const h = harness(),
    key = Symbol.for('margoengine.layers'),
    saved = globalThis[key];
  // Node 1 is on layer 2 only, node 2 on layer 1.
  globalThis[key] = { maskOf: (node) => (node.id === 1 ? 2 : 1), masks: new Map() };
  try {
    const moved = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    const model = fakeModel(h, [{ id: 1, matrix: moved }, { id: 2 }]);
    const outlines = new ModelOutlines({ models: [model], smooth: false });
    h.engine.use(outlines);
    const passes = recordPasses(h);
    // Two views recorded in one task, as core records a frame: the first sees both nodes, the second only node 2.
    h.context.view = { id: 1, index: 0, layers: 3 };
    h.engine.frameGraph.execute(h.context);
    h.context.view = { id: 2, index: 1, layers: 1 };
    h.engine.frameGraph.execute(h.context);
    assert.equal(passes.length, 2);
    const first = passes[0].calls.filter((c) => c[0] === 'draw').map((d) => d[5]);
    const storage = h.bufferWrites.at(-1).buffer;
    // The first view's draw of node 1 reads its slot: x translation 5, not node 2's identity matrix.
    assert.equal(new Float32Array(storage.data, first[0] * 80, 16)[12], 5);
    assert.equal(new Float32Array(storage.data, first[1] * 80, 16)[12], 0);
    outlines.dispose();
  } finally {
    if (saved === undefined) delete globalThis[key];
    else globalThis[key] = saved;
  }
});

// GAP-OUTLINES-INSTANCED: drei outlines one skinnedMesh; `nodes` limits the hulls to the primitives under given nodes.
test('nodes limits the hulls to primitives under those nodes, by the engine store parent links, live', () => {
  const h = harness(),
    model = fakeModel(h, [{ id: 1 }, { id: 2 }, { id: 3 }]);
  // Node 3 hangs under node 2; node 1 under the root (0).
  h.engine.store.parents ??= new Int32Array(8).fill(-1);
  h.engine.store.parents[1] = 0;
  h.engine.store.parents[2] = 0;
  h.engine.store.parents[3] = 2;
  const outlines = new ModelOutlines({ models: [model], nodes: [{ id: 2 }] });
  h.engine.use(outlines);
  const passes = recordPasses(h),
    drawn = () => {
      passes.length = 0;
      h.frame();
      return (passes[0]?.calls ?? []).filter((c) => c[0] === 'vertex').map((c) => c[2].label);
    };
  assert.deepEqual(drawn(), ['vertex 2', 'vertex 3'], 'node 2 and its child 3');
  outlines.nodes = [{ id: 0 }];
  assert.deepEqual(drawn(), ['vertex 1', 'vertex 2', 'vertex 3'], 'everything under the root');
  outlines.nodes = [{ id: 7 }];
  assert.deepEqual(drawn(), [], 'a node above none of them');
  outlines.nodes = undefined;
  assert.equal(drawn().length, 3, 'undefined: every primitive');
  assert.throws(() => (outlines.nodes = [{}]), TypeError);
  assert.throws(() => new ModelOutlines({ nodes: {} }), TypeError);
  outlines.dispose();
});
