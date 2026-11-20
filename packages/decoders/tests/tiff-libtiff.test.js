// TIFF CCITT, JPEG, YCbCr, CMYK and CIE L*a*b* reading (@margoengine/decoders/tiff). Files from the libtiff tools
// (tests/generate-tiff-libtiff.mjs, fixtures/tiff-libtiff) are checked against their sources (CCITT, exact) or against
// tiff2rgba and djpeg (JPEG and CMYK, within the rounding the two decoders differ by); hand-built files check the TIFF
// 6.0 Section 10, 11, 16, 21 and 23 rules that no reference tool writes (Modified Huffman rows, uncompressed mode,
// subsampled YCbCr data units and positioning, DotRange, L*a*b*).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { openTIFF, parseTIFF } from '../dist/tiff.js';
import { loadTIFFCodecs } from '../dist/tiff-codecs.js';
import { failed, tiff } from './support/texture-encoders.js';
import { bilevel, colour } from './support/tiff-sources.js';

const read = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/tiff-libtiff/${name}`, import.meta.url)));
const SHORT = 3,
  LONG = 4,
  RATIONAL = 5;
const maxDiff = (a, b) => {
  assert.equal(a.length, b.length);
  let max = 0;
  for (let i = 0; i < a.length; i++) max = Math.max(max, Math.abs(a[i] - b[i]));
  return max;
};

test('CCITT Group 3 (1D, 2D, byte-aligned EOLs) and Group 4 from tiffcp: strips, tiles and FillOrder 2, exact', () => {
  const { width, height, samples } = bilevel(),
    want = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 ? 255 : samples[i >> 2] ? 0 : 255));
  for (const name of ['g3-1d', 'g3-2d', 'g3-2d-fill', 'g3-lsb2msb', 'g4-strips', 'g4-tiles', 'g4-lsb2msb']) {
    const decoded = parseTIFF(read(`${name}.tif`));
    assert.deepEqual([decoded.width, decoded.height], [width, height], name);
    assert.ok(Buffer.from(decoded.data).equals(Buffer.from(want)), name);
  }
});

test('JPEG (Technical Note 2) from tiffcp and old-style JPEG within 3 of tiff2rgba and djpeg; CMYK within 1', () => {
  // Measured: YCbCr 2 x 2 strips and tiles and old-style 3 (the integer and float inverse DCTs and chroma rounding
  // differ), RGB, RGB planar and grey 1, JPEG CMYK 2, LZW CMYK 1 (tiff2rgba floors (255 - C)(255 - K) / 255).
  for (const [name, limit] of [
    ['jpeg-ycbcr-strips', 3],
    ['jpeg-ycbcr-tiles', 3],
    ['ojpeg', 3],
    ['jpeg-rgb', 1],
    ['jpeg-rgb-planar', 1],
    ['jpeg-grey', 1],
    ['jpeg-cmyk', 2],
    ['cmyk', 1],
  ]) {
    const decoded = parseTIFF(read(`${name}.tif`));
    assert.deepEqual([decoded.width, decoded.height], [48, 32], name);
    assert.ok(maxDiff(decoded.data, read(`${name}.rgba`)) <= limit, name);
  }
});

/** Section 21's YCbCr to RGB, from the field values, for one pixel already at full resolution. */
function ycbcrToRGB(y, cb, cr, [lr, lg, lb], rbw) {
  const Y = ((y - rbw[0]) * 255) / (rbw[1] - rbw[0]),
    Cb = ((cb - rbw[2]) * 127) / (rbw[3] - rbw[2]),
    Cr = ((cr - rbw[4]) * 127) / (rbw[5] - rbw[4]),
    R = Cr * (2 - 2 * lr) + Y,
    B = Cb * (2 - 2 * lb) + Y,
    G = (Y - lb * B - lr * R) / lg;
  return [R, G, B].map((v) => Math.min(255, Math.max(0, Math.round(v))));
}

/** Packs `luma` (width x height) and chroma (ceil(width / sh) x ceil(height / sv)) into Section 21 data units. */
function dataUnits(luma, cb, cr, width, height, sh, sv, tw = width, th = height) {
  const blocks = [];
  for (let by = 0; by < Math.ceil(height / th); by++)
    for (let bx = 0; bx < Math.ceil(width / tw); bx++) {
      const rows = Math.min(th, tw === width ? height - by * th : th),
        out = [];
      for (let uy = 0; uy < Math.ceil(rows / sv); uy++)
        for (let ux = 0; ux < tw / sh; ux++) {
          for (let j = 0; j < sv; j++)
            for (let i = 0; i < sh; i++) {
              const x = bx * tw + ux * sh + i,
                y = by * th + uy * sv + j;
              out.push(x < width && y < height ? luma[y * width + x] : 0);
            }
          const cx = (bx * tw) / sh + ux,
            cy = (by * th) / sv + uy,
            cw = Math.ceil(width / sh);
          out.push(cx < cw ? (cb[cy * cw + cx] ?? 0) : 0, cx < cw ? (cr[cy * cw + cx] ?? 0) : 0);
        }
      blocks.push(Uint8Array.from(out));
    }
  return blocks;
}

test('YCbCr data units at every subsampling, centred and cosited, strips and tiles, headroom and Rec. 709 luma', () => {
  // 9 x 7 is not a multiple of the sampling factors (Technical Note 2's change to Section 21: padded data units).
  for (const [width, height] of [
    [20, 12],
    [9, 7],
  ])
    for (const [sh, sv] of [
      [1, 1],
      [2, 1],
      [2, 2],
      [4, 2],
      [4, 4],
    ])
      for (const positioning of [1, 2])
        for (const [coefficients, rbw] of [
          [
            [0.299, 0.587, 0.114],
            [0, 255, 128, 255, 128, 255],
          ],
          [
            [0.2125, 0.7154, 0.0721],
            [16, 235, 128, 240, 128, 240],
          ],
        ])
          for (const layout of [{}, { rowsPerStrip: 4 }, { tile: [16, 16] }]) {
            const cw = Math.ceil(width / sh),
              ch = Math.ceil(height / sv),
              luma = colour(width, height, 1).map((v) => 16 + ((v * 219) >> 8)),
              cb = colour(cw, ch, 2).filter((_, i) => i % 2 === 0),
              cr = colour(cw, ch, 2).filter((_, i) => i % 2 === 1),
              [tw, th] = layout.tile ?? [width, layout.rowsPerStrip ?? height],
              file = tiff({
                width,
                height,
                spp: 3,
                bits: 8,
                photometric: 6,
                samples: new Array(width * height * 3).fill(0),
                ...layout,
                raw: dataUnits(luma, cb, cr, width, height, sh, sv, tw, th),
                tags: [
                  [529, RATIONAL, coefficients.flatMap((c) => [Math.round(c * 10000), 10000])],
                  [530, SHORT, [sh, sv]],
                  [531, SHORT, [positioning]],
                  [532, RATIONAL, rbw.flatMap((v) => [v, 1])],
                ],
              });
            // Chroma filtered up linearly from its sample positions (Section 21 YCbCrPositioning).
            const at = (plane, x, y) => {
              const ox = positioning === 1 ? sh / 2 - 0.5 : 0,
                oy = positioning === 1 ? sv / 2 - 0.5 : 0,
                u = Math.min(Math.max((x - ox) / sh, 0), cw - 1),
                v = Math.min(Math.max((y - oy) / sv, 0), ch - 1),
                x1 = Math.floor(u),
                y1 = Math.floor(v),
                x2 = Math.min(x1 + 1, cw - 1),
                y2 = Math.min(y1 + 1, ch - 1),
                fx = u - x1,
                fy = v - y1,
                p = (i, j) => plane[j * cw + i];
              return Math.round(
                (p(x1, y1) * (1 - fx) + p(x2, y1) * fx) * (1 - fy) + (p(x1, y2) * (1 - fx) + p(x2, y2) * fx) * fy,
              );
            };
            const want = new Uint8Array(width * height * 4);
            for (let y = 0; y < height; y++)
              for (let x = 0; x < width; x++)
                want.set(
                  [...ycbcrToRGB(luma[y * width + x], at(cb, x, y), at(cr, x, y), coefficients, rbw), 255],
                  (y * width + x) * 4,
                );
            assert.deepEqual(
              parseTIFF(file).data,
              want,
              `${width} x ${height} at ${sh} x ${sv} positioning ${positioning} ${rbw[0]} ${JSON.stringify(layout)}`,
            );
          }
});

test('YCbCr planar (smaller chroma planes), and a file without ReferenceBlackWhite reads as JFIF', () => {
  const width = 9,
    height = 7,
    luma = colour(width, height, 1),
    chroma = (v) => new Uint8Array(20).fill(v);
  // Flat 5 x 4 chroma planes: every pixel is the JFIF conversion of its luma and those two values.
  const flat = tiff({
    width,
    height,
    spp: 3,
    bits: 8,
    photometric: 6,
    planar: 2,
    samples: new Array(width * height * 3).fill(0),
    raw: [Uint8Array.from(luma), chroma(90), chroma(200)],
    tags: [[530, SHORT, [2, 2]]],
  });
  const out = parseTIFF(flat).data;
  // An extra sample in a planar subsampled file is full size (Technical Note 2): unassociated alpha.
  const alpha = Uint8Array.from(luma, (v) => 255 - v),
    withAlpha = parseTIFF(
      tiff({
        width,
        height,
        spp: 4,
        bits: 8,
        photometric: 6,
        planar: 2,
        extra: 2,
        samples: new Array(width * height * 4).fill(0),
        raw: [Uint8Array.from(luma), chroma(90), chroma(200), alpha],
        tags: [[530, SHORT, [2, 2]]],
      }),
    ).data;
  for (let p = 0; p < width * height; p++) {
    assert.deepEqual([...withAlpha.subarray(p * 4, p * 4 + 3)], [...out.subarray(p * 4, p * 4 + 3)]);
    assert.equal(withAlpha[p * 4 + 3], alpha[p]);
  }
  for (let p = 0; p < width * height; p++) {
    const y = luma[p];
    assert.deepEqual(
      [...out.subarray(p * 4, p * 4 + 4)],
      [...ycbcrToRGB(y, 90, 200, [0.299, 0.587, 0.114], [0, 255, 128, 255, 128, 255]), 255],
    );
  }
});

test('CMYK: 8 and 16 bits, DotRange, alpha, and InkSet 2 refused', () => {
  const cmyk = [0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 51, 102, 153, 64],
    rgb = (c) => [0, 1, 2].map((i) => Math.round(255 * (1 - c[i] / 255) * (1 - c[3] / 255)));
  const decoded = parseTIFF(tiff({ width: 6, height: 1, spp: 4, bits: 8, photometric: 5, samples: cmyk })).data;
  for (let p = 0; p < 6; p++)
    assert.deepEqual([...decoded.subarray(p * 4, p * 4 + 4)], [...rgb(cmyk.slice(p * 4)), 255]);
  const wide = parseTIFF(
    tiff({ width: 6, height: 1, spp: 4, bits: 16, photometric: 5, samples: cmyk.map((v) => v * 257) }),
  ).data;
  assert.deepEqual(wide, decoded);
  // DotRange [20, 220]: 20 is no ink, 220 full ink, beyond them clamped.
  const dots = parseTIFF(
    tiff({
      width: 3,
      height: 1,
      spp: 4,
      bits: 8,
      photometric: 5,
      samples: [20, 120, 220, 20, 10, 20, 20, 20, 240, 20, 20, 20],
      tags: [[336, SHORT, [20, 220]]],
    }),
  ).data;
  assert.deepEqual([...dots], [255, 128, 0, 255, 255, 255, 255, 255, 0, 255, 255, 255]);
  // Unassociated alpha is the fifth sample.
  const alpha = parseTIFF(
    tiff({ width: 1, height: 1, spp: 5, bits: 8, photometric: 5, extra: 2, samples: [0, 255, 0, 0, 77] }),
  ).data;
  assert.deepEqual([...alpha], [255, 0, 255, 77]);
  failed(
    () =>
      parseTIFF(
        tiff({
          width: 1,
          height: 1,
          spp: 4,
          bits: 8,
          photometric: 5,
          samples: [0, 0, 0, 0],
          tags: [[334, SHORT, [5]]],
        }),
      ),
    /inks other than CMYK/,
  );
});

test('CIE L*a*b* and ICC L*a*b*: neutral greys, the D65 sRGB primaries, L*-only', () => {
  // L* 0, 50 and 100 neutral are sRGB 0, 119 and 255; D65 L*a*b* of the sRGB red, green and blue primaries
  // (53.24, 80.09, 67.20), (87.73, -86.18, 83.18), (32.30, 79.19, -107.86) come back within 8 after 8-bit storage
  // (an L* step is 0.39 and an a* or b* step 1; at a channel near 0 the sRGB curve turns a linear 0.002 into 7).
  const L = (v) => Math.round((v * 255) / 100),
    s = (v) => (Math.round(v) + 256) % 256,
    lab = [
      L(0),
      0,
      0,
      L(50),
      0,
      0,
      L(100),
      0,
      0,
      L(53.24),
      s(80.09),
      s(67.2),
      L(87.73),
      s(-86.18),
      s(83.18),
      L(32.3),
      s(79.19),
      s(-107.86),
    ];
  const want = [
    [0, 0, 0],
    [119, 119, 119],
    [255, 255, 255],
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];
  for (const photometric of [8, 9]) {
    const samples = photometric === 8 ? lab : lab.map((v, i) => (i % 3 ? (((v << 24) >> 24) + 128) & 255 : v)),
      decoded = parseTIFF(tiff({ width: 6, height: 1, spp: 3, bits: 8, photometric, samples })).data;
    for (let p = 0; p < 6; p++)
      assert.ok(maxDiff(decoded.subarray(p * 4, p * 4 + 3), want[p]) <= (p < 3 ? 0 : 8), `${photometric} pixel ${p}`);
  }
  const grey = parseTIFF(tiff({ width: 2, height: 1, spp: 1, bits: 8, photometric: 8, samples: [L(50), 255] })).data;
  assert.deepEqual([...grey], [119, 119, 119, 255, 255, 255, 255, 255]);
});

// Terminating and make-up codes (T.4 Tables 2 and 3) for a Modified Huffman writer.
const WHITE =
  '00110101 000111 0111 1000 1011 1100 1110 1111 10011 10100 00111 01000 001000 000011 110100 110101 101010 101011 0100111 0001100 0001000 0010111 0000011 0000100 0101000 0101011 0010011 0100100 0011000 00000010 00000011 00011010 00011011 00010010 00010011 00010100 00010101 00010110 00010111 00101000 00101001 00101010 00101011 00101100 00101101 00000100 00000101 00001010 00001011 01010010 01010011 01010100 01010101 00100100 00100101 01011000 01011001 01011010 01011011 01001010 01001011 00110010 00110011 00110100 11011 10010 010111 0110111 00110110 00110111 01100100 01100101 01101000 01100111 011001100 011001101 011010010 011010011 011010100 011010101 011010110 011010111 011011000 011011001 011011010 011011011 010011000 010011001 010011010 011000 010011011'.split(
    ' ',
  );
const BLACK =
  '0000110111 010 11 10 011 0011 0010 00011 000101 000100 0000100 0000101 0000111 00000100 00000111 000011000 0000010111 0000011000 0000001000 00001100111 00001101000 00001101100 00000110111 00000101000 00000010111 00000011000 000011001010 000011001011 000011001100 000011001101 000001101000 000001101001 000001101010 000001101011 000011010010 000011010011 000011010100 000011010101 000011010110 000011010111 000001101100 000001101101 000011011010 000011011011 000001010100 000001010101 000001010110 000001010111 000001100100 000001100101 000001010010 000001010011 000000100100 000000110111 000000111000 000000100111 000000101000 000001011000 000001011001 000000101011 000000101100 000001011010 000001100110 000001100111 0000001111 000011001000 000011001001 000001011011 000000110011 000000110100 000000110101 0000001101100 0000001101101 0000001001010 0000001001011 0000001001100 0000001001101 0000001110010 0000001110011 0000001110100 0000001110101 0000001110110 0000001110111 0000001010010 0000001010011 0000001010100 0000001010101 0000001011010 0000001011011 0000001100100 0000001100101'.split(
    ' ',
  );
const LONG_MAKEUP =
  '00000001000 00000001100 00000001101 000000010010 000000010011 000000010100 000000010101 000000010110 000000010111 000000011100 000000011101 000000011110 000000011111'.split(
    ' ',
  );
const packBitString = (text) => {
  const out = new Uint8Array(Math.ceil(text.length / 8));
  for (let i = 0; i < text.length; i++) if (text[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
  return out;
};
/** One run in Modified Huffman codes: 2560 make-ups, one make-up, then the terminating code. */
const runCode = (length, black) => {
  const table = black ? BLACK : WHITE;
  let code = '';
  for (; length >= 2624; length -= 2560) code += LONG_MAKEUP[12];
  if (length >= 1792) code += LONG_MAKEUP[(length >> 6) - 28];
  else if (length >= 64) code += table[63 + (length >> 6)];
  return code + table[length & 63 && length >= 64 ? length & 63 : length % 64];
};

test('Modified Huffman (Compression 2): byte-aligned rows, long runs, BlackIsZero reverses the colours', () => {
  const { width, height, samples } = bilevel();
  let bitsText = '';
  for (let y = 0; y < height; y++) {
    let x = 0,
      black = 0;
    while (x < width) {
      let end = x;
      while (end < width && samples[y * width + end] === black) end++;
      bitsText += runCode(end - x, black);
      x = end;
      black ^= 1;
    }
    bitsText += '0'.repeat((8 - (bitsText.length % 8)) % 8);
  }
  const raw = packBitString(bitsText);
  for (const photometric of [0, 1]) {
    const decoded = parseTIFF(
      tiff({ width, height, spp: 1, bits: 1, photometric, compression: 2, samples, raw: [raw] }),
    ).data;
    for (let p = 0; p < width * height; p++)
      assert.equal(decoded[p * 4], (samples[p] === 1) === (photometric === 0) ? 0 : 255, `pixel ${p}`);
  }
});

test('T.6 uncompressed mode, early EOFB (white rows) and damaged rows refused', () => {
  const file = (bitsText, width = 16, height = 2, compression = 4) =>
    tiff({
      width,
      height,
      spp: 1,
      bits: 1,
      photometric: 0,
      compression,
      samples: new Array(width * height).fill(0),
      raw: [packBitString(bitsText)],
    });
  const row = (decoded, y, width = 16) =>
    Array.from({ length: width }, (_, x) => (decoded.data[(y * width + x) * 4] ? 0 : 1)).join('');
  // Extension 0000001111 enters uncompressed mode (T.4 Table 5): 1 is a black pixel, 01 white then black, 0001
  // three white then black, 000001 five white, and 00000001 + 1 exits after one white with the next run black. V(0)
  // then ends that run at b1, the reference line's end.
  const uncompressed = parseTIFF(file('0000001111' + '1' + '01' + '0001' + '000001' + '00000001' + '1' + '1', 16, 1));
  assert.equal(row(uncompressed, 0), '1010001000000111');
  // EOFB at the start: every row is white.
  const blank = parseTIFF(file('000000000001000000000001', 16, 3));
  assert.equal(row(blank, 2), '0'.repeat(16));
  failed(() => parseTIFF(file('001' + '01000' + '11', 16, 1)), /CCITT data/);
  failed(() => parseTIFF(file('00000001110', 16, 1)), /code that T.4 and T.6 do not define/);
});

test('mutated CCITT, JPEG and CMYK files fail with typed errors only', { timeout: 120000 }, () => {
  let seed = 5;
  const next = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 2 ** 24;
  for (const name of readdirSync(new URL('./fixtures/tiff-libtiff/', import.meta.url)).filter((f) =>
    f.endsWith('.tif'),
  )) {
    const base = read(name);
    for (let k = 0; k < 300; k++) {
      const bytes = base.slice();
      for (let i = 0, n = 1 + Math.floor(next() * 4); i < n; i++)
        bytes[Math.floor(next() * bytes.length)] = next() * 256;
      try {
        parseTIFF(bytes);
      } catch (error) {
        assert.ok(['MargoError', 'RangeError'].includes(error.name), `${name} mutation ${k}: ${error.stack}`);
      }
    }
  }
});

const codecs = await loadTIFFCodecs();

test('LZMA, Zstandard and lossless WebP from tiffcp read exactly as their sources: strips, tiles and predictors', () => {
  for (const [name, from] of [
    ['lzma-strips', 'source-rgb'],
    ['lzma-tiles-predictor', 'source-rgb16'],
    ['lzma-float', 'source-float'],
    ['zstd-strips', 'source-rgb'],
    ['zstd-tiles', 'source-rgb16'],
    ['zstd-float', 'source-float'],
    ['webp-lossless', 'source-rgb'],
    ['webp-rgba-tiles', 'source-rgba'],
  ]) {
    const decoded = parseTIFF(read(`${name}.tif`), { codecs }),
      want = parseTIFF(read(`${from}.tif`));
    assert.deepEqual([decoded.width, decoded.height, decoded.format], [48, 32, want.format], name);
    assert.deepEqual(decoded.data, want.data, name);
    const page = openTIFF(read(`${name}.tif`), { codecs }).read(0),
      source = openTIFF(read(`${from}.tif`)).read(0);
    assert.deepEqual(page.samples, source.samples, `${name} page`);
  }
});

test('lossy WebP from tiffcp within 1 of tiff2rgba', () => {
  const decoded = parseTIFF(read('webp-lossy.tif'), { codecs });
  assert.deepEqual([decoded.width, decoded.height], [48, 32]);
  assert.ok(maxDiff(decoded.data, read('webp-lossy.rgba')) <= 1);
});

test('openTIFF pages read CCITT, JPEG and FillOrder 2 strips as stored samples', () => {
  const { width, height, samples } = bilevel();
  for (const name of ['g3-1d', 'g3-2d', 'g3-2d-fill', 'g3-lsb2msb', 'g4-strips', 'g4-tiles', 'g4-lsb2msb']) {
    const page = openTIFF(read(`${name}.tif`)).read(0);
    assert.deepEqual([page.width, page.height, page.bits], [width, height, 1], name);
    assert.deepEqual([...page.samples], [...samples], name);
  }
  // RGB and grey JPEG pages hold the colours parseTIFF shows; old-style and YCbCr pages keep their stored components.
  for (const name of ['jpeg-rgb', 'jpeg-rgb-planar', 'jpeg-grey']) {
    const page = openTIFF(read(`${name}.tif`)).read(0),
      shown = parseTIFF(read(`${name}.tif`)).data,
      spp = page.samplesPerPixel;
    assert.deepEqual(
      [...page.samples],
      Array.from({ length: 48 * 32 * spp }, (_, i) => shown[Math.floor(i / spp) * 4 + (i % spp)]),
      name,
    );
  }
  for (const name of ['jpeg-ycbcr-strips', 'jpeg-ycbcr-tiles', 'ojpeg', 'jpeg-cmyk'])
    assert.equal(openTIFF(read(`${name}.tif`)).read(0).samples.length, 48 * 32 * (name === 'jpeg-cmyk' ? 4 : 3), name);
});

test('a damaged Zstandard or LZMA strip fails as a damaged TIFF', () => {
  for (const name of ['zstd-strips', 'lzma-strips']) {
    const bytes = read(`${name}.tif`),
      page = openTIFF(bytes, { codecs }).read(0),
      at = page.tags.get(273)[0];
    bytes[at + 6] ^= 0xff;
    failed(
      () => parseTIFF(bytes, { codecs }),
      name.startsWith('zstd') ? /Zstandard strip or tile/ : /xz|LZMA|check|CRC/i,
    );
  }
});

test('openTIFF refuses a subsampled YCbCr page outside JPEG instead of reading its data units as pixels', () => {
  // TIFF 6.0 Section 21: subsampled YCbCr is stored in data units, which have no per-pixel sample layout. A raw page
  // read them as interleaved Y, Cb, Cr pixels before; parseTIFF converts them, and a 1 x 1 page still reads.
  const file = (sub) =>
    tiff({
      width: 4,
      height: 2,
      spp: 3,
      bits: 8,
      photometric: 6,
      samples: new Array(4 * 2 * 3).fill(128),
      raw: sub ? [new Uint8Array(12).fill(128)] : undefined,
      tags: [[530, SHORT, sub ?? [1, 1]]],
    });
  failed(() => openTIFF(file([2, 2])).read(0), /subsampled YCbCr page is not supported/);
  assert.equal(parseTIFF(file([2, 2])).width, 4);
  assert.equal(openTIFF(file()).read(0).samples.length, 4 * 2 * 3);
});

test('LZMA, Zstandard and WebP need their loaded decoders; loadTIFFCodecs loads only the ones a file uses', async () => {
  for (const [name, label] of [
    ['lzma-strips', 'LZMA'],
    ['zstd-tiles', 'Zstandard'],
    ['webp-lossless', 'WebP'],
  ]) {
    const bytes = read(`${name}.tif`),
      message = new RegExp(
        `\\(${label}\\) needs its decoder; pass \\{ codecs: await loadTIFFCodecs\\(bytes\\) \\} from @margoengine/decoders/tiff-codecs`,
      );
    failed(() => parseTIFF(bytes), message);
    failed(() => openTIFF(bytes).read(0), message);
    const loaded = await loadTIFFCodecs(bytes);
    assert.deepEqual(
      Object.keys(loaded).filter((key) => loaded[key]),
      [{ LZMA: 'lzma', Zstandard: 'zstd', WebP: 'webp' }[label]],
      name,
    );
    assert.equal(parseTIFF(bytes, { codecs: loaded }).width, 48, name);
  }
  const none = await loadTIFFCodecs(read('source-rgb.tif'));
  assert.deepEqual(Object.values(none).filter(Boolean), []);
  await assert.rejects(loadTIFFCodecs(undefined, { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(loadTIFFCodecs('x'), TypeError);
});
