import { LoaderError } from '@margoengine/loaders/common';
import { movable, reviveError, runWorker, transferables } from '../../shared/worker.js';
import type { IFCOptions, IFCResult } from './index.js';
import type { IFCMeshChunk, IFCStreamOptions } from './meshes.js';
import type { IFCOpenOptions } from './open.js';

/** Options of parseIFCInWorker: IFCOptions plus the web-ifc script and wasm locations and the worker time limit. */
export interface IFCWorkerOptions extends IFCOptions {
  /** URL of web-ifc's classic-script build (`web-ifc/web-ifc-api-iife.js`), served by the app. */
  webIfc: string | URL;
  /** Folder of `web-ifc.wasm` (passed to `SetWasmPath(path, true)`); default: next to the script. */
  wasmPath?: string;
  /** The worker is terminated and the call rejects with `LoaderError` code `limit` after this. Default 60,000 ms. */
  timeoutMs?: number;
}

const workerURL = () => new URL(/* @vite-ignore */ './workers/ifc.js?no-inline', import.meta.url);
const revive = (e: { name: string; message: string; [key: string]: unknown }) =>
  e.name === 'LoaderError'
    ? Object.assign(new LoaderError(e.format as string, e.code as LoaderError['code'], ''), { message: e.message })
    : undefined;

/**
 * parseIFC in a fresh worker with a deadline. web-ifc 0.0.78 can loop forever inside its Wasm on schema-invalid
 * models (a string where a list belongs, a missing attribute), which no check before it can rule out; on this thread
 * that hangs the page. Here the worker is terminated after `timeoutMs` and the call rejects with a named error.
 * A whole ArrayBuffer input moves to the worker (pass a copy to keep it).
 */
export async function parseIFCInWorker(
  data: Uint8Array | ArrayBuffer,
  { webIfc, wasmPath, timeoutMs = 60_000, signal, ...options }: IFCWorkerOptions,
): Promise<IFCResult> {
  if (typeof Worker !== 'function') throw new LoaderError('IFC', 'unsupported', 'parseIFCInWorker needs Web Workers');
  if (!(timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1)) throw new LoaderError('IFC', 'range', 'timeoutMs must be positive');
  const stop = new AbortController(),
    forward = () => stop.abort(signal!.reason),
    timer = setTimeout(
      () => stop.abort(new LoaderError('IFC', 'limit', `web-ifc did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
  signal?.throwIfAborted();
  signal?.addEventListener('abort', forward, { once: true });
  try {
    return await runWorker(
      workerURL(),
      { data: movable(data), webIfc: new URL(webIfc, globalThis.location?.href).href, wasmPath, options },
      stop.signal,
      revive,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forward);
  }
}

/** Options of streamIFCInWorker: streamIFCMeshes' and openIFC's options plus the web-ifc locations and a time limit. */
export interface IFCStreamWorkerOptions extends IFCStreamOptions, IFCOpenOptions {
  /** URL of web-ifc's classic-script build (`web-ifc/web-ifc-api-iife.js`), served by the app. */
  webIfc: string | URL;
  /** Folder of `web-ifc.wasm` (passed to `SetWasmPath(path, true)`); default: next to the script. */
  wasmPath?: string;
  /**
   * The worker is terminated and the stream rejects with `LoaderError` code `limit` when it sends nothing (no chunk,
   * no end) for this long. Default 60,000 ms.
   */
  timeoutMs?: number;
}

/**
 * streamIFCMeshes in a fresh worker: the file is opened and its meshes read off this thread, and each chunk arrives
 * as soon as the worker has read it (its buffers moved, not copied), so the page draws the first chunks while the
 * worker reads the rest. Stopping the loop early (`break`), aborting `signal` or a worker that sends nothing for
 * `timeoutMs` terminates the worker. The worker starts on the first `next()`. A whole ArrayBuffer input moves to it.
 */
export async function* streamIFCInWorker(
  data: Uint8Array | ArrayBuffer,
  { webIfc, wasmPath, timeoutMs = 60_000, signal, ...options }: IFCStreamWorkerOptions,
): AsyncGenerator<IFCMeshChunk, void, undefined> {
  if (typeof Worker !== 'function') throw new LoaderError('IFC', 'unsupported', 'streamIFCInWorker needs Web Workers');
  if (!(timeoutMs > 0 && timeoutMs <= 2 ** 31 - 1)) throw new LoaderError('IFC', 'range', 'timeoutMs must be positive');
  signal?.throwIfAborted();
  const queue: IFCMeshChunk[] = [];
  let end: { error?: unknown } | undefined,
    wake: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  const worker = new Worker(new URL(/* @vite-ignore */ './workers/ifc-stream.js?no-inline', import.meta.url), { name: 'margoengine-parser' });
  const finish = (state: { error?: unknown }) => {
    if (end) return;
    end = state;
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    wake?.();
  };
  const abort = () => finish({ error: signal!.reason }),
    arm = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => finish({ error: new LoaderError('IFC', 'limit', `the IFC worker sent nothing for ${timeoutMs} ms`) }),
        timeoutMs,
      );
    };
  signal?.addEventListener('abort', abort, { once: true });
  worker.onerror = (event) => {
    event.preventDefault?.();
    finish({ error: new Error('IFC worker failed: ' + (event.message || 'unknown error')) });
  };
  worker.onmessageerror = () => finish({ error: new Error('IFC worker reply could not be deserialized') });
  worker.onmessage = ({ data: reply }) => {
    if (reply?.chunk) {
      queue.push(reply.chunk);
      arm();
      wake?.();
    } else if (reply?.done) finish({});
    else if (reply?.error) finish({ error: revive(reply.error) ?? reviveError(reply.error) });
    else finish({ error: new TypeError('IFC worker sent an invalid reply') });
  };
  try {
    arm();
    const message = {
      buffer: movable(data),
      webIfc: new URL(webIfc, globalThis.location?.href).href,
      wasmPath,
      options: { ...options, elements: options.elements && [...options.elements] },
    };
    worker.postMessage(message, [...transferables(message)] as Transferable[]);
    for (;;) {
      if (end?.error !== undefined) throw end.error;
      const chunk = queue.shift();
      if (chunk) yield chunk;
      else if (end) return;
      else await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
  } finally {
    finish({});
  }
}
