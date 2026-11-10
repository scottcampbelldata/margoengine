import { parentPort, workerData } from 'node:worker_threads';
import { serveParallelSystems } from '../../dist/parallel.js';
globalThis.testBarrier = workerData?.barrier ? new Int32Array(workerData.barrier) : null;
const listeners = new Map();
serveParallelSystems({
  postMessage: (message) => parentPort.postMessage(message),
  addEventListener(type, listener) {
    if (type !== 'message') return;
    const wrapped = (data) => listener({ data });
    listeners.set(listener, wrapped);
    parentPort.on('message', wrapped);
  },
  removeEventListener(type, listener) {
    const wrapped = listeners.get(listener);
    if (wrapped) parentPort.off(type, wrapped);
    listeners.delete(listener);
  },
});
