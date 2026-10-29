// A Web Worker over a Node worker thread, for tests and benchmarks: the built classic worker script
// (dist/workers/biomes.js, the file browsers load) runs with `self` as its global, as in a browser.
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';

const script = fileURLToPath(new URL('../dist/workers/biomes.js', import.meta.url));

export class ThreadWebWorker {
  constructor() {
    this.thread = new ThreadWorker(
      `const { parentPort } = require('node:worker_threads');
       globalThis.self = globalThis;
       globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
       parentPort.on('message', (data) => globalThis.onmessage && globalThis.onmessage({ data }));
       require('node:vm').runInThisContext(require('node:fs').readFileSync(${JSON.stringify(script)}, 'utf8'));`,
      { eval: true },
    );
    this.thread.on('message', (data) => this.onmessage?.({ data }));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message, transfer) {
    this.thread.postMessage(message, transfer);
  }
  terminate() {
    void this.thread.terminate();
  }
}
