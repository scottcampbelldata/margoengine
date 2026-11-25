import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeshBVH } from '../dist/tree.js';
import { GPU_SCENE_INSTANCE_WORDS, GPUSceneBVH, sceneBvhWGSL } from '../dist/gpu-scene.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode ??= { READ: 1 };

// Records what a real device would receive.
function fakeDevice({ limit = 1 << 27 } = {}) {
  const device = {
    buffers: [],
    limits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit, maxComputeWorkgroupsPerDimension: 65535 },
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
        destroy: () => (buffer.destroyed = true),
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
    },
  };
  return device;
}

const quad = () =>
  MeshBVH.build({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  });
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** Walks the uploaded top tree: every box holds its children, every instance is in exactly one leaf; returns the depth. */
function checkTop(scene) {
  const floats = new Float32Array(scene.nodes.data),
    words = new Uint32Array(scene.nodes.data),
    seen = new Uint8Array(scene.count);
  let deepest = 0;
  const visit = (node, depth) => {
    deepest = Math.max(deepest, depth);
    const o = node * 8;
    if (words[o + 7] & 0x80000000) {
      for (const child of [words[o + 3], words[o + 7] & 0x7fffffff]) {
        const c = child * 8;
        for (let a = 0; a < 3; a++) {
          assert.ok(floats[c + a] >= floats[o + a], `node ${child} below its parent on axis ${a}`);
          assert.ok(floats[c + 4 + a] <= floats[o + 4 + a], `node ${child} above its parent on axis ${a}`);
        }
        visit(child, depth + 1);
      }
    } else {
      assert.equal(words[o + 7], 1, 'one instance a leaf');
      const instance = words[o + 3],
        box = scene.instanceBounds(instance);
      for (let a = 0; a < 3; a++) {
        assert.ok(floats[o + a] <= box[a] && floats[o + 4 + a] >= box[3 + a], `leaf box holds instance ${instance}`);
      }
      seen[instance]++;
    }
  };
  visit(0, 0);
  assert.ok(
    seen.every((v) => v === 1),
    'every instance sits in exactly one leaf',
  );
  return deepest;
}

test('the top tree holds every instance once, boxes nest, and bottom trees are shared', async () => {
  const device = fakeDevice(),
    a = quad(),
    b = MeshBVH.build({ positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]) }),
    instances = [];
  for (let i = 0; i < 300; i++)
    instances.push({ bvh: i % 2 ? a : b, matrix: translate((i * 7) % 31, (i * 13) % 17, i % 5) });
  const scene = await GPUSceneBVH.create(device, instances);
  assert.equal(scene.count, 300);
  assert.ok(checkTop(scene) < 64);
  // Two distinct trees in the pool: 2 * 300 - 1 top nodes, then each tree's nodes once.
  assert.equal(scene.nodes.size, (599 + a.nodeCount + b.nodeCount) * 32);
  assert.equal(scene.triangles.size, (a.triangleCount + b.triangleCount) * 16);
  assert.equal(scene.instances.size, 300 * GPU_SCENE_INSTANCE_WORDS * 4);
  const words = new Uint32Array(scene.instances.data);
  assert.deepEqual([...new Set([0, 1, 2, 3].map((i) => words[i * GPU_SCENE_INSTANCE_WORDS + 12]))].length, 2);
  scene.dispose();
  assert.ok(scene.nodes.destroyed && scene.params.destroyed);
  assert.throws(() => scene.update(), { code: 'disposed' });
});

test('a pathological spread stays inside the WGSL stack', async () => {
  // Boxes at 2^i: SAH alone would cut one instance off each side per level.
  const bvh = quad(),
    instances = Array.from({ length: 200 }, (_, i) => ({ bvh, matrix: translate(2 ** (i / 4), 0, 0) }));
  const scene = GPUSceneBVH.forShader(fakeDevice(), instances);
  assert.ok(checkTop(scene) <= 64);
  assert.throws(() => scene.encodeTrace({}, {}, {}, 1), { code: 'state' });
});

test('update refits small moves and rebuilds once the tree costs past the threshold', async () => {
  const bvh = quad(),
    instances = Array.from({ length: 64 }, (_, i) => ({ bvh, matrix: translate(i % 8, Math.floor(i / 8), 0) })),
    scene = await GPUSceneBVH.create(fakeDevice(), instances);
  assert.equal(scene.update(), 'unchanged');
  const built = scene.cost;
  scene.setMatrix(3, translate(3.1, 0, 0));
  assert.equal(scene.update(), 'refit');
  assert.ok(checkTop(scene) < 64);
  assert.deepEqual(
    [...scene.instanceBounds(3)].map((v) => +v.toFixed(6)),
    [3.1, 0, 0, 4.1, 1, 0],
  );
  // Swap far corners: the refitted boxes overlap and the cost climbs past 1.5 times the built cost.
  for (let i = 0; i < 32; i++) {
    scene.setMatrix(i, translate(63 - (i % 8) * 9, 63 - Math.floor(i / 8) * 9, 40));
    scene.setMatrix(63 - i, translate(i % 8, Math.floor(i / 8), -40));
  }
  assert.equal(scene.update(), 'rebuilt');
  assert.ok(scene.cost <= built * 1.5 * 40, "the rebuilt cost is the new placement's");
  assert.ok(checkTop(scene) < 64);
  scene.setMaterial(5, { color: [1, 0, 0], emissive: [3, 2, 1], metalness: 1, roughness: 0.1 });
  assert.equal(scene.update(), 'refit');
  const floats = new Float32Array(scene.instances.data),
    o = 5 * GPU_SCENE_INSTANCE_WORDS;
  assert.deepEqual(
    [...floats.subarray(o + 16, o + 26)].map((v) => +v.toFixed(5)),
    [1, 0, 0, 1, 3, 2, 1, 0, 1, 0.1],
  );
});

test('the instance record holds the world-to-object rows', () => {
  const bvh = quad(),
    m = [2, 0, 0, 0, 0, -1, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1],
    scene = GPUSceneBVH.forShader(fakeDevice(), [{ bvh, matrix: m, side: 'back' }]),
    floats = new Float32Array(scene.instances.data),
    words = new Uint32Array(scene.instances.data);
  assert.deepEqual(
    [...floats.subarray(0, 12)].map((v) => v + 0),
    [0.5, 0, 0, -2.5, 0, -1, 0, 6, 0, 0, 0.25, -1.75],
  );
  assert.equal(words[15], 2);
  // Defaults: white, opaque, no emission, dielectric, roughness 0.5.
  assert.deepEqual([...floats.subarray(16, 26)], [1, 1, 1, 1, 0, 0, 0, 0, 0, 0.5]);
});

test('bad input throws before any upload', async () => {
  const bvh = quad(),
    device = fakeDevice();
  assert.throws(() => GPUSceneBVH.forShader(device, [{ bvh: null }]), TypeError);
  assert.throws(() => GPUSceneBVH.forShader(device, [{ bvh, matrix: [1, 2, 3] }]), /16 numbers/);
  assert.throws(
    () => GPUSceneBVH.forShader(device, [{ bvh, matrix: [0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]),
    /invertible/,
  );
  assert.throws(
    () => GPUSceneBVH.forShader(device, [{ bvh, matrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }]),
    /affine/,
  );
  assert.throws(() => GPUSceneBVH.forShader(device, [{ bvh, material: { color: [2, 0, 0] } }]), /color/);
  assert.throws(() => GPUSceneBVH.forShader(device, [{ bvh, material: { roughness: -1 } }]), /roughness/);
  assert.throws(() => GPUSceneBVH.forShader(device, [{ bvh, side: 'both' }]), TypeError);
  assert.throws(() => GPUSceneBVH.forShader(device, [{ bvh }], { rebuildThreshold: 0.5 }), RangeError);
  assert.throws(() => GPUSceneBVH.forShader(fakeDevice({ limit: 64 }), [{ bvh }]), /maxStorageBufferBindingSize/);
  assert.throws(() => GPUSceneBVH.forShader({}, [{ bvh }]), { code: 'unsupported' });
  const scene = GPUSceneBVH.forShader(device, [{ bvh }]);
  assert.throws(() => scene.setMatrix(1, translate(0, 0, 0)), RangeError);
  assert.throws(() => sceneBvhWGSL({ group: -1 }), RangeError);
  assert.equal(device.buffers.filter((buffer) => !buffer.destroyed).length, 5);
  const empty = await GPUSceneBVH.create(fakeDevice(), []);
  assert.equal(empty.count, 0);
  assert.equal(empty.instances.size, GPU_SCENE_INSTANCE_WORDS * 4, 'an empty scene still binds one record');
  assert.deepEqual((await empty.raycast([])).count, 0);
});

test('sceneBvhWGSL declares its five bindings where asked', () => {
  const code = sceneBvhWGSL({ group: 2, binding: 3 });
  for (let k = 0; k < 5; k++) assert.ok(code.includes(`@group(2) @binding(${3 + k})`));
  for (const name of ['fn sceneClosest(', 'fn sceneAny(', 'fn sceneNormal(', 'fn sceneMaterial(', 'fn sceneTriangle('])
    assert.ok(code.includes(name), name);
});

test('dispose frees every buffer a trace made, its settings uniform included', async () => {
  const device = fakeDevice();
  device.createCommandEncoder = () => ({
    beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
    copyBufferToBuffer() {},
    finish: () => ({}),
  });
  device.queue.submit = () => {};
  const create = device.createBuffer;
  device.createBuffer = (descriptor) => {
    const buffer = create(descriptor);
    // A miss in every hit slot: the instance word is 0xffffffff.
    buffer.mapAsync = async () => new Uint32Array(buffer.data).fill(0xffffffff);
    buffer.getMappedRange = () => buffer.data;
    return buffer;
  };
  const scene = await GPUSceneBVH.create(device, [{ bvh: quad() }]),
    ray = [{ origin: [0.5, 0.5, 5], direction: [0, 0, -1] }];
  await scene.raycast(ray);
  await scene.raycast(ray, { mode: 'any' });
  await scene.raycast(ray);
  // One settings uniform per distinct trace, reused: closest and any.
  assert.equal(device.buffers.filter((b) => b.label === 'bvh scene trace').length, 2);
  scene.dispose();
  assert.deepEqual(
    device.buffers.filter((b) => !b.destroyed).map((b) => b.label),
    [],
    'no buffer outlives the scene',
  );
});
