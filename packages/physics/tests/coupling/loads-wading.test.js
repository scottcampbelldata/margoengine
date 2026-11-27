import assert from 'node:assert/strict';
import test from 'node:test';
import { bedSurface } from '../../dist/earth.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { LeggedLocomotion } from '../../dist/legged.js';
import { FloodWadingSolver } from '../../dist/loads.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate60 = { num: 60, den: 1 };
const gravity = [0, -9.81, 0];
const mass = 75;
const density = 1000;
const profile = { mass, centreOffset: -0.5, halfHeight: 0.4, area: 0.2, volume: 0.03, dragCoefficient: 1 };
const surface = { columns: 2, rows: 2, width: 2, depth: 2, centre: [0, 0] };
const sides = { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' };

function close(value, expected, tolerance, label) {
  assert.ok(Math.abs(value - expected) <= tolerance, `${label}: ${value} vs ${expected} ± ${tolerance}`);
}

function make(
  legs,
  { rate = rate60, level = 1, position = [0, 1.2, 0], velocity, current = [1.2, 0.9], exchangeRate } = {},
) {
  const water = new ShallowWaterSolver();
  const wading = new FloodWadingSolver();
  const bed = bedSurface(surface, new Float64Array(9));
  const world = new PhysicsWorld({ rate, gravity }).add(legs, {
    bodies: [{ kind: 'biped', mass, position, velocity }],
  });
  const levelOfLegs = world.levelOf('legged-locomotion');
  world
    .add(water, { bed, density, level, roughness: 0, velocity: () => current, sides, rate: levelOfLegs })
    .add(wading, { bed, density, bodies: [profile], rate: exchangeRate ?? levelOfLegs })
    .couple(['floodWading', 'water', 'legged-locomotion'], 'staggered');
  return { legs, wading, water, world };
}

function waterMomentum(water) {
  let xMomentum = 0;
  let zMomentum = 0;
  for (const x of [-0.5, 0.5])
    for (const z of [-0.5, 0.5]) {
      const {
        depth,
        velocity: [u, v],
      } = water.sample(x, z);
      xMomentum += density * depth * u;
      zMomentum += density * depth * v;
    }
  return [xMomentum, zMomentum];
}

test('a live legged body receives buoyancy and current momentum, returning its horizontal reaction to the water', async () => {
  const { legs, wading, water, world } = make(await LeggedLocomotion.load({ readLoad: true }), {
    rate: { num: 240, den: 1 },
  });
  const dt = 1 / 240;
  assert.equal(world.levelOf('legged-locomotion'), 2);
  const before = waterMomentum(water);
  const volume = water.volume();
  world.advance(1);
  const force = wading.readBody(0);
  const [vx, vy, vz] = legs.read(0).velocity;
  const after = waterMomentum(water);
  const wet = 0.7 / 0.8;
  const inverseMass = 1 / mass + 0.25 / density;
  const impulse = Math.hypot(force[0], force[2]) * dt;
  // The shallow-water port publishes f32 discharges. Use their actual starting slip in the analytical residual.
  const startSlip = Math.hypot(Math.fround(1.2), Math.fround(0.9));
  const slip = startSlip - inverseMass * impulse;
  close(impulse, 0.5 * density * wet * profile.area * dt * slip * slip, 2e-12, 'implicit water drag');
  close(force[1], density * 9.81 * wet * profile.volume, 2e-12, 'displaced-volume buoyancy');
  close(mass * vx, force[0] * dt, 1e-10, 'legged x momentum');
  close(mass * vz, force[2] * dt, 1e-10, 'legged z momentum');
  close(mass * vy, (force[1] - mass * 9.81) * dt, 1e-10, 'legged vertical momentum in flight');
  close(after[0] - before[0], -force[0] * dt, 1e-9, 'reactive x momentum');
  close(after[1] - before[1], -force[2] * dt, 1e-9, 'reactive z momentum');
  close(water.volume(), volume, 1e-12, 'water volume');
});

test('wading unloads the actual stance contacts while the dry biped carries its weight', async () => {
  const solvers = await Promise.all([
    LeggedLocomotion.load({ readLoad: true }),
    LeggedLocomotion.load({ readLoad: true }),
  ]);
  const wet = make(solvers[0], { position: [0, 0.8, 0], current: [0, 0] });
  const dry = make(solvers[1], { position: [0, 0.8, 0], level: 0, current: [0, 0] });
  wet.world.advance(180);
  dry.world.advance(180);
  const support = (m) => m.legs.readContact(0, 0).force[1] + m.legs.readContact(0, 1).force[1];
  const buoyancy = wet.wading.readBody(0)[1];
  assert.ok(buoyancy > 0);
  assert.deepEqual(dry.wading.readBody(0), [0, 0, 0]);
  close(support(dry), mass * 9.81, 0.15, 'dry static reaction');
  close(support(wet) + buoyancy, mass * 9.81, 0.15, 'wading vertical force balance');
  assert.ok(support(wet) < support(dry));
});

test('moving legged bodies and shallow-water reactions replay across presentation clocks and snapshots', async () => {
  const solvers = await Promise.all(Array.from({ length: 5 }, () => LeggedLocomotion.load({ readLoad: true })));
  const model = (rate = { num: 24, den: 1 }) => make(solvers.shift(), { rate, velocity: [0, 0, 0.2] }).world;
  frameRateIndependent(model);
  seekEqualsContinuous(() => model(), { at: 2, frames: 12 });
});

test('wading refuses mismatched rates that would otherwise apply only a fraction of the body impulse', async () => {
  const { world } = make(await LeggedLocomotion.load({ readLoad: true }), { exchangeRate: 0 });
  assert.throws(() => world.advance(3), {
    name: 'MargoError',
    code: 'unsupported',
    message: /Match the wading and legged rate levels.+#hydrodynamic-loads/,
  });
});
