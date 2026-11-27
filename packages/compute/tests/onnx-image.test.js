// ai.onnx ImageDecoder (opset 20) against images written here from their format specifications, so every expected pixel
// is known: PNG (ISO/IEC 15948), BMP (Windows DIB), TIFF 6.0, Netpbm and lossless JPEG (ITU-T T.81 Annex H).
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { loadOnnx, OnnxTensor } from '../dist/onnx.js';
import { tiff } from '../../decoders/tests/support/texture-encoders.js';
import { encodeLossless } from '../../decoders/tests/support/jpeg-lossless-encoder.js';
import * as p from './onnx-fixtures.js';

async function decode(bytes, format, version = 20, attrs = []) {
  const info = (name) => p.field(1, name);
  if (format) attrs = [p.attr('pixel_format', format), ...attrs];
  using model = await loadOnnx(
    p.model(p.graph([p.node('ImageDecoder', ['x'], ['y'], attrs)], [info('x')], [info('y')]), version),
  );
  const persistentBytes = model.work.liveBytes;
  const result = await model.run({ x: new OnnxTensor('uint8', bytes, [bytes.length]) });
  assert.equal(model.work.liveBytes, persistentBytes);
  assert.equal(result.y.dtype, 'uint8');
  return result.y;
}

// A 2 x 2 picture: red, green / blue, a mixed colour.
const rgb = [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 200, 90];
const bgr = [0, 0, 255, 0, 255, 0, 255, 0, 0, 90, 200, 10];
// BT.601 luma of those four colours, rounded: .299 R + .587 G + .114 B.
const grey = [76, 150, 29, 131];

const word = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function png() {
  const chunk = (type, data) => {
    const body = [...new TextEncoder().encode(type), ...data];
    return [...word(data.length), ...body, ...word(crc32(Uint8Array.from(body)))];
  };
  const rows = [0, ...rgb.slice(0, 6), 0, ...rgb.slice(6)];
  return Uint8Array.from([
    ...[137, 80, 78, 71, 13, 10, 26, 10],
    ...chunk('IHDR', [...word(2), ...word(2), 8, 2, 0, 0, 0]),
    ...chunk('IDAT', [...deflateSync(Uint8Array.from(rows))]),
    ...chunk('IEND', []),
  ]);
}
function bmp() {
  const bytes = new Uint8Array(54 + 16),
    view = new DataView(bytes.buffer);
  bytes.set([66, 77]);
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 2, true);
  view.setInt32(22, -2, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  bytes.set(bgr.slice(0, 6), 54);
  bytes.set(bgr.slice(6), 62);
  return bytes;
}
/**
 * The same 2 x 2 RGB image as a BigTIFF (libtiff, "The BigTIFF File Format"): version 43, 8-byte offsets, 20-byte
 * entries, and the strip's offset and length as LONG8 (type 16). `little` picks the byte order.
 */
function bigTIFF(little) {
  const entries = [
      [256, 3, 1, 2],
      [257, 3, 1, 2],
      [258, 3, 3, [8, 8, 8]],
      [259, 3, 1, 1],
      [262, 3, 1, 2],
      [273, 16, 1, 0],
      [277, 3, 1, 3],
      [278, 3, 1, 2],
      [279, 16, 1, rgb.length],
    ],
    ifd = 16,
    pixels = ifd + 8 + entries.length * 20 + 8,
    bytes = new Uint8Array(pixels + rgb.length),
    view = new DataView(bytes.buffer);
  bytes.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 43, little);
  view.setUint16(4, 8, little);
  view.setBigUint64(8, BigInt(ifd), little);
  view.setBigUint64(ifd, BigInt(entries.length), little);
  entries.forEach(([tag, type, count, value], i) => {
    const at = ifd + 8 + i * 20;
    view.setUint16(at, tag, little);
    view.setUint16(at + 2, type, little);
    view.setBigUint64(at + 4, BigInt(count), little);
    if (type === 16) view.setBigUint64(at + 12, BigInt(tag === 273 ? pixels : value), little);
    // Three SHORTs fit the 8-byte value field.
    else [value].flat().forEach((v, k) => view.setUint16(at + 12 + k * 2, v, little));
  });
  bytes.set(rgb, pixels);
  return bytes;
}
const channel = (c) => [0, 1, 2, 3].map((i) => rgb[i * 3 + c]);
const files = {
  png: png(),
  bmp: bmp(),
  tiff: tiff({ width: 2, height: 2, spp: 3, bits: 8, photometric: 2, samples: rgb }),
  BigTIFF: bigTIFF(true),
  'big-endian BigTIFF': bigTIFF(false),
  'float tiff': tiff({
    ...{ width: 2, height: 2, spp: 3, bits: 32, float: true, photometric: 2 },
    samples: rgb.map((v) => v / 255),
  }),
  ppm: Uint8Array.from([...new TextEncoder().encode('P6 2 2 255\n'), ...rgb]),
  jpeg: encodeLossless({
    width: 2,
    height: 2,
    precision: 8,
    components: [0, 1, 2].map((c) => ({ samples: channel(c) })),
  }),
};

for (const [name, bytes] of Object.entries(files))
  test(`ImageDecoder reads ${name} as RGB, BGR and Grayscale`, async () => {
    for (const [format, expected] of [
      [undefined, rgb],
      ['RGB', rgb],
      ['BGR', bgr],
      ['Grayscale', grey],
    ]) {
      const image = await decode(bytes, format);
      assert.deepEqual(image.shape, [2, 2, expected.length / 4]);
      assert.deepEqual([...image.data], expected, `${name} ${format}`);
    }
  });

test('ImageDecoder reads WebP: the same pixels as the decoders reader, alpha dropped', async () => {
  const { readFile } = await import('node:fs/promises');
  const { parseWebP } = await import('@margoengine/decoders/webp');
  const bytes = new Uint8Array(
    await readFile(new URL('../../decoders/tests/fixtures/webp/lossy.webp', import.meta.url)),
  );
  const expected = parseWebP(bytes);
  const image = await decode(bytes, 'RGB');
  assert.deepEqual(image.shape, [83, 97, 3]);
  assert.deepEqual(Buffer.from(image.data), Buffer.from(expected.data.filter((_, i) => i % 4 !== 3)));
});

test('ImageDecoder reads JPEG 2000, a raw codestream and a JP2 file', async () => {
  // A 3 x 2 grey codestream of 8 bits (Rec. ITU-T T.800 Annex A) whose one packet is empty: every sample is 128.
  const stream = [
    ...[0xff, 0x4f],
    ...[0xff, 0x51, 0, 41, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 2],
    ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 7, 1, 1],
    ...[0xff, 0x52, 0, 12, 0, 0, 0, 1, 0, 0, 4, 4, 0, 1],
    ...[0xff, 0x5c, 0, 4, 0x20, 0x40],
    ...[0xff, 0x90, 0, 10, 0, 0, 0, 0, 0, 15, 0, 1, 0xff, 0x93, 0],
    ...[0xff, 0xd9],
  ];
  const box = (type, body) => [0, 0, 0, body.length + 8, ...new TextEncoder().encode(type), ...body];
  const jp2 = [
    ...box('jP  ', [0x0d, 0x0a, 0x87, 0x0a]),
    ...box('ftyp', [...new TextEncoder().encode('jp2 \0\0\0\0jp2 ')]),
    ...box('jp2h', box('colr', [1, 0, 0, 0, 0, 0, 17])),
    ...box('jp2c', stream),
  ];
  for (const bytes of [stream, jp2]) {
    const image = await decode(Uint8Array.from(bytes), 'BGR');
    assert.deepEqual(image.shape, [2, 3, 3]);
    assert.deepEqual([...image.data], new Array(18).fill(128));
    // A cut header gives the empty matrix, like every other damaged stream.
    assert.deepEqual((await decode(Uint8Array.from(bytes.slice(0, 20)))).shape, [0, 0, 3]);
  }
});

test('ImageDecoder reads a BigTIFF tifffile wrote, 16-bit samples scaled to bytes', async () => {
  const { readFile } = await import('node:fs/promises');
  const bytes = new Uint8Array(
    await readFile(
      new URL('../../decoders/tests/fixtures/tiff-scientific/big-le-uint16-lzw-tile.tif', import.meta.url),
    ),
  );
  const image = await decode(bytes, 'Grayscale');
  assert.deepEqual(image.shape, [19, 21, 1]);
  // The first page as the fixture was written: pixel i holds (i * 31 + 50000) modulo 2^16.
  assert.deepEqual(
    [...image.data],
    Array.from({ length: 19 * 21 }, (_, i) => Math.round((((i * 31 + 50000) % 65536) * 255) / 65535)),
  );
});

test('ImageDecoder gives an empty matrix for a stream it cannot decode', async () => {
  const damaged = [
    new Uint8Array(0),
    new TextEncoder().encode('not an image'),
    ...Object.values(files).map((bytes) => bytes.slice(0, 20)),
    new TextEncoder().encode('RIFF....WEBPVP8L'),
  ];
  for (const bytes of damaged) {
    const image = await decode(bytes);
    assert.deepEqual(image.shape, [0, 0, 3]);
    assert.equal(image.data.length, 0);
  }
  assert.deepEqual((await decode(damaged[1], 'Grayscale')).shape, [0, 0, 1]);
});

test('ImageDecoder refuses bad attributes, types and old opsets', async () => {
  await assert.rejects(decode(files.png, 'rgb'), /pixel_format/);
  await assert.rejects(decode(files.png, 'RGB', 20, [p.attr('extra', 1)]), /pixel_format/);
  await assert.rejects(decode(files.png, 'RGB', 19), /ImageDecoder/);
  const info = (name) => p.field(1, name);
  using model = await loadOnnx(p.model(p.graph([p.node('ImageDecoder', ['x'], ['y'])], [info('x')], [info('y')]), 20));
  await assert.rejects(model.run({ x: new OnnxTensor('float32', new Float32Array(4), [4]) }), /uint8/);
});
