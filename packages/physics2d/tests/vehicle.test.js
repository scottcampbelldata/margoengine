// The 2D ray cast vehicle (Rapier's DynamicRayCastVehicleController seen from the side): the suspension carries the
// chassis's weight, the engine drives it, the brake stops it, a wheel in the air carries nothing, the wheels push back on a
// dynamic body they stand on, and the answers are the same in pixels as in metres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';
import { Vehicle2D } from '../dist/vehicle.js';

await Physics2D.load();

/** A 2 m by 0.5 m car of 800 kg on two wheels over flat ground whose top is at y 0.5 m (y is down); `u` world units a metre. */
const car = ({ u = 1, ground = 'fixed', groundReaction, high = false } = {}) => {
  const physics = new Physics2D(null, { pixelsPerMeter: u });
  let plank = null;
  if (ground === 'fixed')
    physics.addBody(null, {
      type: 'fixed',
      position: [0, 1 * u],
      colliders: { shape: 'box', width: 400 * u, height: 1 * u },
    });
  else {
    physics.addBody(null, {
      type: 'fixed',
      position: [0, 2 * u],
      colliders: { shape: 'box', width: 400 * u, height: 1 * u, friction: 0 },
    });
    plank = physics.addBody(null, {
      position: [0, 1 * u],
      canSleep: false,
      colliders: { shape: 'box', width: 20 * u, height: 1 * u, friction: 0, mass: 400 },
    });
  }
  const chassis = physics.addBody(null, {
    position: [0, (high ? -20 : -0.2) * u],
    canSleep: false,
    colliders: { shape: 'box', width: 2 * u, height: 0.5 * u, mass: 800 },
  });
  // A stiffer spring than Rapier's default 5.88 with dampers to match it (a damping ratio near 0.45), so the car settles.
  const wheel = (x) => ({
    position: [x * u, 0.25 * u],
    radius: 0.3 * u,
    suspensionRestLength: 0.3 * u,
    suspensionStiffness: 40,
    suspensionCompression: 4,
    suspensionRelaxation: 4,
  });
  const vehicle = new Vehicle2D(physics, chassis, { wheels: [wheel(-0.8), wheel(0.8)], groundReaction });
  const run = (seconds) => {
    for (let i = 0; i < Math.round(seconds * 60); i++) physics.step();
  };
  return { physics, chassis, vehicle, plank, run };
};

test('the suspension carries the chassis at rest: the wheels hold its weight between them and it does not move', () => {
  const { physics, chassis, vehicle, run } = car();
  run(3);
  const total = vehicle.wheel(0).suspensionForce + vehicle.wheel(1).suspensionForce;
  assert.ok(Math.abs(total - 800 * 9.81) < 0.03 * 800 * 9.81, `the springs hold ${total} N of ${800 * 9.81}`);
  for (const i of [0, 1]) {
    const w = vehicle.wheel(i);
    assert.equal(w.inContact, true);
    assert.ok(w.suspensionLength > 0 && w.suspensionLength < 0.3, `wheel ${i} length ${w.suspensionLength}`);
    assert.ok(
      Math.abs(w.contactPoint[1] - 0.5) < 1e-3 && Math.abs(w.contactNormal[1] + 1) < 1e-6,
      `${w.contactPoint} ${w.contactNormal}`,
    );
  }
  assert.ok(Math.hypot(...chassis.linearVelocity) < 0.01, `still moving at ${chassis.linearVelocity}`);
  physics.dispose();
});

test('throttle drives the car forward and the wheels turn with the road; the brake stops it', () => {
  const { physics, chassis, vehicle, run } = car();
  run(1);
  const start = chassis.position[0];
  vehicle.setInput({ throttle: 1 });
  run(2);
  assert.ok(vehicle.speed > 2, `speed ${vehicle.speed} m/s after 2 s at full throttle`);
  const travelled = chassis.position[0] - start;
  assert.ok(
    Math.abs(vehicle.wheel(0).rotation - travelled / 0.3) < 0.1 * (travelled / 0.3),
    `rotation ${vehicle.wheel(0).rotation} for ${travelled} m`,
  );
  assert.ok(vehicle.wheel(0).forwardImpulse > 0);
  // Half brake, 0.6 g: full brake (1.2 g on this short car) moves enough load forward to bottom the front spring and pitch it.
  vehicle.setInput({ brake: 0.5 });
  run(3);
  assert.ok(Math.abs(vehicle.speed) < 0.05, `still at ${vehicle.speed} m/s after braking`);
  assert.ok(Math.abs(chassis.rotation) < 0.05, `pitched to ${chassis.rotation} rad`);
  physics.dispose();
});

test('a wheel in the air carries nothing and reports no contact', () => {
  const { physics, vehicle } = car({ high: true });
  physics.step();
  const w = vehicle.wheel(0);
  assert.equal(w.inContact, false);
  assert.equal(w.suspensionForce, 0);
  assert.equal(w.contactPoint, null);
  assert.equal(w.ground, null);
  assert.ok(Math.abs(w.suspensionLength - 0.3) < 1e-9);
  physics.dispose();
});

test('the wheels push back on a dynamic body they stand on, unless groundReaction is off', () => {
  const drift = (groundReaction) => {
    const { physics, vehicle, plank, run } = car({ ground: 'plank', groundReaction });
    run(1);
    vehicle.setInput({ throttle: 1 });
    run(1);
    const vx = plank.linearVelocity[0];
    physics.dispose();
    return vx;
  };
  assert.ok(drift(true) < -0.5, `the plank moved at ${drift(true)} m/s`);
  assert.ok(Math.abs(drift(false)) < 0.01, `the plank moved at ${drift(false)} m/s with groundReaction off`);
});

test('the same car in pixels gives the same answers scaled', () => {
  const metres = car(),
    pixels = car({ u: 100 });
  for (const c of [metres, pixels]) {
    c.run(1);
    c.vehicle.setInput({ throttle: 0.5 });
    c.run(1);
  }
  assert.ok(
    Math.abs(pixels.vehicle.speed / 100 - metres.vehicle.speed) < 1e-3 * metres.vehicle.speed,
    `${pixels.vehicle.speed} px/s, ${metres.vehicle.speed} m/s`,
  );
  assert.ok(Math.abs(pixels.vehicle.wheel(1).suspensionLength / 100 - metres.vehicle.wheel(1).suspensionLength) < 1e-4);
  metres.physics.dispose();
  pixels.physics.dispose();
});

test('a disposed vehicle drives no more, and bad wheels are refused with the fix', () => {
  const { physics, chassis, vehicle, run } = car();
  run(1);
  vehicle.dispose();
  vehicle.engineForce = 5000;
  run(1);
  assert.ok(Math.abs(chassis.linearVelocity[0]) < 1e-3);
  assert.throws(() => new Vehicle2D(physics, chassis, { wheels: [] }), /at least one wheel/);
  assert.throws(() => new Vehicle2D(physics, chassis, { wheels: [{ position: [0, 0], radius: 0 }] }), RangeError);
  assert.throws(
    () => new Vehicle2D(physics, chassis, { wheels: [{ position: [0, 0], radius: 1, direction: [0, 0] }] }),
    RangeError,
  );
  using second = new Vehicle2D(physics, chassis, { wheels: [{ position: [0, 0], radius: 1 }] });
  assert.throws(() => second.wheel(3), RangeError);
  physics.dispose();
});

test("a body reads its moment of inertia about its centre of mass, as Rapier's principalInertia", () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 10 });
  const box = physics.addBody(null, { colliders: { shape: 'box', width: 40, height: 20, mass: 3 } });
  assert.ok(Math.abs(box.inertia - (3 * (40 * 40 + 20 * 20)) / 12) < 1e-3 * box.inertia, `inertia ${box.inertia}`);
  assert.equal(physics.addBody(null, { type: 'fixed', colliders: { shape: 'circle', radius: 5 } }).inertia, 0);
  physics.dispose();
});
