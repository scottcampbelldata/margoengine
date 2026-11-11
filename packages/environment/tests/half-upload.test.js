import test from 'node:test';
import assert from 'node:assert/strict';
import { Environment, floatToHalf } from '../dist/index.js';

Object.assign(globalThis, {
  GPUBufferUsage: { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 },
  GPUTextureUsage: { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 },
  GPUMapMode: { READ: 1 },
});

/** A device that does nothing but keep the texels Environment.create uploads. */
function recordingDevice() {
  const uploads = [],
    params = [],
    pipeline = () => ({ getBindGroupLayout: () => ({}) }),
    pass = { setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, draw() {}, end() {} };
  return {
    uploads,
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(),
    createBuffer: (d) => ({
      size: d.size,
      destroy() {},
      mapAsync: async () => {},
      getMappedRange: () => new ArrayBuffer(d.size),
      unmap() {},
    }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroup: () => ({}),
    createComputePipeline: pipeline,
    createRenderPipeline: pipeline,
    pushErrorScope() {},
    popErrorScope: async () => null,
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      beginRenderPass: () => pass,
      copyBufferToBuffer() {},
      copyTextureToTexture() {},
      finish: () => ({}),
    }),
    params,
    queue: {
      writeBuffer(buffer, offset, data) {
        if (data instanceof Float32Array && data.length === 4) params.push([...data]);
      },
      writeTexture: (destination, data) => uploads.push(new Uint16Array(data.buffer, data.byteOffset, data.length)),
      submit() {},
    },
  };
}

test('the equirect upload holds the same half floats with the built-in Float16Array as with the bit loop', async () => {
  // p-pmrem spent half of Environment.create converting its HDR to half floats one bit-twiddled value at a time; the
  // built-in Float16Array store rounds to nearest even the same way. Negative, NaN and infinite texels are stored as
  // 0, and the 1e9 texel puts the peak past 60,000, so RGB is divided by peak / 60000 (rounded to f32, then each
  // value to f32) first; the bits must match in both paths, subnormals and ties included.
  const width = 64,
    height = 32,
    data = new Float32Array(width * height * 4);
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const specials = [0, -0, -1, NaN, Infinity, -Infinity, 65504, 65520, 1e9, 6e-8, 3e-8, 1e-12, 1 + 2 ** -11, 2049];
  for (let i = 0; i < data.length; i++)
    data[i] = i < specials.length ? specials[i] : rnd() < 0.2 ? rnd() * 1e-4 : (rnd() * 2) ** 12;
  const scale = Math.fround(1e9 / 60000),
    expected = Uint16Array.from(data, (v, i) => {
      if (!(v > 0 && v < Infinity)) return 0;
      const s = i % 4 === 3 ? v : Math.fround(v * (1 / scale));
      return floatToHalf(s < 65504 ? s : 65504);
    });
  const upload = async () => {
    const device = recordingDevice();
    (await Environment.create(device, { width, height, data }, { size: 16 })).dispose();
    return device.uploads[0];
  };
  assert.ok(globalThis.Float16Array, 'this runtime has Float16Array');
  assert.deepEqual(await upload(), expected);
  const native = globalThis.Float16Array;
  delete globalThis.Float16Array;
  try {
    assert.deepEqual(await upload(), expected);
  } finally {
    globalThis.Float16Array = native;
  }
});

test('a source brighter than half floats is divided into range and lighting multiplies the factor back', async () => {
  // R2 (Rust engine port): a 1e6 sun clamped to 65504 in the rgba16float upload lost 93 percent of its energy.
  const width = 8,
    height = 4,
    data = new Float32Array(width * height * 4).fill(1);
  data.set([1e6, 5e5, 2.5e5, 1], 4 * 9);
  const device = recordingDevice(),
    environment = await Environment.create(device, { width, height, data }, { size: 16, intensity: 0.5 });
  const scale = Math.fround(1e6 / 60000);
  assert.equal(environment.radianceScale, scale);
  const half = device.uploads[0];
  // Stored sun times the scale gives the sun back to half-float precision (2^-11 relative).
  const stored = (bits) => {
    const e = (bits >> 10) & 31,
      m = bits & 1023;
    return e ? (1 + m / 1024) * 2 ** (e - 15) : m * 2 ** -24;
  };
  for (let c = 0; c < 3; c++) {
    const want = [1e6, 5e5, 2.5e5][c];
    assert.ok(Math.abs(stored(half[4 * 9 + c]) * scale - want) <= want * 2 ** -11, `channel ${c}`);
  }
  assert.equal(stored(half[4 * 9 + 3]), 1, 'alpha is not radiance and is not scaled');
  // paramsBuffer w carries intensity x scale; changing intensity keeps the scale.
  assert.equal(device.params[0][3], Math.fround(0.5 * scale));
  environment.intensity = 2;
  assert.equal(device.params.at(-1)[3], Math.fround(2 * scale));
  assert.throws(() => (environment.radianceScale = 0), RangeError);
  assert.throws(() => (environment.radianceScale = Infinity), RangeError);
  environment.radianceScale = 3;
  assert.equal(device.params.at(-1)[3], 6);
  environment.dispose();
  // A source within range keeps the factor 1 and its texels as they are.
  const plain = await Environment.create(recordingDevice(), { width, height, data: new Float32Array(128).fill(60000) }, { size: 16 });
  assert.equal(plain.radianceScale, 1);
  plain.dispose();
});
