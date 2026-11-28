import { TsunamiSolver } from '../../dist/tsunami.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const cells = [17, 11];
const originCell = [400_000, 0, -700_000];
const basin = {
  cells,
  spacing: 0.125,
  bathymetry: Array.from(
    { length: cells[0] * cells[1] },
    (_, i) => -0.4 + (i % cells[0]) * 0.04 + Math.floor(i / cells[0]) * 0.01,
  ),
  open: [true, false, false, true],
  incoming: [(time) => incoming(time, 0.075, 0.27), undefined, undefined, (time) => incoming(time, 0.035, 0.16)],
  laminarBed: { kinematicViscosity: 1e-6, period: 20 },
};

function incoming(time, surface, speed) {
  const ramp = Math.min(1, time * 8);
  return { surface: ramp * surface, outwardVelocity: -ramp * speed };
}

function sameBytes(first, second) {
  return first.length === second.length && first.every((byte, i) => byte === second[i]);
}

async function run(threads) {
  const NativeWorker = globalThis.Worker;
  let nestedWorkers = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      nestedWorkers++;
    }
  };
  try {
    using tsunami = await TsunamiSolver.load({ threads });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) });
    world.add(tsunami, basin, originCell).shiftOrigin(originCell);
    const wetLandBefore = tsunami.budget.wetLandArea;
    world.advance(16);
    const checkpoint = world.takeSnapshot();
    world.advance(84);
    const { bytes, hash } = world.takeSnapshot();
    const wetLandAfter = tsunami.budget.wetLandArea;
    let dryCellsAfter = 0;
    for (let z = 0; z < cells[1]; z++) {
      for (let x = 0; x < cells[0]; x++) {
        if (tsunami.sample(x, z).depth === 0) dryCellsAfter++;
      }
    }
    const { faceFluxes, threadFaceFluxes, substeps } = tsunami.workCounts();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(84);
    const restored = world.takeSnapshot();
    world.remove('tsunami');

    return {
      bytes,
      receipt: {
        nestedWorkers,
        hash,
        wetLandBefore,
        wetLandAfter,
        dryCellsAfter,
        faceFluxes,
        threadFaceFluxes,
        substeps,
        replayedSnapshot: hash === restored.hash && sameBytes(bytes, restored.bytes),
      },
    };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the tsunami worker fixture with cross-origin isolation.');
  const serial = await run(1);
  const threaded = await run(4);
  postMessage({
    serial: serial.receipt,
    threaded: threaded.receipt,
    equalSnapshots: sameBytes(serial.bytes, threaded.bytes),
  });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
