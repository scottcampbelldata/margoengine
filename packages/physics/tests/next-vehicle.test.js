// The ray-cast vehicle on the own solver against Rapier's controller (tests/oracle.js, as a black box): a car rests on its
// springs carrying its weight, drives, steers, brakes and reverses the same way, within what two solvers differ by.
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

/** A 1,000 kg car on a 100 m floor: chassis 2 x 0.5 x 4 m, four 0.35 m wheels, the front pair steers. */
const cars = (rollInfluence) =>
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
      }),
      wheels = [
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
        ...(rollInfluence === undefined ? {} : { rollInfluence }),
      }));
    return { physics, chassis, vehicle: new Kind(physics, chassis, { wheels }) };
  });

test('a car rests on four springs that carry its weight, drives, steers, brakes and reverses, as on Rapier', () => {
  const list = cars(),
    [own, rapier] = list;
  steps(list, 60);
  for (const { chassis, vehicle } of list) {
    for (let i = 0; i < 4; i++) assert.ok(vehicle.wheel(i).inContact, `wheel ${i} touches the ground`);
    const load = [0, 1, 2, 3].reduce((sum, i) => sum + vehicle.wheel(i).suspensionForce, 0);
    near(load, 1000 * 9.81, 1000 * 9.81 * 0.05, 'the springs carry the weight');
    near(vehicle.speed, 0, 0.01, 'parked');
    assert.ok(chassis.position[1] > 0.4 && chassis.position[1] < 1);
  }
  near(own.chassis.position[1], rapier.chassis.position[1], 0.02, 'the same ride height');
  for (let i = 0; i < 4; i++)
    near(own.vehicle.wheel(i).suspensionLength, rapier.vehicle.wheel(i).suspensionLength, 0.01, `spring ${i}`);

  // Full throttle: the speed after three seconds is the engine force over the mass until the tyres slip.
  for (const { vehicle } of list) vehicle.setInput({ throttle: 1 });
  steps(list, 180);
  for (const { chassis, vehicle } of list) {
    assert.ok(vehicle.speed > 3, `gains speed (${vehicle.speed})`);
    near(chassis.position[0], 0, 0.05, 'straight ahead');
  }
  near(own.vehicle.speed, 4 * 3, 0.1, 'four driven wheels of 1,000 N push 1,000 kg at 4 m/s^2: 12 m/s in 3 s');
  near(own.vehicle.speed, rapier.vehicle.speed, rapier.vehicle.speed * 0.02, 'the speed Rapier reaches');

  // Steering left turns toward +X on both, and by about as much.
  for (const { vehicle } of list) vehicle.setInput({ throttle: 0.5, steer: 1 });
  const before = list.map(({ chassis }) => [...chassis.position]);
  steps(list, 60);
  list.forEach(({ chassis, vehicle }, i) => {
    assert.ok(chassis.position[0] - before[i][0] > 0.2, 'turns toward +X');
    near(vehicle.wheel(0).steering, 0.5, 1e-6, 'front wheels at full lock');
    near(vehicle.wheel(2).steering, 0, 1e-6, 'rear wheels do not steer');
  });
  near(
    own.chassis.position[0] - before[0][0],
    rapier.chassis.position[0] - before[1][0],
    Math.abs(rapier.chassis.position[0] - before[1][0]) * 0.1,
    'the sideways travel of the turn',
  );

  // Brake to a stop, then reverse.
  for (const { vehicle } of list) vehicle.setInput({ brake: 1 });
  steps(list, 600);
  for (const { vehicle } of list) assert.ok(Math.abs(vehicle.speed) < 0.05, `brakes to a stop (${vehicle.speed})`);
  for (const { vehicle } of list) vehicle.setInput({ throttle: -1 });
  steps(list, 120);
  for (const { vehicle } of list) assert.ok(vehicle.speed < -1, `reverses (${vehicle.speed})`);
  for (const { physics } of list) physics.dispose();
});

test('a parked car does not rock: its four wheels share a slide instead of each cancelling all of it', () => {
  const [own] = cars();
  steps([own], 60);
  const { chassis, vehicle } = own;
  near(chassis.linearVelocity[0], 0, 1e-3, 'no sideways drift');
  near(chassis.angularVelocity[2], 0, 1e-3, 'no roll');
  const loads = [0, 1, 2, 3].map((i) => vehicle.wheel(i).suspensionForce);
  for (const load of loads) near(load, (1000 * 9.81) / 4, 100, 'every spring carries a quarter of the weight');
  own.physics.dispose();
});

test('a car takes a bend at speed without tipping over, as on Rapier, unless its tyres are given a full roll influence', () => {
  const bend = (rollInfluence) => {
      const list = cars(rollInfluence);
      steps(list, 60);
      for (const { vehicle } of list) vehicle.setInput({ throttle: 1 });
      steps(list, 180);
      for (const { vehicle } of list) vehicle.setInput({ throttle: 0.5, steer: 1 });
      steps(list, 60);
      // The chassis's up axis: how far it has rolled over.
      const up = ({ chassis }) => {
        const [x, , z] = chassis.rotation;
        return 1 - 2 * (x * x + z * z);
      };
      const result = list.map(up);
      for (const { physics } of list) physics.dispose();
      return result;
    },
    [ownUp, rapierUp] = bend(),
    [tippedUp] = bend(1);
  assert.ok(ownUp > 0.99, `the own car stays upright (${ownUp})`);
  assert.ok(rapierUp > 0.99, `and so does Rapier's (${rapierUp})`);
  assert.ok(tippedUp < 0.9, `a roll influence of 1 puts the grip where the tyre is and the car rolls (${tippedUp})`);
});

test('a roll influence outside 0 to 1 is refused with the fix', () => {
  const physics = new Physics(null),
    chassis = physics.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.25, 2] } });
  for (const rollInfluence of [-0.1, 1.5, Number.NaN, '0.1'])
    assert.throws(
      () => new Vehicle(physics, chassis, { wheels: [{ position: [0, 0, 0], radius: 0.3, rollInfluence }] }),
      {
        name: 'MargoError',
        code: 'unsupported',
        message: /rollInfluence must be a number from 0 to 1; use 0.1.*errors#vehicles/,
      },
    );
  physics.dispose();
});

test('a wheel reports what it stands on, where its suspension is mounted and what it pushed the chassis with', () => {
  const [{ physics, chassis, vehicle }] = cars();
  steps([{ physics }], 60);
  const floor = vehicle.wheel(0).ground;
  assert.ok(floor, 'a wheel on the ground names its collider');
  assert.equal(floor.body.type, 'fixed', 'the floor');
  const air = new Physics(null),
    flying = air.addBody(null, { colliders: { shape: 'box', halfExtents: [1, 0.25, 2], mass: 1000 } }),
    glider = new Vehicle(air, flying, { wheels: [{ position: [0, 0, 0], radius: 0.3 }] });
  air.step();
  assert.equal(glider.wheel(0).ground, null, 'in the air it stands on nothing');
  assert.equal(glider.wheel(0).inContact, false);
  air.dispose();
  const [x, y, z] = chassis.position;
  assert.deepEqual(
    vehicle.wheel(0).hardPoint.map((v) => Math.round(v * 1000) / 1000),
    [x - 0.9, y - 0.1, z + 1.4].map((v) => Math.round(v * 1000) / 1000),
    'the mount, in the world',
  );
  vehicle.setInput({ throttle: 1 });
  physics.step();
  for (let i = 0; i < 4; i++) {
    near(vehicle.wheel(i).forwardImpulse, 1000 / 60, 0.5, `wheel ${i} pushes with its engine force for one step`);
    near(vehicle.wheel(i).sideImpulse, 0, 0.5, `wheel ${i} has nothing to grip against`);
  }
  physics.dispose();
});
