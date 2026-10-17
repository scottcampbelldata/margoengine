import test from 'node:test';
import assert from 'node:assert/strict';
import { Picking, Selection } from '../dist/index.js';
import { box } from '../../core/dist/extension.js';
import { wgsl } from '../../core/dist/shaders.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

function harness() {
  const h = optionalGPU(),
    e = h.engine,
    c = h.context,
    events = [],
    passes = [];
  e.canvas = { width: 128, height: 96, clientWidth: 128, clientHeight: 96 };
  e.store.visible = new Uint8Array(16).fill(1);
  e.lighting = { direction: [0, 1, 0, 1], radiance: [1, 1, 1, 0.1] };
  c.descriptor.multisample = { count: 1 };
  c.shader = wgsl;
  e.geometryBuffers = () => ({ vertex: { core: true }, index: {}, instance: e.gpu.createBuffer({ size: 1536 }) });
  const originalRender = c.encoder.beginRenderPass;
  c.encoder.beginRenderPass = (descriptor) => {
    events.push('render');
    const pass = originalRender(descriptor),
      record = { descriptor, vertices: [], groups: [], draws: [] };
    passes.push(record);
    return {
      ...pass,
      setVertexBuffer(index, value) {
        record.vertices.push([index, value]);
      },
      setBindGroup(index, value) {
        record.groups.push([index, value]);
      },
      drawIndexed(count, instances) {
        record.draws.push([count, instances]);
      },
    };
  };
  let pixels = [[1, 1, 1]],
    read;
  c.encoder.copyTextureToBuffer = (_source, target) => {
    read = target.buffer;
    const values = new Uint32Array(read.data);
    values.fill(0);
    for (const [x, y, id] of pixels) values[y * 64 + x] = id;
  };
  c.encoder.finish = () => ({});
  e.gpu.createCommandEncoder = () => c.encoder;
  e.gpu.queue.submit = () => events.push('submit');
  const node = (id, geometry = null) => {
    const value = {
      id,
      engine: e,
      geometry,
      matrix: c.camera.matrix.slice(),
      material: { data: new Float32Array([1, 1, 1, 1, 0.5, 0, 1, 0]) },
      check() {
        if (e.meshes.get(id) !== this) throw new Error('Mesh disposed');
      },
    };
    value.matrix[14] = 0.5;
    e.meshes.set(id, value);
    return value;
  };
  const primitive = (mesh, overrides = {}) => ({
    node: mesh,
    vertex: { vertex: mesh.id },
    index: { index: mesh.id },
    count: 3,
    stride: 80,
    ...overrides,
  });
  const picking = new Picking();
  e.use(picking);
  return {
    ...h,
    e,
    c,
    picking,
    node,
    primitive,
    events,
    passes,
    setPixels(value) {
      pixels = value;
    },
    getRead() {
      return read;
    },
    frame() {
      c.shader = wgsl;
      e.frameGraph.execute(c);
    },
  };
}

test('Picking.add validates ownership, disposal and bounded PBR metadata before allocating GPU resources', () => {
  const h = harness(),
    node = h.node(0),
    p = h.primitive(node),
    source = { pickingPrimitives: [p] },
    buffers = h.counts.buffers,
    textures = h.counts.textures;
  const remove = h.picking.add(source);
  assert.equal(h.counts.buffers, buffers);
  assert.equal(h.counts.textures, textures);
  const foreignEngine = { meshes: new Map() },
    foreignNode = {
      ...node,
      engine: foreignEngine,
      check() {
        assert.equal(foreignEngine.meshes.get(this.id), this);
      },
    };
  foreignEngine.meshes.set(foreignNode.id, foreignNode);
  assert.throws(() => h.picking.add(source), /Duplicate/);
  assert.throws(() => h.picking.add({ pickingPrimitives: [{ ...p, node: foreignNode }] }), /another engine/);
  assert.throws(() => h.picking.add({ pickingPrimitives: [p], disposed: true }), /disposed/);
  for (const field of [
    { stride: 24 },
    { count: -3 },
    { count: 4 },
    { texCoord: 2 },
    { alpha: NaN },
    { cutoff: -1 },
    { alphaTransform: new Float32Array(4) },
    { alphaTransform: new Float32Array([1, 0, Infinity, 0, 0, 1, 0, 0]) },
    { doubleSided: 1 },
    { side: 'invalid' },
  ])
    assert.throws(() => h.picking.add({ pickingPrimitives: [{ ...p, ...field }] }), /Invalid picking|affine rows/);
  assert.throws(() => h.picking.add({ pickingPrimitives: [p], prepareDeformation: 1 }), /callback/);
  assert.throws(() => h.picking.add({ draw() {} }), /pickingPrimitives/);
  remove();
  remove();
  h.picking.add(source)();
  h.picking.dispose();
  assert.throws(() => h.picking.add(source), /disposed/);
  h.cleanup();
});

test('Picking uploads live front, back and double side metadata without reallocating uniforms', async () => {
  const h = harness(),
    mesh = h.node(0),
    p = h.primitive(mesh, { side: 'back', doubleSided: true });
  h.picking.add({ pickingPrimitives: [p] });
  for (const [side, expected] of [
    ['back', 2],
    ['front', 0],
    ['double', 1],
  ]) {
    p.side = side;
    await h.picking.onPick(64, 48);
    const uniform = h.passes.at(-1).groups.at(-1)[1].entries[0].resource.buffer;
    assert.equal(new Float32Array(uniform.data)[45], expected);
  }
  const allocated = h.counts.buffers;
  p.side = 'back';
  await h.picking.onPick(64, 48);
  assert.equal(h.counts.buffers, allocated);
  h.picking.dispose();
  h.cleanup();
});

test('Registered deformation runs once before ID passes, reads the current GPU buffer and shares core reversed depth', async () => {
  const h = harness(),
    mesh = h.node(0),
    p = h.primitive(mesh),
    current = { deformed: true };
  h.node(1, box(0.01, 0.01, 0.01));
  let calls = 0;
  h.picking.add({
    pickingPrimitives: [p],
    prepareDeformation(c) {
      assert.equal(c.device, h.e.gpu);
      assert.equal(c.encoder, h.c.encoder);
      h.events.push('deform');
      calls++;
      p.vertex = current;
    },
  });
  h.frame();
  assert.equal(h.picking.captured, false);
  h.events.length = 0;
  h.passes.length = 0;
  assert.equal(await h.picking.onPick(64, 48), mesh);
  assert.equal(calls, 1);
  assert.equal(h.events[0], 'deform');
  assert.deepEqual(h.events.slice(1), ['render', 'render', 'submit']);
  assert.equal(h.passes[0].descriptor.depthStencilAttachment.depthLoadOp, 'clear');
  assert.equal(h.passes[1].descriptor.depthStencilAttachment.depthLoadOp, 'load');
  assert.equal(h.passes[1].descriptor.colorAttachments[0].loadOp, 'load');
  assert.equal(h.passes[1].descriptor.depthStencilAttachment.view, h.passes[0].descriptor.depthStencilAttachment.view);
  assert.equal(h.passes[1].vertices[0][1], current);
  const pbr = h.pipelines.find((p) => p.vertex.module.code.includes('struct PickFrame'));
  assert.equal(pbr.depthStencil.depthCompare, 'greater-equal');
  assert.equal(pbr.depthStencil.depthWriteEnabled, true);
  assert.equal(pbr.multisample.count, 1);
  // A deformed surface can leave its bind-pose bounds: PBR draws have no CPU rest-bound rejection.
  mesh.matrix[12] = 200;
  await h.picking.onPick(64, 48);
  assert.equal(h.passes.at(-1).draws.length, 1);
  h.picking.dispose();
  h.cleanup();
});

test('Distinct PBR primitives retain distinct uniforms, UV1 affine alpha, mirrored winding and vertex alpha', async () => {
  const h = harness(),
    a = h.node(0),
    b = h.node(1);
  a.matrix[0] = -1;
  const transform = new Float32Array([2, 3, 0.25, 0, 4, 5, 0.75, 0]),
    shared = { index: true };
  h.picking.add({
    pickingPrimitives: [
      h.primitive(a, {
        index: shared,
        alpha: 0.25,
        cutoff: 0.5,
        texCoord: 1,
        alphaTransform: transform,
        doubleSided: true,
      }),
      h.primitive(b, { index: shared, alpha: 0.75 }),
    ],
  });
  await h.picking.onPick(64, 48);
  const groups = h.passes.at(-1).groups.map(([, group]) => group),
    uniforms = groups.map((group) => group.entries[0].resource.buffer);
  assert.notEqual(uniforms[0], uniforms[1]);
  const first = new Float32Array(uniforms[0].data),
    second = new Float32Array(uniforms[1].data);
  assert.deepEqual([...first.slice(32, 36)], [0.25, 0.5, 1, -1]);
  assert.deepEqual(first.slice(36, 44), transform);
  assert.deepEqual([...first.slice(44, 46)], [1, 1]);
  assert.deepEqual([...second.slice(32, 36)], [0.75, 0, 0, 1]);
  assert.equal(second[44], 2);
  const code = h.pipelines.find((p) => p.vertex.module.code.includes('struct PickFrame')).vertex.module.code;
  assert.ok(code.includes('textureSample(alphaMap,alphaSampler,uv).a*f.settings.x*i.alpha'));
  assert.ok(code.indexOf('textureSample(') < code.indexOf('discard;'));
  assert.ok(code.includes('let p=f.model*vec4f(i.position.xyz,1);o.position=f.camera*p;'));
  const buffers = h.counts.buffers,
    textures = h.counts.textures;
  await h.picking.onPick(64, 48);
  assert.equal(h.counts.buffers, buffers);
  assert.equal(h.counts.textures, textures);
  h.picking.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
  h.cleanup();
});

test('Picking skips hidden ancestors and disposed nodes, and unregistration restores the core capture path', async () => {
  const h = harness(),
    mesh = h.node(0),
    parent = h.node(1),
    p = h.primitive(mesh),
    remove = h.picking.add({ root: parent, pickingPrimitives: [p] });
  h.e.store.parents[0] = 1;
  h.e.store.hidden[1] = 1;
  h.setPixels([]);
  assert.equal(await h.picking.onPick(64, 48), null);
  assert.equal(h.passes.length, 1);
  h.e.store.hidden[1] = 0;
  h.setPixels([[1, 1, 1]]);
  assert.equal(await h.picking.onPick(64, 48), mesh);
  assert.equal(h.passes.at(-1).draws.length, 1);
  remove();
  h.frame();
  assert.equal(h.picking.captured, true);
  const count = h.passes.length;
  await h.picking.onPick(64, 48);
  assert.equal(h.passes.length, count);
  h.picking.add({ root: parent, pickingPrimitives: [p] });
  h.e.meshes.delete(parent.id);
  await h.picking.onPick(64, 48);
  h.frame();
  assert.equal(h.picking.captured, true, 'disposed source root is removed automatically');
  h.picking.dispose();
  h.cleanup();
});

test('Removed, disposed and replaced optional sources cannot resolve stale asynchronous readback IDs', async () => {
  for (const action of ['remove', 'dispose-source', 'replace-node', 'dispose-picker']) {
    const h = harness(),
      mesh = h.node(0),
      source = { pickingPrimitives: [h.primitive(mesh)] },
      remove = h.picking.add(source);
    await h.picking.onPick(64, 48);
    let finish;
    h.getRead().mapAsync = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const result = h.picking.onPick(64, 48);
    if (action === 'remove') remove();
    else if (action === 'dispose-source') source.disposed = true;
    else if (action === 'replace-node') h.node(0);
    else h.picking.dispose();
    finish();
    assert.equal(await result, null, action);
    h.picking.dispose();
    h.cleanup();
  }
});

test('Optional picking releases caches on device restoration, keeps registrations and never owns borrowed geometry', async () => {
  const h = harness(),
    mesh = h.node(0),
    p = h.primitive(mesh),
    source = { pickingPrimitives: [p] };
  h.picking.add(source);
  await h.picking.onPick(64, 48);
  const owned = [...h.resources];
  h.picking.onDeviceRestored(h.e);
  assert.ok(owned.every((resource) => resource.destroyed));
  assert.equal(await h.picking.onPick(64, 48), mesh);
  source.disposed = true;
  h.picking.onDeviceRestored(h.e);
  h.frame();
  assert.equal(h.picking.captured, true, 'restoration drops disposed registrations');
  assert.equal(p.vertex.destroyed, undefined);
  assert.equal(p.index.destroyed, undefined);
  h.picking.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
  h.cleanup();
});

test('PBR selection loads multisampled stencil depth read-only and preserves exact beauty depth', () => {
  const h = harness(),
    mesh = h.node(0),
    selection = new Selection();
  h.c.descriptor.depthStencil.format = 'depth24plus-stencil8';
  h.c.descriptor.multisample = { count: 4 };
  h.e.use(selection);
  selection.add({ pickingPrimitives: [h.primitive(mesh)] });
  selection.set([mesh]);
  h.frame();
  const pass = h.passes.find((record) => record.descriptor.depthStencilAttachment?.stencilReadOnly);
  assert.ok(pass);
  assert.equal(pass.descriptor.depthStencilAttachment.depthLoadOp, 'load');
  assert.equal(pass.descriptor.colorAttachments[0].loadOp, 'load');
  const pipeline = h.pipelines.find((record) => record.vertex?.module.code.includes('struct PickFrame'));
  assert.equal(pipeline.depthStencil.depthWriteEnabled, false);
  assert.equal(pipeline.depthStencil.depthCompare, 'equal');
  assert.equal(pipeline.multisample.count, 4);
  assert.equal(pipeline.fragment.targets[0].format, 'r8unorm');
  selection.dispose();
  h.picking.dispose();
  assert.ok(h.resources.every((resource) => resource.destroyed));
  h.cleanup();
});
