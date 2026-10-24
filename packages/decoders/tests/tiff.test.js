// TIFF reading (@margoengine/decoders/tiff) against files built by the test encoder (tests/support/texture-encoders.js,
// from Adobe TIFF 6.0): every sample depth and colour type, every compression, predictor, strips and tiles, planar
// configurations, byte orders and extra samples, with exact pixels, then refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTIFF } from '../dist/tiff.js';
import { failed, image, lzwEncode, rejects, rgbaOf, sequence, tiff } from './support/texture-encoders.js';

const COMPRESSIONS = [1, 5, 32773, 8, 32946],
  LAYOUTS = [{ rowsPerStrip: 3 }, { rowsPerStrip: 1000 }, { tile: [16, 16] }],
  ORDERS = [true, false];
/** `count` deterministic samples of `bits` bits. */
const samplesOf = (count, bits, seed) =>
  Array.from(
    image(count, 1, seed)
      .subarray(0, count * 2)
      .filter((_, i) => i % 2 === 0),
    (v, i) => (v * 257 + i * 31) % 2 ** bits,
  );
const scale = (v, bits) => Math.round((v * 255) / (2 ** bits - 1));

test('TIFF grey at 1, 2, 4, 8 and 16 bits, both polarities, every compression, strips and tiles, both byte orders', () => {
  const width = 21,
    height = 18;
  for (const bits of [1, 2, 4, 8, 16]) {
    const samples = samplesOf(width * height, bits, bits);
    for (const photometric of [0, 1])
      for (const compression of COMPRESSIONS)
        for (const layout of LAYOUTS)
          for (const little of ORDERS) {
            const file = tiff({ little, width, height, spp: 1, bits, photometric, compression, ...layout, samples }),
              want = rgbaOf(samples, 1, (s, p, c) =>
                c === 3 ? 255 : scale(photometric ? s[p] : 2 ** bits - 1 - s[p], bits),
              ),
              label = `${bits}-bit photometric ${photometric} compression ${compression} ${JSON.stringify(layout)} little ${little}`;
            const decoded = parseTIFF(file);
            assert.deepEqual([decoded.width, decoded.height, decoded.format], [width, height, 'rgba8unorm'], label);
            assert.deepEqual(decoded.data, want, label);
          }
  }
});

test('TIFF RGB at 1 to 16 bits, planar 1 and 2, every compression, strips and tiles, both byte orders', () => {
  const width = 9,
    height = 7;
  for (const bits of [1, 2, 4, 8, 16]) {
    const samples = samplesOf(width * height * 3, bits, bits + 20),
      want = rgbaOf(samples, 3, (s, p, c) => (c === 3 ? 255 : scale(s[p + c], bits)));
    for (const planar of [1, 2])
      for (const compression of COMPRESSIONS)
        for (const layout of LAYOUTS)
          for (const little of ORDERS)
            assert.deepEqual(
              parseTIFF(
                tiff({ little, width, height, spp: 3, bits, photometric: 2, planar, compression, ...layout, samples }),
              ).data,
              want,
              `${bits}-bit planar ${planar} compression ${compression} ${JSON.stringify(layout)} little ${little}`,
            );
  }
});

test('TIFF LZW with and without Predictor 2 at 8 and 16 bits, grey and RGB, chunky and planar', () => {
  const width = 13,
    height = 6;
  for (const bits of [8, 16])
    for (const [spp, photometric] of [
      [1, 1],
      [3, 2],
      [4, 2],
    ]) {
      const samples = samplesOf(width * height * spp, bits, spp * bits),
        want = rgbaOf(samples, spp, (s, p, c) =>
          c === 3 ? (spp === 4 ? scale(s[p + 3], bits) : 255) : scale(s[p + (spp === 1 ? 0 : c)], bits),
        );
      for (const predictor of [1, 2])
        for (const planar of [1, 2])
          for (const layout of LAYOUTS)
            for (const little of ORDERS)
              assert.deepEqual(
                parseTIFF(
                  tiff({
                    little,
                    width,
                    height,
                    spp,
                    bits,
                    photometric,
                    compression: 5,
                    predictor,
                    planar,
                    extra: 2,
                    ...layout,
                    samples,
                  }),
                ).data,
                want,
                `${bits}-bit spp ${spp} predictor ${predictor} planar ${planar} little ${little}`,
              );
    }
});

test('TIFF palette images at 1, 2, 4, 8 and 16 bits with every compression', () => {
  const width = 11,
    height = 5;
  for (const bits of [1, 2, 4, 8, 16]) {
    const size = 2 ** bits,
      colorMap = Array.from({ length: 3 * size }, (_, i) => (i * 40503 + 7) & 65535),
      samples = samplesOf(width * height, bits, bits + 40),
      want = rgbaOf(samples, 1, (s, p, c) => (c === 3 ? 255 : Math.round(colorMap[s[p] + c * size] / 257)));
    for (const compression of COMPRESSIONS)
      for (const little of ORDERS)
        assert.deepEqual(
          parseTIFF(tiff({ little, width, height, spp: 1, bits, photometric: 3, colorMap, compression, samples })).data,
          want,
          `${bits}-bit palette compression ${compression}`,
        );
  }
});

test('TIFF 32-bit float grey, RGB and RGBA (associated and unassociated), planar 1 and 2, both byte orders', () => {
  const width = 5,
    height = 4,
    values = (n, seed) => Array.from({ length: n }, (_, i) => Math.fround(((i * 7919 + seed) % 2000) / 997 - 0.5));
  for (const [spp, photometric, extra] of [
    [1, 1],
    [2, 1, 2],
    [3, 2],
    [4, 2, 2],
    [4, 2, 1],
  ]) {
    const samples = values(width * height * spp, spp).map((v, i) =>
        Math.fround(extra && i % spp === spp - 1 ? Math.abs(v) + 0.25 : v),
      ),
      base = photometric === 2 ? 3 : 1,
      want = [];
    for (let p = 0; p < width * height; p++) {
      const s = samples.slice(p * spp, p * spp + spp),
        a = extra ? s[base] : 1;
      for (let c = 0; c < 3; c++) {
        const v = s[base === 3 ? c : 0];
        want.push(Math.fround(extra === 1 ? v / a : v));
      }
      want.push(Math.fround(a));
    }
    for (const planar of [1, 2])
      for (const compression of [1, 5, 32773, 8])
        for (const little of ORDERS) {
          const decoded = parseTIFF(
            tiff({
              little,
              width,
              height,
              spp,
              bits: 32,
              float: true,
              photometric,
              extra,
              planar,
              compression,
              rowsPerStrip: 3,
              samples,
            }),
          );
          assert.equal(decoded.format, 'rgba32float');
          assert.deepEqual(
            [...decoded.data],
            want,
            `spp ${spp} extra ${extra} planar ${planar} compression ${compression} little ${little}`,
          );
        }
  }
});

test('TIFF extra samples: associated alpha divided out, unassociated kept, unspecified dropped, at 8 and 16 bits', () => {
  const width = 4,
    height = 3;
  for (const bits of [8, 16])
    for (const [spp, photometric] of [
      [2, 1],
      [4, 2],
      [5, 2],
    ])
      for (const extra of [0, 1, 2]) {
        const base = photometric === 2 ? 3 : 1,
          max = 2 ** bits - 1,
          raw = samplesOf(width * height * spp, bits, spp + extra),
          // Associated colour never exceeds its alpha.
          samples = raw.map((v, i) =>
            extra === 1 && i % spp < base ? Math.floor((v * raw[i - (i % spp) + base]) / max) : v,
          ),
          want = rgbaOf(samples, spp, (s, p, c) => {
            const a = s[p + base],
              v = s[p + (base === 3 ? c : 0)];
            if (c === 3) return extra ? scale(a, bits) : 255;
            // Associated colour divides by alpha at full precision.
            return extra === 1 ? (a ? Math.min(255, Math.round((v * 255) / a)) : 0) : scale(v, bits);
          }),
          extras = new Array(spp - base).fill(0);
        extras[0] = extra;
        for (const planar of [1, 2])
          assert.deepEqual(
            parseTIFF(tiff({ width, height, spp, bits, photometric, extra: extras, planar, compression: 5, samples }))
              .data,
            want,
            `${bits}-bit spp ${spp} extra ${extra} planar ${planar}`,
          );
      }
});

/** MSB-first `codes` of the given widths, as an LZW strip. */
function codes(list) {
  const bits = list.flatMap(([code, width]) => Array.from({ length: width }, (_, i) => (code >> (width - 1 - i)) & 1)),
    out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => (out[i >> 3] |= bit << (7 - (i & 7))));
  return out;
}

test('TIFF refuses truncated and malformed headers, IFDs and strips, oversized images and unsupported layouts, naming the fix', () => {
  const grey = (options = {}) =>
    tiff({ width: 2, height: 2, spp: 1, bits: 8, photometric: 1, samples: [1, 2, 3, 4], ...options });
  const SHORT = 3,
    LONG = 4;
  assert.deepEqual([...parseTIFF(grey()).data], [1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255]);
  rejects(() => parseTIFF(null), TypeError, /needs the TIFF file as a Uint8Array/);
  rejects(() => parseTIFF(grey(), { maxPixels: -1 }), RangeError, /maxPixels must be a positive integer/);
  rejects(() => parseTIFF(grey(), { maxPixels: 3 }), RangeError, /2 x 2, over maxPixels 3; raise maxPixels/);
  // A huge image is refused before anything is allocated.
  rejects(
    () =>
      parseTIFF(
        grey({
          tags: [
            [256, LONG, [100000]],
            [257, LONG, [100000]],
          ],
        }),
      ),
    RangeError,
    /100000 x 100000, over maxPixels/,
  );
  failed(() => parseTIFF(grey().subarray(0, 7)), /header is missing/);
  const bom = grey();
  bom[1] = 0x4d;
  failed(() => parseTIFF(bom), /header is missing/);
  const magic = grey();
  magic[2] = 43;
  failed(() => parseTIFF(magic), /header is missing/);
  const ifdPast = grey();
  new DataView(ifdPast.buffer).setUint32(4, ifdPast.length, true);
  failed(() => parseTIFF(ifdPast), /first IFD offset is past the end/);
  const entriesPast = grey(),
    ifd = new DataView(entriesPast.buffer).getUint32(4, true);
  new DataView(entriesPast.buffer).setUint16(ifd, 500, true);
  failed(() => parseTIFF(entriesPast), /IFD runs past the end/);
  failed(() => parseTIFF(grey({ tags: [[273, LONG, [1, 2]]] }).subarray(0)), /strip or tile offsets are missing/);
  failed(() => parseTIFF(grey({ tags: [[256, SHORT, null]] })), /required tag 256 is missing/);
  failed(
    () =>
      parseTIFF(
        grey({
          tags: [
            [262, SHORT, null],
            [277, SHORT, [3]],
          ],
        }),
      ),
    /strip or tile/,
  );
  failed(() => parseTIFF(grey({ tags: [[256, SHORT, [0]]] })), /size is 0/);
  failed(() => parseTIFF(grey({ tags: [[257, SHORT, [0]]] })), /size is 0/);
  failed(() => parseTIFF(grey({ tags: [[273, LONG, [1 << 20]]] })), /strip or tile 0 runs past the end/);
  failed(() => parseTIFF(grey({ tags: [[279, LONG, [3]]] })), /strip or tile 0 is too short/);
  failed(() => parseTIFF(grey({ tile: [16, 16], tags: [[322, SHORT, [0]]] })), /tile or strip size is 0/);
  failed(() => parseTIFF(grey({ tile: [16, 16], tags: [[322, LONG, [1 << 20]]] })), /far larger than the image/);
  // LZW: a code past the table, a stream that ends early; PackBits: a literal and a run past the strip, a short stream.
  failed(
    () =>
      parseTIFF(
        grey({
          compression: 5,
          raw: [
            codes([
              [256, 9],
              [65, 9],
              [300, 9],
              [257, 9],
            ]),
          ],
        }),
      ),
    /LZW code 300 is undefined/,
  );
  failed(
    () =>
      parseTIFF(
        grey({
          compression: 5,
          raw: [
            codes([
              [256, 9],
              [259, 9],
            ]),
          ],
        }),
      ),
    /LZW code 259 is undefined/,
  );
  failed(
    () =>
      parseTIFF(
        grey({
          compression: 5,
          raw: [
            codes([
              [256, 9],
              [65, 9],
              [257, 9],
            ]),
          ],
        }),
      ),
    /LZW data ends early/,
  );
  failed(
    () => parseTIFF(grey({ compression: 32773, raw: [Uint8Array.of(10, 1, 2, 3)] })),
    /PackBits literal runs past its strip/,
  );
  failed(
    () => parseTIFF(grey({ compression: 32773, raw: [Uint8Array.of(256 - 9, 5)] })),
    /PackBits run runs past its strip/,
  );
  failed(() => parseTIFF(grey({ compression: 32773, raw: [Uint8Array.of(0, 1)] })), /PackBits data ends early/);
  failed(() => parseTIFF(grey({ compression: 8, raw: [sequence(12)] })), /Compressed data/);
  // Unsupported compressions, colour spaces, sample formats and layouts.
  for (const compression of [2, 3, 4, 6, 7, 34712])
    failed(
      () => parseTIFF(grey({ compression, raw: [sequence(4)] })),
      new RegExp(`compression ${compression} is not supported; save`),
    );
  for (const photometric of [4, 5, 6, 8])
    failed(
      () => parseTIFF(grey({ photometric })),
      new RegExp(`photometric interpretation ${photometric} is not supported`),
    );
  failed(() => parseTIFF(grey({ photometric: 2 })), /photometric interpretation 2/);
  failed(() => parseTIFF(grey({ tags: [[339, SHORT, [2]]] })), /mixed or signed sample formats/);
  failed(
    () =>
      parseTIFF(
        tiff({
          width: 1,
          height: 1,
          spp: 3,
          bits: 8,
          photometric: 2,
          samples: [1, 2, 3],
          tags: [[258, SHORT, [8, 8, 16]]],
        }),
      ),
    /mixed or signed/,
  );
  failed(() => parseTIFF(grey({ bits: 12 })), /12-bit samples/);
  failed(
    () => parseTIFF(grey({ bits: 32, float: true, photometric: 0, samples: [1, 2, 3, 4] })),
    /photometric interpretation 0/,
  );
  failed(() => parseTIFF(grey({ bits: 16, tags: [[339, SHORT, [3]]] })), /16-bit float samples/);
  failed(() => parseTIFF(grey({ predictor: 3 })), /Predictor 3 with 8-bit samples/);
  failed(() => parseTIFF(grey({ bits: 4, predictor: 2 })), /Predictor 2 with 4-bit samples/);
  failed(() => parseTIFF(grey({ tags: [[266, SHORT, [2]]] })), /FillOrder 2 is not supported/);
  failed(() => parseTIFF(grey({ tags: [[284, SHORT, [3]]] })), /PlanarConfiguration 3 is invalid/);
  failed(() => parseTIFF(grey({ spp: 17, samples: new Array(68).fill(0) })), /17 samples per pixel/);
  failed(() => parseTIFF(grey({ bits: 4, photometric: 3 })), /palette image has no ColorMap/);
  failed(() => parseTIFF(grey({ bits: 4, photometric: 3, colorMap: new Array(30).fill(0) })), /no ColorMap/);
  // The 12-bit LZW path is reachable from real data.
  assert.ok(lzwEncode(image(64, 64, 3)).length > 4096);
});

test('TIFF 8-bit RGB and RGBA: uncompressed, LZW with predictor, PackBits, Deflate, both byte orders, strips', () => {
  const width = 9,
    height = 7,
    rgba = [...image(width, height)],
    rgb = rgba.filter((_, i) => i % 4 !== 3),
    opaque = rgbaOf(rgb, 3, (s, p, c) => (c === 3 ? 255 : s[p + c]));
  for (const little of [true, false])
    for (const compression of [1, 5, 32773, 8])
      for (const rowsPerStrip of [height, 3, 1]) {
        const options = { little, width, height, bits: 8, photometric: 2, compression, rowsPerStrip };
        assert.deepEqual(parseTIFF(tiff({ ...options, spp: 3, samples: rgb })).data, opaque);
        const withAlpha = parseTIFF(
          tiff({ ...options, spp: 4, extra: 2, samples: rgba, predictor: compression === 5 ? 2 : 1 }),
        );
        assert.equal(withAlpha.format, 'rgba8unorm');
        assert.deepEqual(
          withAlpha.data,
          Uint8Array.from(rgba),
          `little ${little} compression ${compression} rows ${rowsPerStrip}`,
        );
      }
  // An unspecified extra sample is not alpha.
  assert.deepEqual(
    parseTIFF(tiff({ width, height, bits: 8, photometric: 2, spp: 4, extra: 0, samples: rgba })).data,
    opaque,
  );
});

test('TIFF LZW across code widths 9 to 12 and table clears, with the 8- and 16-bit predictor', () => {
  const width = 96,
    height = 80,
    rgba = [...image(width, height, 7)];
  // Smooth gradients make long strings; noise makes many codes. Together they pass 4094 entries.
  for (let i = 0; i < rgba.length / 2; i++) rgba[i] = (i >> 6) & 255;
  const encoded = lzwEncode(Uint8Array.from(rgba));
  assert.ok(encoded.length > 4096, 'test data must need 12-bit codes');
  const decoded = parseTIFF(
    tiff({ width, height, spp: 4, bits: 8, photometric: 2, compression: 5, extra: 2, samples: rgba }),
  );
  assert.deepEqual(decoded.data, Uint8Array.from(rgba));
  const predicted = parseTIFF(
    tiff({ width, height, spp: 4, bits: 8, photometric: 2, compression: 5, predictor: 2, extra: 2, samples: rgba }),
  );
  assert.deepEqual(predicted.data, Uint8Array.from(rgba));
  // 16-bit grey with predictor 2, big-endian: the high byte (rounded) comes out.
  const grey = Array.from({ length: 30 * 20 }, (_, i) => (i * 977) & 65535);
  for (const little of [true, false]) {
    const g = parseTIFF(
      tiff({
        little,
        width: 30,
        height: 20,
        spp: 1,
        bits: 16,
        photometric: 1,
        compression: 5,
        predictor: 2,
        samples: grey,
      }),
    );
    assert.deepEqual(
      g.data,
      rgbaOf(grey, 1, (s, p, c) => (c === 3 ? 255 : Math.round((s[p] * 255) / 65535))),
    );
  }
});

test('TIFF tiles, planar configuration 2, 16-bit RGB and PackBits grey', () => {
  const width = 21,
    height = 18,
    grey = [...image(width, height, 3)].slice(0, width * height);
  for (const compression of [1, 32773, 5, 8]) {
    const tiled = parseTIFF(
      tiff({ width, height, spp: 1, bits: 8, photometric: 1, compression, tile: [16, 16], samples: grey }),
    );
    assert.deepEqual(
      tiled.data,
      rgbaOf(grey, 1, (s, p, c) => (c === 3 ? 255 : s[p])),
      `compression ${compression}`,
    );
  }
  const rgb16 = Array.from({ length: width * height * 3 }, (_, i) => (i * 40503) & 65535),
    expected = rgbaOf(rgb16, 3, (s, p, c) => (c === 3 ? 255 : Math.round((s[p + c] * 255) / 65535)));
  for (const little of [true, false])
    for (const [planar, tile] of [
      [2, undefined],
      [2, [16, 16]],
      [1, [32, 16]],
    ])
      assert.deepEqual(
        parseTIFF(
          tiff({
            little,
            width,
            height,
            spp: 3,
            bits: 16,
            photometric: 2,
            planar,
            tile,
            compression: 8,
            rowsPerStrip: 5,
            samples: rgb16,
          }),
        ).data,
        expected,
        `little ${little} planar ${planar} tile ${tile}`,
      );
  // Planar RGBA with associated alpha divided out.
  const premultiplied = [100, 50, 25, 200, 0, 0, 0, 0, 255, 128, 0, 255];
  assert.deepEqual(
    [
      ...parseTIFF(
        tiff({ width: 3, height: 1, spp: 4, bits: 8, photometric: 2, planar: 2, extra: 1, samples: premultiplied }),
      ).data,
    ],
    [128, 64, 32, 200, 0, 0, 0, 0, 255, 128, 0, 255],
  );
});

test('TIFF palette, bilevel, sub-byte grey and 32-bit float', () => {
  // A 4-bit palette at odd width 5: rows pad to 3 bytes.
  const indices = [0, 1, 2, 3, 15, 15, 3, 2, 1, 0],
    colorMap = [
      ...Array.from({ length: 16 }, (_, i) => i * 4369),
      ...Array.from({ length: 16 }, (_, i) => 65535 - i * 257),
      ...new Array(16).fill(32896),
    ];
  const palette = parseTIFF(
    tiff({ width: 5, height: 2, spp: 1, bits: 4, photometric: 3, colorMap, compression: 32773, samples: indices }),
  );
  assert.deepEqual(
    palette.data,
    rgbaOf(indices, 1, (s, p, c) => (c === 3 ? 255 : Math.round(colorMap[s[p] + c * 16] / 257))),
  );
  // 1-bit WhiteIsZero at width 10 (two bytes a row), and 2-bit BlackIsZero.
  const bitsRow = [1, 0, 1, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1];
  assert.deepEqual(
    parseTIFF(tiff({ width: 10, height: 2, spp: 1, bits: 1, photometric: 0, compression: 5, samples: bitsRow })).data,
    rgbaOf(bitsRow, 1, (s, p, c) => (c === 3 ? 255 : s[p] ? 0 : 255)),
  );
  const two = [0, 1, 2, 3, 3, 2, 1];
  assert.deepEqual(
    parseTIFF(tiff({ width: 7, height: 1, spp: 1, bits: 2, photometric: 1, samples: two })).data,
    rgbaOf(two, 1, (s, p, c) => (c === 3 ? 255 : s[p] * 85)),
  );
  // 32-bit float grey and RGBA (associated alpha), both byte orders.
  const floats = [0.5, -1.25, 3.75, 1e-3, 65504, 0];
  for (const little of [true, false]) {
    const grey = parseTIFF(
      tiff({ little, width: 3, height: 2, spp: 1, bits: 32, float: true, photometric: 1, samples: floats }),
    );
    assert.equal(grey.format, 'rgba32float');
    assert.ok(grey.data instanceof Float32Array);
    assert.deepEqual(
      [...grey.data],
      floats.flatMap((v) => [Math.fround(v), Math.fround(v), Math.fround(v), 1]),
    );
    const rgba = parseTIFF(
      tiff({
        little,
        width: 1,
        height: 2,
        spp: 4,
        bits: 32,
        float: true,
        photometric: 2,
        extra: 1,
        compression: 8,
        samples: [1, 0.5, 0.25, 0.5, 2, 2, 2, 0],
      }),
    );
    assert.deepEqual([...rgba.data], [2, 1, 0.5, 0.5, 0, 0, 0, 0]);
  }
});

test('TIFF refuses malformed and unsupported files with named errors', () => {
  const good = tiff({ width: 2, height: 2, spp: 1, bits: 8, photometric: 1, samples: [1, 2, 3, 4] });
  assert.throws(() => parseTIFF([]), TypeError);
  assert.throws(() => parseTIFF(good, { maxPixels: 3 }), RangeError);
  failed(() => parseTIFF(good.subarray(0, 6)), /header is missing/);
  const notTiff = good.slice();
  notTiff[2] = 43;
  failed(() => parseTIFF(notTiff), /header is missing/);
  failed(
    () =>
      parseTIFF(tiff({ width: 2, height: 2, spp: 1, bits: 8, photometric: 1, compression: 7, samples: [1, 2, 3, 4] })),
    /compression 7 is not supported/,
  );
  failed(
    () => parseTIFF(tiff({ width: 2, height: 2, spp: 4, bits: 8, photometric: 5, samples: new Array(16).fill(0) })),
    /photometric interpretation 5/,
  );
  failed(
    () => parseTIFF(tiff({ width: 2, height: 2, spp: 1, bits: 12, photometric: 1, samples: [1, 2, 3, 4] })),
    /12-bit samples/,
  );
  failed(
    () =>
      parseTIFF(tiff({ width: 2, height: 2, spp: 1, bits: 4, photometric: 1, predictor: 2, samples: [1, 2, 3, 4] })),
    /Predictor 2 with 4-bit/,
  );
  failed(
    () => parseTIFF(tiff({ width: 2, height: 2, spp: 1, bits: 4, photometric: 3, samples: [1, 2, 3, 4] })),
    /no ColorMap/,
  );
  // A strip whose LZW data is cut short, and one whose PackBits literal overruns.
  const lzw = tiff({
      width: 4,
      height: 4,
      spp: 1,
      bits: 8,
      photometric: 1,
      compression: 5,
      samples: [...sequence(16)],
    }),
    view = new DataView(lzw.buffer),
    entries = view.getUint16(view.getUint32(4, true), true),
    ifd = view.getUint32(4, true);
  for (let e = 0; e < entries; e++)
    if (view.getUint16(ifd + 2 + e * 12, true) === 279) view.setUint32(ifd + 2 + e * 12 + 8, 3, true);
  failed(() => parseTIFF(lzw), /LZW data ends early/);
  const missingWidth = good.slice(),
    w = new DataView(missingWidth.buffer),
    first = w.getUint32(4, true) + 2;
  w.setUint16(first, 255, true);
  failed(() => parseTIFF(missingWidth), /required tag 256 is missing/);
  const past = good.slice(),
    p = new DataView(past.buffer);
  p.setUint32(4, past.length + 10, true);
  failed(() => parseTIFF(past), /first IFD offset/);
});
