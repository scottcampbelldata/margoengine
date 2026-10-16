import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkload as navigation } from './navigation.js';
import { createWorkload as physics } from './physics.js';
import { createWorkload as road } from './road.js';

const finite = (array) => assert.ok(array.every(Number.isFinite));
function avoidsHole(path) {
  for (let i = 1; i < path.length; i++)
    for (let j = 0; j <= 64; j++) {
      const a = path[i - 1],
        b = path[i],
        t = j / 64,
        x = a.x + (b.x - a.x) * t,
        z = a.z + (b.z - a.z) * t;
      assert.ok(Math.abs(x) >= 3 - 1e-4 || Math.abs(z) >= 3 - 1e-4, 'Detour route must not cross the missing floor');
    }
}

test('Navigation builds real Recast geometry and markers follow hole-avoiding Detour routes', async () => {
  const work = await navigation(96),
    originalPoints = work.points,
    originalYaw = work.yaw,
    owned = work.navigation;
  try {
    assert.equal(work.details().agents, 24);
    assert.equal(work.details().inputTriangles, 144);
    assert.equal(work.details().failedQueries, 0);
    assert.ok(work.details().bentPaths > 0);
    for (const path of work.paths) {
      assert.ok(path.length >= 3);
      avoidsHole(path);
    }
    const before = work.points.slice(72 * 4);
    for (let i = 0; i < 120; i++) work.step(1 / 60);
    assert.equal(work.details().pathQueries, 24 * 121);
    assert.equal(work.details().failedQueries, 0);
    assert.notDeepEqual(work.points.slice(72 * 4), before);
    for (const path of work.paths) avoidsHole(path);
    for (let i = 0; i < work.agents.length; i++) {
      const p = work.agents[i].position;
      assert.ok(Math.abs(p.x) >= 3 - 1e-4 || Math.abs(p.z) >= 3 - 1e-4);
      assert.equal(work.points[(i + 72) * 4], Math.fround(p.x));
      assert.equal(work.points[(i + 72) * 4 + 2], Math.fround(p.z));
    }
    assert.equal(work.points, originalPoints);
    assert.equal(work.yaw, originalYaw);
    finite(work.points);
    finite(work.yaw);
  } finally {
    work.dispose();
  }
  assert.throws(() => owned.path({ x: 0, y: 0, z: 4 }, { x: 4, y: 0, z: 4 }), /disposed/);
  assert.equal(work.navigation, null);
  assert.equal(work.agents, null);
  assert.equal(work.paths, null);
});

test('Physics markers equal real rotation-locked Rapier bodies and actual downward ray hits', async () => {
  const work = await physics(80),
    originalPoints = work.points,
    owned = work.physics;
  try {
    assert.equal(owned.bodyCount, 65);
    assert.equal(work.details().queryHits, 16);
    const firstHeight = work.points[1];
    for (let i = 0; i < 240; i++) work.step(1 / 60);
    assert.equal(work.details().fixedSteps, 241);
    assert.ok(work.details().contactStarts > 0);
    assert.ok(work.details().impulses > 0);
    assert.equal(work.details().queryHits, 16);
    assert.notEqual(work.points[1], firstHeight);
    for (let i = 0; i < work.bodies.length; i++) {
      const body = work.bodies[i],
        p = body.position,
        q = body.rotation;
      for (let axis = 0; axis < 3; axis++) assert.equal(work.points[i * 4 + axis], Math.fround(p[axis]));
      assert.ok(p[1] > 0.09);
      assert.ok(Math.abs(q[0]) + Math.abs(q[1]) + Math.abs(q[2]) < 1e-7);
      assert.ok(Math.abs(q[3] - 1) < 1e-7);
    }
    for (let i = 64; i < 80; i++) {
      const offset = i * 4,
        hit = owned.raycast([work.points[offset], 6, work.points[offset + 2]], [0, -1, 0], { maxDistance: 8 });
      assert.ok(hit);
      assert.ok(Math.abs(work.points[offset + 1] - (hit.point[1] + 0.15)) < 1e-5);
      assert.equal(work.points[offset + 3], 2);
    }
    assert.equal(work.points, originalPoints);
    finite(work.points);
  } finally {
    work.dispose();
  }
  assert.ok(owned.isDisposed);
  assert.equal(owned.bodyCount, 0);
  assert.equal(work.physics, null);
  assert.equal(work.bodies, null);
});

test('Road markers come from actual sweep corners with normalized normals and tiled UV topology', () => {
  const work = road(136),
    originalPoints = work.points;
  try {
    const initial = work.result;
    work.step(0.1);
    const result = work.result;
    assert.notEqual(result, initial);
    assert.equal(result.geometry.vertices.length / 6, 238);
    assert.equal(result.geometry.indices.length / 3, 224);
    assert.equal(result.uvs.length, 476);
    assert.ok(result.section[1][1] > initial.section[1][1]);
    for (let row = 0; row <= 16; row++)
      for (let corner = 0; corner < 8; corner++) {
        const vertex = (row * 14 + (corner === 7 ? 13 : corner * 2)) * 6,
          offset = (row * 8 + corner) * 4;
        for (let axis = 0; axis < 3; axis++)
          assert.equal(work.points[offset + axis], result.geometry.vertices[vertex + axis]);
        assert.equal(work.points[offset + 3], result.section[corner][1] > 0 ? 1 : 0);
      }
    for (let i = 0; i < result.geometry.vertices.length; i += 6)
      assert.ok(Math.abs(Math.hypot(...result.geometry.vertices.subarray(i + 3, i + 6)) - 1) < 1e-6);
    assert.ok(Math.abs(result.uvs.at(-1) - work.curve.length / 2) < 1e-5);
    assert.equal(work.points, originalPoints);
    finite(work.points);
    finite(result.uvs);
  } finally {
    work.dispose();
  }
  assert.equal(work.curve, null);
  assert.equal(work.result, null);
});

test('Optional runtime workloads bound inputs and freeze counters/poses after disposal', async () => {
  for (const invalid of [0, 1, 95, 257, NaN, Infinity, 96.5]) await assert.rejects(navigation(invalid), /count/);
  for (const invalid of [0, 79, 529, NaN, Infinity, 80.5]) await assert.rejects(physics(invalid), /count/);
  for (const invalid of [0, 23, 25, 1040, NaN, Infinity]) assert.throws(() => road(invalid), /count/);
  for (const work of [await navigation(96), await physics(80), road(136)]) {
    for (const invalid of [-1, NaN, Infinity, 0.11]) assert.throws(() => work.step(invalid), /delta/);
    work.step(0);
    const points = work.points.slice(),
      counters = work.details();
    work.dispose();
    work.dispose();
    work.step(1 / 60);
    assert.deepEqual(work.points, points);
    assert.deepEqual(work.details(), counters);
  }
});
