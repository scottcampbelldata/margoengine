import {
  SWIM_PASSIVE_REACTION_FIELD,
  SWIM_PASSIVE_REACTION_LAYOUT,
  SWIM_WAKE_FIELD,
  SWIM_WAKE_LAYOUT,
  SwimSolver,
} from '../../dist/life.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

export const far = [842_337_229, -124_135_447, -778_209_011];
const origin = [0, 0, 0];
const RATE = { num: 60, den: 1 };
const wakeColumn = 'schoolKinematics';

function body(index) {
  return {
    position: [-0.7 + 0.11 * (index % 11), -0.6 - 0.07 * (index % 5), 0.5 - 0.13 * (index % 13)],
    velocity: [-0.12 + 0.13 * (index % 5), 0.04 * (index % 3), 0.33 - 0.027 * (index % 7)],
    angularVelocity: [0.04, -0.11 + 0.054 * (index % 6), 0.14],
    orientation: [0, index % 2 ? 0.1 : -0.1, 0, Math.sqrt(0.99)],
    mass: 4.3 + 0.7 * (index % 5),
    length: 0.67 + 0.083 * (index % 4),
    width: 0.18,
    height: 0.15,
    volume: 0.0048,
    wettedArea: 0.43,
    formDragArea: 0.037,
    tail: { amplitude: 0.041, span: 0.18, wavelength: 0.93 },
    frequency: 0.77 + 0.12 * (index % 3),
    fins: { area: 0.022, strokeAmplitude: 0.035, strokeFrequency: 0.85 },
    steering: [0.18, -0.12, 0.42],
  };
}

export function makeSwimmers(solver, shared, count) {
  const water = {
    medium: 'water',
    cell: far,
    sample(x, y, z, time, out = { velocity: [0, 0, 0], density: 0, temperature: 0 }) {
      out.velocity[0] = 0.013 + 0.018 * (x + time);
      out.velocity[1] = -0.04 + 0.023 * z;
      out.velocity[2] = 0.17 + 0.064 * y;
      out.density = 1025;
      out.temperature = 289.15;
      return out;
    },
  };
  const world = new PhysicsWorld({ memory: worldMemory(shared), rate: RATE });
  world.add(solver, { bodies: Array.from({ length: count }, (_, i) => body(i)), flow: water }, far);
  return { world, water };
}

export function expectedSwimWork(bodies, threads, passive) {
  const workers = Array.from({ length: threads }, (_, part) => {
    const rows = Math.floor((bodies * (part + 1)) / threads) - Math.floor((bodies * part) / threads);
    return { bodies: rows, simdAxisPairs: 2 * rows, passiveReactions: passive ? rows : 0 };
  });
  return { threads, bodies, simdAxisPairs: 2 * bodies, passiveReactions: passive ? bodies : 0, workers };
}

function equal(a, b) {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

export function swimmerPorts(world, passive, count) {
  const names = [wakeColumn, SWIM_WAKE_FIELD.name, ...(passive ? [SWIM_PASSIVE_REACTION_FIELD.name] : [])];
  const layouts = [1, SWIM_WAKE_LAYOUT, SWIM_PASSIVE_REACTION_LAYOUT];
  const words = [6, 16, 8];
  return names.map((name, i) => {
    const port = world.fields.port(name);
    if (
      port?.region.type !== 'f64' ||
      port.region.layout !== layouts[i] ||
      port.region.byteLength !== count * words[i] * 8
    )
      throw new Error('Expected the current f64 swimmer kinematics or momentum-return layout.');
    return {
      cell: [...port.cell],
      values: regionWords(world.memory, port.region).slice(),
    };
  });
}

function anyImpulse(values, stride = 8, offset = 0) {
  for (let row = offset; row < values.length; row += stride) {
    if (values[row + 3] !== 0 || values[row + 4] !== 0 || values[row + 5] !== 0) return true;
  }
  return false;
}

export async function runSwimmers(shared, threads, passive) {
  using solver = await SwimSolver.load({ threads, passiveReaction: passive });
  const bodies = 11;
  const { world, water } = makeSwimmers(solver, shared, bodies);
  try {
    const start = world.takeSnapshot();
    const initial = swimmerPorts(world, passive, bodies);
    const coldWork = solver.workCounts();
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    const before = swimmerPorts(world, passive, bodies);
    function finish() {
      world.shiftOrigin(far);
      water.cell = origin;
      const after = swimmerPorts(world, passive, bodies);
      world.advance(7);
      return { snapshot: world.takeSnapshot(), after };
    }
    const final = finish();
    const accepted = swimmerPorts(world, passive, bodies);
    const acceptedCellAgrees = accepted.every(({ cell }) => equal(cell, solver.cell));
    const work = solver.workCounts();
    const reading = solver.read(3);
    world.restoreSnapshot(checkpoint.bytes);
    water.cell = far;
    const restored = swimmerPorts(world, passive, bodies);
    const replay = finish();
    return {
      start: start.bytes,
      checkpoint: checkpoint.bytes,
      final: final.snapshot.bytes,
      report: {
        passive,
        bodies,
        shared,
        threads,
        hash: final.snapshot.hash,
        initialCells: initial.map(({ cell }) => cell),
        shiftedCells: accepted.map(({ cell }) => cell),
        restoredCells: restored.map(({ cell }) => cell),
        acceptedCellAgrees,
        hashedReplay:
          final.snapshot.hash === replay.snapshot.hash && equal(final.snapshot.bytes, replay.snapshot.bytes),
        originShiftExact: before.every(({ values }, i) => equal(values, final.after[i].values)),
        tailAndFin: anyImpulse(accepted[1].values, 16) && anyImpulse(accepted[1].values, 16, 8),
        drag: passive ? anyImpulse(accepted[2].values) : !world.fields.port(SWIM_PASSIVE_REACTION_FIELD.name),
        reading,
        coldWork,
        work,
        replayWork: solver.workCounts(),
      },
    };
  } finally {
    world.remove(solver.describe().id);
  }
}

async function chromium() {
  try {
    if (!globalThis.crossOriginIsolated) throw new Error('Serve the swimmer worker with cross-origin isolation.');
    const ActualWorker = globalThis.Worker;
    let helpers = 0;
    globalThis.Worker = class extends ActualWorker {
      constructor(url, options) {
        super(url, options);
        helpers++;
      }
    };
    try {
      const suites = [];
      for (const passive of [false, true]) {
        const baseline = await runSwimmers(false, 1, passive);
        const reports = [];
        for (const threads of [1, 2, 4]) {
          const before = helpers;
          const run = await runSwimmers(true, threads, passive);
          reports.push({
            ...run.report,
            helpers: helpers - before,
            exactStart: equal(baseline.start, run.start),
            exactCheckpoint: equal(baseline.checkpoint, run.checkpoint),
            exactFinal: equal(baseline.final, run.final),
          });
        }
        suites.push({ baseline: baseline.report, reports });
      }
      postMessage({ suites, far });
    } finally {
      globalThis.Worker = ActualWorker;
    }
  } catch (error) {
    postMessage({ error: error.stack ?? String(error) });
  }
}

if (typeof DedicatedWorkerGlobalScope !== 'undefined' && globalThis instanceof DedicatedWorkerGlobalScope)
  await chromium();
