import { ORBIT_FIELD_LAYOUT, ORBIT_GRAVITATIONAL_CONSTANT, OrbitSolver } from '../../dist/orbit.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const farCell = [310_400, 0, -491_020];
const end = 31;
const midpoint = 14;
const id = 'threaded-orbit';
const massRows = [0, 2, 3, 7, 9];
const primaryMass = 4e24;
const count = 11;
const substeps = 2;
const timeScale = 90;

function initialBodies() {
  const massiveVelocity = [0, 0, 0];
  const bodies = [{ position: [0, 0, 0], mass: primaryMass }];
  for (let i = 1; i < count; i++) {
    const radius = 6.24e6 + i * 152_000;
    const angle = i * 0.92;
    const circular = Math.sqrt((ORBIT_GRAVITATIONAL_CONSTANT * primaryMass) / radius);
    const position = [radius * Math.cos(angle), radius * Math.sin(angle), ((i % 3) - 1) * 29_000];
    const velocity = [-circular * Math.sin(angle), circular * Math.cos(angle), circular * (i / 400 - 0.012)];
    const mass = massRows.includes(i) ? (1 + i / 4) * 2e18 : 0;
    const dragAreaPerMass = mass === 0 ? 0.011 + i / 1000 : 0;
    for (let j = 0; j < 3; j++) massiveVelocity[j] -= (velocity[j] * mass) / primaryMass;
    bodies.push({ position, velocity, mass, dragAreaPerMass });
  }
  bodies[0].velocity = massiveVelocity;
  return bodies;
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function run(scene, mode, drag = scene === 'atmosphere') {
  const ActualWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends ActualWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };
  try {
    const { shared, threads } = mode;
    using solver = await OrbitSolver.load(threads === undefined ? { id } : { id, threads });
    const memory = shared === undefined ? undefined : worldMemory(shared);
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory });
    const bodies = initialBodies();
    world.add(
      solver,
      {
        bodies,
        timeScale,
        substeps,
        integrator: scene === 'vacuum' ? 'yoshida' : 'verlet',
        primary: {
          body: 0,
          radius: 6.1e6,
          j2: 0.012,
          density: drag ? 4e-6 : 0,
          scaleHeight: 180_000,
          angularVelocity: 6.3e-5,
        },
      },
      farCell,
    );
    const locate = () => world.fields.port(solver.positionField.name).cell;
    try {
      const start = world.takeSnapshot();
      const initialCell = locate();
      const coldWork = solver.workCounts();
      world.advance(midpoint);
      const checkpoint = world.takeSnapshot();
      function finish() {
        world.shiftOrigin(farCell);
        world.advance(end);
        return world.takeSnapshot();
      }
      const accepted = finish();
      const shiftedCell = locate();
      const work = solver.workCounts();
      const fields = [solver.positionField, solver.velocityField, solver.timeField].map((field) => {
        const port = world.fields.port(field.name);
        if (!port || port.region.layout !== ORBIT_FIELD_LAYOUT || port.region.type !== 'f64')
          throw new Error('The orbital fixture requires accepted layout-1 f64 fields.');
        return Array.from(regionWords(world.memory, port.region));
      });
      const sample = bodies.map((_, i) => solver.sample(i));
      world.restoreSnapshot(checkpoint.bytes);
      const restoredCell = locate();
      const replay = finish();
      return {
        start: start.bytes,
        checkpoint: checkpoint.bytes,
        final: accepted.bytes,
        receipt: {
          ...mode,
          helpers,
          hash: accepted.hash,
          initialCell,
          shiftedCell,
          restoredCell,
          fields,
          sample,
          coldWork,
          work,
          elapsed: solver.elapsedSeconds,
          replayWork: solver.workCounts(),
          exactReplay: replay.hash === accepted.hash && equalBytes(replay.bytes, accepted.bytes),
        },
      };
    } finally {
      world.remove(id);
    }
  } finally {
    globalThis.Worker = ActualWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the orbital worker fixture with cross-origin isolation.');
  const modes = [
    { shared: false, threads: 1 },
    { shared: true, threads: 1 },
    { shared: true, threads: 2 },
    { shared: true, threads: 4 },
  ];
  const cases = [];
  for (const scene of ['vacuum', 'atmosphere']) {
    const reference = await run(scene, {});
    const receipts = [];
    for (const mode of modes) {
      const actual = await run(scene, mode);
      receipts.push({
        ...actual.receipt,
        exactStart: equalBytes(reference.start, actual.start),
        exactCheckpoint: equalBytes(reference.checkpoint, actual.checkpoint),
        exactFinal: equalBytes(reference.final, actual.final),
      });
    }
    const noDrag = scene === 'atmosphere' ? (await run(scene, { shared: false }, false)).receipt : undefined;
    cases.push({ scene, baseline: reference.receipt, receipts, noDrag });
  }
  postMessage({ cases, farCell, end, substeps, timeScale, bodies: initialBodies() });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
