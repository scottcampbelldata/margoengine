// parseLAS: every point format, 1.2 and 1.4 headers, variable records, colours, LAZ through a hook, limits and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
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
  min = [0, 0, 0],
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
  min.forEach((value, i) => v.setFloat64(187 + i * 16, value, true));
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
    assert.ok(Math.abs(cloud.positions[0] - 1.5) < 1e-6, `format ${format}`);
    assert.ok(Math.abs(cloud.positions[1] + 2.5) < 1e-6, `format ${format}`);
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
  assert.ok(Math.abs(cloud.positions[3] - 2.5) < 1e-6);
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

test('a LAZ file is refused without a decompressor and reads through one', async () => {
  const plain = las({ format: 1, points: [POINT] });
  const pointBytes = plain.subarray(227);
  const file = las({ format: 1, points: [POINT], compressed: true, body: new Uint8Array(5), vlrs: [{ user: 'laszip encoded', id: 22204, data: new Uint8Array(4) }] });
  // The count in the header stays the file's own, whatever the compressed size is.
  new DataView(file.buffer).setUint32(107, 1, true);
  await refuses(parseLAS(file), 'unsupported');
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
  assert.ok(Math.abs(cloud.positions[0] - 1.5) < 1e-6);
  await refuses(parseLAS(file, { decompress: () => new Uint8Array(3) }), 'truncated');
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
