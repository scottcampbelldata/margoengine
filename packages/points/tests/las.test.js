import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import test from 'node:test';
import { LAS_RECORD_SIZES, decodePoints, lasCrs, parseLAS, readLASHeader, writeLAS } from '../dist/las.js';

/** A seeded synthetic survey: a sloped ground with buildings, in UTM-like metres far from the origin. */
function survey(n, seed = 3) {
  let s = seed;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const positions = new Float64Array(n * 3),
    intensity = new Uint16Array(n),
    classification = new Uint8Array(n),
    gpsTime = new Float64Array(n),
    rgb = new Uint16Array(n * 3),
    nir = new Uint16Array(n),
    returnNumber = new Uint8Array(n),
    numberOfReturns = new Uint8Array(n),
    height = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = 500_000 + random() * 800,
      y = 4_400_000 + random() * 600,
      building = random() < 0.2;
    positions.set([x, y, 100 + (x - 500_000) * 0.01 + (building ? 12 * random() : 0)], i * 3);
    intensity[i] = Math.floor(random() * 65535);
    classification[i] = building ? 6 : 2;
    gpsTime[i] = 300_000 + i * 1e-5;
    rgb.set([random() * 65535, random() * 65535, random() * 65535].map(Math.floor), i * 3);
    nir[i] = i % 65536;
    numberOfReturns[i] = 1 + (i % 3);
    returnNumber[i] = 1 + (i % numberOfReturns[i]);
    height[i] = building ? 5 + random() : 0.25;
  }
  return { positions, intensity, classification, gpsTime, rgb, nir, returnNumber, numberOfReturns, extra: { height } };
}

test('a header box that misses the points does not cost float32 precision', async () => {
  // Real files do this (simple1_3.las stores its box as raw integers). The points sit far from the box, 2 mm apart.
  const data = survey(50),
    file = writeLAS({ ...data, positions: data.positions.map((_, i) => 5_800_000 + (i % 3) * 7 + Math.floor(i / 3) * 0.002) });
  const v = new DataView(file.buffer, file.byteOffset);
  for (const at of [179, 187, 195, 203, 211, 219]) v.setFloat64(at, v.getFloat64(at, true) * 1000, true);
  for (const options of [{}, { origin: 'min' }]) {
    const las = await parseLAS(file, options);
    assert.deepEqual([...las.origin], [5_800_000, 5_800_007, 5_800_014]);
    assert.ok(Math.abs(las.positions[147] - 0.098) < 1e-5, 'the last point keeps its millimetres');
  }
  const given = await parseLAS(file, { origin: [1, 2, 3] });
  assert.deepEqual([...given.origin], [1, 2, 3], 'an origin the caller gave is kept');
});

test('a sound header box gives its centre, or its minimum corner', async () => {
  const file = writeLAS(survey(50)),
    { header } = readLASHeader(file);
  assert.deepEqual([...(await parseLAS(file, { origin: 'min' })).origin], [...header.min]);
  assert.deepEqual([...(await parseLAS(file)).origin], [0, 1, 2].map((i) => (header.min[i] + header.max[i]) / 2));
});

test('LAS round trip: every point format 0 to 10 through writeLAS and parseLAS', async () => {
  const data = survey(500);
  for (let format = 0; format <= 10; format++) {
    const versionMinor = format >= 6 ? 4 : format >= 4 ? 3 : 2;
    const file = writeLAS({
      ...data,
      pointFormat: format,
      versionMinor,
      wkt: 'PROJCS["WGS 84 / UTM zone 18N",AUTHORITY["EPSG","32618"]]',
    });
    const las = await parseLAS(file);
    assert.equal(las.header.pointFormat, format);
    assert.equal(las.header.pointRecordLength, LAS_RECORD_SIZES[format] + 8, 'one f64 extra bytes attribute');
    assert.equal(las.count, 500);
    for (let i = 0; i < 500; i++)
      for (let k = 0; k < 3; k++)
        assert.ok(
          Math.abs(las.positions[i * 3 + k] + las.origin[k] - data.positions[i * 3 + k]) <= 0.0006,
          `format ${format} point ${i}`,
        );
    assert.deepEqual([...las.intensity.slice(0, 20)], [...data.intensity.slice(0, 20)]);
    assert.deepEqual([...las.classification], [...data.classification]);
    assert.deepEqual([...las.returnNumber], [...data.returnNumber]);
    assert.deepEqual([...las.numberOfReturns], [...data.numberOfReturns]);
    if ([1, 3, 4, 5, 6, 7, 8, 9, 10].includes(format)) assert.deepEqual([...las.gpsTime], [...data.gpsTime]);
    else assert.equal(las.gpsTime, undefined);
    if ([2, 3, 5, 7, 8, 10].includes(format)) assert.deepEqual([...las.rgb], [...data.rgb]);
    else assert.equal(las.rgb, undefined);
    if (format === 8 || format === 10) assert.deepEqual([...las.nir], [...data.nir]);
    assert.deepEqual([...las.extra.height], [...data.extra.height], 'extra bytes');
    assert.equal(las.crs.epsg, 32618, 'EPSG from the WKT');
  }
});

// The file's own bytes by the tables of the LAS 1.4 specification, with no help from parseLAS. laspy 2 reads the same.
test('the written bytes hold the header fields and records the specification lays out', () => {
  const data = survey(200);
  for (const [format, minor, offsets] of [
    [3, 2, { flags: 14, classification: 15, gps: 20, rgb: 28 }],
    [7, 4, { flags: 14, classification: 16, gps: 22, rgb: 30 }],
  ]) {
    const { extra, ...plain } = data,
      file = writeLAS({ ...plain, pointFormat: format, versionMinor: minor }),
      view = new DataView(file.buffer, file.byteOffset, file.byteLength),
      f64 = (at) => view.getFloat64(at, true),
      first = view.getUint32(96, true),
      length = view.getUint16(105, true);
    assert.equal(String.fromCharCode(...file.subarray(0, 4)), 'LASF');
    assert.deepEqual([file[24], file[25]], [1, minor]);
    assert.equal(file[104], format);
    assert.equal(length, LAS_RECORD_SIZES[format]);
    assert.equal(minor === 4 ? Number(view.getBigUint64(247, true)) : view.getUint32(107, true), 200);
    assert.equal(file.length, first + 200 * length, 'the records end the file');
    const scale = [f64(131), f64(139), f64(147)],
      offset = [f64(155), f64(163), f64(171)];
    for (let i = 0; i < 200; i++) {
      const at = first + i * length;
      for (let k = 0; k < 3; k++) {
        const stored = view.getInt32(at + k * 4, true) * scale[k] + offset[k];
        assert.ok(Math.abs(stored - data.positions[i * 3 + k]) <= scale[k], `format ${format} point ${i}`);
      }
      assert.equal(view.getUint16(at + 12, true), data.intensity[i]);
      const flags = file[at + offsets.flags];
      assert.deepEqual(
        minor === 4 ? [flags & 15, flags >> 4] : [flags & 7, (flags >> 3) & 7],
        [data.returnNumber[i], data.numberOfReturns[i]],
      );
      assert.equal(file[at + offsets.classification] & 31, data.classification[i]);
      assert.equal(f64(at + offsets.gps), data.gpsTime[i]);
      for (let k = 0; k < 3; k++) assert.equal(view.getUint16(at + offsets.rgb + k * 2, true), data.rgb[i * 3 + k]);
    }
  }
});

test('LAS header: 1.4 64-bit counts, bounding box, CRS from GeoTIFF keys, partial reads, stride and maxPoints', async () => {
  const file = writeLAS({ ...survey(1000), epsg: 26918 });
  const { header, records } = readLASHeader(file);
  assert.equal(header.versionMinor, 4);
  assert.equal(header.pointCount, 1000);
  assert.ok(header.min[0] >= 500_000 && header.max[0] <= 500_800);
  assert.equal(lasCrs(records).epsg, 26918);
  const preview = await parseLAS(file, { stride: 10 });
  assert.equal(preview.count, 100);
  assert.equal((await parseLAS(file, { maxPoints: 7 })).count, 7);
  const cut = file.slice(0, file.length - 30 * header.pointRecordLength - 5);
  await assert.rejects(parseLAS(cut), (e) => e instanceof RangeError && /partial: true/.test(e.message));
  const partial = await parseLAS(cut, { partial: true });
  assert.equal(partial.count, 1000 - 31);
  // Float32 positions relative to the box centre keep millimetres 500 km from the origin.
  assert.ok(Math.max(...partial.positions.map(Math.abs)) < 1000);
});

test('LAZ: compressed files load the decoder by themselves; another plugs in through options.laz', async () => {
  const file = writeLAS(survey(50));
  file[104] |= 0x80; // the compression bit
  // No LASzip record here, so the decoder it loaded says so.
  await assert.rejects(parseLAS(file), (e) => e instanceof TypeError && /no LASzip record/.test(e.message));
  // A stand-in decoder that returns the (here already uncompressed) records.
  const las = await parseLAS(file, { laz: (bytes, header) => bytes.subarray(header.pointDataOffset) });
  assert.equal(las.count, 50);
  assert.equal(las.header.compressed, true);
});

test('fuzz: truncated and corrupt LAS never crashes or hangs; errors are TypeError, RangeError or coded', async () => {
  const file = writeLAS({ ...survey(64), wkt: 'GEOGCS["x"]', epsg: 4326 });
  let s = 11;
  const random = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const cpu = cpuTimer();
  for (let i = 0; i < 600; i++) {
    const bytes = i < 300 ? file.slice(0, Math.floor(random() * file.length)) : file.slice();
    if (i >= 300) for (let k = 0; k < 1 + (i % 8); k++) bytes[Math.floor(random() * 400)] = Math.floor(random() * 256);
    try {
      const las = await parseLAS(bytes, { partial: true, maxPoints: 1e6 });
      assert.ok(las.count <= 1e6);
    } catch (error) {
      assert.ok(
        error instanceof TypeError || error instanceof RangeError || error.name === 'MargoError',
        `${error?.name}: ${error?.message}`,
      );
    }
  }
  assert.ok(cpu() < 150);
});

test('decodePoints reads the records a LAZ decoder returns', () => {
  const file = writeLAS(survey(10));
  const { header, records } = readLASHeader(file);
  const points = decodePoints(header, records, file.subarray(header.pointDataOffset));
  assert.equal(points.count, 10);
});
