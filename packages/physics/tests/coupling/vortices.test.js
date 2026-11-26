import assert from 'node:assert/strict';
import test from 'node:test';
import { Hurricane, hollandPressure } from '@margoengine/sky/hurricane';
import { Tornado } from '@margoengine/sky/tornado';
import { TerrainBed } from '../../dist/earth.js';
import { FORCING_WORDS, ShallowWaterSolver, SURFACE_WATER_FORCING_FIELD } from '../../dist/hydro.js';
import { Physics } from '../../dist/index.js';
import { PlantSway } from '../../dist/vegetation.js';
import { StormVortex, VortexForcing, stormWaterDrag } from '../../dist/vortices.js';
import { PhysicsWorld, regionWords, RigidSolver, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const fps = { num: 60, den: 1 };
const dt = 1 / 60;
const close = (actual, expected, tolerance = 64 * Number.EPSILON * Math.max(1, Math.abs(expected))) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected} ± ${tolerance}`);

test('PA-31: a moving visual cyclone publishes the full physical eyewall wind and Holland pressure', () => {
  const visual = new Hurricane({ velocity: [5, 0], pressureDrop: 150, outerEyewall: 120000 });
  const storm = StormVortex.fromHurricane(visual.resolved);
  for (const [x, z, time] of [
    [30000, 0, 0],
    [120000, 0, 150],
    [100000, 30000, 190],
    [0, 0, 0],
  ]) {
    const sky = visual.windAt(x, z, time);
    const physical = storm.sample(x, 10, z, time);
    close(physical.velocity[0], sky.velocity[0]);
    close(physical.velocity[2], sky.velocity[1]);
    const center = visual.centerAt(time);
    close(
      storm.pressureAt(x, z, time),
      100 * hollandPressure(Math.hypot(x - center[0], z - center[1]), visual.resolved),
    );
  }
  assert.ok(visual.weatherAt(30000, 0).wind > 60);
  close(storm.inverseBarometer(0, 0), 15000 / (1025 * 9.80665));
  const tornado = new Tornado({ pressureDrop: 150 });
  const radius = tornado.resolved.rc;
  assert.ok(tornado.windAt(radius, 0).speed > 60);
  assert.equal(tornado.weatherAt(radius, 0).wind, tornado.windAt(radius, 0).speed);
});

test('the Rankine compact pressure and velocity obey cyclostrophic balance', () => {
  const storm = new StormVortex({
    kind: 'tornado',
    compactProfile: 'rankine',
    radius: 50,
    density: 1.15,
    pressureDrop: 3500,
    decay: 1,
    inflow: 0,
    updraft: 0,
  });
  const theta = Math.sqrt(3500 / 1.15);
  close(storm.sample(100, 10, 0, 0).velocity[2], -theta / 2);
  close(storm.pressureDeficit(100, 0), 3500 / 8);
  close(storm.pressureDeficit(0, 0), 3500);
  for (const kind of ['waterspout', 'dustDevil', 'fireWhirl']) {
    const compact = new StormVortex({ kind });
    assert.ok(compact.sample(0, 10, 0, 0).velocity[1] > 0);
    assert.ok(compact.pressureAt(0, 0) < compact.ambientPressure);
    assert.deepEqual(
      compact.sample(10, -1, 0, 0).velocity.map((v) => Math.abs(v)),
      [0, 0, 0],
    );
  }
});

test('the world force has exact mass-averaged drag and moves a real debris body', async () => {
  await Physics.load({ threads: false });
  const gravity = [0, 0, 0];
  const world = new PhysicsWorld({ rate: fps, gravity, memory: worldMemory(false) });
  const physics = new Physics(null, { arena: world.arena, gravity, fixedTimestep: dt });
  try {
    const body = physics.addBody(null, {
      position: [100, 10, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], mass: 4, sensor: true },
    });
    const storm = new StormVortex({
      kind: 'tornado',
      compactProfile: 'rankine',
      radius: 100,
      pressureDrop: 4000,
      density: 1.2,
      inflow: 0,
      updraft: 0,
    });
    const solver = new VortexForcing('wind-load', { rigid: true });
    const capacity = physics.kernel.capacity;
    world.add(new RigidSolver(), { physics, capacity });
    world.add(solver, { vortex: storm, rigid: { capacity, bodies: [{ body: body.row, area: 0.6, forceLimit: 100 }] } });
    world.couple(['rigid', solver.id], 'staggered');
    world.advance(1);
    const record = solver.load();
    const wind = Math.sqrt(4000 / 1.2);
    const force = (0.5 * 1.2 * 0.6 * wind * wind) / (1 + (dt * 0.5 * 1.2 * 0.6 * wind) / 4);
    close(record.force[2], -force);
    assert.equal(record.failed, true);
    close(record.utilization, (0.5 * 1.2 * 0.6 * wind * wind) / 100);
    world.advance(2);
    close(body.linearVelocity[2], (-force * dt) / 4, 8 * 2 ** -24);
  } finally {
    physics.dispose();
  }
});

test('the live shallow-water grid receives both pressure gradient and extreme wind stress', () => {
  const radius = 50,
    rhoWater = 1025,
    width = 4,
    depth = 2,
    spacing = [20, 20],
    origin = [30, -10];
  const storm = new StormVortex({ kind: 'tornado', radius, pressureDrop: 9000, density: 1.2, inflow: 0 });
  const world = new PhysicsWorld({ rate: fps });
  const terrain = new TerrainBed();
  world.add(terrain, {
    columns: width,
    rows: depth,
    width: 80,
    depth: 40,
    centre: [60, 0],
    elevations: new Float64Array(15),
  });
  const water = new ShallowWaterSolver('sea');
  world.add(water, { bed: terrain.bed, depth: 4, density: rhoWater, roughness: 0 });
  const load = new VortexForcing('sea-storm', { water: true });
  world.add(load, { vortex: storm, water: { width, depth, spacing, origin, density: rhoWater, level: 4 } });
  world.couple([water.id, load.id], 'staggered');
  const initial = water.volume();
  world.advance(1);
  const port = load.exportPorts(1).find(({ field }) => field === SURFACE_WATER_FORCING_FIELD.name);
  const values = regionWords(world.memory, port.region);
  const wind = storm.sample(50, 14, -10, dt);
  const speed = Math.hypot(wind.velocity[0], wind.velocity[2]);
  assert.ok(speed > 60);
  const expectedX = (4 * (storm.pressureDeficit(60, -10) - storm.pressureDeficit(40, -10))) / spacing[0];
  const expectedZ = (4 * (storm.pressureDeficit(50, 0) - storm.pressureDeficit(50, -20))) / spacing[1];
  const stress = wind.density * stormWaterDrag(speed) * speed;
  close(values[FORCING_WORDS], (expectedX + stress * wind.velocity[0]) / rhoWater);
  close(values[FORCING_WORDS + 1], (expectedZ + stress * wind.velocity[2]) / rhoWater);
  assert.ok(expectedX < 0 && expectedZ > 0 && wind.velocity[2] < 0);
  assert.equal(stormWaterDrag(120), stormWaterDrag(33));
  world.advance(48);
  assert.ok(Math.hypot(...water.sample(50, -10).velocity) > 0);
  close(water.volume(), initial, 64 * Number.EPSILON * initial);
});

test('CY-14: the gale from the actual visual storm bends a live shore pine', async () => {
  const visual = new Hurricane({ pressureDrop: 85, velocity: [5, 4] });
  const storm = StormVortex.fromHurricane(visual.resolved);
  const pine = { root: [70000, 0, 0], height: 8, baseDiameter: 0.5, density: 700, youngModulus: 1.2e9 };
  const calm = await PlantSway.load();
  const gale = await PlantSway.load();
  const quiet = new PhysicsWorld({ rate: fps }).add(calm, { plants: [pine] });
  const windy = new PhysicsWorld({ rate: fps }).add(gale, { plants: [pine], flow: storm });
  quiet.advance(90);
  windy.advance(90);
  assert.equal(Math.hypot(...calm.readSway().slice(0, 4)), 0);
  assert.ok(Math.hypot(...gale.readSway().slice(0, 4)) > 0);
});

test('moving vortex probe outputs replay across frame rates, seek and both memories', () => {
  const storm = new StormVortex({ kind: 'tornado', translation: [10, 4] });
  const make = (rate, memory) =>
    new PhysicsWorld({ rate, memory }).add(new VortexForcing(), {
      vortex: storm,
      probes: [
        [100, 35, 0],
        [300, 10, 25],
      ],
    });
  frameRateIndependent((rate) => make(rate));
  seekEqualsContinuous(() => make(fps));
  const plain = make(fps, worldMemory(false)),
    shared = make(fps, worldMemory(true));
  plain.advance(60);
  shared.advance(60);
  assert.equal(plain.hash(), shared.hash());
});
