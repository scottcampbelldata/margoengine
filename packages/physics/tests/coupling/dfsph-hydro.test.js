import assert from 'node:assert/strict';
import test from 'node:test';
import { DFSPH_PARCEL_LAYOUT, DFSPH_PARCEL_WORDS, DfsphSolver } from '../../dist/dfsph.js';
import { bedSurface } from '../../dist/earth.js';
import {
  DRY,
  FORCING_WORDS,
  ShallowWaterSolver,
  SURFACE_WATER_FIELD,
  SURFACE_WATER_FORCING_FIELD,
} from '../../dist/hydro.js';
import { PhysicsWorld, regionWords } from '../../dist/world.js';

const RATE = { num: 60, den: 1 };
const AREA = 1;
const DENSITY = 1000;
const POINT = [0.5, 0.5];
const SIDES = { minX: 'periodic', maxX: 'periodic', minZ: 'periodic', maxZ: 'periodic' };
const CELL = [0, 0, 0];

function near(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) <= 64 * Number.EPSILON * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`,
  );
}

function wetCellExchange(liquid, commands) {
  const fields = liquid.parcelFields;
  let requestHost, sourceHost, request, forcing, state;
  const words = (region) => regionWords(sourceHost.memory, region);
  const producer = {
    id: 'wet-cell-requests',
    describe() {
      return {
        id: this.id,
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: SURFACE_WATER_FIELD, access: 'read' },
          { field: fields.requests, access: 'write' },
        ],
      };
    },
    init(host) {
      requestHost = host;
      request = host.allocate('wet-cell-parcel', DFSPH_PARCEL_WORDS * 8, 'f64', DFSPH_PARCEL_LAYOUT);
    },
    step({ inputs, tick }) {
      const record = regionWords(requestHost.memory, request);
      record.fill(0);
      const command = commands[tick];
      if (!command) return;
      const [h, hu, hv] = regionWords(requestHost.memory, inputs.get(SURFACE_WATER_FIELD.name).region);
      const volume = liquid.particleVolume;
      if (command === 'emit') {
        // The donor reserves a whole volume while leaving both Runge–Kutta stages wet.
        if (h - volume / AREA <= DRY) return;
        record.set([
          tick + 1,
          -1,
          POINT[0],
          1,
          POINT[1],
          volume,
          DENSITY * volume * (hu / h),
          0,
          DENSITY * volume * (hv / h),
        ]);
      } else record.set([tick + 1, command.row, 0, 0, 0, -volume, 0, 0, 0]);
    },
    importPorts() {},
    exportPorts(tick) {
      return [{ field: fields.requests.name, region: request, tick, cell: CELL }];
    },
    stateRegions() {
      return [request];
    },
    extraState() {
      return [];
    },
  };
  const intake = {
    id: 'wet-cell-intake',
    describe() {
      return {
        id: this.id,
        rate: 0,
        stableRate: () => 0,
        fields: [
          { field: fields.receipts, access: 'read' },
          { field: SURFACE_WATER_FORCING_FIELD, access: 'accumulate' },
        ],
      };
    },
    init(host) {
      sourceHost = host;
      forcing = host.allocate('wet-cell-horizontal-source', FORCING_WORDS * 8, 'f64', 1);
      state = host.allocate('wet-cell-discharge-and-vertical-momentum', 2 * 8, 'f64', 1);
    },
    step({ inputs, tick }, dt) {
      const data = words(state);
      const source = words(forcing);
      const receipt = inputs.get(fields.receipts.name);
      assert.equal(receipt.tick, tick);
      const [ticket, , , , , volume, px, py, pz] = words(receipt.region);
      const sign = ticket === tick + 1 ? -1 : 0;
      data[0] = (sign * volume) / dt;
      data[1] += sign * py;
      source[0] = (sign * px) / (DENSITY * AREA * dt);
      source[1] = (sign * pz) / (DENSITY * AREA * dt);
    },
    importPorts() {},
    exportPorts(tick) {
      return [{ field: SURFACE_WATER_FORCING_FIELD.name, region: forcing, tick, cell: CELL }];
    },
    stateRegions() {
      return [forcing, state];
    },
    extraState() {
      return [];
    },
  };
  return {
    producer,
    intake,
    inflow: { position: POINT, discharge: () => words(state)[0] },
    verticalMomentum: () => words(state)[1],
  };
}

async function fixture(depth, particles, commands) {
  const world = new PhysicsWorld({ rate: RATE, gravity: [0, 0, 0] });
  const liquid = await DfsphSolver.load(world.memory, { parcelCapacity: 1 });
  const water = new ShallowWaterSolver();
  const link = wetCellExchange(liquid, commands);
  const bed = bedSurface({ columns: 1, rows: 1, width: 1, depth: 1, centre: POINT }, new Float64Array(4));
  world.add(link.producer, {});
  world.add(liquid, {
    capacity: 1,
    spacing: 0.5,
    viscosity: 0,
    bounds: [
      [-8, -8, -8],
      [8, 8, 8],
    ],
    particles,
  });
  world.add(link.intake, {});
  world.add(water, {
    bed,
    depth,
    velocity: () => [0.25, -0.125],
    density: DENSITY,
    roughness: 0,
    sides: SIDES,
    inflows: [link.inflow],
  });
  world.couple([link.producer.id, liquid.id, link.intake.id, 'water'], 'staggered');
  return { world, water, liquid, link };
}

test('DFSPH and a live shallow-water cell exchange volume and all momentum in the same tick and replay', async () => {
  const start = { position: [0.5, 1, 0.5], velocity: [0.875, 0.375, -0.4375] };
  const { world, water, liquid, link } = await fixture(0.5, [start], [{ row: 0 }, 'emit', 'emit', { row: 0 }]);
  const particleVolume = liquid.particleVolume;
  const volume = water.volume() + liquid.mass / DENSITY;
  const momentum = [234.375, 46.875, -117.1875];
  const check = (expectedDepth) => {
    assert.equal(water.volume(), expectedDepth);
    assert.equal(water.volume() + liquid.mass / DENSITY, volume);
    const velocity = water.sample(...POINT).velocity;
    const particle = liquid.mass === 0 ? CELL : liquid.sample(0).velocity;
    const mass = DENSITY * water.volume();
    near(mass * velocity[0] + liquid.mass * particle[0], momentum[0]);
    near(link.verticalMomentum() + liquid.mass * particle[1], momentum[1]);
    near(mass * velocity[1] + liquid.mass * particle[2], momentum[2]);
  };
  check(0.5);
  world.advance(1);
  check(0.5 + particleVolume);
  near(link.verticalMomentum(), 46.875);
  near(water.sample(...POINT).velocity[0], 0.375);
  near(water.sample(...POINT).velocity[1], -0.1875);
  const snap = world.takeSnapshot();
  world.advance(2);
  check(0.5);
  world.advance(3);
  check(0.5); // The full particle arena refused the second emission. The donor kept its volume and momentum.
  world.advance(4);
  check(0.5 + particleVolume);
  assert.equal(water.budget.inflow, particleVolume);
  const hash = world.hash();
  world.restoreSnapshot(snap.bytes);
  world.advance(4);
  check(0.5 + particleVolume);
  assert.equal(world.hash(), hash);
});

test('a shallow-water donor reserves the last wet depth and declines a transfer that would drain the cell', async () => {
  const { world, water, liquid, link } = await fixture(0.125, [], ['emit', 'emit']);
  world.advance(2);
  assert.equal(water.volume(), liquid.particleVolume);
  assert.equal(water.budget.inflow, 0);
  assert.equal(liquid.mass, 0);
  assert.equal(link.verticalMomentum(), 0);
});
