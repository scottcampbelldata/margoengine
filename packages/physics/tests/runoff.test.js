import assert from 'node:assert/strict';
import test from 'node:test';
import { PrecipitationField } from '../../weather/dist/precipitation.js';
import { RainfallRunoff } from '../dist/runoff.js';
import { PhysicsWorld } from '../dist/world.js';

test('the public runoff entry takes the liquid rate from the real ATMO-04 precipitation contract', async () => {
  const precipitation = new PrecipitationField({ rate: 3.6, snowTemperature: 240 });
  const solver = await RainfallRunoff.load();
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, {
    nx: 1,
    nz: 1,
    dx: 10,
    downstream: [-1],
    slope: 0,
    conductivity: 0,
    precipitation,
  });
  world.advance(60);
  const rate = precipitation.sample(5, 0, 5, 0).rain.rate / 3.6e6;
  const tolerance = 60 * 8 * Number.EPSILON * rate;
  assert.ok(rate > 0);
  assert.ok(Math.abs(solver.read(0, 0).depth - rate) <= tolerance);
  assert.ok(Math.abs(solver.budget.rain - rate * 100) <= tolerance * 100);
  assert.equal(solver.read(0, 0).outflow, 0);
});
