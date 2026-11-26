import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { GranularFlowSolver } from '../../dist/granular-flow.js';
import { SEISMIC_LAYOUT, SeismicGround } from '../../dist/seismic.js';
import { TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const shape = { columns: 21, rows: 7, width: 21, depth: 14, centre: [10.5, 7] };
const origin = [170, -24, 62];
const rate = { num: 60, den: 1 };
const depth = Float64Array.from({ length: shape.columns * shape.rows }, (_, i) => {
  const x = i % shape.columns;
  const z = Math.floor(i / shape.columns);
  return x >= 3 && x <= 6 && z >= 2 && z <= 4 ? 1 : 0;
});

async function make(rate, { shared = false, ridge = true } = {}) {
  const bed = new TerrainBed();
  const flow = await GranularFlowSolver.load({ liveTerrain: true });
  const elevations = (x) => (ridge && x >= 10 && x <= 12 ? 4 : 0.5 - 0.125 * x);
  const world = new PhysicsWorld({ rate, memory: worldMemory(shared) })
    .add(bed, { ...shape, elevations }, origin)
    .add(flow, { grid: shape, depth, friction: 0.065 }, origin);
  return { flow, world, bed };
}

test('EARTH-02 reads the real TerrainBed ridge and passes mass through the descending corridor', async () => {
  const raised = await make(rate);
  const open = await make(rate, { ridge: false });
  const startingMass = raised.flow.mass;
  raised.world.advance(180);
  open.world.advance(180);
  const crest = raised.flow.sample(10, 3);
  assert.equal(crest.bedElevation, 4);
  assert.equal(crest.depth, 0);
  assert.ok(open.flow.sample(10, 3).depth > 0.1);
  const massTolerance = 180 * 8 * Number.EPSILON * startingMass;
  assert.ok(Math.abs(raised.flow.mass - startingMass) <= massTolerance);
  assert.ok(Math.abs(open.flow.mass - startingMass) <= massTolerance);
  assert.deepEqual(raised.bed.grid.cell, origin);
});

test('EARTH-02 registered terrain simulation is cadence independent and checkpoint complete', async () => {
  const rates = await Promise.all([24, 30, 60].map((num) => make({ num, den: 1 })));
  frameRateIndependent(({ num }) => rates.find((x) => x.world.rate.num === num).world);
  const runs = await Promise.all([make({ num: 24, den: 1 }), make({ num: 24, den: 1 }, { shared: true })]);
  seekEqualsContinuous(() => runs.shift().world);
});

async function depositional(fps = rate, options = {}) {
  const { shared = false, depositToTerrain = true, speed = 0, ...rest } = options;
  const grid = { columns: 3, rows: 2, width: 3, depth: 4, centre: [0, 0] };
  const bed = new TerrainBed();
  const flow = await GranularFlowSolver.load({ liveTerrain: true, depositToTerrain });
  const world = new PhysicsWorld({ rate: fps, memory: worldMemory(shared) })
    .add(bed, { ...grid, elevations: new Float32Array(12) })
    .add(flow, {
      grid,
      depth: 0.5,
      density: 300,
      friction: 0.6,
      velocity: [speed, 0],
      ...(depositToTerrain ? { deposition: { density: 400, stopSpeed: 0.2 } } : {}),
      ...rest,
    });
  if (depositToTerrain) world.couple(['granularFlow', 'bed'], 'staggered');
  return { flow, world, bed };
}

test('EARTH-02 a frozen patch makes the exact TerrainBed volume and returns its elevation to the flow', async () => {
  const depth = [0.25, 0, 0, 0, 0, 0];
  const { bed, flow, world } = await depositional(rate, { depth });
  const initial = flow.mass;
  assert.equal(initial, 150);
  world.advance(1);
  assert.equal(flow.mass, 0);
  assert.equal(flow.depositBudget.mass, initial);
  assert.equal(flow.depositBudget.horizontalKineticEnergy, 0);
  assert.deepEqual(flow.depositBudget.impulse, [0, 0]);
  assert.equal(bed.volume(), 150 / 400);
  assert.equal(bed.refusedVolume(), 0);
  // One cell contributes a sixth to each of the two far vertices and twice that to each
  // vertex on the diagonal, so a neighbour's larger support area dilutes its height.
  const elevations = bed.elevations();
  assert.equal(elevations[0], 0.1875);
  assert.equal(elevations[1], 0.125);
  assert.equal(elevations[3], 0.125);
  const centralSupport = 1 / 3 + 2 / 3 + 2 / 3 + 1 / 3;
  assert.equal(elevations[4], 0.0625 / centralSupport);
  assert.equal(elevations[2], 0);
  world.advance(2);
  const expectedBedMean = (0.1875 + 2 * 0.125 + 2 * 0.125 + 0.03125) / 6;
  assert.ok(Math.abs(flow.sample(0, 0).bedElevation - expectedBedMean) <= 4 * Number.EPSILON * expectedBedMean);
  assert.equal(bed.volume(), 150 / 400);
});

test('EARTH-02 mixed deposit and mobile momentum balances the fixed-bed impulse and energy receipts', async () => {
  const deposit = await depositional(rate, { speed: 0.1 });
  const moving = await depositional(rate, { speed: 0.1, depositToTerrain: false });
  deposit.world.advance(1);
  moving.world.advance(1);
  assert.equal(deposit.flow.mass, 0);
  assert.equal(deposit.flow.depositBudget.mass, moving.flow.mass);
  let impulse = 0;
  let kinetic = 0;
  for (let z = 0; z < 2; z++) {
    for (let x = 0; x < 3; x++) {
      const { depth, discharge } = moving.flow.sample(x, z);
      const mass = 300 * 2 * depth;
      impulse += (mass * discharge[0]) / depth;
      kinetic += (mass * (discharge[0] / depth) ** 2) / 2;
    }
  }
  assert.ok(Math.abs(impulse) > 0);
  assert.ok(Math.abs(deposit.flow.depositBudget.impulse[0] - impulse) <= 64 * Number.EPSILON * impulse);
  assert.ok(Math.abs(deposit.flow.depositBudget.horizontalKineticEnergy - kinetic) <= 64 * Number.EPSILON * kinetic);
});

test('EARTH-02 mobile material above the arrest speed stays separate from the bed', async () => {
  const w = await depositional(rate, { depth: 0.5, speed: 2 });
  const initial = w.flow.mass;
  w.world.advance(1);
  assert.equal(w.flow.mass, initial);
  assert.equal(w.flow.depositBudget.mass, 0);
  assert.equal(w.bed.volume(), 0);
});

test('EARTH-02 two-way registered deposition replays with the evolving bed across the world clock', async () => {
  const rates = await Promise.all([24, 30, 60].map((num) => depositional({ num, den: 1 })));
  frameRateIndependent(({ num }) => rates.find((x) => x.world.rate.num === num).world);
  const pair = await Promise.all([
    depositional({ num: 24, den: 1 }),
    depositional({ num: 24, den: 1 }, { shared: true }),
  ]);
  // The first completed frame allocates the framework's field-sum region.
  seekEqualsContinuous(() => pair.shift().world, { at: 1 });
});

test('EARTH-02 recovered critical depths distinguish arrested and flowing Vallée de la Sionne profiles', async () => {
  // Sovilla et al. (2010), Figure 17. Two independently reported stopping curves for
  // the dense snow of avalanches 816 and 817 bracket the deposit at a 27 degree slope.
  for (const [low, high, thickness] of [
    [21.4, 34.7, 0.31],
    [22.5, 34.4, 0.19],
  ]) {
    const grid = { columns: 13, rows: 3, width: 13, depth: 3, centre: [0, 0] };
    const angle = (27 * Math.PI) / 180;
    const mu = (degrees) => Math.tan((degrees * Math.PI) / 180);
    const stopDepth = thickness * Math.log((mu(high) - mu(low)) / (mu(27) - mu(low)));
    for (const factor of [0.9, 1.1]) {
      const elevation = new TerrainBed();
      const flow = await GranularFlowSolver.load({ depositToTerrain: true });
      const world = new PhysicsWorld({ rate })
        .add(elevation, { ...grid, elevations: (x) => -Math.tan(angle) * x })
        .add(flow, {
          grid,
          density: 300,
          depth: (factor * stopDepth) / Math.cos(angle),
          roughness: {
            thickStopAngle: low,
            thinStopAngle: high,
            thickStartAngle: low,
            thickness,
            beta: 0.136,
            curve: 'exponential',
          },
          deposition: { density: 400, stopSpeed: 1e-9 },
        })
        .couple(['granularFlow', 'bed'], 'staggered');
      const initial = flow.mass;
      world.advance(1);
      if (factor < 1) {
        assert.equal(flow.sample(6, 1).depth, 0);
        assert.ok(Math.abs(flow.depositBudget.mass - initial) <= 256 * Number.EPSILON * initial);
        assert.ok(Math.abs(elevation.requestedVolume() * 400 - initial) <= 256 * Number.EPSILON * initial);
      } else {
        assert.equal(flow.depositBudget.mass, 0);
        assert.ok(flow.sample(6, 1).discharge[0] > 0);
      }
    }
  }
});

test('EARTH-02 a symmetric peak with zero net discharge remains free to spread downhill', async () => {
  const grid = { columns: 5, rows: 3, width: 5, depth: 3, centre: [0, 0] };
  const depth = Array.from({ length: 15 }, (_, i) => (i % 5 === 2 ? 1 : 0));
  const flow = await GranularFlowSolver.load({ depositToTerrain: true });
  const world = new PhysicsWorld({ rate })
    .add(new TerrainBed(), { ...grid, elevations: new Float32Array(24) })
    .add(flow, { grid, depth, friction: 0.6, deposition: { stopSpeed: 0.2 } })
    .couple(['granularFlow', 'bed'], 'staggered');
  world.advance(1);
  const peak = flow.sample(2, 1);
  assert.ok(peak.depth > 0.9);
  assert.ok(Math.abs(peak.discharge[0]) <= Number.EPSILON);
});

const shoreGrid = { columns: 28, rows: 3, width: 28, depth: 3, centre: [14, 1.5] };
const shoreAltitude = (x) => Math.max(-1.25, 0.5 - x * 0.125);

async function coastal(fps = rate, powered = true, shared = false) {
  const slide = await GranularFlowSolver.load({ liveTerrain: true, marineDisplacement: powered });
  const sea = await TsunamiSolver.load({ sources: powered ? [slide.seaSourceField] : [] });
  const depth = Array.from({ length: 84 }, (_, i) => (i % 28 < 3 ? 0.8 : 0));
  const bathymetry = Array.from({ length: 84 }, (_, i) => (shoreAltitude(i % 28) + shoreAltitude((i % 28) + 1)) / 2);
  const world = new PhysicsWorld({ rate: fps, memory: worldMemory(shared) })
    .add(new TerrainBed(), { ...shoreGrid, elevations: shoreAltitude })
    .add(slide, { grid: shoreGrid, depth, friction: 0.07, velocity: [1.5, 0] })
    .add(sea, { cells: [28, 3], spacing: 1, bathymetry });
  return { world, slide, sea };
}

test('EARTH-02 a natural granular release generates a real SEA-06 wave with conserved signed occupancy', async () => {
  const coupled = await coastal();
  const baseline = await coastal(rate, false);
  const releasedMass = coupled.slide.mass;
  coupled.world.advance(180);
  baseline.world.advance(180);
  assert.ok(coupled.sea.sample(12, 1).height > 0.05);
  assert.equal(baseline.sea.sample(12, 1).height, 0);
  const { occupiedVolume, displacedVolume } = coupled.slide.marineBudget;
  assert.ok(displacedVolume > 0.5);
  assert.equal(occupiedVolume, displacedVolume);
  const wave = coupled.sea.budget;
  assert.ok(Math.abs(wave.admittedSourceVolume - displacedVolume) <= 1024 * Number.EPSILON * displacedVolume);
  assert.equal(wave.unplacedSourceVolume, 0);
  assert.ok(
    Math.abs(wave.storedVolume - wave.initialVolume - displacedVolume) <= 1024 * Number.EPSILON * wave.initialVolume,
  );
  assert.ok(Math.abs(coupled.slide.mass - releasedMass) <= 1024 * Number.EPSILON * releasedMass);
});

test('EARTH-02 coastal source history replays through the actual water receiver', async () => {
  const runs = await Promise.all([coastal({ num: 24, den: 1 }), coastal({ num: 24, den: 1 }, true, true)]);
  seekEqualsContinuous(() => runs.shift().world);
});

test('EARTH-02 already submerged material only displaces its net change when it consolidates', async () => {
  const grid = { columns: 4, rows: 3, width: 4, depth: 3, centre: [2, 1.5] };
  const slide = await GranularFlowSolver.load({ depositToTerrain: true, marineDisplacement: true });
  const sea = await TsunamiSolver.load({ sources: [slide.seaSourceField] });
  const bed = new TerrainBed();
  const world = new PhysicsWorld({ rate })
    .add(bed, { ...grid, elevations: () => -2 })
    .add(slide, { grid, depth: 0.5, density: 300, deposition: { density: 400 } })
    .add(sea, { cells: [4, 3], spacing: 1, bathymetry: -2 })
    .couple(['granularFlow', 'bed'], 'staggered');
  world.advance(2);
  assert.equal(slide.marineBudget.occupiedVolume, 4.5);
  assert.equal(slide.marineBudget.displacedVolume, -1.5);
  // Twelve per-cell signed contributions are summed after area projection.
  assert.ok(Math.abs(sea.budget.admittedSourceVolume + 1.5) <= 12 * Number.EPSILON * 1.5);
  assert.equal(slide.depositBudget.mass, 1800);
  assert.equal(slide.mass, 0);
  assert.equal(bed.requestedVolume(), 4.5);
});

function constantGround(ax, ay) {
  let region;
  const field = {
    name: 'prescribedGround',
    kind: 'particleSet',
    centring: 'particle',
    quantity: 'ground motion',
    unit: 'm, m/s, m/s^2',
  };
  return {
    field,
    describe: () => ({
      id: 'groundForGranularTest',
      fields: [{ field, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    }),
    init(host) {
      region = host.allocate('motion', 16 * 8, 'f64', SEISMIC_LAYOUT);
      new Float64Array(host.memory.buffer, region.byteOffset, 16).set([
        -50,
        0,
        0,
        0,
        0,
        ax,
        ay,
        0,
        50,
        0,
        0,
        0,
        0,
        ax,
        ay,
        0,
      ]);
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: [0, 0, 0] }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

test('EARTH-02 the seismic port crosses the Coulomb yield only at the effective normal load', async () => {
  const g = 9.81;
  const shape = { columns: 41, rows: 3, width: 20.5, depth: 1.5, centre: [0, 0] };
  const mu = 0.2;
  for (const [groundX, groundY] of [
    [-1, 0],
    [-3, 0],
    [3, 0],
    [-1.5, 0],
    [-1.5, -4],
  ]) {
    const ground = constantGround(groundX, groundY);
    const grain = await GranularFlowSolver.load({ groundField: ground.field });
    const world = new PhysicsWorld({ rate, gravity: [0, -g, 0] })
      .add(ground, null)
      .add(grain, { grid: shape, depth: 1, friction: mu, turbulence: Infinity });
    world.advance(1);
    const sample = grain.sample(20, 1);
    const excess = Math.max(0, Math.abs(groundX) - mu * (g + groundY));
    const acceleration = Math.sign(-groundX) * excess;
    const width = shape.width / shape.columns;
    // Integrating an interface pressure from h to h - a*dx/g gives the first-order
    // hydrostatic reconstruction error a² dx / (2gh) on this flat uniform layer.
    const discretization = (width * excess * excess) / (2 * g);
    assert.ok(Math.abs(60 * sample.discharge[0] - acceleration) <= discretization + 512 * Number.EPSILON * g);
    assert.equal(sample.depth, 1);
    assert.equal(sample.discharge[1], 0);
  }
});

async function shaking(fps = rate, shared = false) {
  const ground = await SeismicGround.load();
  const slide = await GranularFlowSolver.load({ groundField: ground.groundField });
  const grid = { columns: 39, rows: 3, width: 39, depth: 3, centre: [19.5, 0] };
  const world = new PhysicsWorld({ rate: fps, memory: worldMemory(shared) })
    .add(ground, {
      width: 39,
      depth: 18,
      spacing: [1, 1],
      absorbingCells: 0,
      material: { density: 2200, compressionalSpeed: 35, shearSpeed: 20 },
      initialVelocity: (x) => [0.1 * Math.sin((2 * Math.PI * x) / 16), 0],
    })
    .add(slide, { grid, depth: 0.25, friction: 0.015, turbulence: Infinity });
  return { world, ground, slide };
}

test('EARTH-02 uses real EARTH-08 pulses and conserves mass through checkpoint replay', async () => {
  const { slide, world, ground } = await shaking();
  const mass = slide.mass;
  world.advance(12);
  assert.notEqual(ground.motion(19).acceleration[0], 0);
  assert.ok(Math.abs(slide.sample(19, 1).discharge[0]) > 0.001);
  assert.ok(Math.abs(slide.mass - mass) <= 128 * Number.EPSILON * mass);
  const runs = await Promise.all([shaking({ num: 24, den: 1 }), shaking({ num: 24, den: 1 }, true)]);
  seekEqualsContinuous(() => runs.shift().world, { frames: 24, at: 6, cap: 333 });
});
