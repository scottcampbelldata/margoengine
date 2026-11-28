import { runValley } from './landscape-threads-case.mjs';

async function run(threads) {
  const ActualWorker = globalThis.Worker;
  let helpers = 0;
  globalThis.Worker = class extends ActualWorker {
    constructor(url, options) {
      super(url, options);
      helpers++;
    }
  };
  try {
    const { final, work, replayWork, replayed, physical } = await runValley(true, threads);
    return { bytes: final.bytes, receipt: { hash: final.hash, helpers, work, replayWork, replayed, physical } };
  } finally {
    globalThis.Worker = ActualWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve this landscape worker fixture with cross-origin isolation.');
  const serial = await run(1);
  const parallel = await run(4);
  postMessage({
    serial: serial.receipt,
    parallel: parallel.receipt,
    equalSnapshots:
      serial.bytes.length === parallel.bytes.length && serial.bytes.every((value, i) => value === parallel.bytes[i]),
  });
} catch (error) {
  postMessage({ error: error.stack ?? String(error) });
}
