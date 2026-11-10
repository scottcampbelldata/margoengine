import test from 'node:test';
import assert from 'node:assert/strict';
import { box, Geometry } from '@margoengine/core';
import { Scatter } from '../dist/index.js';
import { farthest, ringDistance, scatterLODs } from '../dist/simplify.js';

// A UV sphere of radius 1 with smooth normals: `rows` bands, `cols` segments, shared vertices.
function sphere(rows = 24, cols = 48) {
  const p = [],
    idx = [];
  for (let r = 0; r <= rows; r++)
    for (let c = 0; c <= cols; c++) {
      const t = (r / rows) * Math.PI,
        f = (c / cols) * 2 * Math.PI;
      p.push(Math.sin(t) * Math.cos(f), Math.cos(t), Math.sin(t) * Math.sin(f));
    }
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const a = r * (cols + 1) + c,
        b = a + cols + 1;
      if (r) idx.push(a, a + 1, b);
      if (r < rows - 1) idx.push(a + 1, b + 1, b);
    }
  return new Geometry(p, p, idx);
}
const vertexKeys = (g) => {
  const keys = new Set();
  for (let i = 0; i < g.vertices.length; i += 6) keys.add(Array.from(g.vertices.subarray(i, i + 6)).join());
  return keys;
};

test('scatterLODs: ring 0 is the source, rings 1 and 2 nest near their ratios', async () => {
  const source = sphere();
  const { meshes, triangles, deviation } = await scatterLODs(source);
  assert.equal(meshes[0], source);
  assert.equal(triangles[0], source.indices.length / 3);
  assert.ok(triangles[1] < triangles[0] && triangles[2] < triangles[1]);
  // The simplifier stops at or just under its target; it may keep up to 1.5 times more only when collapses run out.
  assert.ok(triangles[1] <= Math.ceil(triangles[0] * 0.4) * 1.5, `ring 1 kept ${triangles[1]}`);
  assert.ok(triangles[2] <= Math.ceil(triangles[0] * 0.12) * 1.5, `ring 2 kept ${triangles[2]}`);
  assert.equal(deviation[0], 0);
  // A coarser ring of a unit sphere strays further, and never by its whole radius.
  assert.ok(deviation[1] > 0 && deviation[1] <= deviation[2] && deviation[2] < 0.25, String(deviation));
});

test('scatterLODs: every ring vertex is a source vertex with its own normal', async () => {
  const source = sphere(),
    keys = vertexKeys(source);
  const { meshes } = await scatterLODs(source, { ratios: [0.5, 0.2] });
  for (const ring of meshes.slice(1)) for (const key of vertexKeys(ring)) assert.ok(keys.has(key), key);
});

test('scatterLODs: hard edges stay hard on a cube', async () => {
  const cube = box(2, 1, 0.5);
  const { meshes, deviation } = await scatterLODs(cube, { ratios: [0.9, 0.5] });
  const normals = new Set();
  for (let i = 0; i < cube.vertices.length; i += 6)
    normals.add(Array.from(cube.vertices.subarray(i + 3, i + 6)).join());
  for (const ring of meshes)
    for (let i = 0; i < ring.vertices.length; i += 6)
      assert.ok(normals.has(Array.from(ring.vertices.subarray(i + 3, i + 6)).join()));
  // A box has no triangle to spare: nothing collapses without changing its shape, so every ring keeps it exactly.
  assert.deepEqual(deviation, [0, 0, 0]);
});

test('scatterLODs: the rings drive a Scatter', async () => {
  const { meshes } = await scatterLODs(sphere(12, 24));
  assert.doesNotThrow(() => new Scatter(meshes, { count: 16 }));
});

test('farthest: closest-point regions of one triangle', () => {
  const tri = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    idx = new Uint32Array([0, 1, 2]);
  const at = (x, y, z) => farthest(new Float32Array([x, y, z, 0, 1, 0]), tri, idx);
  assert.equal(at(0.2, 3, 0.2), 3); // face
  assert.equal(at(-3, 0, -4), 5); // vertex a
  assert.equal(at(4, 0, -4), 5); // vertex b
  assert.equal(at(0, 3, 5), Math.hypot(3, 4)); // vertex c
  assert.equal(at(0.5, 0, -2), 2); // edge ab
  assert.equal(at(-2, 0, 0.5), 2); // edge ac
  assert.ok(Math.abs(at(1, 0, 1) - Math.SQRT1_2) < 1e-7); // edge bc
  // The largest over several vertices, and 0 for a vertex on the surface.
  assert.equal(farthest(new Float32Array([0.1, 0, 0.1, 0, 1, 0, 0.2, -2, 0.2, 0, 1, 0]), tri, idx), 2);
});

test('ringDistance: on-screen error from deviation', () => {
  // tan(30 deg) = 1 / sqrt(3): 0.01 * 1080 / (2 / sqrt(3)) = 5.4 * sqrt(3).
  assert.ok(Math.abs(ringDistance(0.01) - 5.4 * Math.sqrt(3)) < 1e-9);
  assert.ok(Math.abs(ringDistance(0.01, 2) - 2.7 * Math.sqrt(3)) < 1e-9);
  assert.equal(ringDistance(0), 0);
  for (const bad of [[-1], [Number.NaN], [1, 0], [1, 1, 0], [1, 1, 100, Math.PI]])
    assert.throws(
      () => ringDistance(...bad),
      (e) => e instanceof RangeError && /deviation of 0 or more/.test(e.message),
    );
});

test('scatterLODs: refuses bad input and says how to fix it', async () => {
  await assert.rejects(scatterLODs({}), (e) => e instanceof TypeError && /core Geometry/.test(e.message));
  await assert.rejects(scatterLODs(new Geometry([], [], [])), TypeError);
  for (const ratios of [[0.5], [0.2, 0.4], [1.2, 0.5], [0.5, 0], 'x'])
    await assert.rejects(
      scatterLODs(sphere(4, 8), { ratios }),
      (e) => e instanceof RangeError && /such as \[0.4, 0.12\]/.test(e.message),
    );
  await assert.rejects(scatterLODs(sphere(4, 8), null), TypeError);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  await assert.rejects(scatterLODs(sphere(4, 8), { signal: controller.signal }), /stop/);
});
