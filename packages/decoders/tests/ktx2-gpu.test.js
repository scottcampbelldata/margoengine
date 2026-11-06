// The CPU half of the GPU transcoder (@margoengine/decoders/ktx2-gpu): what it refuses, and the ETC1S reader on real files.
// The texels are compared with the Wasm transcoder on a real GPU in tests/decoders-browser.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readBasisLZ, readETC1SSlice } from '../dist/etc1s.js';
import { readKTX2Index } from '../dist/ktx2-file.js';
import { KTX2GPUDecoder } from '../dist/ktx2-gpu.js';
import { uastcMode } from '../dist/ktx2-gpu-shaders.js';
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
