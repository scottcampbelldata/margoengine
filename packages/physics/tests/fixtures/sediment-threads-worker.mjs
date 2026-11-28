import { TerrainBed } from '../../dist/earth.js';
import { SURFACE_WATER_FIELD } from '../../dist/hydro.js';
import { SedimentTransport } from '../../dist/sediment.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const far = [932_051_020, -1_254_557_030, 61_771_006];
const rootCohesion = {
  name: 'sediment-test-roots',
  unit: 'Pa',
  kind: 'uniformGrid',
  quantity: 'pressure',
  centring: 'cell',
};
const grid = { columns: 11, rows: 7, width: 8.8, depth: 7.7, centre: [6, -3] };
const cells = grid.columns * grid.rows;
const faces = (grid.columns + 1) * grid.rows + (grid.rows + 1) * grid.columns;

function source(field, values, type) {
  let host;
  let region;
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

function inputs() {
  const flow = new Float32Array(3 * cells);
  const roots = new Float64Array(cells);
  const suspendedMass = new Float64Array(cells);
  for (let z = 1; z < grid.rows - 1; z++) {
    for (let x = 0; x < grid.columns; x++) {
      const i = z * grid.columns + x;
      const depth = 0.5 + 0.09 * (z % 3);
      const bankVelocity = z === 1 ? 0.55 : z === grid.rows - 2 ? -0.2 : 0;
      flow.set([depth, depth * (1.1 + 0.5 * (x % 3) + bankVelocity), depth * (z % 2 ? -0.04 : 0.06)], 3 * i);
      roots[i] = 0.07 * (x % 3);
      suspendedMass[i] = 0.6 * (z % 3);
    }
  }
  return { flow, roots, suspendedMass };
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function run(shared, threads) {
  const ActualWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends ActualWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };

  try {
    using sediment = await SedimentTransport.load({ threads, rootCohesion });
    const { flow, roots, suspendedMass } = inputs();
    const terrain = new TerrainBed();
    const world = new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 60, den: 1 } })
      .add(terrain, { ...grid, elevations: (x, z) => 0.025 * (x - z) }, far)
      .add(source(SURFACE_WATER_FIELD, flow, 'f32'), {}, far)
      .add(source(rootCohesion, roots, 'f64'), {}, far)
      .add(sediment, { grid, mobileDepth: 0.25, suspendedMass, bankErodibility: 0.02, open: { maxX: true } }, far);
    const location = () => world.fields.port(sediment.concentrationField.name).cell;
    try {
      const start = world.takeSnapshot();
      const coldWork = sediment.workCounts();
      const initialCell = location();
      const initialBed = terrain.elevations();
      world.advance(10);
      const checkpoint = world.takeSnapshot();

      function finish() {
        world.shiftOrigin(far);
        world.advance(65);
        return world.takeSnapshot();
      }

      const final = finish();
      const shiftedCell = location();
      const work = sediment.workCounts();
      const fields = [sediment.concentrationField, sediment.bedloadField, sediment.shearField].map((field) => {
        const port = world.fields.port(field.name);
        if (!port || port.region.layout !== 1 || port.region.type !== 'f64' || port.region.byteLength !== 8 * cells)
          throw new Error('Expected an accepted layout-1 f64 sediment field on every cell.');
        return Array.from(regionWords(world.memory, port.region));
      });
      const budget = sediment.budget;
      const bedMoved = terrain.elevations().some((value, i) => value !== initialBed[i]);
      world.restoreSnapshot(checkpoint.bytes);
      const restoredCell = location();
      const replay = finish();
      return {
        start: start.bytes,
        checkpoint: checkpoint.bytes,
        final: final.bytes,
        receipt: {
          shared,
          threads,
          helpers,
          hash: final.hash,
          initialCell,
          shiftedCell,
          restoredCell,
          fields,
          budget,
          bedMoved,
          coldWork,
          work,
          replayWork: sediment.workCounts(),
          exactReplay: replay.hash === final.hash && equalBytes(replay.bytes, final.bytes),
        },
      };
    } finally {
      world.remove(sediment.id);
    }
  } finally {
    globalThis.Worker = ActualWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the sediment worker fixture with cross-origin isolation.');
  const baseline = await run(false, 1);
  const receipts = [baseline.receipt];
  for (const threads of [1, 2, 4]) {
    const actual = await run(true, threads);
    receipts.push({
      ...actual.receipt,
      exactStart: equalBytes(baseline.start, actual.start),
      exactCheckpoint: equalBytes(baseline.checkpoint, actual.checkpoint),
      exactFinal: equalBytes(baseline.final, actual.final),
    });
  }
  postMessage({ far, cells, faces, columns: grid.columns, receipts });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
