// Module workers on browsers and Node, without starting one or importing Node on construction.
import { WorkerPool } from './pool.js';
import { decodeFailed } from './errors.js';

interface NodeWorker {
  on(type: string, listener: (...args: any[]) => void): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): Promise<number>;
}

function adapt(worker: NodeWorker): Worker {
  const bridge = {
    onmessage: null as Worker['onmessage'],
    onerror: null as Worker['onerror'],
    onmessageerror: null as Worker['onmessageerror'],
    postMessage: (value: unknown, transfer: Transferable[]) => worker.postMessage(value, transfer),
    terminate: () => {
      void worker.terminate();
    },
  };
  worker.on('message', (data: unknown) =>
    bridge.onmessage?.call(bridge as unknown as Worker, { data } as MessageEvent),
  );
  worker.on('messageerror', () => bridge.onmessageerror?.call(bridge as unknown as Worker, {} as MessageEvent));
  worker.on('error', (error: Error) =>
    bridge.onerror?.call(bridge as unknown as Worker, { message: error.message } as ErrorEvent),
  );
  worker.on('exit', (code: number) =>
    bridge.onerror?.call(bridge as unknown as Worker, { message: `Worker exited (${code})` } as ErrorEvent),
  );
  return bridge as unknown as Worker;
}

/** Internal worker factory, used only by optional entries. */
export class ModulePool {
  private loading?: Promise<WorkerPool>;
  private active?: WorkerPool;
  private generation = 0;
  constructor(
    private readonly limit: number,
    private readonly url: URL,
    private readonly name: string,
  ) {}

  async run<T>(
    message: Record<string, unknown>,
    transfer: Transferable[],
    signal: AbortSignal | undefined,
    timeout: number,
  ): Promise<T> {
    signal?.throwIfAborted();
    const generation = this.generation;
    const pool = await (this.loading ??= this.load());
    if (generation !== this.generation) {
      pool.dispose();
      throw decodeFailed('Decoder was disposed; start a new decode');
    }
    this.active = pool;
    return pool.run<T>(message, transfer, signal, timeout, this.name);
  }
  private async load(): Promise<WorkerPool> {
    if (typeof Worker !== 'undefined')
      return new WorkerPool(this.limit, () => new Worker(this.url, { type: 'module', name: this.name }));
    const nodeModule = 'node:worker_threads';
    const { Worker: NodeWorker } = await import(/* @vite-ignore */ nodeModule);
    return new WorkerPool(this.limit, () => adapt(new NodeWorker(this.url, { name: this.name })));
  }
  dispose(): void {
    this.generation++;
    this.active?.dispose();
    this.active = undefined;
    this.loading = undefined;
  }
}

/** Worker-side port, chosen lazily. Node never installs globals. */
export async function modulePort(): Promise<{
  receive(handler: (data: any) => void): void;
  send(message: unknown, transfer?: Transferable[]): void;
}> {
  if (typeof globalThis.postMessage === 'function')
    return {
      receive: (handler) => {
        globalThis.onmessage = ({ data }: MessageEvent) => handler(data);
      },
      send: (message, transfer = []) =>
        (globalThis.postMessage as (message: unknown, transfer: Transferable[]) => void)(message, transfer),
    };
  const nodeModule = 'node:worker_threads';
  const { parentPort } = await import(/* @vite-ignore */ nodeModule);
  if (!parentPort) throw decodeFailed('Decoder module must run in a worker; use the decoder class');
  return {
    receive: (handler) => parentPort.on('message', handler),
    send: (message, transfer) => parentPort.postMessage(message, transfer),
  };
}

/** Read a Wasm asset on either platform, without a Node dependency in browser bundles. */
export async function wasmBytes(url: string): Promise<ArrayBuffer> {
  if (url.startsWith('file:')) {
    const nodeModule = 'node:fs/promises';
    const { readFile } = await import(/* @vite-ignore */ nodeModule);
    const data: Uint8Array = await readFile(new URL(url));
    return data.slice().buffer as ArrayBuffer;
  }
  const response = await fetch(url);
  if (!response.ok) throw decodeFailed(`Wasm asset returned HTTP ${response.status}: ${url}; check decoderPath`);
  return response.arrayBuffer();
}
