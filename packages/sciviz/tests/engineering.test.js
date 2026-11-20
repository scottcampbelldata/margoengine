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
const foamCase = (format, p) => ({
  resolve: async (name) => (name === '0/p' ? p : bytes(`foam-owner-${format}/${name}`)),
});
test('OpenFOAM binary internal values that hold quote or comment bytes keep their boundary values', { timeout: 10000 }, async () => {
  const p = new Uint8Array(bytes('foam-owner-binary/0/p')),
    one = new Uint8Array(new Float64Array([1]).buffer),
    odd = new Float64Array(new Uint8Array([0x22, 0x2f, 0x2a, 0, 0, 0, 0xf0, 0x3f]).buffer)[0];
  let at = -1;
  for (let i = 0; i + 8 <= p.length && at < 0; i++) if (one.every((v, j) => p[i + j] === v)) at = i;
  assert.ok(at > 0);
  p.set(new Uint8Array(new Float64Array([odd]).buffer), at);
  const grid = await readOpenFOAM(new Uint8Array(), { ...foamCase('binary', p), fields: ['p'] }),
    internal = grid.blocks[0];
  assert.ok([...internal.cellArrays.p].includes(odd));
  assert.ok([...grid.blocks[1].cellArrays.p].every((v) => v === 9));
});
test('OpenFOAM boundaryField honours directives, macros, patch groups and quoted patterns by precedence', { timeout: 10000 }, async () => {
  const text = bytes('foam-owner-ascii/0/p').toString('latin1'),
    withBoundary = (boundary, extra = '') =>
      new TextEncoder().encode(text.replace(/boundaryField[\s\S]*$/, `${extra}\nboundaryField\n{\n${boundary}\n}\n`)),
    walls = async (boundary, extra) => {
      const grid = await readOpenFOAM(new Uint8Array(), { ...foamCase('ascii', withBoundary(boundary, extra)), fields: ['p'] });
      return { internal: grid.blocks[0], walls: [...grid.blocks[1].cellArrays.p] };
    };
  const include = '#includeEtc "caseDicts/setConstraintTypes"\n';
  // A patch group entry beats a pattern; the exact patch name beats both, with a `$` macro value.
  assert.ok((await walls(`${include}".*" { type fixedValue; value uniform 5; }\nwall { type fixedValue; value uniform 7; }`)).walls.every((v) => v === 7));
  assert.ok(
    (await walls(`${include}walls { type fixedValue; value $wallValue; }\n".*" { type fixedValue; value uniform 5; }\nwall { type fixedValue; value uniform 7; }`, 'wallValue uniform 9;')).walls.every((v) => v === 9),
  );
  // The last matching pattern wins.
  assert.ok((await walls(`"w.*" { type fixedValue; value uniform 3; }\n"wal(l|ls)" { type fixedValue; value uniform 4; }`)).walls.every((v) => v === 4));
  // A matched entry with no value extrapolates the owner cell.
  const owner = await walls(`"wal.*" { type zeroGradient; }`);
  assert.ok(owner.walls.length > 0 && owner.walls.every((v) => Number.isInteger(v) && v >= 1 && v <= 8));
  await assert.rejects(walls(`"(" { type fixedValue; value uniform 1; }`), /invalid OpenFOAM patch pattern/);
  await assert.rejects(walls(`walls { type fixedValue; value $absent; }`), /macro \$absent/);
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

// A classic (CDF-1) NetCDF file with fixed dimensions: vars are { name, dims, type: 'double' | 'int' | 'char', data,
// attributes: { name: string } }. Enough for small synthetic Exodus databases.
function classicNetCDF(dims, vars) {
  const header = [],
    u32 = (n) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      header.push(b);
    },
    text = (s) => {
      const b = Buffer.from(s);
      u32(b.length);
      header.push(b, Buffer.alloc((4 - (b.length % 4)) % 4));
    };
  const names = Object.keys(dims),
    sizeOf = { char: 1, int: 4, double: 8 },
    typeOf = { char: 2, int: 4, double: 6 },
    bodies = vars.map((v) => {
      const n = v.dims.reduce((p, d) => p * dims[d], 1),
        b = Buffer.alloc(Math.ceil((n * sizeOf[v.type]) / 4) * 4);
      for (let i = 0; i < n; i++)
        if (v.type === 'double') b.writeDoubleBE(v.data[i], 8 * i);
        else if (v.type === 'int') b.writeInt32BE(v.data[i], 4 * i);
        else b[i] = v.data.charCodeAt(i) || 0;
      return b;
    });
  const write = (begins) => {
    header.length = 0;
    header.push(Buffer.from([67, 68, 70, 1]));
    u32(0);
    u32(10);
    u32(names.length);
    for (const d of names) {
      text(d);
      u32(dims[d]);
    }
    u32(0);
    u32(0);
    u32(11);
    u32(vars.length);
    vars.forEach((v, k) => {
      text(v.name);
      u32(v.dims.length);
      for (const d of v.dims) u32(names.indexOf(d));
      const attributes = Object.entries(v.attributes ?? {});
      if (attributes.length) {
        u32(12);
        u32(attributes.length);
        for (const [key, value] of attributes) {
          text(key);
          u32(2);
          text(value);
        }
      } else {
        u32(0);
        u32(0);
      }
      u32(typeOf[v.type]);
      u32(bodies[k].length);
      u32(begins[k]);
    });
    return Buffer.concat(header).length;
  };
  let at = write(vars.map(() => 0));
  const begins = bodies.map((b) => ((at += b.length), at - b.length));
  write(begins);
  return new Uint8Array(Buffer.concat([...header, ...bodies]));
}
// One Exodus element in Exodus II numbering (SAND92-2137 Figure 4; SEACAS hex27 figure) with a nodal field.
function exodusElement(type, nodes, field) {
  const n = nodes.length;
  return classicNetCDF(
    { num_nodes: n, num_el_in_blk1: 1, num_nod_per_el1: n, time_step: 1, num_nod_var: 1, len_name: 8 },
    [
      ...['x', 'y', 'z'].map((axis, a) => ({
        name: 'coord' + axis,
        dims: ['num_nodes'],
        type: 'double',
        data: nodes.map((p) => p[a]),
      })),
      {
        name: 'connect1',
        dims: ['num_el_in_blk1', 'num_nod_per_el1'],
        type: 'int',
        data: nodes.map((_, i) => i + 1),
        attributes: { elem_type: type },
      },
      { name: 'name_nod_var', dims: ['num_nod_var', 'len_name'], type: 'char', data: 'f' },
      { name: 'vals_nod_var1', dims: ['time_step', 'num_nodes'], type: 'double', data: nodes.map(field) },
    ],
  );
}
const corners = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const mid = (a, b) => a.map((v, k) => (v + b[k]) / 2);
const exodusHex = [
  ...corners,
  ...[[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 5], [2, 6], [3, 7], [4, 5], [5, 6], [6, 7], [7, 4]].map(([a, b]) =>
    mid(corners[a], corners[b]),
  ),
  // HEX27: centroid, then bottom, top, x-min, x-max, y-min, y-max face centres.
  [0.5, 0.5, 0.5], [0.5, 0.5, 0], [0.5, 0.5, 1], [0, 0.5, 0.5], [1, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5],
];
const prism = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1]];
const exodusWedge = [
  ...prism,
  ...[[0, 1], [1, 2], [2, 0], [0, 3], [1, 4], [2, 5], [3, 4], [4, 5], [5, 3]].map(([a, b]) => mid(prism[a], prism[b])),
];
test('Exodus HEX20, HEX27 and WEDGE15 read in Exodus II node order, not VTK order', async () => {
  const f = ([x, y, z]) => x * y + z * z - 2 * x * z;
  for (const [type, nodes] of [
    ['HEX20', exodusHex.slice(0, 20)],
    ['HEX27', exodusHex],
    ['WEDGE15', exodusWedge],
  ]) {
    const grid = await readExodus(exodusElement(type, nodes, f), { subdivisions: 4 });
    assert.ok(grid.points.length > nodes.length * 3, type);
    for (let i = 0; i < grid.points.length / 3; i++) {
      const p = [grid.points[3 * i], grid.points[3 * i + 1], grid.points[3 * i + 2]];
      assert.ok(Math.abs(grid.pointData[i] - f(p)) <= 1e-9, `${type} point ${p}: ${grid.pointData[i]} vs ${f(p)}`);
    }
    assert.ok(Math.abs((await integrateGrid(grid)).volume.measure - (type === 'WEDGE15' ? 0.5 : 1)) <= 1e-9, type);
  }
  const wedge18 = [...exodusWedge, [0.5, 0, 0.5], [0.5, 0.5, 0.5], [0, 0.5, 0.5]];
  await assert.rejects(readExodus(exodusElement('WEDGE18', wedge18, f)), /WEDGE18/);
});
// EnSight 7 User Manual Figure 11-1 and Ansys EnSight User Manual 2025 R2 Figure 10.1 both draw the three node bar
// with node 2 in the middle; VTK's quadratic edge puts its mid node last.
test('an EnSight bar3 takes its second node as the mid node', async () => {
  const enc = (s) => new TextEncoder().encode(s);
  // Nodes in EnSight bar3 order: end at x = 0, mid at x = 1, end at x = 2 (the curve bends through y = 1 at the mid).
  const x = [0, 1, 2],
    y = [0, 1, 0];
  const geo = ['t1', 't2', 'node id off', 'element id off', 'part', '1', 'bar', 'coordinates', '3', ...x, ...y, 0, 0, 0,
    'bar3', '1', '1 2 3', ''].join('\n');
  const vals = ['f', 'part', '1', 'coordinates', ...x, ''].join('\n');
  const grid = await readEnSight(
    enc('FORMAT\ntype: ensight gold\nGEOMETRY\nmodel: g.geo\nVARIABLE\nscalar per node: f f.scl\n'),
    { files: { 'g.geo': enc(geo), 'f.scl': enc(vals) }, subdivisions: 4 },
  );
  const p = grid.points;
  // Every tessellated point lies on the parabola y = 1 - (x - 1)^2 through the three nodes, and f = x along it.
  for (let i = 0; i < p.length / 3; i++) {
    assert.ok(Math.abs(p[3 * i + 1] - (1 - (p[3 * i] - 1) ** 2)) <= 1e-9, `point ${p[3 * i]}, ${p[3 * i + 1]}`);
    assert.ok(Math.abs(grid.pointData[i] - p[3 * i]) <= 1e-9, `f at x = ${p[3 * i]}: ${grid.pointData[i]}`);
  }
  const xs = [...p].filter((_, i) => i % 3 === 0);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 2]);
});
test('an Exodus block keeps its own ID when an earlier block has no connectivity', async () => {
  // Block 1 is a null block (eb_status 0, no connect1); block 2 holds one triangle and ID 20.
  const file = classicNetCDF(
    { num_nodes: 3, num_el_blk: 2, num_el_in_blk2: 1, num_nod_per_el2: 3, num_elem_var: 1, len_name: 8, time_step: 1 },
    [
      { name: 'coordx', dims: ['num_nodes'], type: 'double', data: [0, 1, 0] },
      { name: 'coordy', dims: ['num_nodes'], type: 'double', data: [0, 0, 1] },
      { name: 'eb_status', dims: ['num_el_blk'], type: 'int', data: [0, 1] },
      { name: 'eb_prop1', dims: ['num_el_blk'], type: 'int', data: [10, 20] },
      { name: 'connect2', dims: ['num_el_in_blk2', 'num_nod_per_el2'], type: 'int', data: [1, 2, 3], attributes: { elem_type: 'TRI3' } },
      { name: 'name_elem_var', dims: ['num_elem_var', 'len_name'], type: 'char', data: 'p' },
      { name: 'vals_elem_var1eb2', dims: ['time_step', 'num_el_in_blk2'], type: 'double', data: [7] },
    ],
  );
  const grid = await readExodus(file);
  assert.deepEqual(
    grid.elementBlocks.map((b) => [b.id, b.start, b.count, b.arrays.p?.[0]]),
    [[20, 0, 1, 7]],
  );
});
