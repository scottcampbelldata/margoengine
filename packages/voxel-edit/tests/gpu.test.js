// @margoengine/voxel-edit/gpu off the GPU: argument checks before any device work. The GPU runs are in
// gpu-browser-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GpuGrid } from '../dist/gpu.js';

test('the entry loads without WebGPU and refuses a missing device or a bad grid with a fix', async () => {
  const grid = { size: [2, 2, 2], voxels: new Uint8Array(8) };
  await assert.rejects(GpuGrid.create(null, grid), (e) => e instanceof TypeError && /; pass /.test(e.message));
  await assert.rejects(GpuGrid.create({}, grid), TypeError);
  assert.equal(typeof GpuGrid.prototype[Symbol.dispose], 'function');
});

// A stand-in device: enough of WebGPU for create, the checks and counting the passes queued (no GPU work runs).
function fakeDevice() {
  globalThis.GPUBufferUsage ??= { STORAGE: 128, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, MAP_READ: 1 };
  globalThis.GPUShaderStage ??= { COMPUTE: 4 };
  const submits = [];
  const device = {
    limits: { maxStorageBufferBindingSize: 2 ** 30 },
    pushErrorScope() {},
    popErrorScope: async () => null,
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createComputePipelineAsync: async () => ({ getBindGroupLayout: () => ({}) }),
    createComputePipeline: () => ({}),
    createBuffer: ({ size }) => ({ size, destroy() {} }),
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      finish: () => ({}),
    }),
    queue: { writeBuffer() {}, submit: (list) => submits.push(list), onSubmittedWorkDone: async () => {} },
  };
  return { device, submits };
}

test('GpuGrid.brush refuses a table entry past 255 and a selection that is not indexes, as ShaderBrush.run does', async () => {
  const { device } = fakeDevice(),
    { ShaderBrush, brushes } = await import('../dist/shaders.js'),
    gpu = await GpuGrid.create(device, { size: [2, 2, 2], voxels: new Uint8Array(8) }),
    brush = await ShaderBrush.create(device, brushes.grow);
  assert.throws(() => gpu.brush(brush, { table: new Array(256).fill(300) }), /table\[0\] is 300; pass whole/);
  assert.throws(() => gpu.brush(brush, { table: new Array(256).fill(-1) }), RangeError);
  assert.throws(() => gpu.brush(brush, { selection: 5 }), (e) => e instanceof TypeError && /selection/.test(e.message));
  await assert.rejects(
    brush.run({ size: [2, 2, 2], voxels: new Uint8Array(8) }, { table: new Array(256).fill(300) }),
    /table\[0\] is 300/,
  );
});

test('GpuGrid.fill queues nothing for a sphere or box wholly outside the grid, and create refuses a side past 2^24', async () => {
  const { device, submits } = fakeDevice(),
    gpu = await GpuGrid.create(device, { size: [8, 8, 8], voxels: new Uint8Array(512) });
  const before = submits.length;
  // The far sphere once reached the shader, whose i32 squared distance wrapped negative and filled the whole grid.
  gpu.fill({ shape: 'sphere', center: [50000, 3, 3], radius: 2 }, 5);
  gpu.fill({ shape: 'sphere', center: [3, -131, 3], radius: 128 }, 5);
  gpu.fill({ shape: 'box', min: [8, 0, 0], max: [20, 8, 8] }, 5);
  assert.equal(submits.length, before);
  gpu.fill({ shape: 'sphere', center: [3, -128, 3], radius: 128 }, 5);
  assert.equal(submits.length, before + 1, 'a sphere that reaches the grid still runs');
  gpu.dispose();
  assert.throws(() => gpu.fill({ shape: 'sphere', center: [99999, 0, 0], radius: 1 }, 5), { code: 'disposed' });
  await assert.rejects(
    GpuGrid.create(device, { size: [2 ** 24 + 1, 1, 1], voxels: new Uint8Array(2 ** 24 + 1) }, { maxCells: 2 ** 25 }),
    /at most 16777216 cells per side/,
  );
});
