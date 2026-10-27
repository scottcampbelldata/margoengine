// LAZ decoder tests. No LAZ file from the reference LASzip is available here (no downloads approved), so every file
// comes from tests/laz-encoder.js, a separate encoder written from the same public description. A round trip proves
// that the decoder inverts that reading of the specification; it does not prove byte compatibility with LASzip.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLAS, readLASHeader, writeLAS } from '../dist/las.js';
import { createLazDecoder, lazChunks, lazInfo } from '../dist/laz.js';
import { encodeLAZ } from './laz-encoder.js';

const BASE = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** A LAS file of `n` points whose every record byte comes from `fill(view, at, i, format)`. */
function lasFile(format, n, fill, extraBytes = 0) {
  const head = writeLAS({ positions: new Float64Array(n * 3), pointFormat: format, versionMinor: format >= 6 ? 4 : 2 });
  const { header } = readLASHeader(head),
    length = BASE[format] + extraBytes,
    file = new Uint8Array(header.pointDataOffset + n * length);
  // Undocumented extra bytes (no LASF_Spec record 4): any count, kept in the record but not decoded by name.
  file.set(head.subarray(0, header.pointDataOffset));
  new DataView(file.buffer).setUint16(105, length, true);
  const view = new DataView(file.buffer, header.pointDataOffset);
  for (let i = 0; i < n; i++) fill(view, i * length, i, format, length);
  return file;
}

/** Every byte random: the coder's extremes (32-bit jumps, every return code, NaN GPS bit patterns). */
const randomFill = (seed) => {
  const random = rng(seed);
  return (view, at, _i, _f, length) => {
    for (let b = 0; b < length; b++) view.setUint8(at + b, Math.floor(random() * 256));
  };
};

/** An airborne-like survey: scan lines, multiple returns, slow attributes, GPS time with gaps and interleaved lines. */
const surveyFill = (seed) => {
  const random = rng(seed);
  let x = 1_000_000,
    y = 2_000_000,
    z = 50_000,
    gps = 300_000.5,
    returns = 1,
    ret = 1,
    cls = 2,
    source = 7,
    angle = 0,
    direction = 1,
    channel = 0,
    r = 30_000,
    g = 31_000,
    b = 29_000,
    nir = 1000;
  return (view, at, i, format, length) => {
    const extended = format >= 6;
    if (ret >= returns) {
      // A new pulse.
      returns = random() < 0.7 ? 1 : 1 + Math.floor(random() * (extended ? 6 : 5));
      if (extended && random() < 0.01) returns = 8 + Math.floor(random() * 8);
      ret = 1;
      gps += random() < 0.002 ? 1e4 * random() : 1e-5;
      x += 25 + Math.floor(random() * 10);
      angle += direction * (extended ? 50 : 1);
      if (Math.abs(angle) > (extended ? 3000 : 20)) direction = -direction;
      if (random() < 0.002) y += 5000; // next scan line
      if (extended && random() < 0.05) channel = (channel + 1 + Math.floor(random() * 3)) & 3;
    } else ret++;
    z += Math.round((random() - 0.5) * 40) - (ret > 1 ? 300 : 0);
    if (random() < 0.02) cls = [1, 2, 3, 5, 6, 9, extended ? 64 : 17][Math.floor(random() * 7)];
    if (random() < 0.001) source++;
    if (random() < 0.3) r = Math.max(0, Math.min(65535, r + Math.round((random() - 0.5) * 2000)));
    if (random() < 0.3) g = Math.max(0, Math.min(65535, g + Math.round((random() - 0.5) * 2000)));
    if (random() < 0.3) b = Math.max(0, Math.min(65535, b + Math.round((random() - 0.5) * 2000)));
    const grey = i % 97 < 10;
    if (random() < 0.2) nir = (nir + Math.floor(random() * 300)) & 0xffff;
    view.setInt32(at, x + (ret - 1) * 3, true);
    view.setInt32(at + 4, y + Math.round(random() * 4), true);
    view.setInt32(at + 8, z, true);
    view.setUint16(at + 12, Math.floor(200 + random() * 600) >> (ret - 1 > 3 ? 3 : ret - 1), true);
    if (extended) {
      view.setUint8(at + 14, (ret & 15) | ((returns & 15) << 4));
      view.setUint8(at + 15, (i % 500 === 0 ? 2 : 0) | (channel << 4) | ((direction > 0 ? 1 : 0) << 6));
      view.setUint8(at + 16, cls);
      view.setUint8(at + 17, i % 1000 < 3 ? 77 : 0);
      view.setInt16(at + 18, angle, true);
      view.setUint16(at + 20, source, true);
      view.setFloat64(at + 22, gps + channel * 0.25, true);
    } else {
      view.setUint8(at + 14, (ret & 7) | ((returns & 7) << 3) | ((direction > 0 ? 1 : 0) << 6));
      view.setUint8(at + 15, cls & 31);
      view.setInt8(at + 16, angle);
      view.setUint8(at + 17, 0);
      view.setUint16(at + 18, source, true);
    }
    const gpsAt = [-1, 20, -1, 20][format];
    if (gpsAt > 0) view.setFloat64(at + gpsAt, gps + (i % 4000 < 2000 ? 0 : 5e6), true);
    const rgbAt = [-1, -1, 20, 28, -1, -1, -1, 30, 30][format];
    if (rgbAt > 0) {
      view.setUint16(at + rgbAt, r, true);
      view.setUint16(at + rgbAt + 2, grey ? r : g, true);
      view.setUint16(at + rgbAt + 4, grey ? r : b, true);
    }
    if (format === 8) view.setUint16(at + 36, nir, true);
    for (let k = BASE[format]; k < length; k++) view.setUint8(at + k, k === BASE[format] && i % 50 === 0 ? i & 255 : 3);
  };
};

/**
 * Mixed statistics, for the context choices: coordinate steps of every magnitude (so the bit-length contexts mix),
 * user data and classes drawn from a few skewed values (so their per-context models adapt), and runs of repeated
 * points with zero intensity (the "nothing changed" code right after a chunk's first point).
 */
const mixedFill = (seed) => {
  const random = rng(seed),
    previous = new Uint8Array(67);
  return (view, at, i, format, length) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset + at, length);
    if (i % 5 !== 0 && random() < 0.3) {
      bytes.set(previous.subarray(0, length));
      view.setUint16(at + 12, 0, true);
      previous.set(bytes);
      return;
    }
    for (let b = 0; b < length; b++) bytes[b] = Math.floor(random() * 256);
    const scale = 2 ** Math.floor(random() * 31);
    for (let c = 0; c < 3; c++) view.setInt32(at + c * 4, Math.floor((random() - 0.5) * scale), true);
    const skewed = () => [0, 0, 0, 1, 4, 5, 9, 200][Math.floor(random() * 8)];
    if (format >= 6) {
      view.setUint8(at + 16, skewed());
      view.setUint8(at + 17, skewed() * 4 + (i & 3));
    } else {
      view.setUint8(at + 15, skewed() & 31);
      view.setUint8(at + 17, skewed());
    }
    previous.set(bytes);
  };
};

/** The uncompressed records `lazChunks` yields, joined. */
async function decodeRecords(laz, options) {
  const { header, records } = readLASHeader(laz),
    blocks = [];
  for await (const block of lazChunks(laz, header, records, options)) blocks.push(block);
  const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return { out, blocks };
}

const recordsOf = (las) => las.subarray(readLASHeader(las).header.pointDataOffset);

async function roundTrip(las, options, label) {
  const laz = encodeLAZ(las, options),
    { out, blocks } = await decodeRecords(laz),
    expected = recordsOf(las);
  assert.equal(out.length, expected.length, `${label}: record bytes`);
  const length = readLASHeader(las).header.pointRecordLength;
  for (let i = 0; i < out.length; i++)
    if (out[i] !== expected[i])
      assert.fail(`${label}: point ${Math.floor(i / length)} byte ${i % length} is ${out[i]}, expected ${expected[i]}`);
  return { laz, blocks };
}

const formats = [0, 1, 2, 3, 6, 7, 8];

test('LAZ round trip: random records of every supported format, with and without extra bytes', async () => {
  for (const format of formats)
    for (const extraBytes of [0, 3, 8]) {
      const las = lasFile(format, 3000, randomFill(format * 31 + extraBytes), extraBytes);
      await roundTrip(las, { chunkSize: 1000 }, `random format ${format} extra ${extraBytes}`);
    }
});

test('LAZ round trip: structured surveys (returns, GPS sequences, scanner channels, colour) in several chunk sizes', async () => {
  for (const format of formats)
    for (const chunkSize of [1, 2, 7, 1000, 50_000]) {
      const n = chunkSize < 10 ? 300 : 4000,
        las = lasFile(format, n, surveyFill(format + chunkSize), format === 3 || format === 7 ? 2 : 0);
      const { laz, blocks } = await roundTrip(las, { chunkSize }, `survey format ${format} chunks of ${chunkSize}`);
      assert.equal(blocks.length, Math.ceil(n / chunkSize), 'one block per chunk');
      if (chunkSize === 50_000) assert.ok(laz.length < las.length / 2, `format ${format} compresses (${laz.length})`);
    }
});

test('LAZ round trip: mixed statistics (every step size, skewed attributes, repeated points) in large chunks', async () => {
  for (const format of formats)
    for (const chunkSize of [2, 3, 20_000]) {
      const las = lasFile(format, chunkSize < 10 ? 600 : 20_000, mixedFill(format * 7 + chunkSize), 1);
      await roundTrip(las, { chunkSize }, `mixed format ${format} chunks of ${chunkSize}`);
    }
});

test('LAZ: variable chunks, the chunk table offset stored at the end, and an empty file', async () => {
  for (const format of [1, 7]) {
    const las = lasFile(format, 2500, surveyFill(5));
    const { blocks } = await roundTrip(las, { chunks: [1, 999, 3, 1497] }, `variable chunks format ${format}`);
    assert.deepEqual(
      blocks.map((b) => b.length / readLASHeader(las).header.pointRecordLength),
      [1, 999, 3, 1497],
    );
    await roundTrip(las, { chunkSize: 600, tableAtEnd: true }, `table at end format ${format}`);
  }
  const empty = lasFile(6, 0, () => {});
  const las = await parseLAS(encodeLAZ(empty), { laz: createLazDecoder() });
  assert.equal(las.count, 0);
});

test('parseLAS with createLazDecoder matches the uncompressed file, with stride, maxPoints and every attribute', async () => {
  for (const format of formats) {
    const las = lasFile(format, 5000, surveyFill(format), 8),
      laz = encodeLAZ(las, { chunkSize: 1234 });
    for (const options of [{}, { stride: 7 }, { maxPoints: 1500 }, { stride: 3, maxPoints: 1000 }]) {
      const a = await parseLAS(las, options),
        b = await parseLAS(laz, { ...options, laz: createLazDecoder() });
      assert.equal(b.count, a.count);
      assert.equal(b.header.compressed, true);
      for (const key of Object.keys(a)) {
        if (['header', 'records', 'crs', 'extraBytes', 'origin', 'count'].includes(key) || !a[key]) continue;
        if (key === 'extra') {
          for (const name of Object.keys(a.extra)) assert.deepEqual(b.extra[name], a.extra[name], `${format} ${name}`);
        } else assert.deepEqual(b[key], a[key], `format ${format} ${key} ${JSON.stringify(options)}`);
      }
    }
  }
});

test('LAZ: the LASzip record is parsed, and what is not implemented throws a coded unsupported error', async () => {
  const las = lasFile(3, 100, surveyFill(1), 4),
    laz = encodeLAZ(las, { chunkSize: 50 }),
    info = lazInfo(readLASHeader(laz).records);
  assert.equal(info.compressor, 2);
  assert.equal(info.chunkSize, 50);
  assert.deepEqual(
    info.items.map((i) => `${i.name}:${i.size}:${i.version}`),
    ['POINT10:20:2', 'GPSTIME11:8:2', 'RGB12:6:2', 'BYTE:4:2'],
  );
  const laz8 = encodeLAZ(lasFile(8, 10, surveyFill(1)), { chunks: [4, 6] });
  assert.equal(lazInfo(readLASHeader(laz8).records).chunkSize, 'variable');
  const decoder = createLazDecoder();
  const unsupported = async (file, pattern) =>
    assert.rejects(parseLAS(file, { laz: decoder }), (e) => e.code === 'unsupported' && pattern.test(e.message));
  await unsupported(encodeLAZ(las, { override: { compressor: 1 } }), /compressor 1/);
  await unsupported(encodeLAZ(las, { override: { coder: 1 } }), /coder 1/);
  await unsupported(encodeLAZ(las, { override: { version: 1 } }), /POINT10 version 1/);
  // Waveform formats (4, 5, 9, 10): the record lists a WAVEPACKET item.
  const wave = lasFile(4, 10, randomFill(2));
  await unsupported(
    encodeLAZ(wave, {
      override: {
        items: [
          [6, 20],
          [7, 8],
          [9, 29],
        ],
      },
    }),
    /WAVEPACKET13/,
  );
  const wave14 = lasFile(9, 10, randomFill(2));
  await unsupported(
    encodeLAZ(wave14, {
      override: {
        items: [
          [10, 30],
          [13, 29],
        ],
      },
    }),
    /WAVEPACKET14/,
  );
  // Items that do not match the point format are a malformed file.
  await assert.rejects(
    parseLAS(
      encodeLAZ(las, {
        override: {
          items: [
            [6, 20],
            [8, 6],
            [7, 8],
            [0, 4],
          ],
        },
      }),
      { laz: decoder },
    ),
    (e) => e instanceof TypeError && /do not match point format 3/.test(e.message),
  );
  // A LAZ without its LASzip record, and a plain LAS handed to lazChunks.
  const bare = writeLAS({ positions: new Float64Array(30), pointFormat: 0, versionMinor: 2 });
  bare[104] |= 0x80;
  await assert.rejects(
    parseLAS(bare, { laz: decoder }),
    (e) => e instanceof TypeError && /LASzip record/.test(e.message),
  );
  await assert.rejects(decodeRecords(las), (e) => e instanceof TypeError && /not compressed/.test(e.message));
});

test('parseLAS with a streaming decoder: blocks of any size, a stream that ends early, and an early stop', async () => {
  const las = lasFile(1, 1000, surveyFill(4)),
    { header } = readLASHeader(las),
    length = header.pointRecordLength,
    raw = recordsOf(las),
    laz = las.slice();
  laz[104] |= 0x80;
  let pulled = 0;
  const blocks = (sizes) =>
    async function* () {
      let at = 0;
      for (const n of sizes) {
        pulled++;
        yield raw.subarray(at * length, (at + n) * length);
        at += n;
      }
    };
  const whole = await parseLAS(las, { stride: 3 }),
    streamed = await parseLAS(laz, { stride: 3, laz: blocks([1, 2, 333, 0, 664]) });
  assert.deepEqual(streamed.positions, whole.positions);
  assert.deepEqual(streamed.gpsTime, whole.gpsTime);
  // A stream that stops early is a truncated file: a RangeError, or the points it held with `partial`.
  await assert.rejects(
    parseLAS(laz, { laz: blocks([400]) }),
    (e) => e instanceof RangeError && /partial/.test(e.message),
  );
  const partial = await parseLAS(laz, { partial: true, laz: blocks([400]) });
  assert.equal(partial.count, 400);
  assert.equal(partial.positions.length, 1200);
  assert.deepEqual([...partial.intensity], [...(await parseLAS(las)).intensity.subarray(0, 400)]);
  // maxPoints stops pulling blocks once it has its points.
  pulled = 0;
  assert.equal((await parseLAS(laz, { maxPoints: 5, laz: blocks([3, 3, 3, 991]) })).count, 5);
  assert.equal(pulled, 2);
});

test('LAZ: an AbortSignal stops decoding between chunks', async () => {
  const laz = encodeLAZ(lasFile(7, 20_000, surveyFill(9)), { chunkSize: 1000 }),
    { header, records } = readLASHeader(laz);
  await assert.rejects(
    parseLAS(laz, { laz: createLazDecoder(), signal: AbortSignal.abort() }),
    (e) => e.name === 'AbortError',
  );
  const controller = new AbortController(),
    chunks = lazChunks(laz, header, records, { signal: controller.signal });
  assert.equal((await chunks.next()).value.length, 1000 * header.pointRecordLength);
  controller.abort();
  await assert.rejects(chunks.next(), (e) => e.name === 'AbortError');
});

test('fuzz: corrupt and truncated LAZ only ever throws coded errors, never hangs or reads out of range', async () => {
  const random = rng(77),
    decoder = createLazDecoder(),
    started = performance.now();
  let decoded = 0,
    thrown = 0;
  for (const format of [1, 3, 6, 7, 8]) {
    const las = lasFile(format, 600, surveyFill(format), 2),
      laz = encodeLAZ(las, { chunkSize: format === 6 ? 100 : 250, chunks: format === 8 ? [1, 299, 300] : undefined }),
      start = readLASHeader(laz).header.pointDataOffset;
    for (let i = 0; i < 300; i++) {
      let bytes;
      if (i < 60) bytes = laz.slice(0, start + Math.floor(random() * (laz.length - start)));
      else {
        bytes = laz.slice();
        const flips = 1 + (i % 6);
        for (let k = 0; k < flips; k++) {
          // Mostly chunk data; some hits on the chunk table offset and the table itself.
          const at =
            k === 0 && i % 10 === 0
              ? start + Math.floor(random() * 8)
              : i % 7 === 0
                ? laz.length - 1 - Math.floor(random() * 24)
                : start + 8 + Math.floor(random() * (laz.length - start - 8));
          bytes[at] ^= 1 << Math.floor(random() * 8);
        }
      }
      try {
        const out = await parseLAS(bytes, { laz: decoder });
        assert.ok(out.count <= 600);
        decoded++;
      } catch (error) {
        thrown++;
        const coded = error?.name === 'MargoError' || error instanceof TypeError || error instanceof RangeError;
        assert.ok(coded, `${error?.name}: ${error?.message}`);
        // Our own messages, never a DataView or typed array bounds error.
        assert.match(error.message, /^(LAZ|LAS|LASzip)/, error.message);
      }
    }
  }
  assert.ok(thrown > 0 && decoded > 0, `${thrown} thrown, ${decoded} decoded`);
  assert.ok(performance.now() - started < 60_000);
});

test('property: random point counts, chunkings and seeds always round-trip byte for byte', async () => {
  const random = rng(2026);
  for (let trial = 0; trial < 24; trial++) {
    const format = formats[trial % formats.length],
      n = 1 + Math.floor(random() * 2500),
      fill = trial % 2 ? randomFill(trial) : surveyFill(trial),
      las = lasFile(format, n, fill, Math.floor(random() * 4)),
      chunked = random() < 0.5;
    const chunks = [];
    if (chunked)
      for (let left = n; left > 0; ) left -= chunks[chunks.push(Math.min(left, 1 + Math.floor(random() * 900))) - 1];
    await roundTrip(
      las,
      chunked ? { chunks } : { chunkSize: 1 + Math.floor(random() * 3000) },
      `trial ${trial} format ${format} n ${n}`,
    );
  }
});
