// compressLAZ and writeLAZ. The oracle is LASzip's own output: each real file in fixtures/laz (fixtures/NOTICE.md) is
// decompressed to LAS and compressed again, and the compressed points and the chunk table must be the file's bytes.
// Round trips go back through Margo's reader.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseLAS, readLASHeader, writeLAS } from '../dist/las.js';
import { lazChunks, lazInfo } from '../dist/laz.js';
import { compressLAZ, writeLAZ } from '../dist/laz-write.js';

const folder = new URL('./fixtures/laz/', import.meta.url);
const read = (name) => new Uint8Array(readFileSync(new URL(`${name}.laz`, folder)));
const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** The records of a compressed file, chunk by chunk. */
async function decompressed(file) {
  const { header, records } = readLASHeader(file),
    blocks = [];
  for await (const block of lazChunks(file, header, records)) blocks.push(block.slice());
  return { header, records, blocks };
}

/** The uncompressed LAS file a LAZ file holds: its header and records without LASzip's, then the points. */
function asLAS(file, header, blocks) {
  const view = viewOf(file),
    headerSize = view.getUint16(94, true),
    kept = [];
  let at = headerSize;
  for (let i = 0; i < view.getUint32(100, true); i++) {
    const size = 54 + view.getUint16(at + 20, true);
    if (view.getUint16(at + 18, true) !== 22204) kept.push(file.subarray(at, at + size));
    at += size;
  }
  const head = Buffer.concat([file.subarray(0, headerSize), ...kept]),
    start = head.length;
  head.writeUInt32LE(start, 96);
  head.writeUInt32LE(kept.length, 100);
  head.writeUInt8(header.pointFormat, 104);
  // Extended records follow the points.
  const points = Buffer.concat(blocks),
    extended = header.versionMinor >= 4 && view.getUint32(243, true) ? Number(view.getBigUint64(235, true)) : 0,
    tail = extended ? file.subarray(extended) : new Uint8Array(0);
  if (extended) head.writeBigUInt64LE(BigInt(start + points.length), 235);
  if (header.versionMinor >= 3 && headerSize >= 235) head.writeBigUInt64LE(0n, 227);
  return new Uint8Array(Buffer.concat([head, points, tail]));
}

/** The compressed points and the chunk table of a LAZ file, apart from where they start. */
function compressed(file) {
  const view = viewOf(file),
    start = view.getUint32(96, true),
    table = Number(view.getBigInt64(start, true)),
    extended = file[25] >= 4 && view.getUint32(243, true) ? Number(view.getBigUint64(235, true)) : file.length;
  return {
    points: Buffer.from(file.subarray(start + 8, table)),
    table: Buffer.from(file.subarray(table, extended)),
  };
}

const REAL = [
  'point10',
  'point-time',
  'point-color',
  'point-time-color',
  'extra-bytes',
  'simple.copc',
  'append-bug',
  'fullwave',
  'laszip-format4',
  'laszip-format5',
  'laszip-format9',
  'laszip-channels-format7',
  'laszip-channels-format8',
  'laszip-channels-format9',
  'laszip-channels-format10',
  '../USGS_LPC_MT_Statewide_Phase3_2021_B21_568232',
];

for (const name of REAL) {
  test(`${name}: the compressed points and chunk table are LASzip's bytes`, async () => {
    const theirs = read(name),
      { header, records, blocks } = await decompressed(theirs),
      info = lazInfo(records),
      las = asLAS(theirs, header, blocks),
      options =
        info.chunkSize === 'variable'
          ? { chunks: blocks.map((block) => block.length / header.pointRecordLength) }
          : { chunkSize: info.chunkSize },
      mine = compressLAZ(las, options),
      want = compressed(theirs),
      got = compressed(mine);
    assert.equal(got.points.length, want.points.length);
    assert.ok(got.points.equals(want.points), 'compressed points');
    assert.ok(got.table.equals(want.table.subarray(0, got.table.length)), 'chunk table');
    assert.deepEqual(lazInfo(readLASHeader(mine).records).items, info.items, 'the LASzip record names the same items');
    const again = await decompressed(mine);
    assert.ok(Buffer.concat(again.blocks).equals(Buffer.concat(blocks)), 'the records read back');
  });
}

/** A LAS file of `count` records of a format, with extra bytes, whose fields wander and jump the way real ones can. */
function noisy(format, count, extra = 3) {
  const base = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67][format],
    length = base + extra,
    head = writeLAS({ positions: [], pointFormat: format, versionMinor: format >= 6 ? 4 : 3 }),
    file = new Uint8Array(head.length + count * length),
    view = viewOf(file);
  file.set(head);
  view.setUint16(105, length, true);
  if (format >= 6) view.setBigUint64(247, BigInt(count), true);
  else view.setUint32(107, count, true);
  let seed = 7 + format;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  // Slow fields with jumps: most points keep a byte, some replace it, so every coder path is taken.
  const record = new Uint8Array(length);
  for (let i = 0; i < count; i++) {
    for (let b = 0; b < length; b++) {
      const roll = random() % 100;
      if (i === 0 || roll < 3) record[b] = random() >>> 24;
      else if (roll < 20) record[b] = (record[b] + (random() % 3) - 1) & 255;
    }
    file.set(record, head.length + i * length);
  }
  return file;
}

test('every format with extra bytes, any chunking, reads back byte for byte', async () => {
  for (let format = 0; format <= 10; format++) {
    const las = noisy(format, 900),
      start = viewOf(las).getUint32(96, true);
    for (const options of [{}, { chunkSize: 1 }, { chunkSize: 128 }, { chunks: [1, 600, 2, 297] }]) {
      const laz = compressLAZ(las, options),
        { blocks, header } = await decompressed(laz);
      assert.equal(header.pointFormat, format);
      assert.ok(Buffer.concat(blocks).equals(Buffer.from(las.subarray(start))), `format ${format}`);
      if (options.chunks)
        assert.deepEqual(
          blocks.map((block) => block.length / header.pointRecordLength),
          options.chunks,
        );
    }
  }
});

test('writeLAZ keeps positions, attributes, the CRS and extra bytes, through the reader', async () => {
  const count = 5000,
    input = {
      positions: Float64Array.from({ length: count * 3 }, (_, i) => Math.sin(i) * 100 + (i % 3) * 1000),
      rgb: Uint16Array.from({ length: count * 3 }, (_, i) => (i * 257) & 65535),
      intensity: Uint16Array.from({ length: count }, (_, i) => i),
      gpsTime: Float64Array.from({ length: count }, (_, i) => 1e8 + i * 1e-5),
      classification: Uint8Array.from({ length: count }, (_, i) => i % 7),
      extra: { amplitude: Float64Array.from({ length: count }, (_, i) => i / 3) },
      wkt: 'GEOGCS["WGS 84"]',
    },
    laz = writeLAZ(input),
    plain = await parseLAS(writeLAS(input)),
    packed = await parseLAS(laz);
  assert.ok(laz.length < writeLAS(input).length / 2, `${laz.length} bytes`);
  for (const field of ['positions', 'rgb', 'intensity', 'gpsTime', 'classification', 'returnNumber', 'pointSourceId'])
    assert.deepEqual(packed[field], plain[field], field);
  assert.deepEqual(packed.extra, plain.extra);
  assert.equal(packed.crs.wkt, 'GEOGCS["WGS 84"]');
});

test('an empty cloud compresses and reads back', async () => {
  for (const format of [0, 6]) {
    const laz = writeLAZ({ positions: [], pointFormat: format, versionMinor: format ? 4 : 2 });
    assert.equal((await parseLAS(laz)).count, 0);
  }
});

test('extended records and waveform packets move behind the chunk table, their header offsets with them', async () => {
  const las = noisy(9, 40, 0),
    extended = new Uint8Array(60 + 5).fill(9),
    file = new Uint8Array(las.length + extended.length),
    view = viewOf(file);
  file.set(las);
  file.set(extended, las.length);
  view.setBigUint64(227, BigInt(las.length), true);
  view.setBigUint64(235, BigInt(las.length), true);
  view.setUint32(243, 1, true);
  const laz = compressLAZ(file),
    out = viewOf(laz),
    at = Number(out.getBigUint64(235, true));
  assert.equal(at, laz.length - extended.length);
  assert.equal(Number(out.getBigUint64(227, true)), at);
  assert.deepEqual([...laz.subarray(at)], [...extended]);
  view.setBigUint64(235, 5n, true);
  assert.throws(() => compressLAZ(file), TypeError);
});

test('bad input and options are refused', () => {
  const las = writeLAS({ positions: [0, 0, 0, 1, 1, 1] });
  assert.throws(() => compressLAZ(compressLAZ(las)), /already compressed/);
  assert.throws(() => compressLAZ(las.subarray(0, las.length - 1)), TypeError);
  for (const options of [
    { chunkSize: 0 },
    { chunkSize: 1.5 },
    { chunkSize: 0xffffffff },
    { chunks: [1] },
    { chunks: [0, 2] },
    { chunks: [2], chunkSize: 2 },
  ])
    assert.throws(() => compressLAZ(las, options), RangeError, JSON.stringify(options));
});
