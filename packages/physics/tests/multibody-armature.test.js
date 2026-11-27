// A joint's armature (the rotor inertia a motor and gearbox load its axis with) in a multibody, and the augmented mass and the
// inverse inertia each coordinate reads: a pendulum swings at the period its rotor sets, a torque and an impulse turn a hinge by
// what its rotor leaves them, damping takes a hinge's speed down as the augmented mass says, and the inverses invert.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

/** A sphere of `mass` kg and radius `radius` at `length` m below a fixed pivot, on a hinge about z, as a multibody. */
function pendulum(physics, { mass = 1, radius = 0.1, length = 1 } = {}) {
  const pivot = physics.addBody(null, { type: 'fixed', colliders: [] }),
    bob = physics.addBody(null, {
      position: [0, -length, 0],
      colliders: { shape: 'sphere', radius, mass },
      linearDamping: 0,
      angularDamping: 0,
    }),
    multibody = physics.addMultibody(pivot, [
      { body: bob, joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, length, 0] } },
    ]);
  return {
    bob,
    multibody,
    joint: multibody.links[0].joint,
    inertia: 0.4 * mass * radius * radius + mass * length * length,
  };
}

test('armature: a pendulum swings at the period its rotor inertia sets', () => {
  // Small swings of a body of inertia I about its pivot with a rotor of inertia a on the hinge: T = 2 pi sqrt((I + a) /
  // (m g L)). A rotor as heavy as the bob doubles the inertia, so the period grows by sqrt(2). Measured at 240 steps a second
  // over ten swings: 0.03 percent long without the rotor and 0.03 percent with it: a bound of 0.3 percent.
  const period = (armature) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 240 }),
      { bob, multibody, joint, inertia } = pendulum(physics);
    joint.setArmature(armature);
    multibody.setCoordinates([0.05]);
    let last = bob.position[0],
      crossings = [];
    for (let f = 1; f <= 240 * 30 && crossings.length < 11; f++) {
      physics.step();
      const x = bob.position[0];
      if (last > 0 && x <= 0) crossings.push((f - x / (x - last)) / 240);
      last = x;
    }
    physics.dispose();
    const measured = (crossings.at(-1) - crossings[0]) / (crossings.length - 1),
      expected = 2 * Math.PI * Math.sqrt((inertia + armature) / (1 * 9.81 * 1));
    return measured / expected - 1;
  };
  for (const a of [0, 1.004]) assert.ok(Math.abs(period(a)) < 0.003, `armature ${a}: ${period(a)} off the period`);
});

test('armature: a torque turns a hinge at tau / (I + a), the impulses given between steps too, as forward dynamics says', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    { bob, multibody, joint, inertia } = pendulum(physics),
    a = 0.5;
  joint.setArmature(a);
  assert.equal(joint.armature(), a);
  // A torque held for a second: the rotor takes its share.
  bob.addTorque([0, 0, 2]);
  for (let i = 0; i < 60; i++) physics.step();
  bob.resetTorques();
  const spun = multibody.velocities()[0];
  assert.ok(Math.abs(spun / (2 / (inertia + a)) - 1) < 1e-4, `${spun} rad/s against ${2 / (inertia + a)}`);
  // An impulse landed at the next step is shared with the rotor as well.
  bob.applyTorqueImpulse([0, 0, 0.3]);
  physics.step();
  const kicked = multibody.velocities()[0] - spun;
  assert.ok(Math.abs(kicked / (0.3 / (inertia + a)) - 1) < 1e-4, `${kicked} rad/s against ${0.3 / (inertia + a)}`);
  // The joint-space model agrees: forward and inverse dynamics count the rotor.
  assert.ok(Math.abs(multibody.massMatrix()[0][0] - (inertia + a)) < 1e-5);
  assert.ok(Math.abs(multibody.forwardDynamics([2])[0] - 2 / (inertia + a)) < 1e-5);
  assert.ok(Math.abs(multibody.inverseDynamics([3])[0] - 3 * (inertia + a)) < 1e-5);
  physics.dispose();
});

test('augmented mass: damping takes a hinge down by the factor its augmented mass gives each substep', () => {
  // An implicit damper c on a coordinate of inertia H: each substep of h keeps H / (H + h c) of its speed, the diagonal of the
  // mass matrix over the augmented one's, so a step of s substeps keeps that to the s. The joint passes reach that solve in
  // the bodies' own coordinates, not exactly in the joint's: measured 0.1 percent off on what a step takes away, a bound of
  // 0.5 percent.
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    { multibody, joint } = pendulum(physics),
    h = physics.fixedTimestep / physics.kernel.substeps;
  joint.setArmature(0.3).setDamping(2);
  multibody.links[0].body.setAngularVelocity([0, 0, 3]);
  physics.step();
  const before = multibody.velocities()[0];
  physics.step();
  const kept = multibody.velocities()[0] / before,
    ratio = multibody.massMatrix()[0][0] / multibody.augmentedMassMatrix(h)[0][0];
  const predicted = ratio ** physics.kernel.substeps;
  assert.ok(Math.abs((1 - kept) / (1 - predicted) - 1) < 0.005, `kept ${kept} against ${predicted}`);
  assert.ok(Math.abs(multibody.augmentedMassMatrix(h)[0][0] - multibody.massMatrix()[0][0] - 2 * h) < 1e-6);
  assert.throws(() => multibody.augmentedMassMatrix(0), { code: 'unsupported' });
  physics.dispose();
});

test('the inverse mass matrix and each coordinate inverse inertia invert the mass matrix of a double pendulum', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    pivot = physics.addBody(null, { type: 'fixed', colliders: [] }),
    upper = physics.addBody(null, {
      position: [0, -1, 0],
      colliders: { shape: 'box', halfExtents: [0.05, 0.5, 0.05], mass: 2 },
    }),
    lower = physics.addBody(null, { position: [0.5, -1.6, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } }),
    multibody = physics.addMultibody(pivot, [
      { body: upper, joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, -0.5, 0], anchorB: [0, 0.5, 0] } },
      {
        body: lower,
        parent: upper,
        joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, -0.5, 0], anchorB: [-0.5, 0.1, 0] },
      },
    ]);
  multibody.links[1].joint.setArmature(0.2);
  const m = multibody.massMatrix(),
    inv = multibody.inverseMassMatrix(),
    d = multibody.dofInverseInertia();
  for (let i = 0; i < 2; i++)
    for (let j = 0; j < 2; j++) {
      const product = m[i][0] * inv[0][j] + m[i][1] * inv[1][j];
      assert.ok(Math.abs(product - (i === j ? 1 : 0)) < 1e-9, `(M M^-1)[${i}][${j}] = ${product}`);
    }
  assert.deepEqual(d, [inv[0][0], inv[1][1]]);
  // Column j is the acceleration a unit torque on joint j gives with the other free.
  const a = multibody.forwardDynamics([0, 1]);
  assert.ok(Math.abs(a[0] - inv[0][1]) < 1e-9 && Math.abs(a[1] - inv[1][1]) < 1e-9);
  physics.dispose();
});

test('armature is checked, and a ball joint takes it on all three turns or one', () => {
  const physics = new Physics(null),
    a = physics.addBody(null, { type: 'fixed' }),
    b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.1, mass: 1 } }),
    ball = physics.addJoint(a, b, { type: 'spherical' }),
    weld = physics.addJoint(a, b, { type: 'fixed' });
  ball.setArmature(0.1);
  assert.deepEqual(
    ['angX', 'angY', 'angZ'].map((dof) => ball.armature(dof)),
    [0.1, 0.1, 0.1].map(Math.fround),
  );
  ball.setArmature(0.4, 'angY');
  assert.equal(ball.armature('angY'), Math.fround(0.4));
  assert.throws(() => ball.setArmature(-1), { code: 'unsupported' });
  assert.throws(() => ball.setArmature(Number.NaN), { code: 'unsupported' });
  assert.throws(() => ball.setArmature(1, 'linX'), { code: 'unsupported' });
  assert.throws(() => weld.setArmature(1), { code: 'unsupported' });
  physics.dispose();
});
