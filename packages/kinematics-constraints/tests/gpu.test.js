// @margoengine/kinematics-constraints/gpu without a GPU: what it packs, how it splits a batch and what it refuses. The maths
// runs on a real GPU in tests/gpu-browser.js (npm run test:gpu).
import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshBVH } from '../../bvh/dist/index.js';
import { bakeSDF } from '../../bvh/dist/sdf.js';
import { CapsuleVolume, ConvexHullVolume, SphereVolume } from '../dist/index.js';
import { GPUClearance } from '../dist/gpu.js';
import { Robot } from '../dist/robot.js';
import { MeshVolume, SDFVolume } from '../dist/sdf.js';

globalThis.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUMapMode ??= { READ: 1 };

/** Records what a real device would receive; `reply` fills the read buffer for a dispatch of `count` poses. */
function fakeDevice({ limit = 1 << 27, groups = 65535, reply = (count) => new Float32Array(count) } = {}) {
  const device = {
    buffers: [],
    written: new Map(),
    dispatches: [],
    code: null,
    limits: { maxStorageBufferBindingSize: limit, maxBufferSize: limit, maxComputeWorkgroupsPerDimension: groups },
    createShaderModule: ({ code }) => {
      device.code = code;
      return {};
    },
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
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
        mapAsync: async () => undefined,
        getMappedRange: (_offset, bytes) => buffer.data.slice(0, bytes),
        unmap() {},
      };
      device.buffers.push(buffer);
      return buffer;
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups: (x) => device.dispatches.push(x),
        end() {},
      }),
      copyBufferToBuffer(_from, _at, to, _to, bytes) {
        new Float32Array(to.data, 0, bytes / 4).set(reply(bytes / 4, device.dispatches.length - 1));
      },
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(buffer, offset, data, at = 0, size = data.byteLength - at) {
        device.written.set(buffer.label, new Uint8Array(data.slice(at, at + size)));
      },
      submit() {},
    },
  };
  return device;
}

const floats = (device, label) => new Float32Array(device.written.get(`GPUClearance ${label}`).slice().buffer);
const whole = (device, label) => new Uint32Array(device.written.get(`GPUClearance ${label}`).slice().buffer);
const along = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const arm = () =>
  new Robot({
    joints: [
      { name: 'a', axis: [0, 2, 0], lower: -1, upper: 1 },
      { name: 'b', type: 'prismatic', axis: [1, 0, 0], lower: 0, upper: 1, origin: along(1, 2, 3) },
      { name: 'c', axis: [0, 0, 1], origin: along(0, 1, 0), mimic: { joint: 'a', multiplier: 3, offset: 0.5 } },
      { name: 'd', type: 'fixed', origin: along(0, 0, 1) },
    ],
    shapes: [
      { joint: null, end: [0, 0, 1], radius: 0.1 },
      { joint: 'b', points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], matrix: along(0, 0, 2) },
    ],
  });

test('joints, shapes and colliders go up as the kernel reads them', () => {
  const device = fakeDevice(),
    hull = new ConvexHullVolume({ points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], matrix: along(5, 0, 0) });
  new GPUClearance(device, arm(), [
    new SphereVolume({ center: [1, 2, 3], radius: 0.5 }),
    new CapsuleVolume({ start: [0, 0, 0], end: [0, 0, 1], radius: 0.25 }),
    hull,
  ]);
  const joints = floats(device, 'joints'),
    row = (i) => [...joints.subarray(i * 4, i * 4 + 4)];
  // The base first: an identity.
  assert.deepEqual(row(0).slice(0, 3), [1, 0, 0]);
  assert.deepEqual(row(3).slice(0, 3), [0, 0, 0]);
  // Joint b's rows sit after joint a's: origin in the columns, kind, parent frame, entry, multiplier, offset in the w.
  const b = 4 + 5;
  assert.deepEqual(row(b + 3), [1, 2, 3, 1]);
  assert.deepEqual(row(b + 4), [1, 0, 0, 0]);
  assert.equal(row(b)[3], 1, 'prismatic');
  assert.equal(row(b + 1)[3], 1, 'rides on frame 1, joint a');
  assert.equal(row(b + 2)[3], 1, 'second configuration entry');
  // The axis is unit length; the mimic carries its source's entry, multiplier and offset.
  assert.deepEqual(row(4 + 4), [0, 1, 0, 0]);
  const c = 4 + 10;
  assert.equal(row(c + 2)[3], 0);
  assert.equal(row(c + 3)[3], 3);
  assert.equal(row(c + 4)[3], 0.5);
  assert.equal(row(4 + 15)[3], 2, 'fixed');
  // Sets: base capsule, joint hull, then the colliders in the world frame after the last joint's.
  const sets = whole(device, 'sets'),
    radii = floats(device, 'sets');
  assert.deepEqual([...sets.subarray(0, 3)], [0, 2, 0]);
  assert.equal(radii[3], Math.fround(0.1));
  assert.deepEqual([...sets.subarray(4, 7)], [2, 4, 2]);
  assert.deepEqual([...sets.subarray(8, 11)], [6, 1, 5]);
  assert.equal(radii[11], 0.5);
  assert.deepEqual([...sets.subarray(12, 15)], [7, 2, 5]);
  assert.deepEqual([...sets.subarray(16, 19)], [9, 4, 5]);
  // A hull shape's matrix and a hull collider's are applied here.
  const points = floats(device, 'points'),
    point = (i) => [...points.subarray(i * 4, i * 4 + 3)];
  assert.deepEqual(point(3), [1, 0, 2]);
  assert.deepEqual(point(10), [6, 0, 0]);
  assert.match(device.code ?? '', /^$/, 'the pipeline is built at the first evaluate');
});

test('a long batch is split, one dispatch at a time, and read back in order', async () => {
  const device = fakeDevice({ reply: (count, dispatch) => new Float32Array(count).fill(dispatch + 1) }),
    clearance = new GPUClearance(device, arm(), [new SphereVolume({ center: [9, 9, 9], radius: 1 })], { batch: 100 }),
    gaps = await clearance.evaluate(new Float64Array(250 * 2));
  assert.deepEqual(device.dispatches, [2, 2, 1]);
  assert.equal(gaps.length, 250);
  assert.equal(gaps[99], 1);
  assert.equal(gaps[100], 2);
  assert.equal(gaps[249], 3);
  assert.match(device.code, /const FRAMES = 6u;/);
  assert.match(device.code, /fn preciseSin/);
});

test('calls wait their turn, and a batch never outgrows the device', async () => {
  const device = fakeDevice({ limit: 1024, groups: 2, reply: (count) => new Float32Array(count).fill(7) }),
    clearance = new GPUClearance(device, arm(), [new SphereVolume({ center: [9, 9, 9], radius: 1 })]);
  assert.equal(clearance.batch, 128, 'two workgroups of 64');
  const [a, b] = await Promise.all([clearance.evaluate([0, 0]), clearance.evaluate([0, 0, 1, 1])]);
  assert.deepEqual([...a], [7]);
  assert.deepEqual([...b], [7, 7]);
  const tiny = fakeDevice({ limit: 64 });
  assert.throws(() => new GPUClearance(tiny, arm(), []), /over this device/);
});

test('the far reading is Infinity, as Robot.clearance gives with nothing to test', async () => {
  const device = fakeDevice({ reply: (count) => new Float32Array(count).fill(3e38) }),
    gaps = await new GPUClearance(device, arm(), []).evaluate([0, 0]);
  assert.deepEqual([...gaps], [Infinity]);
});

test('minClearance reaches the kernel as a stop, and none means no stop', async () => {
  const header = async (options) => {
    const device = fakeDevice();
    await new GPUClearance(device, arm(), [], options).evaluate([0, 0]);
    return device.written.get('GPUClearance params').slice();
  };
  const on = await header({ minClearance: 0.25 }),
    off = await header({});
  assert.equal(new Uint32Array(on.buffer)[5], 1);
  assert.equal(new Float32Array(on.buffer)[6], 0.25);
  assert.equal(new Uint32Array(off.buffer)[5], 0);
});

test('a baked field goes up by its corners; a mesh and a function are refused', () => {
  const positions = new Float32Array([-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]),
    indices = new Uint32Array([
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ]),
    bvh = MeshBVH.build({ positions, indices }),
    field = bakeSDF(bvh, { resolution: 8 }),
    volume = new SDFVolume({ field, matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 2, 3, 1] }),
    device = fakeDevice();
  new GPUClearance(device, arm(), [volume]);
  const data = floats(device, 'fields'),
    sets = whole(device, 'sets'),
    close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ${b}`);
  assert.deepEqual([...sets.subarray(8, 11)], [0, 0, 0xffffffff]);
  // World to field: half the scale, and the move undone.
  close(data[0], 0.5);
  close(data[9], -0.5);
  close(data[10], -1);
  close(data[11], -1.5);
  assert.deepEqual([...data.subarray(21, 24)], [...field.size]);
  assert.equal(data[24], 2);
  close(data[25], volume.margin);
  close(data[26], volume.precision);
  assert.equal(data[29], 32);
  assert.equal(data.length, 32 + field.size[0] * field.size[1] * field.size[2]);
  const at = (x, y, z) => data[32 + x + field.size[0] * (y + field.size[1] * z)];
  // Each sample is the field at that corner, x fastest.
  close(
    at(1, 2, 3),
    field.distance([0, 1, 2].map((k) => field.min[k] + [1, 2, 3][k] * field.spacing[k])),
  );
  assert.throws(() => new GPUClearance(fakeDevice(), arm(), [new MeshVolume({ bvh })]), /bake a mesh/);
  assert.throws(() => new GPUClearance(fakeDevice(), arm(), [new SDFVolume({ field: { distance: () => 1 } })]), /bake/);
});

test('bad arguments are refused, and dispose frees every buffer once', async () => {
  assert.throws(() => new GPUClearance({}, arm(), []), /GPUDevice/);
  assert.throws(() => new GPUClearance(fakeDevice(), {}, []), /needs a Robot/);
  assert.throws(() => new GPUClearance(fakeDevice(), arm(), 'none'), /array of volumes/);
  assert.throws(() => new GPUClearance(fakeDevice(), arm(), [], { batch: 0 }), /batch/);
  assert.throws(() => new GPUClearance(fakeDevice(), arm(), [], { minClearance: NaN }), /minClearance/);
  const still = new Robot({ joints: [{ type: 'fixed' }] });
  assert.throws(() => new GPUClearance(fakeDevice(), still, []), /moving joint/);
  const device = fakeDevice(),
    clearance = new GPUClearance(device, arm(), []);
  await assert.rejects(clearance.evaluate([0, 0, 1]), /2 numbers each/);
  await assert.rejects(clearance.evaluate([0, 0], { signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.deepEqual([...(await clearance.evaluate([]))], []);
  clearance[Symbol.dispose]();
  clearance.dispose();
  assert.ok(device.buffers.every((buffer) => buffer.destroyed));
  await assert.rejects(clearance.evaluate([0, 0]), /disposed/);
});
