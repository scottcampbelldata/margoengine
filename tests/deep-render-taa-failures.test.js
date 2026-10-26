import test from 'node:test';
import assert from 'node:assert/strict';
import { TAA } from '../packages/taa/dist/index.js';
import { optionalGPU } from './support/optional-gpu.js';
import { wgsl } from '../packages/core/src/shaders.ts';

function harness() {
  const h = optionalGPU(),
    c = h.context;
  h.engine.stats = { drawCalls: 0 };
  h.engine.store.visible = new Uint8Array(16);
  c.shader = wgsl;
  c.descriptor = {
    ...c.descriptor,
    vertex: { entryPoint: 'vertex', buffers: [] },
    fragment: { entryPoint: 'fragment' },
  };
  const color = c.color,
    depth = c.depth,
    descriptor = c.descriptor,
    matrix = c.camera.matrix.slice();
  return {
    ...h,
    matrix,
    publicCamera: c.camera,
    frame() {
      c.color = color;
      c.depth = depth;
      c.descriptor = descriptor;
      c.format = 'bgra8unorm';
      c.shader = wgsl;
      c.bindings = [];
      h.engine.frameGraph.execute(c);
    },
  };
}
test('TAA restores public camera state on capture and motion failure and retries incomplete draw bindings', async () => {
  for (const stage of ['capture', 'depth', 'primitive']) {
    const h = harness(),
      d = h.engine.gpu,
      taa = new TAA();
    h.engine.use(taa);
    const failure = new Error('TAA ' + stage + ' failed');
    let restore = () => {};
    const owned = [];
    if (stage === 'capture') {
      const write = d.queue.writeBuffer;
      d.queue.writeBuffer = () => {
        throw failure;
      };
      restore = () => (d.queue.writeBuffer = write);
    }
    if (stage === 'depth') {
      const create = d.createBindGroup;
      d.createBindGroup = (descriptor) => {
        if (descriptor.entries.some((e) => e.binding === 1 && e.resource.texture?.format === 'depth32float'))
          throw failure;
        return create(descriptor);
      };
      restore = () => (d.createBindGroup = create);
    }
    if (stage === 'primitive') {
      const vertex = d.createBuffer({ size: 72, usage: GPUBufferUsage.VERTEX }),
        index = d.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX });
      owned.push(vertex, index);
      const node = {
        id: 0,
        engine: h.engine,
        geometry: { indices: new Uint32Array([0, 1, 2]) },
        matrix: h.matrix.slice(),
        check() {},
      };
      h.engine.meshes.set(0, node);
      h.engine.store.visible[0] = 1;
      h.engine.geometryBuffers = () => ({ vertex, index });
      const create = d.createBindGroup;
      d.createBindGroup = (descriptor) => {
        // The object velocity group: its own 160-byte block (model, previous model, settings, alpha).
        if (descriptor.entries[0]?.resource.buffer?.size === 160) throw failure;
        return create(descriptor);
      };
      restore = () => (d.createBindGroup = create);
    }
    try {
      assert.throws(h.frame, (error) => error === failure);
      assert.deepEqual(h.context.camera.matrix, h.matrix, 'Camera remained jittered after ' + stage + ' failure');
      restore();
      h.frame();
      assert.deepEqual(h.context.camera.matrix, h.matrix);
      h.frame();
    } finally {
      restore();
      taa.dispose();
      for (const r of owned) r.destroy();
      await null;
      assert.ok(h.resources.every((r) => r.destroyed));
    }
  }
});
test('foreign pass failure cannot leave the public camera jittered, and later passes still receive jittered projection', async () => {
  const h = harness(),
    taa = new TAA(),
    failure = new Error('Foreign pass failed');
  h.engine.use(taa);
  h.frame();
  let borrowed;
  h.engine.use({
    name: 'foreign-failure',
    setup() {},
    dispose() {},
    registerPasses(graph) {
      graph.add({
        name: 'foreign-failure',
        order: -2,
        execute(c) {
          borrowed = c.camera;
          assert.notEqual(c.camera, h.publicCamera);
          assert.notEqual(c.camera.matrix, h.publicCamera.matrix);
          assert.deepEqual(h.publicCamera.matrix, h.matrix);
          assert.equal(c.camera.position, h.publicCamera.position);
          assert.equal(c.camera.planes, h.publicCamera.planes);
          throw failure;
        },
      });
    },
  });
  try {
    assert.throws(h.frame, (error) => error === failure);
    assert.deepEqual(h.publicCamera.matrix, h.matrix);
    h.engine.removePlugin('foreign-failure');
    h.publicCamera.position = [1, 2, 3];
    h.frame();
    assert.equal(h.context.camera, h.publicCamera);
    assert.equal(borrowed.position, h.publicCamera.position);
    const counts = { ...h.counts };
    for (let i = 0; i < 120; i++) h.frame();
    for (const key of ['buffers', 'textures', 'groups', 'views']) assert.equal(h.counts[key], counts[key]);
    assert.deepEqual(h.publicCamera.matrix, h.matrix);
  } finally {
    taa.dispose();
    await null;
    assert.ok(h.resources.every((r) => r.destroyed));
  }
});

test('instanced PBR casters retain camera reprojection without a non-instanced object velocity draw', async () => {
  const h = harness(),
    taa = new TAA(),
    d = h.engine.gpu;
  h.engine.use(taa);
  const vertex = d.createBuffer({ size: 240, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE }),
    index = d.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX }),
    alpha = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING }),
    primitive = {
      node: { id: 0, engine: h.engine, matrix: h.matrix, check() {} },
      vertex,
      index,
      count: 3,
      stride: 80,
      alphaTexture: alpha.createView(),
      alphaSampler: d.createSampler(),
      instances: { count: 4 },
    };
  taa.add({ shadowPrimitives: [primitive] });
  try {
    h.frame();
    assert.equal(h.counts.indexed ?? 0, 0, 'camera reprojection handles static instances');
    primitive.instances = undefined;
    h.frame();
    assert.equal(h.counts.indexed, 1, 'ordinary PBR casters still receive object velocity');
  } finally {
    taa.dispose();
    vertex.destroy();
    index.destroy();
    alpha.destroy();
    await null;
    assert.ok(h.resources.every((resource) => resource.destroyed));
  }
});

test('TAA draws every object velocity in one render pass and rewrites a mesh block only when the mesh moves', () => {
  const h = harness(),
    d = h.engine.gpu,
    taa = new TAA();
  h.engine.use(taa);
  const vertex = d.createBuffer({ size: 72, usage: GPUBufferUsage.VERTEX }),
    index = d.createBuffer({ size: 12, usage: GPUBufferUsage.INDEX });
  h.engine.geometryBuffers = () => ({ vertex, index });
  const nodes = [0, 1, 2, 3].map((id) => ({
    id,
    engine: h.engine,
    geometry: { indices: new Uint32Array([0, 1, 2]) },
    matrix: h.matrix.slice(),
    check() {},
  }));
  for (const node of nodes) {
    h.engine.meshes.set(node.id, node);
    h.engine.store.visible[node.id] = 1;
  }
  const begin = h.context.encoder.beginRenderPass,
    write = d.queue.writeBuffer;
  let objectPasses = 0,
    blocks = 0;
  h.context.encoder.beginRenderPass = (descriptor) => {
    if (descriptor.depthStencilAttachment?.depthReadOnly && descriptor.colorAttachments[0].loadOp === 'load')
      objectPasses++;
    return begin.call(h.context.encoder, descriptor);
  };
  d.queue.writeBuffer = (buffer, ...rest) => {
    if (buffer.size === 160) blocks++;
    return write.call(d.queue, buffer, ...rest);
  };
  try {
    h.frame();
    assert.equal(objectPasses, 1, 'four meshes, one velocity pass');
    assert.equal(blocks, 4);
    h.frame();
    // The second frame sets each block's consecutive-frame flag; after that a still mesh writes nothing.
    h.frame();
    blocks = 0;
    h.frame();
    assert.equal(blocks, 0, 'still meshes keep their blocks');
    nodes[2].matrix[12] = 1;
    h.frame();
    assert.equal(blocks, 1, 'the moved mesh writes its block');
  } finally {
    h.context.encoder.beginRenderPass = begin;
    d.queue.writeBuffer = write;
    taa.dispose();
    vertex.destroy();
    index.destroy();
  }
});
