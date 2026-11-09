// Test-only Web Worker host for the actual shipped classic script, on a Node worker thread.
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
globalThis.self = globalThis;
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
// A classic script executes in the worker's global realm, just as it does in a browser.
(0, eval)(readFileSync(new URL(workerData.url), 'utf8'));
parentPort.on('message', (data) => self.onmessage({ data }));
