// Batch 132 audit regressions: each case failed on the code before its fix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { colorScale, diverging } from '@margoengine/sciviz/colormaps';
import { marchingCubes } from '../dist/fallback.js';
import { parseFITS } from '../dist/fits.js';
import { readXDMF } from '../dist/xdmf.js';
import { readEnSight } from '../dist/ensight.js';
import { datatype, numeric } from '../src/hdf5-binary.ts';

const enc = (s) => new TextEncoder().encode(s);
const fits = (...hdus) =>
  enc(
    hdus
      .map((cards) => {
        let h = [...cards, 'END'].map((c) => c.padEnd(80, ' ')).join('');
        while (h.length % 2880) h += ' ';
        return h;
      })
      .join(''),
  );
const primary = ['SIMPLE  =                    T', 'BITPIX  =                    8', 'NAXIS   =                    0'];

test('diverging compares and blends hues the short way round (Moreland 2009)', () => {
  // Lab hues of these endpoints are 173 and -144 degrees: 43 degrees apart, so no white midpoint.
  const low = [0, 0.55, 0.45],
    high = [0, 0.55, 0.62],
    mid = diverging(0.5, low, high);
  assert.ok(Math.abs(mid[0] - mid[2]) > 0.1 || Math.abs(mid[1] - mid[2]) > 0.1, `midpoint ${mid} is grey`);
  // The blend stays between the endpoints' hues: green-blue, never through red.
  for (let t = 0; t <= 1; t += 0.125) {
    const [r, g, b] = diverging(t, low, high);
    assert.ok(r < Math.min(g, b) + 0.05, `t ${t}: ${[r, g, b]} swings through red`);
  }
});

test('isosurface normals of a planar field are exact at the grid faces', async () => {
  const dims = [5, 5, 3],
    data = new Float32Array(75);
  for (let z = 0; z < 3; z++) for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) data[x + 5 * (y + 5 * z)] = x + y;
  const { vertices, triangles } = await marchingCubes(data, 3.5, { dims });
  assert.ok(triangles > 0);
  for (let i = 0; i < triangles * 3; i++) {
    const [nx, ny, nz] = vertices.subarray(i * 8 + 4, i * 8 + 7);
    assert.ok(Math.abs(nx - ny) < 1e-6 && Math.abs(nz) < 1e-6, `vertex ${i} normal ${[nx, ny, nz]}`);
  }
});

test('FITS commentary cards and complex values parse; a blank value reads as absent', () => {
  const header = parseFITS(fits([...primary, 'HISTORY = reprocessed by pipeline v2', 'CPLX    =           (1.0, 2.0)']))
    .hdus[0].header;
  assert.equal(header.CPLX, '(1.0, 2.0)');
  assert.equal('HISTORY' in header, false);
  const image = parseFITS(
    new Uint8Array([
      ...fits([
        'SIMPLE  =                    T',
        'BITPIX  =                   16',
        'NAXIS   =                    1',
        'NAXIS1  =                    4',
        'BSCALE  =                      / undefined value',
      ]),
      ...new Uint8Array(2880).fill(0).map((_, i) => (i % 2 && i < 8 ? (i + 1) * 5 : 0)),
    ]),
  ).hdus[0];
  assert.equal('BSCALE' in image.header, false);
  assert.deepEqual([...image.data], [10, 20, 30, 40]);
});

test('a FITS binary table of zero-width rows is bounded by maxBytes', { timeout: 10000 }, () => {
  const table = fits(
    [...primary, 'EXTEND  =                    T'],
    [
      "XTENSION= 'BINTABLE'",
      'BITPIX  =                    8',
      'NAXIS   =                    2',
      'NAXIS1  =                    0',
      'NAXIS2  =            200000000',
      'PCOUNT  =                    0',
      'GCOUNT  =                    1',
      'TFIELDS =                    1',
      "TFORM1  = '0A      '",
    ],
  );
  assert.throws(() => parseFITS(table), /rows exceed maxBytes/);
});

test('Xdmf polyhedra and origin-spacing meshes are bounded before they loop or allocate', { timeout: 10000 }, async () => {
  const grid = (topology, geometry) =>
    enc(`<?xml version="1.0"?><Xdmf Version="3.0"><Domain><Grid Name="g">${topology}${geometry}</Grid></Domain></Xdmf>`);
  const xyz = '<Geometry GeometryType="XYZ"><DataItem Dimensions="1 3" Format="XML">0 0 0</DataItem></Geometry>';
  await assert.rejects(
    readXDMF(
      grid(
        '<Topology TopologyType="Mixed" NumberOfElements="1"><DataItem Dimensions="2" Format="XML">16 400000000</DataItem></Topology>',
        xyz,
      ),
    ),
    /polyhedron face count/,
  );
  await assert.rejects(
    readXDMF(
      grid(
        '<Topology TopologyType="3DCoRectMesh" Dimensions="4000000000 4 4"/>',
        '<Geometry GeometryType="ORIGIN_DXDYDZ"><DataItem Dimensions="3" Format="XML">0 0 0</DataItem><DataItem Dimensions="3" Format="XML">1 1 1</DataItem></Geometry>',
      ),
    ),
    /CoRectMesh dimensions exceed maxBytes/,
  );
});

test('an EnSight uniform block is bounded by maxBytes before its points are generated', { timeout: 10000 }, async () => {
  const geo = `d1${' x'.repeat(2000)}\nd2\nnode id off\nelement id off\npart\n1\nbox\nblock uniform\n600 600 600\n0\n0\n0\n1\n1\n1\n`;
  await assert.rejects(
    readEnSight(enc('FORMAT\ntype: ensight gold\nGEOMETRY\nmodel: g.geo\n'), { files: { 'g.geo': enc(geo) } }),
    /uniform block exceeds maxBytes/,
  );
});

test('an HDF5 enumeration takes byte order and sign from its base type', () => {
  // Datatype message: version 1 class 8 (enumeration) with 3 members (the class bits) and size 4, then its base type:
  // version 1 class 0, signed little-endian (flags 0x08), size 4, offset 0, precision 32. Member names follow.
  const enumeration = Uint8Array.of(0x18, 3, 0, 0, 4, 0, 0, 0, 0x10, 0x08, 0, 0, 4, 0, 0, 0, 0, 0, 32, 0);
  const type = datatype(enumeration);
  assert.deepEqual([type.kind, type.little, type.signed, type.bits], [8, true, true, 32]);
  assert.deepEqual([...numeric(Uint8Array.of(1, 0, 0, 0, 255, 255, 255, 255), type)], [1, -1]);
});
