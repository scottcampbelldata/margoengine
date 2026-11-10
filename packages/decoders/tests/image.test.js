// decodeBC, textureFileToRGBA and decodeImage. BC blocks come from Pillow's test files with the pixels of the PNG beside
// each one (fixtures/bc/vectors.json), so the expected colours are an outside reader's, not this package's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBC, halfToFloat, linearToByte, signedByte } from '../dist/bc.js';
import { decodeImage, imageFormat, nodeKTX2, textureFileToRGBA } from '../dist/image.js';
import { decodePNG } from '../dist/png.js';
import { dds } from './support/texture-encoders.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url))),
  vectors = JSON.parse(readFileSync(new URL('fixtures/bc/vectors.json', import.meta.url))),
  bytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex')),
  linear = (v) => {
    const c = v / 255;
    return 255 * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  };

for (const format of new Set(vectors.map((v) => v.format)))
  test(`${format} blocks give the colours of Pillow's PNG`, () => {
    for (const { block, pixels, file } of vectors.filter((v) => v.format === format)) {
      const { data } = decodeBC(format, bytes(block), 4, 4),
        expected = bytes(pixels),
        hdr = format.startsWith('bc6h'),
        limit = format.startsWith('bc7') ? 0 : hdr ? 2.1 : 1;
      for (let i = 0; i < 64; i++) {
        // Float BC6H comes out sRGB encoded; Pillow's PNG holds the linear value in a byte.
        const ours = hdr && (i & 3) < 3 ? linear(data[i]) : data[i];
        assert.ok(Math.abs(ours - expected[i]) <= limit, `${file} byte ${i}: ${ours} against ${expected[i]}`);
      }
    }
  });

test('every BC format has a vector or a hand-made block', () => {
  // BC1: color 0 white above color 1, every index picks color 0.
  const white = new Uint8Array([0xff, 0xff, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...decodeBC('bc1-rgba-unorm', white, 4, 4).data.subarray(0, 4)], [255, 255, 255, 255]);
  const bc4 = new Uint8Array(8);
  bc4[0] = 200;
  bc4[1] = 100;
  assert.deepEqual([...decodeBC('bc4-r-unorm', bc4, 4, 4).data.subarray(0, 4)], [200, 0, 0, 255]);
  const signed = new Uint8Array(8);
  signed[0] = 0x81; // -127
  signed[1] = 0x81;
  assert.deepEqual([...decodeBC('bc4-r-snorm', signed, 4, 4).data.subarray(0, 4)], [0, 128, 128, 255]);
  assert.throws(() => decodeBC('bc1-rgba-unorm', new Uint8Array(7), 4, 4), (e) => e.code === 'failed');
});

test('a size that is no multiple of four crops the last blocks', () => {
  const { width, height, data } = decodeBC('bc1-rgba-unorm', new Uint8Array(16), 5, 3);
  assert.deepEqual([width, height, data.length], [5, 3, 60]);
});

test('byte helpers', () => {
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xc000), -2);
  assert.equal(linearToByte(1), 255);
  assert.equal(linearToByte(-1), 0);
  assert.equal(linearToByte(9), 255);
  assert.equal(signedByte(127), 255);
  assert.equal(signedByte(-128), 0);
});

test('imageFormat names a file by its first bytes', () => {
  assert.equal(imageFormat(fixture('webp/lossy.webp')), 'webp');
  assert.equal(imageFormat(fixture('Dot_C.ktx2')), 'ktx2');
  assert.equal(imageFormat(fixture('webp/dwebp/lossy.png')), 'png');
  assert.equal(imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'jpeg');
  assert.equal(imageFormat(new TextEncoder().encode('DDS |')), 'dds');
  assert.equal(imageFormat(new TextEncoder().encode('\0\0\0\x1cftypavif')), 'avif');
  assert.equal(imageFormat(new Uint8Array(16)), undefined);
});

test('decodeImage reads WebP and PNG', async () => {
  const webp = await decodeImage(fixture('webp/lossless.webp')),
    png = await decodeImage(fixture('webp/dwebp/lossless.png'));
  assert.deepEqual(webp.data, png.data);
});

test('decodeImage reads a DDS file through its blocks', async () => {
  const block = new Uint8Array([0xff, 0xff, 0, 0, 0, 0, 0, 0]),
    file = dds({ width: 4, height: 4, fourCC: 'DXT1', data: block }),
    image = await decodeImage(file);
  assert.deepEqual([image.width, image.height], [4, 4]);
  assert.deepEqual([...image.data.subarray(0, 4)], [255, 255, 255, 255]);
});

test('decodeImage transcodes Basis Universal KTX2 in Node, which has no Worker', async () => {
  assert.equal(typeof Worker, 'undefined');
  const color = await decodeImage(fixture('Dot_C.ktx2')),
    normal = await decodeImage(fixture('Rib_N.ktx2'));
  assert.deepEqual([color.width, color.height, color.data.length], [128, 128, 128 * 128 * 4]);
  assert.deepEqual([normal.width, normal.height, normal.data.length], [32, 32, 32 * 32 * 4]);
  const mean = ({ data }, channel) => {
    let sum = 0;
    for (let i = channel; i < data.length; i += 4) sum += data[i];
    return sum / (data.length / 4);
  };
  assert.equal(new Set(color.data).size, 2, 'dots of two levels');
  assert.ok(Math.abs(mean(color, 0) - 154) < 1);
  assert.ok(mean(normal, 2) > 240 && Math.abs(mean(normal, 0) - 128) < 2, 'a normal map points out of the surface');
});

test('nodeKTX2 gives every mip level, and is what loadGLTF takes as ktx2', async () => {
  const result = await nodeKTX2.transcode(fixture('Dot_C.ktx2'));
  assert.equal(result.mipmaps.length, 8);
  assert.deepEqual([result.mipmaps[7].width, result.mipmaps[7].height], [1, 1]);
});

test('decodeImage stops on an aborted signal', async () => {
  const controller = new AbortController();
  controller.abort(new RangeError('stop'));
  await assert.rejects(decodeImage(fixture('Dot_C.ktx2'), { signal: controller.signal }), /stop/);
});

test('decodeImage refuses what it cannot read, by name', async () => {
  await assert.rejects(decodeImage(new Uint8Array(16)), (e) => e.code === 'failed');
  await assert.rejects(decodeImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), (e) => e.code === 'failed');
  await assert.rejects(decodeImage(new TextEncoder().encode('\0\0\0\x1cftypavif')), (e) => e.code === 'unsupported');
  await assert.rejects(decodeImage('a.webp'), TypeError);
});

test('textureFileToRGBA unpacks plain formats and refuses ETC and ASTC', async () => {
  const of = (format, width, height, data) => ({ format, mipmaps: [{ width, height, data }] }),
    rgba = async (format, data) => [...(await textureFileToRGBA(of(format, 1, 1, data))).data];
  assert.deepEqual(await rgba('rgba8unorm', new Uint8Array([1, 2, 3, 4])), [1, 2, 3, 4]);
  assert.deepEqual(await rgba('bgra8unorm', new Uint8Array([1, 2, 3, 4])), [3, 2, 1, 4]);
  assert.deepEqual(await rgba('r8unorm', new Uint8Array([9])), [9, 0, 0, 255]);
  assert.deepEqual(await rgba('rg8unorm', new Uint8Array([9, 8])), [9, 8, 0, 255]);
  assert.deepEqual(await rgba('rg8snorm', new Uint8Array([127, 0x81])), [255, 0, 128, 255]);
  assert.deepEqual(await rgba('rgba32float', new Uint8Array(new Float32Array([1, 0, 0, 0.5]).buffer)), [255, 0, 0, 128]);
  assert.deepEqual(await rgba('rgba16float', new Uint8Array(new Uint16Array([0x3c00, 0, 0, 0x3c00]).buffer)), [255, 0, 0, 255]);
  assert.deepEqual(await rgba('rgb10a2unorm', new Uint8Array(new Uint32Array([1023 | (3 << 30)]).buffer)), [255, 0, 0, 255]);
  await assert.rejects(textureFileToRGBA(of('etc2-rgb8unorm', 4, 4, new Uint8Array(8))), (e) => e.code === 'unsupported');
  await assert.rejects(textureFileToRGBA(of('astc-4x4-unorm', 4, 4, new Uint8Array(16))), (e) => e.code === 'unsupported');
});

test('the reference PNGs read', () => {
  assert.equal(decodePNG(fixture('webp/dwebp/lossy.png')).width, 97);
});
