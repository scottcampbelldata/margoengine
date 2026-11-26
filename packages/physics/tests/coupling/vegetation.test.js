import assert from 'node:assert/strict';
import test from 'node:test';
import { cos, exp, sin } from '@margoengine/math/pinned';
import { Physics } from '../../dist/index.js';
import { PLANT_IMPULSE_WORDS, PLANT_SWAY_WORDS, PlantRigidSolver, PlantSway } from '../../dist/vegetation.js';
import { PhysicsWorld, rateOf, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate60 = { num: 60, den: 1 };
const plant = { root: [0, 0, 0], height: 1.6, baseDiameter: 0.08, density: 700, youngModulus: 1.2e8 };
const beta = [1.875104068711961, 4.694091132974175];
const radius = plant.baseDiameter / 2;
const omega = beta.map(
  (b) => (b * b * Math.sqrt(plant.youngModulus / plant.density) * radius) / (2 * plant.height ** 2),
);

function make(sway, { plants = [plant], flow, rate = rate60, memory } = {}) {
  return new PhysicsWorld({ rate, gravity: [0, 0, 0], memory }).add(sway, { plants, flow });
}

function near(actual, expected, bound) {
  assert.ok(Math.abs(actual - expected) <= bound, `${actual} versus ${expected}, absolute error bound ${bound}`);
}

// The port's position, time and medium density come from the producer.
function flow(medium, density, speed) {
  return {
    medium,
    cell: [0, 0, 0],
    sample(x, y, z, t, out) {
      out.velocity[0] = speed(x, y, z, t);
      out.velocity[1] = 0;
      out.velocity[2] = 0;
      out.density = density;
      out.temperature = 288.15;
      return out;
    },
  };
}

test('PlantSway resolves both analytic cantilever frequencies and conserves free-oscillation energy', async () => {
  const sway = await PlantSway.load();
  const amplitude = 0.009;
  const world = make(sway, { plants: [{ ...plant, initialDisplacement: [amplitude, 0, 0, amplitude] }] });
  const frequencies = sway.dryFrequencies(0);
  const dt = 1 / rateOf(world.levelOf(sway.id));
  const time = 1;
  world.advance(60);
  const motion = sway.readSway();
  for (const [mode, at] of [
    [0, 0],
    [1, 3],
  ]) {
    const w = omega[mode];
    // The uniform beam makes the 16-node quadrature error smaller than floating-point accumulation.
    near(frequencies[mode], w / (2 * Math.PI), 2e-12);
    // Two-point midpoint rotates free state by theta each step. Its phase error per step is at most (w dt)^3 / 12.
    const theta = 2 * Math.atan((w * dt) / 2);
    near(motion[at], amplitude * Math.cos((time * theta) / dt), 3e-13);
    near(motion[at], amplitude * Math.cos(time * w), (amplitude * time * w ** 3 * dt ** 2) / 12);
    const normalizedEnergy = motion[at] ** 2 + (motion[at + 4] / w) ** 2;
    near(normalizedEnergy, amplitude ** 2, amplitude ** 2 * 1e-10);
  }
  near(motion[1], 0, 1e-13);
  near(motion[2], 0, 1e-13);
  assert.deepEqual(sway.sample(0, 0), { displacement: [0, 0], velocity: [0, 0], slope: [0, 0] });
});

test('PlantSway produces the same hash on plain and shared world memory', async () => {
  const breeze = flow('air', 1.225, (x, _y, _z, t) => 2 + sin(t - x));
  const solvers = await Promise.all([PlantSway.load(), PlantSway.load()]);
  const worlds = solvers.map((sway, i) => make(sway, { flow: breeze, memory: worldMemory(i === 1) }));
  for (const world of worlds) world.advance(60);
  assert.deepEqual(solvers[0].readSway(), solvers[1].readSway());
  assert.equal(worlds[0].hash(), worlds[1].hash());
});

test('PlantSway receives the same gust later at roots farther downwind', async () => {
  const sway = await PlantSway.load();
  const gust = flow('air', 1.225, (x, _y, _z, t) => {
    const age = t - x / 10;
    return age > 0 && age < 0.8 ? 5 * (1 - cos((2 * Math.PI * age) / 0.8)) : 0;
  });
  const world = make(sway, { plants: [plant, { ...plant, root: [10, 0, 0] }], flow: gust });
  world.advance(15);
  const early = sway.readSway();
  assert.ok(early[0] > 0, 'grass responds to the leading gust');
  assert.equal(early[PLANT_SWAY_WORDS], 0, 'the wind has not reached the downwind grass');
  world.advance(75);
  assert.ok(sway.readSway()[PLANT_SWAY_WORDS] > 0, 'the same front reaches the second root');
});

test('PlantSway resolves alternating horizontal motion from an Airy field below the water surface', async () => {
  const sway = await PlantSway.load();
  const k = Math.PI / 8;
  const w = Math.sqrt(9.80665 * k);
  const wave = flow('water', 1025, (x, y, _z, t) => 0.06 * w * exp(k * y) * cos(k * x - w * t));
  const reed = { ...plant, root: [0, -2, 0], dampingRatio: 0.18, addedMassCoefficient: 1 };
  const world = make(sway, { plants: [reed, { ...reed, root: [0, -8, 0] }], flow: wave });
  const minima = [0, 0];
  const maxima = [0, 0];
  for (let f = 1; f <= 360; f++) {
    world.advance(f);
    for (const i of [0, 1]) {
      const x = sway.sample(i, reed.height).displacement[0];
      minima[i] = Math.min(minima[i], x);
      maxima[i] = Math.max(maxima[i], x);
    }
  }
  assert.ok(minima[0] < 0 && maxima[0] > 0);
  assert.ok(minima[1] < 0 && maxima[1] > 0);
  // Linear inertia source attenuates by exp(-6k), and drag by the square of that factor. The latter and
  // transients depend on relative speed. The shallower reed therefore moves farther in both directions here.
  assert.ok(maxima[0] > maxima[1] && minima[0] < minima[1]);
});

test('PlantSway transfers an impact at its height and distinguishes rupture from uprooting', async () => {
  const sway = await PlantSway.load();
  const rootStress = (plant.youngModulus * radius * beta[0] ** 2 * 0.01) / plant.height ** 2;
  const secondMoment = (Math.PI * radius ** 4) / 4;
  const rootMoment = (plant.youngModulus * secondMoment * beta[0] ** 2 * 0.01) / plant.height ** 2;
  const moving = { ...plant, initialDisplacement: [0.01, 0, 0, 0] };
  const world = make(sway, {
    plants: [plant, { ...moving, ruptureStress: 0.5 * rootStress }, { ...moving, anchorMoment: 0.5 * rootMoment }],
  });
  const impulse = sway.projectImpulse(0, plant.height, 0, 0.1);
  assert.deepEqual(impulse, [0, 0.1, 0, 0.1]);
  assert.deepEqual(sway.projectImpulse(0, 0, 0, 0.1), [0, 0, 0, 0]);
  let region;
  let memory;
  world.add(
    {
      describe: () => ({
        id: 'plant-impact',
        rate: 0,
        stableRate: () => 0,
        fields: [{ field: sway.impulseField, access: 'accumulate' }],
      }),
      init(host) {
        memory = host.memory;
        region = host.allocate('plant-impact', 3 * PLANT_IMPULSE_WORDS * 8, 'f64', 1);
      },
      importPorts() {},
      step(context) {
        const words = regionWords(memory, region);
        words.fill(0);
        if (context.tick === 0) words.set(impulse);
      },
      exportPorts: (tick) => [{ field: sway.impulseField.name, region, tick, cell: [0, 0, 0] }],
      stateRegions: () => [region],
      extraState: () => [],
    },
    {},
  );
  world.advance(1);
  const out = sway.readSway();
  assert.equal(out[0], 0);
  assert.ok(out[1] > 0);
  assert.equal(out[PLANT_SWAY_WORDS + 9], 1);
  assert.equal(out[2 * PLANT_SWAY_WORDS + 9], 2);
  assert.equal(out[PLANT_SWAY_WORDS + 10], 0);
  assert.equal(out[2 * PLANT_SWAY_WORDS + 10], 0);
  const dt = 1 / rateOf(world.levelOf(sway.id));
  const phase = 2 * Math.atan((omega[0] * dt) / 2);
  near(out[PLANT_SWAY_WORDS + 11], rootMoment * Math.cos(phase), 2e-10);
  world.advance(60);
  assert.deepEqual(sway.readSway().slice(PLANT_SWAY_WORDS), out.slice(PLANT_SWAY_WORDS));
});

test('PlantSway travelling wind and water motion replay exactly on the dyadic world clock', async () => {
  const air = flow('air', 1.225, (x, _y, _z, t) => 1 + 0.3 * sin(4 * t - x));
  const water = flow('water', 1000, (x, _y, _z, t) => 0.3 * sin(4 * t - x));
  for (const medium of [air, water]) {
    const solvers = await Promise.all(Array.from({ length: 5 }, () => PlantSway.load()));
    const makeRate = (rate) => make(solvers.shift(), { rate, flow: medium });
    frameRateIndependent(makeRate);
    seekEqualsContinuous(() => makeRate({ num: 24, den: 1 }));
  }
});

test('PlantSway refuses malformed geometry and fluid samples before changing modal state', async () => {
  const sway = await PlantSway.load();
  assert.throws(() => make(sway, { plants: [{ ...plant, tipDiameter: -0.001 }] }), /diameter/i);
  const invalid = flow('air', -1, () => 3);
  const world = make(sway, { flow: invalid });
  const initial = sway.readSway();
  assert.throws(() => world.advance(1), /finite velocity and nonnegative density/);
  assert.deepEqual(sway.readSway(), initial);
});

test('PlantRigidSolver transfers a rigid impact, activates a detached trunk and restores both body states', async () => {
  await Physics.load();
  const sway = await PlantSway.load();
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] });
  const colliders = { shape: 'box', halfExtents: [0.04, 0.8, 0.04], offset: [0, 0.8, 0] };
  const standing = physics.addBody(null, { type: 'fixed', colliders });
  const released = physics.addBody(null, { colliders });
  released.enabled = false;
  const ball = physics.addBody(null, {
    position: [-0.45, 1.2, 0],
    colliders: { shape: 'sphere', radius: 0.12, mass: 1 },
  });
  ball.setLinearVelocity([4, 0, 0]);
  const rigid = new PlantRigidSolver(sway);
  const world = make(sway, { plants: [{ ...plant, anchorMoment: 0.5 }] })
    .add(rigid, {
      physics,
      plants: [{ root: plant.root, height: plant.height, standing, fragments: [{ body: released, baseHeight: 0 }] }],
    })
    .couple([rigid.id, sway.id], 'staggered');
  world.advance(2);
  const before = world.takeSnapshot();
  world.advance(20);
  assert.equal(sway.readSway()[9], 2, 'contact uproots the stem');
  assert.equal(standing.enabled, false, 'the rooted proxy has been removed from contacts');
  assert.equal(released.enabled, true, 'the moving trunk has entered the rigid world');
  assert.ok(released.position[0] > 0, 'the moving trunk inherits the direction of the collision');
  const after = world.hash();
  world.restoreSnapshot(before.bytes);
  assert.equal(standing.enabled, true);
  assert.equal(released.enabled, false);
  world.advance(20);
  assert.equal(world.hash(), after, 'the impact and release replay exactly');
});
