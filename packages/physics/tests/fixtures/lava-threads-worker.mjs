import { LavaSolver } from '../../dist/lava.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const cells = [13, 9];
const bed = Array.from(
  { length: cells[0] * cells[1] },
  (_, i) => (i % cells[0] < 5 ? 0.2 : -0.35) + Math.floor(i / cells[0]) / 128,
);

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function run(transport, threads) {
  const NativeWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };
  try {
    using lava = await LavaSolver.load({ threads });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) }).add(lava, {
      cells,
      spacing: 1,
      bed,
      transport,
      seaLevel: 0,
      viscosity: 150,
      yieldStrength: 0,
      vents: [{ cell: [4, 4], flow: 6, start: 0.006, end: 0.45, temperature: 1450 }],
    });
    world.advance(18);
    const checkpoint = world.takeSnapshot();
    world.advance(44);
    const accepted = world.takeSnapshot();
    const work = lava.workCounts();
    const marine = lava.budget.displacedWater;
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(44);
    const replay = world.takeSnapshot();
    world.remove('lava');
    return {
      bytes: accepted.bytes,
      receipt: {
        helpers,
        hash: accepted.hash,
        replayed: replay.hash === accepted.hash && equalBytes(accepted.bytes, replay.bytes),
        work,
        marine,
      },
    };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the lava worker fixture with cross-origin isolation.');
  const results = [];
  for (const transport of ['inertial', 'terminal']) {
    const serial = await run(transport, 1);
    const parallel = await run(transport, 4);
    results.push({
      transport,
      serial: serial.receipt,
      parallel: parallel.receipt,
      equalSnapshots: equalBytes(serial.bytes, parallel.bytes),
    });
  }
  postMessage({ results });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
