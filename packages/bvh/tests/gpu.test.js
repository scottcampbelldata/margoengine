import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '../dist/tree.js';
import { GPU_FAR, GPU_MAX_DEPTH, GPUMeshBVH, bvhWGSL, packRays } from '../dist/gpu.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode ??= { READ: 1 };

// Records what a real device would receive; `reply` fills the mapped hit buffer.
function fakeDevice({ limit = 1 << 27, groups = 65535, reply } = {}) {
  const device = {
    buffers: [],
    dispatches: [],
    limits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit, maxComputeWorkgroupsPerDimension: groups },
    createShaderModule: ({ code }) => ({ code }),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: (group) => ({ group }) }),
    createBindGroup: (descriptor) => descriptor,
    createBuffer({ label, size, usage }) {
      const buffer = {
        label,
        size,
        usage,
        data: new ArrayBuffer(size),
        destroyed: false,
        destroy() {
          buffer.destroyed = true;
        },
        mapAsync: async () => reply?.(buffer),
        getMappedRange: () => buffer.data,
      };
      device.buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        const bytes = ArrayBuffer.isView(data)
          ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
          : new Uint8Array(data);
        new Uint8Array(buffer.data).set(bytes, offset);
      },
      submit() {},
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (x, y) => device.dispatches.push([x, y]),
        end() {},
      }),
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
  };
  return device;
}

function grid(n = 12) {
  const positions = [],
    indices = [];
  for (let y = 0; y <= n; y++)
    for (let x = 0; x <= n; x++) positions.push(x, y, Math.sin(x * 0.7) * Math.cos(y * 0.9));
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
  return { positions, indices };
}

// Walks the uploaded words the way the WGSL does, so the packed layout is checked without a GPU.
function walk(device, gpu, origin, direction) {
  const nodes = gpu.nodes.data,
    floats = new Float32Array(nodes),
    words = new Uint32Array(nodes),
    index = new Uint32Array(gpu.index.data),
    faces = new Uint32Array(gpu.faces.data),
    positions = new Float32Array(gpu.positions.data),
    stack = [0],
    bvh = MeshBVH.build({
      positions: [...positions],
      indices: [...index],
    });
  const seen = [];
  while (stack.length) {
    const o = stack.pop() * 8;
    if (words[o + 7] & 0x80000000) {
      stack.push(words[o + 3], words[o + 7] & 0x7fffffff);
      continue;
    }
    assert.ok(floats[o] <= floats[o + 4] && floats[o + 1] <= floats[o + 5] && floats[o + 2] <= floats[o + 6]);
    for (let k = 0; k < words[o + 7]; k++) seen.push(faces[words[o + 3] + k]);
  }
  const hit = bvh.raycastFirst({ origin, direction });
  return { seen, hit, faces };
}

test('the tree uploads with explicit children and every face in leaf order', async () => {
  const device = fakeDevice(),
    bvh = MeshBVH.build(grid()),
    gpu = await GPUMeshBVH.create(device, bvh),
    { seen, hit, faces } = walk(device, gpu, [3.2, 4.1, 5], [0, 0, -1]),
    expected = bvh.raycastFirst({ origin: [3.2, 4.1, 5], direction: [0, 0, -1] });
  assert.deepEqual(
    seen.toSorted((a, b) => a - b),
    Array.from({ length: bvh.triangleCount }, (_, i) => i),
  );
  // The uploaded index is in leaf order, so face k of the upload is source face faces[k].
  assert.equal(faces[hit.faceIndex], expected.faceIndex);
  assert.equal(gpu.bindings(3).length, 5);
  assert.deepEqual(
    gpu.bindings(3).map((entry) => entry.binding),
    [3, 4, 5, 6, 7],
  );
});

test('positions of any stride and precision upload as three floats a vertex', async () => {
  const device = fakeDevice(),
    interleaved = new Float32Array([0, 0, 0, 9, 9, 9, 1, 0, 0, 9, 9, 9, 0, 1, 0, 9, 9]),
    strided = await GPUMeshBVH.create(device, MeshBVH.build({ positions: interleaved, stride: 6, indices: [0, 1, 2] }));
  assert.deepEqual([...new Float32Array(strided.positions.data).subarray(0, 9)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const wide = await GPUMeshBVH.create(
    device,
    MeshBVH.build({ positions: new Float64Array([0.1, 0, 0, 1, 0, 0, 0, 1, 0]), precision: 'float64', indices: [0, 1, 2] }),
  );
  assert.equal(new Float32Array(wide.positions.data)[0], Math.fround(0.1));
});

test('a tree for a shader uploads at once, with no pipeline, and its own ray calls refuse', async () => {
  const device = fakeDevice(),
    bvh = MeshBVH.build({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: [0, 1, 2] }),
    gpu = GPUMeshBVH.forShader(device, bvh);
  assert.deepEqual(gpu.bindings(3).map((entry) => entry.binding), [3, 4, 5, 6, 7]);
  assert.equal(new Uint32Array(gpu.params.data)[2], 1);
  await assert.rejects(gpu.raycast([{ origin: [0, 0, 1], direction: [0, 0, -1] }]), { code: 'state' });
  gpu.dispose();
});
test('update sends a refit tree again', async () => {
  const device = fakeDevice(),
    source = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: [0, 1, 2] },
    bvh = MeshBVH.build(source),
    gpu = await GPUMeshBVH.create(device, bvh);
  bvh.positions[3] = 5;
  bvh.refit();
  gpu.update();
  assert.equal(new Float32Array(gpu.nodes.data)[4], 5);
  assert.equal(new Float32Array(gpu.positions.data)[3], 5);
});

test('hits decode to distance, face, weights and side', async () => {
  const device = fakeDevice({
      reply(buffer) {
        const words = new Uint32Array(buffer.data),
          floats = new Float32Array(buffer.data);
        floats[0] = 2.5;
        words[1] = (7 | 0x80000000) >>> 0;
        floats[2] = 0.25;
        floats[3] = 0.5;
        floats[4] = 1;
        words[5] = 3;
      },
    }),
    gpu = await GPUMeshBVH.create(device, MeshBVH.build(grid())),
    rays = [0, 1].map(() => ({ origin: [1, 1, 5], direction: [0, 0, -1] })),
    hits = await gpu.raycast(rays);
  assert.deepEqual([...hits.distance], [2.5, 1]);
  assert.deepEqual([...hits.faceIndex], [7, 3]);
  assert.deepEqual([...hits.frontFace], [1, 0]);
  assert.deepEqual([...hits.barycoord.subarray(0, 3)], [0.25, 0.25, 0.5]);
  assert.ok(
    device.buffers.filter((buffer) => /rays|hits|read/.test(buffer.label)).every((buffer) => buffer.destroyed),
    'temporary buffers are freed',
  );
});

test('rays past one dispatch row use a second dimension and every thread index stays in range', async () => {
  const device = fakeDevice({ groups: 100 }),
    gpu = await GPUMeshBVH.create(device, MeshBVH.build(grid())),
    encoder = device.createCommandEncoder(),
    count = 100 * 64 * 3 + 1,
    rays = device.createBuffer({ size: count * 32 }),
    hits = device.createBuffer({ size: count * 16 });
  gpu.encodeTrace(encoder, rays, hits, count);
  assert.deepEqual(device.dispatches.at(-1), [100, 4]);
  assert.throws(() => gpu.encodeTrace(encoder, rays, hits, 100 * 100 * 64 + 1), RangeError);
});

test('two traces in one encoder keep their own settings', async () => {
  const device = fakeDevice(),
    gpu = await GPUMeshBVH.create(device, MeshBVH.build(grid())),
    encoder = device.createCommandEncoder(),
    rays = device.createBuffer({ size: 64 }),
    hits = device.createBuffer({ size: 32 });
  gpu.encodeTrace(encoder, rays, hits, 2, { mode: 'any', side: 'front' });
  gpu.encodeTrace(encoder, rays, hits, 1, { side: 'back' });
  gpu.encodeTrace(encoder, rays, hits, 2, { mode: 'any', side: 'front' });
  const traces = device.buffers.filter((buffer) => buffer.label === 'bvh trace').map((b) => [...new Uint32Array(b.data)]);
  assert.deepEqual(traces, [
    [2, 1, 1, 64],
    [1, 2, 0, 64],
  ]);
});

test('bad input throws before any GPU work', async () => {
  const device = fakeDevice(),
    bvh = MeshBVH.build(grid()),
    gpu = await GPUMeshBVH.create(device, bvh),
    encoder = device.createCommandEncoder(),
    small = device.createBuffer({ size: 16 });
  await assert.rejects(GPUMeshBVH.create(null, bvh), { code: 'unsupported' });
  await assert.rejects(GPUMeshBVH.create({ gpu: null }, bvh), { code: 'unsupported' });
  assert.throws(() => gpu.encodeTrace(encoder, small, small, 1), RangeError);
  assert.throws(() => gpu.encodeTrace(encoder, small, small, 1.5), RangeError);
  assert.throws(() => gpu.encodeTrace(encoder, small, small, 0, { side: 'constructor' }), TypeError);
  assert.throws(() => gpu.encodeTrace(encoder, small, small, 0, { mode: 'all' }), TypeError);
  await assert.rejects(gpu.raycast(new Float32Array(9)), RangeError);
  await assert.rejects(gpu.raycast(new Float32Array([0, 0, 0, 0, 0, 0, 1, Infinity])), /not finite/);
  await assert.rejects(gpu.raycast([], { near: 2, far: 1 }), RangeError);
  await assert.rejects(gpu.raycast([], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal((await gpu.raycast([])).count, 0);
});

test('an abort during the readback rejects and still frees the buffers', async () => {
  const controller = new AbortController(),
    device = fakeDevice({ reply: () => controller.abort() }),
    gpu = await GPUMeshBVH.create(device, MeshBVH.build(grid()));
  await assert.rejects(gpu.raycast([{ origin: [0, 0, 1], direction: [0, 0, 1] }], { signal: controller.signal }), {
    name: 'AbortError',
  });
  assert.ok(device.buffers.filter((buffer) => buffer.label === 'bvh read').every((buffer) => buffer.destroyed));
});

test('a tree or ray set over the device limit is refused with a RangeError', async () => {
  await assert.rejects(GPUMeshBVH.create(fakeDevice({ limit: 64 }), MeshBVH.build(grid())), /maxStorageBufferBindingSize/);
  const device = fakeDevice({ limit: 1 << 16 }),
    gpu = await GPUMeshBVH.create(device, MeshBVH.build(grid(2)));
  await assert.rejects(gpu.raycast(new Float32Array(1 << 15)), /trace them in parts/);
});

test('a restored tree deeper than the WGSL stack is refused', async () => {
  // A chain of internal nodes in depth-first order: each holds its left subtree, then one leaf as its right child.
  const depth = GPU_MAX_DEPTH + 1,
    count = depth * 2 + 1,
    nodes = new ArrayBuffer(count * 32),
    bounds = new Float32Array(nodes),
    data = new Uint32Array(nodes),
    triangles = depth + 1,
    positions = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) positions.set([0, 0, t, 1, 0, t, 0, 1, t], t * 9);
  let next = 0,
    leaf = 0;
  const place = (level) => {
    const node = next++,
      o = node * 8;
    bounds.set([0, 0, 0, 1, 1, triangles], o);
    if (level === depth) {
      data[o + 6] = leaf++;
      data[o + 7] = 1;
      return;
    }
    place(level + 1);
    data[o + 6] = next;
    data[o + 7] = 0x80000000;
    const right = next++,
      r = right * 8;
    bounds.set([0, 0, 0, 1, 1, triangles], r);
    data[r + 6] = leaf++;
    data[r + 7] = 1;
  };
  place(0);
  const index = Uint32Array.from({ length: triangles * 3 }, (_, i) => i),
    faces = Uint32Array.from({ length: triangles }, (_, i) => i),
    bvh = new MeshBVH({ nodes, index, triangles: faces }, { positions });
  await assert.rejects(GPUMeshBVH.create(fakeDevice(), bvh), /deeper than 64/);
});

test('dispose frees every buffer once and later calls say so', async () => {
  const device = fakeDevice(),
    gpu = await GPUMeshBVH.create(device, MeshBVH.build(grid())),
    encoder = device.createCommandEncoder(),
    rays = device.createBuffer({ size: 32 }),
    hits = device.createBuffer({ size: 16 });
  gpu.encodeTrace(encoder, rays, hits, 1);
  gpu[Symbol.dispose]();
  gpu.dispose();
  assert.ok(gpu.disposed);
  assert.ok(device.buffers.filter((buffer) => /^bvh/.test(buffer.label)).every((buffer) => buffer.destroyed));
  assert.throws(() => gpu.update(), { code: 'disposed' });
  assert.throws(() => gpu.encodeTrace(encoder, rays, hits, 1), { code: 'disposed' });
  await assert.rejects(gpu.raycast([]), { code: 'disposed' });
});

test('an Engine works as the target, and one device shares the trace pipeline', async () => {
  const device = fakeDevice();
  let compiled = 0;
  const original = device.createComputePipelineAsync;
  device.createComputePipelineAsync = (descriptor) => {
    compiled++;
    return original(descriptor);
  };
  const bvh = MeshBVH.build(grid());
  await GPUMeshBVH.create({ gpu: device }, bvh);
  await GPUMeshBVH.create(device, bvh);
  assert.equal(compiled, 1);
});

test('a failed compile is not kept', async () => {
  const device = fakeDevice(),
    original = device.createComputePipelineAsync;
  device.createComputePipelineAsync = () => Promise.reject(new Error('no compile'));
  await assert.rejects(GPUMeshBVH.create(device, MeshBVH.build(grid())), /no compile/);
  device.createComputePipelineAsync = original;
  await GPUMeshBVH.create(device, MeshBVH.build(grid()));
});

test('packRays lays out origin, near, direction and a finite far', () => {
  assert.deepEqual(
    [...packRays([{ origin: [1, 2, 3], direction: [4, 5, 6] }], { near: 0.5 })],
    [1, 2, 3, 0.5, 4, 5, 6, Math.fround(GPU_FAR)],
  );
  assert.equal(packRays([{ origin: [0, 0, 0], direction: [0, 0, 1] }], { far: 2 })[7], 2);
});

test('bvhWGSL places the tree in the group and bindings asked for', () => {
  const code = bvhWGSL({ group: 2, binding: 3 });
  assert.match(code, /@group\(2\) @binding\(3\) var<storage, read> bvhNodes/);
  assert.match(code, /@group\(2\) @binding\(7\) var<uniform> bvhParams/);
  assert.match(code, /fn bvhClosest/);
  assert.match(code, /fn bvhAny/);
});
