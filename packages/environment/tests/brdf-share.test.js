// One BRDF LUT per device, size and sample count, counted across the environments that hold it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Environment } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';

Object.assign(globalThis, {
  GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUMapMode: { READ: 1 },
});

/** A device that does nothing but count the LUT fills and buffers, and can read back non-finite SH, which fails a create. */
function countingDevice() {
  const device = {
    fills: 0,
    luts: [],
    badSh: false,
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(),
    createBuffer: (d) => {
      const buffer = {
        size: d.size,
        destroyed: 0,
        destroy() {
          this.destroyed++;
        },
        mapAsync: async () => {},
        getMappedRange: () => (device.badSh ? new Float32Array(d.size / 4).fill(NaN).buffer : new ArrayBuffer(d.size)),
        unmap() {},
      };
      if (d.label === 'environment BRDF LUT') device.luts.push(buffer);
      return buffer;
    },
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroup: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    pushErrorScope() {},
    popErrorScope: async () => null,
    createCommandEncoder: () => ({
      beginComputePass: ({ label } = {}) => {
        if (label === 'environment brdfLut') device.fills++;
        return { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} };
      },
      beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
      copyBufferToBuffer() {},
      copyTextureToTexture() {},
      finish: () => ({}),
    }),
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit() {},
    },
  };
  return device;
}
const image = { width: 8, height: 4, data: new Float32Array(8 * 4 * 4).fill(1) };
const make = (device, options) => Environment.create(device, image, { size: 16, ...options });

test('two environments of one device fill one LUT, and it is freed with the last of them', async () => {
  const device = countingDevice(),
    first = await make(device),
    second = await make(device),
    lut = first.brdfLut;
  assert.equal(device.fills, 1);
  assert.equal(second.brdfLut, lut);
  first.dispose();
  assert.equal(lut.destroyed, 0, 'still held by the second');
  assert.equal(second.brdfLut, lut);
  second.dispose();
  assert.equal(lut.destroyed, 1);
  const third = await make(device);
  assert.notEqual(third.brdfLut, lut, 'a freed LUT is not handed out again');
  assert.equal(device.fills, 2);
  third.dispose();
});

test('overlapping creates share one LUT, and each environment counts once', async () => {
  const device = countingDevice(),
    [first, second, third] = await Promise.all([make(device), make(device), make(device)]);
  assert.equal(device.fills, 1);
  assert.equal(device.luts.length, 1);
  first.dispose();
  second.dispose();
  assert.equal(device.luts[0].destroyed, 0);
  third.dispose();
  assert.equal(device.luts[0].destroyed, 1);
});

test('another size, sample count or device gets its own LUT', async () => {
  const device = countingDevice(),
    other = countingDevice(),
    plain = await make(device),
    size = await make(device, { brdfSize: 64 }),
    samples = await make(device, { brdfSamples: 64 }),
    elsewhere = await make(other);
  assert.equal(device.fills, 3);
  assert.equal(other.fills, 1);
  assert.equal(new Set([plain, size, samples, elsewhere].map((e) => e.brdfLut)).size, 4);
  assert.equal(size.brdfLut.size, 64 * 64 * 4);
  for (const environment of [plain, size, samples, elsewhere]) environment.dispose();
  assert.ok(device.luts.every((lut) => lut.destroyed === 1));
});

test('a failed create drops its count, and no later environment joins that LUT', async () => {
  const device = countingDevice();
  device.badSh = true;
  await assert.rejects(make(device), /non-finite SH/);
  assert.equal(device.luts.length, 1);
  assert.equal(device.luts[0].destroyed, 1, 'the failed create held the only count');
  device.badSh = false;
  const kept = await make(device),
    lut = kept.brdfLut;
  assert.notEqual(lut, device.luts[0]);
  assert.equal(device.fills, 2);
  device.badSh = true;
  await assert.rejects(make(device), /non-finite SH/);
  assert.equal(lut.destroyed, 0, 'the failed joiner leaves the LUT to the environment that holds it');
  device.badSh = false;
  const next = await make(device);
  assert.notEqual(next.brdfLut, lut, 'a failed create may have left its LUT unfilled, so it is not offered again');
  kept.dispose();
  assert.equal(lut.destroyed, 1);
  next.dispose();
});

test('restoring on another device moves the count there', async () => {
  const device = countingDevice(),
    other = countingDevice(),
    first = await make(device),
    second = await make(device),
    lut = first.brdfLut;
  await first.restore(other);
  assert.notEqual(first.brdfLut, lut);
  assert.equal(other.fills, 1);
  assert.equal(lut.destroyed, 0, 'the second still holds it');
  second.dispose();
  assert.equal(lut.destroyed, 1);
  first.dispose();
  assert.equal(other.luts[0].destroyed, 1);
});

test('test-page 20: direct disposal detaches an attached environment and permits replacement', async () => {
  const device = countingDevice();
  const engine = new Engine(
    { width: 16, height: 16 },
    await TransformStore.create(4),
    { backend: 'webgpu', gpu: device, dispose() {} },
    {},
    null,
  );
  try {
    const first = await Environment.attach(engine, image, { size: 16 });
    assert.equal(engine.plugins.get(first.name), first);
    first.dispose();
    first.dispose();
    assert.equal(engine.plugins.has(first.name), false);
    const replacement = await Environment.attach(engine, image, { size: 16 });
    assert.equal(engine.plugins.get(replacement.name), replacement);
    replacement.dispose();
    assert.equal(engine.plugins.size, 0);
    assert.ok(device.luts.every(lut => lut.destroyed === 1));
  } finally {
    engine.dispose();
  }
});

test('test-page 20: disposal removes the owning scene, preserving an identically named environment', async () => {
  const device = countingDevice();
  const engine = new Engine(
    { width: 16, height: 16 },
    await TransformStore.create(4),
    { backend: 'webgpu', gpu: device, dispose() {} },
    {},
    null,
  );
  try {
    const first = await Environment.attach(engine, image, { size: 16 });
    const scene = engine.createScene('other');
    const second = await make(device);
    scene.use(second);
    second.dispose();
    assert.equal(scene.plugins.size, 0);
    assert.equal(engine.plugins.get(first.name), first);
    const replacement = await make(device);
    scene.use(replacement);
    scene.removePlugin(replacement.name);
    assert.equal(replacement.disposed, true);
    first.dispose();
    assert.ok(device.luts.every(lut => lut.destroyed === 1));
  } finally {
    engine.dispose();
  }
});
