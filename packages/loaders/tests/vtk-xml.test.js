// parseVTKXML: array formats, compression, PolyData cells, grid surfaces, data arrays, limits and refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { parseVTKXML } from '../dist/vtk-xml.js';
import { LoaderError } from '../dist/common.js';

const text = (value) => new TextEncoder().encode(value);
const refuses = (promise, code) =>
  assert.rejects(promise, (error) => error instanceof LoaderError && error.format === 'VTK XML' && error.code === code);
const ascii = (type, name, values, components = 1) =>
  `<DataArray type="${type}" Name="${name}" NumberOfComponents="${components}" format="ascii">${values.join(' ')}</DataArray>`;
const points = (values) => `<Points>${ascii('Float32', 'Points', values, 3)}</Points>`;
const poly = (body, counts, attributes = '') =>
  text(`<VTKFile type="PolyData" ${attributes}><PolyData><Piece ${counts}>${body}</Piece></PolyData></VTKFile>`);
const cells = (name, connectivity, offsets) =>
  `<${name}>${ascii('Int32', 'connectivity', connectivity)}${ascii('Int32', 'offsets', offsets)}</${name}>`;
const grid = (coordinates, connectivity, offsets, types, extra = '') =>
  text(
    `<VTKFile type="UnstructuredGrid"><UnstructuredGrid><Piece NumberOfPoints="${coordinates.length / 3}" NumberOfCells="${types.length}">${points(coordinates)}<Cells>${ascii('Int32', 'connectivity', connectivity)}${ascii('Int32', 'offsets', offsets)}${ascii('UInt8', 'types', types)}${extra}</Cells></Piece></UnstructuredGrid></VTKFile>`,
  );
const QUAD = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
const f32 = (values) => Buffer.from(new Float32Array(values).buffer);
const u32 = (...values) => Buffer.from(new Uint32Array(values).buffer);
const u64 = (...values) => Buffer.from(new BigUint64Array(values.map(BigInt)).buffer);
const triangleFile = (arrayTag, tail = '', attributes = '') =>
  Buffer.concat([
    text(
      `<VTKFile type="PolyData" ${attributes}><PolyData><Piece NumberOfPoints="3"><Points>${arrayTag}</Points></Piece></PolyData>`,
    ),
    tail ? (typeof tail === 'string' ? text(tail) : tail) : text(''),
    text('</VTKFile>'),
  ]);
const VALUES = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const tag = (format, more = '', body = '') =>
  `<DataArray type="Float32" NumberOfComponents="3" format="${format}" ${more}>${body}</DataArray>`;
const same = async (file) => assert.deepEqual([...(await parseVTKXML(file)).positions], VALUES);

test('a polygon fan, a strip and a polyline read from ascii arrays', async () => {
  const model = await parseVTKXML(
    poly(
      points([...QUAD, 2, 0, 0, 2, 1, 0]) +
        cells('Lines', [0, 1, 2], [3]) +
        cells('Strips', [1, 4, 2, 5], [4]) +
        cells('Polys', [0, 1, 2, 3], [4]),
      'NumberOfPoints="6"',
    ),
  );
  assert.equal(model.kind, 'mesh');
  assert.equal(model.type, 'PolyData');
  assert.deepEqual([...model.lines], [0, 1, 1, 2]);
  assert.deepEqual([...model.indices], [1, 4, 2, 2, 4, 5, 0, 1, 2, 0, 2, 3]);
  assert.equal(model.cellCount, 3);
  assert.deepEqual([...model.triangleCells], [1, 1, 2, 2]);
});

test('only vertices make a point cloud', async () => {
  const model = await parseVTKXML(poly(points([0, 0, 0, 1, 1, 1]) + cells('Verts', [0, 1], [1, 2]), 'NumberOfPoints="2"'));
  assert.equal(model.kind, 'points');
  assert.equal(model.indices, undefined);
});

test('inline binary reads with a separate size run, one run, and a 64-bit header', async () => {
  const data = f32(VALUES);
  const b64 = (buffer) => buffer.toString('base64');
  await same(triangleFile(tag('binary', '', b64(u32(data.length)) + b64(data))));
  await same(triangleFile(tag('binary', '', b64(Buffer.concat([u32(data.length), data])))));
  await same(triangleFile(tag('binary', '', b64(u64(data.length)) + b64(data)), '', 'header_type="UInt64"'));
});

test('big-endian files swap their values and sizes', async () => {
  const data = Buffer.from(f32(VALUES)).swap32();
  const size = u32(data.length).swap32();
  await same(triangleFile(tag('binary', '', size.toString('base64') + data.toString('base64')), '', 'byte_order="BigEndian"'));
});

test('appended data reads raw and base64, at an offset, with bytes that look like tags', async () => {
  const data = f32(VALUES);
  const pad = Buffer.from('<<>>_');
  const raw = Buffer.concat([text('<AppendedData encoding="raw">_'), pad, u32(data.length), data, text('</AppendedData>')]);
  await same(triangleFile(tag('appended', `offset="${pad.length}"`), raw));
  const first = u32(data.length).toString('base64') + data.toString('base64');
  const lead = 'AAAA';
  await same(
    triangleFile(tag('appended', `offset="${lead.length}"`), `<AppendedData encoding="base64">\n _${lead}${first}\n</AppendedData>`),
  );
});

test('zlib blocks read inline and appended, across several blocks', async () => {
  const data = f32(VALUES),
    block = 16,
    parts = [data.subarray(0, 16), data.subarray(16, 32), data.subarray(32)].map((part) => deflateSync(part)),
    header = u32(3, block, 4, ...parts.map((part) => part.length));
  const compressor = 'compressor="vtkZLibDataCompressor"';
  await same(
    triangleFile(tag('binary', '', header.toString('base64') + Buffer.concat(parts).toString('base64')), '', compressor),
  );
  const raw = Buffer.concat([text('<AppendedData encoding="raw">_'), header, ...parts, text('</AppendedData>')]);
  await same(triangleFile(tag('appended', 'offset="0"'), raw, compressor));
  const even = u32(1, 36, 0, deflateSync(data).length);
  await same(
    triangleFile(tag('binary', '', even.toString('base64') + deflateSync(data).toString('base64')), '', compressor),
  );
});

test('LZ4 blocks read literals and overlapping matches, and a bad block is refused', async () => {
  // 36 bytes: 8 literal bytes, then a match at offset 4 that repeats them over itself for the other 28.
  const source = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const expected = Array.from({ length: 36 }, (_, i) => (i < 8 ? source[i] : source[4 + (i % 4)]));
  const block = Buffer.from([0x8f, ...source, 4, 0, 28 - 4 - 15, 0x00]);
  const header = u32(1, 36, 0, block.length);
  const tagged = `<DataArray type="UInt8" NumberOfComponents="3" format="binary">${header.toString('base64')}${block.toString('base64')}</DataArray>`;
  const compressor = 'compressor="vtkLZ4DataCompressor"';
  const model = await parseVTKXML(
    text(
      `<VTKFile type="PolyData" ${compressor}><PolyData><Piece NumberOfPoints="12"><Points>${tagged}</Points></Piece></PolyData></VTKFile>`,
    ),
  );
  assert.deepEqual([...model.positions], expected);
  const broken = Buffer.from([0x0f, 9, 0, 0]);
  const bad = `<DataArray type="UInt8" NumberOfComponents="3" format="binary">${u32(1, 36, 0, broken.length).toString('base64')}${broken.toString('base64')}</DataArray>`;
  await refuses(
    parseVTKXML(
      text(
        `<VTKFile type="PolyData" ${compressor}><PolyData><Piece NumberOfPoints="12"><Points>${bad}</Points></Piece></PolyData></VTKFile>`,
      ),
    ),
    'zip',
  );
});

test('every integer and float type reads, with 64-bit values as numbers', async () => {
  for (const [type, make] of [
    ['Int8', (v) => Buffer.from(new Int8Array(v).buffer)],
    ['UInt16', (v) => Buffer.from(new Uint16Array(v).buffer)],
    ['Int16', (v) => Buffer.from(new Int16Array(v).buffer)],
    ['Int32', (v) => Buffer.from(new Int32Array(v).buffer)],
    ['UInt32', (v) => Buffer.from(new Uint32Array(v).buffer)],
    ['Int64', (v) => Buffer.from(new BigInt64Array(v.map(BigInt)).buffer)],
    ['UInt64', (v) => Buffer.from(new BigUint64Array(v.map(BigInt)).buffer)],
    ['Float64', (v) => Buffer.from(new Float64Array(v).buffer)],
  ]) {
    const data = make(VALUES);
    const array = `<DataArray type="${type}" NumberOfComponents="3" format="binary">${u32(data.length).toString('base64')}${data.toString('base64')}</DataArray>`;
    await same(triangleFile(array));
  }
});

test('a hexahedron gives its six faces, and two sharing a face lose that face', async () => {
  const cube = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const one = await parseVTKXML(grid(cube, [0, 1, 2, 3, 4, 5, 6, 7], [8], [12]));
  assert.equal(one.indices.length / 3, 12);
  const two = [...cube, 0, 0, 2, 1, 0, 2, 1, 1, 2, 0, 1, 2];
  const stack = [0, 1, 2, 3, 4, 5, 6, 7, 4, 5, 6, 7, 8, 9, 10, 11];
  const shared = await parseVTKXML(grid(two, stack, [8, 16], [12, 12]));
  assert.equal(shared.indices.length / 3, 20);
  const all = await parseVTKXML(grid(two, stack, [8, 16], [12, 12]), { surface: 'all' });
  assert.equal(all.indices.length / 3, 24);
});

/** The signed volume of the closed surface: positive when every face looks outward. */
function volume({ positions: p, indices }) {
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t] * 3, indices[t + 1] * 3, indices[t + 2] * 3];
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

test('every volume cell type closes with its faces looking outward', async () => {
  const cases = [
    ['tetra', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], 10, 1 / 6],
    ['voxel', [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1], 11, 1],
    ['hexahedron', [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], 12, 1],
    ['wedge', [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], 13, 0.5],
    ['pyramid', [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1], 14, 1 / 3],
  ];
  for (const [name, coordinates, type, expected] of cases) {
    const count = coordinates.length / 3,
      model = await parseVTKXML(grid(coordinates, [...Array(count).keys()], [count], [type]));
    assert.ok(Math.abs(volume(model) - expected) < 1e-6, `${name}: ${volume(model)}`);
  }
  for (const [sides, type] of [
    [5, 15],
    [6, 16],
  ]) {
    const ring = (z) =>
      Array.from({ length: sides }, (_, i) => [
        Math.cos((i / sides) * 2 * Math.PI),
        Math.sin((i / sides) * 2 * Math.PI),
        z,
      ]).flat();
    const count = sides * 2,
      model = await parseVTKXML(grid([...ring(0), ...ring(1)], [...Array(count).keys()], [count], [type]));
    assert.ok(volume(model) > 0, `prism of ${sides}: ${volume(model)}`);
  }
});

test('surface cells, a pixel, line cells and second-order cells read in a grid', async () => {
  const model = await parseVTKXML(
    grid(
      [...QUAD, 2, 0, 0, 2, 1, 0],
      [0, 1, 2, 0, 1, 3, 2, 1, 4, 0, 1, 2, 3, 4, 5],
      [3, 7, 9, 15],
      [5, 8, 3, 22],
    ),
  );
  assert.deepEqual([...model.indices.subarray(0, 9)], [0, 1, 2, 0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...model.lines], [1, 4]);
  assert.deepEqual([...model.triangleCells], [0, 1, 1, 3]);
  assert.deepEqual(model.warnings, ['second-order cells are drawn from their corner points']);
});

test('a polyhedron reads its faces array, across a second cell', async () => {
  const tetra = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
  const faces = [4, 3, 0, 2, 1, 3, 0, 1, 3, 3, 1, 2, 3, 3, 0, 3, 2];
  const extra = ascii('Int32', 'faces', [...faces, ...faces]) + ascii('Int32', 'faceoffsets', [-1, 17, 34]);
  const model = await parseVTKXML(
    grid(tetra, [0, 1, 2, 0, 1, 2, 3, 0, 1, 2, 3], [3, 7, 11], [5, 42, 42], extra),
    { surface: 'all' },
  );
  assert.equal(model.indices.length / 3, 9);
  await refuses(parseVTKXML(grid(tetra, [0, 1, 2, 3], [4], [42])), 'syntax');
});

test('an unknown cell type warns and the rest still reads', async () => {
  const model = await parseVTKXML(grid(QUAD, [0, 1, 2, 0, 1, 2, 3], [3, 7], [5, 77]));
  assert.equal(model.indices.length, 3);
  assert.deepEqual(model.warnings, ['cell type 77 is not drawn']);
});

test('point data fills normals, uvs, colours and attributes; cell data stays by cell', async () => {
  const model = await parseVTKXML(
    poly(
      points(VALUES) +
        cells('Polys', [0, 1, 2], [3]) +
        `<PointData Normals="N" TCoords="T" Scalars="C">${ascii('Float32', 'N', [0, 0, 1, 0, 0, 1, 0, 0, 1], 3)}${ascii('Float32', 'T', [0, 0, 1, 0, 0, 1], 2)}${ascii('UInt8', 'C', [255, 0, 0, 0, 255, 0, 0, 0, 255], 3)}${ascii('Float64', 'pressure', [1, 2, 3])}<DataArray type="String" Name="tag" format="ascii">65 0</DataArray></PointData>` +
        `<CellData>${ascii('Int32', 'id', [7])}</CellData>`,
      'NumberOfPoints="3"',
    ),
  );
  assert.deepEqual([...model.normals], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...model.uvs], [0, 1, 1, 1, 0, 0]);
  assert.deepEqual([...model.colors], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  assert.deepEqual([...model.attributes.pressure], [1, 2, 3]);
  assert.equal(model.pointData.T.components, 2);
  assert.deepEqual([...model.cellData.id.values], [7]);
  assert.deepEqual(model.warnings, ['string arrays are not read']);
  assert.equal(Object.getPrototypeOf(model.pointData), null);
});

test('pieces merge, with cell indices moved past the earlier points', async () => {
  const piece = `<Piece NumberOfPoints="3">${points(VALUES)}${cells('Polys', [0, 1, 2], [3])}<CellData>${ascii('Int32', 'id', [1])}</CellData></Piece>`;
  const model = await parseVTKXML(text(`<VTKFile type="PolyData"><PolyData>${piece}${piece}</PolyData></VTKFile>`));
  assert.equal(model.positions.length, 18);
  assert.deepEqual([...model.indices], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...model.triangleCells], [0, 1]);
  assert.deepEqual([...model.cellData.id.values], [1, 1]);
  const half = `<Piece NumberOfPoints="3">${points(VALUES)}${cells('Polys', [0, 1, 2], [3])}</Piece>`;
  await refuses(parseVTKXML(text(`<VTKFile type="PolyData"><PolyData>${piece}${half}</PolyData></VTKFile>`)), 'syntax');
});

test('bad files are named errors', async () => {
  const counts = 'NumberOfPoints="3"';
  await refuses(parseVTKXML(text('<other/>')), 'header');
  await refuses(parseVTKXML(text('<VTKFile type="ImageData"/>')), 'unsupported');
  await refuses(parseVTKXML(text('<VTKFile type="PolyData"/>')), 'syntax');
  await refuses(parseVTKXML(text('<VTKFile type="PolyData"><PolyData/></VTKFile>')), 'syntax');
  await refuses(parseVTKXML(text('<VTKFile type="PolyData" header_type="UInt16"/>')), 'header');
  await refuses(parseVTKXML(text('<VTKFile type="PolyData" compressor="vtkOtherCompressor"/>')), 'unsupported');
  await refuses(parseVTKXML(poly('', counts)), 'syntax');
  await refuses(parseVTKXML(poly(points([0, 0]), counts)), 'syntax');
  await refuses(parseVTKXML(poly(points(['a', 0, 0, 1, 0, 0, 0, 1, 0]), counts)), 'syntax');
  await refuses(parseVTKXML(poly(points(VALUES) + cells('Polys', [0, 1, 9], [3]), counts)), 'range');
  await refuses(parseVTKXML(poly(points(VALUES) + cells('Polys', [0, 1, 2], [9]), counts)), 'range');
  await refuses(parseVTKXML(poly(`${points(VALUES)}<Polys></Polys>`, counts)), 'syntax');
  await refuses(parseVTKXML(poly(`${points(VALUES)}<PointData>${ascii('Float32', 'x', [1])}</PointData>`, counts)), 'syntax');
  await refuses(parseVTKXML(triangleFile(tag('appended', 'offset="0"'))), 'syntax');
  await refuses(parseVTKXML(triangleFile(tag('appended', 'offset="x"'))), 'syntax');
  await refuses(parseVTKXML(triangleFile(tag('binary', '', '!!!!'))), 'syntax');
  await refuses(parseVTKXML(triangleFile(tag('other'))), 'syntax');
  await refuses(parseVTKXML(triangleFile('<DataArray type="Half" format="ascii">0</DataArray>')), 'unsupported');
  await refuses(parseVTKXML(triangleFile(tag('appended', 'offset="0"'), '<AppendedData encoding="raw">')), 'truncated');
  await refuses(parseVTKXML(grid(VALUES, [0, 1, 2], [3], [10])), 'range');
  await refuses(parseVTKXML(grid(VALUES, [0, 1, 2], [3], [5, 5])), 'syntax');
});

test('sizes are checked before work, and an abort stops the read', async () => {
  const counts = 'NumberOfPoints="3"';
  await refuses(parseVTKXML(poly(points(VALUES), counts), { maxVertices: 2 }), 'limit');
  await refuses(parseVTKXML(poly(points(VALUES) + cells('Polys', [0, 1, 2], [3]), counts), { maxTriangles: 0 }), 'limit');
  const huge = u32(0xfffffff0).toString('base64') + f32(VALUES).toString('base64');
  await refuses(parseVTKXML(triangleFile(tag('binary', '', huge)), { maxVertices: 3, maxTriangles: 3 }), 'limit');
  await refuses(parseVTKXML(poly('', counts), { surface: 'some' }), 'range');
  const controller = new AbortController();
  controller.abort();
  await refuses(parseVTKXML(poly('', counts), { signal: controller.signal }), 'aborted');
});

test('real LZMA files from VTK 9.7.2, inline and appended, read the same numbers as the ascii twin', async () => {
  const read = (name) => parseVTKXML(readFileSync(new URL(`./fixtures/${name}`, import.meta.url))),
    plain = await read('sphere-ascii.vtp');
  assert.equal(plain.positions.length, 1122 * 3);
  for (const name of ['sphere-lzma.vtp', 'sphere-lzma-appended.vtp']) {
    const packed = await read(name);
    assert.deepEqual([...packed.positions], [...plain.positions], name);
    assert.deepEqual([...packed.indices], [...plain.indices], name);
  }
});

test('a broken LZMA block is a named error', async () => {
  const file = Buffer.from(readFileSync(new URL('./fixtures/sphere-lzma-appended.vtp', import.meta.url))),
    data = file.indexOf('<AppendedData'),
    at = file.indexOf('_', data) + 40;
  file[at] ^= 0xff;
  await refuses(parseVTKXML(file), 'zip');
});
