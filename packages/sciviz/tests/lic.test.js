import test from 'node:test';
import assert from 'node:assert/strict';
import { lic } from '@margoengine/sciviz/lic';

// Device spies below use the WebGPU numeric enums without installing a rendering backend in Node.
globalThis.GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUTextureUsage = { COPY_DST: 2, TEXTURE_BINDING: 4 };

const grid = () => ({ dims: [2, 2, 1], bounds: [10, 14, -2, 2, 5, 5], u: [1, 1, 1, 1], v: [0, 0, 0, 0] });
const fake = () => {
  const buffers = [], layers = new Set();
  const device = { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 128 * 1024 * 1024 },
    queue: { writeBuffer(buffer, offset, data) { buffer.data = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice(); }, writeTexture() {} },
    createBuffer({ size }) { const b = { size, destroyed: false, destroy() { this.destroyed = true; } }; buffers.push(b); return b; },
    createTexture() { return { createView() { return {}; }, destroy() {} }; },
  };
  for (const method of ['createBindGroupLayout', 'createBindGroup', 'createPipelineLayout', 'createShaderModule', 'createComputePipeline', 'createSampler']) device[method] = () => ({});
  const renderer = { device, add() {}, remove() {} };
  return { buffers, layers, renderer, addLayer(layer) { layers.add(layer); layer.setModel(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])); } };
};

test('LIC validates all input before GPU allocation or publication', async () => {
  const f = fake();
  for (const options of [{ steps: 0 }, { steps: 129 }, { step: 0 }, { step: 1.1 }, { seed: -1 }, { seed: 2 ** 32 },
    { resolution: [7, 8] }, { resolution: [8, 2049] }, { resolution: [8.5, 8] }, { resolution: [8] },
    { phase: NaN }, { opacity: 2 }, { contrast: -1 }, { animated: 'yes' }, { coloured: 0 },
    { scalar: [0] }, { scalar: [0, 0, Infinity, 0] }, { range: [1, 1] },
    { slice: { origin: [0, 0, 5], axisU: [1, 0, 0], axisV: [2, 0, 0] } },
    { slice: { origin: [0, 0, 6], axisU: [1, 0, 0], axisV: [0, 1, 0] } }])
    await assert.rejects(lic(f, grid(), options), RangeError);
  for (const change of [{ dims: [2, 2, 0] }, { bounds: [0, 0, 0, 1, 0, 0] }, { bounds: [0, 1, 0, 1, 0, 1] },
    { u: [1] }, { u: [1, 1, undefined, 1] }, { v: [0, 0, Infinity, 0] }, { w: [] }])
    await assert.rejects(lic(f, { ...grid(), ...change }), RangeError);
  assert.equal(f.buffers.length, 0); assert.equal(f.layers.size, 0);
});

test('LIC copies data, preserves tiny velocities, and owns device replacement and disposal', async () => {
  const f = fake(), g = grid(); g.u = [1e-100, 1e-100, 1e-100, 1e-100];
  const resolution = [16, 8], layer = await lic(f, g, { resolution, phase: -Math.PI, seed: 171 });
  const raw = new Float32Array(f.buffers[1].data.buffer);
  assert.equal(raw[0], 1, 'normalizes in float64 before rounding to float32');
  g.u.fill(99); resolution[0] = 8;
  assert.equal(raw[0], 1); assert.deepEqual(layer.resolution, [16, 8]);
  assert.deepEqual(layer.bounds, [10, 14, -2, 2, 5, 5]); assert.deepEqual(layer.center(), [12, 0, 5]);
  layer.setPhase(3 * Math.PI); assert.ok(Math.abs(layer.phase - Math.PI) < 2e-7);
  const prior = [...f.buffers]; layer.restore(); assert.ok(prior.every((b) => b.destroyed));
  assert.deepEqual(f.buffers[4].data, f.buffers[1].data, 'restore uses immutable retained copy');
  layer.dispose(); layer.dispose(); assert.ok(f.buffers.every((b) => b.destroyed));
  assert.throws(() => layer.setPhase(0), (e) => e.code === 'disposed');
  await assert.rejects(layer.readIntensity(), (e) => e.code === 'disposed');
});

test('LIC exact-reason abort before and during bounded field copying leaves no layer or allocation', async () => {
  const f = fake(), reason = { cancelled: true }, controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(lic(f, grid(), { signal: controller.signal }), (e) => e === reason);
  const during = new AbortController();
  const pending = lic(f, grid(), { signal: during.signal }); during.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  assert.equal(f.layers.size, 0); assert.equal(f.buffers.length, 0);
});

test('LIC device budgets reject before allocation and release partial resource builds', async () => {
  const f = fake(); f.renderer.device.limits.maxStorageBufferBindingSize = 255;
  await assert.rejects(lic(f, grid(), { resolution: [8, 8] }), RangeError);
  assert.equal(f.buffers.length, 0);
  const failed = fake(), reason = new Error('device allocation failed');
  failed.renderer.device.createComputePipeline = () => { throw reason; };
  await assert.rejects(lic(failed, grid()), (e) => e === reason);
  assert.ok(failed.buffers.every((b) => b.destroyed)); assert.equal(failed.layers.size, 0);
});
