import { AirborneParticles } from '../../dist/airborne.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const far = [925_044_031, -117_050_207, -881_900_071];
const zero = [0, 0, 0];
const kinds = ['mineral-dust', 'freshwater-mist', 'sea-spray'];

export function parcel(index) {
  const material = index % kinds.length;
  return {
    kind: kinds[material],
    diameter: [26e-6, 180e-6, 260e-6][material],
    mass: (1 + (index % 4)) * 1e-6,
    position: [-1.5 + (index % 21) * 0.16, 11 + (index % 3) * 0.32, 1.2 - (index % 15) * 0.18],
    velocity: [-0.13 + (index % 5) * 0.3, 0.22, -0.47],
  };
}

function wind() {
  return {
    medium: 'air',
    cell: far,
    sample(x, y, z, t, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
      out.velocity[0] = 0.51 + 0.081 * x + 0.012 * t;
      out.velocity[1] = 0.071 + 0.031 * z;
      out.velocity[2] = -0.42 + 0.015 * y;
      out.density = 1.225;
      out.temperature = 288.15;
      return out;
    },
  };
}

export function plume(solver, shared, count, flowing = false) {
  const field = wind();
  const initial = Array.from({ length: count }, (_, i) => parcel(i));
  if (flowing) initial[0].position[0] = 3.6;
  const world = new PhysicsWorld({ memory: worldMemory(shared), rate: { num: 240, den: 1 }, seed: 917 });
  world.add(
    solver,
    {
      initial,
      capacity: flowing ? count + 12 : count,
      humidity: 0.68,
      wind: field,
      turbulence: { rms: [0.28, 0.11, 0.16], time: 0.33 },
      sources: flowing
        ? [{ kind: 'freshwater-mist', diameter: 180e-6, rate: 0.003, position: [0.5, 11.5, -0.9] }]
        : [],
      bounds: [
        [-3.4, 1, -3.4],
        [3.4, 30, 3.4],
      ],
    },
    far,
  );
  return { world, initial, field };
}

export function expectedAirborneWork(parcels, threads) {
  const workers = Array.from({ length: threads }, (_, part) => {
    const start = Math.floor((part * parcels.length) / threads);
    const end = Math.floor(((part + 1) * parcels.length) / threads);
    return {
      parcels: end - start,
      simdAxisPairs: 2 * (end - start),
      evaporationUpdates: parcels.slice(start, end).filter(({ kind }) => kind !== 'mineral-dust').length,
    };
  });
  return {
    threads,
    parcels: parcels.length,
    simdAxisPairs: 2 * parcels.length,
    evaporationUpdates: workers.reduce((total, worker) => total + worker.evaporationUpdates, 0),
    workers,
  };
}

export function published(world, solver) {
  const particles = world.fields.port(solver.particleField.name);
  const mass = world.fields.port(solver.massField.name);
  if (![particles, mass].every((port) => port?.region.layout === 1 && port.region.type === 'f64'))
    throw new Error('Expected layout-1 f64 particle and mass publications from AirborneParticles.');
  return {
    particles: regionWords(world.memory, particles.region).slice(),
    mass: regionWords(world.memory, mass.region).slice(),
    cell: [...particles.cell],
    cellsAgree: equal(particles.cell, mass.cell),
  };
}

function equal(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export async function runPlume(shared, threads) {
  using solver = await AirborneParticles.load({ threads });
  const { world, field } = plume(solver, shared, 13, true);
  try {
    const start = world.takeSnapshot();
    const initial = published(world, solver);
    const coldWork = solver.workCounts();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const beforeShift = published(world, solver);

    function finish() {
      world.shiftOrigin(far);
      field.cell = zero;
      const afterShift = published(world, solver);
      world.advance(5);
      // The active list remains in stable emission order. The last source
      // appends one new mist parcel before the native phase.
      const beforeFinal = [...solver.readParticles(), { kind: 'freshwater-mist' }];
      world.advance(6);
      return { snapshot: world.takeSnapshot(), beforeFinal, afterShift };
    }

    const final = finish();
    const accepted = published(world, solver);
    const work = solver.workCounts();
    const budget = solver.budget;
    const ordered = solver.readParticles().map(({ id }) => id);
    world.restoreSnapshot(checkpoint.bytes);
    field.cell = far;
    const restored = published(world, solver);
    const replay = finish();
    return {
      start: start.bytes,
      checkpoint: checkpoint.bytes,
      final: final.snapshot.bytes,
      report: {
        shared,
        threads,
        initialCell: initial.cell,
        shiftedCell: accepted.cell,
        restoredCell: restored.cell,
        cellsAgree: accepted.cellsAgree && restored.cellsAgree,
        originShiftExact: equal(beforeShift.particles, final.afterShift.particles) &&
          equal(beforeShift.mass, final.afterShift.mass),
        hash: final.snapshot.hash,
        exactReplay: final.snapshot.hash === replay.snapshot.hash && equal(final.snapshot.bytes, replay.snapshot.bytes),
        particlesChanged: !equal(initial.particles, accepted.particles),
        budget,
        ordered,
        coldWork,
        work,
        expectedWork: expectedAirborneWork(final.beforeFinal, threads),
        replayWork: solver.workCounts(),
      },
    };
  } finally {
    world.remove(solver.describe().id);
  }
}

async function chromium() {
  try {
    if (!globalThis.crossOriginIsolated) throw new Error('Serve the airborne worker with cross-origin isolation.');
    const ActualWorker = globalThis.Worker;
    let helpers = 0;
    globalThis.Worker = class extends ActualWorker {
      constructor(url, options) {
        super(url, options);
        helpers++;
      }
    };
    try {
      const baseline = await runPlume(false, 1);
      const reports = [];
      for (const threads of [1, 2, 4]) {
        const before = helpers;
        const actual = await runPlume(true, threads);
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

if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope) await chromium();
