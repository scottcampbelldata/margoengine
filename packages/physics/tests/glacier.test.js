import assert from 'node:assert/strict';
import test from 'node:test';

import { GlacierSolver } from '../dist/glacier.js';
import { PhysicsWorld } from '../dist/world.js';

const rate = { num: 60, den: 1 };
const gravity = 9.80665;
const rhoIce = 917;
const rhoWater = 1000;
const timeScale = 60;

async function glacier(options) {
  const ice = await GlacierSolver.load();
  const world = new PhysicsWorld({ rate, gravity: [0, -gravity, 0] }).add(ice, {
    nx: 1,
    nz: 1,
    dx: 1,
    bed: [0],
    timeScale,
    ...options,
  });
  return { ice, world };
}

function near(actual, expected, epsilon) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected} by more than ${epsilon}`);
}

test('two closed columns match the exact lagged backward-Euler Glen flux', async () => {
  const hFace = 9.5;
  const coefficient = 0.25 / hFace ** 5;
  const softness = coefficient / (0.4 * (rhoIce * gravity) ** 3);
  const { ice, world } = await glacier({ nx: 2, bed: [0, 0], thickness: [10, 9], softness });
  world.advance(1);
  const flow = 0.25 / (1 + 2 * 0.25);
  const error = 16 * Number.EPSILON * 10;
  near(ice.sample(0, 0).thickness, 10 - flow, error);
  near(ice.sample(1, 0).thickness, 9 + flow, error);
  near(ice.budget.ice, 19, error);
  assert.equal(ice.sample(0, 0).velocity[1], 0);
});

test('oblique linear slopes match the closed-form depth-averaged Glen velocity', async () => {
  const dx = 10;
  const dz = 20;
  const thickness = 100;
  const gx = -0.05;
  const gz = -0.1;
  const softness = 2.4e-24;
  const bed = [0, gx * dx, gz * dz, gx * dx + gz * dz];
  const { ice } = await glacier({ nx: 2, nz: 2, dx, dz, bed, thickness: bed.map(() => thickness), softness });
  const factor = -0.4 * softness * (rhoIce * gravity) ** 3 * thickness ** 4 * (gx * gx + gz * gz);
  const expected = [factor * gx, factor * gz];
  for (let z = 0; z < 2; z++) {
    for (let x = 0; x < 2; x++) {
      const velocity = ice.sample(x, z).velocity;
      for (const [axis, value] of expected.entries()) near(velocity[axis], value, 24 * Number.EPSILON * value);
    }
  }
});
test('a lake-flat free surface over nonflat topography is stationary', async () => {
  const bed = [-5, -2, 2, 5, 6, -7];
  const thickness = bed.map((height) => 9 - height);
  const { ice, world } = await glacier({ nx: 3, nz: 2, dx: 39, dz: 82, bed, thickness });
  world.advance(120);
  for (let i = 0; i < bed.length; i++) {
    const cell = ice.sample(i % 3, Math.floor(i / 3));
    assert.equal(cell.thickness, thickness[i]);
    assert.equal(cell.crevasseDepth, 0);
    assert.ok(cell.velocity.every((component) => component === 0));
  }
});

test('two-dimensional flow is positive and conservative even when the lagged face matrix is stiff', async () => {
  const { ice, world } = await glacier({
    nx: 3,
    nz: 3,
    dx: 20,
    dz: 30,
    bed: [18, 0, -3, 17, 1, -4, 16, 2, -5],
    thickness: [0, 0, 0, 0, 12, 0, 0, 0, 0],
    timeScale: 1e13,
  });
  world.advance(8);
  const middle = ice.sample(1, 1);
  assert.ok(middle.thickness < 12);
  assert.ok(ice.sample(2, 1).thickness > 0);
  assert.ok(ice.sample(1, 0).thickness > 0);
  for (let i = 0; i < 9; i++) assert.ok(ice.sample(i % 3, Math.floor(i / 3)).thickness >= 0);
  const volume = 12 * 20 * 30;
  near(ice.budget.ice, volume, 8 * 48 * Number.EPSILON * volume);
});

test('positive surface extension produces Nye depth, and its water column increases it by hydrostatic ratio', async () => {
  const bed = [-0.53, -0.63, -0.83];
  const thickness = [1, 1, 1];
  const wet = 0.25;
  const dry = await glacier({ nx: 3, bed, thickness });
  const watered = await glacier({ nx: 3, bed, thickness, crevasseWater: wet });
  const gradient = (bed[1] - bed[2]) ** 3 - ((bed[0] - bed[2]) / 2) ** 3;
  const depth = 2 * Math.cbrt(0.5 * gradient);
  near(dry.ice.sample(2, 0).crevasseDepth, depth, 64 * Number.EPSILON * depth);
  near(watered.ice.sample(2, 0).crevasseDepth, depth + (rhoWater / rhoIce) * wet, 64 * Number.EPSILON);
  assert.equal(dry.ice.sample(0, 0).icefall, 0);
});

test('a positive grounded freeboard releases under the marine criterion, while a dry cliff needs full penetration', async () => {
  const front = { nx: 4, bed: [-0.53, -0.63, -0.83, -1.1], thickness: [1, 1, 1, 0] };
  const [sea, dry, wet] = await Promise.all([
    glacier({ ...front, boundary: [0, 0, 0, 1] }),
    glacier({ ...front, boundary: [0, 0, 0, 2] }),
    glacier({ ...front, boundary: [0, 0, 0, 2], crevasseWater: [0, 0, 0.8, 0] }),
  ]);
  const freeboard = front.bed[2] + front.thickness[2];
  assert.ok(freeboard > 0);
  assert.ok(front.thickness[2] > -front.bed[2] * (rhoWater / rhoIce));
  for (const { world } of [sea, dry, wet]) world.advance(1);
  assert.ok(sea.ice.sample(2, 0).calving > 0);
  assert.equal(sea.ice.sample(2, 0).icefall, 0);
  assert.equal(dry.ice.sample(2, 0).icefall, 0);
  assert.ok(dry.ice.sample(2, 0).thickness > 0);
  assert.ok(wet.ice.sample(2, 0).icefall > 0);
  assert.equal(wet.ice.sample(2, 0).calving, 0);
  for (const { ice } of [sea, dry, wet]) {
    const { ice: remaining, calved, fallen } = ice.budget;
    near(remaining + calved + fallen, 3, 24 * Number.EPSILON);
  }
});

test('a wet front at flotation releases without requiring spurious tensile flow', async () => {
  const { ice, world } = await glacier({ nx: 2, bed: [-0.94, -2], thickness: [1, 0], boundary: [0, 1] });
  world.advance(1);
  assert.equal(ice.sample(0, 0).crevasseDepth, 0);
  assert.equal(ice.sample(0, 0).calving, 1);
  assert.equal(ice.budget.ice, 0);
  world.advance(2);
  assert.equal(ice.sample(0, 0).calving, 0);
  assert.equal(ice.budget.calved, 1);
});

test('melt is ice-limited, converts density, and accumulates down a two-dimensional D8 outlet', async () => {
  const dx = 2;
  const dz = 3;
  const { ice, world } = await glacier({
    nx: 2,
    nz: 2,
    dx,
    dz,
    bed: [9, 5, 3, 0],
    thickness: [1, 2, 3, 4],
    accumulation: 0.125,
    melt: 16,
  });
  world.advance(1);
  const { melted, accumulation } = ice.budget;
  assert.equal(ice.budget.ice, 0);
  assert.equal(accumulation, 4 * 0.125 * dx * dz);
  assert.equal(melted, 10 * dx * dz + accumulation);
  assert.equal(ice.sample(0, 0).meltwater, 0);
  assert.equal(ice.sample(1, 0).meltwater, 0);
  assert.equal(ice.sample(0, 1).meltwater, 0);
  near(ice.sample(1, 1).meltwater / 60, (melted * rhoIce) / rhoWater, 12 * Number.EPSILON * melted);
});

test('invalid inputs provide a repair and an aborted load preserves its reason', async () => {
  await assert.rejects(glacier({ nx: 2, bed: [0] }), /one value per grid cell/);
  await assert.rejects(glacier({ boundary: [4] }), /use 0 for ground/);
  await assert.rejects(glacier({ boundary: [1] }), /submerged bed/);
  await assert.rejects(glacier({ timeScale: -1 }), /finite value/);
  const reason = new Error('cancel patch');
  await assert.rejects(GlacierSolver.load({ signal: AbortSignal.abort(reason) }), (error) => error === reason);
});
