import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVTKLegacy } from '@margoengine/loaders/vtk-legacy';
import { parseVTKXML } from '../dist/vtk-xml.js';

// Original right triangular prism in VTK's published point order: base 0,2,1 faces away from 3,4,5.
const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1]];
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot = (a, b) => a.reduce((sum, x, i) => sum + x*b[i], 0);

test('legacy and XML wedges retain outward faces under positive affine transforms', async () => {
  for (const surface of ['outer', 'all']) for (const transformed of [false, true]) {
    const p = points.map(([x, y, z]) => transformed ? [10 + 2*x + z, -3 + 3*y, 7 + 4*z] : [x, y, z]);
    const coordinates = p.flat().join(' ');
    const legacy = `# vtk DataFile Version 3.0\noriginal wedge\nASCII\nDATASET UNSTRUCTURED_GRID\nPOINTS 6 float\n${coordinates}\nCELLS 1 7\n6 0 1 2 3 4 5\nCELL_TYPES 1\n13\n`;
    const xml = `<VTKFile type="UnstructuredGrid"><UnstructuredGrid><Piece NumberOfPoints="6" NumberOfCells="1"><Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">${coordinates}</DataArray></Points><Cells><DataArray type="Int32" Name="connectivity" format="ascii">0 1 2 3 4 5</DataArray><DataArray type="Int32" Name="offsets" format="ascii">6</DataArray><DataArray type="UInt8" Name="types" format="ascii">13</DataArray></Cells></Piece></UnstructuredGrid></VTKFile>`;
    const encode = text => new TextEncoder().encode(text);
    for (const mesh of [parseVTKLegacy(encode(legacy), { surface }), await parseVTKXML(encode(xml), { surface })]) {
      assert.equal(mesh.indices.length, 24);
      assert.deepEqual(Array.from(mesh.positions), p.flat());
      assert.ok(mesh.triangleCells.every(cell => cell === 0));
      const center = p[0].map((_, k) => p.reduce((sum, v) => sum + v[k], 0) / p.length);
      let volume6 = 0;
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const [a, b, c] = Array.from(mesh.indices.subarray(i, i + 3), index => p[index]);
        const normal = cross(b.map((x, k) => x-a[k]), c.map((x, k) => x-a[k]));
        const outward = a.map((x, k) => (x+b[k]+c[k])/3-center[k]);
        assert.ok(dot(normal, outward) > 0, 'every triangle faces away from the interior');
        volume6 += dot(a, cross(b, c));
      }
      assert.equal(volume6 / 6, transformed ? 12 : 0.5);
    }
  }
});
