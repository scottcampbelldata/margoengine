import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { GroundwaterSolver } from '../../dist/groundwater.js';
import { ShallowWaterSolver } from '../../dist/hydro.js';
import { RainfallRunoff } from '../../dist/runoff.js';
import { isShared, PhysicsWorld, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const grid = (columns = 1, rows = 1) => ({ columns, rows, width: columns, depth: rows, centre: [0, 0] });

function near(actual, expected, tolerance = 2e-12) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected} ± ${tolerance}`);
}

function make(solver, params, options = {}) {
  const world = new PhysicsWorld({ rate: options.rate ?? rate, memory: options.memory });
  world.add(solver, { grid: grid(), bottom: 0, surface: 6, ...params });
  return world;
}

function total({ storage, recharge, boundaryIn, boundaryOut, spring, seepage }) {
  return storage + boundaryOut + spring + seepage - recharge - boundaryIn;
}

test('a sealed aquifer rises by recharge divided by specific yield', async () => {
  const aquifer = await GroundwaterSolver.load();
  const world = make(aquifer, { initialHead: 1, specificYield: 0.25, recharge: 0.02 });
  const initial = aquifer.budget.storage;
  world.advance(60);
  near(aquifer.read(0, 0).head, 1 + 0.02 / 0.25);
  near(aquifer.budget.recharge, 0.02);
  near(total(aquifer.budget), initial);
});

test('fixed aquifer edges reproduce the exact steady Dupuit solution and discharge', async () => {
  const aquifer = await GroundwaterSolver.load();
  const shape = grid(4);
  const left = 4;
  const right = 2;
  const k = 0.3;
  const analytic = (x) => Math.sqrt(left * left + ((right * right - left * left) * x) / shape.width);
  const initial = Array.from({ length: shape.columns }, (_, i) => analytic(i + 0.5));
  const world = make(aquifer, {
    grid: shape,
    initialHead: initial,
    specificYield: 0.3,
    conductivity: k,
    sideHeads: { minX: left, maxX: right },
  });
  const storage = aquifer.budget.storage;
  world.advance(60);
  for (let i = 0; i < shape.columns; i++) near(aquifer.read(i, 0).head, initial[i]);
  const q = (k * (left * left - right * right) * shape.depth) / (2 * shape.width);
  near(aquifer.budget.boundaryIn, q);
  near(aquifer.budget.boundaryOut, q);
  near(total(aquifer.budget), storage);
});

test('conductivity across a contact combines both materials by resistance', async () => {
  const aquifer = await GroundwaterSolver.load();
  const world = make(aquifer, {
    grid: grid(2),
    initialHead: [3, 1],
    specificYield: 0.25,
    conductivityX: [1, 3],
    conductivityZ: 0,
  });
  world.advance(1);
  const conductance = ((3 + 1) / 2) * (2 / (1 / 1 + 1 / 3));
  const difference = (3 - 1) / (1 + (2 * conductance) / (60 * 0.25));
  near(aquifer.read(0, 0).head, 2 + 0.5 * difference);
  near(aquifer.read(1, 0).head, 2 - 0.5 * difference);
  near(aquifer.budget.storage, 1);
});

test('a spring opens within the implicit step and follows the measured head law', async () => {
  const aquifer = await GroundwaterSolver.load();
  const yieldFactor = 0.4;
  const conductance = 0.2;
  const level = 1;
  const initialHead = 0.5;
  const add = 0.4;
  const world = make(aquifer, {
    initialHead,
    specificYield: yieldFactor,
    springElevation: level,
    springConductance: conductance,
    recharge: add,
    secondsPerSecond: 60,
  });
  assert.equal(aquifer.read(0, 0).spring, 0);
  world.advance(1);
  const head = (yieldFactor * initialHead + add + conductance * level) / (yieldFactor + conductance);
  const volume = conductance * (head - level);
  near(aquifer.read(0, 0).head, head);
  near(aquifer.read(0, 0).spring, 60 * volume);
  near(aquifer.budget.spring, volume);
  near(total(aquifer.budget), yieldFactor * initialHead);
});

test('surface seepage becomes resolved shallow-water volume', async () => {
  const world = new PhysicsWorld({ rate });
  const terrain = new TerrainBed();
  const aquifer = await GroundwaterSolver.load({ followTerrain: true });
  const shape = grid();
  world.add(terrain, { ...shape, elevations: [2, 1, 1, 3] });
  world.add(aquifer, { grid: shape, bottom: 0, surface: 2, initialHead: 0.9, specificYield: 0.5, recharge: 0.1 });
  const water = new ShallowWaterSolver('water', aquifer.shallowInput());
  world.add(water, { bed: terrain.bed });
  world.advance(60);
  near(aquifer.read(0, 0).head, 1);
  near(aquifer.budget.seepage, 0.05);
  near(water.budget.inflow, aquifer.budget.seepage);
  near(water.volume(), aquifer.budget.seepage);
  near(total(aquifer.budget), 0.45);
});

test('recharge leaving the HYDRO-02 soil is conserved in the aquifer', async () => {
  const runoff = await RainfallRunoff.load();
  const aquifer = await GroundwaterSolver.load({ rechargeField: runoff.rechargeField });
  const world = make(aquifer, { initialHead: 1, specificYield: 0.25 });
  world.add(runoff, {
    nx: 1,
    nz: 1,
    dx: 1,
    downstream: [-1],
    soilCapacity: 0.12,
    initialSaturation: 0.5,
    drainage: 0.3,
    conductivity: 0,
    slope: 0,
  });
  world.advance(60);
  const recharge = 0.06 * (1 - Math.exp(-0.3));
  near(runoff.budget.recharge, recharge);
  near(aquifer.budget.recharge, recharge);
  near(aquifer.budget.storage, 0.25 + recharge);
});

test('dry cells wet and bank seepage and boundary exports cannot spend absent water', async () => {
  const aquifer = await GroundwaterSolver.load();
  const shape = grid(3);
  const bottom = [1, 0, 2];
  const world = make(aquifer, {
    grid: shape,
    bottom,
    surface: [2.1, 5, 3],
    initialHead: [2, 0, 2],
    conductivity: 0.8,
    specificYield: 0.4,
    secondsPerSecond: 60,
    springElevation: [1, 3, 2],
    springConductance: [0.05, 1, 10],
    sideHeads: { maxX: -1 },
  });
  const original = total(aquifer.budget);
  world.advance(1);
  assert.ok(aquifer.read(1, 0).thickness > 0);
  for (let frame = 2; frame <= 18; frame++) {
    world.advance(frame);
    for (let x = 0; x < shape.columns; x++) assert.ok(aquifer.read(x, 0).head >= bottom[x]);
    near(total(aquifer.budget), original);
  }
});

test('sub-millimetre storage additions survive a large elevation datum', async () => {
  const aquifer = await GroundwaterSolver.load();
  const bottom = 1e6;
  const world = make(aquifer, {
    bottom,
    surface: bottom + 2,
    initialHead: bottom,
    recharge: 1e-11,
    specificYield: 0.2,
  });
  world.advance(60);
  near(aquifer.read(0, 0).thickness, 5e-11, 64 * Number.EPSILON * 5e-11);
  near(aquifer.budget.storage, 1e-11, 64 * Number.EPSILON * 1e-11);
});

test('groundwater uses the world clock and restores identical state in both memory modes', async () => {
  const plain = await GroundwaterSolver.load();
  const shared = await GroundwaterSolver.load();
  const params = {
    grid: grid(3, 2),
    initialHead: [3, 2, 1, 2, 2, 2],
    recharge: [0.1, 0, 0, 0, 0.01, 0],
    conductivity: 0.2,
    springElevation: 1.5,
    springConductance: 0.01,
    sideHeads: { maxZ: 1 },
  };
  const create = (frameRate, memory, solver = plain) => make(solver, params, { rate: frameRate, memory });
  frameRateIndependent(create);
  seekEqualsContinuous(() => create(rate), { at: 19, frames: 60 });
  const plainMemory = worldMemory(false);
  const sharedMemory = worldMemory(true);
  assert.equal(isShared(plainMemory), false);
  assert.equal(isShared(sharedMemory), true);
  const a = create(rate, plainMemory);
  const b = create(rate, sharedMemory, shared);
  a.advance(60);
  b.advance(60);
  assert.equal(a.hash(), b.hash());
});

test('invalid aquifer parameters identify the repair', async () => {
  const aquifer = await GroundwaterSolver.load();
  assert.throws(() => make(aquifer, { specificYield: 0 }), /specific yield.*supply/);
  assert.throws(() => make(aquifer, { initialHead: 10 }), /initial head.*supply/);
  assert.throws(() => make(aquifer, { conductivity: [1, 2] }), /X conductivity length.*one value/);
  assert.throws(() => aquifer.read(0, 0), /add it to a PhysicsWorld/);
});
