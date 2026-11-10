import { exposeRpc, rpcTransfer } from '../dist/rpc.js';

export const methods = {
  sum: (a, b) => a + b,
  buffer(buffer) {
    new Uint8Array(buffer)[0]++;
    return rpcTransfer(buffer, [buffer]);
  },
  fail() {
    throw Object.assign(new Error('task failed'), { name: 'MargoError', code: 'failed' });
  },
  uncloneable() {
    return () => {};
  },
  wait({ signal }) {
    return new Promise((resolve) => {
      if (signal.aborted) resolve('cancelled');
      else signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
    });
  },
};

if (typeof process === 'object' && process.versions?.node) {
  const { parentPort } = await import('node:worker_threads');
  const endpoint = new EventTarget();
  parentPort.on('message', (data) => endpoint.dispatchEvent(new MessageEvent('message', { data })));
  endpoint.postMessage = (data, transfer) => parentPort.postMessage(data, transfer);
  exposeRpc(methods, endpoint);
} else {
  exposeRpc(methods);
}
