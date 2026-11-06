// The page of browser-check.mjs: a real Worker draws on a real transferred canvas; browser-check-worker.js is its other end.
import { transferCanvas, workerCanvasSupported } from '/packages/worker/dist/index.js';

const asked = new Map();
let next = 0;
/** One request to a worker over plain postMessage, beside the canvas link. */
const ask = (worker, command, value) =>
  new Promise((resolve, reject) => {
    const id = ++next,
      limit = setTimeout(() => reject(new Error(`the worker never answered ${command}`)), 20_000);
    asked.set(id, {
      resolve(result) {
        clearTimeout(limit);
        resolve(result);
      },
      reject(error) {
        clearTimeout(limit);
        reject(error);
      },
    });
    worker.postMessage({ id, command, value });
  });
const open = (backend, element) => {
  const worker = new Worker('/packages/worker/tests/browser-check-worker.js', { type: 'module' });
  worker.addEventListener('message', ({ data }) => {
    const pending = asked.get(data.id);
    if (!pending) return;
    asked.delete(data.id);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.value);
  });
  return transferCanvas(element, worker, { data: { backend } }).then((view) => ({ view, worker }));
};

const gpu = await open('webgpu', document.getElementById('gpu'));

window.check = {
  supported: workerCanvasSupported(),
  ask: (command, value) => ask(gpu.worker, command, value),
  resize(width, height) {
    Object.assign(gpu.view.canvas.style, { width: `${width}px`, height: `${height}px` });
  },
  /** Timer ticks the page gets while the worker is stuck in a loop for `ms`. */
  async pageWhileWorkerBlocks(ms) {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await ask(gpu.worker, 'block', ms);
    clearInterval(timer);
    return ticks;
  },
  /** Frames the worker draws while the page is stuck in a loop for `ms`. */
  async workerWhilePageBlocks(ms) {
    const before = await ask(gpu.worker, 'frames'),
      end = performance.now() + ms;
    while (performance.now() < end);
    return (await ask(gpu.worker, 'frames')) - before;
  },
  /** The same scene on the WebGL2 path, in a second worker. */
  async webgl2() {
    const { view, worker } = await open('webgl2', document.getElementById('gl')),
      result = await ask(worker, 'state');
    view.dispose();
    worker.terminate();
    return result;
  },
  async close() {
    gpu.view.dispose();
    return ask(gpu.worker, 'closed');
  },
};
window.ready = true;
