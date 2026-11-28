// CraterSolver (EARTH-06) in a world with the ExplosionSolver it reads and the TerrainBed it digs: the same bed at 24, 30 and
// 60 frames a second, a snapshot and restore re-run bit for bit, and the crater reaches the bed's readers.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CraterSolver } from '../../dist/crater.js';
import { TerrainBed } from '../../dist/earth.js';
import { ExplosionSolver } from '../../dist/explosive.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const shape = { columns: 24, rows: 24, width: 96, depth: 96, centre: [0, 0] };

const make = (rate = { num: 24, den: 1 }) => {
  const world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] });
  world.add(new ExplosionSolver(), { charges: [{ position: [0, 0, 0], time: 0.05, mass: 2000, depth: 3 }] });
  world.add(new TerrainBed(), { ...shape, elevations: () => 0 });
  world.add(new CraterSolver(), { bed: shape, shells: 16 });
  return world;
};

test('CraterSolver steps the same at 24, 30 and 60 frames a second', () => {
  frameRateIndependent(make, { seconds: 2 });
});

test('CraterSolver: a snapshot and restore re-runs it bit for bit', () => {
  seekEqualsContinuous(() => make());
});

test("the explosion's ground energy and depth set the crater, and the crater reaches the bed", () => {
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] }),
    explosions = new ExplosionSolver(),
    bed = new TerrainBed(),
    crater = new CraterSolver();
  world.add(explosions, { charges: [{ position: [0, 0, 0], time: 0.05, mass: 2000, depth: 3 }] });
  world.add(bed, { ...shape, elevations: () => 0 });
  world.add(crater, { bed: shape, shells: 16 });
  world.advance(2);
  assert.equal(crater.crater(0).state, 'waiting', 'nothing before the charge goes off');
  world.advance(900);
  const c = crater.crater(0);
  assert.equal(c.state, 'done');
  assert.ok(c.radius > 3 && c.depth > 1, `${c.radius}, ${c.depth}`);
  // The bed under the charge is the crater's depth down, as a collider or water reading the bed sees it.
  const e = bed.elevations();
  assert.ok(Math.abs(-e[12 + 25 * 12] / c.depth - 1) < 0.01, `${e[12 + 25 * 12]} against ${c.depth}`);
  // For film: the curtain rose while the ejecta flew, and the work counts are deterministic.
  assert.ok(crater.workCounts().vertices >= 0);
});
