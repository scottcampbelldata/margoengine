import assert from 'node:assert/strict';
import test from 'node:test';
import { BED_CHANGE_FIELD, BedChange, TerrainBed } from '../../dist/earth.js';
import { GlacierSolver } from '../../dist/glacier.js';
import { IcebergSolver } from '../../dist/iceberg.js';
import { TSUNAMI_LAYOUT, TSUNAMI_WORDS, TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const rate = { num: 60, den: 1 };
const rock = {
  nx: 4,
  nz: 1,
  dx: 1,
  bed: [-0.53, -0.63, -0.83, -2],
  thickness: [1, 1, 1, 0],
  boundary: [0, 0, 0, 1],
  timeScale: 60,
};
const bottomField = {
  name: 'natural-motion',
  kind: 'uniformGrid',
  quantity: 'bedElevation',
  unit: 'm',
  centring: 'cell',
};

function near(actual, expected, tol) {
  assert.ok(Math.abs(actual - expected) <= tol, `${actual} vs ${expected}, bound ${tol}`);
}

function closes(tsunami, steps) {
  const b = tsunami.budget;
  near(
    b.storedVolume,
    b.initialVolume + b.admittedSourceVolume - b.boundaryExportVolume,
    64 * steps * Number.EPSILON * b.initialVolume,
  );
}

class BottomShift {
  constructor(values) {
    this.values = values;
  }
  describe() {
    return {
      id: 'wet-displacement-source',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: bottomField, access: 'write' }],
    };
  }
  init(host) {
    this.memory = host.memory;
    this.region = host.allocate('seabed-altitude', 8 * this.values.length, 'f64', TSUNAMI_LAYOUT);
    regionWords(this.memory, this.region).fill(-2);
  }
  importPorts() {}
  step() {
    regionWords(this.memory, this.region).set(this.values);
  }
  exportPorts(tick) {
    return [{ field: bottomField.name, region: this.region, tick, cell: [0, 0, 0] }];
  }
  stateRegions() {
    return [this.region];
  }
  extraState() {
    return [];
  }
}

test('TsunamiSolver: rapid bottom filter has the exact discrete Padé transfer and preserves water volume', async () => {
  const nx = 16;
  const dx = 0.25;
  const initial = -2;
  const mode = (3 * Math.PI) / nx;
  const amplitude = 0.03;
  const filterDepth = 0.5;
  const cosine = Array.from({ length: nx }, (_, i) => Math.cos(mode * (i + 0.5)));
  const tsunami = await TsunamiSolver.load({ bottomField });
  const world = new PhysicsWorld({ rate, gravity: [0, -1e-6, 0] })
    .add(tsunami, { cells: [nx, 1], spacing: dx, bathymetry: initial, bottomFilterDepth: filterDepth })
    .add(new BottomShift(cosine.map((c) => initial + amplitude * c)), {});
  world.advance(1);
  const discrete = (4 * Math.sin(mode / 2) ** 2) / (dx * dx);
  const expected = amplitude / (1 + 0.5 * filterDepth * filterDepth * discrete);
  let measured = 0;
  for (let i = 0; i < nx; i++) measured += (tsunami.sample(i, 0).height * cosine[i] * 2) / nx;
  // HLL diffuses the linear mode over one step. Its standard face bound is
  // 2c*dt/dx times the unattenuated amplitude.
  const diffusion = ((2 * Math.sqrt(1e-6 * 2)) / (60 * dx)) * amplitude;
  near(measured, expected, diffusion + 128 * Number.EPSILON);
  closes(tsunami, 1);
});

const terrainShape = { columns: 8, rows: 2, width: 8, depth: 2, centre: [4, 1] };

class BedMotion {
  describe() {
    return {
      id: 'natural-bed-motion',
      rate: 0,
      stableRate: () => 0,
      fields: [{ field: BED_CHANGE_FIELD, access: 'accumulate' }],
    };
  }
  init(host) {
    this.change = new BedChange(host, terrainShape);
  }
  importPorts() {}
  step({ tick }) {
    this.change.clear();
    if (tick === 1) {
      const rows = terrainShape.rows + 1;
      for (let i = 0; i < rows; i++) this.change.deltas[3 * rows + i] = 0.125;
    }
  }
  exportPorts(tick) {
    return [this.change.port(tick)];
  }
  stateRegions() {
    return [this.change.region];
  }
  extraState() {
    return [];
  }
}

test('TsunamiSolver: actual TerrainBed displacement launches a water wave without a source-volume injection', async () => {
  const tsunami = await TsunamiSolver.load({ terrain: terrainShape });
  const world = new PhysicsWorld({ rate })
    .add(tsunami, { cells: [16, 4], spacing: 0.5, bathymetry: -1 })
    .add(new TerrainBed(), { ...terrainShape, elevations: () => -1 })
    .add(new BedMotion(), {});
  world.advance(6);
  assert.ok(tsunami.sample(5, 1).bed > -1);
  assert.ok(tsunami.sample(4, 1).height > 0);
  assert.equal(tsunami.budget.admittedSourceVolume, 0);
  closes(tsunami, 6);
});

async function factory(count) {
  const lanes = await Promise.all(
    Array.from({ length: count }, async () => {
      const glacier = await GlacierSolver.load();
      const iceberg = await IcebergSolver.load({ calving: glacier.calvingField });
      const tsunami = await TsunamiSolver.load({ sources: [iceberg.wakeSourceField] });
      return { glacier, iceberg, tsunami };
    }),
  );
  return (fps = rate, memory) => {
    const { glacier, tsunami, iceberg } = lanes.shift();
    const world = new PhysicsWorld({ rate: fps, memory })
      .add(tsunami, { cells: [26, 26], spacing: 0.5, bathymetry: -4, origin: [-3, 1] })
      .add(iceberg, { releaseSites: [{ sourceCell: 2, position: [3, 7] }], basalMelt: 0.03 })
      .add(glacier, rock);
    return Object.assign(world, { tsunami, iceberg, glacier });
  };
}

test('TsunamiSolver: real ICE-02 and ICE-03 releases send a conservative long pulse across the bay', async () => {
  const make = await factory(1);
  const world = make();
  assert.equal(world.tsunami.sample(12, 12).height, 0);
  world.advance(15);
  assert.ok(world.glacier.sample(2, 0).calving > 0);
  assert.ok(world.iceberg.budget.calved > 0);
  const plane = [];
  for (let z = 0; z < 26; z++) for (let x = 0; x < 26; x++) plane.push(world.tsunami.sample(x, z).height);
  assert.ok(plane.some((h) => h > 0));
  assert.ok(plane.some((h) => h < 0));
  near(world.tsunami.budget.admittedSourceVolume, 0, 128 * Number.EPSILON * world.iceberg.budget.calved);
  near(world.tsunami.budget.unplacedSourceVolume, 0, 128 * Number.EPSILON * world.iceberg.budget.calved);
  world.advance(90);
  assert.ok(Math.abs(world.tsunami.sample(21, 12).height) > 128 * Number.EPSILON);
  closes(world.tsunami, 90);
  const p = world.tsunami.exportPorts(90)[0];
  assert.equal(p.region.layout, TSUNAMI_LAYOUT);
  assert.equal(p.region.byteLength, TSUNAMI_WORDS * 26 * 26 * 8);
});

test('TsunamiSolver: source and run-up history replay across cadence, restore and memory variants', async () => {
  const make = await factory(7);
  frameRateIndependent(make);
  seekEqualsContinuous(make);
  const plain = worldMemory(false);
  const shared = worldMemory(true);
  assert.ok(plain.buffer instanceof ArrayBuffer);
  assert.ok(shared.buffer instanceof SharedArrayBuffer);
  const a = make(rate, plain);
  const b = make(rate, shared);
  a.advance(90);
  b.advance(90);
  assert.equal(a.hash(), b.hash());
});
