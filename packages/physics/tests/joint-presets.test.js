// The universal joint and the wheel joint, built from the generic joint.
import assert from 'node:assert/strict';
import test from 'node:test';
import { addUniversalJoint, addWheelJoint, Physics } from '../dist/index.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
await Physics.load();

test('a universal joint swings about two axes and holds the twist', () => {
  const physics = new Physics(null);
  const post = physics.addBody(null, { type: 'fixed', position: [0, 3, 0], colliders: [] });
  const shaft = physics.addBody(null, {
    position: [0.8, 3, 0],
    colliders: { shape: 'box', halfExtents: [0.8, 0.05, 0.05], mass: 2 },
  });
  addUniversalJoint(physics, post, shaft, { anchorB: [0, 0, -0.8] });
  shaft.setAngularVelocity([2, 1, 1.5]);
  let twist = 0,
    swing = 0;
  for (let i = 0; i < 180; i++) {
    physics.step();
    // The shaft's length is Z and the post's frame is the world's: the turn about Z is locked, so its spin about Z stays nothing
    // once the joint has taken the first step's spin out.
    if (i > 5) twist = Math.max(twist, Math.abs(shaft.angularVelocity[2]));
    swing = Math.max(swing, Math.abs(shaft.position[1] - 3));
  }
  assert.ok(swing > 0.3, `it swings about the X axis under gravity: ${swing}`);
  assert.ok(twist < 0.05, `it cannot twist about its length: ${twist}`);
});

test('a universal joint is limited and driven on each axis', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const post = physics.addBody(null, { type: 'fixed', colliders: [] });
  const arm = physics.addBody(null, {
    position: [1, 0, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.05, 0.05], mass: 1 },
  });
  const joint = addUniversalJoint(physics, post, arm, {
    anchorB: [-1, 0, 0],
    limitsY: [-0.5, 0.5],
    motorY: { targetVelocity: 3, damping: 20 },
  });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(joint.valid);
  const yaw = 2 * Math.asin(arm.rotation[1]);
  near(Math.abs(yaw), 0.5, 0.06, 'the motor drives the turn about Y to its limit and holds it there');
});

test('a wheel joint hangs on its spring at g over omega squared, and drives and steers', () => {
  const physics = new Physics(null);
  const chassis = physics.addBody(null, { type: 'fixed', position: [0, 2, 0], colliders: [] });
  const wheel = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.3, mass: 4 } });
  const mount = addWheelJoint(physics, chassis, wheel, { frequency: 2, damping: 1, travel: [-0.5, 0.5] });
  for (let i = 0; i < 240; i++) physics.step();
  near(2 - wheel.position[1], 9.81 / (2 * Math.PI * 2) ** 2, 0.01, 'the static sag of the suspension');
  near(wheel.position[0], 0, 1e-3, 'it does not move sideways');
  mount.drive(8);
  for (let i = 0; i < 120; i++) physics.step();
  near(wheel.angularVelocity[0], 8, 0.4, 'the drive motor spins the wheel about the axle');
  assert.throws(() => mount.steer(0.3), RangeError);
  assert.throws(() => addWheelJoint(physics, chassis, wheel, { frequency: 0 }), RangeError);
});

test('a steerable wheel hangs from a knuckle that turns about the suspension axis', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const chassis = physics.addBody(null, { type: 'fixed', position: [0, 2, 0], colliders: [] });
  const wheel = physics.addBody(null, { position: [0, 2, 0], colliders: { shape: 'sphere', radius: 0.3, mass: 4 } });
  const mount = addWheelJoint(physics, chassis, wheel, { steerable: true });
  assert.ok(mount.knuckle);
  mount.steer(0.4);
  for (let i = 0; i < 120; i++) physics.step();
  const yaw = 2 * Math.asin(wheel.rotation[1]);
  near(yaw, 0.4, 0.03, 'the wheel is turned by the steering angle about the suspension axis');
});
