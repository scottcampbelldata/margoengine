import { CLOUD_LAYOUT, CLOUD_WATER_FIELD, CloudSolver } from '../../dist/clouds.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const far = [919_010_017, -178_020_007, -701_612_070];
export const grid = [11, 7, 5];

export function cloudParams(cells) {
  return {
    cells,
    centre: [70, -40],
    cellSize: 85,
    altitude: 650,
    humidity: 0.72,
    humidityTop: 0.6,
    surfaceHeat: 0,
    surfaceLatent: 0,
    patchiness: 0,
    vorticity: 0,
    timeScale: 60,
    interval: 1,
    bubbles: [{ centre: [70, 220, -40], radius: 200, warming: 3, humidity: 1.05 }],
  };
}

export function makeCloud(solver, shared, cells = grid) {
  return new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 60, den: 1 } }).add(
    solver,
    cloudParams(cells),
    far,
  );
}

export function expectedCloudWork(cells, threads, applications) {
  const [nx, ny, nz] = cells;
  const lines = ny * nz;
  const pairs = 2 * Math.floor(Math.max(0, nx - 2) / 2);
  const workers = Array.from({ length: threads }, (_, part) => {
    const linesHere = Math.floor(((part + 1) * lines) / threads) - Math.floor((part * lines) / threads);
    return { cells: applications * linesHere * nx, pairedCells: applications * linesHere * pairs };
  });
  return {
    threads,
    applications,
    cells: workers.reduce((total, worker) => total + worker.cells, 0),
    pairedCells: workers.reduce((total, worker) => total + worker.pairedCells, 0),
    workers,
  };
}

export function cloudPort(world) {
  const port = world.fields.port(CLOUD_WATER_FIELD.name);
  if (!port || port.region.type !== 'f32' || port.region.layout !== CLOUD_LAYOUT)
    throw new Error('Expected the registered f32 cloud-water field using CLOUD_LAYOUT.');
  return { values: regionWords(world.memory, port.region).slice(), cell: [...port.cell] };
}

export function sameValues(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export async function runCloud(shared, threads) {
  const cloud = threads === 0 ? new CloudSolver() : await CloudSolver.load({ threads });
  const world = makeCloud(cloud, shared);
  try {
    const start = world.takeSnapshot();
    const initial = cloudPort(world);
    const coldWork = cloud.workCounts();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const beforeShift = cloudPort(world);
    world.shiftOrigin(far);
    const afterShift = cloudPort(world);
    world.advance(6);
    const final = world.takeSnapshot();
    const accepted = cloudPort(world);
    const diagnostics = cloud.projectionDiagnostics;
    const work = cloud.workCounts();
    const sample = cloud.sample(70, 220, -40);
    world.restoreSnapshot(checkpoint.bytes);
    const restored = cloudPort(world);
    world.shiftOrigin(far);
    world.advance(6);
    const replay = world.takeSnapshot();
    return {
      start: start.bytes,
      checkpoint: checkpoint.bytes,
      final: final.bytes,
      report: {
        shared,
        threads,
        hash: final.hash,
        initialCell: initial.cell,
        shiftedCell: accepted.cell,
        restoredCell: restored.cell,
        originShiftExact: sameValues(beforeShift.values, afterShift.values),
        exactReplay: final.hash === replay.hash && sameValues(final.bytes, replay.bytes),
        publicationAgrees: sameValues(accepted.values, cloud.cloudWater()),
        cloudPresent: accepted.values.some((value) => value > 0),
        fieldsChanged: !sameValues(initial.values, accepted.values),
        sample,
        diagnostics,
        coldWork,
        work,
        replayWork: cloud.workCounts(),
      },
    };
  } finally {
    world.remove(cloud.describe().id);
    cloud[Symbol.dispose]();
  }
}

async function chromium() {
  try {
    if (!globalThis.crossOriginIsolated) throw new Error('Serve the cloud projection worker with cross-origin isolation.');
    const ActualWorker = globalThis.Worker;
    let helpers = 0;
    globalThis.Worker = class extends ActualWorker {
      constructor(url, options) {
        super(url, options);
        helpers++;
      }
    };
    try {
      const baseline = await runCloud(false, 0);
      const reports = [];
      for (const [shared, threads] of [
        [false, 1],
        [true, 1],
        [true, 2],
        [true, 4],
      ]) {
        const count = helpers;
        const run = await runCloud(shared, threads);
        reports.push({
          ...run.report,
          helpers: helpers - count,
          exactStart: sameValues(baseline.start, run.start),
          exactCheckpoint: sameValues(baseline.checkpoint, run.checkpoint),
          exactFinal: sameValues(baseline.final, run.final),
        });
      }
      postMessage({ baseline: baseline.report, reports, far, grid });
    } finally {
      globalThis.Worker = ActualWorker;
    }
  } catch (error) {
    postMessage({ error: error.stack ?? String(error) });
  }
}

if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope) await chromium();
