import { PLANT_SWAY_WORDS, PlantSway } from '../../dist/vegetation.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const far = [869_521_031, -142_117_933, -775_928_055];
const origin = [0, 0, 0];

export function makePlants(solver, shared, count, breaking = false) {
  const flow = {
    medium: 'air',
    cell: far,
    sample(x, y, z, t, out) {
      out.velocity[0] = 2 + 0.037 * x + 0.03 * y + 0.041 * t;
      out.velocity[1] = 0;
      out.velocity[2] = -0.61 + 0.051 * z + 0.027 * t;
      out.density = 1.225;
      out.temperature = 293.15;
      return out;
    },
  };
  const plants = Array.from({ length: count }, (_, i) => ({
    root: [-0.92 + 0.14 * (i % 17), 0, -0.8 + 0.17 * (i % 11)],
    height: 1.55 + 0.11 * (i % 4),
    baseDiameter: 0.07 + 0.003 * (i % 5),
    density: 710,
    youngModulus: 1.05e8 + 1e7 * (i % 4),
    dampingRatio: 0.038,
    initialDisplacement: [0.008 + (i % 3) * 0.002, -0.002, -0.001, 0.006],
    initialVelocity: [0.001, 0.009, 0.0017, -0.03],
    ...(breaking && i === 3 ? { ruptureStress: 1 } : {}),
    ...(breaking && i === 6 ? { anchorMoment: 0.001 } : {}),
  }));
  const world = new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 60, den: 1 } });
  world.add(solver, { plants, flow }, far);
  return { world, flow, plants };
}

export function expectedPlantWork(standing, threads) {
  const plants = standing.length;
  const workers = Array.from({ length: threads }, (_, part) => {
    const start = Math.floor((plants * part) / threads);
    const end = Math.floor((plants * (part + 1)) / threads);
    const integratedPlants = standing.slice(start, end).filter(Boolean).length;
    // The authored air setup selects a dry frequency-based level. No added
    // mass or wet preload modifies that bound, so each standing row takes one.
    return {
      plants: end - start,
      integratedPlants,
      midpointSubsteps: integratedPlants,
      simdModePairs: 2 * integratedPlants,
    };
  });
  const integratedPlants = workers.reduce((sum, worker) => sum + worker.integratedPlants, 0);
  return {
    threads,
    plants,
    integratedPlants,
    midpointSubsteps: integratedPlants,
    simdModePairs: 2 * integratedPlants,
    workers,
  };
}

export function plantPorts(world, solver) {
  return [solver.swayField, solver.impulseField].map(({ name }) => {
    const port = world.fields.port(name);
    if (port?.region.type !== 'f64' || port.region.layout !== 1)
      throw new Error('Expected PlantSway to publish the layout-1 f64 modal fields.');
    return { cell: [...port.cell], values: regionWords(world.memory, port.region).slice() };
  });
}

function equal(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export async function runPlants(shared, threads) {
  using solver = await PlantSway.load({ threads });
  const count = 13;
  const { world, flow } = makePlants(solver, shared, count, true);
  try {
    const first = plantPorts(world, solver);
    const start = world.takeSnapshot();
    const coldWork = solver.workCounts();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const before = plantPorts(world, solver);
    const standing = Array.from({ length: count }, (_, i) => before[0].values[i * PLANT_SWAY_WORDS + 9] === 0);
    function finish() {
      world.shiftOrigin(far);
      flow.cell = origin;
      const after = plantPorts(world, solver);
      world.advance(8);
      return { snapshot: world.takeSnapshot(), after };
    }
    const final = finish();
    const accepted = plantPorts(world, solver);
    const acceptedCellAgrees = accepted.every(({ cell }) => equal(cell, solver.cell));
    const motion = solver.readSway();
    const status = Array.from({ length: count }, (_, i) => motion[i * PLANT_SWAY_WORDS + 9]);
    const changed = !equal(first[0].values, motion);
    const work = solver.workCounts();
    world.restoreSnapshot(checkpoint.bytes);
    flow.cell = far;
    const restored = plantPorts(world, solver);
    const replay = finish();
    return {
      start: start.bytes,
      checkpoint: checkpoint.bytes,
      final: final.snapshot.bytes,
      report: {
        threads,
        shared,
        hash: final.snapshot.hash,
        initialCells: first.map(({ cell }) => cell),
        shiftedCells: accepted.map(({ cell }) => cell),
        restoredCells: restored.map(({ cell }) => cell),
        originShiftExact: before.every(({ values }, i) => equal(values, final.after[i].values)),
        acceptedCellAgrees,
        exactReplay: final.snapshot.hash === replay.snapshot.hash && equal(final.snapshot.bytes, replay.snapshot.bytes),
        changed,
        readsAgree: equal(motion, accepted[0].values),
        status,
        standing,
        coldWork,
        work,
        replayWork: solver.workCounts(),
      },
    };
  } finally {
    world.remove(solver.id);
  }
}

async function chromium() {
  try {
    if (!globalThis.crossOriginIsolated) throw new Error('Serve the plant worker with cross-origin isolation.');
    const ActualWorker = globalThis.Worker;
    let helpers = 0;
    globalThis.Worker = class extends ActualWorker {
      constructor(url, options) {
        super(url, options);
        helpers++;
      }
    };
    try {
      const baseline = await runPlants(false, 1);
      const reports = [];
      for (const threads of [1, 2, 4]) {
        const before = helpers;
        const actual = await runPlants(true, threads);
        reports.push({
          ...actual.report,
          helpers: helpers - before,
          exactStart: equal(baseline.start, actual.start),
          exactCheckpoint: equal(baseline.checkpoint, actual.checkpoint),
          exactFinal: equal(baseline.final, actual.final),
        });
      }
      postMessage({ baseline: baseline.report, reports, far });
    } finally {
      globalThis.Worker = ActualWorker;
    }
  } catch (error) {
    postMessage({ error: error.stack ?? String(error) });
  }
}

if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope)
  await chromium();
