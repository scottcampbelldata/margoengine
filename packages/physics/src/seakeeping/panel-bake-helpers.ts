import { hullError } from './errors.js';
import type { PanelBakeReply, PanelBakeRequest, PanelFrequencyResult } from './panel-bake-native.js';

interface PanelWorker {
  postMessage(request: PanelBakeRequest): void;
  onReply(receive: (reply: PanelBakeReply) => void): void;
  onFailure(reject: (cause: unknown) => void): void;
  terminate(): void | Promise<number>;
}

type NodeWorker = {
  postMessage(request: PanelBakeRequest): void;
  on(event: 'message', receive: (reply: PanelBakeReply) => void): void;
  on(event: 'error' | 'messageerror', receive: (error: Error) => void): void;
  on(event: 'exit', receive: (code: number) => void): void;
  terminate(): Promise<number>;
};

async function startWorker(): Promise<PanelWorker> {
  if (typeof Worker === 'function') {
    const worker = new Worker(new URL(/* @vite-ignore */ './hull-panel-thread.js', import.meta.url), {
      type: 'module',
    });
    return {
      postMessage: (request) => worker.postMessage(request),
      onReply: (receive) => worker.addEventListener('message', ({ data }) => receive(data), { once: true }),
      onFailure: (reject) => {
        worker.addEventListener('error', reject, { once: true });
        worker.addEventListener('messageerror', reject, { once: true });
      },
      terminate: () => worker.terminate(),
    };
  }
  const name = 'node:worker_threads';
  const { Worker: NodePanelWorker } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    Worker: new (url: URL, options: { execArgv: string[] }) => NodeWorker;
  };
  const worker = new NodePanelWorker(new URL(/* @vite-ignore */ './hull-panel-thread.js', import.meta.url), {
    execArgv: [],
  });
  return {
    postMessage: (request) => worker.postMessage(request),
    onReply: (receive) => worker.on('message', receive),
    onFailure: (reject) => {
      worker.on('error', reject);
      worker.on('messageerror', reject);
      worker.on('exit', (code) => reject(`Hull panel helper exited with code ${code}.`));
    },
    terminate: () => worker.terminate(),
  };
}

function workerError(cause: unknown) {
  return Object.assign(
    hullError('failed', 'Serve the bundled hull panel worker in a Wasm SIMD runtime, or use threads: 1.'),
    { cause },
  );
}

export async function bakeWithHelper(
  request: PanelBakeRequest,
  signal: AbortSignal,
): Promise<readonly PanelFrequencyResult[]> {
  signal.throwIfAborted();
  let worker: PanelWorker;
  try {
    worker = await startWorker();
  } catch (cause) {
    throw workerError(cause);
  }
  try {
    signal.throwIfAborted();
    let abort: (() => void) | undefined;
    try {
      const reply = await new Promise<PanelBakeReply>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        worker.onReply(resolve);
        worker.onFailure((cause) => reject(workerError(cause)));
        try {
          worker.postMessage(request);
        } catch (cause) {
          reject(workerError(cause));
        }
      });
      signal.throwIfAborted();
      if ('error' in reply) throw workerError(reply.error);
      if ('invalid' in reply)
        throw hullError(
          'state',
          'The hull panel system is ill-conditioned. Refine hull triangles and remove crossed or duplicate faces.',
        );
      return reply.results;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  } finally {
    await worker.terminate();
  }
}
