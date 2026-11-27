// PNM reading (@margoengine/decoders/pnm) against files written here from the Netpbm pbm, pgm and ppm specifications.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePNM } from '../dist/pnm.js';
import { failed, rejects } from './support/texture-encoders.js';

const file = (header, raster = []) => Uint8Array.from([...new TextEncoder().encode(header), ...raster]);
const grey = (image) => [...image.data].filter((_, i) => i % 4 === 0);

test('every magic number gives exact RGBA8 rows', () => {
  const colour = [10, 20, 30, 255, 40, 50, 60, 255];
  for (const bytes of [file('P3\n2 1\n255\n10 20 30  40 50 60\n'), file('P6 2 1 255\n', [10, 20, 30, 40, 50, 60])]) {
    const image = parsePNM(bytes);
    assert.deepEqual([image.width, image.height, ...image.data], [2, 1, ...colour]);
  }
  for (const bytes of [file('P2\n3 2\n255\n0 1 2 253 254 255'), file('P5\n3 2\n255\n', [0, 1, 2, 253, 254, 255])]) {
    const image = parsePNM(bytes);
    assert.deepEqual([image.width, image.height], [3, 2]);
    assert.deepEqual(grey(image), [0, 1, 2, 253, 254, 255]);
    assert.deepEqual([...image.data.subarray(4, 8)], [1, 1, 1, 255]);
  }
  // A set bit is black. Raw rows are padded to a byte; plain bits need no white space.
  const bits = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1, 0];
  const expected = bits.map((b) => (b ? 0 : 255));
  assert.deepEqual(grey(parsePNM(file('P1\n9 2\n100000001\n011111110'))), expected);
  assert.deepEqual(grey(parsePNM(file('P4\n9 2\n', [0x80, 0x80, 0x7f, 0x00]))), expected);
});

test('samples scale from the maximum value, in one or two bytes, most significant first', () => {
  assert.deepEqual(grey(parsePNM(file('P2 4 1 15 0 1 7 15'))), [0, 17, 119, 255]);
  assert.deepEqual(grey(parsePNM(file('P5 3 1 65535\n', [0, 0, 0x80, 0x80, 0xff, 0xff]))), [0, 128, 255]);
  assert.deepEqual(grey(parsePNM(file('P5 2 1 256\n', [0, 128, 1, 0]))), [128, 255]);
});

test('comments sit anywhere in the header, and a raw file gives its first image', () => {
  const header = 'P5# a\n# b\r\n 2#c\n1 # d\n255# the raster follows this line\n';
  assert.deepEqual(grey(parsePNM(file(header, [35, 10]))), [35, 10]);
  assert.deepEqual(grey(parsePNM(file('P5 1 1 255\n', [9, ...file('P5 1 1 255\n', [1])]))), [9]);
});

test('damaged, oversized and foreign input is refused', () => {
  failed(() => parsePNM(file('P7\n')), /magic number/);
  failed(() => parsePNM(file('P52 1 255\n', [0, 0])), /white space before its width/);
  failed(() => parsePNM(file('P5 0 1 255\n')), /size is 0/);
  failed(() => parsePNM(file('P5 2 x 255\n')), /no height/);
  failed(() => parsePNM(file('P5 2 1 0\n', [0, 0])), /outside 1 to 65535/);
  failed(() => parsePNM(file('P5 2 1 65536\n', [0, 0])), /outside 1 to 65535/);
  failed(() => parsePNM(file('P5 2 1 255')), /white space/);
  failed(() => parsePNM(file('P5 2 1 255\n', [0])), /ends before/);
  failed(() => parsePNM(file('P5 2 1 15\n', [0, 16])), /above the maximum/);
  failed(() => parsePNM(file('P2 2 1 255 0 ')), /no sample/);
  failed(() => parsePNM(file('P1 2 1\n02')), /other than 0 and 1/);
  failed(() => parsePNM(file('P2 99999999999 1 255 0')), /too large/);
  rejects(() => parsePNM(file('P5 3 1 255\n', [0, 0, 0]), { maxPixels: 2 }), RangeError, /maxPixels/);
  rejects(() => parsePNM(file('P5 1 1 255\n', [0]), { maxPixels: 0 }), RangeError, /maxPixels/);
  rejects(() => parsePNM('P5'), TypeError, /Uint8Array/);
});
