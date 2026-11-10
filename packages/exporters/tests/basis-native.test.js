import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { encodeKTX2 } from '@margoengine/exporters/ktx2';
import { encodeBasisLZ, packKTX2 } from '../dist/basis-wire.js';
import { transcodeKTX2 } from '../../decoders/dist/codec.js';
import { basis } from '../../decoders/tests/support/ktx2.js';
import { loadNativeBasis } from '../dist/basis-native.js';

const module = await basis(),
  pixels = (bytes) => transcodeKTX2(module, bytes, 'rgba8'),
  api = await loadNativeBasis(new URL('../dist/basis-encoder/margo_basis_encoder.wasm', import.meta.url));
const image = (width, height, make) => ({
  width,
  height,
  data: Uint8Array.from({ length: width * height * 4 }, (_, i) => make(i >> 2)[i & 3]),
});

test('BasisLZ sends a usable selector history, alpha slices and every NPOT mip to the independent transcoder', async () => {
  const input = image(13, 9, (t) => [40 + (t % 4), 90, 160, 90]),
    file = await encodeKTX2(input, { mode: 'etc1s' }),
    result = pixels(file);
  assert.equal(result.hasAlpha, true);
  assert.deepEqual(
    result.mipmaps.map((mip) => [mip.width, mip.height]),
    [
      [13, 9],
      [6, 4],
      [3, 2],
      [1, 1],
    ],
  );
  for (const mip of result.mipmaps)
    for (let i = 3; i < mip.data.length; i += 4) assert.ok(Math.abs(mip.data[i] - 90) <= 5);
});

test('BasisLZ Huffman code-length alphabets fit their three-bit fields on varied codebooks', () => {
  let state = 0x71422;
  const next = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    },
    width = 128,
    height = 128,
    blocks = (width * height) / 16,
    fitted = new Uint8Array(blocks * 8),
    view = new DataView(fitted.buffer);
  for (let i = 0; i < blocks; i++) {
    const endpoint = i < 700 ? i % 3 : next() % 131;
    fitted.set([endpoint & 31, (endpoint >> 2) & 31, (endpoint >> 1) & 31, endpoint & 7], i * 8);
    view.setUint32(i * 8 + 4, next(), true);
  }
  const { levels, global } = encodeBasisLZ([fitted], [[width, height]], false),
    result = pixels(packKTX2(width, height, levels, 'etc1s', false, false, global));
  assert.equal(result.mipmaps[0].data.length, width * height * 4);
});

test('ETC1S quality changes the actual shared palette budget and reconstructed result', async () => {
  const input = image(32, 32, (t) => [(t * 13 + (t >> 4) * 17) & 255, (t * 31) & 255, (t * 41) & 255, 255]),
    low = await encodeKTX2(input, { quality: 1, mipmaps: false }),
    high = await encodeKTX2(input, { quality: 255, mipmaps: false });
  const error = (decoded) =>
    decoded.reduce((sum, value, i) => sum + ((i & 3) === 3 ? 0 : (value - input.data[i]) ** 2), 0);
  assert.ok(low.length < high.length);
  assert.ok(error(pixels(high).mipmaps[0].data) < error(pixels(low).mipmaps[0].data));
});

test('sRGB UASTC preserves chromatic detail under equal-channel reconstruction error', async () => {
  const input = image(8, 8, (t) => [
      (31 + t * 13 + (t >> 3) * 3) % 256,
      (31 + t * 7 + (t >> 3) * 11) % 256,
      (31 + t * 29 + (t >> 3) * 5) % 256,
      255,
    ]),
    decoded = pixels(await encodeKTX2(input, { mode: 'uastc', mipmaps: false })).mipmaps[0].data;
  // The former luma-weighted search spends over 97,000 RGB squared-error
  // units on this independent chromatic pattern. Equal RGB fitting is below
  // 80,000 without changing the block format, level, alpha or transfer metadata.
  let error = 0;
  for (let i = 0; i < decoded.length; i++) {
    if ((i & 3) === 3) assert.equal(decoded[i], 255);
    else error += (decoded[i] - input.data[i]) ** 2;
  }
  assert.ok(error < 80000, `RGB squared error ${error}`);
});

test('UASTC mips filter sRGB in linear light and renormalize tangent-space vectors', async () => {
  const contrast = image(2, 1, (t) => [t * 255, t * 255, t * 255, 255]),
    srgb = pixels(await encodeKTX2(contrast, { mode: 'uastc' })).mipmaps[1],
    linear = pixels(await encodeKTX2(contrast, { mode: 'uastc', colorSpace: 'linear' })).mipmaps[1];
  assert.deepEqual([...srgb.data], [188, 188, 188, 255]);
  assert.deepEqual([...linear.data], [128, 128, 128, 255]);
  const normals = image(2, 1, (t) => (t ? [128, 255, 128, 255] : [255, 128, 128, 255])),
    decoded = pixels(await encodeKTX2(normals, { mode: 'uastc', normalMap: true })).mipmaps[1].data,
    vector = [...decoded.subarray(0, 3)].map((value) => value / 127.5 - 1);
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.01);
  assert.ok(vector[0] > 0.7 && vector[1] > 0.7);
});

test('clean-room Zstandard uses real matches and interoperates across frame and block boundaries', () => {
  for (const length of [0, 31, 4096, 131072, 131073, 300000]) {
    const input = Uint8Array.from({ length }, (_, i) => i % 37),
      capacity = input.length * 2 + 65536,
      source = api.allocate(input.length),
      output = api.allocate(capacity);
    try {
      new Uint8Array(api.memory.buffer, source, input.length).set(input);
      const size = api.encode_zstd(source, input.length, output, capacity);
      assert.ok(size > 0);
      const encoded = new Uint8Array(api.memory.buffer, output, size).slice();
      assert.deepEqual(new Uint8Array(zstdDecompressSync(encoded)), input);
      if (length > 4096) assert.ok(size < input.length / 10);
    } finally {
      api.release(source, input.length);
      api.release(output, capacity);
    }
  }
});

test('the bundled encoder is the reproducible native artifact rather than the optional external module', () => {
  const bundled = readFileSync(new URL('../dist/basis-encoder/margo_basis_encoder.wasm', import.meta.url)),
    artifact = readFileSync(new URL('../native/basis/margo_basis_encoder.wasm', import.meta.url));
  assert.deepEqual(bundled, artifact);
});

test('encoderPath preserves the explicit external-module compatibility route', async () => {
  const input = image(4, 4, () => [72, 143, 208, 255]),
    expected = await encodeKTX2(input, { mode: 'uastc', mipmaps: false }),
    prefix = fileURLToPath(new URL('../.basis-override-', import.meta.url)),
    folder = mkdtempSync(prefix),
    at = (name) => new URL(name, pathToFileURL(folder + '/'));
  try {
    writeFileSync(at('package.json'), '{"type":"commonjs"}');
    // Own mock of the public factory contract. No vendor wrapper is copied.
    writeFileSync(
      at('basis_encoder.js'),
      `module.exports = () => Promise.resolve({ initializeBasis() {}, BasisEncoder: class {
      constructor() { return new Proxy(this, { get: (target, name) => name in target ? target[name] : () => {} }); }
      encode(output) { const bytes = new Uint8Array(${JSON.stringify([...expected])}); output.set(bytes); return bytes.length; }
      delete() {}
    } });`,
    );
    writeFileSync(at('basis_encoder.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    assert.deepEqual(
      await encodeKTX2(input, { mode: 'uastc', mipmaps: false, encoderPath: pathToFileURL(folder + '/').href }),
      expected,
    );
  } finally {
    assert.ok(folder.startsWith(prefix));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('BasisLZ endpoint relabelling reduces the actual contextual payload and preserves reconstructed texels', () => {
  const width = 256,
    height = 128,
    count = (width * height) / 16,
    data = new Uint8Array(count * 8),
    view = new DataView(data.buffer),
    expected = new Uint8Array(width * height * 4),
    deltas = [
      [-8, -2, 2, 8],
      [-17, -5, 5, 17],
      [-29, -9, 9, 29],
      [-42, -13, 13, 42],
      [-60, -18, 18, 60],
      [-80, -24, 24, 80],
      [-106, -33, 33, 106],
      [-183, -47, 47, 183],
    ];
  for (let block = 0; block < count; block++) {
    const e = (block * 73) % 251,
      endpoint = [e & 31, (e >>> 3) & 31, (e >>> 5) & 31, (e >>> 4) & 7],
      selectors = ((block % 17) * 0x12492492) >>> 0;
    data.set(endpoint, block * 8);
    view.setUint32(block * 8 + 4, selectors, true);
    for (let t = 0; t < 16; t++) {
      const x = (block % (width / 4)) * 4 + (t & 3),
        y = Math.floor(block / (width / 4)) * 4 + (t >> 2),
        at = (y * width + x) * 4;
      for (let c = 0; c < 3; c++)
        expected[at + c] = Math.max(
          0,
          Math.min(255, ((endpoint[c] << 3) | (endpoint[c] >> 2)) + deltas[endpoint[3]][(selectors >>> (t * 2)) & 3]),
        );
      expected[at + 3] = 255;
    }
  }
  const { levels, global } = encodeBasisLZ([data], [[width, height]], false);
  // The original first-use index ordering spends 1611 payload bytes on this
  // spatially varied stream. Include codebooks, all model headers and slices.
  assert.ok(global.length + levels[0].data.length < 1611);
  const file = packKTX2(width, height, levels, 'etc1s', false, false, global);
  assert.deepEqual(pixels(file).mipmaps[0].data, expected);
});

test('BasisLZ codebook limits tell callers how to reduce the input', () => {
  const count = 16129,
    fitted = new Uint8Array(count * 8);
  for (let i = 0; i < count; i++) fitted.set([i & 31, (i >> 5) & 31, (i >> 10) & 31, 0], i * 8);
  assert.throws(() => encodeBasisLZ([fitted], [[count * 4, 4]], false), {
    name: 'RangeError',
    message: /16128 entries; reduce quality or split the image/,
  });
});
