// voxelizeMesh: cube and sphere counts, shared edges on a ray, colours, palette limit, abort and limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { voxelizeMesh } from '../dist/voxelize.js';
import { gridToExportSource } from '../dist/export.js';

function box(min = [0, 0, 0], max = [1, 1, 1], otherDiagonal = false) {
  const positions = [];
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]);
  const quads = [
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ];
  return {
    positions: new Float32Array(positions),
    indices: quads.flatMap(([a, b, c, d]) => (otherDiagonal ? [a, b, d, b, c, d] : [a, b, c, a, c, d])),
  };
}

function sphere(radius, rings, segments) {
  const positions = [],
    indices = [];
  for (let r = 0; r <= rings; r++)
    for (let s = 0; s <= segments; s++) {
      const a = (Math.PI * r) / rings,
        b = (2 * Math.PI * (s % segments)) / segments;
      positions.push(radius * Math.sin(a) * Math.cos(b), radius * Math.cos(a), radius * Math.sin(a) * Math.sin(b));
    }
  for (let r = 0; r < rings; r++)
    for (let s = 0; s < segments; s++) {
      const a = r * (segments + 1) + s,
        b = a + segments + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  return { positions: new Float64Array(positions), indices };
}

const filled = (grid) => grid.voxels.reduce((n, v) => n + (v ? 1 : 0), 0);
const at = (grid, x, y, z) => grid.voxels[x + grid.size[0] * (z + grid.size[2] * y)];

test('a cube at N cells: N^3 solid and 6N^2 - 12N + 8 surface', async () => {
  const { positions, indices } = box();
  for (const n of [2, 3, 7, 16, 33]) {
    const solid = await voxelizeMesh(positions, indices, { size: n, fill: 'solid' });
    assert.deepEqual(solid.grid.size, [n, n, n]);
    assert.equal(filled(solid.grid), n ** 3, `solid ${n}`);
    assert.equal(solid.openRows, 0);
    const surface = await voxelizeMesh(positions, indices, { size: n });
    assert.equal(filled(surface.grid), 6 * n * n - 12 * n + 8, `surface ${n}`);
    assert.equal(surface.voxelSize, 1 / n);
  }
});

test('regression: a ray exactly on a face diagonal still counts one crossing per face', async () => {
  // Row centres with y == z sit on the shared diagonal of both x faces; a test per triangle loses or doubles them.
  const { positions, indices } = box();
  const { grid, openRows } = await voxelizeMesh(positions, indices, { size: 4, fill: 'solid' });
  assert.equal(openRows, 0);
  for (let d = 0; d < 4; d++) for (let x = 0; x < 4; x++) assert.equal(at(grid, x, d, d), 1);
  // The other diagonal of every quad too.
  const other = box(undefined, undefined, true);
  const again = await voxelizeMesh(other.positions, other.indices, { size: 4, fill: 'solid' });
  assert.equal(filled(again.grid), 64);
});

test('regression: single precision bounds do not add a cell', async () => {
  const { positions, indices } = box([0, 0, 0], [0.3, 0.3, 0.3]);
  const { grid } = await voxelizeMesh(positions, indices, { voxelSize: 0.1 });
  assert.deepEqual(grid.size, [3, 3, 3]);
});

test('a sphere solid holds its volume within 2 percent', async () => {
  const { positions, indices } = sphere(1, 96, 192);
  const { grid, voxelSize, origin, openRows } = await voxelizeMesh(positions, indices, { size: 48, fill: 'solid' });
  assert.equal(openRows, 0);
  const volume = filled(grid) * voxelSize ** 3,
    exact = (4 / 3) * Math.PI;
  assert.ok(Math.abs(volume - exact) / exact < 0.02, `volume ${volume} against ${exact}`);
  assert.ok(Math.abs(origin[0] + 1) < 1e-3);
  assert.equal(at(grid, 24, 24, 24), 1);
  assert.equal(at(grid, 0, 0, 0), 0);
});

test('a two colour texture lands on its own side, through the UVs', async () => {
  // A quad in the xy plane: u follows x. The texture is red on the left, blue on the right.
  const positions = [0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 4, 0],
    uvs = [0, 0, 1, 0, 1, 1, 0, 1],
    data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
  const { grid, palette, colorsReduced } = await voxelizeMesh(positions, [0, 1, 2, 0, 2, 3], {
    voxelSize: 1,
    colors: { uvs, texture: { width: 2, height: 1, data } },
  });
  assert.deepEqual(grid.size, [4, 4, 1]);
  assert.equal(colorsReduced, false);
  const color = (x, y) => [...palette.subarray(4 * at(grid, x, y, 0), 4 * at(grid, x, y, 0) + 4)];
  for (let y = 0; y < 4; y++) {
    assert.deepEqual(color(0, y), [255, 0, 0, 255]);
    assert.deepEqual(color(1, y), [255, 0, 0, 255]);
    assert.deepEqual(color(2, y), [0, 0, 255, 255]);
    assert.deepEqual(color(3, y), [0, 0, 255, 255]);
  }
});

test('vertex colours: faces keep theirs, solid inner cells take the nearer crossing', async () => {
  // Two separate halves of a box would be two meshes; here x = 0 corners are green and x = 1 corners red.
  const { positions, indices } = box();
  const vertex = new Uint8Array(24);
  for (let i = 0; i < 8; i++) vertex.set(i & 1 ? [255, 0, 0] : [0, 255, 0], 3 * i);
  const { grid, palette } = await voxelizeMesh(positions, indices, {
    size: 8,
    fill: 'solid',
    colors: { vertex },
  });
  assert.equal(filled(grid), 512);
  const rgb = (x, y, z) => [...palette.subarray(4 * at(grid, x, y, z), 4 * at(grid, x, y, z) + 3)];
  const low = rgb(0, 4, 4),
    high = rgb(7, 4, 4),
    inner = rgb(1, 4, 4);
  assert.ok(low[1] > 200 && low[0] < 40, `low ${low}`);
  assert.ok(high[0] > 200 && high[1] < 40, `high ${high}`);
  assert.deepEqual(inner, low);
  // Float colours run 0 to 1.
  const floats = new Float32Array(32).fill(0.5);
  const half = await voxelizeMesh(positions, indices, { size: 2, colors: { vertex: floats } });
  assert.deepEqual([...half.palette.subarray(4, 8)], [128, 128, 128, 255]);
});

test('median cut keeps exact colours under the limit and reduces over it, the same every run', async () => {
  const count = 40,
    positions = [],
    indices = [],
    vertex = [];
  for (let i = 0; i < count; i++) {
    positions.push(i, 0, 0, i + 0.5, 0, 0, i, 0.5, 0);
    indices.push(3 * i, 3 * i + 1, 3 * i + 2);
    for (let c = 0; c < 3; c++) vertex.push(i * 6, 255 - i * 6, (i * 37) % 256);
  }
  const options = { voxelSize: 1, colors: { vertex: new Uint8Array(vertex) } };
  const exact = await voxelizeMesh(positions, indices, options);
  assert.equal(exact.colorsReduced, false);
  const seen = new Set(exact.grid.voxels.filter(Boolean));
  assert.equal(seen.size, count);
  assert.deepEqual([...exact.palette.subarray(0, 4)], [0, 0, 0, 0]);
  const small = await voxelizeMesh(positions, indices, { ...options, paletteSize: 5 });
  assert.equal(small.colorsReduced, true);
  assert.equal(new Set(small.grid.voxels.filter(Boolean)).size, 5);
  const again = await voxelizeMesh(positions, indices, { ...options, paletteSize: 5 });
  assert.deepEqual(again.palette, small.palette);
  assert.deepEqual(again.grid.voxels, small.grid.voxels);
});

test('an open mesh reports its rows and a flat one still gets a layer', async () => {
  const { positions, indices } = box();
  const { openRows } = await voxelizeMesh(positions, indices.slice(6), { size: 4, fill: 'solid' });
  assert.equal(openRows, 16);
  const flat = await voxelizeMesh([0, 0, 0, 1, 0, 0, 0, 1, 0], null, { size: 4 });
  assert.deepEqual(flat.grid.size, [4, 4, 1]);
  assert.ok(filled(flat.grid) >= 10);
});

test('limits and bad input are rejected before any allocation, and the signal stops the work', async () => {
  const { positions, indices } = box();
  const reject = (args, type, pattern) =>
    assert.rejects(voxelizeMesh(...args), (e) => e instanceof type && pattern.test(e.message));
  await reject([positions, indices, { size: 64, maxCells: 1000 }], RangeError, /maxCells/);
  await reject([positions, indices, {}], TypeError, /voxelSize or size/);
  await reject([positions, indices, { size: 2, voxelSize: 1 }], TypeError, /not both/);
  await reject([positions, indices, { size: 0 }], RangeError, /positive integer/);
  await reject([positions, indices, { voxelSize: -1 }], RangeError, /positive/);
  await reject([positions, [0, 1], { size: 2 }], RangeError, /whole triangles/);
  await reject([positions, [], { size: 2 }], RangeError, /whole triangles/);
  await reject([positions, [0, 1, 99], { size: 2 }], RangeError, /outside/);
  await reject([[0, 0, NaN, 1, 0, 0, 0, 1, 0], null, { size: 2 }], RangeError, /finite/);
  await reject([positions, indices, { size: 2, paletteSize: 256 }], RangeError, /paletteSize/);
  await reject([positions, indices, { size: 2, fill: 'hollow' }], TypeError, /fill/);
  await reject([positions, indices, { size: 2, colors: { vertex: [1] } }], RangeError, /vertex/);
  await reject([positions, indices, { size: 2, colors: { uvs: [], texture: {} } }], RangeError, /uvs/);
  await reject(
    [
      positions,
      indices,
      { size: 2, colors: { uvs: new Array(16).fill(0), texture: { width: 2, height: 2, data: new Uint8Array(4) } } },
    ],
    RangeError,
    /RGBA8/,
  );
  const before = new AbortController();
  before.abort(new Error('stop now'));
  await assert.rejects(voxelizeMesh(positions, indices, { size: 2, signal: before.signal }), /stop now/);
  // A running job stops at its next pause: the abort comes from a timer the job yields to.
  const during = new AbortController();
  setTimeout(() => during.abort(new Error('stopped late')), 1);
  const big = sphere(1, 256, 512);
  await assert.rejects(voxelizeMesh(big.positions, big.indices, { size: 256, signal: during.signal }), /stopped late/);
});

test('the result feeds the rest of the package', async () => {
  const { positions, indices } = box();
  const { grid } = await voxelizeMesh(positions, indices, { size: 3 });
  const source = gridToExportSource(grid, [{ index: 1, color: [1, 1, 1] }]);
  assert.equal(source.nodes[0].primitives.length, 1);
});
