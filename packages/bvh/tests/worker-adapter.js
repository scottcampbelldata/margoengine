// Browser Worker API over real Node worker threads, including nested workers.
import { Worker as NodeWorker, parentPort, workerData } from 'node:worker_threads';

export class BrowserWorker {
  static started = 0;
  static active = new Set();
  static noShared = false;
  static leaves = 0;
  constructor(url) {
    BrowserWorker.started++;
    BrowserWorker.active.add(this);
    if (parentPort) parentPort.postMessage({ testLeafStarted: true });
    this.thread = new NodeWorker(new URL('./worker-adapter.js', import.meta.url), {
      workerData: { url: String(url), noShared: BrowserWorker.noShared },
    });
    this.thread.on('message', (data) => {
      if (data.testLeafStarted) BrowserWorker.leaves++;
      else this.onmessage?.({ data });
    });
    this.thread.on('error', (error) => this.onerror?.({ message: error.message }));
  }
  postMessage(data, transfer) {
    this.thread.postMessage(data, transfer);
  }
  terminate() {
    BrowserWorker.active.delete(this);
    return this.thread.terminate();
  }
}

if (parentPort) {
  globalThis.Worker = BrowserWorker;
  BrowserWorker.noShared = workerData.noShared;
  if (workerData.noShared) globalThis.SharedArrayBuffer = undefined;
  globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
  await import(workerData.url);
  parentPort.on('message', (data) => globalThis.onmessage?.({ data }));
}
