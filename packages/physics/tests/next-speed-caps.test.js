// Speed caps of the own solver: a body never moves faster than its cap, keeps its direction, and replays bit for bit.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

const speed = (v) => Math.hypot(v[0], v[1], v[2]);

test('a linear cap cuts speed and keeps direction', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = physics.addBody(null, {
    colliders: { shape: 'sphere', radius: 0.5 },
    maxLinearSpeed: 5,
    linearVelocity: [30, 40, 0],
  });
  assert.equal(body.maxLinearSpeed, 5);
  physics.step();
  const v = body.linearVelocity;
  assert.ok(Math.abs(speed(v) - 5) < 1e-4, `speed ${speed(v)}`);
  assert.ok(Math.abs(v[0] / v[1] - 0.75) < 1e-4, 'direction kept');
  physics.dispose();
});

test('a body under force stops gaining speed at its cap, and an angular cap holds a torque', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = physics.addBody(null, {
    colliders: { shape: 'sphere', radius: 0.5 },
    maxLinearSpeed: 3,
    maxAngularSpeed: 2,
  });
  for (let i = 0; i < 120; i++) {
    body.addForce([100, 0, 0]);
    body.addTorque([0, 50, 0]);
    physics.step();
  }
  assert.ok(Math.abs(speed(body.linearVelocity) - 3) < 1e-3, `${speed(body.linearVelocity)}`);
  assert.ok(Math.abs(speed(body.angularVelocity) - 2) < 1e-3, `${speed(body.angularVelocity)}`);
  physics.dispose();
});

test('no cap by default, Infinity clears one, bad values throw, a cap never touches a kinematic body', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 }, linearVelocity: [100, 0, 0] });
  assert.equal(body.maxLinearSpeed, Infinity);
  physics.step();
  assert.ok(Math.abs(body.linearVelocity[0] - 100) < 1e-3);
  body.maxLinearSpeed = 10;
  body.maxLinearSpeed = Infinity;
  assert.equal(body.maxLinearSpeed, Infinity);
  assert.throws(() => (body.maxLinearSpeed = 0), rigidCoded);
  assert.throws(() => (body.maxAngularSpeed = NaN), rigidCoded);
  assert.throws(() => (body.maxAngularSpeed = -1), rigidCoded);
  const kin = physics.addBody(null, {
    type: 'kinematicVelocity',
    colliders: [],
    linearVelocity: [50, 0, 0],
    maxLinearSpeed: 1,
  });
  physics.step();
  assert.ok(Math.abs(kin.linearVelocity[0] - 50) < 1e-3);
  physics.dispose();
});

test('capped worlds replay bit for bit', async () => {
  await Physics.load();
  const run = () => {
    const physics = new Physics(null);
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
    });
    physics.addBody(null, {
      position: [0, 20, 0],
      maxLinearSpeed: 4,
      maxAngularSpeed: 1,
      linearVelocity: [3, 0, 2],
      angularVelocity: [5, 5, 5],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
    for (let i = 0; i < 240; i++) physics.step();
    const hash = physics.kernel.hash;
    physics.dispose();
    return hash;
  };
  assert.equal(run(), run());
});
