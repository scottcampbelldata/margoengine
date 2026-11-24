// ETC2 and EAC blocks, built bit by bit from the OpenGL ES 3.0 specification (appendix C), through textureFileToRGBA.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { textureFileToRGBA } from '../dist/image.js';

/** A 64-bit block from fields [msb, lsb, value] (bit 63 is the top of byte 0, as in the specification). */
const pack = (fields) => {
  let word = 0n;
  for (const [msb, lsb, value] of fields) {
    const width = BigInt(msb - lsb + 1);
    word |= (BigInt(value) & ((1n << width) - 1n)) << BigInt(lsb);
  }
  return Uint8Array.from({ length: 8 }, (_, i) => Number((word >> BigInt(56 - 8 * i)) & 255n));
};
const decode = async (format, data, width = 4, height = 4) =>
  (await textureFileToRGBA({ format, mipmaps: [{ width, height, data }] })).data;
const pixel = (data, x, y, width = 4) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

test('ETC2 individual mode: the specification example colour with its modifier, subblocks by the flip bit', async () => {
  // R1 14, G1 3, B1 8 is (238, 51, 136); the second subblock holds 0, 0, 0. Both tables are 2: [-29, -9, 9, 29].
  const block = (flip, lsbPlane, msbPlane) =>
    pack([
      [63, 60, 14],
      [59, 56, 0],
      [55, 52, 3],
      [51, 48, 0],
      [47, 44, 8],
      [43, 40, 0],
      [39, 37, 2],
      [36, 34, 2],
      [33, 33, 0],
      [32, 32, flip],
      [31, 16, msbPlane],
      [15, 0, lsbPlane],
    ]);
  // Selector 01 (+b = 29) for every pixel: 238 + 29 clamps to 255, 51 + 29 = 80, 136 + 29 = 165.
  const side = await decode('etc2-rgb8unorm', block(0, 0xffff, 0));
  assert.deepEqual(pixel(side, 0, 0), [255, 80, 165, 255]);
  assert.deepEqual(pixel(side, 1, 3), [255, 80, 165, 255]);
  assert.deepEqual(pixel(side, 2, 0), [29, 29, 29, 255], 'the second subblock is black plus 29');
  const stacked = await decode('etc2-rgb8unorm', block(1, 0xffff, 0));
  assert.deepEqual(pixel(stacked, 3, 1), [255, 80, 165, 255]);
  assert.deepEqual(pixel(stacked, 0, 2), [29, 29, 29, 255]);
  // Selector 11 is -b (-29): 238 - 29 = 209, 51 - 29 = 22, 136 - 29 = 107.
  const low = await decode('etc2-rgb8unorm', block(0, 0xffff, 0xffff));
  assert.deepEqual(pixel(low, 0, 0), [209, 22, 107, 255]);
});

test('ETC2 differential mode: R 28 with dR -4 gives 231 and 198, as the specification works it', async () => {
  const data = await decode(
    'etc2-rgb8unorm-srgb',
    pack([
      [63, 59, 28],
      [58, 56, 4],
      [55, 51, 4],
      [50, 48, 2],
      [47, 43, 3],
      [42, 40, 0],
      [39, 37, 0],
      [36, 34, 0],
      [33, 33, 1],
      [32, 32, 0],
      [31, 16, 0],
      [15, 0, 0],
    ]),
  );
  // Selector 00 is +a (+2 on table 0): bases (231, 33, 24) and (198, 49, 24).
  assert.deepEqual(pixel(data, 0, 0), [233, 35, 26, 255]);
  assert.deepEqual(pixel(data, 3, 3), [200, 51, 26, 255]);
});

test('ETC2 planar mode interpolates the three corners', async () => {
  // RO 4, GO 0, BO 31; the overflow of B + dB (31 + 3) selects planar. RH 60, GH 90, BH 0; RV 8, GV 127, BV 63.
  const ro = 4,
    rh = 60,
    bo = 31;
  const block = pack([
    [62, 57, ro],
    [56, 56, 0],
    [54, 49, 0],
    [48, 48, 0],
    [47, 45, 7],
    [44, 43, 3],
    [41, 39, 7],
    [38, 34, rh >> 1],
    [33, 33, 1],
    [32, 32, rh & 1],
    [31, 25, 90],
    [24, 19, 0],
    [18, 13, 8],
    [12, 6, 127],
    [5, 0, 63],
  ]);
  const data = await decode('etc2-rgb8unorm', block);
  const x6 = (v) => (v << 2) | (v >> 4),
    x7 = (v) => (v << 1) | (v >> 6);
  const expect = (x, y) =>
    [
      (x * (x6(rh) - x6(ro)) + y * (x6(8) - x6(ro)) + 4 * x6(ro) + 2) >> 2,
      (x * (x7(90) - x7(0)) + y * (x7(127) - x7(0)) + 4 * x7(0) + 2) >> 2,
      (x * (x6(0) - x6(bo)) + y * (x6(63) - x6(bo)) + 4 * x6(bo) + 2) >> 2,
    ].map((v) => Math.min(255, Math.max(0, v)));
  assert.deepEqual(pixel(data, 0, 0), [...expect(0, 0), 255]);
  assert.deepEqual(pixel(data, 3, 2), [...expect(3, 2), 255]);
  assert.deepEqual(pixel(data, 1, 3), [...expect(1, 3), 255]);
});

test('ETC2 T mode: paint colour 0 is base 1 and the others move base 2 by the distance', async () => {
  // The unused bits are set so R + dR overflows: R = 28 + R1a, dR = R1b (bit 58 clear).
  const block = (selector) =>
    pack([
      [63, 61, 7],
      [60, 59, 3],
      [58, 58, 0],
      [57, 56, 1],
      [55, 52, 2],
      [51, 48, 4],
      [47, 44, 6],
      [43, 40, 8],
      [39, 36, 10],
      [35, 34, 2],
      [33, 33, 1],
      [32, 32, 1],
      [31, 16, selector >> 1 ? 0xffff : 0],
      [15, 0, selector & 1 ? 0xffff : 0],
    ]);
  const e = (v) => (v << 4) | v,
    r1 = 3 * 4 + 1,
    g1 = 2,
    b1 = 4,
    r2 = 6,
    g2 = 8,
    b2 = 10,
    d = 32; // da 10, db 1: index 101 is 32
  const colour = async (selector) => pixel(await decode('etc2-rgb8unorm', block(selector)), 0, 0);
  assert.deepEqual(await colour(0), [e(r1), e(g1), e(b1), 255]);
  assert.deepEqual(await colour(1), [e(r2) + d, e(g2) + d, e(b2) + d, 255]);
  assert.deepEqual(await colour(2), [e(r2), e(g2), e(b2), 255]);
  assert.deepEqual(await colour(3), [e(r2) - d, e(g2) - d, e(b2) - d, 255]);
});

test('ETC2 punch-through: selector 10 with the opaque bit clear is transparent black', async () => {
  const block = (opaque) =>
    pack([
      [63, 59, 10],
      [58, 56, 0],
      [55, 51, 10],
      [50, 48, 0],
      [47, 43, 10],
      [42, 40, 0],
      [39, 37, 2],
      [36, 34, 2],
      [33, 33, opaque],
      [32, 32, 0],
      [31, 16, 0xffff],
      [15, 0, 0],
    ]);
  assert.deepEqual(pixel(await decode('etc2-rgb8a1unorm', block(0)), 0, 0), [0, 0, 0, 0]);
  const solid = pixel(await decode('etc2-rgb8a1unorm', block(1)), 0, 0);
  // Opaque: selector 10 is -a (-9 on table 2) from the base 10 -> (10 << 3) | (10 >> 2) = 82.
  assert.deepEqual(solid, [73, 73, 73, 255]);
});

test('EAC R11 and the alpha of RGBA8 follow the specification examples', async () => {
  // Base 103, table 13, multiplier 2, selector 3 for pixel a: modifier -10 x 2.
  const eac = (base, multiplier, table, selectors) =>
    pack([
      [63, 56, base],
      [55, 52, multiplier],
      [51, 48, table],
      [47, 0, selectors],
    ]);
  const selectorA3 = 0b011n << 45n;
  const red = await decode('eac-r11unorm', eac(103, 2, 13, selectorA3));
  assert.deepEqual(pixel(red, 0, 0), [Math.round((668 * 255) / 2047), 0, 0, 255]); // 103 x 8 + 4 - 160 = 668
  const zero = await decode('eac-r11unorm', eac(103, 0, 13, selectorA3));
  assert.equal(pixel(zero, 0, 0)[0], Math.round((818 * 255) / 2047)); // multiplier 0 is 1/8: 828 - 10
  const signed = await decode('eac-r11snorm', eac(60, 2, 13, selectorA3));
  assert.deepEqual(pixel(signed, 0, 0), [Math.round(((320 + 1023) * 255) / 2046), 128, 128, 255]);
  const rg = new Uint8Array(16);
  rg.set(eac(103, 2, 13, selectorA3));
  rg.set(eac(255, 1, 0, 0n), 8);
  assert.equal(pixel(await decode('eac-rg11unorm', rg), 0, 0)[0], pixel(red, 0, 0)[0]);
  // RGBA8: 8 alpha bytes then the colour block; alpha 103 - 20 = 83, and a multiplier of 0 gives the base alone.
  const rgba = new Uint8Array(16);
  rgba.set(eac(103, 2, 13, selectorA3));
  assert.equal(pixel(await decode('etc2-rgba8unorm', rgba), 0, 0)[3], 83);
  rgba.set(eac(103, 0, 13, selectorA3));
  assert.equal(pixel(await decode('etc2-rgba8unorm', rgba), 0, 0)[3], 103);
});

test('partial blocks crop and short data fails by name', async () => {
  const data = await decode('eac-r11unorm', new Uint8Array(16), 5, 3);
  assert.equal(data.length, 5 * 3 * 4);
  await assert.rejects(decode('etc2-rgb8unorm', new Uint8Array(8), 8, 4), (e) => e.code === 'failed');
});

test('ETC2 H mode: both bases move by the distance, whose low bit compares the bases', async () => {
  const block = (selector) =>
    pack([
      [62, 59, 5],
      [58, 56, 1],
      [55, 53, 7],
      [52, 52, 1],
      [51, 51, 1],
      [49, 47, 2],
      [46, 43, 9],
      [42, 39, 2],
      [38, 35, 12],
      [34, 34, 1],
      [33, 33, 1],
      [32, 32, 0],
      [31, 16, selector >> 1 ? 0xffff : 0],
      [15, 0, selector & 1 ? 0xffff : 0],
    ]);
  const e = (v) => (v << 4) | v,
    colour = async (selector) => pixel(await decode('etc2-rgb8unorm', block(selector)), 2, 1);
  // Base 1 is (5, 3, 10) and base 2 is (9, 2, 12); base 1 is below base 2, so the low bit is 0: index 100 is 23.
  const d = 23;
  assert.deepEqual(await colour(0), [e(5) + d, e(3) + d, e(10) + d, 255]);
  assert.deepEqual(await colour(1), [e(5) - d, e(3) - d, e(10) - d, 255]);
  assert.deepEqual(await colour(2), [e(9) + d, e(2) + d, e(12) + d, 255]);
  assert.deepEqual(await colour(3), [e(9) - d, e(2) - d, e(12) - d, 255]);
});
