// Vehicle.car, the arcade car that drives with no tuning (P5 DYN-04): its springs rest where their closed form puts them, it
// drives, steers and stops at once, a replay from a snapshot is the same bit for bit, its debug lines show the suspension,
// contacts, tyre push and wheels, and bad input is a coded MargoError with its help link.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, Vehicle } from '../dist/index.js';

await Physics.load();

/** A 1,200 kg box car, 1.8 x 0.6 x 4 m, on a wide floor: the quick start of the README. */
function scene(options) {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [500, 0.5, 500] },
  });
  const chassis = physics.addBody(null, {
    position: [0, 1, 0],
    colliders: { shape: 'box', halfExtents: [0.9, 0.3, 2], mass: 1200 },
  });
  return { physics, chassis, car: Vehicle.car(physics, chassis, options) };
}
const run = (physics, steps) => {
  for (let i = 0; i < steps; i++) physics.step();
};

test('a car rests on four springs that carry a quarter of its weight each, at the sag their closed form gives', () => {
  const { physics, chassis, car } = scene();
  run(physics, 300);
  // r = 0.35 min(0.9, 2) = 0.315, rest = 0.85 r, sag = rest / 3, k = g / (4 sag) per kilogram. A car at rest has dampers that read
  // nothing, so each spring alone holds a quarter of the weight at the static sag. The dampers once read the chassis's end-of-step
  // velocity, -7/16 g dt at 8 substeps for a body held still, and rested every spring 4.1 mm long (KB-PHYS-VEHICLEREST1).
  const radius = 0.35 * 0.9,
    rest = 0.85 * radius,
    sag = rest / 3,
    weight = (1200 * 9.81) / 4;
  assert.equal(car.wheelCount, 4);
  for (let i = 0; i < 4; i++) {
    const wheel = car.wheel(i);
    assert.ok(wheel.inContact, `wheel ${i} touches the floor`);
    assert.ok(
      Math.abs(wheel.suspensionLength - (rest - sag)) < 1e-5,
      `wheel ${i} length ${wheel.suspensionLength}, not the static sag ${rest - sag}`,
    );
    assert.ok(Math.abs(wheel.suspensionForce - weight) / weight < 1e-3, `wheel ${i} load ${wheel.suspensionForce}`);
  }
  // Each hub hangs the spring's length below its mount, 0.2 r + rest - sag above the body's bottom, so the body's centre stands
  // r + length - (0.2 r + rest - sag) + 0.3 over the floor: 0.8 r + 0.3 at the static sag.
  const length = car.wheel(0).suspensionLength,
    y = radius + length - (0.2 * radius + rest - sag) + 0.3;
  assert.ok(Math.abs(chassis.position[1] - y) < 1e-4, `ride height ${chassis.position[1]}, not ${y}`);
  const start = chassis.position[1];
  run(physics, 60);
  assert.ok(Math.abs(chassis.position[1] - start) < 1e-6, 'and it is still');
  physics.dispose();
});

test('a car drives at once: full throttle pushes 0.4 g, steer turns it toward +X, the brake stops it', () => {
  const { physics, chassis, car } = scene();
  run(physics, 300);
  car.setInput({ throttle: 1 });
  run(physics, 60);
  // Four driven wheels each push the chassis mass in newtons: a = 4 m/s^2, so 4 m/s after one second.
  assert.ok(Math.abs(car.speed - 4) < 0.01, `speed after 1 s ${car.speed}`);
  assert.ok(Math.abs(chassis.position[0]) < 1e-6, 'and straight');
  car.setInput({ throttle: 1, steer: 1 });
  run(physics, 60);
  assert.ok(chassis.position[0] > 0.5, `steering left turns a +Z car toward +X (${chassis.position[0]})`);
  const [x, , z] = chassis.rotation;
  assert.ok(1 - 2 * (x * x + z * z) > 0.95, 'the car stays on its wheels');
  car.setInput({ brake: 1 });
  run(physics, 180);
  assert.ok(Math.abs(car.speed) < 0.05, `the brake stops it (${car.speed})`);
  physics.dispose();
});

test('a replay from a snapshot and the motion state is the same bit for bit', () => {
  const drive = (car, physics, steps) => {
    for (let i = 0; i < steps; i++) {
      car.setInput({ throttle: 1, steer: Math.sin(i / 20) });
      physics.step();
    }
  };
  const a = scene(),
    b = scene();
  drive(a.car, a.physics, 200);
  drive(b.car, b.physics, 200);
  assert.equal(a.physics.kernel.hash, b.physics.kernel.hash, 'two worlds from the same input agree');
  const snapshot = a.physics.takeSnapshot(),
    motion = new Float64Array(a.car.motionStateWords);
  a.car.writeMotionState(motion);
  drive(a.car, a.physics, 120);
  const first = [a.physics.kernel.hash, a.car.wheel(0).rotation, a.car.speed];
  a.physics.restoreSnapshot(snapshot);
  a.car.readMotionState(motion);
  drive(a.car, a.physics, 120);
  assert.deepEqual([a.physics.kernel.hash, a.car.wheel(0).rotation, a.car.speed], first);
  a.physics.dispose();
  b.physics.dispose();
});

test('the debug lines show each suspension ray, contact, tyre push and wheel', () => {
  const { physics, car } = scene();
  run(physics, 300);
  car.setInput({ throttle: 1 });
  run(physics, 2);
  const lines = car.debugRender(),
    segments = lines.vertices.length / 6;
  // Per wheel: two suspension lines, one normal, one push and a 24-segment rim.
  assert.equal(segments, 4 * (2 + 1 + 1 + 24));
  assert.equal(lines.colors.length, segments * 8);
  for (let i = 0; i < 4; i++) {
    const wheel = car.wheel(i),
      at = i * 28 * 6,
      top = lines.vertices.subarray(at, at + 3),
      hub = lines.vertices.subarray(at + 3, at + 6);
    assert.ok(Math.abs(Math.hypot(hub[0] - top[0], hub[1] - top[1], hub[2] - top[2]) - wheel.suspensionLength) < 1e-5);
    assert.ok(Math.hypot(top[0] - wheel.hardPoint[0], top[1] - wheel.hardPoint[1], top[2] - wheel.hardPoint[2]) < 1e-5);
    // The push line points forward (+Z), one metre for a push of the wheel's whole load: a quarter of the drive, 4 m/s^2 on a
    // quarter of 1,200 kg, 1,200 N, over the load the wheel carries now. Two steps after the throttle the front wheels carry
    // less than a quarter of the weight and the rear more, so the line is read against each wheel's own load.
    const push = lines.vertices.subarray(at + 18, at + 24);
    assert.ok(Math.abs(push[0] - push[3]) < 1e-6 && Math.abs(push[1] - push[4]) < 1e-6, `wheel ${i} push points along Z`);
    assert.ok(
      Math.abs((push[5] - push[2]) * wheel.suspensionForce - 1200) < 0.5,
      `wheel ${i} push ${push[5] - push[2]} on a load of ${wheel.suspensionForce} N`,
    );
  }
  const only = car.debugRender({ wheels: false, slip: false, contacts: false });
  assert.equal(only.vertices.length / 6, 4 * 2, 'each part switches off');
  physics.dispose();
});

test('Vehicle.car takes overrides and refuses what it cannot lay out, with a coded error and its help link', () => {
  const { physics, chassis, car } = scene({ wheel: { frictionSlip: 2 }, maxEngineForce: 500 });
  assert.equal(car.maxEngineForce, 500);
  car.dispose();
  const coded = { name: 'MargoError', code: 'unsupported', message: /errors#vehicles/ };
  const hull = physics.addBody(null, {
    position: [5, 1, 0],
    colliders: { shape: 'convexHull', points: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] },
  });
  assert.throws(() => Vehicle.car(physics, hull), { ...coded, message: /halfExtents.*errors#vehicles/ });
  assert.ok(Vehicle.car(physics, hull, { halfExtents: [0.5, 0.2, 1] }).valid, 'a size makes any chassis a car');
  assert.throws(() => Vehicle.car(physics, chassis, { halfExtents: [1, 0, 2] }), coded);
  assert.throws(() => Vehicle.car(physics, chassis, { forward: [0, 1, 0] }), coded);
  assert.throws(
    () => new Vehicle(physics, chassis, { wheels: [{ position: [0, Number.NaN, 0], radius: 0.3 }] }),
    coded,
  );
  const other = new Physics(null);
  assert.throws(() => Vehicle.car(other, chassis), { name: 'MargoError', code: 'state' });
  other.dispose();
  physics.dispose();
});
