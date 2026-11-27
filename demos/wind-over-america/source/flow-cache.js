export function prepareFrames(archive, opening, signal) {
  const worker = new Worker(new URL('./flow-worker.js', import.meta.url), { type: 'module', name: 'NOAA streamlines' });
  const frames = new Map();
  let received = 0, fail;
  const cleanup = () => {
    worker.terminate();
    signal.removeEventListener('abort', cancel);
  };
  const cancel = () => {
    cleanup();
    fail(signal.reason);
  };
  const all = new Promise((_, reject) => { fail = reject; });
  const waiting = Array.from({ length: archive.length }, (_, index) => Promise.race([
    all,
    new Promise((resolve) => {
      frames.set(index, resolve);
    }),
  ]));
  for (const promise of waiting) void promise.catch(() => {});
  worker.onmessage = ({ data: { index, frame } }) => {
    frames.get(index)(frame);
    frames.delete(index);
    if (++received === archive.length) cleanup();
  };
  worker.onerror = (event) => {
    cleanup();
    fail(event.error ?? new Error('The wind streamlines could not be built.'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  else worker.postMessage({ archive, opening });
  return waiting;
}

