import { equalBytes, runCatchment, smallGrid } from './runoff-threads-case.mjs';

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
    const { final, work, replayWork, replayed, settled, finalPort } = await runCatchment(smallGrid, {
      shared: true,
      threads,
    });
    return {
      bytes: final.bytes,
      receipt: { hash: final.hash, helpers, replayed, work, replayWork, settled, finalPort },
    };
  } finally {
    globalThis.Worker = NativeWorker;
  }
}

try {
  if (!crossOriginIsolated) throw new Error('Serve the runoff worker fixture with cross-origin isolation.');
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
