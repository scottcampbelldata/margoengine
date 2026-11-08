// A Web Worker over a Node worker thread, for tests and benchmarks: the built classic worker script
// (dist/workers/biomes.js, the file browsers load) runs with `self` as its global, as in a browser, and importScripts
// runs a part script (dist/workers/biomes-<part>.js) from the file URL the page sent. takeLoaded() names the part
// files the threads ran since it was last called.
import { fileURLToPath } from 'node:url';
import { Worker as ThreadWorker } from 'node:worker_threads';

const script = fileURLToPath(new URL('../dist/workers/biomes.js', import.meta.url));
const loaded = [];

/** The part scripts (file names) the threads ran with importScripts since the last call, in order. */
export const takeLoaded = () => loaded.splice(0);

export class ThreadWebWorker {
  constructor() {
    this.thread = new ThreadWorker(
      `const { parentPort } = require('node:worker_threads');
       globalThis.self = globalThis;
       globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
       parentPort.on('message', (data) => globalThis.onmessage && globalThis.onmessage({ data }));
       globalThis.importScripts = (...urls) => {
         for (const url of urls) {
           const file = require('node:url').fileURLToPath(url);
           require('node:vm').runInThisContext(require('node:fs').readFileSync(file, 'utf8'), { filename: file });
           parentPort.postMessage({ partLoaded: require('node:path').basename(file) });
         }
       };
       require('node:vm').runInThisContext(require('node:fs').readFileSync(${JSON.stringify(script)}, 'utf8'));`,
      { eval: true },
    );
    this.thread.on('message', (data) => (data?.partLoaded ? loaded.push(data.partLoaded) : this.onmessage?.({ data })));
    this.thread.on('error', (error) => this.onerror?.({ message: error.message, preventDefault() {} }));
  }
  postMessage(message, transfer) {
    this.thread.postMessage(message, transfer);
  }
  terminate() {
    void this.thread.terminate();
  }
}
