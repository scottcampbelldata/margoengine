import { parentPort, workerData } from 'node:worker_threads';
const waiting = [];
globalThis.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
parentPort.on('message', (data) => {
  if (globalThis.onmessage) globalThis.onmessage({ data });
  else waiting.push(data);
});
const url = new URL(workerData.url);
url.search = '';
await import(url.href);
for (const data of waiting) globalThis.onmessage?.({ data });
