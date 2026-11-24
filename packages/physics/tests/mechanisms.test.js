// Gear, rack and pinion and pulley joints against their closed forms.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DistanceJoint, GearJoint, PathJoint, PulleyJoint, Physics, RackAndPinionJoint } from '../dist/index.js';

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} is not within ${tolerance} of ${expected}`);
await Physics.load();

const wheel = (physics, x, mass = 2) => {
  const fixed = physics.addBody(null, { type: 'fixed', position: [x, 0, 0], colliders: [] });
  const body = physics.addBody(null, { position: [x, 0, 0], colliders: { shape: 'sphere', radius: 0.4, mass } });
  physics.addJoint(fixed, body, { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: [0, 0, 0] });
  return body;
};

test('a gear turns its partner against the first at the ratio, rigid or as a soft constraint', () => {
  for (const options of [{}, { frequency: 30, damping: 1 }]) {
    const physics = new Physics(null);
    physics.gravity = [0, 0, 0];
    const a = wheel(physics, 0),
      b = wheel(physics, 1, 5);
    new GearJoint(physics, a, b, { ratio: 2, ...options });
    a.setAngularVelocity([0, 0, 2]);
    for (let i = 0; i < 120; i++) physics.step();
    // omega_a + ratio omega_b = 0: the second turns half as fast the other way, and the pair has lost no more than the gear's share.
    near(
      b.angularVelocity[2] * -2,
      a.angularVelocity[2],
      0.08,
      `the speeds keep the ratio (${JSON.stringify(options)})`,
    );
    assert.ok(b.angularVelocity[2] < -0.2, 'the second gear turns the other way');
  }
});

test('a rack and pinion moves the rack a radius a radian', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const pinion = wheel(physics, 0);
  const rail = physics.addBody(null, { type: 'fixed', position: [0, -1, 0], colliders: [] });
  const rack = physics.addBody(null, {
    position: [0, -1, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.05, 0.1], mass: 1 },
  });
  physics.addJoint(rail, rack, { type: 'prismatic', axis: [1, 0, 0], anchorA: [0, 0, 0], anchorB: [0, 0, 0] });
  new RackAndPinionJoint(physics, pinion, rack, { radius: 0.5 });
  pinion.setAngularVelocity([0, 0, 4]);
  for (let i = 0; i < 60; i++) physics.step();
  near(rack.linearVelocity[0] * -1, 0.5 * pinion.angularVelocity[2], 0.06, 'the rack moves a radius a radian');
  assert.ok(rack.position[0] < -0.2, `and it has moved: ${rack.position[0]}`);
});

test('a rigid pulley lifts the lighter body as the heavier falls, at the acceleration of an Atwood machine to within one percent', () => {
  for (const [heavyMass, lightMass] of [
    [3, 1],
    [1.5, 1],
    [10, 9],
  ]) {
    const physics = new Physics(null);
    const heavy = physics.addBody(null, {
      position: [-1, 0, 0],
      colliders: { shape: 'sphere', radius: 0.2, mass: heavyMass },
    });
    const light = physics.addBody(null, {
      position: [1, 0, 0],
      colliders: { shape: 'sphere', radius: 0.2, mass: lightMass },
    });
    new PulleyJoint(physics, heavy, light, { groundA: [-1, 3, 0], groundB: [1, 3, 0] });
    for (let i = 0; i < 30; i++) physics.step();
    const a = ((heavyMass - lightMass) / (heavyMass + lightMass)) * 9.81,
      t = 0.5;
    // A row of the kernel's solve, in every substep: the fall is a closed form to one percent whatever the masses.
    const fall = 0.5 * a * t * t;
    near(-heavy.position[1], fall, 0.01 * fall, `the heavy body falls ½ a t² (${heavyMass}:${lightMass})`);
    near(-heavy.linearVelocity[1], a * t, 0.02 * a * t + 0.005, `at a t (${heavyMass}:${lightMass})`);
    near(light.position[1], -heavy.position[1], 0.005, 'and the light one rises as far');
  }
});

test('a block and tackle (ratio 2) moves its second body half as far, at the acceleration the energy gives', () => {
  const physics = new Physics(null);
  const a = physics.addBody(null, { position: [-1, 0, 0], colliders: { shape: 'sphere', radius: 0.2, mass: 2 } });
  const b = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.2, mass: 2 } });
  new PulleyJoint(physics, a, b, { groundA: [-1, 3, 0], groundB: [1, 3, 0], ratio: 2 });
  for (let i = 0; i < 30; i++) physics.step();
  // The length on A plus twice the length on B stays: B rises half as far as A falls, and
  // a = (mA - mB / ratio) g / (mA + mB / ratio^2) from the energy of the pair.
  const accel = ((2 - 2 / 2) / (2 + 2 / 4)) * 9.81,
    fall = 0.5 * accel * 0.25;
  near(-a.position[1], fall, 0.02 * fall, 'A falls as the energy says');
  near(b.position[1], fall / 2, 0.02 * fall, 'B rises half as far');
});

test('a pulley rope goes slack when nothing pulls it and the mechanisms are checked', () => {
  const physics = new Physics(null);
  physics.gravity = [0, 0, 0];
  const a = physics.addBody(null, { position: [-1, 0, 0], colliders: { shape: 'sphere', radius: 0.2, mass: 1 } });
  const b = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.2, mass: 1 } });
  new PulleyJoint(physics, a, b, { groundA: [-1, 3, 0], groundB: [1, 3, 0] });
  a.setLinearVelocity([0, 1, 0]);
  b.setLinearVelocity([0, 1, 0]);
  for (let i = 0; i < 30; i++) physics.step();
  assert.ok(a.position[1] > 0.3, `rising toward the pulley it goes on: ${a.position[1]}`);
  assert.throws(() => new GearJoint(physics, a, b, { ratio: 0 }), RangeError);
  assert.throws(() => new GearJoint(physics, a, b, { axisA: [0, 0, 0] }), RangeError);
  assert.throws(() => new RackAndPinionJoint(physics, a, b, { radius: -1 }), RangeError);
  assert.throws(() => new PulleyJoint(physics, a, b, { groundA: [0, 0], groundB: [0, 0, 0] }), RangeError);
  assert.throws(() => new GearJoint(physics, a, b, { frequency: -1 }), RangeError);
});

test('a distance joint with a range holds a body between its least and greatest distance, rigid or soft', async () => {
  const hang = (options, steps, start = [0, -0.5, 0], velocity = [0, 0, 0]) => {
    const physics = new Physics(null);
    const post = physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: [] });
    const body = physics.addBody(null, { position: start, colliders: { shape: 'sphere', radius: 0.1, mass: 2 } });
    body.setLinearVelocity(velocity);
    new DistanceJoint(physics, post, body, options);
    for (let i = 0; i < steps; i++) physics.step();
    return Math.hypot(...body.position);
  };
  near(hang({ max: 1 }, 180), 1, 0.01, 'a rope: it hangs at the greatest distance');
  near(hang({ min: 0.5, max: 2 }, 15, [0, -1, 0]), 1 + 0.5 * 9.81 * 0.0625, 0.03, 'free inside the range');
  assert.ok(hang({ min: 1 }, 60, [0, 2, 0], [0, -6, 0]) > 0.97, 'a strut: it cannot come nearer than the least');
  const soft = hang({ max: 1, frequency: 8, damping: 1 }, 240);
  assert.ok(soft > 1 && soft < 1.25, `a soft end gives a little and holds: ${soft}`);
  const physics = new Physics(null);
  const a = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  const b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  assert.throws(() => new DistanceJoint(physics, a, b, { min: -1 }), RangeError);
  assert.throws(() => new DistanceJoint(physics, a, b, { min: 2, max: 1 }), RangeError);
});

test('a path joint holds a bead on a curve, lets it swing as a pendulum of the curve and drives it along', async () => {
  const swing = new Physics(null);
  const post = swing.addBody(null, { type: 'fixed', colliders: [] });
  // An arc of radius 1 under the post, a tenth of a radian between points.
  const arc = Array.from({ length: 13 }, (_, k) => [Math.sin((k - 6) * 0.1), -Math.cos((k - 6) * 0.1), 0]);
  const bead = swing.addBody(null, {
    position: [Math.sin(0.2), -Math.cos(0.2), 0],
    colliders: { shape: 'sphere', radius: 0.05, mass: 2 },
  });
  new PathJoint(swing, post, bead, { points: arc });
  let off = 0;
  for (let i = 1; i <= 60; i++) {
    swing.step();
    off = Math.max(off, Math.abs(Math.hypot(bead.position[0], bead.position[1]) - 1), Math.abs(bead.position[2]));
    if (i === 30) near(bead.position[0], 0, 0.05, 'at the bottom after a quarter of the period of a 1 m pendulum');
  }
  assert.ok(off < 0.004, `it stays on the curve: ${off}`);
  const rail = new Physics(null);
  rail.gravity = [0, 0, 0];
  const base = rail.addBody(null, { type: 'fixed', colliders: [] });
  const car = rail.addBody(null, {
    position: [0.2, 0, 0],
    colliders: { shape: 'box', halfExtents: [0.1, 0.1, 0.1], mass: 2 },
  });
  const track = new PathJoint(rail, base, car, {
    points: [
      [0, 0, 0],
      [2, 0, 0],
      [4, 0, 0],
    ],
    motor: { speed: 1.5, maxForce: 100 },
  });
  for (let i = 0; i < 30; i++) rail.step();
  near(car.linearVelocity[0], 1.5, 0.05, 'the motor drives it along the rail');
  track.setMotor(0, 0);
  assert.throws(() => new PathJoint(rail, base, car, { points: [[0, 0, 0]] }), RangeError);
  assert.throws(() => track.setMotor(1, -1), RangeError);
});
