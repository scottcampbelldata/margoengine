import assert from 'node:assert/strict';
import test from 'node:test';
import { readXDMF } from '../dist/xdmf.js';
import { readCGNS } from '../dist/cgns.js';
import { readEnSight } from '../dist/ensight.js';
import { readFileSync } from 'node:fs';
const xml = (grid) => new TextEncoder().encode(`<Xdmf Version="3.0"><Domain>${grid}</Domain></Xdmf>`);
const item = (data, dims) => `<DataItem Dimensions="${dims}">${data}</DataItem>`;
const simple = (attributes = '') =>
  `<Grid Name="tetra"><Topology TopologyType="Tetrahedron">${item('0 1 2 3', '1 4')}</Topology><Geometry GeometryType="XYZ">${item('0 0 0 1 0 0 0 1 0 0 0 1', '4 3')}</Geometry>${attributes}</Grid>`;
test('Xdmf mixed topology, separate axes, JOIN and temporal collections', { timeout: 10000 }, async () => {
  const g = await readXDMF(
    xml(
      `<Grid CollectionType="Temporal"><Grid><Topology TopologyType="Mixed">${item('6 0 1 2 3', '5')}</Topology><Geometry GeometryType="X_Y_Z">${item('0 1 0 0', '4')}${item('0 0 1 0', '4')}${item('0 0 0 1', '4')}</Geometry><Attribute Name="vec"><DataItem ItemType="Function" Function="JOIN($0,$1,$2)" Dimensions="4 3">${item('1 2 3 4', '4')}${item('5 6 7 8', '4')}${item('9 10 11 12', '4')}</DataItem></Attribute></Grid>${simple()}</Grid>`,
    ),
  );
  assert.deepEqual([...g.types], [10]);
  assert.deepEqual([...g.pointArrays.vec], [1, 5, 9, 2, 6, 10, 3, 7, 11, 4, 8, 12]);
});
test('Xdmf hyperslabs and references select declared values without evaluating JavaScript', {
  timeout: 10000,
}, async () => {
  const a = `<Attribute Name="selected"><DataItem ItemType="HyperSlab" Dimensions="4">${item('1 2 4', '3 1')}${item('0 10 20 30 40 50 60 70', '8')}</DataItem></Attribute>`;
  const g = await readXDMF(xml(simple(a)));
  assert.deepEqual([...g.pointArrays.selected], [10, 30, 50, 70]);
  const ref = await readXDMF(xml(simple() + '<Grid Reference="XML">/Xdmf/Domain/Grid[1]</Grid>'));
  assert.equal(ref.blocks.length, 2);
  await assert.rejects(readXDMF(xml(simple(a.replace('1 2 4', '7 2 4')))), /hyperslab/);
  await assert.rejects(
    readXDMF(xml(simple(a.replace('ItemType="HyperSlab"', 'ItemType="Function" Function="eval($0)"')))),
    /supports JOIN/,
  );
});
test('Xdmf regular axes use reversed structured dimensions and origin/spacing order', { timeout: 10000 }, async () => {
  const grid = await readXDMF(
    xml(
      `<Grid><Topology TopologyType="3DCoRectMesh" Dimensions="2 2 3"/><Geometry GeometryType="ORIGIN_DXDYDZ">${item('30 20 10', '3')}${item('3 2 1', '3')}</Geometry></Grid>`,
    ),
  );
  assert.deepEqual([...grid.points.slice(0, 9)], [10, 20, 30, 11, 20, 30, 12, 20, 30]);
  assert.deepEqual(grid.dimensions, [3, 2, 2]);
});
test('aborted engineering loads fail before resolving any resources', { timeout: 10000 }, async () => {
  const signal = AbortSignal.abort();
  let reads = 0;
  for (const reader of [readCGNS, readXDMF, readEnSight])
    await assert.rejects(
      reader(
        {
          async read() {
            reads++;
            return new Uint8Array();
          },
        },
        { signal },
      ),
      /abort/i,
    );
  assert.equal(reads, 0);
});
test('CGNS volume sections exclude boundary elements from solution tuples', { timeout: 10000 }, async () => {
  const grid = await readCGNS(readFileSync(new URL('./fixtures/engineering/nasa-tri-hdf.cgns', import.meta.url)));
  assert.ok(grid.types.every((t) => t === 13));
  assert.equal(grid.types.length, 1632);
});
const goldCase = new TextEncoder().encode(
  'FORMAT\ntype: ensight gold\nGEOMETRY\nmodel: mesh.geo\nVARIABLE\nscalar per node: temperature field.scl\n',
);
test('Gold ASCII preserves empty description lines and padded numeric rows', { timeout: 10000 }, async () => {
  const data = new TextEncoder().encode(
    'Original geometry\n\nnode id assign\nelement id assign\npart\n1\ntetra\ncoordinates\n4\n0 1 0 0   \n0 0 1 0   \n0 0 0 1   \ntetra4\n1\n1 2 3 4   \n',
  );
  const values = new TextEncoder().encode('temperature\npart\n1\ncoordinates\n1 2 3 4   \n');
  const grid = await readEnSight(goldCase, { files: { 'mesh.geo': data, 'field.scl': values } });
  assert.deepEqual([...grid.types], [10]);
  assert.deepEqual([...grid.pointArrays.temperature], [1, 2, 3, 4]);
});
for (const little of [false, true])
  test(`Gold Fortran records include variable files without a binary signature (${little ? 'LE' : 'BE'})`, {
    timeout: 10000,
  }, async () => {
    const string = (s) => {
      const b = new Uint8Array(80);
      b.fill(32);
      b.set(new TextEncoder().encode(s));
      return b;
    };
    const numeric = (values, integer) => {
      const b = new Uint8Array(values.length * 4),
        v = new DataView(b.buffer);
      values.forEach((n, i) => (integer ? v.setInt32(i * 4, n, little) : v.setFloat32(i * 4, n, little)));
      return b;
    };
    const record = (parts) => {
      const b = new Uint8Array(parts.reduce((n, p) => n + p.length + 8, 0)),
        v = new DataView(b.buffer);
      let at = 0;
      for (const p of parts) {
        v.setUint32(at, p.length, little);
        b.set(p, at + 4);
        v.setUint32(at + p.length + 4, p.length, little);
        at += p.length + 8;
      }
      return b;
    };
    const geom = record([
      string('Fortran Binary'),
      string('Original geometry'),
      string(''),
      string('node id assign'),
      string('element id assign'),
      string('part'),
      numeric([1], true),
      string('tetra'),
      string('coordinates'),
      numeric([4], true),
      numeric([0, 1, 0, 0]),
      numeric([0, 0, 1, 0]),
      numeric([0, 0, 0, 1]),
      string('tetra4'),
      numeric([1], true),
      numeric([1, 2, 3, 4], true),
    ]);
    const field = record([
      string('temperature'),
      string('part'),
      numeric([1], true),
      string('coordinates'),
      numeric([1, 2, 3, 4]),
    ]);
    const grid = await readEnSight(goldCase, { littleEndian: little, files: { 'mesh.geo': geom, 'field.scl': field } });
    assert.deepEqual([...grid.types], [10]);
    assert.deepEqual([...grid.pointArrays.temperature], [1, 2, 3, 4]);
  });
