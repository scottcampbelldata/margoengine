import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openNetCDF } from '@margoengine/sciviz/netcdf';
import { openVTK, parseVtk } from '@margoengine/sciviz/vtk';
import { gridSurface } from '@margoengine/sciviz/grids';
import { createHash } from 'node:crypto';

// Tiny independent grammar writer. The fixtures deliberately exercise the sole-record no-padding rule.
function cdf({ version = 1, record = false, second = false, type = 3, name = 'speed' } = {}) {
  const parts = [],
    offsets = [],
    push = (b) => parts.push(Buffer.from(b));
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    push(b);
  };
  const text = (s) => {
    const b = Buffer.from(s);
    u32(b.length);
    push(b);
    push(Buffer.alloc((4 - (b.length % 4)) % 4));
  };
  const size = [0, 1, 1, 2, 4, 4, 8][type];
  push([67, 68, 70, version]);
  u32(record ? 2 : 0);
  u32(10);
  u32(record ? 2 : 1);
  text(record ? 'time' : 'x');
  u32(record ? 0 : 3);
  if (record) {
    text('x');
    u32(3);
  }
  u32(0);
  u32(0);
  u32(11);
  u32(second ? 2 : 1);
  for (let i = 0; i < (second ? 2 : 1); i++) {
    text(i ? 'other' : name);
    u32(record ? 2 : 1);
    u32(0);
    if (record) u32(1);
    u32(12);
    u32(4);
    for (const [key, v] of [
      ['_FillValue', -9],
      ['scale_factor', 2],
      ['add_offset', 10],
    ]) {
      text(key);
      u32(3);
      u32(1);
      const b = Buffer.alloc(4);
      b.writeInt16BE(v);
      push(b);
    }
    text('title');
    u32(2);
    const title = Buffer.from('Temperature μ');
    u32(title.length);
    push(title);
    push(Buffer.alloc((4 - (title.length % 4)) % 4));
    u32(type);
    u32(Math.ceil((3 * size) / 4) * 4);
    offsets.push(parts.length);
    push(Buffer.alloc(version === 2 ? 8 : 4));
  }
  let begin = Buffer.concat(parts).length;
  offsets.forEach((index, i) =>
    version === 2
      ? parts[index].writeBigUInt64BE(BigInt(begin + i * Math.ceil((3 * size) / 4) * 4))
      : parts[index].writeUInt32BE(begin + i * Math.ceil((3 * size) / 4) * 4),
  );
  const values = record
    ? [
        [1, -9, 3],
        [4, 5, 6],
      ]
    : [[1, -9, 3]];
  for (const row of values)
    for (let i = 0; i < (second ? 2 : 1); i++) {
      const b = Buffer.alloc(3 * size);
      row.forEach((v, j) =>
        size === 1
          ? b.writeInt8(v + i, j)
          : size === 2
            ? b.writeInt16BE(v + i, j * size)
            : b.writeInt32BE(v + i, j * size),
      );
      push(b);
      if (!record || second) push(Buffer.alloc((4 - (b.length % 4)) % 4));
    }
  return Buffer.concat(parts);
}

for (const version of [1, 2])
  for (const type of [1, 3, 4])
    for (const second of [false, true]) {
      test(`CDF-${version} type ${type}: interleaved record reads, padding=${second}`, async () => {
        using file = await openNetCDF(cdf({ version, record: true, second, type }));
        const v = file.variables.speed;
        assert.equal(v.attributes.title, 'Temperature μ');
        assert.deepEqual(v.shape, [2, 3]);
        assert.deepEqual([...(await v.read())], [12, NaN, 16, 18, 20, 22]);
        assert.deepEqual([...(await v.read({ start: [1, 0], count: [1, 2], stride: [1, 2], unpack: false }))], [4, 6]);
        const volume = await v.volume();
        assert.deepEqual(volume.dims, [3, 2, 1]);
        assert.deepEqual(volume.range, [12, 22]);
      });
    }

test('metadata and selected ranges do not read unrelated large variable payloads', async () => {
  const bytes = cdf({ version: 2 }),
    reads = [];
  using file = await openNetCDF({
    async read(o, n) {
      reads.push([o, n]);
      return bytes.subarray(o, o + n);
    },
  });
  assert.equal(reads.length, 1);
  reads.length = 0;
  assert.deepEqual([...(await file.variables.speed.read({ start: [2], count: [1], unpack: false }))], [3]);
  assert.equal(reads.length, 1);
  assert.equal(reads[0][1], 2);
});

test('selection bounds, output limits, missing signatures and malformed headers reject with linked errors', async () => {
  using file = await openNetCDF(cdf({ name: '__proto__' }));
  assert(file.variables.__proto__);
  for (const selection of [{ start: [-1] }, { stride: [0] }, { count: [4] }, { count: [] }, { start: [0.5] }])
    await assert.rejects(file.variables.__proto__.read(selection), /NetCDF.*https:\/\/margoengine/);
  await assert.rejects(openNetCDF(new Uint8Array(32)), /CDF-1 and CDF-2/);
  await assert.rejects(openNetCDF(cdf().subarray(0, 60)), /header ends early/);
  await assert.rejects(openNetCDF(cdf(), { maxBytes: 32 }), /header exceeds/);
  const invalidText = cdf(); invalidText[invalidText.indexOf(Buffer.from('Temperature'))] = 255;
  await assert.rejects(openNetCDF(invalidText), /UTF-8.*https:\/\/margoengine/);
});

test('lifetime and per-read cancellation preserve the exact abort reason', async () => {
  const reason = { why: 'stopped' },
    controller = new AbortController();
  controller.abort(reason);
  await assert.rejects(openNetCDF(cdf(), { signal: controller.signal }), (e) => e === reason);
  const file = await openNetCDF(cdf());
  await assert.rejects(file.variables.speed.read({ signal: controller.signal }), (e) => e === reason);
  file.dispose();
  file.dispose();
  await assert.rejects(file.variables.speed.read(), { name: 'AbortError' });
});

test('HTTP Range handles valid 206 and bounded 200 responses, refusing mismatched offsets and lengths', async (t) => {
  const bytes = cdf();
  let mode = 'range';
  const ranges = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const [o, e] = options.headers.Range.slice(6).split('-').map(Number);
    ranges.push([o, e]);
    if (mode === 'whole') return new Response(bytes);
    const end = Math.min(e, bytes.length - 1),
      start = mode === 'offset' ? o + 1 : o;
    const body = mode === 'length' ? bytes.subarray(o, end) : bytes.subarray(o, end + 1);
    return new Response(body, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } });
  });
  for (mode of ['range', 'whole']) {
    using file = await openNetCDF('https://files.invalid/wind.nc');
    assert.deepEqual([...(await file.variables.speed.read({ unpack: false }))], [1, -9, 3]);
  }
  assert(ranges.some(([o, e]) => o > 0 && e - o + 1 === 6));
  for (mode of ['offset', 'length']) await assert.rejects(openNetCDF('https://files.invalid/wind.nc'), /Content-Range/);
  mode = 'whole';
  await assert.rejects(openNetCDF('https://files.invalid/wind.nc', { maxBytes: 32 }), /bounded read/);
});

const xml = (type, attrs, piece, content) =>
  new TextEncoder().encode(
    `<VTKFile type="${type}" byte_order="LittleEndian"><${type} ${attrs}><Piece ${piece}>${content}</Piece></${type}></VTKFile>`,
  );
const array = (name, values, components = 1) =>
  `<DataArray type="Float64" Name="${name}" NumberOfComponents="${components}">${values}</DataArray>`;

test('ImageData nonzero extent and negative spacing keep samples, physical positions and cell centres', async () => {
  using file = await openVTK(
    xml(
      'ImageData',
      'WholeExtent="4 6 2 3 0 0" Origin="10 20 30" Spacing="-2 3 4"',
      'Extent="4 6 2 3 0 0"',
      `<PointData>${array('s', '1 2 3 4 5 6')}</PointData><CellData>${array('s', '7 8')}</CellData>`,
    ),
  );
  const p = await file.volume('s');
  assert.deepEqual([...p.data], [3, 2, 1, 6, 5, 4]);
  assert.deepEqual(p.bounds, [-2, 2, 26, 29, 28, 32]);
  const c = await file.volume('s', { association: 'cell' });
  assert.deepEqual([...c.data], [8, 7]);
  assert.deepEqual(c.bounds, [-1, 1, 26, 29, 28, 32]);
  await assert.rejects(file.volume('missing'), /absent/);
});

test('structured topology feeds the existing surface renderer with no second XML parser', async () => {
  const points = '0 0 0 1 0 0 0 1 0 1 1 0 0 0 1 1 0 1 0 1 1 1 1 1';
  using file = await openVTK(
    xml(
      'StructuredGrid',
      'WholeExtent="0 1 0 1 0 1"',
      'Extent="0 1 0 1 0 1"',
      `<Points>${array('', points, 3)}</Points><PointData>${array('s', '0 1 2 3 4 5 6 7')}</PointData>`,
    ),
  );
  const grid = await file.grid('s');
  assert.deepEqual([...grid.connectivity], [0, 1, 3, 2, 4, 5, 7, 6]);
  assert.equal(gridSurface(grid).cells.length, 12);
});

function legacy(binary = false, key = 's') {
  const b = [],
    text = (s) => b.push(Buffer.from(s));
  const data = (values, type) => {
    if (!binary) return text(values.join(' ') + '\n');
    const buf = Buffer.alloc(values.length * (type === 'vtktypeint64' ? 8 : 4));
    values.forEach((v, i) =>
      type === 'float'
        ? buf.writeFloatBE(v, i * 4)
        : type === 'vtktypeint64'
          ? buf.writeBigInt64BE(BigInt(v), i * 8)
          : buf.writeInt32BE(v, i * 4),
    );
    b.push(buf);
    text('\n');
  };
  text(
    `# vtk DataFile Version 5.1\nTetra\n${binary ? 'BINARY' : 'ASCII'}\nDATASET UNSTRUCTURED_GRID\nPOINTS 4 float\n`,
  );
  data([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], 'float');
  text('CELLS 2 4\nOFFSETS vtktypeint64\n');
  data([0, 4], 'vtktypeint64');
  text('CONNECTIVITY vtktypeint64\n');
  data([0, 1, 2, 3], 'vtktypeint64');
  text('CELL_TYPES 1\n');
  data([10], 'int');
  text(`POINT_DATA 4\nSCALARS ${key} float\nLOOKUP_TABLE default\n`);
  data([1, 2, 3, 4], 'float');
  return Buffer.concat(b);
}

test('legacy 5.1 ASCII and big-endian binary offsets retain volume cells and scalar arrays', () => {
  for (const binary of [false, true]) {
    const g = parseVtk(legacy(binary, '__proto__'));
    assert.deepEqual([...g.connectivity], [0, 1, 2, 3]);
    assert.deepEqual([...g.pointData], [1, 2, 3, 4]);
    assert.equal(Object.getPrototypeOf(g.pointArrays), null);
    assert.equal(gridSurface(g).cells.length, 4);
  }
  assert.throws(
    () => parseVtk(legacy().toString().replace('0 4\nCONNECTIVITY', '1 4\nCONNECTIVITY')),
    /span connectivity/,
  );
  assert.throws(
    () => parseVtk(legacy().toString().replace('0 1 2 3\nCELL_TYPES', '0 1 2 999\nCELL_TYPES')),
    /invalid point index/,
  );
});

test('NOAA writer-produced files agree with the frozen independent data and all hashes', async () => {
  const root = new URL('../../../examples/assets/sciviz/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('formats.json', root), 'utf8'));
  for (const [file, hash] of Object.entries(manifest.files)) {
    const bytes = await readFile(new URL(file, root));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, file);
  }
  using nc = await openNetCDF(await readFile(new URL('wind-classic.nc', root)));
  const expected = await nc.variables.uwnd.read();
  using offset = await openNetCDF(await readFile(new URL('wind-offset.nc', root)));
  assert.deepEqual(await offset.variables.uwnd.read(), expected);
  assert.equal(expected[0], manifest.first);
  const little = Buffer.alloc(expected.length * 4);
  expected.forEach((v, i) => little.writeFloatLE(v, i * 4));
  assert.equal(createHash('sha256').update(little).digest('hex'), manifest.valuesSHA256);
  for (const suffix of ['vti', 'vts', 'vtu']) {
    using vtk = await openVTK(await readFile(new URL(`wind.${suffix}`, root)));
    if (suffix === 'vti') assert.deepEqual((await vtk.volume('uwnd')).data, expected);
    else assert.deepEqual((await vtk.grid('uwnd')).pointData, expected);
  }
  const legacyGrid = parseVtk(await readFile(new URL('wind.vtk', root)));
  assert.deepEqual(legacyGrid.pointData, expected);
});
