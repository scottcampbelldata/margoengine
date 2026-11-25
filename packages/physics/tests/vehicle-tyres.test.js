// Tyre models and shape-cast wheels: the Magic Formula and the brush model as curves, and a car on them against what a tyre can give.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, Vehicle, brushTyre, pacejkaTyre } from '../dist/index.js';

await Physics.load();

const near = (actual, expected, bound, message) =>
  assert.ok(
    Math.abs(actual - expected) <= bound,
    `${message ?? 'value'}: ${actual} is not within ${bound} of ${expected}`,
  );

test('the Magic Formula is odd, peaks near a slip of a tenth at the load times the friction, and starts at the stiffness BCD', () => {
  const tyre = pacejkaTyre(),
    load = 4000,
    at = (slipRatio, slipAngle = 0, l = load) => tyre.forces({ slipRatio, slipAngle, load: l });
  near(at(0.05).longitudinal, -at(-0.05).longitudinal, 1e-9, 'odd in the slip ratio');
  near(at(0, 0.08).lateral, -at(0, -0.08).lateral, 1e-9, 'odd in the slip angle');
  assert.equal(at(0).longitudinal, 0);
  let best = 0,
    where = 0;
  for (let k = 0.005; k < 0.6; k += 0.005) if (at(k).longitudinal > best) [best, where] = [at(k).longitudinal, k];
  assert.ok(where > 0.06 && where < 0.2, `the peak slip ratio is ${where}`);
  near(best / load, 1.1, 0.08, 'the peak force over the load is the friction coefficient D');
  // The stiffness at small slip: B C D times the load (the sine form's slope at the origin).
  near(at(1e-5).longitudinal / 1e-5 / (12 * 1.9 * 1.1 * load), 1, 0.01, 'slope at the origin');
  near(at(0, 1e-5).lateral / 1e-5 / (9 * 1.3 * 1.0 * load), 1, 0.01, 'cornering stiffness');
  // Load sensitivity: a heavier tyre has less friction per newton.
  assert.ok(at(0.1, 0, 8000).longitudinal / 8000 < at(0.1, 0, 4000).longitudinal / 4000);
  assert.deepEqual(at(0.1, 0, 0), { longitudinal: 0, lateral: 0 }, 'no load, no force');
});

test('combined slip stays inside the friction ellipse, and a model refuses what makes no sense', () => {
  const tyre = pacejkaTyre();
  for (const [k, a] of [
    [0.1, 0.1],
    [0.3, 0.2],
    [-0.5, 0.3],
    [1, 1],
  ]) {
    const f = tyre.forces({ slipRatio: k, slipAngle: a, load: 4000 }),
      free = pacejkaTyre({ combined: false }).forces({ slipRatio: k, slipAngle: a, load: 4000 });
    assert.ok((f.longitudinal / 4400) ** 2 + (f.lateral / 4000) ** 2 <= 1 + 1e-9, `inside the ellipse at ${k}, ${a}`);
    assert.ok(
      Math.hypot(free.longitudinal / 4400, free.lateral / 4000) >=
        Math.hypot(f.longitudinal / 4400, f.lateral / 4000) - 1e-9,
    );
  }
  assert.throws(() => pacejkaTyre({ longitudinal: { B: 0 } }), /longitudinal.B/);
  assert.throws(() => pacejkaTyre({ lateral: { D: NaN } }), /lateral.D/);
  assert.throws(() => pacejkaTyre({ loadSensitivity: -1 }), /loadSensitivity/);
  assert.throws(() => brushTyre({ friction: 0 }), /friction/);
  assert.throws(() => brushTyre({ halfLength: -1 }), /halfLength/);
});

test('the brush tyre has the cornering stiffness 2 c a squared, saturates at the friction cone and gives combined slip along the slip', () => {
  const c = 4e6,
    a = 0.1,
    mu = 1,
    load = 4000,
    tyre = brushTyre({ stiffness: c, halfLength: a, friction: mu }),
    theta = (2 * c * a * a) / (3 * mu * load);
  near(
    tyre.forces({ slipRatio: 1e-5, slipAngle: 0, load }).longitudinal / 1e-5 / (2 * c * a * a),
    1,
    0.01,
    'longitudinal stiffness 2 c a^2',
  );
  near(
    tyre.forces({ slipRatio: 0, slipAngle: 1e-5, load }).lateral / 1e-5 / (2 * c * a * a),
    1,
    0.01,
    'cornering stiffness 2 c a^2',
  );
  const slide = 1 / theta;
  near(tyre.forces({ slipRatio: 1.5 * slide, slipAngle: 0, load }).longitudinal, mu * load, 1e-6, 'saturated at mu Fz');
  assert.ok(
    tyre.forces({ slipRatio: 0.5 * slide, slipAngle: 0, load }).longitudinal < mu * load,
    'not yet at half the sliding slip',
  );
  // Combined slip: one force, along the slip vector, never past the cone.
  for (const [k, alpha] of [
    [0.02, 0.03],
    [0.2, 0.1],
    [0.05, -0.4],
  ]) {
    const f = tyre.forces({ slipRatio: k, slipAngle: alpha, load }),
      size = Math.hypot(f.longitudinal, f.lateral);
    assert.ok(size <= mu * load + 1e-6, `inside the cone at ${k}, ${alpha}`);
    near(f.lateral / f.longitudinal, Math.tan(alpha) / k, 1e-9, 'along the slip');
  }
});

test('the brush tyre\'s defaults have the cornering stiffness of the Magic Formula\'s defaults at their nominal load', () => {
  const load = 4000,
    slip = 1e-5,
    brush = brushTyre().forces({ slipRatio: 0, slipAngle: slip, load }).lateral / slip,
    magic = pacejkaTyre().forces({ slipRatio: 0, slipAngle: slip, load }).lateral / slip;
  near(brush / magic, 1, 0.01, 'the two tyres corner alike at 4,000 N');
  near(brush, 46800, 468, 'a cornering stiffness 2 c a^2 of 46.8 kN per radian');
});

/** A 1,000 kg car on a 200 m floor on tyre models: chassis 2 x 0.5 x 4 m, four 0.35 m wheels, the front pair steers, the rear drives. */
function car(options = {}, wheelOptions = {}) {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [100, 0.5, 100], friction: 0.9 },
  });
  const chassis = physics.addBody(null, {
      position: [0, 1, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 },
    }),
    vehicle = new Vehicle(physics, chassis, {
      tyre: pacejkaTyre(),
      wheels: [
        [-0.9, 1.4, true, false],
        [0.9, 1.4, true, false],
        [-0.9, -1.4, false, true],
        [0.9, -1.4, false, true],
      ].map(([x, z, steer, drive]) => ({
        position: [x, -0.1, z],
        radius: 0.35,
        suspensionRestLength: 0.3,
        suspensionStiffness: 30,
        suspensionCompression: 4,
        suspensionRelaxation: 5,
        steer,
        drive,
        ...wheelOptions,
      })),
      ...options,
    });
  return { physics, chassis, vehicle };
}

test('a car on Magic Formula tyres brakes to a stop in about the distance the friction allows, with its wheels near locking', () => {
  const { physics, chassis, vehicle } = car();
  for (let i = 0; i < 90; i++) physics.step();
  chassis.setLinearVelocity([0, 0, 20]);
  for (const wheel of [0, 1, 2, 3]) void wheel;
  const start = chassis.position[2];
  vehicle.brake = 8000;
  let slip = 0;
  for (let i = 0; i < 600 && vehicle.speed > 0.2; i++) {
    physics.step();
    slip = Math.min(slip, vehicle.wheel(2).slipRatio);
  }
  const distance = chassis.position[2] - start;
  // v^2 / (2 mu g) with mu of 1.1 to 1.2 under a load of 2,450 N a wheel: 17 to 18 metres, and the weight shifts forward as it brakes.
  assert.ok(distance > 14 && distance < 24, `stopped in ${distance} m`);
  assert.ok(slip < -0.04, `the wheels slipped under braking: ${slip}`);
  physics.dispose();
});

test('driving force accelerates the car through the tyres, to about what the friction allows on the driven wheels', () => {
  const { physics, chassis, vehicle } = car();
  for (let i = 0; i < 90; i++) physics.step();
  // A gentle drive: 1,500 N a rear wheel on a car of 1,000 kg is 3 m/s squared, well inside the 1.1 g the tyres hold.
  vehicle.engineForce = 1500;
  const start = chassis.position[2];
  for (let i = 0; i < 120; i++) physics.step();
  near(vehicle.speed, 6, 0.8, 'two seconds at 3 m/s squared');
  assert.ok(
    vehicle.wheel(2).spin > 0 && Math.abs(vehicle.wheel(2).slipRatio) < 0.12,
    `the driven wheels turn with a little slip: ${vehicle.wheel(2).slipRatio}`,
  );
  assert.ok(chassis.position[2] > start + 5);
  // A drive beyond the grip: 6,000 N a wheel is more than the 2,700 N its tyre holds, and a force at the patch has no engine to limit it,
  // so the wheels run away past the ground and the car gets no more than the tyres can give (the engine's limit is the drivetrain's).
  vehicle.engineForce = 6000;
  const before = vehicle.speed;
  for (let i = 0; i < 60; i++) physics.step();
  const gain = vehicle.speed - before;
  assert.ok(vehicle.wheel(2).slipRatio > 1, `the driven wheels run away: ${vehicle.wheel(2).slipRatio}`);
  assert.ok(
    gain > 0.5 && gain < 5.5,
    `a second of wheelspin gains ${gain} m/s, less than the friction of the driven wheels' share allows`,
  );
  physics.dispose();
});

test('a car on tyres holds a corner at about the friction circle, and the brush tyre does the same inside its cone', () => {
  for (const [name, tyre] of [
    ['pacejka', pacejkaTyre()],
    ['brush', brushTyre({ stiffness: 4e6, halfLength: 0.1, friction: 1.0 })],
  ]) {
    const { physics, chassis, vehicle } = car({ tyre });
    for (let i = 0; i < 90; i++) physics.step();
    chassis.setLinearVelocity([0, 0, 15]);
    vehicle.steering = 0.25;
    let lateral = 0;
    for (let i = 0; i < 240; i++) {
      physics.step();
      if (i > 120) {
        const v = chassis.linearVelocity,
          w = chassis.angularVelocity;
        lateral = Math.max(lateral, Math.abs(Math.hypot(v[0], v[2]) * w[1]));
      }
    }
    // Under a steady turn the lateral acceleration is the speed times the yaw rate: about 1 g at most on these tyres.
    assert.ok(lateral > 4 && lateral < 13, `${name}: lateral acceleration ${lateral} m/s^2`);
    assert.ok(Math.abs(chassis.angularVelocity[1]) > 0.1, `${name}: the car turns`);
    physics.dispose();
  }
});

test('a wheel that sweeps a cylinder meets the lip of a slot a ray passes through', () => {
  const run = (cast) => {
    const physics = new Physics(null);
    // Two slabs with a 12 cm slot between them across the car's width, under the front wheels (z = 1.4).
    for (const z of [-1, 1]) {
      physics.addBody(null, {
        type: 'fixed',
        position: [0, -0.5, 1.4 + z * (50 + 0.06)],
        colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
      });
    }
    const chassis = physics.addBody(null, {
      position: [0, 1, 0],
      colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 },
    });
    // The rear is held on a third slab so the car sits level while the front wheels are over the slot.
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, -52],
      colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
    });
    const vehicle = new Vehicle(physics, chassis, {
      wheelCast: cast,
      wheels: [
        [-0.9, 1.4],
        [0.9, 1.4],
        [-0.9, -1.4],
        [0.9, -1.4],
      ].map(([x, z]) => ({
        position: [x, -0.1, z],
        radius: 0.35,
        suspensionRestLength: 0.3,
        suspensionStiffness: 30,
        suspensionCompression: 4,
        suspensionRelaxation: 5,
        frictionSlip: 2,
      })),
    });
    for (let i = 0; i < 180; i++) physics.step();
    const front = [vehicle.wheel(0), vehicle.wheel(1)],
      result = {
        contact: front.every((w) => w.inContact),
        length: front[0].suspensionLength,
        normal: front[0].contactNormal,
      };
    physics.dispose();
    return result;
  };
  const ray = run('ray'),
    shape = run('shape');
  assert.equal(ray.contact, false, 'a ray goes down the slot: no contact');
  assert.equal(shape.contact, true, 'a cylinder bridges it');
  near(shape.length, 0.3 - 0.03, 0.12, 'the suspension carries the car as on a floor');
  assert.ok(shape.normal && shape.normal[1] > 0.9, 'the ground pushes up');
});

test('a shape-cast car drives, steers and rests like a ray-cast one on a plain floor', () => {
  const rest = (cast) => {
    const { physics, chassis, vehicle } = car({ wheelCast: cast, tyre: undefined }, { frictionSlip: 2 });
    for (let i = 0; i < 120; i++) physics.step();
    vehicle.engineForce = 400;
    vehicle.steering = 0.2;
    for (let i = 0; i < 120; i++) physics.step();
    const result = {
      y: chassis.position[1],
      speed: vehicle.speed,
      yaw: chassis.angularVelocity[1],
      loads: [0, 1, 2, 3].map((i) => vehicle.wheel(i).load),
    };
    physics.dispose();
    return result;
  };
  const ray = rest('ray'),
    shape = rest('shape');
  near(shape.y, ray.y, 0.03, 'ride height');
  near(shape.speed, ray.speed, 0.6, 'speed');
  near(shape.yaw, ray.yaw, 0.06, 'yaw rate');
  near(
    shape.loads.reduce((a, b) => a + b, 0),
    1000 * 9.81,
    400,
    'the springs carry the weight',
  );
  assert.throws(() => new Vehicle(new Physics(null), new Physics(null).addBody(null, {}), {}), /state|chassis|wheels/i);
});
