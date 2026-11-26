import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { ShallowWaterSolver, SURFACE_WATER_FIELD } from '../../dist/hydro.js';
import { SedimentTransport, sedimentSettlingSpeed } from '../../dist/sediment.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const density = 2650;
const waterDensity = 1000;
const porosity = 0.4;
const g = 9.80665;
const shape = (columns, rows) => ({ columns, rows, width: columns, depth: rows, centre: [0, 0] });

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} against ${expected} ± ${tolerance}`);
}

function publisher(field, type, words) {
  let host;
  let region;
  return {
    describe: () => ({ id: field.name, fields: [{ field, access: 'write' }], rate: 0, stableRate: () => 0 }),
    init(h) {
      host = h;
      region = host.allocate(field.name, words.length * (type === 'f32' ? 4 : 8), type, 1);
      regionWords(host.memory, region).set(words);
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: [0, 0, 0] }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

function setup(sediment, grid, flow, params = {}, options = {}) {
  const world = new PhysicsWorld({ rate: options.rate ?? rate, memory: options.memory });
  const terrain = new TerrainBed();
  world.add(terrain, { ...grid, elevations: () => 0, bedrock: options.bedrock });
  world.add(sediment, { grid, ...params });
  world.add(publisher(SURFACE_WATER_FIELD, 'f32', flow), {});
  return { world, terrain, sediment };
}

function total(sediment) {
  const { bed, suspended, suspendedOut, bedloadOut } = sediment.budget;
  return bed + suspended + suspendedOut + bedloadOut;
}

test('van Rijn clear-water settling matches the Stokes, transition and turbulent formulas', () => {
  const c = (density / waterDensity - 1) * g;
  const nu = 1e-6;
  const fine = 35e-6;
  const medium = 0.5e-3;
  const coarse = 1.2e-3;
  const stokes = (c * fine * fine) / (18 * nu);
  const transition = (10 * nu * (Math.sqrt(1 + (0.01 * c * medium ** 3) / (nu * nu)) - 1)) / medium;
  const turbulent = 1.1 * Math.sqrt(c * coarse);
  near(sedimentSettlingSpeed(fine), stokes, 8 * Number.EPSILON * stokes);
  near(sedimentSettlingSpeed(medium), transition, 8 * Number.EPSILON * transition);
  near(sedimentSettlingSpeed(coarse), turbulent, 8 * Number.EPSILON * turbulent);
});

test('Exner deposition into a quiescent basin conserves grain mass and approaches its settling solution', async () => {
  const solver = await SedimentTransport.load();
  const initial = 20;
  const fall = 0.2;
  const { world, terrain } = setup(solver, shape(1, 1), [1, 0, 0], {
    mobileDepth: 0.1,
    settlingVelocity: fall,
    suspendedMass: initial,
  });
  const start = total(solver);
  world.advance(120);
  const expected = initial * Math.exp(-2 * fall);
  near(solver.read(0, 0).suspended, expected, 120 * 8 * Number.EPSILON * initial);
  near(solver.read(0, 0).concentration, expected, 120 * 8 * Number.EPSILON * initial);
  near(total(solver), start, 120 * 8 * Number.EPSILON * start);
  const deposit = (initial - expected) / (density * (1 - porosity));
  near(terrain.volume(), deposit, 120 * 8 * Number.EPSILON * deposit);
  assert.equal(terrain.refusedVolume(), 0);
});

test('Wong–Parker bedload follows its closed rating and leaves through an open end', async () => {
  const solver = await SedimentTransport.load();
  const diameter = 0.0006;
  const roughness = 0.03;
  const speed = 1;
  const { world, terrain } = setup(
    solver,
    shape(1, 1),
    [1, speed, 0],
    {
      grainDiameter: diameter,
      roughness,
      settlingVelocity: 0,
      open: { maxX: true },
      mobileDepth: 0.15,
    },
    { bedrock: () => -0.15 },
  );
  const initial = total(solver);
  world.advance(120);
  const tau = waterDensity * g * roughness * roughness * speed * speed;
  const theta = tau / ((density - waterDensity) * g * diameter);
  const rating = 3.97 * (theta - 0.0495) ** 1.5 * Math.sqrt((density / waterDensity - 1) * g * diameter ** 3);
  near(solver.read(0, 0).shearStress, tau, 8 * Number.EPSILON * tau);
  near(solver.read(0, 0).bedload, rating, 32 * Number.EPSILON * rating);
  near(solver.budget.bedloadOut, 2 * rating * density, 120 * 8 * Number.EPSILON * rating * density);
  near(terrain.volume(), (-2 * rating) / (1 - porosity), 120 * 12 * Number.EPSILON * rating);
  near(total(solver), initial, 120 * 8 * Number.EPSILON * initial);
  assert.equal(terrain.refusedVolume(), 0);
});

test('reference concentration and composite Rouse integration reproduce the analytic P = 1 depth mean', async () => {
  const solver = await SedimentTransport.load();
  const grain = 0.0003;
  const roughness = 0.03;
  const tau = waterDensity * g * roughness ** 2;
  const settling = 0.4 * Math.sqrt(tau / waterDensity);
  const { world } = setup(solver, shape(1, 1), [1, 1, 0], {
    grainDiameter: grain,
    roughness,
    settlingVelocity: settling,
    mobileDepth: 0.1,
  });
  world.advance(60);
  const theta = tau / ((density - waterDensity) * g * grain);
  const stage = (theta - 0.0495) / 0.0495;
  const reduced = grain * (((density / waterDensity - 1) * g) / 1e-12) ** (1 / 3);
  const reference = (0.015 * grain * stage ** 1.5) / (0.01 * reduced ** 0.3);
  const target = density * reference * (0.01 / 0.99) * Math.log(100);
  const expected = target * -Math.expm1(-settling);
  // For the analytic integrand 1/z - 1, on each doubling panel the 16th derivative's bound
  // gives a relative integral error below 2e-9 for the eight-point Gauss rule.
  near(solver.read(0, 0).concentration, expected, 2e-9 * expected);
});

test('upwind suspended flux advects an inlet pulse with the conservative discrete solution', async () => {
  const solver = await SedimentTransport.load();
  const speed = 1.25;
  const initial = 10;
  const { world } = setup(solver, shape(2, 1), [1, speed, 0, 1, speed, 0], {
    roughness: 0,
    settlingVelocity: 0,
    suspendedMass: [initial, 0],
    mobileDepth: 0,
  });
  world.advance(60);
  const upstream = initial * (1 - speed / 60) ** 60;
  near(solver.read(0, 0).suspended, upstream, 60 * 12 * Number.EPSILON * initial);
  near(solver.read(1, 0).suspended, initial - upstream, 60 * 12 * Number.EPSILON * initial);
  near(solver.concentrationAt(0.5, 0), initial - upstream, 60 * 12 * Number.EPSILON * initial);
  assert.equal(solver.concentrationAt(3, 3), 0);
});

test('near-bank velocity asymmetry erodes the outside of a bend and builds the inside bar', async () => {
  const roots = { name: 'bank-root-strength', kind: 'uniformGrid', quantity: 'pressure', unit: 'Pa', centring: 'cell' };
  const free = await SedimentTransport.load();
  const rooted = await SedimentTransport.load({ rootCohesion: roots });
  const grid = shape(2, 5);
  const flow = Array.from({ length: 10 }, (_, i) => {
    const j = Math.floor(i / 2);
    return j === 0 || j === 4 ? [0, 0, 0] : [1, 4 - j, 0];
  }).flat();
  const params = { bankErodibility: 0.02, criticalShields: 1e3, settlingVelocity: 0, mobileDepth: 0.1 };
  const moving = setup(free, grid, flow, params);
  const fixed = setup(rooted, grid, flow, params);
  fixed.world.add(publisher(roots, 'f64', new Float64Array(10).fill(1000)), {});
  const before = total(free);
  moving.world.advance(60);
  fixed.world.advance(60);
  assert.ok(moving.terrain.bed.sample(-0.5, -2.25).elevation < 0);
  assert.ok(moving.terrain.bed.sample(0.5, 2.25).elevation > 0);
  assert.equal(fixed.terrain.volume(), 0);
  const expected = 4 * 0.02 * (1 - porosity) * density;
  near(free.budget.bankTransfer, expected, 60 * 8 * Number.EPSILON * expected);
  near(moving.terrain.volume(), 0, 60 * 16 * Number.EPSILON);
  near(total(free), before, 60 * 16 * Number.EPSILON * before);
});

function actualWater(solver, fps = { num: 24, den: 1 }, memory) {
  const grid = shape(3, 2);
  const bed = new TerrainBed();
  const flood = new ShallowWaterSolver();
  const world = new PhysicsWorld({ rate: fps, memory })
    .add(bed, { ...grid, elevations: () => 0 })
    .add(flood, { bed: bed.bed, depth: 0.65, velocity: () => [1.45, 0], sides: { maxX: 'open' } })
    .add(solver, { grid, mobileDepth: 0.1, open: { maxX: true } });
  return { world, bed, flood, solver };
}

test('production shallow water advects opaque sediment and responds to the evolving bed', async () => {
  const sediment = await SedimentTransport.load();
  const control = await SedimentTransport.load();
  const moving = actualWater(sediment);
  const fixed = actualWater(control);
  // Compare to a world with the same flow columns and a non-erodible bed.
  const grid = shape(3, 2);
  const immobile = new TerrainBed();
  const flood = new ShallowWaterSolver();
  const reference = new PhysicsWorld({ rate: { num: 24, den: 1 } })
    .add(immobile, { ...grid, elevations: () => 0, bedrock: () => 0 })
    .add(flood, { bed: immobile.bed, depth: 0.65, velocity: () => [1.45, 0], sides: { maxX: 'open' } });
  const start = total(sediment);
  moving.world.advance(30);
  fixed.world.advance(30);
  reference.advance(30);
  assert.equal(moving.world.hash(), fixed.world.hash());
  assert.ok(sediment.budget.bedloadOut > 0);
  assert.ok(sediment.budget.suspended > 0);
  assert.ok(moving.bed.volume() < 0);
  assert.notEqual(moving.flood.sample(0.5, 0.25).depth, flood.sample(0.5, 0.25).depth);
  near(total(sediment), start, 90 * 64 * Number.EPSILON * start);
  const port = moving.world.fields.port(sediment.concentrationField.name);
  assert.equal(regionWords(moving.world.memory, port.region)[0], sediment.read(0, 0).concentration);
});

test('real flow, bank and bed fields replay across frame rates, snapshots and both memory modes', async () => {
  const solvers = await Promise.all(Array.from({ length: 7 }, () => SedimentTransport.load()));
  const make = (fps, memory) => actualWater(solvers.shift(), fps, memory).world;
  frameRateIndependent((fps) => make(fps));
  seekEqualsContinuous(() => make());
  const plain = make(rate, worldMemory(false));
  const shared = make(rate, worldMemory(true));
  plain.advance(90);
  shared.advance(90);
  assert.equal(plain.hash(), shared.hash());
});
