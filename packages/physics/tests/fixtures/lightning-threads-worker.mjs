import { LightningSolver } from '../../dist/lightning.js';
import { PhysicsWorld, worldMemory } from '../../dist/world.js';

const settings = {
  size: [9, 11, 7],
  spacing: 40,
  start: 2 / 60 - 0.0011,
  charge: (x, y, z) => 2e-10 * (1 + (x - z + 0.5 * y) / 640),
  sweeps: 12,
  tolerance: 1e-12,
};

function equalBytes(a, b) {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

async function run(threads) {
  const NativeWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };
  try {
    using lightning = await LightningSolver.load({ threads });
    const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(true) }).add(lightning, settings);
    world.advance(2);
    const checkpoint = world.takeSnapshot();
    world.advance(3);
    const work = lightning.workCounts();
    const channelCount = lightning.channel().count;
    const accepted = world.takeSnapshot();
    world.restoreSnapshot(checkpoint.bytes);
    world.advance(3);
    const replay = world.takeSnapshot();
    world.remove('lightning');
    return {
      bytes: accepted.bytes,
      receipt: {
        helpers,
        work,
        channelCount,
        hash: accepted.hash,
        replayed: replay.hash === accepted.hash && equalBytes(accepted.bytes, replay.bytes),
      },
    };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the lightning worker fixture with cross-origin isolation.');
  const serial = await run(1);
  const parallel = await run(4);
  postMessage({
    serial: serial.receipt,
    parallel: parallel.receipt,
    equalSnapshots: equalBytes(serial.bytes, parallel.bytes),
  });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
