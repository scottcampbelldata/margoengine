// Joint frames on revolute and prismatic joints, and the solver figures ragdoll reads through the public API, against the
// real solver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics } from '../dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

const near = (got, want, bound, label) => assert.ok(Math.abs(got - want) <= bound, `${label}: ${got} against ${want}`);
const IDENTITY = [0, 0, 0, 1];
// A quarter turn about z takes the x axis to y.
const X_TO_Y = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const pair = (physics, joint) => {
  const anchor = physics.addBody(null, { type: 'fixed', colliders: [] }),
    arm = physics.addBody(null, {
      canSleep: false,
      colliders: { shape: 'sphere', radius: 0.2 },
    });
  return { arm, joint: physics.addJoint(anchor, arm, joint) };
};

test('a revolute joint turns about the x axis of its frames, and its limits read from the rest pose', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    { arm, joint } = pair(physics, { type: 'revolute', frameA: X_TO_Y, frameB: X_TO_Y, limits: [-0.5, 0.5] });
  assert.deepEqual(joint.limits, [-0.5, 0.5]);
  // A spin about y is free along the joint's axis; one about z is held.
  arm.setAngularVelocity([0, 2, 0]);
  physics.step();
  near(arm.angularVelocity[1], 2, 0.05, 'about the frame axis');
  arm.setAngularVelocity([0, 0, 2]);
  physics.step();
  near(arm.angularVelocity[2], 0, 0.05, 'across it');
  // Spun on past its limit, it stops at 0.5 radians either way: the rest pose is 0.
  arm.setAngularVelocity([0, 3, 0]);
  for (let i = 0; i < 120; i++) physics.step();
  const [, y, , w] = arm.rotation;
  near(Math.abs(2 * Math.atan2(y, w)), 0.5, 0.02, 'held at the limit');
  physics.dispose();
});

test('frameA moves the rest pose: it carries what lies between the two bodies at rest', () => {
  // Body B stands a quarter turn about y from body A, and both frames name the same world axis. Frame A says so, so
  // the pose reads 0 and limits of 0 to 0 hold it there; identity frames would read a quarter turn and swing it.
  const quarter = [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    physics = new Physics(null, { gravity: [0, 0, 0] }),
    anchor = physics.addBody(null, { type: 'fixed', colliders: [] }),
    arm = physics.addBody(null, { rotation: quarter, colliders: { shape: 'sphere', radius: 0.2 } });
  physics.addJoint(anchor, arm, { type: 'revolute', frameA: X_TO_Y, frameB: X_TO_Y, limits: [0, 0] });
  const swung = arm.rotation;
  for (let i = 0; i < 60; i++) physics.step();
  assert.ok(Math.abs(arm.rotation[1]) < Math.abs(swung[1]), 'identity at rest pulls it back');
  physics.dispose();
  const held = new Physics(null, { gravity: [0, 0, 0] }),
    base = held.addBody(null, { type: 'fixed', colliders: [] }),
    still = held.addBody(null, { rotation: quarter, colliders: { shape: 'sphere', radius: 0.2 } });
  const frameA = [
    quarter[3] * X_TO_Y[0] + quarter[0] * X_TO_Y[3] + quarter[1] * X_TO_Y[2] - quarter[2] * X_TO_Y[1],
    quarter[3] * X_TO_Y[1] - quarter[0] * X_TO_Y[2] + quarter[1] * X_TO_Y[3] + quarter[2] * X_TO_Y[0],
    quarter[3] * X_TO_Y[2] + quarter[0] * X_TO_Y[1] - quarter[1] * X_TO_Y[0] + quarter[2] * X_TO_Y[3],
    quarter[3] * X_TO_Y[3] - quarter[0] * X_TO_Y[0] - quarter[1] * X_TO_Y[1] - quarter[2] * X_TO_Y[2],
  ];
  held.addJoint(base, still, { type: 'revolute', frameA, frameB: X_TO_Y, limits: [0, 0] });
  for (let i = 0; i < 60; i++) held.step();
  still.rotation.forEach((value, i) => near(value, quarter[i], 1e-3, 'stays'));
  held.dispose();
});

test('a prismatic joint slides along the x axis of its frames and a motor drives it there', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    { arm } = pair(physics, {
      type: 'prismatic',
      frameA: X_TO_Y,
      frameB: X_TO_Y,
      limits: [-1, 1],
      motor: { targetVelocity: 1, damping: 10 },
    });
  for (let i = 0; i < 30; i++) physics.step();
  assert.ok(arm.position[1] > 0.3, `slid to ${arm.position}`);
  near(arm.position[0], 0, 1e-3, 'not along x');
  near(arm.position[2], 0, 1e-3, 'not along z');
  physics.dispose();
});

test('a frame is given with the other and not with an axis', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { colliders: [] }),
    b = physics.addBody(null, { colliders: [] });
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute', frameA: IDENTITY }), TypeError);
  assert.throws(() => physics.addJoint(a, b, { type: 'prismatic', frameB: IDENTITY }), TypeError);
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute', axis: [0, 1, 0], frameA: IDENTITY, frameB: IDENTITY }), TypeError);
  assert.throws(() => physics.addJoint(a, b, { type: 'revolute' }), TypeError);
  physics.dispose();
});

test('a frame is a quaternion', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { colliders: [] }),
    b = physics.addBody(null, { colliders: [] });
  for (const frame of [[0, 0, 0, 0], [0, 0, 1], [0, 0, NaN, 1]])
    assert.throws(() => physics.addJoint(a, b, { type: 'revolute', frameA: frame, frameB: IDENTITY }), RangeError);
  physics.dispose();
});

test('a solver without joint frames refuses them with a coded error', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { colliders: [] }),
    b = physics.addBody(null, { colliders: [] }),
    { prototype } = physics.rapier.ImpulseJoint,
    { setLocalFrame1 } = prototype;
  prototype.setLocalFrame1 = undefined;
  try {
    assert.throws(() => physics.addJoint(a, b, { type: 'revolute', frameA: IDENTITY, frameB: IDENTITY }), { code: 'unsupported' });
  } finally {
    prototype.setLocalFrame1 = setLocalFrame1;
  }
  physics.dispose();
});

test('solver passes read and set, for the world and for one island', () => {
  const physics = new Physics(null, { solverIterations: 6 }),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  assert.equal(physics.solverIterations, 6);
  physics.solverIterations = 8;
  assert.equal(physics.world.numSolverIterations, 8);
  assert.throws(() => (physics.solverIterations = 0), RangeError);
  assert.throws(() => (physics.solverIterations = 1.5), RangeError);
  assert.equal(body.additionalSolverIterations, 0);
  body.additionalSolverIterations = 4;
  assert.equal(body.additionalSolverIterations, 4);
  assert.throws(() => (body.additionalSolverIterations = -1), RangeError);
  physics.dispose();
});

test('the force and torque left on a body read back until they are reset', () => {
  const physics = new Physics(null),
    body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1 } });
  body.addForce([1, 2, 3]).addTorque([4, 5, 6]);
  assert.deepEqual(body.appliedForce, [1, 2, 3]);
  assert.deepEqual(body.appliedTorque, [4, 5, 6]);
  body.resetForces();
  assert.deepEqual(body.appliedForce, [0, 0, 0]);
  assert.deepEqual(body.appliedTorque, [0, 0, 0]);
  physics.dispose();
});

test('contact points name where the solver pushes on a body', () => {
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [5, 0.5, 5] }, position: [0, -0.5, 0] });
  const box = physics.addBody(null, {
      canSleep: false,
      position: [1, 0.49, 2],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    }),
    high = physics.addBody(null, { position: [0, 9, 0], colliders: { shape: 'sphere', radius: 0.5 } }),
    ghost = physics.addBody(null, {
      type: 'fixed',
      position: [-3, 0.2, 0],
      colliders: { shape: 'sphere', radius: 0.5, sensor: true },
    });
  physics.step();
  const corners = physics.contactPoints(box);
  assert.equal(corners.length, 4, 'a box on a floor stands on four corners');
  assert.deepEqual(
    corners.map(([x, , z]) => `${Math.round(x * 2) / 2} ${Math.round(z * 2) / 2}`).sort(),
    ['0.5 1.5', '0.5 2.5', '1.5 1.5', '1.5 2.5'],
  );
  for (const [, y] of corners) near(y, 0, 0.02, 'on the floor');
  assert.deepEqual(physics.contactPoints(high), [], 'a body in the air has none');
  assert.deepEqual(physics.contactPoints(ghost), [], 'nor has a sensor');
  physics.dispose();
});
