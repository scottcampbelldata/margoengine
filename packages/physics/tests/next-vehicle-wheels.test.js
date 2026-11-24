// The rest of the wheel tuning and the wheel's outputs of the ray-cast vehicle, each against Rapier's controller
// (`tests/oracle.js`, as a black box) on the same car: the suspension's travel and force limit, the side friction, where a
// wheel touches and what it turned, and a chassis that faces another way.
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics, Vehicle } from '../dist/index.js';
import { Vehicle as RapierVehicle } from './oracle/dist/index.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );
const steps = (cars, count) => {
  for (let i = 0; i < count; i++) for (const { physics } of cars) physics.step();
};

/** The 1,000 kg car of next-vehicle.test.js on a 100 m floor, own and Rapier's, with `tuning` on every wheel. */
const cars = (tuning = {}) =>
  [
    [new Physics(null), Vehicle],
    [new RapierPhysics(null), RapierVehicle],
  ].map(([physics, Kind]) => {
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
    });
    const chassis = physics.addBody(null, {
      position: [0, 1, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 },
    });
    const wheels = [
      [-0.9, 1.4, true],
      [0.9, 1.4, true],
      [-0.9, -1.4, false],
      [0.9, -1.4, false],
    ].map(([x, z, steer]) => ({
      position: [x, -0.1, z],
      radius: 0.35,
      suspensionRestLength: 0.3,
      suspensionStiffness: 30,
      suspensionCompression: 4,
      suspensionRelaxation: 5,
      frictionSlip: 2,
      steer,
      ...tuning,
    }));
    return { physics, chassis, vehicle: new Kind(physics, chassis, { wheels }) };
  });

test('maxSuspensionForce caps what a spring pushes: the car sinks onto a lower ride, as on Rapier', () => {
  const free = cars(),
    capped = cars({ maxSuspensionForce: 1500 });
  steps(free, 90);
  steps(capped, 90);
  for (const [name, a, b] of [
    ['own', free[0], capped[0]],
    ['Rapier', free[1], capped[1]],
  ]) {
    assert.ok(
      b.chassis.position[1] < a.chassis.position[1] - 0.2,
      `${name}: the car sits lower (${b.chassis.position[1]} against ${a.chassis.position[1]})`,
    );
    assert.ok(b.chassis.position[1] < 0.3, `${name}: it settles on its own body, a quarter of a metre up`);
  }
  // Four springs of 1,500 N carry 6,000 of the 9,810 N: the own solver reports each at its cap.
  for (let i = 0; i < 4; i++) near(capped[0].vehicle.wheel(i).suspensionForce, 1500, 1, `spring ${i}`);
  for (let i = 0; i < 4; i++)
    near(
      free[0].vehicle.wheel(i).suspensionForce,
      (1000 * 9.81) / 4,
      60,
      `an uncapped spring ${i} carries a quarter of the weight`,
    );
  near(capped[0].chassis.position[1], capped[1].chassis.position[1], 0.05, "as low as Rapier's");
});

test('maxSuspensionTravel limits how far a spring compresses, as on Rapier', () => {
  const free = cars(),
    short = cars({ maxSuspensionTravel: 0.03 });
  steps(free, 90);
  steps(short, 90);
  for (const [name, a, b] of [
    ['own', free[0], short[0]],
    ['Rapier', free[1], short[1]],
  ]) {
    // Compression is the rest length less the length: a spring that may not travel more than 3 cm cannot be pressed past that.
    for (let i = 0; i < 4; i++)
      assert.ok(
        0.3 - b.vehicle.wheel(i).suspensionLength <= 0.03 + 1e-3,
        `${name}: spring ${i} compressed ${0.3 - b.vehicle.wheel(i).suspensionLength}`,
      );
    assert.ok(0.3 - a.vehicle.wheel(0).suspensionLength > 0.03, `${name}: free springs compress further than that`);
  }
  near(short[0].chassis.position[1], short[1].chassis.position[1], 0.05, "the same ride height as Rapier's");
});

test('sideFrictionStiffness scales the grip against a slide: none lets a car glide sideways, as on Rapier', () => {
  const slide = (stiffness) => {
    const list = cars({ sideFrictionStiffness: stiffness });
    steps(list, 60);
    for (const { chassis } of list) chassis.setLinearVelocity([5, 0, 0]);
    steps(list, 60);
    return list.map(({ chassis }) => chassis.linearVelocity[0]);
  };
  const [gripOwn, gripRapier] = slide(1),
    [glideOwn, glideRapier] = slide(0);
  assert.ok(gripOwn < 2 && gripRapier < 2, `grip stops the slide: ${gripOwn}, ${gripRapier}`);
  assert.ok(glideOwn > 4 && glideRapier > 4, `no side friction keeps it: ${glideOwn}, ${glideRapier}`);
});

test('a wheel reports where it touches, the surface normal and how far it has turned, as Rapier does', () => {
  const list = cars();
  steps(list, 60);
  for (const { vehicle } of list) vehicle.setInput({ throttle: 1 });
  steps(list, 90);
  const [own, rapier] = list;
  for (const { vehicle } of list) {
    const w = vehicle.wheel(2);
    assert.ok(w.inContact);
    near(w.contactPoint[1], 0, 1e-3, 'the point is on the floor');
    near(w.contactNormal[1], 1, 1e-3, 'and the normal points up');
    near(Math.hypot(...w.contactNormal), 1, 1e-4, 'a unit normal');
  }
  near(own.vehicle.wheel(2).contactPoint[0], -0.9, 0.05, 'under the wheel in x');
  near(own.vehicle.wheel(2).contactPoint[2], own.chassis.position[2] - 1.4, 0.1, 'and in z');
  // The wheel turns by the distance it rolled over its radius: in a second and a half, speed integrated.
  const turned = own.vehicle.wheel(2).rotation,
    rolled = rapier.vehicle.wheel(2).rotation;
  assert.ok(Math.abs(turned) > 5, `the wheel has turned (${turned} rad)`);
  near(Math.abs(turned), Math.abs(rolled), Math.abs(rolled) * 0.05, "by what Rapier's turned");
  assert.equal(Math.sign(turned), Math.sign(rolled), 'the same way');
});

test('a chassis that faces +X has its speed along +X, drives forward and steers the way up cross forward turns', () => {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [80, 0.5, 80] },
  });
  const chassis = physics.addBody(null, {
    position: [0, 1, 0],
    colliders: { shape: 'box', halfExtents: [2, 0.25, 1], mass: 1000 },
  });
  const wheels = [
    [1.4, -0.9, true],
    [1.4, 0.9, true],
    [-1.4, -0.9, false],
    [-1.4, 0.9, false],
  ].map(([x, z, steer]) => ({
    position: [x, -0.1, z],
    radius: 0.35,
    suspensionRestLength: 0.3,
    suspensionStiffness: 30,
    suspensionCompression: 4,
    suspensionRelaxation: 5,
    frictionSlip: 2,
    axle: [0, 0, 1],
    steer,
  }));
  const vehicle = new Vehicle(physics, chassis, { wheels, forward: [1, 0, 0] });
  for (let i = 0; i < 60; i++) physics.step();
  vehicle.setInput({ throttle: 1 });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(vehicle.speed > 5, `it drives forward along its +X: ${vehicle.speed}`);
  assert.ok(chassis.position[0] > 5, `and moves along +X: ${chassis.position[0]}`);
  near(vehicle.speed, chassis.linearVelocity[0], 0.2, 'the speed is the velocity along +X');
  // Steering to the left of a chassis facing +X (up x forward = (0, 1, 0) x (1, 0, 0) = -Z) turns it towards -Z.
  vehicle.setInput({ throttle: 0.5, steer: 1 });
  for (let i = 0; i < 90; i++) physics.step();
  assert.ok(chassis.position[2] < -0.3, `positive steering turns towards up x forward = -Z: z ${chassis.position[2]}`);
  physics.dispose();
});
