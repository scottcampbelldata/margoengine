// A multibody's kinematics read out: the pose of one link for given coordinates, the body Jacobian, the branch from the root,
// displacements, and inverse kinematics with a rotation target, both targets, and constrained axes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

/** Three hinges about Z, each link 1 m long hanging below the one before: the end of link k is at the sum of (sin a, -cos a). */
function arm(physics) {
  const pivot = physics.addBody(null, { type: 'fixed', colliders: [] });
  const bodies = [0, 1, 2].map((i) =>
    physics.addBody(null, { position: [0, -(i + 1), 0], colliders: { shape: 'sphere', radius: 0.05, mass: 1 } }),
  );
  const multibody = physics.addMultibody(
    pivot,
    bodies.map((body) => ({
      body,
      joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, 1, 0] },
    })),
  );
  return { pivot, bodies, multibody };
}
const planar = (angles) => {
  let x = 0,
    y = 0,
    sum = 0;
  for (const a of angles) {
    sum += a;
    x += Math.sin(sum);
    y -= Math.cos(sum);
  }
  return [x, y, sum];
};

test('the pose of one link for given coordinates, without moving the bodies', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { bodies, multibody } = arm(physics);
  const angles = [0.3, -0.5, 0.7];
  const pose = multibody.forwardKinematics(bodies[2], angles);
  const [x, y, total] = planar(angles);
  near(pose.position[0], x, 1e-5, 'x');
  near(pose.position[1], y, 1e-5, 'y');
  near(pose.rotation[2], Math.sin(total / 2), 1e-5, 'turn about z');
  // The bodies have not moved; and with no coordinates it reads where they are now.
  assert.deepEqual(bodies[2].position, [0, -3, 0]);
  const here = multibody.forwardKinematics(bodies[1]);
  near(here.position[1], -2, 1e-5, 'now');
  assert.throws(() => multibody.forwardKinematics(bodies[0], [1]), RangeError);
  physics.dispose();
});

test('the body Jacobian matches the poses it differentiates, and the branch lists the joints it crosses', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { pivot, bodies, multibody } = arm(physics);
  const angles = [0.3, -0.5, 0.7],
    jac = multibody.bodyJacobian(bodies[1], [0, 0, 0], angles);
  assert.equal(jac.length, 6, 'three linear rows, then three angular');
  assert.equal(jac[0].length, 3, 'a column for each joint coordinate');
  const h = 1e-5;
  for (let k = 0; k < 3; k++) {
    const up = angles.slice(),
      down = angles.slice();
    up[k] += h;
    down[k] -= h;
    const a = multibody.forwardKinematics(bodies[1], up).position,
      b = multibody.forwardKinematics(bodies[1], down).position;
    for (let r = 0; r < 3; r++) near(jac[r][k], (a[r] - b[r]) / (2 * h), 1e-3, `linear row ${r}, column ${k}`);
  }
  // Link 1 moves with joints 0 and 1 only: a spin about z, and nothing from joint 2.
  [1, 1, 0].forEach((v, k) => near(jac[5][k], v, 1e-6, `spin about z, column ${k}`));
  assert.equal(jac[0][2], 0);
  assert.deepEqual(multibody.kinematicBranch(bodies[1]), [pivot, bodies[0], bodies[1]]);
  assert.deepEqual(multibody.kinematicBranch(pivot), [pivot]);
  physics.dispose();
});

test('displacements add to the coordinates, turn by turn', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { multibody } = arm(physics);
  multibody.applyDisplacements([0.1, 0.2, -0.3]);
  const now = multibody.coordinates();
  [0.1, 0.2, -0.3].forEach((v, i) => near(now[i], v, 1e-5, `joint ${i}`));
  multibody.applyDisplacements([0.1, 0, 0]);
  near(multibody.coordinates()[0], 0.2, 1e-5, 'again, on top');
  assert.throws(() => multibody.applyDisplacements([1]), RangeError);
  physics.dispose();
});

test('inverse kinematics reaches a rotation alone, a rotation with a position, and obeys constrained axes', async () => {
  await Physics.load();
  const quat = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
  {
    const physics = new Physics(null);
    const { bodies, multibody } = arm(physics);
    const result = multibody.inverseKinematics(bodies[2], { rotation: quat(0.8) }, { iterations: 200 });
    assert.ok(result.converged, `rotation target: ${JSON.stringify(result)}`);
    near(planar(multibody.coordinates())[2], 0.8, 0.01, 'the end link turned 0.8');
    physics.dispose();
  }
  {
    const physics = new Physics(null);
    const { bodies, multibody } = arm(physics);
    const result = multibody.inverseKinematics(
      bodies[2],
      { position: [1, -1.5, 0], rotation: quat(1.2) },
      { iterations: 400 },
    );
    assert.ok(result.converged, `both targets: ${JSON.stringify(result)}`);
    const [x, y, total] = planar(multibody.coordinates());
    near(x, 1, 0.01, 'x');
    near(y, -1.5, 0.01, 'y');
    near(total, 1.2, 0.01, 'turn');
    physics.dispose();
  }
  {
    // A target out of the plane: unreachable in z, so it only converges when z is not constrained.
    const physics = new Physics(null);
    const { bodies, multibody } = arm(physics);
    const free = multibody.inverseKinematics(
      bodies[2],
      { position: [1, -1.5, 5] },
      { iterations: 200, constrain: { position: [true, true, false] } },
    );
    assert.ok(free.converged, `z left free: ${JSON.stringify(free)}`);
    const [x, y] = planar(multibody.coordinates());
    near(x, 1, 0.01, 'x, z free');
    near(y, -1.5, 0.01, 'y, z free');
    physics.dispose();
    const held = new Physics(null);
    const second = arm(held);
    const stuck = second.multibody.inverseKinematics(second.bodies[2], { position: [1, -1.5, 5] }, { iterations: 200 });
    assert.equal(stuck.converged, false, 'with z constrained the target is out of reach');
    assert.throws(
      () =>
        second.multibody.inverseKinematics(
          second.bodies[2],
          { position: [1, -1.5, 0] },
          { constrain: { position: [false, false, false] } },
        ),
      RangeError,
    );
    held.dispose();
  }
});

test('a kinematic link follows the coordinates the caller sets and drags the dynamic link below it', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const root = physics.addBody(null, { type: 'fixed' });
  const driven = physics.addBody(null, {
    type: 'kinematicPosition',
    position: [0, -1, 0],
    colliders: { shape: 'sphere', radius: 0.1, mass: 1 },
  });
  const hanging = physics.addBody(null, { position: [0, -2, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  const joint = (anchorA) => ({ type: 'revolute', axis: [0, 0, 1], anchorA, anchorB: [0, 1, 0] });
  const multibody = physics.addMultibody(root, [
    { body: driven, joint: joint([0, 0, 0]) },
    { body: hanging, joint: joint([0, 0, 0]) },
  ]);
  // One radian a second about the root: at each step the caller sets the angle for the end of the step.
  for (let i = 1; i <= 60; i++) {
    multibody.setCoordinates([i / 60, multibody.coordinates()[1]]);
    physics.step();
  }
  assert.equal(driven.type, 'kinematicPosition');
  near(driven.position[0], Math.sin(1), 1e-3, 'the driven link, x');
  near(driven.position[1], -Math.cos(1), 1e-3, 'the driven link, y');
  const a = driven.position,
    b = hanging.position;
  near(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), 1, 0.02, 'the hanging link stays a metre from it');
  assert.ok(b[0] > 0.3, `and is carried round: ${b}`);
  physics.dispose();
});

test('joint damping and dry friction on a hinge follow their closed forms', async () => {
  await Physics.load();
  function spin(set) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const wall = physics.addBody(null, { type: 'fixed' });
    // A solid sphere of 1 kg and radius 0.5 has inertia 0.1 kg m^2.
    const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, mass: 1 } });
    const joint = physics.addJoint(wall, body, { type: 'revolute', axis: [0, 0, 1] });
    set(joint);
    body.setAngularVelocity([0, 0, 4]);
    const at = [];
    for (let i = 1; i <= 180; i++) {
      physics.step();
      if (i === 60 || i === 180) at.push(body.angularVelocity[2]);
    }
    physics.dispose();
    return at;
  }
  // Torque c w on inertia 0.1: w = 4 exp(-c t / 0.1).
  const damped = spin((joint) => joint.setDamping(0.2));
  near(damped[0], 4 * Math.exp(-2), 0.1, 'damping at 1 s');
  near(damped[1], 4 * Math.exp(-6), 0.05, 'damping at 3 s');
  // Dry friction of 0.2 N m is 2 rad/s2: 2 rad/s at 1 s, stopped by 2 s, and held.
  const rough = spin((joint) => joint.setFriction(0.2));
  near(rough[0], 2, 0.1, 'friction at 1 s');
  near(rough[1], 0, 0.02, 'stopped and held');
  const free = spin((joint) => joint.setDamping(0.2).setDamping(0));
  near(free[1], 4, 0.01, 'off again');
});

/** A one-metre arm out along X from a fixed pivot on a ball joint with the swing across X held to one angle, as a cone holds it. */
function shoulder(physics, extra = {}) {
  const pivot = physics.addBody(null, { type: 'fixed', colliders: [] });
  const arm = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.05, mass: 1 } });
  const multibody = physics.addMultibody(pivot, [
    {
      body: arm,
      joint: {
        type: 'generic',
        locked: ['linX', 'linY', 'linZ'],
        anchorA: [0, 0, 0],
        anchorB: [-1, 0, 0],
        coupled: ['angY', 'angZ'],
        limits: { angY: [0, 0.6], ...extra },
      },
    },
  ]);
  return { arm, multibody };
}
/** The angle between the arm's X axis and the world's X: the swing of the joint. */
const swing = (arm) => {
  const [x, y, z, w] = arm.rotation;
  return Math.acos(Math.min(1, 1 - 2 * (y * y + z * z)) + 0 * (x + w));
};

test('inverse kinematics keeps a ball joint inside its cone: a target outside it is reached as far as the edge, one inside is reached', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const { arm, multibody } = shoulder(physics);
  // The tip is 2 m from the pivot: a target 90 degrees round is far outside a cone of 0.6 rad.
  const outside = multibody.inverseKinematics(arm, { position: [0, 2, 0] }, { point: [1, 0, 0] });
  assert.equal(outside.converged, false);
  near(swing(arm), 0.6, 1e-3, 'the swing stops at the cone edge');
  // The nearest the tip can come is on the edge in the target's plane: 2 (cos 0.6, sin 0.6).
  const tip = [2 * Math.cos(0.6), 2 * Math.sin(0.6)];
  near(
    outside.positionError,
    Math.hypot(tip[0], 2 - tip[1]),
    2e-3,
    'what is left of the error is the distance to the edge',
  );
  const inside = multibody.inverseKinematics(
    arm,
    { position: [2 * Math.cos(0.3), 0, 2 * Math.sin(0.3)] },
    { point: [1, 0, 0] },
  );
  assert.equal(inside.converged, true);
  near(swing(arm), 0.3, 1e-3, 'a target inside is reached');
  physics.dispose();
});

test('inverse kinematics keeps the twist of a ball joint inside its range', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  // A twist about X of 0.8 rad asked of a joint that twists only within 0.2 either way; with no twist limit it is reached.
  const wanted = [Math.sin(0.4), 0, 0, Math.cos(0.4)];
  const twist = (arm) => 2 * Math.asin(arm.rotation[0]);
  const free = shoulder(physics);
  free.multibody.inverseKinematics(free.arm, { rotation: wanted });
  near(twist(free.arm), 0.8, 2e-3, 'with no limit the twist is reached');
  const held = new Physics(null, { gravity: [0, 0, 0] });
  const limited = shoulder(held, { angX: [-0.2, 0.2] });
  const result = limited.multibody.inverseKinematics(limited.arm, { rotation: wanted });
  assert.equal(result.converged, false);
  near(twist(limited.arm), 0.2, 2e-3, 'the twist stops at its limit');
  physics.dispose();
  held.dispose();
});
