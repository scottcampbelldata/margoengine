// A joint's own API: user data, an enabled switch, the force it carried, anchors and frames set after creation, and a flip.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { RAPIER, RapierPhysics } from './oracle.js';

const G = 9.81;
const near = (actual, expected) =>
  assert.ok(
    actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6),
    `${actual} is not ${expected}`,
  );

function hang(options = {}, mass = 10) {
  const physics = new Physics(null);
  const anchor = physics.addBody(null, { type: 'fixed' });
  const weight = physics.addBody(null, {
    position: [0, -2, 0],
    colliders: { shape: 'sphere', radius: 0.25, mass },
  });
  const joint = physics.addJoint(anchor, weight, { type: 'spherical', anchorB: [0, 2, 0], ...options });
  return { physics, anchor, weight, joint };
}

test('a joint carries user data from its options, and setting it reads back', async () => {
  await Physics.load();
  const { physics, joint } = hang({ userData: { name: 'shoulder' } });
  assert.deepEqual(joint.userData, { name: 'shoulder' });
  joint.userData = 7;
  assert.equal(joint.userData, 7);
  const plain = hang();
  assert.equal(plain.joint.userData, undefined);
  plain.physics.dispose();
  physics.dispose();
});

test('a disabled joint solves nothing and comes back when enabled: free fall, then a held weight', async () => {
  await Physics.load();
  const { physics, weight, joint } = hang();
  assert.equal(joint.enabled, true);
  joint.enabled = false;
  assert.equal(joint.enabled, false);
  for (let i = 0; i < 30; i++) physics.step();
  const t = 30 * physics.fixedTimestep,
    fall = (G * t * t) / 2;
  assert.ok(Math.abs(weight.position[1] - (-2 - fall)) < 0.02 * fall, `free fall ${fall}: ${-2 - weight.position[1]}`);
  physics.dispose();
  // Made disabled and switched on before any step: the weight holds as if it had never been off.
  const held = hang({ enabled: false });
  assert.equal(held.joint.enabled, false);
  held.joint.enabled = true;
  for (let i = 0; i < 120; i++) held.physics.step();
  assert.ok(Math.abs(held.weight.position[1] + 2) < 0.01, `holds: ${held.weight.position[1]}`);
  held.physics.dispose();
});

test('a joint reads the force and torque it carried in the last step: a weight, a beam, a spring', async () => {
  await Physics.load();
  const w = hang();
  assert.deepEqual(w.joint.force, [0, 0, 0], 'nothing before a step');
  for (let i = 0; i < 240; i++) w.physics.step();
  // The joint holds the 10 kg weight up: 98.1 N along +y on body B, and no torque on a ball joint.
  const [fx, fy, fz] = w.joint.force;
  assert.ok(Math.abs(fy - 10 * G) < 0.5, `holds 98.1 N: ${fy}`);
  assert.ok(Math.abs(fx) < 0.5 && Math.abs(fz) < 0.5, `straight up: ${fx} ${fz}`);
  assert.ok(
    w.joint.torque.every((t) => Math.abs(t) < 0.5),
    `no torque: ${w.joint.torque}`,
  );
  w.physics.dispose();
  // A beam held level by a fixed joint: 10 kg 2 m out is 196.2 N m about the anchor.
  const physics = new Physics(null);
  const wall = physics.addBody(null, { type: 'fixed' });
  const beam = physics.addBody(null, { position: [2, 0, 0], colliders: { shape: 'sphere', radius: 0.25, mass: 10 } });
  const fixed = physics.addJoint(wall, beam, { type: 'fixed', anchorB: [-2, 0, 0] });
  for (let i = 0; i < 240; i++) physics.step();
  const torque = fixed.torque;
  assert.ok(Math.abs(Math.abs(torque[2]) - 10 * G * 2) < 2, `196.2 N m: ${torque}`);
  assert.ok(Math.abs(fixed.force[1] - 10 * G) < 0.5, `98.1 N: ${fixed.force}`);
  physics.dispose();
  // A spring stretched by its load: extension m g / k, force k times it.
  const s = hang({ type: 'spring', restLength: 1, stiffness: 200, damping: 20 }, 5);
  for (let i = 0; i < 600; i++) s.physics.step();
  assert.ok(Math.abs(s.joint.force[1] - 5 * G) < 0.5, `spring holds 49.05 N: ${s.joint.force}`);
  s.joint.remove();
  assert.throws(() => s.joint.force, { code: 'state' });
  s.physics.dispose();
});

test('anchors and frames set after creation move the joint: a weight hangs 1 m higher, a frame turns the hinge', async () => {
  await Physics.load();
  const { physics, weight, joint } = hang();
  joint.setAnchorB([0, 1, 0]);
  assert.deepEqual(joint.anchorB, [0, 1, 0]);
  joint.setAnchorA([0, 0.5, 0]);
  assert.deepEqual(joint.anchorA, [0, 0.5, 0]);
  for (let i = 0; i < 240; i++) physics.step();
  // The anchor on the wall is at y 0.5 and the weight's is 1 above its centre: the centre hangs at -0.5.
  assert.ok(Math.abs(weight.position[1] + 0.5) < 0.01, `hangs at -0.5: ${weight.position[1]}`);
  assert.throws(() => joint.setAnchorB([0, NaN, 0]), RangeError);
  physics.dispose();

  // A hinge about X lets a weight on the Z axis swing down; turn both frames so its axis is Z and the weight, on that axis, holds.
  const swing = (turn) => {
    const world = new Physics(null);
    const wall = world.addBody(null, { type: 'fixed' });
    const bar = world.addBody(null, { position: [0, 0, 1], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
    const hinge = world.addJoint(wall, bar, { type: 'revolute', axis: [1, 0, 0], anchorB: [0, 0, -1] });
    if (turn) {
      const q = [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
      hinge.setFrames(q, q);
      assert.ok(
        hinge.frameA.every((v, i) => Math.abs(v - q[i]) < 1e-6),
        `frame A reads back ${hinge.frameA}`,
      );
      assert.ok(hinge.frameB.every((v, i) => Math.abs(v - q[i]) < 1e-6));
      assert.throws(() => hinge.setFrames([0, 0, 0, 0], q), { code: 'unsupported' });
    }
    for (let i = 0; i < 30; i++) world.step();
    const y = bar.position[1];
    world.dispose();
    return y;
  };
  assert.ok(swing(false) < -0.5, 'a hinge about X lets the weight fall');
  assert.ok(Math.abs(swing(true)) < 0.01, 'turned to Z, the weight on the axis holds');
});

test('flip swaps the bodies of a hinge and mirrors its limits, and the swing follows the same path', async () => {
  await Physics.load();
  function pendulum(flipped) {
    const physics = new Physics(null);
    const wall = physics.addBody(null, { type: 'fixed' });
    const bar = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
    // The same hinge from either body: seen from the bar, the angle and so its limits read the other way round.
    const joint = flipped
      ? physics.addJoint(bar, wall, { type: 'revolute', axis: [0, 0, 1], limits: [-1.2, 0.3], anchorA: [-1, 0, 0] })
      : physics.addJoint(wall, bar, { type: 'revolute', axis: [0, 0, 1], limits: [-0.3, 1.2], anchorB: [-1, 0, 0] });
    return { physics, wall, bar, joint };
  }
  const a = pendulum(false),
    b = pendulum(true);
  b.joint.flip();
  assert.equal(b.joint.bodyA, b.wall);
  assert.equal(b.joint.bodyB, b.bar);
  near(b.joint.anchorA, [0, 0, 0]);
  near(b.joint.anchorB, [-1, 0, 0]);
  near(b.joint.limits, [-0.3, 1.2]);
  let worst = 0,
    lowest = Infinity;
  for (let i = 0; i < 240; i++) {
    a.physics.step();
    b.physics.step();
    worst = Math.max(worst, Math.abs(a.bar.position[1] - b.bar.position[1]));
    lowest = Math.min(lowest, a.bar.position[1]);
  }
  assert.ok(worst < 1e-3, `the flipped joint swings the same way: ${worst}`);
  // The bar falls and meets its stop, so the limit really acted.
  assert.ok(lowest > -0.31 && lowest < -0.28, `stopped by the -0.3 limit, sin(0.3) below: ${lowest}`);
  a.physics.dispose();
  b.physics.dispose();
});

test('flip refuses a joint it would not mirror exactly, and a removed one', async () => {
  await Physics.load();
  const { physics, joint } = hang({ type: 'cone', swing: 0.5 });
  assert.throws(() => joint.flip(), { code: 'unsupported' });
  const free = hang();
  free.joint.flip();
  assert.equal(free.joint.bodyA, free.weight);
  free.joint.remove();
  assert.throws(() => free.joint.flip(), { code: 'state' });
  free.physics.dispose();
  physics.dispose();
});

test('setting anchors after creation hangs the weight where Rapier does (the oracle, as a black box)', async () => {
  await Promise.all([Physics.load(), RapierPhysics.load()]);
  const own = hang();
  own.joint.setAnchorA([0, 0.5, 0]);
  own.joint.setAnchorB([0, 1, 0]);
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const wall = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
  const ball = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, -2, 0));
  world.createCollider(RAPIER.ColliderDesc.ball(0.25).setMass(10), ball);
  const joint = world.createImpulseJoint(
    RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 2, z: 0 }),
    wall,
    ball,
    true,
  );
  joint.setAnchor1({ x: 0, y: 0.5, z: 0 });
  joint.setAnchor2({ x: 0, y: 1, z: 0 });
  for (let i = 0; i < 240; i++) {
    own.physics.step();
    world.step();
  }
  const rapier = ball.translation().y;
  assert.ok(Math.abs(own.weight.position[1] + 0.5) < 0.005, `own hangs at -0.5: ${own.weight.position[1]}`);
  assert.ok(Math.abs(rapier - own.weight.position[1]) < 0.01, `Rapier hangs at ${rapier}`);
  own.physics.dispose();
  world.free();
});

test('the world lists its joints, and a removed one leaves the list', async () => {
  await Physics.load();
  const { physics, anchor, weight, joint } = hang();
  const second = physics.addJoint(anchor, weight, { type: 'rope', length: 5 });
  assert.equal(physics.jointCount, 2);
  assert.deepEqual(physics.getJoints(), [joint, second]);
  second.remove();
  assert.deepEqual(physics.getJoints(), [joint]);
  assert.equal(physics.jointCount, 1);
  physics.dispose();
});
