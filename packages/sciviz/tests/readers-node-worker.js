// Node adapter for the exact shipped browser worker, not a second parser implementation.
import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
const target = new EventTarget();
globalThis.addEventListener = target.addEventListener.bind(target);
globalThis.removeEventListener = target.removeEventListener.bind(target);
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
const code = await readFile(new URL('../dist/workers/readers.js', import.meta.url), 'utf8');
(0, eval)(code);
parentPort.on('message', (data) => target.dispatchEvent(new MessageEvent('message', { data })));
