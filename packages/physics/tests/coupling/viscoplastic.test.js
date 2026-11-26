import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import {
  VISCOPLASTIC_INLET_WORDS,
  VISCOPLASTIC_LAYOUT,
  VISCOPLASTIC_WORDS,
  ViscoplasticSolver,
} from '../../dist/viscoplastic.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const shape = { columns: 4, rows: 4, width: 1.2, depth: 1.2, centre: [0.6, 0.6] };
const bedHeight = (x) => 0.24 - 0.1 * x;
const peak = 0.0006;
const field = { name: 'test-mud-inlet', kind: 'particleSet', quantity: 'volumeRate', unit: 'SI', centring: 'particle' };

class Inlet {
  constructor(flow) {
    this.flow = flow;
  }
  describe() {
    return { id: 'inlet-hydrograph', rate: 0, stableRate: () => 0, fields: [{ field, access: 'write' }] };
  }
  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('discharge-row', VISCOPLASTIC_INLET_WORDS * 8, 'f64', VISCOPLASTIC_LAYOUT);
  }
  importPorts() {}
  step({ tick }) {
    const up = Math.max(0, 1 - Math.abs(tick - 6) / 6) * this.flow;
    regionWords(this.memory, this.region).set([0.26, 0.41, 0.53 + 0.04 * (tick % 3), 0.15, -0.08, 0.02, up]);
  }
  exportPorts(tick) {
    return [{ field: field.name, region: this.region, tick, cell: [0, 0, 0] }];
  }
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

async function factory(count) {
  const loaded = await Promise.all(
    Array.from({ length: count }, () => ViscoplasticSolver.load({ terrain: shape, inlet: field })),
  );
  return (fps = rate, memory, discharge = peak) => {
    const mud = loaded.shift();
    const bed = new TerrainBed();
    const elevations = Float64Array.from({ length: 25 }, (_, i) => bedHeight(0.3 * Math.floor(i / 5)));
    const world = new PhysicsWorld({ rate: fps, memory })
      .add(mud, {
        cells: [6, 6, 6],
        spacing: 0.2,
        capacity: 24,
        density: 1600,
        bulkModulus: 8000,
        shearModulus: 320,
        yieldStress: 20,
        consistency: 10,
        exponent: 0.65,
        solventViscosity: 3,
        friction: 0.02,
      })
      .add(bed, { ...shape, elevations })
      .add(new Inlet(discharge), {});
    return Object.assign(world, { mud });
  };
}

test('ViscoplasticSolver: PA-60 time-varying discharge carries exact mass across a real TerrainBed', async () => {
  const make = await factory(2);
  const world = make();
  const empty = make(rate, undefined, 0);
  world.advance(60);
  empty.advance(60);
  const b = world.mud.budget;
  const reference = (peak * 6) / 60;
  const bound = 64 * Number.EPSILON * reference;
  assert.ok(Math.abs(b.injectedReferenceVolume - reference) <= bound);
  assert.ok(Math.abs(b.storedReferenceVolume + b.escapedReferenceVolume - reference) <= bound);
  assert.notEqual(world.hash(), empty.hash());
  assert.equal(empty.mud.budget.activePoints, 0);
  assert.equal(b.activePoints, 11);
  let y = Infinity;
  let x = 0;
  for (let i = 0; i < b.activePoints; i++) {
    const point = world.mud.sample(i);
    assert.ok(point.present);
    const [px, py] = point.position;
    x = Math.max(x, px);
    y = Math.min(y, py);
    assert.ok(py >= bedHeight(px) - 2 ** -24, 'the bed field is rounded to f32 and supports the material');
  }
  assert.ok(x > 0.26 + 0.1);
  assert.ok(y < 0.41);
  const port = world.mud.exportPorts(60)[0];
  assert.equal(port.region.layout, VISCOPLASTIC_LAYOUT);
  assert.equal(port.region.byteLength, 8 * VISCOPLASTIC_WORDS * 24);
});

test('ViscoplasticSolver: the feed and real terrain contact replay on all frame rates and memory variants', async () => {
  const make = await factory(7);
  frameRateIndependent(make);
  seekEqualsContinuous(make);
  const memory = worldMemory(false);
  const shared = worldMemory(true);
  assert.ok(memory.buffer instanceof ArrayBuffer);
  assert.ok(shared.buffer instanceof SharedArrayBuffer);
  const a = make(rate, memory);
  const b = make(rate, shared);
  a.advance(60);
  b.advance(60);
  assert.equal(a.hash(), b.hash());
});
