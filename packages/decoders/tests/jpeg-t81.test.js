// The lossless process (ITU-T T.81 Annex H) and 12-bit DCT files, against libjpeg-turbo's files and decodes, two files
// of the NEMA DICOM WG04 sample set with its uncompressed reference, and files the test writes for the rest.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { decodeImage } from '@margoengine/decoders/image';
import { decodeJPEG, decodeJPEGSamples } from '@margoengine/decoders/jpeg';
import { openTIFF, parseTIFF } from '@margoengine/decoders/tiff';
import { encapsulatedFrame } from './support/dicom-pixels.js';
import { encodeLossless } from './support/jpeg-lossless-encoder.js';
import { cases, image } from './support/jpeg-sources.js';
import { tiff } from './support/texture-encoders.js';

const file = (path) => new Uint8Array(readFileSync(new URL(`fixtures/${path}`, import.meta.url))),
  turbo = (name) => file(`jpeg-libjpeg-turbo/${name}.jpg`),
  reference = (name) => {
    const raw = gunzipSync(file(`jpeg-libjpeg-turbo/${name}.samples.gz`));
    return new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  },
  /** What a lossless file of `entry` holds: its source, with the point transform's low bits dropped. */
  source = (entry) => {
    const made = image(entry),
      data = made.data.map((value) => (value >> entry.transform) << entry.transform);
    return { ...made, data: entry.precision > 8 ? data : Uint8Array.from(data) };
  },
  worstOf = (actual, expected) => {
    assert.equal(actual.length, expected.length);
    let worst = 0;
    for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
    return worst;
  };

for (const [name, entry] of Object.entries(cases)) {
  if (!entry.args.includes('-lossless')) continue;
  test(`lossless ${name} comes out exactly as cjpeg read it`, () => {
    const decoded = decodeJPEGSamples(turbo(name)),
      expected = source(entry);
    assert.deepEqual(
      [decoded.width, decoded.height, decoded.components, decoded.precision, decoded.lossless],
      [expected.width, expected.height, expected.components, entry.precision, true],
    );
    assert.deepEqual(decoded.data, expected.data);
  });
}

// A DCT file has no exact reference: T.81 leaves the inverse transform's arithmetic to the decoder. djpeg's floating
// point transform is the same function in single precision, so the two round at most one level apart.
for (const name of ['dct12-grey', 'dct12-grey-restart', 'dct12-grey-progressive', 'dct12-grey-q100', 'dct12-rgb'])
  test(`12-bit ${name} is within one level of djpeg`, () => {
    const decoded = decodeJPEGSamples(turbo(name)),
      expected = reference(name);
    assert.deepEqual([decoded.precision, decoded.lossless], [12, false]);
    assert.ok(worstOf(decoded.data, expected) <= 1);
    // The picture itself comes out, not a flat or clipped one: within 1% of the source on average at quality 92.
    const made = image(cases[name]);
    if (!cases[name].smooth) return;
    let sum = 0;
    for (let i = 0; i < made.data.length; i++) sum += Math.abs(decoded.data[i] - made.data[i]);
    assert.ok(sum / made.data.length < 41, `${name}: mean ${sum / made.data.length}`);
  });

// djpeg's chroma upsampling rounds to whole 12-bit levels and its conversion to RGB rounds again; after scaling to 8
// bits both are far under one 8-bit level.
for (const name of ['dct12-ycbcr-420', 'dct12-ycbcr-444-progressive', 'dct12-grey', 'dct12-rgb'])
  test(`decodeJPEG scales 12-bit ${name} to the 8 bits of djpeg's picture`, () => {
    const { data, width, height } = decodeJPEG(turbo(name)),
      expected = reference(name),
      components = cases[name].components ?? 1;
    assert.equal(expected.length, width * height * components);
    for (let i = 0; i < width * height; i++) {
      for (let c = 0; c < 3; c++) {
        const level = (expected[i * components + (components === 1 ? 0 : c)] * 255) / 4095;
        assert.ok(Math.abs(data[i * 4 + c] - level) <= 1, `${name}: pixel ${i}, channel ${c}`);
      }
      assert.equal(data[i * 4 + 3], 255);
    }
  });

test('decodeJPEG and decodeImage scale lossless samples to 8 bits, RGB kept as stored', async () => {
  for (const name of ['grey16-sv4', 'rgb12-sv2-point1', 'rgb8-sv1', 'grey2-sv1']) {
    const entry = cases[name],
      expected = source(entry),
      bytes = turbo(name),
      picture = decodeJPEG(bytes),
      components = expected.components;
    for (let i = 0; i < expected.width * expected.height; i++)
      for (let c = 0; c < 3; c++) {
        const value = expected.data[i * components + (components === 1 ? 0 : c)];
        assert.equal(picture.data[i * 4 + c], Math.round((value * 255) / (2 ** entry.precision - 1)), `${name} ${i}`);
      }
    assert.deepEqual(await decodeImage(bytes), picture);
  }
});

// The NEMA files byte for byte; the digest is of the little-endian words of NM1_UNC, the set's uncompressed reference.
test('the DICOM lossless sample NM1_JPLL equals its uncompressed reference', () => {
  const decoded = decodeJPEGSamples(encapsulatedFrame(file('jpeg-dicom/JPEG-LL.dcm')));
  assert.deepEqual([decoded.width, decoded.height, decoded.precision, decoded.lossless], [256, 1024, 16, true]);
  assert.equal(
    createHash('sha256').update(new Uint8Array(decoded.data.buffer)).digest('hex'),
    'a6e9d32143339d3f5748b5520aa4e6c6ffb3550b6f71fdf17bdb2ebb44bc2611',
  );
});

test('the DICOM 12-bit lossy sample NM1_JPLY reads, with its sequential scan header of zeros', () => {
  // The set's lossy encoder wrote Ss = Se = 0 in sequential scans, which a sequential decoder has no use for. The digest
  // was within one level of libjpeg-turbo 3.2.1's floating point decode of the file with those bytes set to 0, 63, 0.
  const decoded = decodeJPEGSamples(encapsulatedFrame(file('jpeg-dicom/JPEG-lossy.dcm')));
  assert.deepEqual([decoded.width, decoded.height, decoded.precision, decoded.lossless], [256, 1024, 12, false]);
  assert.equal(
    createHash('sha256').update(new Uint8Array(decoded.data.buffer)).digest('hex'),
    '3e571988ed84a9d29e90c0fcf1e77636d27b374b69aa20f6bd317d88518710b3',
  );
});

const planes = (width, height, precision, factors, seed = 0) => {
  const maxH = Math.max(...factors.map(([h]) => h)),
    maxV = Math.max(...factors.map(([, v]) => v));
  return factors.map(([h, v], c) => {
    const made = image({
      width: Math.ceil((width * h) / maxH),
      height: Math.ceil((height * v) / maxV),
      precision,
      smooth: (c + seed) % 2 === 0,
    });
    return { h, v, samples: made.data };
  });
};

test('long Huffman codes, difference category 16 and every selection value decode exactly', () => {
  for (const table of ['flat', 'long'])
    for (let predictor = 1; predictor <= 7; predictor++) {
      const components = planes(41, 13, 16, [[1, 1]], 1),
        bytes = encodeLossless({
          width: 41,
          height: 13,
          precision: 16,
          components,
          scans: [{ components: [0], predictor, table }],
        });
      assert.deepEqual(decodeJPEGSamples(bytes).data, components[0].samples, `${table} ${predictor}`);
    }
});

test('one scan per component, each with its predictor, point transform, table and restart interval', () => {
  const components = planes(19, 11, 12, [
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ]),
    bytes = encodeLossless({
      width: 19,
      height: 11,
      precision: 12,
      components,
      scans: [
        { components: [2], predictor: 7, rows: 1 },
        { components: [0], predictor: 4, transform: 3, table: 'long' },
        { components: [1, 3], predictor: 6, rows: 4 },
      ],
    }),
    decoded = decodeJPEGSamples(bytes);
  assert.equal(decoded.components, 4);
  for (let c = 0; c < 4; c++)
    for (let i = 0; i < 19 * 11; i++)
      assert.equal(
        decoded.data[i * 4 + c],
        c === 0 ? components[c].samples[i] & ~7 : components[c].samples[i],
        `${c} ${i}`,
      );
});

test('subsampled lossless components decode exactly where stored and filter up between', () => {
  // 21 x 9 is not a whole number of 2 x 2 MCUs, so the interleaved scan pads both ways.
  for (const rows of [0, 1, 2])
    for (const predictor of [1, 4, 7]) {
      const components = planes(21, 9, 8, [
          [2, 2],
          [1, 1],
          [1, 1],
        ]),
        bytes = encodeLossless({
          width: 21,
          height: 9,
          precision: 8,
          components,
          scans: [{ components: [0, 1, 2], predictor, rows }],
        }),
        decoded = decodeJPEGSamples(bytes);
      for (let i = 0; i < 21 * 9; i++) assert.equal(decoded.data[i * 3], components[0].samples[i], `luma ${i}`);
      // A constant corner: the first output sample of a half-size component is its first stored sample.
      assert.equal(decoded.data[1], components[1].samples[0]);
      assert.equal(decoded.data[2], components[2].samples[0]);
    }
  // Constant half-size components stay constant, whatever the MCU padding holds.
  const components = planes(7, 5, 8, [
    [2, 2],
    [1, 1],
    [1, 1],
  ]);
  components[1].samples.fill(40);
  components[2].samples.fill(200);
  const decoded = decodeJPEGSamples(encodeLossless({ width: 7, height: 5, precision: 8, components }));
  for (let i = 0; i < 35; i++) assert.deepEqual([...decoded.data.subarray(i * 3 + 1, i * 3 + 3)], [40, 200]);
});

test('a lossless file with a JFIF marker converts from YCbCr, one without is RGB', () => {
  const components = [100, 90, 200].map((value) => ({ samples: new Uint16Array(4).fill(value) })),
    plain = encodeLossless({ width: 2, height: 2, precision: 8, components }),
    marked = encodeLossless({ width: 2, height: 2, precision: 8, components, jfif: true });
  assert.deepEqual([...decodeJPEG(plain).data.subarray(0, 4)], [100, 90, 200, 255]);
  // JFIF: R = Y + 1.402 (Cr - 128), G = Y - 0.344136 (Cb - 128) - 0.714136 (Cr - 128), B = Y + 1.772 (Cb - 128).
  assert.deepEqual([...decodeJPEG(marked).data.subarray(0, 4)], [201, 62, 33, 255]);
});

test('TIFF pages hold 12-bit DCT and 16-bit lossless JPEG strips at their precision', () => {
  for (const [name, bits, photometric] of [
    ['dct12-grey', 12, 1],
    ['dct12-rgb', 12, 2],
    ['rgb16-sv6', 16, 2],
    ['grey12-sv6-restart', 12, 1],
    // Fewer bits than the page stores: allowed for lossless data.
    ['grey12-sv7-point2', 16, 1],
  ]) {
    const entry = cases[name],
      { width, height, components } = image(entry),
      bytes = tiff({
        width,
        height,
        spp: components,
        bits,
        photometric,
        compression: 7,
        samples: [],
        raw: [turbo(name)],
      }),
      expected = decodeJPEGSamples(turbo(name)).data,
      page = openTIFF(bytes).read(0);
    assert.equal(page.bits, bits);
    assert.deepEqual(page.samples, expected, name);
    const picture = parseTIFF(bytes);
    for (let i = 0; i < width * height; i++)
      assert.equal(
        picture.data[i * 4],
        Math.round((expected[i * components] * 255) / (2 ** bits - 1)),
        `${name} pixel ${i}`,
      );
  }
});

test('DNG-style tiles: a two-component lossless frame at half width, or doubled and half as high, fills the tile', () => {
  const width = 40,
    height = 24,
    samples = image({ width, height, precision: 14 }).data;
  const tiles = (frameWidth, frameHeight, count) => {
    const raw = [];
    for (let ty = 0; ty < 2; ty++)
      for (let tx = 0; tx < 3; tx++) {
        // 16 x 16 tiles; the last column and row hang over the edge and repeat it.
        const tile = new Uint16Array(256);
        for (let y = 0; y < 16; y++)
          for (let x = 0; x < 16; x++)
            tile[y * 16 + x] = samples[Math.min(ty * 16 + y, height - 1) * width + Math.min(tx * 16 + x, width - 1)];
        const components = Array.from({ length: count }, (_, c) => ({
          samples: tile.filter((_, i) => i % count === c),
        }));
        raw.push(encodeLossless({ width: frameWidth, height: frameHeight, precision: 14, components }));
      }
    return tiff({ width, height, spp: 1, bits: 14, photometric: 32803, compression: 7, tile: [16, 16], samples, raw });
  };
  for (const [w, h, count] of [
    [8, 16, 2],
    [32, 8, 1],
    [16, 8, 2],
    [4, 16, 4],
  ])
    assert.deepEqual(openTIFF(tiles(w, h, count)).read(0).samples, samples, `${w} x ${h} x ${count}`);
});

test('TIFF refuses a JPEG strip whose precision or shape does not fit the page', () => {
  const page = (bits, strip, spp = 1) =>
    tiff({
      width: 37,
      height: 23,
      spp,
      bits,
      photometric: spp === 1 ? 1 : 2,
      compression: 7,
      samples: [],
      raw: [strip],
    });
  assert.throws(() => parseTIFF(page(8, turbo('dct12-grey'))), /12-bit JPEG frame in a 8-bit/);
  assert.throws(() => parseTIFF(page(16, turbo('dct12-grey'))), /12-bit JPEG frame in a 16-bit/);
  assert.throws(() => openTIFF(page(8, turbo('grey16-sv1'))).read(0), /16-bit JPEG frame in a 8-bit/);
  assert.throws(() => parseTIFF(page(8, turbo('rgb8-sv1'))), /3 components for 1/);
  assert.throws(() => parseTIFF(page(24, turbo('grey8-sv1'))), /not supported/);
});

test('unsupported JPEG variants are refused with the code unsupported', () => {
  const whole = turbo('grey8-sv1'),
    frame = whole.findIndex((byte, i) => byte === 0xff && whole[i + 1] === 0xc3),
    changed = (offset, value) => {
      const bytes = whole.slice();
      bytes[frame + offset] = value;
      return bytes;
    },
    refused = (bytes, message) =>
      assert.throws(
        () => decodeJPEGSamples(bytes),
        (error) => error.code === 'unsupported' && message.test(error.message),
        String(message),
      );
  for (const marker of [0xc5, 0xc6, 0xc7, 0xde]) refused(changed(1, marker), /hierarchical/);
  for (const marker of [0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf]) refused(changed(1, marker), /arithmetic/);
  // Precisions each process does not have.
  for (const precision of [1, 17]) refused(changed(4, precision), /-bit samples are not read/);
  for (const [marker, precision] of [
    [0xc0, 12],
    [0xc1, 10],
    [0xc2, 16],
  ]) {
    const bytes = changed(1, marker);
    bytes[frame + 4] = precision;
    refused(bytes, new RegExp(`${precision}-bit samples are not read`));
  }
  // No height until a DNL marker.
  const open = changed(5, 0);
  open[frame + 6] = 0;
  refused(open, /DNL/);
  const five = encodeLossless({
    width: 2,
    height: 2,
    precision: 8,
    components: Array.from({ length: 5 }, () => ({ samples: new Uint16Array(4) })),
    scans: [{ components: [0, 1, 2, 3, 4] }],
  });
  refused(five, /5 components/);
});

test('damaged lossless files end in a coded error, never a wrong size, a crash or a hang', () => {
  const whole = turbo('grey12-sv6-restart'),
    scan = whole.findIndex((byte, i) => byte === 0xff && whole[i + 1] === 0xda),
    failed = (bytes, message) =>
      assert.throws(
        () => decodeJPEGSamples(bytes),
        (error) => error.code === 'failed' && message.test(error.message),
        String(message),
      );
  // Cut one byte of entropy data and more, with no end marker: every cut is noticed.
  for (const cut of [3, 4, 40, 400]) {
    const short = turbo('grey16-sv1');
    failed(short.subarray(0, short.length - cut), /less data/);
  }
  for (const [offset, value, message] of [
    // Selection value 0 belongs to hierarchical files, 8 does not exist.
    [7, 0, /scan header/],
    [7, 8, /scan header/],
    // Se and Ah must be 0, and the point transform below the precision.
    [8, 1, /scan header/],
    [9, 0x10, /scan header/],
    [9, 12, /scan header/],
  ]) {
    const bytes = whole.slice();
    bytes[scan + offset] = value;
    failed(bytes, message);
  }
  const interval = whole.slice(),
    dri = interval.findIndex((byte, i) => byte === 0xff && interval[i + 1] === 0xdd);
  interval[dri + 5] -= 1;
  failed(interval, /whole number of lines/);
  // A component no scan covers.
  const components = planes(8, 8, 8, [
    [1, 1],
    [1, 1],
  ]);
  failed(encodeLossless({ width: 8, height: 8, precision: 8, components, scans: [{ components: [0] }] }), /no scan/);
  // A file cut right after an 0xFF byte of entropy data has ended: it once read as endless zeros.
  for (const [name, from] of [
    ['dct12-grey-restart', 'dct12-grey-restart'],
    ['grey16-sv1', 'grey16-sv1'],
  ]) {
    const original = turbo(name),
      start = original.findIndex((byte, i) => byte === 0xff && original[i + 1] === 0xda),
      stuffed = original.findIndex((byte, i) => i > start + 20 && byte === 0xff && original[i + 1] === 0);
    assert.ok(stuffed > 0 && stuffed < original.length - 40, `${from} has a stuffed byte well inside its data`);
    failed(original.subarray(0, stuffed + 1), /less data|restart marker/);
  }
  assert.throws(() => decodeJPEGSamples(whole, { maxPixels: 100 }), RangeError);
  // A fixed sequence of damage, so a failure here repeats.
  let state = 987654321;
  const next = (limit) => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 8) % limit;
  };
  for (const name of ['grey12-sv6-restart', 'rgb16-sv6', 'dct12-ycbcr-420', 'dct12-grey-progressive']) {
    const original = turbo(name);
    for (let round = 0; round < 300; round++) {
      const bytes = original.slice();
      for (let hit = 0; hit <= next(8); hit++) bytes[2 + next(bytes.length - 2)] = next(256);
      try {
        const decoded = decodeJPEGSamples(bytes, { maxPixels: 2 ** 16 });
        assert.equal(decoded.data.length, decoded.width * decoded.height * decoded.components);
      } catch (error) {
        assert.ok(error instanceof RangeError || error.code !== undefined, `${name} round ${round}: ${error.stack}`);
      }
    }
  }
});
