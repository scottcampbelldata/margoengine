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
    queue: {
      writeBuffer() {},
      writeTexture: (destination, data) => uploads.push(new Uint16Array(data.buffer, data.byteOffset, data.length)),
      submit() {},
    },
  };
}

test('the equirect upload holds the same half floats with the built-in Float16Array as with the bit loop', async () => {
  // p-pmrem spent half of Environment.create converting its HDR to half floats one bit-twiddled value at a time; the
  // built-in Float16Array store rounds to nearest even the same way. Negative, NaN and over-range texels are
  // sanitized first (0, 0 and 65504), so the bits must match in both paths, subnormals and ties included.
  const width = 64,
    height = 32,
    data = new Float32Array(width * height * 4);
  let seed = 7;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const specials = [0, -0, -1, NaN, Infinity, -Infinity, 65504, 65520, 1e9, 6e-8, 3e-8, 1e-12, 1 + 2 ** -11, 2049];
  for (let i = 0; i < data.length; i++)
    data[i] = i < specials.length ? specials[i] : rnd() < 0.2 ? rnd() * 1e-4 : (rnd() * 2) ** 12;
  const expected = Uint16Array.from(data, (v) => (v > 0 ? floatToHalf(v < 65504 ? v : 65504) : 0));
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
