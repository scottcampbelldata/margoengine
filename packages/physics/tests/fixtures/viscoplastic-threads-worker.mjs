import { equalBytes, runFlume } from './viscoplastic-threads-flume.mjs';

async function run(solvent, threads) {
  const NativeWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends NativeWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };
  try {
    const { bytes, hash, budget, work, replayWork, replayed } = await runFlume({ shared: true, threads, solvent });
    return { bytes, receipt: { hash, budget, work, replayWork, replayed, helpers } };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the viscoplastic worker fixture with cross-origin isolation.');
  const results = [];
  for (const solvent of [0, 3]) {
    const serial = await run(solvent, 1);
    const parallel = await run(solvent, 4);
    results.push({
      solvent,
      serial: serial.receipt,
      parallel: parallel.receipt,
      equalSnapshots: equalBytes(serial.bytes, parallel.bytes),
    });
  }
  postMessage({ results });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
