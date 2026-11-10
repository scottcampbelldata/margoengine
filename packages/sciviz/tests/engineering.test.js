import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readCGNS } from '../dist/cgns.js';
import { readXDMF } from '../dist/xdmf.js';
import { readExodus } from '../dist/exodus.js';
import { readOpenFOAM } from '../dist/openfoam.js';
import { readEnSight } from '../dist/ensight.js';
import { integrateGrid } from '../dist/probe.js';
const root = new URL('./fixtures/engineering/', import.meta.url),
  bytes = (name) => readFileSync(new URL(name, root));
const files = (prefix = '') => ({ resolve: async (name) => bytes(prefix + name) });
test('engineering sample provenance pins every retained original and owner output', { timeout: 10000 }, () => {
  const manifest = JSON.parse(bytes('source.json'));
  for (const entry of manifest.files) {
    const data = bytes(entry.path);
    assert.equal(data.length, entry.bytes, entry.path);
    assert.equal(createHash('sha256').update(data).digest('hex'), entry.sha256, entry.path);
  }
});
test('NASA TMR CGNS owner-converted structured and prism grids preserve original coordinates', {
  timeout: 30000,
}, async () => {
  const structured = await readCGNS(bytes('nasa-struct-hdf.cgns')),
    triangles = await readCGNS(bytes('nasa-tri-hdf.cgns'));
  assert.equal(structured.points.length / 3, 1750);
  assert.equal(structured.types.length, 816);
  assert.equal(triangles.points.length / 3, 1750);
  assert.ok(triangles.types.length >= 1632);
  const a = await integrateGrid(structured),
    b = await integrateGrid(triangles);
  assert.ok(Math.abs(a.volume.measure - b.volume.measure) < 1e-10);
  await assert.rejects(readCGNS(bytes('nasa-struct-hdf.cgns'), { zone: 'absent' }), /no matching/);
});
test('Xdmf owner library output keeps HDF topology, point tuples and cell arrays', { timeout: 10000 }, async () => {
  const grid = await readXDMF(bytes('owner.xmf'), files());
  assert.deepEqual([...grid.types], [10]);
  assert.deepEqual([...grid.pointArrays.temperature], [10, 20, 30, 40]);
  assert.deepEqual([...grid.pointArrays.velocity], [1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3]);
  assert.deepEqual([...grid.cellArrays.stress], [7]);
});
for (const format of ['classic', 'netcdf4'])
  test(`Exodus owner library ${format} results and time selections`, { timeout: 10000 }, async () => {
    const grid = await readExodus(bytes(`exodus-${format}.exo`), { timeIndex: 1 });
    assert.deepEqual([...grid.types], [10]);
    assert.deepEqual([...grid.times], [0, 1]);
    assert.deepEqual([...grid.pointArrays.temperature], [20, 40, 60, 80]);
    assert.deepEqual([...grid.cellArrays.stress], [14]);
    assert.deepEqual([...grid.nodeIds], [1, 2, 3, 4]);
    assert.equal(grid.elementBlocks[0].id, 100);
    assert.deepEqual([...grid.elementBlocks[0].arrays.stress], [14]);
  });
test('SEACAS can real Exodus database preserves geometry and all nine nodal results', { timeout: 30000 }, async () => {
  const grid = await readExodus(bytes('seacas-can.ex2'));
  assert.equal(grid.points.length / 3, 10088);
  assert.equal(grid.types.length, 7152);
  assert.equal(Object.keys(grid.pointArrays).length, 9);
  assert.ok(grid.cellArrays.EQPS.length === 7152);
});
for (const format of ['ascii', 'binary'])
  test(`OpenFOAM owner blockMesh/foamFormatConvert ${format} mesh and fields`, { timeout: 10000 }, async () => {
    const grid = await readOpenFOAM(new Uint8Array(), { ...files(`foam-owner-${format}/`), fields: ['p', 'U'] });
    assert.deepEqual(grid.names, ['internalMesh', 'walls']);
    const internal = grid.blocks[0],
      walls = grid.blocks[1];
    assert.equal(internal.sourceCells.at(-1), 7);
    assert.ok(Math.abs((await integrateGrid(internal)).volume.measure - 1) < 1e-12);
    for (let i = 0; i < internal.cellArrays.p.length; i++)
      assert.equal(internal.cellArrays.p[i], internal.sourceCells[i] + 1);
    assert.ok([...walls.cellArrays.p].every((v) => v === 9));
    assert.deepEqual([...internal.cellArrays.U.slice(0, 3)], [1, 2, 3]);
    assert.deepEqual([...walls.cellArrays.U.slice(0, 3)], [4, 5, 6]);
  });
test('OpenFOAM real airfoil polyMesh retains all named patches', { timeout: 60000 }, async () => {
  const grid = await readOpenFOAM(new Uint8Array(), files('foam-ascii/'));
  assert.deepEqual(grid.names, ['internalMesh', 'inlet', 'outlet', 'walls', 'frontAndBack']);
  assert.equal(grid.blocks[0].sourceCells.at(-1), 10719);
});
test('Ansys EnSight 10.2 Gold binary aircraft keeps parts and six nodal fields', { timeout: 60000 }, async () => {
  const grid = await readEnSight(bytes('ensight-owner/extra300_RC_Plane_nodal.case'), {
    ...files('ensight-owner/'),
    maxPoints: 3000000,
  });
  assert.equal(grid.blocks.length, 15);
  assert.equal(grid.points.length / 3, 316350);
  assert.ok(grid.names.includes('wing_upper_surface'));
  assert.equal(Object.keys(grid.blocks[0].pointArrays).length, 6);
  assert.equal(grid.blocks[0].pointArrays.velocity.length, grid.blocks[0].points.length);
});
