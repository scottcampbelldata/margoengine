// PCX reading (@margoengine/decoders/pcx) against files built here from the ZSoft PCX technical reference: every plane and
// bit layout, palettes, run lengths across scanlines, refusals. packages/loaders test:real-files checks real files against Pillow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePCX } from '../dist/pcx.js';
import { failed, rejects } from './support/texture-encoders.js';

/** Run-length encodes bytes: every value of 0xC0 or more needs a run, and runs stop at 63. */
function rle(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; ) {
    let run = 1;
    while (i + run < bytes.length && bytes[i + run] === bytes[i] && run < 63) run++;
    if (run > 1 || bytes[i] >= 0xc0) out.push(0xc0 | run);
    out.push(bytes[i]);
    i += run;
  }
  return out;
}

function pcx({ width, height, bits, planes, lineBytes, data, version = 5, encoding = 1, header = [], palette, x0 = 0, y0 = 0 }) {
  const head = new Uint8Array(128),
    view = new DataView(head.buffer);
  head.set([10, version, encoding, bits]);
  view.setUint16(4, x0, true);
  view.setUint16(6, y0, true);
  view.setUint16(8, x0 + width - 1, true);
  view.setUint16(10, y0 + height - 1, true);
  head.set(header, 16);
  head[65] = planes;
  view.setUint16(66, lineBytes, true);
  return Uint8Array.from([...head, ...(encoding ? rle(data) : data), ...(palette ? [12, ...palette] : [])]);
}
const PALETTE = Array.from({ length: 768 }, (_, i) => (i * 5) & 255);
const rgb = (index) => [PALETTE[index * 3], PALETTE[index * 3 + 1], PALETTE[index * 3 + 2], 255];

test('an 8-bit image reads through the palette after the image, as Quake skins do', () => {
  const image = parsePCX(pcx({ width: 3, height: 2, bits: 8, planes: 1, lineBytes: 4, data: [1, 2, 200, 0, 7, 7, 7, 0], palette: PALETTE }));
  assert.deepEqual([image.width, image.height], [3, 2]);
  assert.deepEqual([...image.data], [1, 2, 200, 7, 7, 7].flatMap(rgb), 'the padding byte of each line is dropped');
});

test('an 8-bit image without a palette reads as grey, and a window off zero keeps its size', () => {
  const image = parsePCX(pcx({ width: 2, height: 1, bits: 8, planes: 1, lineBytes: 2, data: [9, 200], x0: 5, y0: 3 }));
  assert.deepEqual([...image.data], [9, 9, 9, 255, 200, 200, 200, 255]);
});

test('RGB and RGBA hold each plane in turn on every line', () => {
  const three = parsePCX(pcx({ width: 2, height: 2, bits: 8, planes: 3, lineBytes: 2, data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] }));
  assert.deepEqual([...three.data], [1, 3, 5, 255, 2, 4, 6, 255, 7, 9, 11, 255, 8, 10, 12, 255]);
  const four = parsePCX(pcx({ width: 2, height: 1, bits: 8, planes: 4, lineBytes: 2, data: [1, 2, 3, 4, 5, 6, 128, 0] }));
  assert.deepEqual([...four.data], [1, 3, 5, 128, 2, 4, 6, 0]);
});

const HEADER = Array.from({ length: 48 }, (_, i) => i + 1);
const header = (index) => [HEADER[index * 3], HEADER[index * 3 + 1], HEADER[index * 3 + 2], 255];

test('16-colour images pack two pixels a byte, or one bit in each of four planes', () => {
  const packed = parsePCX(pcx({ width: 3, height: 1, bits: 4, planes: 1, lineBytes: 2, data: [0x1f, 0x20], header: HEADER }));
  assert.deepEqual([...packed.data], [1, 15, 2].flatMap(header));
  const planar = parsePCX(
    pcx({ width: 2, height: 1, bits: 1, planes: 4, lineBytes: 1, data: [0b10000000, 0b01000000, 0b10000000, 0b11000000], header: HEADER }),
  );
  assert.deepEqual([...planar.data], [0b1101, 0b1010].flatMap(header));
});

test('a version 3 file means the standard EGA colours, and a 1-bit image is black and white', () => {
  const ega = parsePCX(pcx({ version: 3, width: 4, height: 1, bits: 4, planes: 1, lineBytes: 2, data: [0x46, 0x7f] }));
  assert.deepEqual(
    [...ega.data],
    [
      [170, 0, 0, 255],
      [170, 85, 0, 255],
      [170, 170, 170, 255],
      [255, 255, 255, 255],
    ].flat(),
  );
  const mono = parsePCX(pcx({ width: 9, height: 1, bits: 1, planes: 1, lineBytes: 2, data: [0b10100000, 0b10000000] }));
  assert.deepEqual([...mono.data].filter((_, i) => i % 4 === 0), [255, 0, 255, 0, 0, 0, 0, 0, 255]);
});

test('a run crosses scanlines, and an uncompressed file reads as it stands', () => {
  const run = parsePCX(pcx({ width: 2, height: 2, bits: 8, planes: 1, lineBytes: 2, data: [200, 200, 200, 200] }));
  assert.deepEqual([...run.data], Array(4).fill([200, 200, 200, 255]).flat());
  const plain = parsePCX(pcx({ width: 2, height: 1, bits: 8, planes: 1, lineBytes: 2, data: [200, 3], encoding: 0 }));
  assert.deepEqual([...plain.data], [200, 200, 200, 255, 3, 3, 3, 255]);
});

test('broken files are refused and say what to do', () => {
  const good = { width: 2, height: 1, bits: 8, planes: 1, lineBytes: 2, data: [1, 2] };
  rejects(() => parsePCX([1, 2]), TypeError, /Uint8Array/);
  rejects(() => parsePCX(pcx(good), { maxPixels: 0 }), RangeError, /positive integer/);
  rejects(() => parsePCX(pcx(good), { maxPixels: 1 }), RangeError, /maxPixels/);
  failed(() => parsePCX(new Uint8Array(20)), /128-byte header/);
  failed(() => parsePCX(pcx(good).fill(9, 0, 1)), /manufacturer/);
  const encoded = pcx(good);
  encoded[2] = 5;
  failed(() => parsePCX(encoded), /encoding 5/);
  failed(() => parsePCX(pcx({ ...good, bits: 2 })), /2 bits in 1 planes/);
  failed(() => parsePCX(pcx({ ...good, width: 9, lineBytes: 1 })), /too short/);
  failed(() => parsePCX(pcx({ ...good, data: [1] })), /ends inside the image data/);
  failed(() => parsePCX(Uint8Array.from([...pcx({ ...good, data: [] }), 0xc2])), /ends inside a run/);
  failed(() => parsePCX(Uint8Array.from([...pcx({ ...good, data: [] }), 0xc9, 1])), /run past the image/);
  failed(() => parsePCX(pcx({ ...good, data: [1], encoding: 0 })), /ends inside the image data/);
  const empty = pcx(good);
  new DataView(empty.buffer).setUint16(8, 0, true);
  new DataView(empty.buffer).setUint16(4, 5, true);
  failed(() => parsePCX(empty), /empty window/);
});
