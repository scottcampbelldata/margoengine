import { LoaderError } from '@margoengine/loaders';
import { movable, runWorker } from '../../shared/worker.js';
import type { IFCOptions, IFCResult } from './index.js';

export interface IFCWorkerOptions extends IFCOptions {
  /** URL of web-ifc's classic-script build (`web-ifc/web-ifc-api-iife.js`), served by the app. */
  webIfc: string | URL;
  /** Folder of `web-ifc.wasm` (passed to `SetWasmPath(path, true)`); default: next to the script. */
  wasmPath?: string;
  /** The worker is terminated and the call rejects with `LoaderError` code `limit` after this. Default 60,000 ms. */
  timeoutMs?: number;
}

const workerURL = () => new URL('./workers/ifc.js?no-inline', import.meta.url);
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
