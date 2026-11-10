import assert from 'node:assert/strict';
import test from 'node:test';
import { openVTKXMLDataset } from '../dist/vtk-xml.js';

test('lazy RectilinearGrid axes retain unnamed arrays in axis order', async () => {
  const bytes = new TextEncoder().encode(
    '<VTKFile type="RectilinearGrid"><RectilinearGrid WholeExtent="0 1 0 0 0 0"><Piece><Coordinates><DataArray type="Float64">3 1</DataArray><DataArray type="Float32">7</DataArray><DataArray type="Int32">9</DataArray></Coordinates></Piece></RectilinearGrid></VTKFile>',
  );
  const file = openVTKXMLDataset(bytes);
  assert.equal(file.type, 'RectilinearGrid');
  assert.deepEqual(await Promise.all(file.pieces[0].coordinates.map(async (a) => [...(await a.read())])), [
    [3, 1],
    [7],
    [9],
  ]);
});
test('lazy PolyData retains all four topology groups instead of discarding them', async () => {
  const groups = ['Verts', 'Lines', 'Polys', 'Strips'],
    body = groups
      .map(
        (name, i) =>
          `<${name}><DataArray type="Int32" Name="connectivity">${Array.from({ length: i + 1 }, (_, k) => k).join(' ')}</DataArray><DataArray type="Int32" Name="offsets">${i + 1}</DataArray></${name}>`,
      )
      .join('');
  const file = openVTKXMLDataset(
    new TextEncoder().encode(`<VTKFile type="PolyData"><PolyData><Piece>${body}</Piece></PolyData></VTKFile>`),
  );
  assert.deepEqual(Object.keys(file.pieces[0].topology), groups);
  for (let i = 0; i < groups.length; i++)
    assert.deepEqual([...(await file.pieces[0].topology[groups[i]].offsets.read())], [i + 1]);
});
