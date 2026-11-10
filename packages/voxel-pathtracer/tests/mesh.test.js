import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MeshPathTracer } from '../dist/mesh.js';
import { VoxelPathTracer } from '../dist/index.js';
import { fakeDevice, fakeEngine, simpleScene } from './support.js';

const mesh = () => ({
  id: 'panel',
  positions: new Float32Array([-2, 0, -2, 2, 0, -2, 0, 0, 2]),
  indices: new Uint32Array([0, 2, 1]),
  material: 1,
});
const scene = () => ({ ...simpleScene(), meshes: [mesh()] });
function harness() {
  const device = fakeDevice(),
    sources = [],
    create = device.createShaderModule;
  device.createShaderModule = (d) => {
    sources.push(d.code);
    return create(d);
  };
  return { ...fakeEngine(device), sources };
}

test('mixed geometry is optional, copied, restored, atomically replaced and disposed', async () => {
  const h = harness(),
    root = harness(),
    s = scene(),
    before = structuredClone(s);
  const t = await MeshPathTracer.create(h.engine, { scene: s });
  const b = VoxelPathTracer.attach(root.engine, { scene: s });
  try {
    await Promise.all([t.ready, b.ready]);
    assert.equal(t.stats.packedModels, 1, 'create packs the voxel snapshot once');
    assert.equal(t.stats.reusedModels, 0, 'initial packing is not reported as scene reuse');
    h.frame();
    root.frame();
    assert.match(h.sources[0], /fn meshClosest/);
    assert.doesNotMatch(root.sources[0], /fn meshClosest/);
    assert.deepEqual(s, before);
    const bytes = t.stats.gpuBytes;
    assert.ok(bytes > b.stats.gpuBytes, 'triangle storage is counted');
    s.meshes[0].positions.fill(NaN);
    await assert.rejects(t.setScene(s), /positions must be finite/);
    assert.equal(t.stats.sceneRevision, 1);
    assert.equal(t.stats.gpuBytes, bytes);
    await t.setScene({ ...scene(), revision: 2, meshes: [] });
    assert.equal(t.stats.sceneRevision, 2);
    const replacement = harness();
    h.engine.gpu = replacement.device;
    h.frame();
    await t.ready;
    assert.equal(replacement.sources[0], h.sources[0]);
    const update = t.setScene({ ...scene(), revision: 3 });
    t.dispose();
    await assert.rejects(update, { code: 'disposed' });
    await assert.rejects(t.setScene(scene()), { code: 'disposed' });
  } finally {
    t.dispose();
    b.dispose();
  }
  assert.ok(h.device.buffers.every((b) => b.destroyed));
});

test('hostile mesh shape, indices, material and coordinates fail before GPU allocation', async () => {
  for (const edit of [
    (s) => s.meshes.push(mesh()),
    (s) => (s.meshes[0].id = ''),
    (s) => (s.meshes[0].positions = []),
    (s) => (s.meshes[0].positions = new Float32Array(2)),
    (s) => (s.meshes[0].indices = new Uint16Array([0, 1, 2])),
    (s) => (s.meshes[0].indices = new Uint32Array(2)),
    (s) => (s.meshes[0].material = 2),
    (s) => (s.materials[0].type = 'media'),
    (s) => (s.materials[0].texture = 0),
    (s) => (s.materials[0].cutout = 0.5),
    (s) => (s.meshes[0].positions[0] = NaN),
    (s) => (s.meshes[0].positions[0] = Infinity),
    (s) => (s.meshes[0].positions[0] = 1e9),
    (s) => (s.meshes[0].indices[0] = 99),
  ]) {
    const h = harness(),
      s = scene();
    edit(s);
    await assert.rejects(MeshPathTracer.create(h.engine, { scene: s }));
    assert.equal(h.device.buffers.length, 0);
  }
  const h = harness();
  const controller = new AbortController(),
    reason = new Error('cancel test');
  controller.abort(reason);
  await assert.rejects(
    MeshPathTracer.create(h.engine, { scene: scene(), signal: controller.signal }),
    (e) => e === reason,
  );
  assert.equal(h.device.buffers.length, 0);
});

test('plain WebGL2 mesh refusal has a code and setup help', async () => {
  const h = harness();
  h.engine.gpu = undefined;
  await assert.rejects(
    MeshPathTracer.create(h.engine, { scene: scene() }),
    (e) => e.code === 'unsupported' && e.message.includes('https://margoengine.com/errors#voxel-pathtracer'),
  );
});

test('async creation copies caller geometry and voxel arrays before waiting; updates stay in call order', async () => {
  const h = harness(),
    s = scene(),
    creating = MeshPathTracer.create(h.engine, { scene: s });
  s.meshes[0].positions.fill(NaN);
  s.models[0].voxels.fill(0);
  const t = await creating;
  try {
    await t.ready;
    assert.ok(t.raycast([0.5, 5, 0.5], [0, -1, 0]), 'the caller voxel mutation cannot change the snapshot');
    const a = { ...scene(), revision: 2 },
      b = { ...scene(), revision: 3 };
    const updates = [t.setScene(a), t.setScene(b)];
    a.meshes[0].positions.fill(NaN);
    b.materials[0].color.fill(NaN);
    await Promise.all(updates);
    assert.equal(t.stats.sceneRevision, 3);
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(t.setScene({ ...scene(), revision: 4 }, { signal: cancelled.signal }), { name: 'AbortError' });
    assert.equal(t.stats.sceneRevision, 3);
  } finally {
    t.dispose();
  }
});

test('the device storage limit includes triangle nodes before any GPU allocation', async () => {
  const h = harness(),
    s = scene();
  h.device.limits.maxStorageBufferBindingSize = 65536;
  s.meshes[0].indices = new Uint32Array(30000);
  for (let i = 0; i < 30000; i += 3) s.meshes[0].indices.set([0, 1, 2], i);
  await assert.rejects(MeshPathTracer.create(h.engine, { scene: s }), RangeError);
  assert.equal(h.device.buffers.length, 0);
});

test('Wasm SIMD and scalar finite predicates agree across every coordinate lane', async () => {
  const {
    instance: { exports: k },
  } = await WebAssembly.instantiate(await readFile(new URL('../src/mesh.wasm', import.meta.url)));
  const input = new Uint32Array(16);
  input.set([1, 3, 3, 1]);
  new Float32Array(input.buffer).set([0, 0, 0, 1, 0, 0, 0, 1, 0], 4);
  input.set([0, 1, 2], 13);
  const p = k.allocate(input.length);
  try {
    for (let lane = 0; lane < 9; lane++)
      for (const v of [NaN, Infinity, -Infinity, 1e8 + 8, -1e8 - 8]) {
        const copy = input.slice();
        new Float32Array(copy.buffer)[4 + lane] = v;
        new Uint32Array(k.memory.buffer, p, copy.length).set(copy);
        assert.equal(k.build_mesh(p, copy.length), 2, `lane ${lane}: ${v}`);
      }
    new Uint32Array(k.memory.buffer, p, input.length).set(input);
    assert.equal(k.build_mesh(p, input.length), 0);
    const output = new Uint32Array(k.memory.buffer, k.output_ptr(), k.output_len());
    assert.deepEqual(Array.from(output.subarray(0, 4)), [1, 12, 1, 0]);
    assert.equal(new Float32Array(output.buffer, output.byteOffset)[26], 1);
  } finally {
    k.release(p, input.length);
  }
});
