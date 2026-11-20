// The CPU half of the GPU transcoder (@margoengine/decoders/ktx2-gpu): what it refuses, and the ETC1S reader on real files.
// The texels are compared with the Wasm transcoder on a real GPU in tests/decoders-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBasisLZ, readETC1SSlice } from '../dist/etc1s.js';
import { readKTX2Index } from '../dist/ktx2-file.js';
import { KTX2GPUDecoder } from '../dist/ktx2-gpu.js';
import { uastcBlockValid, uastcMode } from '../dist/ktx2-gpu-shaders.js';
import { fixture } from './support/ktx2.js';

const device = { limits: { maxTextureDimension2D: 8192, maxStorageBufferBindingSize: 1 << 27 } };

async function etc1s() {
  const bytes = await fixture('cube-etc1s.ktx2'),
    index = readKTX2Index(bytes),
    global = bytes.subarray(index.globalData.offset, index.globalData.offset + index.globalData.length);
  return { bytes, index, global };
}

test('the ETC1S reader turns a real file into codebook indices in range', async () => {
  const { bytes, index, global } = await etc1s(),
    images = index.levels.length * 6,
    tables = readBasisLZ(global, images),
    { offset, length } = index.levels[0],
    image = tables.images[0],
    blocks = 16 * 16,
    out = new Uint32Array(blocks);
  assert.equal(tables.images.length, images);
  readETC1SSlice(tables, bytes.subarray(offset, offset + length).subarray(image.rgbAt, image.rgbAt + image.rgbLength), 16, 16, out);
  assert.ok(new Set(out).size > 8, 'the blocks of a real picture differ');
  assert.ok(tables.endpoints.length > 0 && tables.selectors.length > 0);
});

test('damaged BasisLZ tables and streams are refused with a code', async () => {
  const { bytes, index, global } = await etc1s(),
    tables = readBasisLZ(global, index.levels.length * 6),
    image = tables.images[0],
    { offset } = index.levels[0],
    slice = bytes.subarray(offset + image.rgbAt, offset + image.rgbAt + image.rgbLength);
  assert.throws(() => readBasisLZ(global.subarray(0, 10), 1), { code: 'failed', message: /global data is damaged/ });
  assert.throws(() => readBasisLZ(global.subarray(0, 100), 42), { code: 'failed' });
  assert.throws(() => readETC1SSlice(tables, slice.subarray(0, 3), 16, 16, new Uint32Array(256)), { code: 'failed' });
});

test('texture video is refused: its frames depend on each other', async () => {
  const { global } = await etc1s(),
    video = global.slice();
  video[20] |= 2;
  assert.throws(() => readBasisLZ(video, 42), /texture video/);
});

test('the first byte of a block can name the reserved mode, which createTexture checks for', () => {
  const modes = new Set();
  for (let byte = 0; byte < 256; byte++) modes.add(uastcMode(byte));
  assert.ok(modes.has(19), 'mode 19 is reachable from the first byte');
});

test('a file that holds no Basis data, and a call with no device', async () => {
  assert.throws(() => new KTX2GPUDecoder({}), /needs a device/);
  const decoder = new KTX2GPUDecoder({ device });
  await assert.rejects(decoder.createTexture(await fixture('cube-native-zstd.ktx2')), /holds a GPU format/);
  await assert.rejects(decoder.createTexture(new Uint8Array(10)), /truncated header/);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(
    decoder.createTexture(await fixture('cube-etc1s.ktx2'), { signal: controller.signal }),
    /stop/,
  );
});

test('a file with more layers than the device allows is refused before any texture is made', async () => {
  // cube-etc1s.ktx2 is a cube: 6 layers. A device that takes 4 cannot hold it; createTexture used to make an invalid
  // texture (a validation error, no throw).
  let created = 0;
  const small = {
    limits: { ...device.limits, maxTextureArrayLayers: 4 },
    createTexture: () => created++,
    createComputePipelineAsync: async () => ({}),
    createShaderModule: () => ({}),
  };
  await assert.rejects(
    new KTX2GPUDecoder({ device: small }).createTexture(await fixture('cube-etc1s.ktx2')),
    (error) => error instanceof RangeError && /6 layers exceeds the device's maxTextureArrayLayers/.test(error.message),
  );
  assert.equal(created, 0);
});

test('a UASTC block whose partition pattern is past its mode table is refused, as the reserved mode is', async () => {
  // The PAT field has room for 32 patterns (16 in mode 3), the specification defines 30 two-subset patterns, 11
  // three-subset ones (mode 3) and 19 for mode 7; the shader read a neighbouring table for the rest.
  const block = (first, pattern) => {
    const bytes = new Uint8Array(16);
    bytes[0] = first;
    const field = uastcMode(first) === 9 ? 28 : 20;
    bytes[field >> 3] |= (pattern << (field & 7)) & 255;
    bytes[(field >> 3) + 1] |= pattern >> (8 - (field & 7));
    return bytes;
  };
  // First bytes naming modes 2 (0x1d), 3, 4 (0x13), 7 and 9 (0x0f): the last valid pattern, then the first invalid one.
  for (const [byte, mode, count] of [
    [0x1d, 2, 30],
    [0x03, 3, 11],
    [0x13, 4, 30],
    [0x07, 7, 19],
    [0x0f, 9, 30],
  ]) {
    assert.equal(uastcMode(byte), mode);
    assert.equal(uastcBlockValid(block(byte, count - 1), 0), true, `mode ${mode} pattern ${count - 1}`);
    assert.equal(uastcBlockValid(block(byte, count), 0), false, `mode ${mode} pattern ${count}`);
  }
  const bytes = (await fixture('array-uastc.ktx2')).slice(),
    { offset } = readKTX2Index(bytes).levels[0];
  bytes.set(block(0x07, 31), offset);
  globalThis.GPUTextureUsage ??= { TEXTURE_BINDING: 4, COPY_DST: 2 };
  let destroyed = 0;
  const mock = {
    limits: { ...device.limits, maxTextureArrayLayers: 256 },
    createTexture: () => ({ destroy: () => destroyed++ }),
    createComputePipelineAsync: async () => ({}),
    createShaderModule: () => ({}),
  };
  await assert.rejects(new KTX2GPUDecoder({ device: mock }).createTexture(bytes), /reserved mode or partition pattern/);
  assert.equal(destroyed, 1, 'the texture made for it is released');
});
