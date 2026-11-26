import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { GranularFlowSolver } from '../../dist/granular-flow.js';
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
