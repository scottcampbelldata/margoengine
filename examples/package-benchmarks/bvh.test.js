import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkload } from './bvh.js';

function heightAt(work, x, z) {
  const cells = 100,
    row = cells + 1,
    u = ((x / work.extent + 1) * cells) / 2,
    v = ((z / work.extent + 1) * cells) / 2;
  const column = Math.min(cells - 1, Math.floor(u)),
    line = Math.min(cells - 1, Math.floor(v));
  const a = (line * row + column) * 3,
    vertices = work.source.positions;
  // Use the stored Float32 cell coordinates, rather than their pre-conversion spacing.
  const fx = (x - vertices[a]) / (vertices[a + 3] - vertices[a]),
    fz = (z - vertices[a + 2]) / (vertices[a + row * 3 + 2] - vertices[a + 2]);
  const ha = vertices[a + 1],
    hb = vertices[a + 4],
    hc = vertices[a + row * 3 + 1],
    hd = vertices[a + row * 3 + 4];
  return fx + fz <= 1 ? ha + (hb - ha) * fx + (hc - ha) * fz : hd + (hc - hd) * (1 - fx) + (hb - hd) * (1 - fz);
}

test('BVH workload bounds its ray counts and builds a real indexed 20k-triangle tree', () => {
  for (const invalid of [0, -1, 1.5, 1025, NaN]) assert.throws(() => createWorkload(invalid), /BVH workload count/);
  const work = createWorkload();
  try {
    assert.equal(work.points.length, 256 * 4);
    assert.equal(work.bvh.triangleCount, 20000);
    assert.equal(work.source.indices.length, 60000);
    assert.equal(work.bvh.positions, work.source.positions);
    assert.ok(work.bvh.nodeCount > 100);
    assert.ok(work.details().buildCpuMilliseconds >= 0);
  } finally {
    work.dispose();
  }
});

test('refit and ray queries drive finite hit markers that match independent triangle interpolation', () => {
  const work = createWorkload(64),
    storage = work.bvh.nodes,
    rays = work.rays.slice();
  try {
    for (let frame = 0; frame < 3; frame++) {
      work.step(0.1);
      assert.equal(work.bvh.nodes, storage);
      assert.equal(work.details().hits, 60);
      assert.equal(work.details().misses, 4);
      assert.equal(work.details().queries, (frame + 1) * 64);
      assert.equal(work.details().refits, frame + 1);
      assert.equal(work.details().shapecasts, frame + 1);
      assert.ok(work.details().broadPhaseTriangles > 0);
      assert.ok(work.details().broadPhaseTriangles < 20000);
      assert.equal(
        work.selectedFaces.reduce((sum, selected) => sum + selected, 0),
        work.details().broadPhaseTriangles,
      );
      for (let i = 0; i < 64; i++) {
        assert.equal(work.rays[i], rays[i]);
        const offset = i * 4;
        if (i % 16 === 0) {
          assert.equal(work.points[offset + 3], 3);
          for (let axis = 0; axis < 3; axis++)
            assert.equal(work.points[offset + axis], Math.fround(work.rays[i].origin[axis]));
        } else {
          const x = work.points[offset],
            y = work.points[offset + 1] - 0.12,
            z = work.points[offset + 2];
          assert.ok(Math.abs(y - heightAt(work, x, z)) < 2e-6, `Marker ${i} left the refitted surface`);
          assert.ok(work.points[offset + 3] === 0 || work.points[offset + 3] === 1);
          assert.equal(
            work.points[offset + 3],
            work.selectedFaces[work.bvh.raycastFirst(work.rays[i], { side: 'front', far: 4 }).faceIndex],
          );
        }
        for (let axis = 0; axis < 3; axis++)
          assert.ok(
            work.points[offset + axis] >= work.bounds.min[axis] && work.points[offset + axis] <= work.bounds.max[axis],
          );
      }
      assert.ok(work.points.every(Number.isFinite));
    }
    for (const invalid of [-1, NaN, Infinity, 0.101]) assert.throws(() => work.step(invalid), /BVH frame delta/);
  } finally {
    work.dispose();
  }
});

test('disposing a BVH workload drops its tree/source references and stops further work', () => {
  const work = createWorkload(1);
  work.step(0);
  const points = work.points.slice(),
    queries = work.details().queries;
  work.dispose();
  work.dispose();
  work.step(0.1);
  assert.equal(work.bvh, null);
  assert.equal(work.source, null);
  assert.equal(work.details().queries, queries);
  assert.deepEqual(work.points, points);
});
