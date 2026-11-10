// The page of browser-check.mjs: a real Worker draws on a real transferred canvas; browser-check-worker.js is its other end.
import { transferCanvas, workerCanvasSupported } from '/packages/worker/dist/index.js';
import { RpcPool } from '/packages/worker/dist/rpc.js';

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
  async rpc() {
    const pool = new RpcPool(() => new Worker('/packages/worker/tests/rpc-worker.js', { type: 'module' }), { size: 2 });
    try {
      const sums = await Promise.all([pool.call('sum', [20, 22]), pool.call('sum', [1, 2])]);
      const buffer = new Uint8Array([41]).buffer;
      const output = await pool.call('buffer', [buffer], { transfer: [buffer] });
      return { sums, detached: buffer.byteLength === 0, result: new Uint8Array(output)[0] };
    } finally {
      pool.dispose();
    }
  },
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
    // The close travels on the canvas's port and this question on the worker's own channel, and nothing orders the two:
    // WebKit answers the question first. Two seconds at most.
    for (let i = 0; i < 100; i++) {
      if (await ask(gpu.worker, 'closed')) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  },
};
window.ready = true;
