// A tracked vehicle: springs under road wheels, belts that push the ground by their slip, and steering by driving the two belts apart.
import assert from "node:assert/strict";
import test from "node:test";
import { Physics, TrackedVehicle, shearShare } from "../dist/index.js";

await Physics.load();

const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? "value"}: ${actual} is not within ${bound} of ${expected}`,
  );

/** A 10,000 kg tank, hull 2.4 x 0.8 x 5 m, tracks 3.6 m long a gauge of 2 m apart, on a floor (or on a slope of `angle` radians about x). */
function tank(options = {}, angle = 0) {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: "fixed",
    position: [0, -0.5, 0],
    rotation: [Math.sin(-angle / 2), 0, 0, Math.cos(-angle / 2)],
    colliders: { shape: "box", halfExtents: [200, 0.5, 200], friction: 1 },
  });
  const chassis = physics.addBody(null, {
      position: [0, 1.2 + Math.max(0, Math.sin(angle) * 0), 0],
      rotation: [Math.sin(-angle / 2), 0, 0, Math.cos(-angle / 2)],
      colliders: { shape: "box", halfExtents: [1.2, 0.4, 2.5], mass: 10000 },
    }),
    vehicle = new TrackedVehicle(physics, chassis, {
      tracks: [-1, 1].map((x) => ({
        position: [x, -0.3, 0],
        length: 3.6,
        roadWheels: 6,
      })),
      ...options,
    });
  for (let i = 0; i < 120; i++) physics.step();
  return { physics, chassis, vehicle };
}

test("a tank settles on its springs, which carry its weight", () => {
  const { physics, chassis, vehicle } = tank();
  const at = chassis.position[1];
  for (let i = 0; i < 60; i++) physics.step();
  near(chassis.position[1], at, 1e-3, "at rest");
  // The springs of a four-wheeler's stiffness 30 carry the weight at g / 30 of compression: the wheels' rays reach 0.3 - 0.33 m, and the
  // hull sits 0.52 m up, the mount (0.3 m under the hull's middle) plus the suspension length.
  near(at, 0.52, 0.05, "ride height");
  const load = [0, 1].map((i) => vehicle.track(i).load);
  near(load[0] + load[1], 10000 * 9.81, 6000, "the springs carry the weight");
  assert.ok(
    vehicle.track(0).inContact === 6 && vehicle.track(1).inContact === 6,
    "every road wheel is down",
  );
  physics.dispose();
});

test("both belts forward drive the tank straight at about the belt speed, and reverse takes it back", () => {
  const { physics, chassis, vehicle } = tank();
  vehicle.setInput({ throttle: 0.5 });
  const start = chassis.position;
  for (let i = 0; i < 360; i++) physics.step();
  near(vehicle.speed, 4, 0.5, "half of the belt speed of 8 m/s");
  assert.ok(
    Math.abs(chassis.position[0] - start[0]) < 0.8,
    `it drives straight: ${chassis.position[0]}`,
  );
  assert.ok(Math.abs(chassis.angularVelocity[1]) < 0.05, "without turning");
  vehicle.setInput({ throttle: -0.5 });
  for (let i = 0; i < 480; i++) physics.step();
  assert.ok(vehicle.speed < -3, `reversing: ${vehicle.speed}`);
  physics.dispose();
});

test("driving the belts against each other spins the tank on the spot, and a lead on one belt turns it in an arc", () => {
  const pivot = tank();
  pivot.vehicle.setInput({ steer: 1 });
  const start = pivot.chassis.position;
  for (let i = 0; i < 240; i++) pivot.physics.step();
  // The belts at 8 m/s and -8 m/s a gauge of 2 m apart would turn the hull at 8 rad/s kinematically; skid steering gives much less, since
  // the ground resists the turn, but the hull does turn about its middle.
  const yaw = pivot.chassis.angularVelocity[1];
  assert.ok(
    Math.abs(yaw) > 0.5 && Math.abs(yaw) < 8,
    `the hull turns: ${yaw} rad/s`,
  );
  assert.ok(
    Math.hypot(
      pivot.chassis.position[0] - start[0],
      pivot.chassis.position[2] - start[2],
    ) < 3,
    "about its own middle",
  );
  // Steer positive turns toward +X for a chassis facing +Z: the yaw about +Y is positive (a left-handed turn seen from above).
  assert.ok(yaw > 0, `positive steer turns toward +x: ${yaw}`);
  pivot.physics.dispose();
  const arc = tank();
  arc.vehicle.setInput({ throttle: 0.5, steer: 0.3 });
  for (let i = 0; i < 300; i++) arc.physics.step();
  const yawArc = arc.chassis.angularVelocity[1],
    speed = arc.vehicle.speed;
  assert.ok(
    yawArc > 0.05 && speed > 2,
    `an arc: yaw ${yawArc}, speed ${speed}`,
  );
  arc.physics.dispose();
});

test("a tank climbs a slope its tracks can grip and holds on one with the belts stopped", () => {
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

// Every refusal is a coded MargoError linking the vehicles help entry (KB-PHYS-TRACKEDERR1).
const coded = (pattern) => (error) =>
  error.name === "MargoError" &&
  error.code === "unsupported" &&
  pattern.test(error.message) &&
  error.message.includes("margoengine.com/errors#vehicles");

test("a tank refuses what makes no sense, and a disposed one lets go", () => {
  const physics = new Physics(null),
    chassis = physics.addBody(null, {
      colliders: { shape: "box", halfExtents: [1, 0.4, 2], mass: 1000 },
    });
  assert.throws(
    () => new TrackedVehicle(physics, chassis, { tracks: [] }),
    coded(/at least one track/),
  );
  assert.throws(
    () =>
      new TrackedVehicle(physics, chassis, {
        tracks: [{ position: [0, 0, 0], length: 0 }],
      }),
    coded(/length/),
  );
  assert.throws(
    () =>
      new TrackedVehicle(physics, chassis, {
        tracks: [{ position: [0, 0, 0], length: 2, roadWheels: 1 }],
      }),
    coded(/road wheels/),
  );
  assert.throws(
    () =>
      new TrackedVehicle(physics, chassis, {
        tracks: [{ position: [0, 0, 0], length: 2 }],
        maxSpeed: 0,
      }),
    coded(/maxSpeed/),
  );
  const fixed = physics.addBody(null, {
    type: "fixed",
    colliders: { shape: "box", halfExtents: [1, 1, 1] },
  });
  assert.throws(
    () =>
      new TrackedVehicle(physics, fixed, {
        tracks: [{ position: [0, 0, 0], length: 2 }],
      }),
    coded(/dynamic/),
  );
  const vehicle = new TrackedVehicle(physics, chassis, {
    tracks: [{ position: [0, 0, 0], length: 2 }],
  });
  assert.throws(() => vehicle.track(3), coded(/Track index/));
  assert.throws(() => vehicle.setInput({ throttle: NaN }), coded(/finite/));
  assert.throws(
    () =>
      new TrackedVehicle(physics, chassis, {
        tracks: [{ position: [0, NaN, 0], length: 2 }],
      }),
    coded(/Track position/),
  );
  vehicle.dispose();
  assert.equal(vehicle.valid, false);
  physics.dispose();
});

test("the shear curve is 0 at no displacement, 63.2 percent at the shear modulus and 1 far out", () => {
  assert.equal(shearShare(0, 0.025), 0);
  near(shearShare(0.025, 0.025), 1 - Math.exp(-1), 1e-12, "at j = K");
  near(shearShare(0.025, 0.025), 0.632, 5e-4, "about 63 percent at j = K");
  near(
    shearShare(-0.05, 0.025),
    1 - Math.exp(-2),
    1e-12,
    "the displacement counts by its size",
  );
  near(shearShare(1, 0.025), 1, 1e-12, "saturated far out");
  assert.throws(() => shearShare(1, 0), coded(/modulus/));
});

test("a sliding tank with its belts stopped is held back by friction along it and across it in the ratio of the two coefficients", () => {
  const lost = (velocity) => {
    const { physics, chassis } = tank({
      longitudinalFriction: 0.8,
      lateralFriction: 0.4,
    });
    chassis.setLinearVelocity(velocity, true);
    for (let i = 0; i < 12; i++) physics.step();
    const speed = Math.hypot(...chassis.linearVelocity);
    physics.dispose();
    return 3 - speed;
  };
  // 0.2 s at a few m/s: the shear is at its friction after a few centimetres of slide, so the loss is the friction times g times the time.
  const along = lost([0, 0, 3]),
    across = lost([3, 0, 0]);
  near(
    along / across,
    2,
    0.25,
    "the loss along the belt is twice that across it",
  );
  near(along, 0.8 * 9.81 * 0.2, 0.4, "the loss along the belt is mu g t");
});

test("a belt changes its speed by no more than its acceleration a second", () => {
  const { physics, vehicle } = tank({ trackAcceleration: 6 });
  vehicle.setInput({ throttle: 1 });
  let last = 0;
  for (let i = 0; i < 60; i++) {
    physics.step();
    const speed = vehicle.track(0).speed;
    assert.ok(
      speed - last <= 6 / 60 + 1e-9,
      `step ${i}: the belt gained ${speed - last}`,
    );
    last = speed;
  }
  near(last, 6, 0.01, "after a second at 6 m/s squared");
  physics.dispose();
});
