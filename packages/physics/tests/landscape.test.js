import assert from 'node:assert/strict';
import test from 'node:test';
import { BED_FIELD, TerrainBed, bedVertexAreas } from '../dist/earth.js';
import { LandscapeEvolution } from '../dist/landscape.js';
import { PhysicsWorld } from '../dist/world.js';

// The public `@margoengine/physics/landscape` entry. The solver's numerics are checked in coupling/landscape.test.js;
// this file holds what a user of the entry meets first: loading, the documented defaults, the fields it publishes and
// the errors for input that cannot work.
const grid = { columns: 1, rows: 1, width: 1, depth: 1, centre: [0, 0] };
const rate = { num: 60, den: 1 };
const JULIAN_YEAR = 31_557_600;

function attach(landscape, heights, params = {}) {
  const world = new PhysicsWorld({ rate });
  const terrain = new TerrainBed();
  world.add(terrain, { ...grid, elevations: heights });
  world.add(landscape, { grid, ...params });
  return { world, terrain };
}

function near(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} versus ${expected} (tolerance ${tolerance})`);
}

test('the entry loads, names its output fields from the id and reads the bed it is placed beside', async () => {
  const model = await LandscapeEvolution.load({ id: 'hills' });
  assert.deepEqual(
    [model.dischargeField, model.incisionField, model.sedimentField].map((f) => [f.name, f.unit]),
    [
      ['hills:discharge', 'm^3/s'],
      ['hills:incision', 'm/s'],
      ['hills:sediment', 'm^3/s'],
    ],
  );
  const description = model.describe();
  assert.equal(description.id, 'hills');
  const uses = description.fields.map((use) => `${use.field.name} ${use.access}`);
  assert.deepEqual(uses, [
    `${BED_FIELD.name} read`,
    'bedChange accumulate',
    'hills:discharge write',
    'hills:incision write',
    'hills:sediment write',
  ]);
  assert.equal((await LandscapeEvolution.load()).describe().id, 'landscape');
});

test('the default rainfall of one metre a Julian year gathers in the pit of a closed catchment', async () => {
  const model = await LandscapeEvolution.load();
  // Vertices are z-fast: [(0,0), (0,1), (1,0), (1,1)], so the bed falls to the last one, which has no way out.
  attach(model, [3, 2, 1, 0]).world.advance(1);
  const area = bedVertexAreas(grid).reduce((sum, a) => sum + a, 0);
  const rain = area / JULIAN_YEAR;
  near(model.read(1, 1).discharge, rain, 1e-15);
  assert.ok(model.read(0, 0).discharge < model.read(1, 1).discharge);
  const sample = model.read(1, 1);
  assert.equal(sample.alluvium.length, 1);
  assert.ok(sample.alluvium[0] >= 0);
  const { elapsed, exported, alluvium } = model.budget;
  near(elapsed, 1 / 60, 1e-15);
  assert.deepEqual(exported, [0]);
  near(alluvium, 0.1 * area, 1e-6); // the default alluvial depth is 0.1 m over the bed's area
});

test('uplift raises the terrain by the volume the budget reports, in geological time', async () => {
  const model = await LandscapeEvolution.load();
  const { world, terrain } = attach(model, [1, 1, 1, 1], {
    rainfall: 0,
    erodibility: 0,
    hillslopeDiffusivity: 0,
    thermalDiffusivity: 0,
    uplift: 1e-3,
    secondsPerSecond: 1000,
  });
  world.advance(60);
  const { elapsed, uplift } = model.budget;
  const area = bedVertexAreas(grid).reduce((sum, a) => sum + a, 0);
  // One second of world time is 1000 geological seconds here, and uplift acts over those.
  near(elapsed, 1000, 1e-9);
  near(uplift, 1e-3 * elapsed * area, 1e-12);
  // The bed takes a step's change on the next step, so one more frame lifts every vertex by the uplift so far.
  world.advance(61);
  for (const height of terrain.elevations()) near(height, 1 + uplift / area, 1e-9);
});

test('a landscape that is not in a world, or given input that cannot work, names the repair', async () => {
  const model = await LandscapeEvolution.load();
  assert.throws(() => model.budget, /add it to a PhysicsWorld/);
  assert.throws(() => model.read(0, 0), /add it to a PhysicsWorld/);
  assert.throws(() => model.init({}, {}), /needs a bed grid/);
  assert.throws(() => attach(model, [0, 0, 0, 0], { grains: [{ diameter: 0.001, fraction: 0 }] }), /positive fraction/);
  assert.throws(() => attach(model, [0, 0, 0, 0], { rainfall: [1, 2] }), /4 vertex values/);

  const placed = await LandscapeEvolution.load();
  attach(placed, [0, 0, 0, 0]);
  assert.throws(() => placed.read(2, 0), /Invalid landscape vertex/);
  assert.throws(() => placed.read(0.5, 0), /integer column and row/);

  const reason = new Error('stop the landscape load');
  await assert.rejects(() => LandscapeEvolution.load({ signal: AbortSignal.abort(reason) }), /stop the landscape load/);
});
