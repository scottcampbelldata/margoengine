// A tracked vehicle: springs under road wheels, belts that push the ground by their slip, and steering by driving the two belts apart.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, TrackedVehicle } from '../dist/index.js';

await Physics.load();

const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );

/** A 10,000 kg tank, hull 2.4 x 0.8 x 5 m, tracks 3.6 m long a gauge of 2 m apart, on a floor (or on a slope of `angle` radians about x). */
function tank(options = {}, angle = 0) {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    rotation: [Math.sin(-angle / 2), 0, 0, Math.cos(-angle / 2)],
    colliders: { shape: 'box', halfExtents: [200, 0.5, 200], friction: 1 },
  });
  const chassis = physics.addBody(null, {
      position: [0, 1.2 + Math.max(0, Math.sin(angle) * 0), 0],
      rotation: [Math.sin(-angle / 2), 0, 0, Math.cos(-angle / 2)],
      colliders: { shape: 'box', halfExtents: [1.2, 0.4, 2.5], mass: 10000 },
    }),
    vehicle = new TrackedVehicle(physics, chassis, {
      tracks: [-1, 1].map((x) => ({ position: [x, -0.3, 0], length: 3.6, roadWheels: 6 })),
      ...options,
    });
  for (let i = 0; i < 120; i++) physics.step();
  return { physics, chassis, vehicle };
}

test('a tank settles on its springs, which carry its weight', () => {
  const { physics, chassis, vehicle } = tank();
  const at = chassis.position[1];
  for (let i = 0; i < 60; i++) physics.step();
  near(chassis.position[1], at, 1e-3, 'at rest');
  // The springs of a four-wheeler's stiffness 30 carry the weight at g / 30 of compression: the wheels' rays reach 0.3 - 0.33 m, and the
  // hull sits 0.52 m up, the mount (0.3 m under the hull's middle) plus the suspension length.
  near(at, 0.52, 0.05, 'ride height');
  const load = [0, 1].map((i) => vehicle.track(i).load);
  near(load[0] + load[1], 10000 * 9.81, 6000, 'the springs carry the weight');
  assert.ok(vehicle.track(0).inContact === 6 && vehicle.track(1).inContact === 6, 'every road wheel is down');
  physics.dispose();
});

test('both belts forward drive the tank straight at about the belt speed, and reverse takes it back', () => {
  const { physics, chassis, vehicle } = tank();
  vehicle.setInput({ throttle: 0.5 });
  const start = chassis.position;
  for (let i = 0; i < 360; i++) physics.step();
  near(vehicle.speed, 4, 0.5, 'half of the belt speed of 8 m/s');
  assert.ok(Math.abs(chassis.position[0] - start[0]) < 0.8, `it drives straight: ${chassis.position[0]}`);
  assert.ok(Math.abs(chassis.angularVelocity[1]) < 0.05, 'without turning');
  vehicle.setInput({ throttle: -0.5 });
  for (let i = 0; i < 480; i++) physics.step();
  assert.ok(vehicle.speed < -3, `reversing: ${vehicle.speed}`);
  physics.dispose();
});

test('driving the belts against each other spins the tank on the spot, and a lead on one belt turns it in an arc', () => {
  const pivot = tank();
  pivot.vehicle.setInput({ steer: 1 });
  const start = pivot.chassis.position;
  for (let i = 0; i < 240; i++) pivot.physics.step();
  // The belts at 8 m/s and -8 m/s a gauge of 2 m apart would turn the hull at 8 rad/s kinematically; skid steering gives much less, since
  // the ground resists the turn, but the hull does turn about its middle.
  const yaw = pivot.chassis.angularVelocity[1];
  assert.ok(Math.abs(yaw) > 0.5 && Math.abs(yaw) < 8, `the hull turns: ${yaw} rad/s`);
  assert.ok(
    Math.hypot(pivot.chassis.position[0] - start[0], pivot.chassis.position[2] - start[2]) < 3,
    'about its own middle',
  );
  // Steer positive turns toward +X for a chassis facing +Z: the yaw about +Y is positive (a left-handed turn seen from above).
  assert.ok(yaw > 0, `positive steer turns toward +x: ${yaw}`);
  pivot.physics.dispose();
  const arc = tank();
  arc.vehicle.setInput({ throttle: 0.5, steer: 0.3 });
  for (let i = 0; i < 300; i++) arc.physics.step();
  const yawArc = arc.chassis.angularVelocity[1],
    speed = arc.vehicle.speed;
  assert.ok(yawArc > 0.05 && speed > 2, `an arc: yaw ${yawArc}, speed ${speed}`);
  arc.physics.dispose();
});

test('a tank climbs a slope its tracks can grip and holds on one with the belts stopped', () => {
  const angle = (20 * Math.PI) / 180,
    { physics, chassis, vehicle } = tank({}, angle);
  const climbed = () => {
    const f = [0, Math.sin(angle), Math.cos(angle)],
      p = chassis.position;
    return p[1] * f[1] + p[2] * f[2];
  };
  const before = climbed();
  vehicle.setInput({ throttle: 0.4 });
  for (let i = 0; i < 360; i++) physics.step();
  assert.ok(climbed() > before + 5, `it climbed ${climbed() - before} m`);
  vehicle.setInput({ throttle: 0 });
  for (let i = 0; i < 120; i++) physics.step();
  const held = climbed();
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(
    Math.abs(climbed() - held) < 0.6,
    `on the slope with the belts still it moves ${climbed() - held} m in three seconds`,
  );
  physics.dispose();
});

test('a tank refuses what makes no sense, and a disposed one lets go', () => {
  const physics = new Physics(null),
    chassis = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.4, 2], mass: 1000 } });
  assert.throws(() => new TrackedVehicle(physics, chassis, { tracks: [] }), /at least one track/);
  assert.throws(() => new TrackedVehicle(physics, chassis, { tracks: [{ position: [0, 0, 0], length: 0 }] }), /length/);
  assert.throws(
    () => new TrackedVehicle(physics, chassis, { tracks: [{ position: [0, 0, 0], length: 2, roadWheels: 1 }] }),
    /road wheels/,
  );
  assert.throws(
    () => new TrackedVehicle(physics, chassis, { tracks: [{ position: [0, 0, 0], length: 2 }], maxSpeed: 0 }),
    /maxSpeed/,
  );
  const fixed = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', halfExtents: [1, 1, 1] } });
  assert.throws(() => new TrackedVehicle(physics, fixed, { tracks: [{ position: [0, 0, 0], length: 2 }] }), /dynamic/);
  const vehicle = new TrackedVehicle(physics, chassis, { tracks: [{ position: [0, 0, 0], length: 2 }] });
  assert.throws(() => vehicle.track(3), RangeError);
  vehicle.dispose();
  assert.equal(vehicle.valid, false);
  physics.dispose();
});
