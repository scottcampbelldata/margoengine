// TGA reading (@margoengine/decoders/tga) against files built by the test encoder (tests/support/texture-encoders.js,
// from the Truevision TGA 2.0 specification): every image type, depth and origin, colour maps, RLE, refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTGA } from '../dist/tga.js';
import { bgra, failed, fileOrder, image, rejects, tga } from './support/texture-encoders.js';

const ORIGINS = [
  [false, false],
  [true, false],
  [false, true],
  [true, true],
];
const q5 = (v) => Math.round((v * 31) / 255),
  e5 = (n) => Math.round((n * 255) / 31);
/** A colour as a TGA pixel of `bits` bits (B, G, R, A; 15/16-bit ARRRRRGG GGGBBBBB, attribute bit from alpha). */
function encode(p, bits) {
  if (bits === 32) return [p[2], p[1], p[0], p[3]];
  if (bits === 24) return [p[2], p[1], p[0]];
  const v = (bits === 16 && p[3] >= 128 ? 0x8000 : 0) | (q5(p[0]) << 10) | (q5(p[1]) << 5) | q5(p[2]);
  return [v & 255, v >> 8];
}
/** What a reader should return for `p` stored at `bits` bits. */
function expected(p, bits) {
  if (bits === 32) return [p[0], p[1], p[2], p[3]];
  if (bits === 24) return [p[0], p[1], p[2], 255];
  return [e5(q5(p[0])), e5(q5(p[1])), e5(q5(p[2])), bits === 16 ? (p[3] >= 128 ? 255 : 0) : 255];
}
const alphaBits = (bits) => (bits === 32 ? 8 : bits === 16 ? 1 : 0);
/** Start pixel and length of each RLE packet in `file` (pixel data at `at`, `size` bytes a pixel). */
function packets(file, at, size, count) {
  const out = [];
  for (let n = 0; n < count; ) {
    const header = file[at++],
      run = (header & 127) + 1;
    out.push([n, run]);
    at += header & 128 ? size : run * size;
    n += run;
  }
  return out;
}
const crossesRow = (list, width) =>
  list.some(([start, run]) => Math.floor(start / width) !== Math.floor((start + run - 1) / width));

/** A 6x5 test image whose rows 1 and 2 are one colour, so RLE runs cross scanlines whatever the origin. */
function banded(seed) {
  const rgba = image(6, 5, seed);
  for (let i = 6; i < 18; i++) rgba.set(rgba.subarray(0, 4), i * 4);
  return rgba;
}
const descriptorOf = (top, right, alpha) => (top ? 32 : 0) | (right ? 16 : 0) | alpha;

test('TGA types 2 and 10 at 15, 16, 24 and 32 bits, all four origins, RLE runs across scanlines', () => {
  const width = 6,
    height = 5,
    rgba = banded(11);
  for (const type of [2, 10])
    for (const bits of [15, 16, 24, 32])
      for (const [top, right] of ORIGINS) {
        const pixels = fileOrder(rgba, width, height, top, right).map((p) => Uint8Array.from(encode(p, bits))),
          file = tga({ type, width, height, bits, descriptor: descriptorOf(top, right, alphaBits(bits)), pixels }),
          want = [];
        for (let i = 0; i < width * height; i++) want.push(...expected(rgba.subarray(i * 4, i * 4 + 4), bits));
        const decoded = parseTGA(file);
        assert.deepEqual([decoded.width, decoded.height], [width, height]);
        assert.deepEqual([...decoded.data], want, `type ${type} ${bits}-bit top ${top} right ${right}`);
        if (type === 10) assert.ok(crossesRow(packets(file, 18, (bits + 7) >> 3, width * height), width));
      }
});

test('TGA types 3 and 11, 8-bit grey and 16-bit grey with alpha, all four origins', () => {
  const width = 6,
    height = 5,
    rgba = banded(12);
  for (const type of [3, 11])
    for (const bits of [8, 16])
      for (const [top, right] of ORIGINS) {
        const pixels = fileOrder(rgba, width, height, top, right).map((p) =>
            Uint8Array.from(bits === 8 ? [p[0]] : [p[0], p[3]]),
          ),
          file = tga({ type, width, height, bits, descriptor: descriptorOf(top, right, bits === 16 ? 8 : 0), pixels }),
          want = [];
        for (let i = 0; i < width * height; i++)
          want.push(rgba[i * 4], rgba[i * 4], rgba[i * 4], bits === 16 ? rgba[i * 4 + 3] : 255);
        assert.deepEqual([...parseTGA(file).data], want, `type ${type} ${bits}-bit top ${top} right ${right}`);
        if (type === 11) assert.ok(crossesRow(packets(file, 18, bits / 8, width * height), width));
      }
});

test('TGA types 1 and 9: 8- and 16-bit indices into 15-, 16-, 24- and 32-bit colour maps, all four origins', () => {
  const width = 6,
    height = 5;
  for (const type of [1, 9])
    for (const [indexBits, length, first] of [
      [8, 200, 3],
      [16, 300, 10],
    ])
      for (const mapBits of [15, 16, 24, 32]) {
        const colours = image(length, 1, length + mapBits),
          map = Array.from({ length }, (_, i) => encode(colours.subarray(i * 4, i * 4 + 4), mapBits)),
          // Indices, top row first; rows 1 and 2 share one index so runs cross scanlines.
          indices = Array.from(
            { length: width * height },
            (_, i) => first + ((i >= 6 && i < 18 ? 7 : i * 37) % length),
          );
        for (const [top, right] of ORIGINS) {
          const order = [];
          for (let fy = 0; fy < height; fy++)
            for (let fx = 0; fx < width; fx++)
              order.push(indices[(top ? fy : height - 1 - fy) * width + (right ? width - 1 - fx : fx)]);
          const file = tga({
              type,
              width,
              height,
              bits: indexBits,
              descriptor: descriptorOf(top, right, alphaBits(mapBits)),
              map,
              mapBits,
              mapFirst: first,
              pixels: order.map((i) => Uint8Array.from(indexBits === 8 ? [i] : [i & 255, i >> 8])),
              id: [9, 8, 7, 6],
            }),
            want = indices.flatMap((i) => expected(colours.subarray((i - first) * 4, (i - first) * 4 + 4), mapBits));
          assert.deepEqual([...parseTGA(file).data], want, `type ${type} ${indexBits}-bit index, ${mapBits}-bit map`);
          if (type === 9)
            assert.ok(
              crossesRow(packets(file, 18 + 4 + length * ((mapBits + 7) >> 3), indexBits / 8, width * height), width),
            );
        }
      }
});

test('TGA 2.0 extension area: no-alpha attributes make it opaque, premultiplied alpha is divided out', () => {
  const pixels = [new Uint8Array([40, 60, 100, 200]), new Uint8Array([0, 0, 0, 0])],
    file = (footer) => tga({ type: 2, width: 2, height: 1, bits: 32, descriptor: 8, pixels, footer });
  assert.deepEqual([...parseTGA(file(3)).data], [100, 60, 40, 200, 0, 0, 0, 0]);
  assert.deepEqual([...parseTGA(file(0)).data], [100, 60, 40, 255, 0, 0, 0, 255]);
  assert.deepEqual(
    [...parseTGA(file(4)).data],
    [Math.round((100 * 255) / 200), Math.round((60 * 255) / 200), Math.round((40 * 255) / 200), 200, 0, 0, 0, 0],
  );
});

test('TGA refuses malformed files with named errors', () => {
  const good = tga({ type: 2, width: 2, height: 2, bits: 24, pixels: fileOrder(image(2, 2), 2, 2).map(bgra) });
  assert.throws(() => parseTGA([1, 2, 3]), TypeError);
  assert.throws(() => parseTGA(good, { maxPixels: 3 }), RangeError);
  assert.throws(() => parseTGA(good, { maxPixels: 0 }), RangeError);
  failed(() => parseTGA(good.subarray(0, 10)), /header is missing/);
  failed(() => parseTGA(good.subarray(0, good.length - 1)), /ends inside the image data/);
  const noImage = good.slice();
  noImage[2] = 0;
  failed(() => parseTGA(noImage), /image type 0/);
  const badDepth = good.slice();
  badDepth[16] = 12;
  failed(() => parseTGA(badDepth), /pixel depth 12/);
  // An RLE packet longer than the image, and a truncated RLE stream.
  const rle = tga({ type: 10, width: 2, height: 1, bits: 24, pixels: [new Uint8Array(4), new Uint8Array(4)] });
  const long = rle.slice();
  long[18] = 128 | 5;
  failed(() => parseTGA(long), /runs past the image/);
  failed(() => parseTGA(rle.subarray(0, rle.length - 2)), /ends inside the run-length data/);
  const mapped = tga({
    type: 1,
    width: 1,
    height: 1,
    bits: 8,
    map: [[1, 2, 3]],
    pixels: [new Uint8Array([3])],
  });
  failed(() => parseTGA(mapped), /colour index 3 is outside/);
});

test('TGA refuses truncated, zero-sized, oversized and inconsistent files, naming the fix', () => {
  const header = (patch) => {
    const file = tga({ type: 2, width: 2, height: 2, bits: 24, pixels: fileOrder(image(2, 2), 2, 2).map(bgra) });
    patch(file);
    return file;
  };
  rejects(
    () =>
      parseTGA(
        header(() => {}),
        { maxPixels: 1.5 },
      ),
    RangeError,
    /maxPixels must be a positive integer/,
  );
  rejects(
    () =>
      parseTGA(
        header(() => {}),
        { maxPixels: 3 },
      ),
    RangeError,
    /over maxPixels 3; raise maxPixels/,
  );
  rejects(() => parseTGA('TGA'), TypeError, /needs the TGA file as a Uint8Array/);
  failed(() => parseTGA(new Uint8Array(17)), /header is missing/);
  failed(() => parseTGA(header((f) => (f[12] = f[13] = 0))), /size is 0/);
  failed(() => parseTGA(header((f) => (f[14] = f[15] = 0))), /size is 0/);
  // 65535 x 65535 is over the default limit and is refused before anything is allocated.
  rejects(
    () => parseTGA(header((f) => (f[12] = f[13] = f[14] = f[15] = 255))),
    RangeError,
    /over maxPixels 67108864; raise maxPixels/,
  );
  failed(() => parseTGA(header((f) => (f[2] = 32))), /image type 32/);
  failed(() => parseTGA(header((f) => (f[1] = 2))), /colour map type is invalid/);
  failed(() => parseTGA(header((f) => (f[2] = 1))), /colour map type is invalid/);
  failed(() => parseTGA(header((f) => (f[2] = 3))), /pixel depth 24 is invalid for image type 3/);
  const mapped = tga({
    type: 1,
    width: 2,
    height: 1,
    bits: 8,
    map: [
      [1, 2, 3],
      [4, 5, 6],
    ],
    pixels: [new Uint8Array([0]), new Uint8Array([1])],
  });
  assert.deepEqual([...parseTGA(mapped).data], [3, 2, 1, 255, 6, 5, 4, 255]);
  failed(() => parseTGA(mapped.subarray(0, 21)), /ends inside the colour map/);
  const badMap = mapped.slice();
  badMap[7] = 8;
  failed(() => parseTGA(badMap), /pixel depth 8 is invalid for image type 1/);
});
