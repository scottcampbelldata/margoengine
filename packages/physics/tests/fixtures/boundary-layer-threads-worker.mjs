import { BoundaryLayerSolver } from '../../dist/boundary-layer.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';
import { BoundaryLayerWind } from '../../../weather/dist/boundary-layer.js';

export const far = [932_051_020, -1_254_557_030, 61_771_006];
export const grid = { cells: [9, 9, 3], origin: [-43.2, -1, 7.3], spacing: [2.7, 4.25, 1.6] };

export function scalarWind(length, turbulence = true) {
  return new BoundaryLayerWind({
    direction: 0.71,
    directionConvention: length > 0 && Number.isFinite(length) ? 'heading' : 'cartesian',
    speed: 9.2,
    ground: 0.75,
    roughness: 0.125,
    altitude: 118.5,
    seaLevelTemperature: 286.3,
    obukhovLength: length,
    cell: far,
    turbulence: turbulence ? { cells: [6, 5, 4], size: [41.3, 29.1, 30], seed: 74 } : false,
  });
}

export function position(grid, row) {
  const [nx, ny] = grid.cells;
  const [x, y, z] = grid.origin;
  const [dx, dy, dz] = grid.spacing;
  return [x + (row % nx) * dx, y + (Math.floor(row / nx) % ny) * dy, z + Math.floor(row / (nx * ny)) * dz];
}

export function expectedWindWork(grid, profile, threads, stepped = true) {
  const rows = stepped ? grid.cells.reduce((n, extent) => n * extent, 1) : 0;
  const workers = Array.from({ length: threads }, (_, part) => {
    const start = Math.floor((rows * part) / threads);
    const end = Math.floor((rows * (part + 1)) / threads);
    let turbulentRows = 0;
    if (profile.turbulence) {
      for (let row = start; row < end; row++) {
        const h = position(grid, row)[1] - profile.ground;
        if (h > profile.roughness && h < profile.turbulence.size[2]) turbulentRows++;
      }
    }
    return { rows: end - start, pairedRows: 2 * Math.floor((end - start) / 2), turbulentRows };
  });
  return {
    threads,
    rows,
    pairedRows: workers.reduce((n, worker) => n + worker.pairedRows, 0),
    turbulentRows: workers.reduce((n, worker) => n + worker.turbulentRows, 0),
    workers,
  };
}

export function sameValues(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export function scalarValues(scalar, grid, time) {
  const rows = grid.cells.reduce((n, extent) => n * extent, 1);
  const values = new Float64Array(5 * rows);
  const out = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  for (let row = 0; row < rows; row++) {
    scalar.sample(...position(grid, row), time, out);
    values.set([...out.velocity, out.density, out.temperature], 5 * row);
  }
  return values;
}

export function publishedWind(world, wind) {
  const port = world.fields.port(wind.sampleField.name);
  if (!port || port.region.type !== 'f64' || port.region.layout !== 1)
    throw new Error('Expected a layout-1 f64 registered wind grid.');
  return { cell: [...port.cell], values: regionWords(world.memory, port.region).slice() };
}

function sampleParity(scalar, wind) {
  const queries = [
    [-14.4, 0.875, 17.4, -98.1],
    [12.9, 3.125, -32.8, -3.7],
    [-31.12, 13.4, 29.2, 1.61],
    [22.9, 29.9, -7.2, -0.61],
    [5.74, 30.75, 21.07, 2.3],
    [18.52, 33.1, 13.2, -4.13],
  ];
  return queries.every((point) => {
    const expected = scalar.sample(...point);
    const sample = wind.sample(...point);
    return (
      sameValues(sample.velocity, expected.velocity) &&
      Object.is(sample.density, expected.density) &&
      Object.is(sample.temperature, expected.temperature)
    );
  });
}

export async function runWind(shared, threads, scalar) {
  using wind = await BoundaryLayerSolver.load({ threads });
  const world = new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 60, den: 1 } });
  world.add(wind, { profile: scalar.profile, grid }, far);
  try {
    const initial = publishedWind(world, wind);
    const coldWork = wind.workCounts();
    const exactInitial = sameValues(initial.values, scalarValues(scalar, grid, 0));
    const start = world.takeSnapshot();
    world.advance(8);
    const checkpoint = world.takeSnapshot();
    const beforeShift = publishedWind(world, wind);
    world.shiftOrigin(far);
    const afterShift = publishedWind(world, wind);
    world.advance(17);
    const final = world.takeSnapshot();
    const observed = publishedWind(world, wind);
    const time = wind.elapsedSeconds;
    const work = wind.workCounts();
    const exactScalar = sameValues(observed.values, scalarValues(scalar, grid, time));
    const exactQuery = sampleParity(scalar, wind);
    const afterQueries = world.takeSnapshot();
    const queryPreservesWork = JSON.stringify(work) === JSON.stringify(wind.workCounts());
    world.restoreSnapshot(checkpoint.bytes);
    const restored = publishedWind(world, wind);
    world.shiftOrigin(far);
    world.advance(17);
    const replay = world.takeSnapshot();
    return {
      start: start.bytes,
      checkpoint: checkpoint.bytes,
      final: final.bytes,
      report: {
        shared,
        threads,
        initialCell: initial.cell,
        shiftedCell: observed.cell,
        restoredCell: restored.cell,
        time,
        coldWork,
        work,
        replayWork: wind.workCounts(),
        hash: final.hash,
        exactInitial,
        exactScalar,
        exactQuery,
        exactQueryState: queryPreservesWork && sameValues(final.bytes, afterQueries.bytes),
        exactShift: sameValues(beforeShift.values, afterShift.values),
        exactReplay: sameValues(final.bytes, replay.bytes) && final.hash === replay.hash,
        gustChanges: !sameValues(initial.values, observed.values),
        topAndGroundStill: observed.values[1] === 0 && observed.values[5 * 8 * grid.cells[0] + 1] === 0,
        activeUpward: observed.values.some((v, i) => i % 5 === 1 && v !== 0),
      },
    };
  } finally {
    world.remove(wind.describe().id);
  }
}

async function chromium() {
  try {
    if (!globalThis.crossOriginIsolated) throw new Error('Serve the boundary-layer worker with cross-origin isolation.');
    const ActualWorker = globalThis.Worker;
    let helpers = 0;
    globalThis.Worker = class extends ActualWorker {
      constructor(url, options) {
        super(url, options);
        helpers++;
      }
    };
    try {
      const scalar = scalarWind(24);
      const baseline = await runWind(false, 1, scalar);
      const reports = [];
      for (const threads of [1, 2, 4]) {
        const before = helpers;
        const actual = await runWind(true, threads, scalar);
        reports.push({
          ...actual.report,
          helpers: helpers - before,
          exactStart: sameValues(baseline.start, actual.start),
          exactCheckpoint: sameValues(baseline.checkpoint, actual.checkpoint),
          exactFinal: sameValues(baseline.final, actual.final),
        });
      }
      postMessage({
        reports,
        baseline: baseline.report,
        expectedWork: reports.map(({ threads }) => expectedWindWork(grid, scalar.profile, threads)),
      });
    } finally {
      globalThis.Worker = ActualWorker;
    }
  } catch (error) {
    postMessage({ error: error.stack ?? String(error) });
  }
}

if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope) await chromium();
