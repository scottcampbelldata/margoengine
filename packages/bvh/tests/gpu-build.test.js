import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '../dist/index.js';
import { GPUMeshBVH } from '../dist/gpu.js';
import { GPUDynamicBVH } from '../dist/gpu-build.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

const primitiveOf = (extra = {}) => ({
  vertices: new Float32Array(60).map((_, i) => (i % 20 < 3 ? (i * 7) % 5 : 9)),
  indices: new Uint32Array([0, 1, 2]),
  deformed: { size: 4096 + 240 },
  deformedOffset: 4096,
  ...extra,
});

function fakeDevice({ limit = 1 << 27 } = {}) {
  const dispatches = [],
    writes = [],
    made = [];
  const device = {
    dispatches,
    writes,
    made,
    limits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit, maxComputeWorkgroupsPerDimension: 65535 },
    queue: { writeBuffer: (buffer, offset, data) => writes.push({ buffer, offset, data }) },
    createBuffer(descriptor) {
      const buffer = { ...descriptor, destroyed: false, destroy() { this.destroyed = true; } };
      made.push(buffer);
      return buffer;
    },
    createShaderModule: ({ code }) => ({ code }),
    createBindGroupLayout: (descriptor) => descriptor,
    createPipelineLayout: (descriptor) => descriptor,
    createBindGroup: (descriptor) => descriptor,
    createComputePipelineAsync: async ({ compute }) => ({
      code: compute.module.code,
      getBindGroupLayout: (group) => ({ group }),
    }),
  };
  return device;
}

const encoder = (device) => ({
  beginComputePass: () => {
    let code = '';
    return {
      setPipeline: (pipeline) => (code = pipeline.code),
      setBindGroup() {},
      dispatchWorkgroups: (x, y = 1) => device.dispatches.push({ code, x, y }),
      end() {},
    };
  },
});

const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], indices: new Uint32Array([0, 1, 2, 1, 3, 2]) };
const vertices = () => ({ size: 48 });

test('a build adds no queue writes when it encodes, so two updates can share an encoder', async () => {
  const device = fakeDevice(),
    dynamic = await GPUDynamicBVH.create(device, { vertices: vertices(), indices: mesh.indices }),
    before = device.writes.length;
  dynamic.encode(encoder(device));
  assert.equal(device.writes.length, before);
  assert.ok(device.dispatches.length > 64, 'every level of the worst tree has a dispatch');
  assert.match(device.dispatches[0].code, /atomicStore/);
});

test('a tree that follows the GPU leaves the vertex buffer to its owner and refuses a CPU update', async () => {
  const device = fakeDevice(),
    source = { size: 48, destroy: () => assert.fail('the caller owns the vertices') },
    dynamic = await GPUDynamicBVH.create(device, { vertices: source, indices: mesh.indices });
  assert.equal(dynamic.tree.positions, source);
  assert.equal(dynamic.tree.bvh, null);
  assert.throws(() => dynamic.tree.update(), { code: 'state' });
  dynamic[Symbol.dispose]();
  assert.ok(dynamic.disposed);
  assert.ok(device.made.every((buffer) => buffer.destroyed));
  dynamic.dispose();
  assert.throws(() => dynamic.encode(encoder(device)), { code: 'disposed' });
});

test('refit uploads the topology of its tree and runs a dispatch per level', async () => {
  const device = fakeDevice(),
    bvh = MeshBVH.build({ positions: mesh.positions, indices: [...mesh.indices] }, { maxLeafTriangles: 1 }),
    dynamic = await GPUDynamicBVH.create(device, { vertices: vertices(), indices: mesh.indices, mode: 'refit', bvh });
  assert.equal(dynamic.tree.bvh, bvh);
  assert.ok(device.writes.some(({ buffer }) => buffer === dynamic.tree.nodes));
  dynamic.encode(encoder(device));
  assert.ok(device.dispatches.length >= 2);
  assert.ok(device.dispatches.every(({ code }) => code.includes('order[')));
});

test('stride and offset reach the shader; a plain GPUMeshBVH still reads three floats', async () => {
  const device = fakeDevice(),
    dynamic = await GPUDynamicBVH.create(device, { vertices: { size: 512 }, indices: mesh.indices, stride: 8, offset: 2 }),
    params = device.writes.find(({ buffer }) => buffer === dynamic.tree.params).data;
  assert.deepEqual([...params], [8, 2, 2, 3]);
  const plain = await GPUMeshBVH.create(device, MeshBVH.build({ positions: mesh.positions, indices: [...mesh.indices] })),
    own = device.writes.find(({ buffer }) => buffer === plain.params).data;
  assert.deepEqual([...own].slice(0, 2), [3, 0]);
});

test('bad options say what to pass', async () => {
  const device = fakeDevice(),
    create = (options) => GPUDynamicBVH.create(device, { vertices: vertices(), indices: mesh.indices, ...options });
  await assert.rejects(create({ vertices: null }), TypeError);
  await assert.rejects(create({ indices: new Uint32Array(0) }), RangeError);
  await assert.rejects(create({ indices: [0, 1, 2] }), RangeError);
  await assert.rejects(create({ indices: new Uint32Array([0, 1]) }), RangeError);
  await assert.rejects(create({ stride: 2 }), RangeError);
  await assert.rejects(create({ offset: -1 }), RangeError);
  await assert.rejects(create({ mode: 'other' }), TypeError);
  await assert.rejects(create({ mode: 'refit' }), TypeError);
  await assert.rejects(create({ vertices: { size: 12 } }), RangeError);
  await assert.rejects(GPUDynamicBVH.create(fakeDevice({ limit: 64 }), { vertices: { size: 48 }, indices: mesh.indices }), RangeError);
  await assert.rejects(GPUDynamicBVH.create({}, { vertices: vertices(), indices: mesh.indices }), { code: 'unsupported' });
});

test('fromPrimitive reads the stride and offset of a deformed primitive, and needs a deformer', async () => {
  const device = fakeDevice(),
    primitive = primitiveOf(),
    dynamic = await GPUDynamicBVH.fromPrimitive(device, primitive);
  assert.equal(dynamic.primitive, primitive);
  const mesh = device.writes.map(({ data }) => new Uint32Array(data.buffer ?? data)).find((words) => words[0] === 20);
  assert.ok(mesh, 'the mesh uniform holds a stride of 20 floats');
  assert.equal(mesh[1], 1024, 'and the offset in floats');
  await assert.rejects(GPUDynamicBVH.fromPrimitive(device, primitiveOf({ deformed: undefined })), { code: 'state' });
  dynamic.dispose();
});

test('refit defaults to a tree of the bind pose', async () => {
  const dynamic = await GPUDynamicBVH.fromPrimitive(fakeDevice(), primitiveOf(), { mode: 'refit' });
  assert.equal(dynamic.mode, 'refit');
  dynamic.dispose();
});

test('fromModel makes a tree per deforming primitive, in order, and leaves the rest', async () => {
  const device = fakeDevice(),
    first = primitiveOf(),
    last = primitiveOf({ deformedOffset: 0 }),
    trees = await GPUDynamicBVH.fromModel(device, { primitives: [first, primitiveOf({ deformed: undefined }), last] });
  assert.deepEqual(trees.map((tree) => tree.primitive), [first, last]);
  for (const tree of trees) tree.dispose();
});

test('a primitive moved to another buffer or offset is an error, not a tree of stale memory', async () => {
  const device = fakeDevice(),
    primitive = primitiveOf(),
    dynamic = await GPUDynamicBVH.fromPrimitive(device, primitive),
    encoder = { beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }) };
  dynamic.encode(encoder);
  primitive.deformedOffset = 8192;
  assert.throws(() => dynamic.encode(encoder), { code: 'state' });
  primitive.deformedOffset = 4096;
  dynamic.encode(encoder);
  primitive.deformed = { size: 8192 };
  assert.throws(() => dynamic.encode(encoder), { code: 'state' });
  dynamic.dispose();
});
