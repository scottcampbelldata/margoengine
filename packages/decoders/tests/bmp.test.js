import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBMP } from '../dist/bmp.js';

export function bitmap({
  bits = 24,
  width = 2,
  height = 2,
  compression = 0,
  pixels = [0, 0, 255, 0, 255, 0, 0, 0, 255, 0, 0, 255, 255, 255, 0, 0],
  palette = [],
  masks = [],
  header = 40,
} = {}) {
  const offset = 14 + header + masks.length * 4 + palette.length,
    out = new Uint8Array(offset + pixels.length),
    v = new DataView(out.buffer);
  out.set([66, 77]);
  v.setUint32(2, out.length, true);
  v.setUint32(10, offset, true);
  v.setUint32(14, header, true);
  v.setInt32(18, width, true);
  v.setInt32(22, height, true);
  v.setUint16(26, 1, true);
  v.setUint16(28, bits, true);
  v.setUint32(30, compression, true);
  if (palette.length) v.setUint32(46, palette.length / 4, true);
  masks.forEach((m, i) => v.setUint32(54 + i * 4, m, true));
  out.set(palette, 14 + header + masks.length * 4);
  out.set(pixels, offset);
  return out;
}
test('BMP preserves top-down and bottom-up padded rows and ignores undefined RGB32 alpha', () => {
  const b = bitmap();
  assert.deepEqual([...parseBMP(b).data], [0, 0, 255, 255, 255, 255, 255, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  assert.deepEqual([...parseBMP(bitmap({ height: -1, width: 1, pixels: [3, 2, 1, 0] })).data], [1, 2, 3, 255]);
  assert.deepEqual([...parseBMP(bitmap({ bits: 32, height: 1, width: 1, pixels: [3, 2, 1, 0] })).data], [1, 2, 3, 255]);
});
test('BMP 565 and alpha bitfields, indexed 1/4/8 bits and OS2 header', () => {
  assert.deepEqual(
    [
      ...parseBMP(
        bitmap({ width: 1, height: 1, bits: 16, compression: 3, masks: [0xf800, 0x7e0, 31], pixels: [0, 0xf8, 0, 0] }),
      ).data,
    ],
    [255, 0, 0, 255],
  );
  assert.deepEqual(
    [
      ...parseBMP(
        bitmap({
          width: 1,
          height: 1,
          bits: 32,
          compression: 6,
          masks: [255, 65280, 16711680, 4278190080],
          pixels: [1, 2, 3, 128],
        }),
      ).data,
    ],
    [1, 2, 3, 128],
  );
  for (const bits of [1, 4, 8])
    assert.deepEqual(
      [
        ...parseBMP(
          bitmap({
            width: 1,
            height: 1,
            bits,
            palette: [0, 0, 0, 0, 3, 2, 1, 0],
            pixels: [bits === 1 ? 128 : bits === 4 ? 16 : 1, 0, 0, 0],
          }),
        ).data,
      ],
      [1, 2, 3, 255],
    );
  const os = new Uint8Array(30),
    v = new DataView(os.buffer);
  os.set([66, 77]);
  v.setUint32(10, 26, true);
  v.setUint32(14, 12, true);
  [1, 1, 1, 24].forEach((n, i) => v.setUint16(18 + i * 2, n, true));
  os.set([3, 2, 1, 0], 26);
  assert.deepEqual([...parseBMP(os).data], [1, 2, 3, 255]);
});
test('BMP RLE8 and RLE4 encoded/absolute runs, row escape and deltas', () => {
  const palette = [0, 0, 0, 0, 3, 2, 1, 0];
  for (const bits of [4, 8]) {
    const pixels =
      bits === 8
        ? [0, 3, 1, 0, 1, 0, 0, 0, 0, 2, 1, 0, 2, 1, 0, 1]
        : [0, 3, 0x10, 0x10, 0, 0, 0, 2, 1, 0, 2, 0x11, 0, 1];
    const image = parseBMP(bitmap({ bits, width: 3, height: 2, compression: bits === 8 ? 1 : 2, palette, pixels }));
    assert.deepEqual(
      [...image.data],
      [0, 0, 0, 255, 1, 2, 3, 255, 1, 2, 3, 255, 1, 2, 3, 255, 0, 0, 0, 255, 1, 2, 3, 255],
    );
  }
});
test('BMP rejects truncations, pixel overflow, overlapping masks and invalid RLE coordinates', () => {
  const bytes = bitmap();
  for (let n = 0; n < bytes.length; n++) assert.throws(() => parseBMP(bytes.subarray(0, n)));
  assert.throws(() => parseBMP(bytes, { maxPixels: 3 }), /budget/);
  assert.throws(
    () =>
      parseBMP(bitmap({ bits: 16, width: 1, height: 1, compression: 3, masks: [31, 31, 31], pixels: [0, 0, 0, 0] })),
    /overlap/,
  );
  assert.throws(
    () =>
      parseBMP(bitmap({ bits: 8, width: 1, height: 1, compression: 1, palette: [0, 0, 0, 0], pixels: [2, 0, 0, 1] })),
    /coordinate/,
  );
});
