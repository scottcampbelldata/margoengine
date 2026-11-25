// Mass added as a solid: its mass, centre and inertia join the colliders' by the parallel axis theorem, in kernel and facade.
import { readFileSync } from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);
const world = () => new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
const disc = { shape: 'circle', radius: 1, mass: 2 };

test('an added solid joins the colliders by the parallel axis theorem about the combined centre', () => {
  const physics = world();
  const body = physics.addBody(null, { colliders: disc });
  // The disc: 2 kg, inertia m r^2 / 2 = 1 about its centre. The solid: 2 kg at (2, 0) with inertia 0.5 about its own centre.
  // Together: 4 kg, centre (1, 0), inertia 1 + 2 * 1^2 + 0.5 + 2 * 1^2 = 5.5.
  body.setAdditionalMassProperties(2, [2, 0], 0.5);
  near(body.mass, 4, 1e-5, 'mass');
  near(body.centerOfMass[0], 1, 1e-5, 'centre of mass');
  // A torque of 1 turns the body at 1 / 5.5 rad/s^2.
  body.applyTorque(1);
  physics.step();
  near(body.angularVelocity, 1 / 5.5 / 60, 1e-6, 'angular acceleration for a step');
  // A force through the centre of mass pushes it without turning: F / m.
  const second = physics.addBody(null, { position: [50, 0], colliders: disc });
  second.setAdditionalMassProperties(2, [2, 0], 0.5);
  second.applyForceAtPoint([0, 4], [51, 0]);
  physics.step();
  near(second.linearVelocity[1], 4 / 4 / 60, 1e-5, 'F / m through the centre');
  near(second.angularVelocity, 0, 1e-6, 'and no turn');
  // 0 takes it away.
  body.setAdditionalMassProperties(0, [0, 0], 0);
  near(body.mass, 2, 1e-5, 'back to the disc');
  assert.throws(() => body.setAdditionalMassProperties(-1), RangeError);
  assert.throws(() => body.setAdditionalMassProperties(1, [Number.NaN, 0]), RangeError);
});

test('a body with no collider takes its mass and centre from the solid alone', () => {
  const physics = world();
  const body = physics.addBody(null, {});
  body.setAdditionalMassProperties(3, [0, 1], 2);
  near(body.mass, 3, 1e-5, 'mass');
  near(body.centerOfMass[1], 1, 1e-5, 'centre');
});

test('a snapshot carries the solid', () => {
  const physics = world();
  const body = physics.addBody(null, { colliders: disc });
  body.setAdditionalMassProperties(2, [2, 0], 0.5);
  const bytes = physics.snapshot();
  body.setAdditionalMassProperties(0);
  near(body.mass, 2, 1e-5, 'solid taken off');
  physics.restore(bytes);
  near(body.mass, 4, 1e-5, 'restored mass');
});

test('a snapshot made by the version 6 kernel (no extra solid) restores and steps as it did', () => {
  // snapshot-v6.bin was made by this package's kernel as of commit 4c477469d: a fixed floor, a disc and a box joined by a motored
  // hinge, 20 steps in; snapshot-v6.json holds where the two bodies stood 60 steps later in that kernel.
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/snapshot-v6.bin', import.meta.url)));
  const later = JSON.parse(readFileSync(new URL('./fixtures/snapshot-v6.json', import.meta.url), 'utf8'));
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -9.81] });
  physics.addBody(null, { type: 'fixed', position: [0, -1], colliders: { shape: 'box', width: 40, height: 2 } });
  const a = physics.addBody(null, { position: [0, 3], colliders: { shape: 'circle', radius: 0.5, mass: 2 } });
  const b = physics.addBody(null, {
    position: [1.2, 3.6],
    colliders: { shape: 'box', width: 0.8, height: 0.6, mass: 1 },
  });
  physics.addJoint(a, b, {
    type: 'revolute',
    anchorA: [0.6, 0.3],
    anchorB: [-0.6, -0.3],
    motor: { targetVelocity: 1, factor: 2 },
  });
  physics.restore(bytes);
  for (let i = 0; i < later.stepsAfter; i++) physics.step();
  near(a.position[0], later.a[0], 1e-5, 'disc x');
  near(a.position[1], later.a[1], 1e-5, 'disc y');
  near(b.position[0], later.b[0], 1e-5, 'box x');
  near(b.position[1], later.b[1], 1e-5, 'box y');
  assert.ok(a.mass > 0 && b.mass > 0);
});

test("a maximum angular speed caps a body's spin, and the default leaves it free", () => {
  const physics = world();
  const capped = physics.addBody(null, { colliders: disc, canSleep: false });
  const free = physics.addBody(null, { position: [50, 0], colliders: disc, canSleep: false });
  capped.angularVelocity = 40;
  free.angularVelocity = 40;
  capped.maxAngularSpeed = 6;
  physics.step();
  near(capped.angularVelocity, 6, 1e-5, 'capped');
  near(free.angularVelocity, 40, 1e-5, 'free');
  assert.equal(capped.maxAngularSpeed, 6);
  assert.equal(free.maxAngularSpeed, 0);
  assert.throws(() => (capped.maxAngularSpeed = -1), RangeError);
  const bytes = physics.snapshot();
  capped.maxAngularSpeed = 0;
  physics.restore(bytes);
  assert.equal(capped.maxAngularSpeed, 6, 'a snapshot carries it');
});
