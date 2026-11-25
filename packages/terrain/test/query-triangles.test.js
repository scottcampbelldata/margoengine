import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainQuery } from '../dist/query.js';

// A twisted grid (hills plus a ridge), so normals and heights differ from cell to cell.
function grid(columns, rows) {
  const heights = new Float32Array(columns * rows);
  for (let z = 0; z < rows; z++)
    for (let x = 0; x < columns; x++) heights[z * columns + x] = 0.3 * Math.sin(x * 0.4) * Math.cos(z * 0.3) + 0.01 * x;
  return heights;
}
const options = { origin: [-10, 4], size: [20, 15], heightScale: 12, heightOffset: -2 };

test('step 1: one vertex per sample on the queried surface, the query normal, two triangles per cell, CCW from above', () => {
  const q = new TerrainQuery(grid(11, 7), 11, 7, options),
    { positions, normals, indices } = q.triangles();
  assert.equal(positions.length, 11 * 7 * 3);
  assert.equal(indices.length, 10 * 6 * 6);
  for (let v = 0; v < positions.length / 3; v++) {
    const x = positions[v * 3],
      z = positions[v * 3 + 2];
    assert.ok(Math.abs(positions[v * 3 + 1] - q.height(x, z)) < 1e-4, `vertex ${v} on the surface`);
    const n = q.normal(x, z);
    for (let a = 0; a < 3; a++) assert.ok(Math.abs(normals[v * 3 + a] - n[a]) < 1e-6, `vertex ${v} normal`);
  }
  assert.deepEqual([positions[0], positions[2]], [-10, 4], 'first vertex at the origin');
  assert.deepEqual([positions.at(-3), positions.at(-1)], [10, 19], 'last vertex at origin + size');
  for (let t = 0; t < indices.length; t += 3) {
    const p = (i) => [
        positions[indices[t + i] * 3],
        positions[indices[t + i] * 3 + 1],
        positions[indices[t + i] * 3 + 2],
      ],
      [a, b, c] = [p(0), p(1), p(2)],
      e = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      f = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    assert.ok(e[2] * f[0] - e[0] * f[2] > 0, `triangle ${t / 3} faces up`);
  }
});

test('a step thins the mesh and keeps the last row and column; a region clips to whole cells', () => {
  const q = new TerrainQuery(grid(11, 7), 11, 7, options),
    coarse = q.triangles({ step: 4 });
  // Columns 0, 4, 8, 10 and rows 0, 4, 6.
  assert.equal(coarse.positions.length / 3, 4 * 3);
  assert.equal(coarse.indices.length, 3 * 2 * 6);
  assert.deepEqual([coarse.positions.at(-3), coarse.positions.at(-1)], [10, 19]);
  // Cells are 2 x 2.5 m; x -3.5..1.2 widens to samples 3..6 (x -4..2), z 5..9 to rows 0..2 (z 4..9).
  const part = q.triangles({ region: { min: [-3.5, 5], max: [1.2, 9] } }),
    xs = new Set(),
    zs = new Set();
  for (let v = 0; v < part.positions.length / 3; v++) {
    xs.add(part.positions[v * 3]);
    zs.add(part.positions[v * 3 + 2]);
  }
  assert.deepEqual([...xs], [-4, -2, 0, 2]);
  assert.deepEqual([...zs], [4, 6.5, 9]);
  assert.equal(part.indices.length, 3 * 2 * 6);
});

test('cells whose centre is in a hole are left out; an all-hole mask gives no triangles', () => {
  const mask = new Uint8Array(10 * 6).fill(255);
  mask[2 * 10 + 3] = 0; // the cell at column 3, row 2
  const holes = { mask, columns: 10, rows: 6 },
    q = new TerrainQuery(grid(11, 7), 11, 7, { ...options, holes }),
    { indices, positions } = q.triangles();
  assert.equal(indices.length, (60 - 1) * 6);
  for (let t = 0; t < indices.length; t += 3) {
    const cx = (positions[indices[t] * 3] + positions[indices[t + 1] * 3] + positions[indices[t + 2] * 3]) / 3,
      cz = (positions[indices[t] * 3 + 2] + positions[indices[t + 1] * 3 + 2] + positions[indices[t + 2] * 3 + 2]) / 3;
    assert.ok(q.height(cx, cz) !== undefined, 'no triangle over the hole');
  }
  mask.fill(0);
  assert.equal(q.triangles().indices.length, 0, 'holes are read live');
});

test('bad steps and regions are refused', () => {
  const q = new TerrainQuery(grid(11, 7), 11, 7, options);
  for (const step of [0, 1.5, -1, NaN]) assert.throws(() => q.triangles({ step }), RangeError);
  for (const region of [
    { min: [0, 0], max: [0, 5] },
    { min: [0, NaN], max: [1, 1] },
    { min: [50, 50], max: [60, 60] },
    {},
  ])
    assert.throws(() => q.triangles({ region }), RangeError);
});
