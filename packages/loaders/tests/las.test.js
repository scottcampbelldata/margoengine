// parseLAS: every point format, 1.2 and 1.4 headers, variable records, colours, limits and refusals, and real LAS and LAZ
// files read with no hook, every field against what LASzip decodes (packages/points/tests/fixtures/laz/records.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lasWaveDescriptors, lasWaveform } from '@margoengine/points/las';
import { parseLAS } from '../dist/las.js';
import { LoaderError } from '../dist/common.js';

const RECORD = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
const refuses = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof LoaderError && error.format === 'LAS' && error.code === code);

/** Writes a LAS file. Each point is `{ x, y, z, intensity, returnNumber, returnCount, classification, gps, rgb }`. */
function las({
  minor = 2,
  format = 0,
  points = [],
  scale = [0.01, 0.01, 0.01],
  offset = [0, 0, 0],
  min,
  extra = 0,
  vlrs = [],
  evlrs = [],
  compressed = false,
  body,
}) {
  const header = minor >= 4 ? 375 : minor === 3 ? 235 : 227,
    vlrSize = vlrs.reduce((n, vlr) => n + 54 + vlr.data.length, 0),
    size = RECORD[format] + extra,
    pointOffset = header + vlrSize,
    points_ = body ?? new Uint8Array(points.length * size),
    evlrStart = pointOffset + points_.length,
    evlrSize = evlrs.reduce((n, vlr) => n + 60 + vlr.data.length, 0),
    out = new Uint8Array(evlrStart + evlrSize),
    v = new DataView(out.buffer);
  out.set(new TextEncoder().encode('LASF'), 0);
  out[24] = 1;
  out[25] = minor;
  out.set(new TextEncoder().encode('margo test'), 58);
  v.setUint16(94, header, true);
  v.setUint32(96, pointOffset, true);
  v.setUint32(100, vlrs.length, true);
  out[104] = format | (compressed ? 0x80 : 0);
  v.setUint16(105, size, true);
  if (minor < 4) v.setUint32(107, points.length, true);
  [...scale, ...offset].forEach((value, i) => v.setFloat64(131 + i * 8, value, true));
  // The box of the points, as a sound writer stores it, or from the given minimum corner up.
  const world = points.map((p) => [p.x, p.y, p.z].map((value, i) => value * scale[i] + offset[i]));
  [0, 1, 2].forEach((i) => {
    const along = world.map((p) => p[i]);
    v.setFloat64(187 + i * 16, min?.[i] ?? Math.min(0, ...along), true);
    v.setFloat64(179 + i * 16, Math.max(0, min?.[i] ?? 0, ...along), true);
  });
  if (minor >= 4) {
    v.setBigUint64(235, BigInt(evlrs.length ? evlrStart : 0), true);
    v.setUint32(243, evlrs.length, true);
    v.setBigUint64(247, BigInt(points.length), true);
  }
  let at = header;
  for (const { user, id, data } of vlrs) {
    out.set(new TextEncoder().encode(user), at + 2);
    v.setUint16(at + 18, id, true);
    v.setUint16(at + 20, data.length, true);
    out.set(new TextEncoder().encode('about'), at + 22);
    out.set(data, at + 54);
    at += 54 + data.length;
  }
  if (!body)
    points.forEach((p, i) => {
      const o = pointOffset + i * size,
        wide = format >= 6;
      v.setInt32(o, p.x, true);
      v.setInt32(o + 4, p.y, true);
      v.setInt32(o + 8, p.z, true);
      v.setUint16(o + 12, p.intensity ?? 0, true);
      out[o + 14] = wide
        ? (p.returnNumber ?? 1) | ((p.returnCount ?? 1) << 4)
        : (p.returnNumber ?? 1) | ((p.returnCount ?? 1) << 3);
      if (wide) out[o + 16] = p.classification ?? 0;
      else out[o + 15] = (p.classification ?? 0) | 0xe0;
      const gps = [-1, 20, -1, 20, 20, 20, 22, 22, 22, 22, 22][format],
        rgb = [-1, -1, 20, 28, -1, 28, -1, 30, 30, -1, 30][format];
      if (gps >= 0) v.setFloat64(o + gps, p.gps ?? 0, true);
      if (rgb >= 0) (p.rgb ?? [0, 0, 0]).forEach((value, c) => v.setUint16(o + rgb + c * 2, value, true));
    });
  else out.set(body, pointOffset);
  at = evlrStart;
  for (const { user, id, data } of evlrs) {
    out.set(new TextEncoder().encode(user), at + 2);
    v.setUint16(at + 18, id, true);
    v.setBigUint64(at + 20, BigInt(data.length), true);
    out.set(data, at + 60);
    at += 60 + data.length;
  }
  return out;
}

const POINT = { x: 150, y: -250, z: 300, intensity: 700, returnNumber: 2, returnCount: 3, classification: 6, gps: 12.5, rgb: [65535, 0, 32768] };

test('every point format gives positions, returns and classification; each extra field where it exists', async () => {
  for (let format = 0; format <= 10; format++) {
    const cloud = await parseLAS(las({ format, minor: format >= 6 ? 4 : 2, points: [POINT] }));
    assert.equal(cloud.header.pointFormat, format);
    assert.ok(Math.abs(cloud.positions[0] + cloud.origin[0] - 1.5) < 1e-6, `format ${format}`);
    assert.ok(Math.abs(cloud.positions[1] + cloud.origin[1] + 2.5) < 1e-6, `format ${format}`);
    assert.equal(cloud.intensity[0], 700);
    assert.equal(cloud.classification[0], 6, `format ${format}: flag bits stay out of the class`);
    assert.equal(cloud.returnNumber[0], 2);
    assert.equal(cloud.returnCount[0], 3);
    assert.equal(cloud.gpsTime?.[0], [0, 2].includes(format) ? undefined : 12.5, `format ${format}`);
    assert.equal(cloud.colors !== undefined, [2, 3, 5, 7, 8, 10].includes(format), `format ${format}`);
  }
});

test('extra bytes per point move the stride, not the fields', async () => {
  const cloud = await parseLAS(las({ format: 1, extra: 6, points: [POINT, { ...POINT, x: 250 }] }));
  assert.ok(Math.abs(cloud.positions[3] + cloud.origin[0] - 2.5) < 1e-6);
  assert.equal(cloud.gpsTime[1], 12.5);
});

test('survey coordinates keep their centimetres, with offset or without, relative to origin', async () => {
  const far = { x: 12345, y: 0, z: 0 };
  const withOffset = await parseLAS(las({ points: [far], offset: [500000, 4000000, 100], min: [500000, 4000000, 100] }));
  assert.deepEqual(withOffset.origin, [500000, 4000000, 100]);
  assert.ok(Math.abs(withOffset.positions[0] - 123.45) < 1e-4);
  const noOffset = await parseLAS(las({ points: [{ x: 50012345, y: 0, z: 0 }], min: [500000, 0, 0] }));
  assert.ok(Math.abs(noOffset.positions[0] - 123.45) < 1e-4, `${noOffset.positions[0]}`);
  assert.equal(noOffset.origin[0] + Math.round(noOffset.positions[0] * 100) / 100, 500123.45);
});

test('colours scale from 16 bits, or from 8 when a file fills only the low byte', async () => {
  const wide = await parseLAS(las({ format: 2, points: [POINT] }));
  assert.ok(Math.abs(wide.colors[0] - 1) < 1e-6);
  assert.ok(Math.abs(wide.colors[2] - 32768 / 65535) < 1e-6);
  const low = await parseLAS(las({ format: 2, points: [{ ...POINT, rgb: [255, 0, 51] }] }));
  assert.ok(Math.abs(low.colors[2] - 0.2) < 1e-6);
});

test('the header reads, including the writer and a 64-bit point count', async () => {
  const cloud = await parseLAS(las({ minor: 4, format: 6, points: [POINT, POINT], min: [1, 2, 3], scale: [0.1, 0.2, 0.5] }));
  assert.deepEqual(cloud.header.version, [1, 4]);
  assert.equal(cloud.header.pointCount, 2);
  assert.equal(cloud.header.generator, 'margo test');
  assert.deepEqual(cloud.header.min, [1, 2, 3]);
  assert.deepEqual(cloud.header.scale, [0.1, 0.2, 0.5]);
  assert.equal(cloud.header.compressed, false);
});

test('variable and extended records come back with their ids and bytes', async () => {
  const cloud = await parseLAS(
    las({
      minor: 4,
      format: 6,
      points: [POINT],
      vlrs: [{ user: 'LASF_Projection', id: 2112, data: new Uint8Array([1, 2]) }],
      evlrs: [{ user: 'big', id: 7, data: new Uint8Array([3]) }],
    }),
  );
  assert.deepEqual(
    cloud.records.map((r) => [r.userId, r.recordId, [...r.data]]),
    [
      ['LASF_Projection', 2112, [1, 2]],
      ['big', 7, [3]],
    ],
  );
  assert.equal(cloud.records[0].description, 'about');
});

test('step thins the cloud and counts against the limit after thinning', async () => {
  const points = [0, 1, 2, 3, 4].map((i) => ({ ...POINT, x: i * 100 }));
  const cloud = await parseLAS(las({ points }), { step: 2 });
  assert.equal(cloud.positions.length / 3, 3);
  assert.ok(Math.abs(cloud.positions[6] - 4) < 1e-6);
  assert.equal((await parseLAS(las({ points }), { step: 2, maxVertices: 3 })).intensity.length, 3);
  await refuses(parseLAS(las({ points }), { maxVertices: 3 }), 'limit');
  await refuses(parseLAS(las({ points }), { step: 0 }), 'range');
});

const fixtures = new URL('../../points/tests/fixtures/', import.meta.url);
const expected = JSON.parse(readFileSync(new URL('laz/records.json', fixtures)));
const USGS = 'USGS_LPC_MT_Statewide_Phase3_2021_B21_568232.laz';
const real = (name) => new Uint8Array(readFileSync(new URL(name === USGS ? name : `laz/${name}`, fixtures)));
const digest = (a) =>
  createHash('sha256').update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength)).digest('hex').slice(0, 32);

/** The fields of a cloud under the names of records.json. */
function fieldsOf(cloud) {
  const { points } = cloud,
    wave = points.wavePackets;
  return {
    positions: cloud.positions,
    intensity: cloud.intensity,
    returnNumber: cloud.returnNumber,
    numberOfReturns: cloud.returnCount,
    classification: cloud.classification,
    classificationFlags: points.classificationFlags,
    scanDirection: points.scanDirection,
    edgeOfFlightLine: points.edgeOfFlightLine,
    scanAngle: points.scanAngle,
    scannerChannel: points.scannerChannel,
    userData: points.userData,
    pointSourceId: points.pointSourceId,
    gpsTime: cloud.gpsTime,
    rgb: points.rgb,
    nir: points.nir,
    waveDescriptor: wave?.descriptor,
    waveOffset: wave?.offset,
    waveSize: wave?.size,
    waveLocation: wave?.location,
    waveDirection: wave?.direction,
  };
}

for (const [name, want] of Object.entries(expected)) {
  if (name === 'point-version-1-point-wise.laz') continue;
  test(`${name} opens with no hook: format ${want.format}, ${want.points} points, every field matching LASzip`, async () => {
    const cloud = await parseLAS(real(name)),
      fields = fieldsOf(cloud);
    assert.equal(cloud.header.pointFormat, want.format);
    assert.equal(cloud.positions.length, want.points * 3);
    // simple1_3.las has a wrong box in its header, so its own test below checks the positions.
    const boxIsRight = name !== 'simple1_3.las';
    if (boxIsRight) assert.deepEqual(cloud.origin, cloud.header.min);
    for (const [field, value] of Object.entries(want.fields))
      if (field !== 'extra' && (boxIsRight || field !== 'positions')) assert.equal(digest(fields[field]), value, field);
    for (const [field, value] of Object.entries(want.fields.extra ?? {}))
      assert.equal(digest(cloud.extra[field]), value, `extra bytes ${field}`);
  });
}

test('the USGS tile opens through loaders/las, as the header of the survey says', async () => {
  const cloud = await parseLAS(real(USGS));
  assert.equal(cloud.header.pointCount, 54634);
  assert.equal(cloud.header.compressed, true);
  assert.deepEqual(cloud.header.version, [1, 4]);
  assert.ok(cloud.crs.epsg !== undefined || cloud.crs.wkt, 'the survey names its coordinate system');
  const { min, max } = cloud.header;
  for (let i = 0; i < cloud.positions.length; i += 3)
    for (let c = 0; c < 3; c++) {
      const v = cloud.origin[c] + cloud.positions[i + c];
      assert.ok(v >= min[c] - 0.01 && v <= max[c] + 0.01);
    }
  const thin = await parseLAS(real(USGS), { step: 10 });
  assert.equal(thin.intensity.length, Math.ceil(54634 / 10));
  assert.equal(thin.intensity[7], cloud.intensity[70]);
});

test('a real file whose header box is wrong keeps exact positions', async () => {
  // The writer of this file stored its box as raw integers, a thousand times too far out. Read against that box a float32
  // position is 16 m coarse. The extent here is what the records say, as laspy reads them.
  const cloud = await parseLAS(real('simple1_3.las'));
  assert.equal(cloud.header.min[0], -235434519);
  const extent = (axis) => {
    let low = Infinity,
      high = -Infinity;
    for (let i = axis; i < cloud.positions.length; i += 3) {
      low = Math.min(low, cloud.positions[i]);
      high = Math.max(high, cloud.positions[i]);
    }
    return [low + cloud.origin[axis], high + cloud.origin[axis]];
  };
  const near = ([low, high], [wantLow, wantHigh]) =>
    assert.ok(Math.abs(low - wantLow) < 0.001 && Math.abs(high - wantHigh) < 0.001, `${low} to ${high}`);
  near(extent(0), [-235434.519, -234935.841]);
  near(extent(1), [5800843.145, 5800946.249]);
  near(extent(2), [265.094, 273.811]);
});

test('a real waveform file gives its packets, descriptor and sample reader', async () => {
  const cloud = await parseLAS(real('fullwave.laz')),
    { wavePackets } = cloud.points,
    descriptor = lasWaveDescriptors(cloud.records).get(1);
  assert.deepEqual([wavePackets.offset[0], wavePackets.size[0], descriptor.bitsPerSample], [60, 4968, 16]);
  // The samples sit in a 35 MB `.wdp` beside it, so here a stand-in with the first packet where the offset says.
  const wdp = new Uint8Array(60 + 4968);
  new DataView(wdp.buffer).setUint16(60 + 2 * 1371, 24759, true);
  const wave = lasWaveform(cloud.points, 0, wdp);
  assert.equal(wave.raw.length, 2484);
  assert.equal(wave.raw[1371], 24759);
  assert.equal(wave.spacing, descriptor.spacing);
});

test('a decompress option replaces the built-in decoder, and LASzip 1.0 coding is refused by name', async () => {
  const plain = las({ format: 1, points: [POINT] });
  const pointBytes = plain.subarray(227);
  const file = las({ format: 1, points: [POINT], compressed: true, body: new Uint8Array(5), vlrs: [{ user: 'laszip encoded', id: 22204, data: new Uint8Array(4) }] });
  // The count in the header stays the file's own, whatever the compressed size is.
  new DataView(file.buffer).setUint32(107, 1, true);
  await refuses(parseLAS(file), 'header');
  let seen;
  const cloud = await parseLAS(file, {
    decompress: async (source) => {
      seen = source;
      return pointBytes;
    },
  });
  assert.equal(seen.header.compressed, true);
  assert.equal(seen.records[0].recordId, 22204);
  assert.equal(seen.pointOffset, 227 + 58);
  assert.ok(Math.abs(cloud.positions[0] + cloud.origin[0] - 1.5) < 1e-6);
  await refuses(parseLAS(file, { decompress: () => new Uint8Array(3) }), 'truncated');
  await assert.rejects(
    parseLAS(real('point-version-1-point-wise.laz')),
    (e) => e instanceof LoaderError && e.code === 'unsupported' && /POINT10 version 1/.test(e.message),
  );
});

test('a damaged LAZ stream is a named error, and a hook that fails keeps its own error', async () => {
  const cut = real('point-time.laz').slice(0, 9000);
  await refuses(parseLAS(cut), 'truncated');
  const broken = new Error('my decoder failed');
  await assert.rejects(parseLAS(real('point-time.laz'), { decompress: () => Promise.reject(broken) }), (e) => e === broken);
});

/** Every module a file reaches by static imports, following `@margoengine/` names and relative paths. */
function staticGraph(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  for (const [, specifier] of text.matchAll(/^\s*(?:import|export)\s[^'"()]*?['"]([^'"]+)['"]/gm)) {
    if (specifier.startsWith('.')) staticGraph(resolve(dirname(file), specifier), seen);
    else if (specifier.startsWith('@margoengine/')) staticGraph(fileURLToPath(import.meta.resolve(specifier)), seen);
  }
  return seen;
}

test('a plain LAS file never pays for the decoder: laz.js is only reached by the import() of a compressed file', () => {
  const entry = fileURLToPath(new URL('../dist/las.js', import.meta.url)),
    graph = [...staticGraph(entry)],
    reader = graph.find((file) => /points[\\/]dist[\\/]las\.js$/.test(file));
  assert.ok(reader, 'loaders/las goes through the points reader');
  assert.deepEqual(graph.filter((file) => /laz\.js$/.test(file)), []);
  assert.match(readFileSync(reader, 'utf8'), /import\("\.\/laz\.js"\)/);
});

test('bad files are named errors', async () => {
  await refuses(parseLAS(new Uint8Array(10)), 'header');
  await refuses(parseLAS(new Uint8Array(300)), 'header');
  const edit = (change, options = {}) => {
    const file = las({ points: [POINT], ...options });
    change(file, new DataView(file.buffer));
    return file;
  };
  await refuses(parseLAS(edit((f) => (f[25] = 9))), 'unsupported');
  await refuses(parseLAS(edit((f) => (f[104] = 11))), 'unsupported');
  await refuses(parseLAS(edit((f, v) => v.setUint16(105, 10, true))), 'header');
  await refuses(parseLAS(edit((f, v) => v.setUint32(96, 10, true))), 'header');
  await refuses(parseLAS(edit((f, v) => v.setUint32(96, 1 << 30, true))), 'header');
  await refuses(parseLAS(edit((f, v) => v.setFloat64(131, 0, true))), 'range');
  await refuses(parseLAS(edit((f, v) => v.setUint32(100, 3, true))), 'truncated');
  await refuses(parseLAS(las({ points: [POINT] }).subarray(0, 240)), 'truncated');
  const huge = edit((f, v) => v.setUint32(107, 0xffffff00, true));
  await refuses(parseLAS(huge), 'limit');
  await refuses(parseLAS(huge, { maxVertices: 0xffffffff }), 'truncated');
  const controller = new AbortController();
  controller.abort();
  await refuses(parseLAS(las({ points: [POINT] }), { signal: controller.signal }), 'aborted');
});
