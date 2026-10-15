import test from 'node:test';
import assert from 'node:assert/strict';
import {EngineKernel, PbrMaterial, box} from '../packages/core/dist/index.js';

// Fake WebGPU device that records buffer uploads (except the 112-byte frame uniform) and every pipeline / bind group creation.
function fakeGPU(t) {
  const saved = Object.fromEntries(['navigator', 'GPUBufferUsage', 'GPUTextureUsage'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const log = {writes: [], pipelines: 0, groups: 0, culls: []};
  const context = {configure() {}, unconfigure() {}, getCurrentTexture: () => ({createView: () => ({})})};
  const canvas = {width: 64, height: 64, clientWidth: 64, clientHeight: 64, getContext: () => context};
  const resource = descriptor => Object.assign({destroy() {}}, descriptor);
  const device = {features: new Set(), limits: {maxBufferSize: 2 ** 30}, lost: new Promise(() => {}), addEventListener() {}, destroy() {},
    queue: {writeBuffer(buffer, offset, data, start = 0, size) {if (buffer.size !== 112) log.writes.push({offset, values: Array.from(data.subarray(start, start + (size ?? data.length - start)))});}, submit() {}},
    createShaderModule: d => d, createBindGroup() {log.groups++; return {};},
    createBuffer: resource,
    createTexture: d => Object.assign(resource(d), {createView: () => ({})}),
    async createRenderPipelineAsync(d) {log.pipelines++; return {cull: d.primitive?.cullMode ?? 'none', constants: d.fragment.constants, getBindGroupLayout: () => ({})};},
    createRenderPipeline() {log.pipelines++; return {getBindGroupLayout: () => ({})};},
    createCommandEncoder: () => ({beginRenderPass: () => ({setPipeline(p) {log.culls.push(p.cull);}, setBindGroup() {}, setVertexBuffer() {}, setIndexBuffer() {}, drawIndexed() {}, end() {}}), finish: () => ({})})};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {userAgent: '', gpu: {requestAdapter: async () => ({features: new Set(), requestDevice: async () => device}), getPreferredCanvasFormat: () => 'bgra8unorm'}}});
  globalThis.GPUBufferUsage = {UNIFORM: 1, COPY_DST: 2, VERTEX: 4, STORAGE: 8, INDEX: 16, INDIRECT: 32, COPY_SRC: 64, MAP_READ: 128};
  globalThis.GPUTextureUsage = {RENDER_ATTACHMENT: 1, COPY_SRC: 2};
  t.after(() => {for (const [key, descriptor] of Object.entries(saved)) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];});
  return {canvas, log};
}

test('PbrMaterial.set recolours a static scene on the next frame: one instance re-upload, no new pipeline or bind group', async t => {
  const {canvas, log} = fakeGPU(t);
  const engine = await EngineKernel.create(canvas, {capacity: 8, backend: 'webgpu', camera: {position: [0, 0, 6], target: [0, 0, 0]}});
  try {
    const geometry = box(), shared = new PbrMaterial({color: '#ff0000', roughness: 0.3}), other = new PbrMaterial();
    const a = engine.createMesh().setGeometry(geometry).setMaterial(shared), b = engine.createMesh().setGeometry(geometry).setMaterial(other).setPosition([1, 0, 0]);
    engine.render(); engine.render();
    assert.equal(engine.stats.visible, 2);
    const pipelines = log.pipelines, groups = log.groups;
    log.writes.length = 0; engine.render();
    assert.deepEqual(log.writes, [], 'a static frame uploads nothing');

    shared.set({color: [0, 0.5, 1], metalness: 1});
    assert.deepEqual(Array.from(shared.data.slice(0, 7)), [0, 0.5, 1, 1, Math.fround(0.3), 1, 1], 'omitted roughness and doubleSided keep their values');
    engine.render();
    // Full re-collection: the changed batch is uploaded once, covering both instances (offset 0, 2 x 24 floats).
    assert.equal(log.writes.length, 1); const [write] = log.writes;
    assert.equal(write.offset, 0); assert.equal(write.values.length, 48);
    const slot = mesh => {const end = write.values.findIndex((v, i) => i % 24 === 23 && v === mesh.id); return write.values.slice(end - 7, end);};
    assert.deepEqual(slot(a), [0, 0.5, 1, 1, Math.fround(0.3), 1, 1], 'new colour and metalness reach the GPU');
    assert.deepEqual(slot(b), Array.from(other.data.slice(0, 7)), 'other material unchanged');
    assert.equal(log.pipelines, pipelines, 'no pipeline created'); assert.equal(log.groups, groups, 'no bind group created');

    log.writes.length = 0; engine.render();
    assert.deepEqual(log.writes, [], 'back to no uploads once the change is on the GPU');
  } finally {engine.dispose();}
});

test('a geometry batch draws back-culled (no discard) only while every drawn instance is single-sided and unmirrored', async t => {
  const {canvas, log} = fakeGPU(t);
  const engine = await EngineKernel.create(canvas, {capacity: 8, backend: 'webgpu', camera: {position: [0, 0, 6], target: [0, 0, 0]}});
  try {
    assert.deepEqual(log.culls, []);
    const single = new PbrMaterial({doubleSided: false}), cube = box(), slab = box(2, 0.5, 1);
    const a = engine.createMesh().setGeometry(cube).setMaterial(single), b = engine.createMesh().setGeometry(cube).setMaterial(single).setPosition([1, 0, 0]);
    engine.createMesh().setGeometry(slab).setPosition([-1, 0, 0]); // core's default material: double-sided
    const pipelines = log.pipelines, frame = () => {log.culls.length = 0; engine.render(); return log.culls.slice();};
    assert.deepEqual(frame(), ['back', 'none'], 'single-sided cubes culled, double-sided slab not');
    b.scale.set(-1, 1, 1); assert.deepEqual(frame(), ['none'], 'a mirrored instance (moved-matrix fast path) needs the discard pipeline');
    b.visible = false; assert.deepEqual(frame(), ['back', 'none'], 'a hidden mirrored instance does not count');
    b.visible = true; b.scale.set(1, 1, 1); frame();
    single.set({doubleSided: true}); assert.deepEqual(frame(), ['none'], 'set({doubleSided: true}) switches the batch live');
    single.set({doubleSided: false}); assert.deepEqual(frame(), ['back', 'none'], 'and back');
    a.setMaterial(new PbrMaterial()); assert.deepEqual(frame(), ['none'], 'assigning a double-sided material');
    assert.equal(log.pipelines, pipelines, 'no pipeline created after startup');
  } finally {engine.dispose();}
});

test('PbrMaterial.set validates before writing and keeps constructor defaults', () => {
  const material = new PbrMaterial({color: undefined, roughness: undefined}), before = material.data.slice();
  assert.deepEqual(Array.from(before), Array.from(new PbrMaterial({color: '#4f46e5', roughness: 0.5, metalness: 0, doubleSided: true}).data));
  assert.throws(() => material.set({color: '#zzzzzz'}), TypeError);
  assert.throws(() => material.set({color: [0, 0, 0], roughness: 2}), RangeError);
  assert.throws(() => material.set({doubleSided: 1}), TypeError);
  assert.deepEqual(Array.from(material.data), Array.from(before), 'a rejected set changes nothing');
  material.set({roughness: 0, doubleSided: false});
  assert.deepEqual(Array.from(material.data.slice(4, 7)), [Math.fround(0.045), 0, 0]);
});
