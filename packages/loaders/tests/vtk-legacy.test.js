import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVTKLegacy } from '@margoengine/loaders/vtk-legacy';
import { parseVTK } from '../dist/index.js';
const text = (s) => new TextEncoder().encode(s);
const head = (type, version = '3.0') =>
  `# vtk DataFile Version ${version}\nspec-derived fixture\nASCII\nDATASET ${type}\n`;
test('all structured dataset types keep x-fastest points, cells and both associations', () => {
  const tail =
    'CELL_DATA 1\nSCALARS pressure double\nLOOKUP_TABLE default\n1.12345678901234\nPOINT_DATA 8\nVECTORS velocity float\n' +
    Array(8).fill('1 2 3').join('\n') +
    '\n';
  const points = '0 0 0 1 0 0 0 2 0 1 2 0 0 0 3 1 0 3 0 2 3 1 2 3\n';
  const sp = parseVTKLegacy(text(head('STRUCTURED_POINTS') + 'DIMENSIONS 2 2 2\nORIGIN 0 0 0\nSPACING 1 2 3\n' + tail));
  const sg = parseVTKLegacy(text(head('STRUCTURED_GRID') + 'DIMENSIONS 2 2 2\nPOINTS 8 float\n' + points + tail));
  const rg = parseVTKLegacy(
    text(
      head('RECTILINEAR_GRID') +
        'DIMENSIONS 2 2 2\nX_COORDINATES 2 float\n0 1\nY_COORDINATES 2 double\n0 2\nZ_COORDINATES 2 float\n0 3\n' +
        tail,
    ),
  );
  for (const result of [sp, sg, rg]) {
    assert.deepEqual([...result.positions], points.trim().split(/\s+/).map(Number));
    assert.deepEqual([...result.connectivity], [0, 1, 3, 2, 4, 5, 7, 6]);
    assert.deepEqual([...result.offsets], [0, 8]);
    assert.deepEqual([...result.cellTypes], [12]);
    assert.equal(result.indices.length, 36);
    assert.equal(result.triangleCells.length, 12);
    assert.ok(result.triangleCells.every((c) => c === 0));
    assert.equal(result.cellData.pressure.values[0], 1.12345678901234);
    assert.equal(result.pointData.velocity.components, 3);
    assert.equal(result.cellCount, 1);
  }
});
test('structured 1D, 2D and singleton datasets emit lines, quads and vertices', () => {
  const one = parseVTKLegacy(text(head('STRUCTURED_POINTS') + 'DIMENSIONS 1 3 1\n'));
  assert.deepEqual([...one.lines], [0, 1, 1, 2]);
  assert.deepEqual([...one.lineCells], [0, 1]);
  const two = parseVTKLegacy(text(head('STRUCTURED_POINTS') + 'DIMENSIONS 1 2 2\n'));
  assert.equal(two.indices.length, 6);
  assert.deepEqual([...two.connectivity], [0, 1, 3, 2]);
  const zero = parseVTKLegacy(text(head('STRUCTURED_POINTS') + 'DIMENSIONS 1 1 1\n'));
  assert.deepEqual([...zero.vertices], [0]);
  assert.deepEqual([...zero.vertexCells], [0]);
});
test('polydata preserves VERTICES, polylines, polygons, strips and original cell-data addressing', () => {
  const result = parseVTKLegacy(
    text(
      head('POLYDATA') +
        'POINTS 4 float\n0 0 0 1 0 0 1 1 0 0 1 0\nVERTICES 1 3\n2 0 3\nLINES 1 4\n3 0 1 2\nPOLYGONS 1 5\n4 0 1 2 3\nTRIANGLE_STRIPS 1 5\n4 0 1 3 2\nCELL_DATA 4\nSCALARS id int\nLOOKUP_TABLE default\n10 20 30 40\n',
    ),
  );
  assert.deepEqual([...result.vertices], [0, 3]);
  assert.deepEqual([...result.vertexCells], [0, 0]);
  assert.deepEqual([...result.lines], [0, 1, 1, 2]);
  assert.deepEqual([...result.lineCells], [1, 1]);
  assert.deepEqual([...result.triangleCells], [2, 2, 3, 3]);
  assert.deepEqual([...result.cellData.id.values], [10, 20, 30, 40]);
});
test('unstructured mixed vertex, line, surface and shared volume cells retain topology', () => {
  const result = parseVTKLegacy(
    text(
      head('UNSTRUCTURED_GRID') +
        'POINTS 5 float\n0 0 0 1 0 0 0 1 0 0 0 1 0 0 -1\nCELLS 5 19\n1 4 2 0 1 3 0 1 2 4 0 1 2 3 4 0 2 1 4\nCELL_TYPES 5\n1 3 5 10 10\nCELL_DATA 5\nVECTORS v double\n' +
        Array(5).fill('1 2 3').join('\n') +
        '\n',
    ),
  );
  assert.equal(result.cellCount, 5);
  assert.deepEqual([...result.vertices], [4]);
  assert.deepEqual([...result.lines], [0, 1]);
  assert.equal(result.indices.length, 21); // one explicit triangle plus six outer tetra faces
  assert.deepEqual([...result.cellTypes], [1, 3, 5, 10, 10]);
  assert.equal(result.cellData.v.values.length, 15);
});
test('5.x offsets and connectivity match old cell layout, independent of header version', () => {
  for (const version of ['4.2', '5.1']) {
    const body =
      'POINTS 3 float\n0 0 0 1 0 0 0 1 0\nCELLS 3 5\nOFFSETS vtktypeint64\n0 2 5\nCONNECTIVITY vtktypeint64\n0 1 0 1 2\nCELL_TYPES 2\n3 5\n';
    const result = parseVTKLegacy(text(head('UNSTRUCTURED_GRID', version) + body));
    assert.deepEqual([...result.offsets], [0, 2, 5]);
    assert.deepEqual([...result.indices], [0, 1, 2]);
    assert.deepEqual([...result.lines], [0, 1]);
  }
});
test('all arrays, null-prototype names, FIELD values and source double precision survive', () => {
  const source =
    head('POLYDATA') +
    'POINTS 1 float\n0 0 0\nVERTICES 1 2\n1 0\nFIELD global 1\ntime 1 1 double\n0.123456789012345\nPOINT_DATA 1\nSCALARS __proto__ double 2\nLOOKUP_TABLE default\n1.123456789012345 2\nNORMALS n float\n0 0 1\nTEXTURE_COORDINATES uv 2 float\n0.25 0.75\nTENSORS t double\n1 2 3 4 5 6 7 8 9\nFIELD extra 1\nconstructor 3 1 float\n3 4 5\n';
  const result = parseVTKLegacy(text(source));
  assert.equal(Object.getPrototypeOf(result.pointData), null);
  assert.equal(result.pointData.__proto__.values[0], 1.123456789012345);
  assert.equal(result.fieldData.time.values[0], 0.123456789012345);
  assert.deepEqual([...result.pointData.constructor.values], [3, 4, 5]);
  assert.deepEqual([...result.pointData.t.values], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...result.normals], [0, 0, 1]);
  assert.deepEqual([...result.uvs], [0.25, 0.75]);
});
test('binary mixed data are big endian, sliced inputs preserve double and cell ordering', () => {
  const bytes = [
    ...text('# vtk DataFile Version 3.0\nbinary fixture\nBINARY\nDATASET UNSTRUCTURED_GRID\nPOINTS 3 float\n'),
  ];
  const put = (values, kind) => {
    for (const n of values) {
      const b = new Uint8Array(kind === 'double' ? 8 : 4),
        d = new DataView(b.buffer);
      if (kind === 'int') d.setInt32(0, n);
      else if (kind === 'double') d.setFloat64(0, n);
      else d.setFloat32(0, n);
      bytes.push(...b);
    }
    bytes.push(10);
  };
  put([0, 0, 0, 1, 0, 0, 0, 1, 0], 'float');
  bytes.push(...text('CELLS 2 7\n'));
  put([2, 0, 1, 3, 0, 1, 2], 'int');
  bytes.push(...text('CELL_TYPES 2\n'));
  put([3, 5], 'int');
  bytes.push(...text('CELL_DATA 2\nSCALARS temperature double\nLOOKUP_TABLE default\n'));
  put([1.123456789012345, 2.25], 'double');
  const payload = new Uint8Array(bytes.length + 8);
  payload.set(bytes, 4);
  const result = parseVTKLegacy(payload.subarray(4, -4));
  assert.deepEqual([...result.lines], [0, 1]);
  assert.deepEqual([...result.indices], [0, 1, 2]);
  assert.equal(result.cellData.temperature.values[0], 1.123456789012345);
});
test('malformed topology, mismatched associations and configured bounds reject', () => {
  for (const body of [
    'DIMENSIONS 2 0 2\n',
    'DIMENSIONS 2 2 2\nPOINT_DATA 7\n',
    'DIMENSIONS 2 2 2\nCELL_DATA 2\n',
    'DIMENSIONS 2 2 2\nSPACING 0 1 1\n',
  ])
    assert.throws(
      () => parseVTKLegacy(text(head('STRUCTURED_POINTS') + body)),
      (e) => e.name === 'LoaderError',
    );
  assert.throws(() => parseVTKLegacy(text(head('STRUCTURED_POINTS') + 'DIMENSIONS 3 3 3\n'), { maxVertices: 8 }), {
    code: 'limit',
  });
  assert.throws(() => parseVTKLegacy(text(head('STRUCTURED_POINTS') + 'DIMENSIONS 3 3 3\n'), { maxCells: 1 }), {
    code: 'limit',
  });
  const c = new AbortController();
  c.abort();
  assert.throws(() => parseVTKLegacy(new Uint8Array(), { signal: c.signal }), { code: 'aborted' });
  const bad = head('UNSTRUCTURED_GRID') + 'POINTS 1 float\n0 0 0\nCELLS 1 3\n2 0 2\nCELL_TYPES 1\n3\n';
  assert.throws(() => parseVTKLegacy(text(bad)), { code: 'range' });
});

test('legacy readers reject inexact integer attributes instead of silently rounding', () => {
  const bytes = text(
    head('POLYDATA') + 'POINTS 1 float\n0 0 0\nPOINT_DATA 1\nSCALARS id long\nLOOKUP_TABLE default\n9007199254740993\n',
  );
  for (const parse of [parseVTK, parseVTKLegacy]) assert.throws(() => parse(bytes), { code: 'range' });
});

test('packed binary and ASCII bit cell arrays retain exact booleans', () => {
  const body =
    'DATASET POLYDATA\nPOINTS 1 float\n0 0 0\nVERTICES 1 2\n1 0\nCELL_DATA 1\nSCALARS selected bit\nLOOKUP_TABLE default\n1\n';
  assert.deepEqual(
    [...parseVTKLegacy(text('# vtk DataFile Version 3.0\nbits\nASCII\n' + body)).cellData.selected.values],
    [1],
  );
  const prefix = text(
    '# vtk DataFile Version 3.0\nbits\nBINARY\nDATASET STRUCTURED_POINTS\nDIMENSIONS 3 2 1\nCELL_DATA 2\nSCALARS selected bit\nLOOKUP_TABLE default\n',
  );
  const binary = new Uint8Array([...prefix, 0b10000000, 10]);
  assert.deepEqual([...parseVTKLegacy(binary).cellData.selected.values], [1, 0]);
});

test('polyhedron face streams retain source topology and surface cell ownership', () => {
  const source =
    head('UNSTRUCTURED_GRID') +
    'POINTS 4 float\n0 0 0 1 0 0 0 1 0 0 0 1\nCELLS 1 18\n17 4 3 0 2 1 3 0 1 3 3 1 2 3 3 0 3 2\nCELL_TYPES 1\n42\n';
  const result = parseVTKLegacy(text(source));
  assert.equal(result.indices.length, 12);
  assert.deepEqual([...result.triangleCells], [0, 0, 0, 0]);
  assert.deepEqual([...result.connectivity], [4, 3, 0, 2, 1, 3, 0, 1, 3, 3, 1, 2, 3, 3, 0, 3, 2]);
  assert.throws(() => parseVTKLegacy(text(source.replace('17 4 3', '17 5 3'))), { code: 'range' });
});
