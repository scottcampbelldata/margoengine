// The scene module of the worker owner fixture's AutoScene entry: it listens on the canvas until its lifetime signal
// aborts, and its dispose finishes a task later, as an asynchronous scene cleanup may.
export function createScene({ canvas, data, signal }) {
  const listener = () => {};
  canvas.addEventListener('pointerdown', listener);
  signal.addEventListener('abort', () => canvas.removeEventListener('pointerdown', listener), { once: true });
  return {
    dispose: () => new Promise((resolve) => setTimeout(() => {
      data.disposals++;
      resolve();
    }, 5)),
  };
}
