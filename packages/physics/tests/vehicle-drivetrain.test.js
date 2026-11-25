// The drivetrain: an engine's torque curve, a clutch, a gearbox and differentials between the throttle and the wheels, and anti-roll bars.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Drivetrain, Physics, Vehicle, pacejkaTyre } from '../dist/index.js';

await Physics.load();

const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );

/** A 1,000 kg rear-wheel-drive car on a floor, wheels 0 and 1 in front, 2 and 3 driven. `wheel(i)` can change a wheel's options. */
function car(drivetrain, { wheel = () => ({}), friction = 0.9, ...options } = {}) {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [200, 0.5, 200], friction },
  });
  const chassis = physics.addBody(null, {
      position: [0, 1, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 },
    }),
    vehicle = new Vehicle(physics, chassis, {
      tyre: pacejkaTyre(),
      drivetrain,
      wheels: [
        [-0.9, 1.4, true],
        [0.9, 1.4, true],
        [-0.9, -1.4, false],
        [0.9, -1.4, false],
      ].map(([x, z, steer], i) => ({
        position: [x, -0.1, z],
        radius: 0.35,
        suspensionRestLength: 0.3,
        suspensionStiffness: 30,
        suspensionCompression: 4,
        suspensionRelaxation: 5,
        steer,
        ...wheel(i),
      })),
      ...options,
    });
  for (let i = 0; i < 90; i++) physics.step();
  return { physics, chassis, vehicle };
}
const rear = () => new Drivetrain({ axles: [{ wheels: [2, 3] }] });

test('an engine curve is read between its points and held past them, and a drivetrain refuses what makes no sense', () => {
  assert.throws(() => new Drivetrain({ axles: [] }), /axle/);
  assert.throws(() => new Drivetrain({ axles: [{ wheels: [2] }] }), /two wheel/);
  assert.throws(
    () =>
      new Drivetrain({
        axles: [{ wheels: [2, 3] }],
        torqueCurve: [
          [2000, 100],
          [1000, 120],
        ],
      }),
    /rpm rising/,
  );
  assert.throws(() => new Drivetrain({ axles: [{ wheels: [2, 3] }], gears: [0] }), /ratios above 0/);
  assert.throws(() => new Drivetrain({ axles: [{ wheels: [2, 3] }], idleRpm: 9000 }), /redlineRpm/);
  const idle = new Drivetrain({ axles: [{ wheels: [2, 3] }], idleRpm: 800 });
  near(idle.rpm, 800, 1e-6, 'it starts at idle');
  assert.equal(idle.gear, 1);
  idle.shiftUp();
  assert.equal(idle.gear, 2);
  idle.shiftDown();
  idle.shiftDown();
  assert.equal(idle.gear, 0, 'neutral under first');
  assert.throws(
    () =>
      new Vehicle(new Physics(null), new Physics(null).addBody(null, {}), {
        drivetrain: rear(),
        wheels: [{ position: [0, 0, 0], radius: 0.3 }],
      }),
    /state|dynamic|chassis/i,
  );
});

test('a drivetrain needs tyres on its wheels, and names wheels the vehicle has', () => {
  const physics = new Physics(null),
    chassis = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 } });
  const wheels = [0, 1, 2, 3].map((i) => ({ position: [i % 2 ? 0.9 : -0.9, -0.1, i < 2 ? 1.4 : -1.4], radius: 0.35 }));
  assert.throws(() => new Vehicle(physics, chassis, { drivetrain: rear(), wheels }), /tyre model/);
  assert.throws(
    () =>
      new Vehicle(physics, chassis, {
        drivetrain: new Drivetrain({ axles: [{ wheels: [8, 9] }] }),
        tyre: pacejkaTyre(),
        wheels,
      }),
    /wheel 8/,
  );
  assert.throws(
    () => new Vehicle(physics, chassis, { antiRollBars: [{ wheels: [0, 0], stiffness: 100 }], wheels }),
    /two different wheels/,
  );
  assert.throws(
    () => new Vehicle(physics, chassis, { antiRollBars: [{ wheels: [0, 1], stiffness: -1 }], wheels }),
    /stiffness/,
  );
  physics.dispose();
});

test('a launch in first gear pushes the car with the engine torque times the gearing over the wheel radius', () => {
  const { physics, chassis, vehicle } = car(rear());
  vehicle.setInput({ throttle: 0.4 });
  const start = chassis.position[2];
  let early = 0;
  for (let i = 0; i < 60; i++) {
    physics.step();
    if (i === 20) early = vehicle.speed;
  }
  // At 40 percent throttle the engine gives about 0.4 x 120 N m near idle; through 3.6 x 3.7 at 0.9 and over 0.35 m that is 1.6 kN on a car
  // of 1,000 kg: 1.6 m/s squared, the clutch slipping while the wheels are slow, and more as the revs and the torque rise.
  assert.ok(early > 0.4, `moving after a third of a second: ${early}`);
  assert.ok(vehicle.speed > 1.0 && vehicle.speed < 3.5, `speed after a second: ${vehicle.speed}`);
  assert.ok(chassis.position[2] > start + 0.5);
  assert.ok(
    vehicle.drivetrain.rpm > 700 && vehicle.drivetrain.rpm < 6800,
    `the engine turns at ${vehicle.drivetrain.rpm} rpm`,
  );
  physics.dispose();
});

test('an automatic gearbox climbs through its gears with the speed and holds the engine under its redline', () => {
  const { physics, vehicle } = car(rear());
  vehicle.setInput({ throttle: 1 });
  const gears = new Set();
  let highest = 0;
  for (let i = 0; i < 900; i++) {
    physics.step();
    gears.add(vehicle.drivetrain.gear);
    highest = Math.max(highest, vehicle.drivetrain.rpm);
  }
  assert.ok(gears.has(1) && gears.has(2) && gears.has(3), `it shifted up: ${[...gears]}`);
  assert.ok(vehicle.drivetrain.gear >= 3, `in gear ${vehicle.drivetrain.gear} at ${vehicle.speed} m/s`);
  assert.ok(vehicle.speed > 18, `fifteen seconds at full throttle: ${vehicle.speed} m/s`);
  assert.ok(highest <= 6800 * 1.05 + 1, `the revs stay at the limiter: ${highest}`);
  physics.dispose();
});

test('with the clutch pedal down the engine revs on its own and the car does not drive, and letting it up takes the car away', () => {
  const { physics, vehicle } = car(rear());
  vehicle.setInput({ throttle: 1, clutch: 1 });
  for (let i = 0; i < 90; i++) physics.step();
  assert.ok(Math.abs(vehicle.speed) < 0.3, `the car sits: ${vehicle.speed}`);
  assert.ok(vehicle.drivetrain.rpm > 5500, `the engine revved: ${vehicle.drivetrain.rpm}`);
  vehicle.setInput({ throttle: 1, clutch: 0 });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(vehicle.speed > 3, `it drives off: ${vehicle.speed}`);
  physics.dispose();
});

test('reverse takes the car backwards from a standstill, and neutral gives it no drive', () => {
  const reverse = car(rear());
  reverse.vehicle.setInput({ throttle: -0.5 });
  for (let i = 0; i < 120; i++) reverse.physics.step();
  assert.equal(reverse.vehicle.drivetrain.gear, -1);
  assert.ok(reverse.vehicle.speed < -1, `backing: ${reverse.vehicle.speed}`);
  reverse.physics.dispose();
  const neutral = car(rear());
  neutral.vehicle.drivetrain.gear = 0;
  neutral.vehicle.setInput({ throttle: 1 });
  for (let i = 0; i < 90; i++) neutral.physics.step();
  assert.ok(Math.abs(neutral.vehicle.speed) < 0.2, `in neutral: ${neutral.vehicle.speed}`);
  neutral.physics.dispose();
});

test('on ice under one wheel an open differential spins it, and a locked or a limited-slip one takes the car away', () => {
  const ice = (i) => (i === 2 ? { tyre: pacejkaTyre({ longitudinal: { D: 0.08 }, lateral: { D: 0.08 } }) } : {});
  const run = (differential) => {
    const { physics, vehicle } = car(new Drivetrain({ axles: [{ wheels: [2, 3], differential }], automatic: false }), {
      wheel: ice,
    });
    vehicle.setInput({ throttle: 0.7 });
    for (let i = 0; i < 180; i++) physics.step();
    const result = { speed: vehicle.speed, iceSpin: vehicle.wheel(2).spin, gripSpin: vehicle.wheel(3).spin };
    physics.dispose();
    return result;
  };
  const open = run({ type: 'open' }),
    locked = run({ type: 'locked' }),
    limited = run({ type: 'limitedSlip', preload: 400, bias: 1 });
  assert.ok(open.speed < 4, `an open differential is held by the wheel on ice: ${open.speed}`);
  assert.ok(
    open.iceSpin > 3 * Math.max(open.gripSpin, 1),
    `and the ice wheel spins: ${open.iceSpin} against ${open.gripSpin}`,
  );
  assert.ok(
    locked.speed > open.speed * 1.8 && locked.speed > 4,
    `a locked one drives both: ${locked.speed} against ${open.speed}`,
  );
  assert.ok(
    limited.speed > open.speed * 1.3,
    `a limited-slip one drives more than an open one: ${limited.speed} against ${open.speed}`,
  );
  assert.ok(
    limited.speed <= locked.speed + 0.5,
    `and no more than a locked one: ${limited.speed} against ${locked.speed}`,
  );
});

test('a four-wheel drive through a centre differential drives every wheel', () => {
  const four = new Drivetrain({
    axles: [{ wheels: [0, 1] }, { wheels: [2, 3] }],
    center: { type: 'limitedSlip', split: 0.4 },
  });
  const { physics, vehicle } = car(four);
  vehicle.setInput({ throttle: 0.5 });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(vehicle.speed > 2.5, `speed ${vehicle.speed}`);
  for (const i of [0, 1, 2, 3]) assert.ok(vehicle.wheel(i).spin > 3, `wheel ${i} turns: ${vehicle.wheel(i).spin}`);
  physics.dispose();
});

test('anti-roll bars resist the roll of a car in a bend', () => {
  const roll = (bars) => {
    const { physics, chassis, vehicle } = car(undefined, {
      tyre: pacejkaTyre(),
      antiRollBars: bars,
      wheel: () => ({ suspensionStiffness: 20, rollInfluence: 0.4 }),
    });
    chassis.setLinearVelocity([0, 0, 15]);
    vehicle.steering = 0.12;
    let worst = 0;
    for (let i = 0; i < 240; i++) {
      physics.step();
      if (i > 90) {
        const q = chassis.rotation,
          // The tilt of the chassis's up axis from the world's, from its quaternion.
          up = [2 * (q[0] * q[1] - q[3] * q[2]), 1 - 2 * (q[0] * q[0] + q[2] * q[2]), 2 * (q[1] * q[2] + q[3] * q[0])];
        worst = Math.max(worst, Math.acos(Math.min(1, up[1])));
      }
    }
    physics.dispose();
    return worst;
  };
  const none = roll([]),
    barred = roll([
      { wheels: [0, 1], stiffness: 30000 },
      { wheels: [2, 3], stiffness: 30000 },
    ]);
  assert.ok(none > 0.02, `the car rolls without bars: ${none} rad`);
  assert.ok(barred < none * 0.8, `bars cut the roll: ${barred} against ${none}`);
});

/** Four driven wheels turning at `spin` rad/s, 1 kg m squared each. */
const wheels = (n, spin) => Array.from({ length: n }, () => ({ spin, inertia: 1 }));

test('a centre differential with a split of 0.4 sends 0.4 of the torque to the first axle and 0.6 to the second', () => {
  const drive = new Drivetrain({ axles: [{ wheels: [0, 1] }, { wheels: [2, 3] }], center: { split: 0.4 } });
  drive.pedals(1, 0);
  let torques = [];
  for (let i = 0; i < 10; i++) torques = drive.step(1 / 60, wheels(4, 20));
  const first = torques[0] + torques[1],
    second = torques[2] + torques[3];
  assert.ok(first > 0 && second > 0, 'both axles are driven');
  near(first / (first + second), 0.4, 1e-9, "the first axle's share");
  near(torques[0], torques[1], 1e-9, 'each axle splits evenly between its wheels when they turn alike');
});

test('a clutch that slips carries no more than its torque, whatever the pedal', () => {
  for (const pedal of [0, 0.2, 0.5, 0.8, 0.95]) {
    const drive = new Drivetrain({ axles: [{ wheels: [2, 3] }], efficiency: 0.9 }),
      capacity = 320 * (1 - pedal),
      limit = capacity * Math.abs(drive.ratio) * 0.9;
    drive.pedals(1, pedal);
    for (let i = 0; i < 120; i++) {
      const torques = drive.step(1 / 60, wheels(2, i / 20)),
        total = torques[0] + torques[1];
      assert.ok(
        total <= limit * (1 + 1e-9) + 1e-9,
        `pedal ${pedal}, step ${i}: ${total} N m at the wheels over ${limit}`,
      );
    }
  }
});

test('the automatic gearbox does not hunt: it refuses limits that would shift up and straight back down, and a run only goes up', () => {
  assert.throws(
    () => new Drivetrain({ axles: [{ wheels: [2, 3] }], upshiftRpm: 3000, downshiftRpm: 2800 }),
    /shift back down/,
  );
  assert.throws(() => new Drivetrain({ axles: [{ wheels: [2, 3] }], upshiftRpm: 0 }), /upshiftRpm/);
  const { physics, vehicle } = car(rear());
  vehicle.setInput({ throttle: 1 });
  const gears = [];
  for (let i = 0; i < 900; i++) {
    physics.step();
    gears.push(vehicle.drivetrain.gear);
  }
  assert.ok(gears.at(-1) >= 3, `it climbed to gear ${gears.at(-1)}`);
  for (let i = 1; i < gears.length; i++)
    assert.ok(gears[i] >= gears[i - 1], `it shifted down from ${gears[i - 1]} to ${gears[i]} at step ${i}`);
  physics.dispose();
});

test('closing the throttle brakes with the engine: a drag at the wheels that grows with the speed, and none with no engine braking', () => {
  const drag = (engineBraking, spin) => {
    const drive = new Drivetrain({ axles: [{ wheels: [2, 3] }], engineBraking });
    drive.pedals(0, 0);
    let torques = [];
    for (let i = 0; i < 10; i++) torques = drive.step(1 / 60, wheels(2, spin));
    return torques[0] + torques[1];
  };
  assert.ok(drag(40, 20) < 0, 'a drag at 20 rad/s');
  assert.ok(drag(40, 40) < drag(40, 20), 'a bigger drag at twice the speed');
  assert.equal(drag(0, 40), 0, 'none without engine braking');
});

test('shifting up from reverse or neutral goes into first, and shifting down from reverse does nothing', () => {
  const drive = rear();
  drive.gear = -1;
  drive.shiftDown();
  assert.equal(drive.gear, -1);
  drive.shiftUp();
  assert.equal(drive.gear, 1);
  drive.gear = 0;
  drive.shiftUp();
  assert.equal(drive.gear, 1);
});
