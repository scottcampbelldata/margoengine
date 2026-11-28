import { MargoError } from '@margoengine/math/errors';
import { bindMannFft, type MannFftCells, type MannFftReply, type MannFftRequest } from './turbulence-native-core.js';

/** Actual component transforms performed by one caller or helper. */
export interface MannFftParticipantWork {
  readonly transforms: number;
  readonly complexValues: number;
  readonly simdTwiddleProducts: number;
}

/** Work of the native plan over the complete wind box, with the caller first. */
export interface MannFftWork extends MannFftParticipantWork {
  readonly threads: number;
  readonly workers: number;
  readonly participants: readonly MannFftParticipantWork[];
}

interface Options {
  readonly threads?: number;
  readonly signal?: AbortSignal;
}

interface Endpoint {
  postMessage(message: MannFftRequest, transfer?: ArrayBuffer[]): void;
  onReply(receive: (reply: MannFftReply) => void): void;
  onError(receive: (error: Error) => void): void;
  terminate(): void;
}

function loadError(message: string, cause?: unknown): MargoError {
  return Object.assign(new MargoError('failed', message), { cause });
}

async function loadModule(signal?: AbortSignal): Promise<WebAssembly.Module> {
  const url = new URL(/* @vite-ignore */ './mann-fft.wasm?no-inline', import.meta.url);
  try {
    let module: WebAssembly.Module;
    if (url.protocol === 'file:') {
      url.search = '';
      const name = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ name);
      module = await WebAssembly.compile(await readFile(url, { signal }));
    } else {
      const response = await fetch(url, { signal });
      if (!response.ok) throw loadError(`Mann FFT request returned HTTP ${response.status}. Serve the Wasm asset.`);
      module = await WebAssembly.compile(await response.arrayBuffer());
    }
    signal?.throwIfAborted();
    return module;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof MargoError) throw cause;
    throw loadError('Load the Mann FFT asset in a Wasm SIMD runtime.', cause);
  }
}

async function endpoint(): Promise<Endpoint> {
  // The package builder emits a standalone classic worker. A consumer only has to copy its asset URL.
  const url = new URL(/* @vite-ignore */ './workers/mann-fft.js?no-inline', import.meta.url);
  if (typeof Worker === 'function') {
    const worker = new Worker(url);
    return {
      postMessage: (message, transfer = []) => worker.postMessage(message, transfer),
      onReply: (receive) => worker.addEventListener('message', ({ data }) => receive(data)),
      onError: (receive) => {
        worker.addEventListener('error', (error) => receive(new Error(error.message)));
        worker.addEventListener('messageerror', () => receive(new Error('Mann helper reply could not be read.')));
      },
      terminate: () => worker.terminate(),
    };
  }
  url.search = '';
  const name = 'node:worker_threads';
  const { Worker: NodeWorker } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ name)) as {
    Worker: new (
      url: URL,
      options: { execArgv: string[] },
    ) => {
      postMessage(message: MannFftRequest, transfer?: ArrayBuffer[]): void;
      on(event: 'message', receive: (reply: MannFftReply) => void): void;
      on(event: 'error', receive: (error: Error) => void): void;
      on(event: 'exit', receive: (code: number) => void): void;
      terminate(): Promise<number>;
    };
  };
  const worker = new NodeWorker(url, { execArgv: [] });
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer),
    onReply: (receive) => worker.on('message', receive),
    onError: (receive) => {
      worker.on('error', receive);
      worker.on('exit', (code) => receive(new Error(`Mann helper exited with status ${code}.`)));
    },
    terminate: () => void worker.terminate(),
  };
}

class Helper {
  private pending?: { resolve: (reply: MannFftReply) => void; reject: (error: Error) => void };
  private failure?: Error;
  private buffer?: ArrayBuffer;

  constructor(private readonly worker: Endpoint) {
    worker.onReply((reply) => {
      const pending = this.pending;
      this.pending = undefined;
      if ('error' in reply) pending?.reject(loadError(`Mann FFT helper failed. ${reply.error}`));
      else pending?.resolve(reply);
    });
    worker.onError((error) => this.fail(loadError('Run the bundled Mann FFT worker, or use threads: 1.', error)));
  }

  private fail(error: Error) {
    this.failure = error;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private request(message: MannFftRequest, transfer?: ArrayBuffer[]): Promise<MannFftReply> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      try {
        this.worker.postMessage(message, transfer);
      } catch (cause) {
        this.fail(loadError('Send the Mann FFT job through a worker that supports Wasm module cloning.', cause));
      }
    });
  }

  async init(module: WebAssembly.Module, cells: MannFftCells): Promise<void> {
    const reply = await this.request({ module, cells });
    if (!('ready' in reply)) throw loadError('Build the Mann FFT worker with the matching initialisation protocol.');
  }

  async run(field: Float64Array, inverse: boolean): Promise<number> {
    const buffer = this.buffer ?? new ArrayBuffer(field.byteLength);
    this.buffer = undefined;
    new Float64Array(buffer).set(field);
    const reply = await this.request({ buffer, inverse }, [buffer]);
    if (!('buffer' in reply) || reply.buffer.byteLength !== field.byteLength)
      throw loadError('Build the Mann FFT worker with the matching component protocol.');
    this.buffer = reply.buffer;
    field.set(new Float64Array(reply.buffer));
    return reply.products;
  }

  close(): void {
    this.fail(loadError('Keep the Mann FFT helper open until its field transforms finish.'));
    this.worker.terminate();
  }
}

function receipt(): { transforms: number; complexValues: number; simdTwiddleProducts: number } {
  return { transforms: 0, complexValues: 0, simdTwiddleProducts: 0 };
}

/** One private plan on the caller, optionally splitting the two batches over independent component helpers. */
export async function loadMannFft(cells: MannFftCells, { signal, threads = 1 }: Options = {}) {
  signal?.throwIfAborted();
  if (threads !== 1 && threads !== 2 && threads !== 3)
    throw new MargoError('failed', 'Use 1, 2 or 3 Mann FFT threads for the three velocity components.');
  const module = await loadModule(signal);
  const run = bindMannFft(module, cells);
  const helpers: Helper[] = [];
  const participants = Array.from({ length: threads }, receipt);
  const words = 2 * cells[0] * cells[1] * cells[2];
  let closed = false;
  let running = false;
  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    for (const helper of helpers) helper.close();
  }
  signal?.addEventListener('abort', close, { once: true });
  try {
    for (let i = 1; i < threads; i++) {
      const worker = await endpoint();
      if (closed) worker.terminate();
      signal?.throwIfAborted();
      helpers.push(new Helper(worker));
    }
    await Promise.all(helpers.map((helper) => helper.init(module, cells)));
    signal?.throwIfAborted();
  } catch (cause) {
    close();
    signal?.throwIfAborted();
    throw loadError('Start the bundled Mann FFT helpers, or use threads: 1.', cause);
  }

  return {
    async transformBatch(fields: readonly Float64Array[], inverse = false): Promise<void> {
      signal?.throwIfAborted();
      if (closed || running) throw loadError('Run only one Mann FFT batch at a time on an open plan.');
      if (fields.length !== 3 || fields.some((field) => field.length !== words))
        throw loadError(`Pass three separate Mann FFT fields of ${words} interleaved f64 words each.`);
      running = true;
      try {
        // Start helpers first. The calling thread executes its slots while these messages are in flight.
        const remote = Promise.all(helpers.map((helper, i) => helper.run(fields[i + 1]!, inverse)));
        const local = Promise.resolve().then(() =>
          fields.filter((_, i) => i % threads === 0).map((field) => run(field, inverse)),
        );
        const [helperProducts, ownProducts] = await Promise.all([remote, local]);
        signal?.throwIfAborted();
        for (const [i, products] of [ownProducts, ...helperProducts.map((products) => [products])].entries()) {
          const work = participants[i]!;
          work.transforms += products.length;
          work.complexValues += (words / 2) * products.length;
          work.simdTwiddleProducts += products.reduce((sum, product) => sum + product, 0);
        }
      } catch (cause) {
        close();
        signal?.throwIfAborted();
        throw cause;
      } finally {
        running = false;
      }
    },
    workCounts(): MannFftWork {
      const total = receipt();
      for (const work of participants) {
        total.transforms += work.transforms;
        total.complexValues += work.complexValues;
        total.simdTwiddleProducts += work.simdTwiddleProducts;
      }
      return { ...total, threads, workers: helpers.length, participants: participants.map((work) => ({ ...work })) };
    },
    close,
  };
}
