import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { FloodPaddleSolver } from '../../dist/loads.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const gravity = [0, -9.81, 0];
const sides = { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' };
const radius = 0.5;
const mass = 30;
const inertia = mass / 6;
const density = 1000;
const dt = 1 / 60;

function close(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} ± ${tolerance}`);
}

function make({ rate = { num: 60, den: 1 }, flow = 2, bladeHeight = 0.5, motor = false } = {}) {
  const box = { columns: 2, rows: 2, width: 2, depth: 2, centre: [0, 0] };
  const bed = bedSurface(box, new Float64Array(9));
  const physics = new Physics(null, { fixedTimestep: dt, gravity });
  const pivot = physics.addBody(null, { type: 'fixed', position: [0, 0.5, 0], colliders: [] });
  const shaft = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass },
  });
  const joint = physics.addJoint(pivot, shaft, { type: 'revolute', axis: [0, 1, 0] });
  if (motor) joint.setMotor({ targetVelocity: 4, maxForce: 4, damping: 1000, model: 'force' });
  const water = new ShallowWaterSolver();
  const paddle = new FloodPaddleSolver();
  const world = new PhysicsWorld({ rate, gravity })
    .add(new RigidSolver(), { physics })
    .add(water, { bed, density, depth: 1, roughness: 0, velocity: () => [flow, 0], sides })
    .add(paddle, {
      bed,
      density,
      blades: [
        {
          row: shaft.row,
          centre: [0, bladeHeight - 0.5, radius],
          normal: [1, 0, 0],
          area: 0.1,
          halfHeight: 0.2,
          dragCoefficient: 1,
        },
      ],
    })
    .couple(['floodPaddle', 'water', 'rigid'], 'staggered');
  return { water, paddle, shaft, world };
}

function waterBudget(water) {
  let xMomentum = 0;
  let zMomentum = 0;
  let energy = 0;
  for (const z of [-0.5, 0.5])
    for (const x of [-0.5, 0.5]) {
      const {
        depth,
        velocity: [u, v],
      } = water.sample(x, z);
      xMomentum += density * depth * u;
      zMomentum += density * depth * v;
      energy += 0.5 * density * depth * (u * u + v * v + 9.81 * depth);
    }
  return { xMomentum, zMomentum, energy };
}

test('a live current turns the joint shaft, and every staged blade impulse has the opposite water momentum', () => {
  const { world, water, paddle, shaft } = make();
  const initial = waterBudget(water);
  const volume = water.volume();
  world.advance(1);
  const next = waterBudget(water);
  const [x, y, z, , angular] = paddle.readBlade(0);
  // Two fully wet cells with equal area shares, and a cube body whose inertia is m/6. Use the quadratic
  // residual in its original units. This is the unobstructed, depth-averaged pressure-drag law.
  const inverseMass = 0.5 / density + Math.fround(1 / mass) + radius * radius * Math.fround(1 / inertia);
  const slipAtEnd = 2 - inverseMass * x;
  close(x, 0.5 * density * 0.1 * dt * slipAtEnd * slipAtEnd, 2e-12, 'implicit drag law at actual blade');
  close(angular, radius * x, 2e-12, 'shaft angular impulse');
  close(shaft.angularVelocity[1] * inertia, angular, 4e-7, 'actual revolute shaft angular momentum');
  close(next.xMomentum - initial.xMomentum, -x, 1e-9, 'equal and opposite x momentum into live flood solver');
  close(next.zMomentum - initial.zMomentum, -z, 1e-9, 'equal and opposite z momentum into live flood solver');
  assert.equal(y, 0);
  close(water.volume(), volume, 1e-12, 'momentum exchange also preserves the fluid volume');
  assert.ok(next.energy + 0.5 * inertia * shaft.angularVelocity[1] * shaft.angularVelocity[1] < initial.energy);
});

test('partial immersion clips the paddle and the live motor returns torque to the water', () => {
  const half = make({ bladeHeight: 1 });
  half.world.advance(1);
  const [x] = half.paddle.readBlade(0);
  const inverseMass = 0.5 / density + Math.fround(1 / mass) + (radius * radius + 0.4 * 0.4) * Math.fround(1 / inertia);
  const slip = 2 - inverseMass * x;
  close(x, 0.5 * density * 0.05 * dt * slip * slip, 2e-12, 'half-wetted and shifted centre of pressure');

  const wet = make({ flow: 0, motor: true });
  const dry = make({ flow: 0, motor: true, bladeHeight: 2 });
  let waterImpulse = 0;
  for (let frame = 1; frame <= 15; frame++) {
    dry.world.advance(frame);
    wet.world.advance(frame);
    waterImpulse -= wet.paddle.readBlade(0)[0];
  }
  assert.ok(wet.shaft.angularVelocity[1] > 0);
  assert.ok(wet.shaft.angularVelocity[1] < dry.shaft.angularVelocity[1], 'the actual motor slows under the water load');
  assert.ok(waterImpulse > 0);
  close(waterBudget(wet.water).xMomentum, waterImpulse, 1e-9, 'motor-driven paddle returns its impulse to the water');
  assert.deepEqual(dry.paddle.readBlade(0), [0, 0, 0, 0, 0, 0]);
  assert.throws(() => wet.paddle.readBlade(1), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Choose the index.+#hydrodynamic-loads/,
  });
});

test('live blade, water, and shaft states replay across both presentation and snapshot jumps', () => {
  frameRateIndependent((rate) => make({ rate, motor: true, flow: 0 }).world);
  seekEqualsContinuous(() => make({ rate: { num: 24, den: 1 }, motor: true, flow: 0 }).world, {
    at: 2,
    frames: 12,
  });
});
