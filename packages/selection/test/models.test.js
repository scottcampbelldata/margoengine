// GPU picking and outlines for gltf-pro models on a mock device: real PBRModels (generated quads, the helmet asset), real core Engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Engine, TransformStore} from '../../core/dist/extension.js';
import {GLTFAsset, PBRModel} from '../../gltf-pro/dist/index.js';
import {Picking, Selection} from '../dist/index.js';
import {optionalGPU} from '../../../tests/support/optional-gpu.js';

function readGLB(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), json = view.getUint32(12, true);
  return {doc: JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + json))), binary: bytes.subarray(28 + json, 28 + json + view.getUint32(20 + json, true))};
}
/** Unit quad facing +Z; `nodes` copies at the given translations. */
function quads(engine, translations, {doubleSided = false} = {}) {
  const data = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), index = new Uint32Array([0, 1, 2, 0, 2, 3]), bytes = new Uint8Array(data.byteLength + index.byteLength);
  bytes.set(new Uint8Array(data.buffer)); bytes.set(new Uint8Array(index.buffer), data.byteLength);
  const doc = {asset: {version: '2.0'}, buffers: [{byteLength: bytes.length}], bufferViews: [{buffer: 0, byteLength: 48}, {buffer: 0, byteOffset: 48, byteLength: 48}, {buffer: 0, byteOffset: 96, byteLength: 24}],
    accessors: [{bufferView: 0, componentType: 5126, count: 4, type: 'VEC3'}, {bufferView: 1, componentType: 5126, count: 4, type: 'VEC3'}, {bufferView: 2, componentType: 5125, count: 6, type: 'SCALAR'}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1}, indices: 2, material: 0}]}], materials: [{doubleSided}], nodes: [{children: translations.map((_, i) => i + 1)}, ...translations.map(translation => ({mesh: 0, translation}))]};
  const model = new PBRModel(engine, new GLTFAsset(doc, [bytes])); engine.use(model); return model;
}
async function world() {
  const h = optionalGPU(), device = h.engine.gpu, c = h.context, draws = [], passes = [];
  device.queue.writeTexture = () => {}; device.queue.copyExternalImageToTexture = () => {}; device.queue.submit = () => {};
  const canvas = {width: 128, height: 96, clientWidth: 128, clientHeight: 96};
  const engine = new Engine(canvas, await TransformStore.create(256), {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0, 0, 6], target: [0, 0, 0], fov: 60}, null);
  engine.camera.update(128 / 96, true);
  c.encoder.beginRenderPass = descriptor => {
    const pass = {descriptor, pipeline: null, group: null, vertex: null, setPipeline(p) {this.pipeline = p;}, setBindGroup(_, g) {this.group = g;}, setVertexBuffer(_, b) {this.vertex = b;}, setIndexBuffer() {}, setBlendConstant() {}, draw() {}, end() {},
      drawIndexed(count, instances = 1, first = 0, base = 0, firstInstance = 0) {draws.push({pass, count, instances, firstInstance, pipeline: this.pipeline, vertex: this.vertex});}};
    passes.push(pass); return pass;
  };
  let pixel = 0; c.encoder.copyTextureToBuffer = (_source, target) => {const data = new Uint32Array(target.buffer.data); data.fill(0); data[1 * 64 + 1] = pixel;};
  c.encoder.finish = () => ({}); device.createCommandEncoder = () => c.encoder;
  const storage = () => {const group = draws.at(-1).pass.group, buffer = group.entries.find(e => e.binding === 1).resource.buffer; return new Uint32Array(buffer.data);};
  return {h, c, engine, device, draws, passes, storage, setPixel: id => {pixel = id;}};
}

test('engine.pick returns gltf-pro model nodes from the culled micro pass, with model, primitive and stale guards', async () => {
  const w = await world(), {engine, draws} = w, model = quads(engine, [[0, 0, 0], [30, 0, 0]]), picking = Picking.attach(engine), capacity = engine.store.capacity;
  draws.length = 0;
  w.setPixel(capacity + 1 + 0);
  assert.equal(await engine.pick(64, 48), model.nodes[1], 'engine.pick resolves the node');
  const modelDraws = draws.filter(d => d.pipeline?.vertex?.buffers?.[0]?.arrayStride === 80);
  assert.equal(modelDraws.length, 1, 'the off-screen quad is culled by its bounding sphere');
  assert.equal(modelDraws[0].vertex, model.primitives[0].buffers.vertex); assert.equal(modelDraws[0].count, 6); assert.equal(modelDraws[0].firstInstance, 0);
  const words = w.storage(); assert.equal(words[16], capacity + 1, 'slot id'); assert.equal(words[17], 0, 'single sided'); assert.equal(words[18], 1, 'front sign');
  assert.equal(modelDraws[0].pipeline.depthStencil.depthCompare, 'greater-equal');
  let hit = await picking.pick(64, 48);
  assert.equal(hit.model, model); assert.equal(hit.primitive, model.primitives[0]); assert.equal(hit.primitiveIndex, 0); assert.equal(hit.mesh, model.nodes[1]);
  w.setPixel(capacity + 2); hit = await picking.pick(64, 48);
  assert.equal(hit.mesh, model.nodes[2], 'second primitive slot');
  model.root.visible = false; assert.equal(await engine.pick(64, 48), null, 'hidden model'); model.root.visible = true;
  // A second model gets the slots after the first; core slots stay below the capacity.
  const other = quads(engine, [[0, 0, -1]]);
  w.setPixel(capacity + 3); assert.equal((await picking.pick(64, 48)).model, other);
  const core = engine.createMesh(); w.setPixel(core.id + 1); assert.equal(await engine.pick(64, 48), core, 'core slots below the capacity');
  other.dispose(); w.setPixel(capacity + 3); assert.equal(await picking.pick(64, 48), null, 'disposed model');
  // The per-pick model path reuses its storage, camera and bind group.
  const groups = w.h.counts.groups, buffers = w.h.counts.buffers;
  for (let i = 0; i < 4; i++) await picking.pick(64, 48);
  assert.equal(w.h.counts.groups, groups); assert.equal(w.h.counts.buffers, buffers);
  picking.dispose(); assert.ok(!engine.hasPlugin('picking'));
});

test('picking draws deformed (skinned) vertex buffers and many primitives of a real asset', async () => {
  const w = await world(), {engine, draws} = w, {doc, binary} = readGLB(readFileSync(new URL('../../../examples/assets/damaged-helmet.glb', import.meta.url)));
  const model = new PBRModel(engine, new GLTFAsset(doc, [], binary), doc.images.map(() => ({width: 1, height: 1, close() {}}))); engine.use(model);
  const picking = Picking.attach(engine), deformed = engine.gpu.createBuffer({size: 80}); model.primitives[0].deformed = deformed;
  w.setPixel(engine.store.capacity + 1);
  assert.equal(await engine.pick(64, 48), model.primitives[0].node);
  assert.equal(draws.at(-1).vertex, deformed);
  picking.dispose();
});

test('selection outlines selected model primitives with an equal-depth mask, nodes select descendants, and frames allocate nothing new', async () => {
  const w = await world(), {engine, c, draws} = w, model = quads(engine, [[-2, 0, 0], [2, 0, 0], [0, 3, 0]], {doubleSided: true}), selection = Selection.attach(engine);
  c.camera = engine.camera; c.descriptor = {...c.descriptor, multisample: {count: 4}, depthStencil: {format: 'depth24plus-stencil8'}};
  const frame = () => {draws.length = 0; engine.store.tick(false); engine.frameGraph.execute(c); return draws.filter(d => d.pipeline?.fragment?.targets?.[0]?.format === 'r8unorm');};
  selection.set([model.nodes[2]]);
  let marked = frame();
  assert.equal(marked.length, 1); assert.equal(marked[0].vertex, model.primitives[1].buffers.vertex);
  const mask = marked[0].pipeline;
  assert.equal(mask.depthStencil.depthCompare, 'equal'); assert.equal(mask.depthStencil.depthWriteEnabled, false); assert.equal(mask.multisample.count, 4); assert.equal(mask.fragment.targets[0].format, 'r8unorm');
  assert.equal(marked[0].pass.descriptor.depthStencilAttachment.depthReadOnly, true); assert.equal(marked[0].pass.descriptor.depthStencilAttachment.stencilReadOnly, true);
  assert.equal(w.storage()[17], 1, 'double sided');
  selection.set([model]); assert.equal(frame().length, 3, 'a model selects every primitive');
  selection.set([model.nodes[0]]); assert.equal(frame().length, 3, 'a node selects its descendants');
  const stable = {groups: w.h.counts.groups, buffers: w.h.counts.buffers, pipelines: w.h.pipelines.length};
  for (let i = 0; i < 5; i++) frame();
  assert.deepEqual({groups: w.h.counts.groups, buffers: w.h.counts.buffers, pipelines: w.h.pipelines.length}, stable, 'steady frames create no GPU objects');
  model.nodes[1].visible = false; assert.equal(frame().length, 2, 'hidden nodes are skipped'); model.nodes[1].visible = true;
  const extra = quads(engine, [[0, -3, 0]]); assert.equal(frame().length, 3, 'unselected models are not marked');
  selection.set([extra.root, model.nodes[3]]); assert.equal(frame().length, 2);
  extra.dispose(); assert.equal(frame().length, 1, 'disposed models drop out'); assert.throws(() => selection.set([extra]), /Foreign or disposed/);
  selection.dispose(); assert.ok(!engine.hasPlugin('selection'));
});

test('pick proxies (LOD imposter levels) draw an enclosing sphere in the micro pass and resolve to the anchor, flagged approximate', async () => {
  const w = await world(), {engine, draws} = w, list = [], picking = Picking.attach(engine), capacity = engine.store.capacity;
  engine.use({name: 'lod-proxies', setup() {}, pickProxies: () => list});
  const parent = engine.createMesh(), anchor = engine.createMesh(parent).setPosition([0.5, 0, 0]).setScale([2, 2, 2]), away = engine.createMesh().setPosition([500, 0, 0]), owner = quads(engine, [[0, 0, -30]]);
  list.push({anchor: away, sphere: [0, 0, 0, 1], model: null}, {anchor, sphere: [0.25, 0, 0, 0.5], model: owner});
  draws.length = 0; w.setPixel(capacity + 1 + 1 + 1);
  const hit = await picking.pick(64, 48);
  assert.ok(hit?.approximate && hit.mesh === anchor && hit.model === owner && !hit.primitive, 'proxy slots follow every model primitive');
  const spheres = draws.filter(d => d.pipeline?.vertex?.buffers?.[0]?.arrayStride === 80 && d.count === 768);
  assert.equal(spheres.length, 1, 'the off-screen proxy is culled'); assert.equal(spheres[0].firstInstance, 1, 'after the model draw');
  const words = w.storage(), floats = new Float32Array(words.buffer), o = 20;
  assert.equal(words[o + 16], capacity + 3); assert.equal(words[o + 17], 1, 'double sided');
  assert.ok(Math.abs(floats[o] - 1) < 1e-6 && Math.abs(floats[o + 12] - 1) < 1e-6, 'scale 2 * radius 0.5, centre 0.5 + 2 * 0.25');
  // The sphere's faces enclose the unit sphere (so the GPU never misses where the bvh sphere test hits) by at most a few percent.
  const v = new Float32Array(spheres[0].vertex.data);
  let inner = Infinity, outer = 0;
  for (let k = 0; k < v.length; k += 20) outer = Math.max(outer, Math.hypot(v[k], v[k + 1], v[k + 2]));
  for (let a = 0; a < 8; a++) for (let b = 0; b < 16; b++) {
    const at = (r, c) => {const k = (r * 17 + c) * 20; return [v[k], v[k + 1], v[k + 2]];}, p = at(a, b), q = at(a + 1, b), s = at(a + 1, b + 1), u = q.map((x, k) => x - p[k]), t = s.map((x, k) => x - p[k]);
    const n = [u[1] * t[2] - u[2] * t[1], u[2] * t[0] - u[0] * t[2], u[0] * t[1] - u[1] * t[0]], l = Math.hypot(...n);
    if (l > 1e-6) inner = Math.min(inner, Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / l);
  }
  assert.ok(inner >= 1 - 1e-5 && outer < 1.05, `faces ${inner}, vertices ${outer}`);
  parent.visible = false; assert.ok(await picking.pick(64, 48) === null, 'hidden anchors are not picked'); parent.visible = true;
  w.setPixel(capacity + 1); assert.ok((await picking.pick(64, 48))?.model === owner, 'model slots unchanged');
  list.length = 0; w.setPixel(capacity + 3); assert.ok(await picking.pick(64, 48) === null, 'stale proxy slot');
  picking.dispose();
});
