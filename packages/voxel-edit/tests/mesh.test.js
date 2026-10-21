import assert from 'node:assert/strict';
import test from 'node:test';
import { meshGrid } from '../dist/mesh.js';
import { SparseGrid } from '../dist/sparse.js';

const grid = (size, voxels) => ({ size, voxels: Uint8Array.from(voxels) });

test('one cell meshes to 6 outward quads with its palette index and the pivot subtracted', () => {
  const { mesh, stats } = meshGrid(grid([1, 1, 1], [255]), { pivot: [0.5, 1, 2] });
  assert.deepEqual(stats, { voxels: 1, quads: 6, triangles: 12, vertices: 24 });
  assert.deepEqual([...mesh.paletteIndexes], [255, 255, 255, 255, 255, 255]);
  assert.ok(mesh.positions instanceof Float32Array && mesh.indices instanceof Uint32Array);
  assert.deepEqual(mesh.min, [-0.5, -1, -2]);
  assert.deepEqual(mesh.max, [0.5, 0, -1]);
  assert.equal(mesh.ao.length, 0);
  for (let q = 0; q < 6; q++) {
    const at = q * 12,
      u = [0, 1, 2].map((a) => mesh.positions[at + 3 + a] - mesh.positions[at + a]),
      v = [0, 1, 2].map((a) => mesh.positions[at + 6 + a] - mesh.positions[at + a]),
      n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(
      n[0] * mesh.normals[at] + n[1] * mesh.normals[at + 1] + n[2] * mesh.normals[at + 2] > 0,
      'counterclockwise',
    );
  }
  assert.throws(() => meshGrid(grid([1, 1, 1], [1]), { maxQuads: 5 }), /maxQuads/);
});

test('greedy meshing merges same-index faces into rectangles and splits by index', () => {
  const bar = meshGrid(grid([3, 1, 1], [4, 4, 4])).stats;
  assert.equal(bar.quads, 6);
  const mixed = meshGrid(grid([3, 1, 1], [4, 5, 4])).stats;
  assert.equal(mixed.quads, 14, 'the middle index splits the four long sides into three quads each');
});

test('a sparse grid meshes chunk by chunk with no faces on the seams between filled cells', () => {
  for (let axis = 0; axis < 3; axis++) {
    const size = [40, 40, 40],
      a = [5, 5, 5],
      b = [5, 5, 5];
    a[axis] = 31;
    b[axis] = 32;
    const sparse = SparseGrid.empty(size).edit([
        [...a, 1],
        [...b, 255],
      ]).grid,
      { mesh, stats } = meshGrid(sparse, { ambientOcclusion: true });
    assert.equal(stats.voxels, 2);
    assert.equal(stats.quads, 10);
    for (let q = 0; q < stats.quads; q++)
      if (mesh.normals[q * 12 + axis]) assert.notEqual(mesh.positions[q * 12 + axis], 32, 'the seam has no face');
    assert.ok(mesh.paletteIndexes.includes(255));
    assert.equal(mesh.ao.length, stats.vertices);
  }
});

test('ambient occlusion darkens corners next to filled cells and stays 1 in the open', () => {
  const open = meshGrid(grid([1, 1, 1], [1]), { ambientOcclusion: true }).mesh;
  assert.ok(open.ao.every((v) => Math.abs(v - 1) < 1e-6));
  const step = meshGrid(grid([2, 2, 1], [1, 1, 1, 0]), { ambientOcclusion: true }).mesh;
  assert.ok(Math.min(...step.ao) < 1);
});

test('smoothing averages across greedy T junctions and keeps creases', () => {
  const source = grid([3, 2, 2], new Array(12).fill(1));
  source.voxels[1] = 0;
  const hard = meshGrid(source).mesh,
    smooth = meshGrid(source, { smoothNormals: true }).mesh,
    creased = meshGrid(source, { smoothNormals: true, creaseAngle: 35 }).mesh;
  assert.deepEqual(smooth.positions, hard.positions);
  assert.deepEqual(smooth.indices, hard.indices);
  assert.deepEqual(creased.normals, hard.normals);
  let junctions = 0;
  for (let i = 0; i < hard.positions.length; i += 3) {
    if (
      hard.positions[i] !== 1 ||
      hard.positions[i + 1] !== 2 ||
      hard.positions[i + 2] !== 0 ||
      hard.normals[i + 2] !== -1
    )
      continue;
    junctions++;
    assert.ok(Math.abs(smooth.normals[i]) < 1e-6);
    assert.ok(Math.abs(smooth.normals[i + 1] - Math.SQRT1_2) < 1e-6);
    assert.ok(Math.abs(smooth.normals[i + 2] + Math.SQRT1_2) < 1e-6);
  }
  assert.ok(junctions > 0);
});

test('meshGrid checks storage and budgets before scanning, and empty grids give an empty mesh', () => {
  assert.throws(() => meshGrid(grid([2, 1, 1], [1])), /hold 1 cells, not 2/);
  assert.throws(() => meshGrid(grid([2, 1, 1], [1, 1]), { maxCells: 1 }), /maxCells/);
  assert.throws(() => meshGrid(grid([1, 1, 1], [1]), { creaseAngle: NaN }), /creaseAngle/);
  assert.throws(() => meshGrid(grid([1, 1, 1], [1]), { smoothNormals: 'yes' }), TypeError);
  const none = meshGrid(grid([2, 2, 2], new Array(8).fill(0)));
  assert.equal(none.mesh.positions.length, 0);
  assert.deepEqual(
    [none.mesh.min, none.mesh.max],
    [
      [0, 0, 0],
      [0, 0, 0],
    ],
  );
});
