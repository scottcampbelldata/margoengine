import { openPanelKernel, type PanelBakeReply, type PanelBakeRequest } from './panel-bake-native.js';

function respond({ module, input, jobs }: PanelBakeRequest): PanelBakeReply {
  try {
    const native = openPanelKernel(module, input);
    try {
      const results = [];
      for (const job of jobs) {
        const result = native.solve(job);
        if (!result) return { invalid: true };
        results.push(result);
      }
      return { results };
    } finally {
      native.close();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const node = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node;
if (typeof node === 'string') {
  type ParentPort = {
    once(event: 'message', listener: (request: PanelBakeRequest) => void): void;
    postMessage(reply: PanelBakeReply): void;
  };
  const name = 'node:worker_threads';
  void (import(/* @vite-ignore */ /* webpackIgnore: true */ name) as Promise<{ parentPort: ParentPort | null }>).then(
    ({ parentPort }) => parentPort?.once('message', (request) => parentPort.postMessage(respond(request))),
  );
} else {
  const worker = globalThis as unknown as {
    onmessage: (event: MessageEvent<PanelBakeRequest>) => void;
    postMessage(reply: PanelBakeReply): void;
  };
  worker.onmessage = ({ data }) => worker.postMessage(respond(data));
}
