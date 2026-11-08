import test from 'node:test';
import assert from 'node:assert/strict';
import { gridSurface, sliceGrid, checkGrid, parseVtk, CELL_TYPES } from '@margoengine/sciviz/grids';

// A structured block of n x n x n unit hexahedra over [0, n]^3, in VTK node order, with pointData = x + 2y + 3z.
function block(n) {
  const points = [],
    id = (i, j, k) => (k * (n + 1) + j) * (n + 1) + i;
  for (let k = 0; k <= n; k++) for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) points.push(i, j, k);
  const connectivity = [],
    offsets = [],
    types = [],
    cellData = [];
  for (let k = 0; k < n; k++)
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        connectivity.push(id(i, j, k), id(i + 1, j, k), id(i + 1, j + 1, k), id(i, j + 1, k));
        connectivity.push(id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1));
        offsets.push(connectivity.length);
        types.push(CELL_TYPES.hexahedron);
        cellData.push(offsets.length - 1);
      }
  const pointData = [];
  for (let p = 0; p < points.length; p += 3) pointData.push(points[p] + 2 * points[p + 1] + 3 * points[p + 2]);
  return { points, connectivity, offsets, types, pointData, cellData };
}

// The unit cube cut into five tetrahedra (a corner tet at each of four corners plus the middle one).
function fiveTets() {
  const points = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
  const tets = [
    [0, 1, 3, 4],
    [1, 2, 3, 6],
    [1, 4, 5, 6],
    [3, 4, 6, 7],
    [1, 3, 4, 6],
  ];
  // VTK's tetra wants the fourth point above the first three's counter-clockwise face; fix each by its volume sign.
  const vol = (t) => {
    const p = (i) => points.slice(t[i] * 3, t[i] * 3 + 3),
      [a, b, c, d] = [0, 1, 2, 3].map(p),
      u = b.map((x, k) => x - a[k]),
      v = c.map((x, k) => x - a[k]),
      w = d.map((x, k) => x - a[k]);
    return u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
  };
  const connectivity = tets.flatMap((t) => (vol(t) > 0 ? t : [t[0], t[2], t[1], t[3]]));
  return {
    points,
    connectivity,
    offsets: tets.map((_, k) => (k + 1) * 4),
    types: tets.map(() => CELL_TYPES.tetra),
    pointData: [0, 1, 2, 3, 4, 5, 6, 7],
  };
}

const area = (set) => {
  let total = 0;
  for (let t = 0; t < set.positions.length; t += 9) {
    const p = set.positions,
      u = [p[t + 3] - p[t], p[t + 4] - p[t + 1], p[t + 5] - p[t + 2]],
      v = [p[t + 6] - p[t], p[t + 7] - p[t + 1], p[t + 8] - p[t + 2]];
    total += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return total;
};
// True when every triangle's normal points away from `centre`.
const outward = (set, centre) => {
  for (let t = 0; t < set.positions.length; t += 9) {
    const c = [0, 1, 2].map((k) => (set.positions[t + k] + set.positions[t + 3 + k] + set.positions[t + 6 + k]) / 3 - centre[k]);
    if (c[0] * set.normals[t] + c[1] * set.normals[t + 1] + c[2] * set.normals[t + 2] <= 0) return false;
  }
  return true;
};
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('the outer surface of a hex block keeps only unshared faces, faces out and carries the point data', () => {
  const grid = block(3),
    surface = gridSurface(grid);
  assert.equal(surface.positions.length / 9, 6 * 9 * 2);
  close(area(surface), 6 * 9);
  assert.ok(outward(surface, [1.5, 1.5, 1.5]));
  for (let c = 0; c < surface.values.length; c++) {
    const [x, y, z] = surface.positions.slice(c * 3, c * 3 + 3);
    close(surface.values[c], x + 2 * y + 3 * z, 1e-5);
  }
  assert.deepEqual(surface.bounds, [0, 3, 0, 3, 0, 3]);
  const cells = gridSurface(grid, { values: 'cell' });
  for (let t = 0; t < cells.cells.length; t++) for (let k = 0; k < 3; k++) assert.equal(cells.values[t * 3 + k], cells.cells[t]);
});

test('tetra, wedge and pyramid surfaces close with their exact areas, facing out', () => {
  const tets = fiveTets(),
    surface = gridSurface(tets);
  close(area(surface), 6);
  assert.ok(outward(surface, [0.5, 0.5, 0.5]));
  // A unit right wedge (triangle 0-1-2 at z = 0, 3-4-5 at z = 1) and a square pyramid of height 1.
  const wedge = gridSurface({
    points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1],
    connectivity: [0, 1, 2, 3, 4, 5],
    offsets: [6],
    types: [CELL_TYPES.wedge],
    cellData: [7],
  });
  close(area(wedge), 0.5 + 0.5 + 1 + 1 + Math.SQRT2);
  assert.ok(outward(wedge, [1 / 3, 1 / 3, 0.5]));
  assert.ok(wedge.values.every((v) => v === 7));
  const pyramid = gridSurface({
    points: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0.5, 0.5, 1],
    connectivity: [0, 1, 2, 3, 4],
    offsets: [5],
    types: [CELL_TYPES.pyramid],
  });
  close(area(pyramid), 1 + 4 * (0.5 * Math.hypot(0.5, 1)));
  assert.ok(outward(pyramid, [0.5, 0.5, 0.25]));
});

test('a slice cuts every crossed cell into one polygon: exact areas with no cracks, interpolated values', () => {
  const grid = block(2);
  // An axis plane between nodes and one through a node layer give the full 2 x 2 square.
  for (const offset of [0.7, 1]) {
    const cut = sliceGrid(grid, { normal: [1, 0, 0], offset });
    close(area(cut), 4);
    for (let c = 0; c < cut.values.length; c++) {
      const [x, y, z] = cut.positions.slice(c * 3, c * 3 + 3);
      close(x, offset, 1e-6);
      close(cut.values[c], x + 2 * y + 3 * z, 1e-5);
    }
  }
  // A diagonal plane x + y = 2 crosses the block in a 2 sqrt 2 by 2 rectangle; x + y + z = 3 in a regular hexagon.
  close(area(sliceGrid(grid, { normal: [1, 1, 0], offset: 2 })), 4 * Math.SQRT2, 1e-9);
  const hexagon = 3 * Math.sqrt(3); // side sqrt 2, area (3 sqrt 3 / 2) side^2
  close(area(sliceGrid(grid, { normal: [1, 1, 1], offset: 3 })), hexagon, 1e-9);
  // The same cut through five tetrahedra of the unit cube gives the cube's section too.
  close(area(sliceGrid(fiveTets(), { normal: [0, 0, 1], offset: 0.25 })), 1, 1e-12);
  close(area(sliceGrid(fiveTets(), { normal: [1, 1, 1], offset: 1.5 })), (3 * Math.sqrt(3)) / 4, 1e-12);
  // Faces along the plane's normal.
  const cut = sliceGrid(grid, { normal: [0, 0, 2], offset: 1.2 });
  for (let t = 0; t < cut.normals.length; t += 3) close(Math.abs(cut.normals[t + 2]), 1);
  // Cell data stays constant per cell; a plane outside the grid cuts nothing.
  const cells = sliceGrid(grid, { normal: [0, 1, 0], offset: 0.5 }, { values: 'cell' });
  for (let t = 0; t < cells.cells.length; t++) assert.equal(cells.values[t * 3], cells.cells[t]);
  assert.equal(sliceGrid(grid, { normal: [1, 0, 0], offset: 9 }).positions.length, 0);
});

test('bad grids are refused naming what is wrong', () => {
  const good = block(1);
  assert.equal(checkGrid(good), 1);
  assert.throws(() => checkGrid({ ...good, types: [99] }), /VTK type 99/);
  assert.throws(() => checkGrid({ ...good, offsets: [7] }), RangeError);
  assert.throws(() => checkGrid({ ...good, connectivity: [0, 1, 2, 3, 4, 5, 6, 99] }), /point 99/);
  assert.throws(() => checkGrid({ ...good, pointData: [1] }), RangeError);
  assert.throws(() => gridSurface({ ...good, cellData: undefined }, { values: 'cell' }), TypeError);
  assert.throws(() => sliceGrid(good, { normal: [0, 0, 0], offset: 0 }), RangeError);
  assert.throws(() => checkGrid({}), TypeError);
});

// Signed volume of a closed triangle surface (divergence theorem): positive only when every triangle faces out.
const volume = (set) => {
  let total = 0;
  const p = set.positions;
  for (let t = 0; t < p.length; t += 9)
    total +=
      (p[t] * (p[t + 4] * p[t + 8] - p[t + 5] * p[t + 7]) -
        p[t + 1] * (p[t + 3] * p[t + 8] - p[t + 5] * p[t + 6]) +
        p[t + 2] * (p[t + 3] * p[t + 7] - p[t + 4] * p[t + 6])) /
      6;
  return total;
};

// Each cell at the parametric coordinates of its points as "VTK File Formats" figure 2 numbers them (the wedge as
// corrected in VTK 9.7: 0-1-2 counter-clockwise seen from 3-4-5). A face run the wrong way gives a smaller or negative
// volume. The wedge's earlier face list did, and this test failed before the fix.
test('every cell type closes with its exact positive volume in VTK point order', () => {
  const cases = [
    [CELL_TYPES.tetra, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], 1 / 6],
    [CELL_TYPES.hexahedron, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1], 1],
    [CELL_TYPES.wedge, [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1], 1 / 2],
    [CELL_TYPES.pyramid, [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1], 1 / 3],
  ];
  for (const [type, points, expected] of cases) {
    const n = points.length / 3,
      surface = gridSurface({ points, connectivity: [...Array(n).keys()], offsets: [n], types: [type], cellData: [0] });
    close(volume(surface), expected, 1e-12);
  }
});

// A small legacy file in the layout "VTK File Formats" sets out: two hexahedra, a voxel, a wedge, a pyramid and a
// tetrahedron, plus a triangle and a line that are not volume cells.
function legacy() {
  const points = [];
  for (let k = 0; k <= 1; k++) for (let j = 0; j <= 1; j++) for (let i = 0; i <= 3; i++) points.push(i, j, k); // 0..15
  points.push(4, 0, 0, 4, 1, 0, 4, 0, 1, 4, 1, 1); // 16..19, the voxel's far side
  points.push(0, 0, 2, 0.5, 0.5, 2); // 20 ends the line, 21 tops the pyramid
  const id = (i, j, k) => k * 8 + j * 4 + i;
  const cells = [
    [CELL_TYPES.hexahedron, [id(0, 0, 0), id(1, 0, 0), id(1, 1, 0), id(0, 1, 0), id(0, 0, 1), id(1, 0, 1), id(1, 1, 1), id(0, 1, 1)]],
    [CELL_TYPES.hexahedron, [id(1, 0, 0), id(2, 0, 0), id(2, 1, 0), id(1, 1, 0), id(1, 0, 1), id(2, 0, 1), id(2, 1, 1), id(1, 1, 1)]],
    [11, [id(3, 0, 0), 16, id(3, 1, 0), 17, id(3, 0, 1), 18, id(3, 1, 1), 19]],
    [5, [0, 1, 2]],
    [CELL_TYPES.wedge, [id(2, 0, 0), id(3, 0, 0), id(2, 1, 0), id(2, 0, 1), id(3, 0, 1), id(2, 1, 1)]],
    [3, [0, 20]],
    [CELL_TYPES.pyramid, [id(0, 0, 1), id(1, 0, 1), id(1, 1, 1), id(0, 1, 1), 21]],
    [CELL_TYPES.tetra, [id(3, 1, 0), id(2, 1, 0), id(3, 0, 0), id(3, 1, 1)]],
  ];
  return { points, cells };
}
function legacyText({ points, cells }) {
  const n = points.length / 3,
    size = cells.reduce((s, [, ids]) => s + 1 + ids.length, 0);
  return [
    '# vtk DataFile Version 3.0',
    'six volume cells',
    'ASCII',
    'DATASET UNSTRUCTURED_GRID',
    `POINTS ${n} float`,
    points.join(' '),
    `CELLS ${cells.length} ${size}`,
    ...cells.map(([, ids]) => `${ids.length} ${ids.join(' ')}`),
    `CELL_TYPES ${cells.length}`,
    ...cells.map(([type]) => type),
    `CELL_DATA ${cells.length}`,
    'SCALARS material int',
    'LOOKUP_TABLE default',
    cells.map((_, c) => c * 10).join(' '),
    'FIELD extra 1',
    `ids 1 ${cells.length} int`,
    cells.map((_, c) => c).join(' '),
    `POINT_DATA ${n}`,
    'VECTORS flow float',
    Array.from({ length: n }, () => '1 0 0').join(' '),
    'SCALARS heat double 2',
    'LOOKUP_TABLE default',
    Array.from({ length: n }, (_, i) => `${points[i * 3] + 2 * points[i * 3 + 1] + 3 * points[i * 3 + 2]} -1`).join(' '),
    'LOOKUP_TABLE mine 2',
    '0 0 0 1 1 1 1 1',
    '',
  ].join('\n');
}

// The same file in BINARY: keyword lines in ASCII, data big-endian straight after each keyword line's newline.
function legacyBinary({ points, cells }) {
  const parts = [],
    text = (s) => parts.push(new TextEncoder().encode(s)),
    data = (values, type) => {
      const size = type === 'double' ? 8 : 4,
        view = new DataView(new ArrayBuffer(values.length * size));
      values.forEach((v, i) =>
        type === 'float' ? view.setFloat32(i * 4, v) : type === 'double' ? view.setFloat64(i * 8, v) : view.setInt32(i * 4, v),
      );
      parts.push(new Uint8Array(view.buffer));
      text('\n');
    };
  const n = points.length / 3,
    list = cells.flatMap(([, ids]) => [ids.length, ...ids]);
  text(`# vtk DataFile Version 2.0\nsix volume cells\nBINARY\nDATASET UNSTRUCTURED_GRID\nPOINTS ${n} float\n`);
  data(points, 'float');
  text(`CELLS ${cells.length} ${list.length}\n`);
  data(list, 'int');
  text(`CELL_TYPES ${cells.length}\n`);
  data(cells.map(([t]) => t), 'int');
  text(`CELL_DATA ${cells.length}\nSCALARS material int 1\nLOOKUP_TABLE default\n`);
  data(cells.map((_, c) => c * 10), 'int');
  text(`POINT_DATA ${n}\nSCALARS heat double\nLOOKUP_TABLE default\n`);
  data(Array.from({ length: n }, (_, i) => points[i * 3] + 2 * points[i * 3 + 1] + 3 * points[i * 3 + 2]), 'double');
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) out.set(p, at), (at += p.length);
  return out;
}

// One cell of a grid as a grid of its own.
const cellOf = (grid, c) => {
  const start = c ? grid.offsets[c - 1] : 0;
  return {
    points: grid.points,
    connectivity: grid.connectivity.slice(start, grid.offsets[c]),
    offsets: [grid.offsets[c] - start],
    types: [grid.types[c]],
    cellData: [0],
  };
};

test('parseVtk reads a legacy unstructured grid in ASCII and BINARY alike', () => {
  const source = legacy(),
    ascii = legacyText(source);
  for (const grid of [parseVtk(ascii), parseVtk(legacyBinary(source)), parseVtk(new TextEncoder().encode(ascii).buffer)]) {
    assert.equal(grid.title, 'six volume cells');
    assert.equal(grid.skipped, 2);
    assert.deepEqual([...grid.types], [12, 12, 12, 13, 14, 10]);
    // The triangle and the line are gone from the cell data too.
    assert.deepEqual([...grid.cellData], [0, 10, 20, 40, 60, 70]);
    assert.deepEqual([...grid.cellArrays.material], [...grid.cellData]);
    assert.equal(grid.pointData.length, 22);
    assert.equal(grid.pointArrays.heat[5], 1 + 2 * 1);
    // Every cell, the voxel read as a hexahedron included, closes with its exact positive volume.
    for (const [c, v] of [1, 1, 1, 0.5, 1 / 3, 1 / 6].entries()) close(volume(gridSurface(cellOf(grid, c))), v, 1e-6);
  }
});

test('parseVtk refuses what it does not read, naming it', () => {
  assert.throws(() => parseVtk('hello'), /first line/);
  assert.throws(() => parseVtk('# vtk DataFile Version 5.1\nx\nASCII\nDATASET UNSTRUCTURED_GRID\n'), /5\.1/);
  assert.throws(() => parseVtk('# vtk DataFile Version 3.0\nx\nASCII\nDATASET POLYDATA\n'), /POLYDATA/);
  assert.throws(() => parseVtk('# vtk DataFile Version 3.0\nx\nHEX\n'), /ASCII or BINARY/);
  assert.throws(() => parseVtk('# vtk DataFile Version 3.0\nx\nBINARY\nDATASET UNSTRUCTURED_GRID\nPOINTS 1 long\n12345678'), /long/);
  assert.throws(() => parseVtk('# vtk DataFile Version 3.0\nx\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 2 float\n0 0'), /ends early/);
  const ok = legacyText(legacy());
  assert.throws(() => parseVtk(ok.replace('CELL_TYPES 8', 'CELL_TYPES 7')), /CELL_TYPES/);
  assert.throws(() => parseVtk(ok.replace('CELL_DATA 8', 'CELL_DATA 9')), /CELL_DATA/);
  assert.throws(() => parseVtk(ok.replace('SCALARS material int', 'SCALARS material int 5')), /components/);
});
