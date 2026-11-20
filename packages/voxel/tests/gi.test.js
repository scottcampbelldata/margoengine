// VoxelGI without a GPU: its option checks and the unsupported backend. The ray tracing and the shading are proved in
// gi-browser-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { VoxelGI } from '../dist/gi.js';
import { BlockTypes, VoxelWorld } from '../dist/index.js';

test('options are checked; WebGPU is required', () => {
  const world = new VoxelWorld({ blocks: new BlockTypes() }),
    engine = { createMesh() {}, gpu: null, camera: { position: [0, 0, 0] } };
  assert.throws(() => VoxelGI.attach({}, { world }), TypeError);
  assert.throws(() => VoxelGI.attach(engine, { world: {} }), TypeError);
  for (const bad of [
    { strength: -1 },
    { strength: 9 },
    { softness: 0.6 },
    { cells: 100 },
    { cells: 5000.5 },
    { rays: 0 },
    { rays: 17 },
    { range: 65 },
    { albedo: { stone: [1, 2, 0] } },
    { albedo: { stone: 'grey' } },
  ])
    assert.throws(() => VoxelGI.attach(engine, { world, ...bad }), RangeError, JSON.stringify(bad));
  assert.throws(() => VoxelGI.attach(engine, { world }), { code: 'unsupported' });
});

// A recording WebGPU device for the compute side: buffers keep their bytes, everything else is a stub.
Object.assign(globalThis, {
  GPUBufferUsage: { STORAGE: 128, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, STORAGE_BINDING: 8 },
});
function fakeEngine(position) {
  const device = {
    buffers: [],
    createBuffer({ size, usage }) {
      const b = { size, usage, data: new ArrayBuffer(size), destroy() {} };
      device.buffers.push(b);
      return b;
    },
    createTexture: (d) => ({ ...d, createView: () => ({}), destroy() {} }),
    createSampler: (d) => ({ ...d }),
    createShaderModule: (d) => d,
    createComputePipeline: (d) => ({ ...d, getBindGroupLayout: () => ({}) }),
    createBindGroup: (d) => d,
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      finish: () => ({}),
    }),
    queue: {
      writeBuffer(b, offset, data) {
        new Uint8Array(b.data, offset, data.byteLength).set(new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0));
      },
      submit() {},
    },
  };
  return {
    device,
    engine: {
      createMesh() {},
      gpu: device,
      camera: { position },
      lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 1, 1, 0.15]) },
    },
  };
}
// A stone floor with a pillar in the 2 x 2 x 2 chunks from chunk (cx, cy, cz).
function floorWorld(cx, cy, cz) {
  const blocks = new BlockTypes();
  blocks.define('stone');
  const world = new VoxelWorld({ blocks }),
    edits = [];
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) world.addChunk(cx + x, cy + y, cz + z);
  for (let z = 0; z < 64; z++) for (let x = 0; x < 64; x++) edits.push(cx * 32 + x, cy * 32 + 2, cz * 32 + z, 1);
  for (let y = 3; y < 20; y++) edits.push(cx * 32 + 20, cy * 32 + y, cz * 32 + 9, 1);
  world.setBlocks(edits);
  return world;
}
const run = (world, eye, origin) => {
  const { device, engine } = fakeEngine(eye),
    gi = VoxelGI.attach(engine, { world }),
    voxels = { origin, addLighting: () => () => {} };
  gi.add(voxels);
  gi.update();
  const [cells, , params, , window] = device.buffers;
  return {
    gi,
    cells: new Uint32Array(cells.data),
    params: new Int32Array(params.data.slice(0, 16)),
    rest: new Uint8Array(params.data.slice(16)),
    window: new Float32Array(window.data),
  };
};

test('origin: a world 2^24 blocks out, under its renderer origin, traces the same cells and writes the same window', () => {
  const S = 2 ** 24,
    near = run(floorWorld(0, 0, 0), [30, 20, 34], null),
    far = run(floorWorld(S / 32, 64, -S / 32), [30, 20, 34], { origin: [S, 2048, -S] });
  assert.deepEqual(near.gi.origin, [0, 0, 0]);
  assert.deepEqual(far.gi.origin, [S, 2048, -S]);
  assert.ok(near.cells.some((c) => c !== 0));
  assert.deepEqual(far.cells, near.cells);
  assert.deepEqual([...far.params.subarray(0, 3)], [S, 2048, -S]);
  assert.deepEqual(far.rest, near.rest);
  // The shading reads engine cells: corner minus origin, and origin mod 64 for the wrapping volume (0 here).
  assert.deepEqual([...far.window], [...near.window]);
  assert.deepEqual([...near.window], [0, 0, 0, 1, 0, 0, 0, 0]);
});

test('origin: a fractional origin far out writes the corner in engine cells and the origin mod 64', () => {
  const S = 2 ** 24,
    origin = [S + 40.25, 2048 + 5.5, -S - 3.75],
    far = run(floorWorld(S / 32, 64, -S / 32), [10, 20, 30], { origin }),
    corner = far.gi.origin;
  // The window is centred on the world eye: camera plus origin, in float64.
  assert.deepEqual(
    corner,
    [0, 1, 2].map((a) => Math.round(([10, 20, 30][a] + origin[a]) / 32) * 32 - 32),
  );
  for (let a = 0; a < 3; a++) {
    assert.equal(far.window[a], Math.fround(corner[a] - origin[a]));
    assert.ok(Math.abs(far.window[a]) < 64);
    // Engine cell p samples world cell p + origin: (p + wrap) mod 64 equals (p + origin) mod 64.
    assert.equal(far.window[4 + a], Math.fround(((origin[a] % 64) + 64) % 64));
  }
  assert.throws(() => run(floorWorld(0, 0, 0), [0, 0, 0], { origin: [Number.NaN, 0, 0] }), RangeError);
});

test('a restored device: update remakes the volumes on the engine\'s new device and frees the old ones', () => {
  const world = floorWorld(0, 0, 0),
    first = fakeEngine([16, 16, 16]),
    second = fakeEngine([16, 16, 16]),
    gi = VoxelGI.attach(first.engine, { world }),
    destroyed = new Set(),
    make = first.device.createBuffer;
  first.device.createBuffer = (d) => Object.assign(make(d), { destroy() { destroyed.add(this); } });
  gi.update();
  assert.ok(gi.bindings().length && gi.pbr(1));
  first.engine.gpu = second.device; // the engine restored its device after a loss
  // A frame drawn before the next update binds nothing of the lost device (KB-RESTORE-VOXGI1).
  assert.deepEqual(gi.bindings(), []);
  assert.equal(gi.pbr(1), undefined);
  gi.update();
  assert.ok(gi.bindings().length && gi.pbr(1), 'the hooks come back with the new volumes');
  assert.equal(destroyed.size, first.device.buffers.length, 'every buffer of the old device is freed');
  assert.ok(second.device.buffers.length >= 5, 'the volumes are made on the new device');
  // The window's blocks are uploaded again on the new device.
  assert.ok(new Uint32Array(second.device.buffers[0].data).some((c) => c & 65536));
  gi.dispose();
});

test('strength is checked live: update throws for a value outside 0 to 8', () => {
  const { engine } = fakeEngine([0, 0, 0]),
    gi = VoxelGI.attach(engine, { world: floorWorld(0, 0, 0) });
  for (const strength of [NaN, -1, 9, '1']) {
    gi.strength = strength;
    assert.throws(() => gi.update(), RangeError, `strength ${strength}`);
  }
  gi.strength = 8;
  gi.update();
  gi.dispose();
});
