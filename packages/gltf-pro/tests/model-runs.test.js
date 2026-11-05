// Models of one frame graph draw as one run, and copies of one asset share its packed arrays (speed matrix rows 12.5,
// 12.7: 100 morphed clones drew 100 render passes, and every clone repacked its vertices).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { PBRModel, parseGLTF } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

async function fixture(t) {
  const gpu = optionalGPU(),
    device = gpu.engine.gpu,
    store = await TransformStore.create(64),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 0, 4], target: [0, 0, 0] },
      null,
    ),
    buffers = [
      new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      new Uint32Array([0, 1, 2, 0, 2, 3]),
    ],
    doc = {
      asset: { version: '2.0' },
      buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
      bufferViews: buffers.map((data, buffer) => ({ buffer, byteLength: data.byteLength })),
      accessors: [
        { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3' },
        { bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
      // Blended, so a model drawn on its own would end its pass around the draw: only a shared run keeps one pass.
      materials: [{ alphaMode: 'BLEND' }],
      nodes: [{ mesh: 0 }],
    },
    context = { ...gpu.context, camera: engine.camera },
    passes = [];
  context.encoder.beginRenderPass = () => {
    const pass = { draws: 0 }; // instances drawn: a run may draw both models as one instanced draw
    passes.push(pass);
    return {
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      setViewport() {},
      setScissorRect() {},
      setStencilReference() {},
      drawIndexed(count, instances = 1) {
        pass.draws += instances;
      },
      end() {},
    };
  };
  t.after(() => {
    engine.dispose();
    gpu.cleanup();
  });
  store.tick(false);
  engine.camera.update(128 / 96, true);
  const frame = () => {
    passes.length = 0;
    engine.frameGraph.execute(context);
    return passes.filter((p) => p.draws).map((p) => p.draws);
  };
  return { engine, doc, buffers, frame, context };
}

test('consecutive model passes draw as one run; a pass added between them keeps them apart', async (t) => {
  const f = await fixture(t),
    a = parseGLTF(f.engine, f.doc, f.buffers),
    b = new PBRModel(f.engine, a.asset, []),
    c = new PBRModel(f.engine, a.asset, []);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  f.engine.use(b);
  assert.deepEqual(f.frame(), [2], 'two models, one render pass');
  f.engine.frameGraph.add({ name: 'between', order: 1, execute() {} });
  f.engine.use(c);
  assert.deepEqual(f.frame(), [2, 1], 'the third draws after the foreign pass, on its own');
  b.dispose();
  assert.deepEqual(f.frame(), [1, 1], 'a lone model left of a run draws itself');
});

test('models of one asset share its packed vertex and index arrays', async (t) => {
  const f = await fixture(t),
    a = parseGLTF(f.engine, f.doc, f.buffers),
    b = new PBRModel(f.engine, a.asset, []);
  assert.equal(b.primitives[0].vertices, a.primitives[0].vertices);
  assert.equal(b.primitives[0].indices, a.primitives[0].indices);
  const other = parseGLTF(f.engine, f.doc, f.buffers);
  assert.notEqual(other.primitives[0].vertices, a.primitives[0].vertices, 'another asset packs its own');
});

test('copies of one asset share vertex and index GPU buffers until the last one lets go', async (t) => {
  // p-skeleton-clone: each cloneModel copy created and filled its own GPU buffers for arrays it shared.
  const f = await fixture(t),
    a = parseGLTF(f.engine, f.doc, f.buffers);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  const b = new PBRModel(f.engine, a.asset, []);
  f.engine.use(b);
  const vertex = a.primitives[0].buffers.vertex,
    index = a.primitives[0].buffers.index;
  assert.equal(b.primitives[0].buffers.vertex, vertex, 'a copy uploads its own vertex buffer');
  assert.equal(b.primitives[0].buffers.index, index, 'a copy uploads its own index buffer');
  const [ra] = a['resources'],
    [rb] = b['resources'];
  assert.ok(ra.samplers[0]);
  assert.equal(rb.samplers[0], ra.samplers[0], 'each copy created its own samplers (one native call per map slot)');
  a.dispose();
  assert.equal(vertex.destroyed, false, 'freed while a copy still draws from it');
  assert.equal(index.destroyed, false);
  b.dispose();
  assert.equal(vertex.destroyed, true, 'the last copy to go frees it');
  assert.equal(index.destroyed, true);
});

test('writeGeometry on one copy leaves the shared buffer, and later copies, with the asset data', async (t) => {
  const f = await fixture(t),
    a = parseGLTF(f.engine, f.doc, f.buffers);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  const b = new PBRModel(f.engine, a.asset, []);
  f.engine.use(b);
  const shared = a.primitives[0].buffers.vertex,
    packed = new Float32Array(a.primitives[0].vertices),
    edit = () => {
      const vertices = packed.slice();
      vertices[0] = 42;
      return [{ vertices, indices: a.primitives[0].indices.slice() }];
    };
  a.writeGeometry(edit());
  assert.notEqual(a.primitives[0].buffers.vertex, shared, 'the edit went into the buffer the copy draws from');
  assert.equal(b.primitives[0].buffers.vertex, shared);
  assert.deepEqual(new Float32Array(shared.data), packed, 'the copy sees the edit');
  b.writeGeometry(edit());
  assert.equal(b.primitives[0].buffers.vertex, shared, 'its only holder rewrites a fitting buffer in place');
  const c = new PBRModel(f.engine, a.asset, []);
  f.engine.use(c);
  assert.notEqual(c.primitives[0].buffers.vertex, shared, 'a later copy drew from an edited buffer');
  assert.deepEqual(new Float32Array(c.primitives[0].buffers.vertex.data), packed, 'a later copy got edited data');
});

test('copies of one asset share their baked static batch arrays and its buffers', async (t) => {
  const f = await fixture(t),
    doc = { ...f.doc, materials: [{}], nodes: [{ mesh: 0 }, { mesh: 0, translation: [3, 0, 0] }] },
    a = parseGLTF(f.engine, doc, f.buffers);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  const b = new PBRModel(f.engine, a.asset, []);
  f.engine.use(b);
  const [one] = a['staticBatches'],
    [two] = b['staticBatches'];
  assert.ok(one && two, 'two static parts of one material bake into a batch');
  assert.equal(two.primitive.vertices, one.primitive.vertices, 'a copy baked its own static batch');
  assert.equal(two.primitive.indices, one.primitive.indices);
  assert.equal(two.primitive.buffers.vertex, one.primitive.buffers.vertex);
  const moved = new PBRModel(f.engine, a.asset, []);
  moved.nodes[1].setPosition([1, 0, 0]);
  f.engine.use(moved);
  assert.notEqual(moved['staticBatches'][0].primitive.vertices, one.primitive.vertices, 'another pose bakes anew');
});

test('copies of one textured asset compile the mip pipelines once per device', async (t) => {
  // p-morph: every cloneModel copy kept its own mip pipelines (gpuCache is per model), so 100 copies created 200
  // shader modules and pipelines, compiled while the first frame waited (a 300 ms first frame).
  const f = await fixture(t),
    device = f.engine.gpu,
    created = [],
    createModule = device.createShaderModule,
    createPipeline = device.createRenderPipeline;
  device.createShaderModule = (d) => {
    const m = createModule.call(device, d);
    created.push(['module', d.code.includes('var imageSampler:sampler') ? 'mip' : 'draw']);
    return m;
  };
  device.createRenderPipeline = (d) => {
    created.push(['pipeline', d.fragment?.targets?.[0]?.format]);
    return createPipeline.call(device, d);
  };
  device.queue.copyExternalImageToTexture ??= () => {};
  const encoder = device.createCommandEncoder;
  device.createCommandEncoder = (d) => {
    const e = encoder.call(device, d);
    e.beginRenderPass ??= () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} });
    return e;
  };
  const doc = structuredClone(f.doc),
    buffers = [...f.buffers, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])];
  doc.buffers.push({ byteLength: 32 });
  doc.bufferViews.push({ buffer: 3, byteLength: 32 });
  doc.accessors.push({ bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' });
  doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3;
  doc.images = [{ uri: 'unused.png' }];
  doc.textures = [{ source: 0 }];
  doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  const image = { width: 4, height: 4, close() {} },
    a = parseGLTF(f.engine, doc, buffers, [image]);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  for (let k = 0; k < 3; k++) f.engine.use(new PBRModel(f.engine, a.asset, [image]));
  const mips = created.filter(([kind, what]) => kind === 'module' && what === 'mip');
  assert.equal(mips.length, 1, 'one mip shader for the device, not one per copy');
});

test('copies of one image share its GPU texture, freed with the last holder', async (t) => {
  // p-morph: every cloneModel copy uploaded and mipped its own textures (700 textures, 300 image copies and 300 submits
  // for 100 copies), all queued during the build, so the first frame waited 260 ms for them.
  const f = await fixture(t),
    device = f.engine.gpu,
    made = [],
    create = device.createTexture,
    copied = [];
  device.createTexture = (d) => {
    const texture = create.call(device, d),
      destroy = texture.destroy;
    texture.destroy = () => {
      texture.gone = true;
      destroy?.call(texture);
    };
    if (d.size[0] === 4) made.push(texture);
    return texture;
  };
  device.queue.copyExternalImageToTexture = ({ source }) => copied.push(source);
  const encoder = device.createCommandEncoder;
  device.createCommandEncoder = (d) => {
    const e = encoder.call(device, d);
    e.beginRenderPass ??= () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} });
    return e;
  };
  const doc = structuredClone(f.doc),
    buffers = [...f.buffers, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])];
  doc.buffers.push({ byteLength: 32 });
  doc.bufferViews.push({ buffer: 3, byteLength: 32 });
  doc.accessors.push({ bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' });
  doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3;
  doc.images = [{ uri: 'unused.png' }];
  doc.textures = [{ source: 0 }];
  doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  const image = {
      width: 4,
      height: 4,
      closed: 0,
      close() {
        this.closed++;
      },
    },
    a = parseGLTF(f.engine, doc, buffers, [image]);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);
  const b = new PBRModel(f.engine, a.asset, a.shareImages()),
    c = new PBRModel(f.engine, a.asset, a.shareImages());
  f.engine.use(b);
  f.engine.use(c);
  assert.equal(made.length, 1, 'the copies made no texture of their own');
  assert.deepEqual(copied, [image], 'the image was uploaded once');
  assert.equal(b['resources'][0].views[0], a['resources'][0].views[0], 'one view for the copies');
  // Another image on the same asset is another texture.
  const other = { width: 4, height: 4, close() {} },
    d = new PBRModel(f.engine, a.asset, [other]);
  f.engine.use(d);
  assert.equal(made.length, 2, 'a different image uploads its own texture');
  // In any disposal order: the source first, as a copy that outlives it keeps drawing.
  a.dispose();
  b.dispose();
  assert.equal(made[0].gone, undefined, 'a copy still draws from the texture');
  assert.equal(image.closed, 0, 'a copy still holds the image');
  c.dispose();
  assert.equal(made[0].gone, true, 'the last holder frees the texture');
  assert.equal(image.closed, 1, 'the last holder closes the image');
  // Freed for good: a later model of that image uploads it again rather than drawing from a destroyed texture.
  const again = { width: 4, height: 4, close() {} },
    e = new PBRModel(f.engine, d.asset, [again]);
  f.engine.use(e);
  assert.equal(made.length, 3);
  d.dispose();
  e.dispose();
  assert.equal(made[1].gone, true);
});

test('compile() builds first-frame pipelines off the frame, and a draw it did not foresee still compiles', async (t) => {
  // p-morph: the first frame blocked about 80 ms on its render pipeline, with nothing else to overlap it.
  const f = await fixture(t),
    device = f.engine.gpu,
    sync = [],
    later = [],
    create = device.createRenderPipeline;
  device.createRenderPipeline = (d) => {
    if (d.vertex.buffers?.[0]?.arrayStride === 80) sync.push(d);
    return create.call(device, d);
  };
  device.createRenderPipelineAsync = async (d) => {
    later.push(d);
    return create.call(device, d);
  };
  device.queue.copyExternalImageToTexture ??= () => {};
  const encoder = device.createCommandEncoder;
  device.createCommandEncoder = (d) => {
    const e = encoder.call(device, d);
    e.beginRenderPass ??= () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} });
    return e;
  };
  const doc = structuredClone(f.doc),
    buffers = [...f.buffers, new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])];
  doc.buffers.push({ byteLength: 32 });
  doc.bufferViews.push({ buffer: 3, byteLength: 32 });
  doc.accessors.push({ bufferView: 3, componentType: 5126, count: 4, type: 'VEC2' });
  doc.meshes[0].primitives[0].attributes.TEXCOORD_0 = 3;
  doc.images = [{ uri: 'unused.png' }];
  doc.textures = [{ source: 0 }];
  doc.materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
  const a = parseGLTF(f.engine, doc, buffers, [{ width: 4, height: 4, close() {} }]);
  if (f.engine.plugins.get(a.name) !== a) f.engine.use(a);

  // No target to compile for (off WebGPU): nothing happens and the draw compiles as ever.
  await a.compile();
  assert.equal(later.length, 0);

  const renderer = f.engine['renderer'];
  renderer.target = {
    format: f.context.format,
    depthFormat: f.context.descriptor.depthStencil.format,
    samples: f.context.descriptor.multisample.count,
  };
  await Promise.all([a.compile(), new PBRModel(f.engine, a.asset, a.shareImages()).compile()]);
  assert.ok(later.length >= 1, 'compiled off the frame');
  const compiled = later.length;
  f.frame();
  assert.equal(sync.length, 0, 'the first frame found its pipeline ready');
  await a.compile();
  assert.equal(later.length, compiled, 'a ready pipeline is not compiled again');

  // A pipeline compile() did not foresee (here another target) is compiled by the draw, as it always was.
  renderer.target = { ...renderer.target, samples: renderer.target.samples === 1 ? 4 : 1 };
  doc.materials[0].doubleSided = true;
  const unforeseen = parseGLTF(f.engine, doc, buffers, [{ width: 4, height: 4, close() {} }]);
  if (f.engine.plugins.get(unforeseen.name) !== unforeseen) f.engine.use(unforeseen);
  await unforeseen.compile();
  f.frame();
  assert.equal(sync.length, 1, 'the draw compiled what it needed');
  a.dispose();
  await assert.rejects(a.compile(), (error) => error.code === 'disposed');
});
