// The terrain bed's coupling checks (PA-37): `TerrainBed` and a writer that erodes it through `bedChange`, held to the
// harness: the same bed at 24, 30 and 60 frames a second, and a seek equal to a continuous run.
import test from 'node:test';
import { BED_CHANGE_FIELD, BedChange, TerrainBed } from '../../dist/earth.js';
import { PhysicsWorld } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const shape = { columns: 8, rows: 6, width: 16, depth: 12, centre: [0, 0] };

/** A writer that lowers each vertex by its own small amount each tick. */
function erosion() {
  let change;
  return {
    describe: () => ({
      id: 'erosion',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: BED_CHANGE_FIELD, access: 'accumulate' }],
    }),
    init(host) {
      change = new BedChange(host, shape);
    },
    step() {
      const d = change.deltas;
      for (let i = 0; i < d.length; i++) d[i] = -1e-4 * (1 + (i % 5)) - 1 / 3e7;
    },
    iterate() {
      this.step();
    },
    exportPorts: (tick) => [change.port(tick)],
    importPorts() {},
    stateRegions: () => [change.state],
    extraState: () => [],
  };
}

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate })
    .add(new TerrainBed(), { ...shape, elevations: (x, z) => 1 + 0.1 * x - 0.05 * z, bedrock: () => -0.2 })
    .add(erosion(), {});

test('TerrainBed: the same bed at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('TerrainBed: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
