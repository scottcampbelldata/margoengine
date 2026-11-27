// writeCOPC and writeCOPCTo, read back through Margo's COPC reader and LAS decoder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readdir, readFile, rm, appendFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopcSource } from '@margoengine/points/copc';
import { writeCOPC, writeCOPCTo } from '@margoengine/points/copc-write';
import { parseLAS, readLASHeader, writeLAS } from '../dist/las.js';

/** A fetch over `file` that answers ranges. */
const server =
  (file) =>
  async (_url, { headers }) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(headers.Range);
    return new Response(file.slice(+from, +to + 1), { status: 206 });
  };
const open3 = (file) => CopcSource.open('https://x/a.copc.laz', { fetch: server(file) });

/** `n` points on a wavy sheet, each told apart by its intensity, point source and time. */
function cloud(n, from = 0) {
  const positions = new Float64Array(n * 3),
    intensity = new Uint16Array(n),
    pointSourceId = new Uint16Array(n),
    gpsTime = new Float64Array(n),
    returnNumber = new Uint8Array(n),
    classification = new Uint8Array(n),
    rgb = new Uint16Array(n * 3);
  for (let k = 0; k < n; k++) {
    const i = from + k,
      u = ((i * 7919) % 10007) / 10007,
      v = ((i * 104729) % 9973) / 9973;
    positions.set([500000 + u * 100, 4000000 + v * 100, 20 + 5 * Math.sin(u * 20) * Math.cos(v * 13)], k * 3);
    intensity[k] = i & 0xffff;
    pointSourceId[k] = i >>> 16;
    gpsTime[k] = 1000 + (n - k) * 0.25 + from;
    returnNumber[k] = 1 + (i % 3);
    classification[k] = i % 7;
    rgb.set([i % 65536, (i * 3) % 65536, 65535], k * 3);
  }
  return { positions, intensity, pointSourceId, gpsTime, returnNumber, classification, rgb, wkt: 'GEOGCS["WGS 84"]' };
}

/** Every node of a source with its decoded points. */
async function nodesOf(source) {
  const out = [],
    queue = [source.root];
  while (queue.length) {
    const node = queue.shift();
    out.push([node, await source.load(node, new AbortController().signal)]);
    queue.push(...node.children.filter(Boolean));
  }
  return out;
}

/** Each point as one string, by its number, from raw records of any LAS or LAZ file. */
async function records(file) {
  const las = await parseLAS(file),
    out = new Map();
  for (let k = 0; k < las.header.pointCount; k++) {
    const id = las.intensity[k] + las.pointSourceId[k] * 65536,
      at = [0, 1, 2].map((a) => Math.round((las.positions[k * 3 + a] + las.origin[a]) * 1000));
    out.set(
      id,
      JSON.stringify([
        at,
        las.gpsTime?.[k],
        las.classification[k],
        las.returnNumber[k],
        [...(las.rgb?.slice(k * 3, k * 3 + 3) ?? [])],
      ]),
    );
  }
  return out;
}

test('a cloud becomes an octree that holds every point once, in its voxel, one a grid cell', async () => {
  const input = cloud(40_000),
    file = await writeCOPC(input, { gridSize: 16, leafPoints: 1500 }),
    source = await open3(file),
    nodes = await nodesOf(source),
    { center, halfSize, spacing } = source.info;
  assert.ok(nodes.length > 20, `${nodes.length} nodes`);
  assert.equal(spacing, (halfSize * 2) / 16);
  assert.equal(
    nodes.reduce((sum, [node]) => sum + node.count, 0),
    40_000,
  );
  const seen = new Set();
  for (const [node, data] of nodes) {
    assert.equal(data.positions.length / 3, node.count);
    const inner = node.children.some(Boolean),
      cells = new Set();
    for (let k = 0; k < node.count; k++) {
      const id = data.attributes.intensity[k] + data.attributes.point_source_id[k] * 65536;
      assert.ok(!seen.has(id), `point ${id} twice`);
      seen.add(id);
      for (let a = 0; a < 3; a++) {
        const p = data.positions[k * 3 + a];
        // Float32 positions about the cube's centre: a tolerance of their rounding.
        assert.ok(p >= node.bounds[a] - 1e-3 && p <= node.bounds[a + 3] + 1e-3, `point ${id} outside its voxel`);
        assert.ok(Math.abs(p + center[a] - input.positions[id * 3 + a]) < 2e-3);
      }
      if (inner)
        cells.add(
          [0, 1, 2]
            .map((a) =>
              Math.floor(
                ((data.positions[k * 3 + a] - node.bounds[a]) / (node.bounds[a + 3] - node.bounds[a])) * 16 + 1e-5,
              ),
            )
            .join(),
        );
      if (k) assert.ok(data.attributes.gps_time[k] >= data.attributes.gps_time[k - 1], 'a node in time order');
    }
    if (inner) assert.ok(cells.size >= node.count * 0.98, `${cells.size} cells for ${node.count} points`);
    else assert.ok(node.count <= 1500);
  }
  assert.equal(seen.size, 40_000);
  assert.deepEqual([...source.info.gpsTime], [1000.25, 11000]);
});

test('the file is a LAZ any reader takes in order, with every field and the header of the whole cloud', async () => {
  const input = cloud(6000),
    file = await writeCOPC(input, { leafPoints: 500, gridSize: 8 }),
    { header, records: vlrs } = readLASHeader(file);
  assert.equal(new TextDecoder().decode(file.subarray(375 + 2, 375 + 6)), 'copc');
  assert.deepEqual([file[393], file[394], file[104], file[24], file[25]], [1, 0, 0x87, 1, 4]);
  assert.deepEqual(
    vlrs.map((r) => `${r.userId} ${r.recordId}`),
    ['copc 1', 'laszip encoded 22204', 'LASF_Projection 2112', 'copc 1000'],
  );
  assert.equal(new DataView(file.buffer).getUint16(6, true) & 16, 16, 'the WKT bit');
  assert.equal(header.pointCount, 6000);
  for (let a = 0; a < 3; a++) {
    const axis = input.positions.filter((_, i) => i % 3 === a);
    assert.ok(Math.abs(header.min[a] - Math.min(...axis)) < 1e-3);
    assert.ok(Math.abs(header.max[a] - Math.max(...axis)) < 1e-3);
  }
  const view = new DataView(file.buffer);
  assert.deepEqual(
    [0, 1, 2].map((r) => Number(view.getBigUint64(255 + r * 8, true))),
    [2000, 2000, 2000],
  );
  assert.deepEqual(await records(file), await records(writeLAS(input)));
});

test('batches from an async stream and a file store give the same file as one batch in memory', async () => {
  const input = cloud(20_000),
    slice = (from, to) =>
      Object.fromEntries(
        Object.entries(input).map(([name, value]) =>
          name === 'wkt'
            ? [name, value]
            : [name, value.slice((from * value.length) / 20_000, (to * value.length) / 20_000)],
        ),
      ),
    options = { gridSize: 16, leafPoints: 1000 },
    whole = await writeCOPC(input, options);
  const folder = await mkdtemp(join(tmpdir(), 'margo-copc-')),
    target = join(folder, 'out.copc.laz');
  try {
    let appended = 0;
    const store = {
        async append(key, bytes) {
          appended += bytes.length;
          await appendFile(join(folder, key), bytes);
        },
        read: (key) => createReadStream(join(folder, key), { highWaterMark: 1013 }),
        delete: (key) => rm(join(folder, key)),
      },
      handle = await open(target, 'w'),
      progress = [];
    async function* tiles() {
      for (let from = 0; from < 20_000; from += 3000) yield slice(from, Math.min(20_000, from + 3000));
    }
    const written = await writeCOPCTo(
      async (bytes, position) => {
        await handle.write(bytes, 0, bytes.length, position);
      },
      tiles(),
      // The first tile's own offset would differ: the same bytes need the same coordinates.
      { ...options, store, onProgress: (done, total) => progress.push([done, total]) },
    );
    await handle.close();
    const file = new Uint8Array(await readFile(target));
    assert.deepEqual(await readdir(folder), ['out.copc.laz'], 'the store is empty afterwards');
    assert.equal(written.bytes, file.length);
    assert.equal(written.points, 20_000);
    assert.equal(progress.length, written.nodes);
    assert.deepEqual(progress.at(-1), [20_000, 20_000]);
    assert.ok(written.depth >= 2 && appended >= 20_000 * 36);
    assert.deepEqual(await records(file), await records(whole));
    const counts = async (f) => (await nodesOf(await open3(f))).map(([node]) => [node.id, node.count]);
    assert.deepEqual(await counts(file), await counts(whole));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a large hierarchy is split into pages the reader follows', async () => {
  const input = cloud(30_000),
    options = { gridSize: 4, leafPoints: 60 },
    one = await writeCOPC(input, { ...options, pageEntries: 100_000 }),
    many = await writeCOPC(input, { ...options, pageEntries: 12 }),
    [a, b] = await Promise.all([open3(one), open3(many)]);
  assert.equal(b.info.rootHierarchySize <= 12 * 32, true);
  assert.ok(a.info.rootHierarchySize > 200 * 32, `${a.info.rootHierarchySize}`);
  const shape = async (source) => (await nodesOf(source)).map(([node]) => [node.id, node.count]);
  assert.deepEqual(await shape(b), await shape(a));
  // Every page, the root's and those it points to, holds at most pageEntries.
  const view = new DataView(many.buffer),
    pages = [[b.info.rootHierarchyOffset, b.info.rootHierarchySize]];
  let entries = 0;
  for (const [at, size] of pages) {
    assert.ok(size <= 12 * 32 && size % 32 === 0, `a page of ${size} bytes`);
    for (let o = at; o < at + size; o += 32)
      if (view.getInt32(o + 28, true) === -1)
        pages.push([Number(view.getBigUint64(o + 16, true)), view.getInt32(o + 24, true)]);
      else entries++;
  }
  assert.ok(pages.length > 10);
  assert.equal(entries, (await shape(a)).length);
});

/** A LAS 1.2 file of `format` 0 to 3 with one point of known fields and one extra byte. */
function legacy(format) {
  const length = [20, 28, 26, 34][format] + 1,
    file = new Uint8Array(227 + length),
    view = new DataView(file.buffer);
  file.set([0x4c, 0x41, 0x53, 0x46]);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, 227, true);
  view.setUint32(96, 227, true);
  view.setUint8(104, format);
  view.setUint16(105, length, true);
  view.setUint32(107, 1, true);
  for (let a = 0; a < 3; a++) view.setFloat64(131 + a * 8, 0.01, true);
  const p = 227;
  view.setInt32(p, 100, true);
  view.setInt32(p + 4, 200, true);
  view.setInt32(p + 8, 300, true);
  view.setUint16(p + 12, 777, true);
  view.setUint8(p + 14, 2 | (3 << 3) | 0x40); // return 2 of 3, scan direction
  view.setUint8(p + 15, 12 | 0x80); // overlap class, withheld
  view.setInt8(p + 16, -15);
  view.setUint8(p + 17, 9);
  view.setUint16(p + 18, 42, true);
  if (format === 1 || format === 3) view.setFloat64(p + 20, 123.5, true);
  if (format >= 2) [10, 20, 30].forEach((v, c) => view.setUint16(p + (format === 3 ? 28 : 20) + c * 2, v, true));
  file[p + length - 1] = 201;
  return file;
}

test('formats 0 to 3 become 6 or 7 with every field and extra byte', async () => {
  for (const format of [0, 1, 2, 3]) {
    const file = await writeCOPC(legacy(format)),
      { header } = readLASHeader(file),
      target = format >= 2 ? 7 : 6;
    assert.deepEqual([header.pointFormat, header.pointRecordLength], [target, (target === 7 ? 36 : 30) + 1]);
    const las = await parseLAS(file);
    assert.deepEqual(
      [las.returnNumber[0], las.numberOfReturns[0], las.classification[0], las.userData[0], las.pointSourceId[0]],
      [2, 3, 1, 9, 42],
    );
    // Withheld (4) and the overlap flag (8) that class 12 becomes.
    assert.equal(las.classificationFlags[0] & 15, 12);
    assert.equal(las.intensity[0], 777);
    assert.equal(las.gpsTime[0], format === 1 || format === 3 ? 123.5 : 0);
    if (target === 7) assert.deepEqual([...las.rgb], [10, 20, 30]);
    const view = new DataView(file.buffer),
      info = await open3(file);
    assert.deepEqual([...info.info.center], [1, 2, 3]);
    assert.equal(view.getUint32(96, true) > 589, true);
    const decoded = (await nodesOf(info))[0][1];
    assert.equal(decoded.attributes.scan_angle[0], las.scanAngle[0]);
    assert.ok(Math.abs(las.scanAngle[0] + 15) < 0.003, `${las.scanAngle[0]}`);
  }
});

test('input the format cannot hold is refused, and an abort empties the store', async () => {
  await assert.rejects(writeCOPC([]), /at least one point/);
  await assert.rejects(writeCOPC({ positions: [] }), /at least one point/);
  await assert.rejects(writeCOPC({ positions: [0, 0, 0], pointFormat: 9 }), /waveform/);
  await assert.rejects(writeCOPC({ positions: [0, 0, 0], pointFormat: 1, versionMinor: 2, epsg: 32633 }), /GeoTIFF/);
  await assert.rejects(
    writeCOPC([{ positions: [0, 0, 0] }, { positions: [1, 1, 1], pointFormat: 8 }]),
    /record layout/,
  );
  await assert.rejects(writeCOPC([{ positions: [0, 0, 0] }, { positions: [1e9, 0, 0] }]), /coarser scale/);
  await assert.rejects(writeCOPC({ positions: [0, 0, 0] }, { gridSize: 1 }), /gridSize/);
  await assert.rejects(writeCOPC({ positions: [0, 0, 0] }, { leafPoints: 0 }), /leafPoints/);
  await assert.rejects(writeCOPC({ positions: [0, 0, 0] }, { pageEntries: 8 }), /pageEntries/);
  const held = new Map(),
    store = {
      append: (key, bytes) => held.set(key, [...(held.get(key) ?? []), bytes]),
      read: (key) => held.get(key) ?? [],
      delete: (key) => held.delete(key),
    },
    stop = new AbortController();
  await assert.rejects(
    writeCOPC(cloud(5000), {
      store,
      leafPoints: 100,
      gridSize: 4,
      signal: stop.signal,
      onProgress: () => stop.abort(new Error('enough')),
    }),
    /enough/,
  );
  assert.equal(held.size, 0);
});

test('points that share one place stop at the deepest voxel and are all kept', async () => {
  const positions = new Float64Array(3 * 400).fill(5),
    file = await writeCOPC({ positions }, { leafPoints: 10, gridSize: 2 }),
    nodes = await nodesOf(await open3(file));
  assert.equal(
    nodes.reduce((sum, [node]) => sum + node.count, 0),
    400,
  );
  assert.equal(Math.max(...nodes.map(([node]) => node.level)), 30);
});
