import { UnderwaterAcousticsSolver } from '../../dist/underwater.js';
import { PhysicsWorld, regionWords, worldMemory } from '../../dist/world.js';

const farCell = [-231_900, 0, 341_900];
const end = 23;
const midpoint = 9;
const angles = [-0.9, 0.65, 0, Math.PI / 2, -0.24, -0.7, 0.12, -Math.PI / 2, 0.9, -0.52, 0.45];
const uniform = [
  { depth: 0, speed: 1488 },
  { depth: 36, speed: 1488 },
];
const stratified = [
  { depth: 0, speed: 1520 },
  { depth: 16, speed: 1495 },
  { depth: 34, speed: 1478 },
  { depth: 66, speed: 1488 },
  { depth: 75, speed: 1495 },
  { depth: 94, speed: 1504 },
];

function launches(profile) {
  const bottom = profile.at(-1).depth;
  return angles.map((declination, index) => ({
    depth: bottom * (0.19 + (0.57 * ((index * 11) % 13)) / 13),
    declination,
    frequency: 620 + index * 105,
    waist: 1.4 + index * 0.33,
    pressure: index === 6 ? 0 : index % 3 === 0 ? -0.4 : 1.15,
  }));
}

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function execute(profile, mode) {
  const ActualWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends ActualWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };
  const { native, shared, threads } = mode;
  const id = 'test-waveguide';
  try {
    using solver = native
      ? await UnderwaterAcousticsSolver.load({ id, threads })
      : new UnderwaterAcousticsSolver({ id });
    const rays = launches(profile);
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
    world.add(solver, { profile, rays, surfaceReflection: -1, bottomReflection: 0.72, absorption: 1.2 }, farCell);
    const stateCell = () => world.fields.port(solver.pathField.name).cell;
    try {
      const start = world.takeSnapshot();
      const initialCell = stateCell();
      world.advance(midpoint);
      const checkpoint = world.takeSnapshot();
      const finish = () => {
        world.shiftOrigin(farCell);
        world.advance(end);
        return world.takeSnapshot();
      };
      const final = finish();
      const shiftedCell = stateCell();
      const work = native ? solver.workCounts() : undefined;
      const signal = Array.from(regionWords(world.memory, world.fields.port(solver.signalField.name).region));
      const delay = Array.from(regionWords(world.memory, world.fields.port(solver.delayField.name).region));
      const sample = rays.map((_, ray) => solver.sample(ray));
      world.restoreSnapshot(checkpoint.bytes);
      const restoredCell = stateCell();
      const replay = finish();
      return {
        start: start.bytes,
        checkpoint: checkpoint.bytes,
        final: final.bytes,
        receipt: {
          ...mode,
          helpers,
          hash: final.hash,
          initialCell,
          shiftedCell,
          restoredCell,
          signal,
          delay,
          sample,
          work,
          replayWork: native ? solver.workCounts() : undefined,
          exactReplay: final.hash === replay.hash && equalBytes(final.bytes, replay.bytes),
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
  if (!crossOriginIsolated) throw new Error('Serve the underwater worker test with cross-origin isolation.');
  const cases = [];
  for (const [name, profile] of [
    ['uniform', uniform],
    ['stratified', stratified],
  ]) {
    const baseline = await execute(profile, { native: false, shared: false, threads: 1 });
    const modes = [
      { shared: false, threads: 1 },
      { shared: true, threads: 1 },
      { shared: true, threads: 2 },
      { shared: true, threads: 4 },
    ];
    const receipts = [];
    for (const mode of modes) {
      const native = await execute(profile, { native: true, ...mode });
      receipts.push({
        ...native.receipt,
        exactStart: equalBytes(native.start, baseline.start),
        exactCheckpoint: equalBytes(native.checkpoint, baseline.checkpoint),
        exactFinal: equalBytes(native.final, baseline.final),
      });
    }
    cases.push({ name, end, farCell, profile, launches: launches(profile), baseline: baseline.receipt, receipts });
  }
  postMessage({ cases });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
