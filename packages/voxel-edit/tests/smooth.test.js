// smoothGrid: closed surfaces, cube bounds and counts, every point in its net cell, colours, normals, blur and limits.
import assert from 'node:assert/strict';
import test from 'node:test';
import { smoothGrid } from '../dist/smooth.js';
import { gridToExportSource } from '../dist/export.js';
import { partitionMesh } from '../dist/mesh.js';

const filledGrid = (size, value = 1) => ({ size, voxels: new Uint8Array(size[0] * size[1] * size[2]).fill(value) });
const key = (m, v) => `${m.positions[3 * v]},${m.positions[3 * v + 1]},${m.positions[3 * v + 2]}`;

/** Welded V - E + F over the triangles, plus whether every edge has exactly one partner running the other way. */
function topology(mesh) {
  const ids = new Map();
  const id = (v) => {
    const k = key(mesh, v);
    if (!ids.has(k)) ids.set(k, ids.size);
    return ids.get(k);
  };
  const edges = new Map();
  for (let t = 0; t < mesh.indices.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = id(mesh.indices[t + e]),
        b = id(mesh.indices[t + ((e + 1) % 3)]);
      edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
    }
  let closed = true;
  const undirected = new Set();
  for (const [edge, n] of edges) {
    const [a, b] = edge.split('>');
    if (n !== 1 || edges.get(`${b}>${a}`) !== 1) closed = false;
    undirected.add(+a < +b ? edge : `${b}>${a}`);
  }
  return { euler: ids.size - undirected.size + mesh.indices.length / 3, closed, points: ids.size };
}

function signedVolume(mesh) {
  let sum = 0;
  const p = mesh.positions;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((n) => 3 * mesh.indices[t + n]);
    sum +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return sum / 6;
}

test('a single voxel is a closed surface: V - E + F = 2, wound outward', () => {
  for (const iterations of [0, 3]) {
    const { mesh, stats } = smoothGrid(filledGrid([1, 1, 1], 7), { iterations });
    assert.equal(stats.quads, 6);
    assert.equal(stats.surfaceVertices, 8);
    assert.equal(stats.vertices, 24);
    assert.equal(stats.triangles, 12);
    const shape = topology(mesh);
    assert.equal(shape.euler, 2);
    assert.equal(shape.closed, true);
    assert.ok(signedVolume(mesh) > 0, 'outward');
    assert.deepEqual([...new Set(mesh.paletteIndexes)], [7]);
  }
});

test('a 10^3 cube: flat faces reach its bounds, with the expected counts', () => {
  const { mesh, stats } = smoothGrid(filledGrid([10, 10, 10]), { iterations: 0 });
  assert.deepEqual(mesh.min, [0, 0, 0]);
  assert.deepEqual(mesh.max, [10, 10, 10]);
  assert.equal(stats.quads, 600);
  assert.equal(stats.surfaceVertices, 11 ** 3 - 9 ** 3);
  assert.equal(stats.voxels, 1000);
  const shape = topology(mesh);
  assert.equal(shape.euler, 2);
  assert.equal(shape.closed, true);
  assert.equal(shape.points, 602);
  // The eight corners are pulled in by a third of the bevel; the volume stays near the cube's.
  const volume = signedVolume(mesh);
  assert.ok(volume > 950 && volume < 1000, `volume ${volume}`);
});

test('every relaxed point stays in its net cell', () => {
  const grid = filledGrid([4, 3, 5]);
  grid.voxels[0] = 0;
  const start = smoothGrid(grid, { iterations: 0 }).mesh.positions,
    end = smoothGrid(grid, { iterations: 64 }).mesh.positions;
  assert.equal(start.length, end.length);
  let moved = 0;
  for (let i = 0; i < start.length; i++) {
    const cell = Math.round(start[i]);
    assert.ok(Math.abs(start[i] - cell) < 0.5, 'a start is strictly inside');
    assert.ok(end[i] >= cell - 0.5 && end[i] <= cell + 0.5, `coordinate ${i}: ${start[i]} went to ${end[i]}`);
    if (Math.abs(end[i] - start[i]) > 1e-3) moved++;
  }
  assert.ok(moved > 0, 'relaxation moved points');
});

test('quads take the colour of their voxel', () => {
  // Two voxels side by side along x, index 3 and index 9: each owns the quads on its faces, none between them.
  const grid = { size: [2, 1, 1], voxels: new Uint8Array([3, 9]) };
  const { mesh, stats } = smoothGrid(grid, { iterations: 0 });
  assert.equal(stats.quads, 10);
  for (let q = 0; q < stats.quads; q++) {
    let x = 0;
    for (let c = 0; c < 4; c++) x += mesh.positions[3 * (4 * q + c)] / 4;
    assert.equal(mesh.paletteIndexes[q], x < 1 ? 3 : 9, `quad ${q} at x ${x}`);
  }
  const parts = partitionMesh(mesh);
  assert.deepEqual(
    parts.map((p) => p.paletteIndex).sort((a, b) => a - b),
    [3, 9],
  );
  // y and z orientation: a voxel at (0, 1, 0) in a 1 x 2 x 2 grid is the top half at the z = 0 side.
  const stacked = { size: [1, 2, 2], voxels: new Uint8Array(4) };
  stacked.voxels[0 + 1 * (0 + 2 * 1)] = 5;
  const up = smoothGrid(stacked, { iterations: 0 }).mesh;
  assert.ok(up.min[1] >= 1 && up.max[1] <= 2, `y ${up.min[1]}..${up.max[1]}`);
  assert.ok(up.min[2] >= 0 && up.max[2] <= 1, `z ${up.min[2]}..${up.max[2]}`);
});

test('normals follow the density gradient: unit, outward, axis-true on a flat face', () => {
  const { mesh } = smoothGrid(filledGrid([6, 6, 6]), { iterations: 0 });
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const n = [0, 1, 2].map((a) => mesh.normals[3 * v + a]),
      out = [0, 1, 2].map((a) => mesh.positions[3 * v + a] - 3);
    assert.ok(Math.abs(Math.hypot(...n) - 1) < 1e-5);
    assert.ok(n[0] * out[0] + n[1] * out[1] + n[2] * out[2] > 0, `vertex ${v}`);
  }
  let flat = 0;
  for (let v = 0; v < mesh.positions.length / 3; v++)
    if (
      mesh.positions[3 * v] === 6 &&
      mesh.positions[3 * v + 1] > 1 &&
      mesh.positions[3 * v + 1] < 5 &&
      mesh.positions[3 * v + 2] > 1 &&
      mesh.positions[3 * v + 2] < 5
    ) {
      flat++;
      assert.deepEqual([...mesh.normals.subarray(3 * v, 3 * v + 3)], [1, 0, 0]);
    }
  assert.ok(flat > 0);
});

test('regression: opposite corners cancel in the gradient and still get a unit normal', () => {
  // Two voxels touching only at a corner: their shared net cell has a zero density gradient.
  const grid = { size: [2, 2, 2], voxels: new Uint8Array(8) };
  grid.voxels[0] = 1;
  grid.voxels[7] = 1;
  const { mesh, stats } = smoothGrid(grid, { iterations: 0 });
  assert.equal(stats.quads, 12);
  for (let v = 0; v < mesh.normals.length / 3; v++) {
    const length = Math.hypot(mesh.normals[3 * v], mesh.normals[3 * v + 1], mesh.normals[3 * v + 2]);
    assert.ok(Math.abs(length - 1) < 1e-5, `normal ${v} has length ${length}`);
  }
});

test('blur rounds the shape, keeps it closed and colours from the nearest filled voxel', () => {
  const grid = filledGrid([8, 8, 8], 4);
  const plain = smoothGrid(grid, { iterations: 0 }),
    round = smoothGrid(grid, { iterations: 0, blur: 2 });
  assert.equal(topology(round.mesh).euler, 2);
  assert.ok(signedVolume(round.mesh) < signedVolume(plain.mesh), 'corners are gone');
  for (const low of round.mesh.min) assert.ok(Math.abs(low) < 1e-5, 'flat face centres stay');
  assert.deepEqual([...new Set(round.mesh.paletteIndexes)], [4]);
  // A notch of air in the cube's middle fills in under blur: its surface colour still comes from filled voxels.
  const notched = filledGrid([9, 9, 9], 6);
  notched.voxels[4 + 9 * (4 + 9 * 4)] = 0;
  const closed = smoothGrid(notched, { iterations: 0, blur: 1 });
  assert.deepEqual([...new Set(closed.mesh.paletteIndexes)], [6]);
  // A voxel thinner than the blur width fades out.
  assert.equal(smoothGrid(filledGrid([1, 1, 1]), { blur: 1 }).stats.quads, 0);
});

test('regression: an empty grid and empty mesh give zero bounds, a pivot moves the mesh', () => {
  const empty = smoothGrid({ size: [2, 2, 2], voxels: new Uint8Array(8) });
  assert.equal(empty.stats.quads, 0);
  assert.deepEqual(empty.mesh.min, [0, 0, 0]);
  assert.deepEqual(empty.mesh.max, [0, 0, 0]);
  const moved = smoothGrid(filledGrid([4, 4, 4]), { iterations: 0, pivot: [2, 0, 2] }).mesh;
  assert.deepEqual(moved.min, [-2, 0, -2]);
  assert.deepEqual(moved.max, [2, 4, 2]);
});

test('limits and bad options are rejected, and the source is untouched', () => {
  const grid = filledGrid([4, 4, 4]);
  const before = grid.voxels.slice();
  smoothGrid(grid, { blur: 1, iterations: 2 });
  assert.deepEqual(grid.voxels, before);
  assert.throws(() => smoothGrid(grid, { maxQuads: 5 }), /maxQuads/);
  assert.throws(() => smoothGrid(grid, { maxQuads: -1 }), RangeError);
  assert.throws(() => smoothGrid(grid, { maxCells: 10 }), /maxCells/);
  assert.throws(() => smoothGrid(filledGrid([4, 4, 4]), { maxCells: 64 }), /maxCells/);
  assert.throws(() => smoothGrid(grid, { iterations: 65 }), /iterations/);
  assert.throws(() => smoothGrid(grid, { blur: 0.5 }), /blur/);
  assert.throws(() => smoothGrid(grid, { pivot: [0, 0] }), /pivot/);
  assert.throws(() => smoothGrid({ size: [1, 1, 1], voxels: [1] }), /Uint8Array/);
  assert.throws(() => smoothGrid(grid, null), TypeError);
});

test('it feeds gridToExportSource, one primitive per palette index', () => {
  const grid = { size: [2, 1, 1], voxels: new Uint8Array([1, 2]) };
  const { mesh } = smoothGrid(grid);
  const source = gridToExportSource(
    grid,
    [
      { index: 1, color: [1, 0, 0] },
      { index: 2, color: [0, 1, 0] },
    ],
    { mesh },
  );
  assert.equal(source.mesh, mesh);
  assert.deepEqual(source.nodes[0].primitives.map((p) => p.material.name).sort(), ['palette-1', 'palette-2']);
  assert.equal(source.nodes[0].primitives[0].geometry.colors, undefined);
});
