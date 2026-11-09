import { wasmError } from '../../shared/errors.js';
// Runs prebuilt Wasm encoders away from the caller's frame: in a classic worker in a browser, where a long encode must not
// stop the page, and in process in Node, where there is no Web Worker and nothing to keep responsive. Both load the
// vendored file only when an encode starts.

import { MargoError, type MargoErrorCode } from '@margoengine/math/errors';

/** Emscripten modules are thenable, so they travel inside a box to keep promise resolution finite. */
export interface ModuleBox<T> {
  module: T;
}

/** What a module may be told besides its Wasm: where its printing goes. */
export type ModuleOptions = Record<string, unknown>;

/** An Emscripten module factory. */
export type Factory<T> = (options: { wasmBinary: ArrayBuffer } & ModuleOptions) => PromiseLike<T>;

/** Calls an Emscripten factory, keeping the module out of promise resolution. */
export const boxed = <T>(
  factory: Factory<T>,
  wasmBinary: ArrayBuffer,
  options: ModuleOptions = {},
): Promise<ModuleBox<T>> =>
  new Promise<ModuleBox<T>>((resolve, reject) => {
    factory({ ...options, wasmBinary }).then((module) => resolve({ module }), reject);
  }).catch((error) => {
    throw wasmError(error);
  });

// A name, not a literal: bundlers for the browser must not try to resolve Node's modules from this file.
const nodeImport = <T>(name: string): Promise<T> => import(/* @vite-ignore */ /* webpackIgnore: true */ name);

/** A file in a caller's encoder folder, given as a URL. */
export function encoderFile(folder: string, file: string): URL {
  return new URL(file, new URL(folder.endsWith('/') ? folder : folder + '/', globalThis.location?.href));
}

/** Loads a vendored Emscripten factory and its Wasm from disk, in Node. The folder's package.json marks it CommonJS. */
export async function loadInNode<T>(wrapper: URL, wasm: URL, options?: ModuleOptions): Promise<ModuleBox<T>> {
  const [{ createRequire }, { readFile }, { fileURLToPath }] = await Promise.all([
    nodeImport<{ createRequire(from: string): (id: string) => Factory<T> }>('node:module'),
    nodeImport<{ readFile(file: URL): Promise<Uint8Array> }>('node:fs/promises'),
    nodeImport<{ fileURLToPath(file: URL): string }>('node:url'),
  ]);
  const factory = createRequire(import.meta.url)(fileURLToPath(wrapper)),
    bytes = await readFile(wasm);
  return boxed<T>(
    factory,
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    options,
  );
}

/** One message to the encoder worker, without its id. */
export interface EncoderRequest {
  kind: string;
  wrapperURL: string;
  wasmURL: string;
  job: unknown;
}

const aborted = (signal: AbortSignal | undefined): unknown =>
  signal?.reason ?? new DOMException('Aborted', 'AbortError');

// The worker is a prebuilt classic script, because importScripts needs one. Its URL stays out of `new Worker(...)` so
// bundlers copy it as an asset instead of rebuilding it; `?no-inline` keeps it a file, never a data: URL.
const workerURL = (): URL => new URL('./encoder.worker.js?no-inline', import.meta.url);

/** Sends `requests` to one worker in turn and returns the results in order. An abort ends the worker at once. */
export function inWorker<R>(
  requests: readonly EncoderRequest[],
  transfer: (request: EncoderRequest) => Transferable[],
  signal?: AbortSignal,
): Promise<R[]> {
  const worker = new Worker(workerURL(), { name: 'margoengine-encoder' }),
    results: R[] = [];
  return new Promise<R[]>((resolve, reject) => {
    const next = (): void => {
      if (results.length === requests.length) return resolve(results);
      const request = requests[results.length];
      worker.postMessage({ ...request, id: results.length }, transfer(request));
    };
    const onAbort = (): void => reject(aborted(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (event) => {
      event.preventDefault();
      reject(
        new MargoError(
          'failed',
          `Encoder worker failed: ${event.message}; check that encoder.worker.js and the Wasm are served`,
        ),
      );
    };
    worker.onmessage = ({ data }) => {
      if (data.error) return reject(rebuilt(data.error));
      results.push(data.result);
      next();
    };
    next();
  }).finally(() => worker.terminate());
}

/**
 * A worker's error in the type the same failure has in process. Structured clone would turn a MargoError into a plain
 * Error and drop its code, so the worker sends the parts.
 */
function rebuilt({ name, message, code }: { name: string; message: string; code?: MargoErrorCode }): Error {
  if (name === 'TypeError') return new TypeError(message);
  if (name === 'RangeError') return new RangeError(message);
  return new MargoError(code ?? 'failed', message);
}

/** Runs `run` on each job in process, letting an abort in between. */
export async function inProcess<J, R>(jobs: readonly J[], run: (job: J) => R, signal?: AbortSignal): Promise<R[]> {
  const results: R[] = [];
  let turn = performance.now();
  for (const job of jobs) {
    signal?.throwIfAborted();
    results.push(run(job));
    // A timer tick costs a millisecond, so a file of many small meshes pays for one only every so often.
    if (performance.now() - turn > 50) {
      await new Promise((resolve) => setTimeout(resolve));
      turn = performance.now();
    }
  }
  signal?.throwIfAborted();
  return results;
}
