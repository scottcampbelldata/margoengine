import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '../dist/index.js';
import { GPUMeshBVH } from '../dist/gpu.js';
import { GPUDynamicBVH } from '../dist/gpu-build.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };

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
