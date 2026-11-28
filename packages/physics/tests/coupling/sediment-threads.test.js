import assert from 'node:assert/strict';
import test from 'node:test';
import { TerrainBed } from '../../dist/earth.js';
import { SURFACE_WATER_FIELD } from '../../dist/hydro.js';
import { SedimentTransport } from '../../dist/sediment.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const far = [932_051_020, -1_254_557_030, 61_771_006];
const ROOT = { name: 'reach-root-strength', unit: 'Pa', kind: 'uniformGrid', quantity: 'pressure', centring: 'cell' };

function source(field, values, type) {
  let region;
  let host;
  return {
    describe: () => ({
      id: field.name + '-source',
      fields: [{ field, access: 'write' }],
      rate: 0,
      stableRate: () => 0,
    }),
    init(owner) {
      host = owner;
      region = host.allocate(field.name, values.byteLength, type, 1);
      regionWords(host.memory, region).set(values);
    },
    step() {},
    importPorts() {},
    exportPorts: (tick) => [{ field: field.name, region, tick, cell: host.cell }],
    stateRegions: () => [region],
    extraState: () => [],
  };
}

async function make(t, threads, shared, columns = 11, rows = 7) {
  const sediment = await SedimentTransport.load({ threads, rootCohesion: ROOT });
  t.after(() => sediment[Symbol.dispose]());
  const grid = { columns, rows, width: columns * 0.8, depth: rows * 1.1, centre: [6, -3] };
  const flow = new Float32Array(3 * columns * rows);
  const pressure = new Float64Array(columns * rows);
  const load = new Float64Array(columns * rows);
  for (let i = 0; i < columns * rows; i++) {
    const x = i % columns;
    const z = Math.floor(i / columns);
    if (z < 1 || z >= rows - 1) continue;
    const h = 0.5 + 0.09 * (z % 3);
    flow.set(
      [h, h * (1.1 + 0.5 * (x % 3) + (z === 1 ? 0.55 : z === rows - 2 ? -0.2 : 0)), h * (z % 2 ? -0.04 : 0.06)],
      3 * i,
    );
    pressure[i] = 0.07 * (x % 3);
    load[i] = 0.6 * (z % 3);
  }
  const world = new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 60, den: 1 } });
  const terrain = new TerrainBed();
  world
    .add(terrain, { ...grid, elevations: (x, z) => 0.025 * (x - z) }, far)
    .add(source(SURFACE_WATER_FIELD, flow, 'f32'), {}, far)
    .add(source(ROOT, pressure, 'f64'), {}, far)
    .add(sediment, { grid, mobileDepth: 0.25, suspendedMass: load, bankErodibility: 0.02, open: { maxX: true } }, far);
  return { world, sediment, terrain };
}

function exactCounts(threads, cells, faces) {
  const segment = (total, part) => Math.floor((total * (part + 1)) / threads) - Math.floor((total * part) / threads);
  return {
    threads,
    cellProposals: cells,
    faceProposals: faces,
    workers: Array.from({ length: threads }, (_, part) => ({
      cellProposals: segment(cells, part),
      faceProposals: segment(faces, part),
    })),
  };
}

test('shared sediment proposals preserve accepted root, bed and transport through a far-origin shift and replay', async (t) => {
  const models = await Promise.all([make(t, 1, false), make(t, 1, true), make(t, 2, true), make(t, 4, true)]);
  for (const { world, sediment } of models) {
    world.advance(10);
    assert.deepEqual(world.fields.port(sediment.concentrationField.name).cell, far);
  }
  const checkpoints = models.map(({ world }) => world.takeSnapshot());
  for (const { world, sediment } of models) {
    world.shiftOrigin(far);
    world.advance(65);
    assert.deepEqual(world.fields.port(sediment.concentrationField.name).cell, [0, 0, 0]);
    assert.ok(sediment.budget.bedloadOut > 0);
    assert.ok(sediment.budget.bankTransfer > 0);
    const counts = sediment.workCounts();
    assert.deepEqual(counts, exactCounts(counts.threads, 77, 172));
  }
  const expected = models[0].world.takeSnapshot();
  for (const [i, model] of models.entries()) {
    const { world, sediment, terrain } = model;
    assert.deepEqual(world.takeSnapshot().bytes, expected.bytes);
    assert.deepEqual(sediment.budget, models[0].sediment.budget);
    assert.deepEqual(terrain.elevations(), models[0].terrain.elevations());
    world.restoreSnapshot(checkpoints[i].bytes);
    assert.deepEqual(world.fields.port(sediment.concentrationField.name).cell, far);
    world.shiftOrigin(far);
    world.advance(65);
    assert.deepEqual(world.takeSnapshot().bytes, expected.bytes);
  }
});

test('sediment worker counts scale on two odd cell grids without changing accepted serial state', async (t) => {
  for (const [columns, rows] of [
    [129, 97],
    [257, 193],
  ]) {
    const [serial, threaded] = await Promise.all([make(t, 1, false, columns, rows), make(t, 4, true, columns, rows)]);
    const cells = columns * rows;
    const faces = (columns + 1) * rows + (rows + 1) * columns;
    for (const { world, sediment } of [serial, threaded]) {
      world.advance(1);
      const counts = sediment.workCounts();
      assert.deepEqual(counts, exactCounts(counts.threads, cells, faces));
    }
    assert.deepEqual(threaded.world.takeSnapshot().bytes, serial.world.takeSnapshot().bytes);
    console.log('HYDRO-03 proposal work', cells, faces, threaded.sediment.workCounts().workers);
  }
});

test('sediment threads reject unavailable shared memory and disposed workers with coded remedies', async (t) => {
  await assert.rejects(SedimentTransport.load({ threads: 0 }), {
    name: 'MargoError',
    code: 'state',
    message: /whole number of sediment threads/,
  });
  const { world, sediment } = await make(t, 2, true);
  t.after(() => sediment[Symbol.dispose]());
  const plain = await SedimentTransport.load({ threads: 2 });
  t.after(() => plain[Symbol.dispose]());
  assert.throws(() => new PhysicsWorld({ memory: worldMemory(false) }).add(plain, {}), {
    name: 'MargoError',
    code: 'unsupported',
    message: /worldMemory\(true\)/,
  });
  world.advance(1);
  sediment[Symbol.dispose]();
  assert.throws(() => world.advance(2), {
    name: 'MargoError',
    code: 'disposed',
    message: /Load a fresh solver/,
  });
});
