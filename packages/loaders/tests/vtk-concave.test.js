// Regression: VTK polygons (cell type 7) may be concave, so the readers ear-clip them instead of fanning them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVTKLegacy } from '../dist/vtk-legacy.js';
import { parseVTKXML } from '../dist/vtk-xml.js';
import { parseVTK } from '../dist/index.js';

const text = (s) => new TextEncoder().encode(s);
// A notched pentagon, counter-clockwise seen from +z, area 10; a fan from corner 0 leaves the shape.
const POINTS = '0 0 0 4 0 0 4 4 0 2 1 0 0 4 0';
const signedAreas = ({ positions: p, indices }) => {
  const out = [];
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => indices[t + k] * 3);
    out.push(((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a])) / 2);
  }
  return out;
};
const covers = (mesh, label) => {
  const areas = signedAreas(mesh);
  assert.equal(areas.length, 3, label);
  assert.ok(areas.every((a) => a > 0), `${label}: every triangle keeps the polygon's turn: ${areas}`);
  assert.ok(Math.abs(areas.reduce((s, a) => s + a, 0) - 10) < 1e-9, `${label}: the triangles cover it exactly`);
};
const legacy = (cells) =>
  text(`# vtk DataFile Version 3.0\nconcave\nASCII\nDATASET ${cells}`);

test('regression: a concave POLYGONS cell is ear-clipped by parseVTK and parseVTKLegacy', () => {
  const file = legacy(`POLYDATA\nPOINTS 5 float\n${POINTS}\nPOLYGONS 1 6\n5 0 1 2 3 4\n`);
  covers(parseVTK(file), 'parseVTK');
  covers(parseVTKLegacy(file), 'parseVTKLegacy');
  const grid = legacy(`UNSTRUCTURED_GRID\nPOINTS 5 float\n${POINTS}\nCELLS 1 6\n5 0 1 2 3 4\nCELL_TYPES 1\n7\n`);
  const mesh = parseVTKLegacy(grid);
  covers(mesh, 'unstructured polygon');
  assert.deepEqual([...mesh.triangleCells], [0, 0, 0]);
  // A convex polygon still fans from corner 0, as before.
  const square = parseVTK(legacy('POLYDATA\nPOINTS 4 float\n0 0 0 1 0 0 1 1 0 0 1 0\nPOLYGONS 1 5\n4 0 1 2 3\n'));
  assert.deepEqual([...square.indices], [0, 1, 2, 0, 2, 3]);
});

test('regression: a concave Polys cell is ear-clipped by parseVTKXML', async () => {
  const array = (type, name, values, components = 1) =>
    `<DataArray type="${type}" Name="${name}" NumberOfComponents="${components}" format="ascii">${values}</DataArray>`;
  const file = `<VTKFile type="PolyData"><PolyData><Piece NumberOfPoints="5" NumberOfPolys="1">
    <Points>${array('Float32', 'p', POINTS, 3)}</Points>
    <Polys>${array('Int32', 'connectivity', '0 1 2 3 4')}${array('Int32', 'offsets', '5')}</Polys>
  </Piece></PolyData></VTKFile>`;
  covers(await parseVTKXML(text(file)), 'parseVTKXML');
});
