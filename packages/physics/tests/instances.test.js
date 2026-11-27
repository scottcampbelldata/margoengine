// One body per instance of an instanced mesh (InstancedBodies), with a stand-in for the instances of createInstancedMesh:
// 24 floats a row, the first 16 a column-major matrix, written with setMatrices.
import assert from 'node:assert/strict';
import test from 'node:test';
import { InstancedBodies, Physics } from '../dist/index.js';

await Physics.load();

const instanced = (count) => {
  const data = new Float32Array(count * 24),
    writes = [];
  for (let i = 0; i < count; i++) {
    // A scale of 2 on x, a quarter turn about y, at (i, 1 + i, 0).
    data.set([0, 0, -2, 0, 0, 1, 0, 0, 1, 0, 0, 0, i, 1 + i, 0, 1], i * 24);
  }
  return {
    writes,
    instances: {
      data,
      capacity: count,
      count,
      setMatrices(start, matrices) {
        writes.push(start);
        for (let i = 0; i < matrices.length / 16; i++)
          data.set(matrices.subarray(i * 16, i * 16 + 16), (start + i) * 24);
        return this;
      },
    },
  };
};
const coded = (pattern) => (error) =>
  error.name === 'MargoError' && pattern.test(error.message) && error.message.includes('errors#physics-instances');

test('each instance gets a body at its matrix, and the bodies write their poses back with the scale kept', () => {
  const physics = new Physics(null),
    mesh = instanced(500),
    group = new InstancedBodies(physics, mesh, { colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } });
  assert.equal(group.bodies.length, 500);
  assert.deepEqual(group.body(3).position, [3, 4, 0], 'starts at its instance');
  const r = group.body(3).rotation;
  assert.ok(
    Math.abs(Math.abs(r[1]) - Math.SQRT1_2) < 1e-6 && Math.abs(Math.abs(r[3]) - Math.SQRT1_2) < 1e-6,
    'a quarter turn about y',
  );
  for (let i = 0; i < 30; i++) physics.step();
  physics.sync(1);
  for (const i of [0, 250, 499]) {
    const [x, y, z] = group.body(i).position,
      row = mesh.instances.data.subarray(i * 24, i * 24 + 16);
    assert.ok(Math.abs(row[12] - x) < 1e-5 && Math.abs(row[13] - y) < 1e-5 && Math.abs(row[14] - z) < 1e-5);
    assert.ok(y < 1 + i, `instance ${i} fell under gravity`);
    assert.ok(Math.abs(Math.hypot(row[0], row[1], row[2]) - 2) < 1e-5, 'the x scale of 2 is kept');
    assert.ok(Math.abs(Math.hypot(row[4], row[5], row[6]) - 1) < 1e-5);
  }
  assert.equal(mesh.writes.length, 1, 'one setMatrices a sync for every instance');
  group.remove();
  assert.equal(physics.bodyCount, 0, 'remove takes the bodies out');
  physics.sync(1);
  assert.equal(mesh.writes.length, 1, 'nothing is written once removed');
});

test('sleeping instances cost no write once their rest is drawn', () => {
  const physics = new Physics(null),
    mesh = instanced(4);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  // Boxes, not spheres: a sphere on a frictional plane rolls on and never sleeps.
  const group = new InstancedBodies(physics, mesh, { colliders: { shape: 'box', halfExtents: [0.3, 0.3, 0.3] } });
  let steps = 0;
  while (group.bodies.some((b) => !b.sleeping) && steps++ < 2000) {
    physics.step();
    physics.sync(1);
  }
  assert.ok(steps < 2000, 'they fall asleep');
  const writes = mesh.writes.length;
  physics.step();
  physics.sync(1);
  physics.step();
  physics.sync(1);
  assert.equal(mesh.writes.length, writes, 'no write while all sleep');
  group.body(0).applyImpulse([0, 3, 0]);
  physics.step();
  physics.sync(1);
  assert.equal(mesh.writes.length, writes + 1, 'a woken body writes again');
});

test('the bodies of instances replay bit for bit after a snapshot and restore', () => {
  const physics = new Physics(null),
    group = new InstancedBodies(physics, instanced(40), { colliders: { shape: 'box', halfExtents: [0.4, 0.4, 0.4] } });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
  });
  for (let i = 0; i < 30; i++) physics.step();
  const snapshot = physics.takeSnapshot(),
    run = () => {
      for (let i = 0; i < 60; i++) physics.step();
      return group.bodies.flatMap((b) => [...b.position, ...b.rotation]);
    },
    first = run();
  physics.restoreSnapshot(snapshot);
  assert.deepEqual(run(), first);
});

test('InstancedBodies refuses a mesh without instances, a count past them, no colliders and a bad index', () => {
  const physics = new Physics(null);
  assert.throws(
    () => new InstancedBodies(physics, {}, { colliders: { shape: 'sphere', radius: 1 } }),
    coded(/instanced mesh/),
  );
  assert.throws(
    () => new InstancedBodies(physics, instanced(2), { count: 3, colliders: { shape: 'sphere', radius: 1 } }),
    coded(/count/),
  );
  assert.throws(() => new InstancedBodies(physics, instanced(2), { colliders: [] }), coded(/colliders/));
  const group = new InstancedBodies(physics, instanced(2), { colliders: { shape: 'sphere', radius: 1 } });
  assert.throws(() => group.body(2), coded(/index/));
  assert.equal(physics.bodyCount, 2, 'a refused group leaves no bodies behind');
});
