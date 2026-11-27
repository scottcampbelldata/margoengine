// Per-body sleep thresholds: a body's own limit and window replace the world's for that body only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

const drift = (physics, extra = {}) =>
  physics.addBody(null, {
    linearVelocity: [0.1, 0, 0],
    linearDamping: 0,
    colliders: { shape: 'sphere', radius: 0.5 },
    ...extra,
  });

test('a higher threshold lets a creeping body sleep, and the default does not', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const lazy = drift(physics),
    eager = drift(physics, { position: [0, 5, 0] });
  assert.ok(Math.abs(eager.sleepThreshold - 0.0002) < 1e-9);
  eager.sleepThreshold = 0.01;
  for (let i = 0; i < 60; i++) physics.step();
  assert.equal(eager.sleeping, true, '0.1 m/s is 0.005 J/kg, under 0.01');
  assert.equal(lazy.sleeping, false, 'and over the world default');
  physics.dispose();
});

test('a shorter window sleeps sooner, and Infinity gives the world back', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const quick = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 } }),
    normal = physics.addBody(null, { position: [5, 0, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  quick.sleepTime = 0.1;
  assert.ok(Math.abs(quick.sleepTime - 0.1) < 1e-6);
  for (let i = 0; i < 12; i++) physics.step();
  assert.equal(quick.sleeping, true);
  assert.equal(normal.sleeping, false);
  quick.sleepTime = Infinity;
  assert.equal(quick.sleepTime, 0.5);
  assert.throws(() => (quick.sleepTime = 0), rigidCoded);
  assert.throws(() => (quick.sleepThreshold = -1), rigidCoded);
  assert.throws(() => (quick.sleepThreshold = NaN), rigidCoded);
  physics.dispose();
});
