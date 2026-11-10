import { RpcClient, exposeRpc, rpcTransfer, type RpcEndpoint } from '@margoengine/worker/rpc';
import { fault } from '../../shared/errors.js';
import {
  encodeReader,
  decodeReader,
  readerBuffers,
  type ReaderProtocol,
  type ReaderCallbacks,
  type RemoteFunction,
} from './reader-wire.js';
import type { loadNRRD } from './nrrd.js';
import type { loadNIfTI, parseNIfTI, parseDICOM, dicomSeries, loadDICOMSeries, openZarr } from './formats.js';
import type { parseVtk, openVTK } from './vtk.js';
import type { openNetCDF } from './netcdf.js';

/** All batch 175 readers, with their existing arguments and defaults. */
export interface WorkerReaders {
  loadNRRD: typeof loadNRRD;
  loadNIfTI: typeof loadNIfTI;
  parseNIfTI: typeof parseNIfTI;
  parseDICOM: typeof parseDICOM;
  dicomSeries: typeof dicomSeries;
  loadDICOMSeries: typeof loadDICOMSeries;
  openZarr: typeof openZarr;
  parseVtk: typeof parseVtk;
  openVTK: typeof openVTK;
  openNetCDF: typeof openNetCDF;
}
/** Reader methods become promises; arrays, tuples and typed buffers retain their shape. */
export type RemoteReader<T> = T extends (...args: infer A) => infer R
  ? (...args: A) => Promise<RemoteReader<Awaited<R>>>
  : T extends ArrayBuffer | ArrayBufferView
    ? T
    : T extends readonly unknown[]
      ? { [K in keyof T]: RemoteReader<T[K]> }
      : T extends object
        ? { [K in keyof T as K extends symbol ? never : K]: RemoteReader<T[K]> }
        : T;
/** Ordered operation milestones, not estimates of parsing percentage. */
export interface ReaderProgress {
  /** Operation that produced this milestone. */
  operation: string;
  /** Started, or successfully decoded and ready for transfer. */
  phase: 'start' | 'complete';
  /** Unique backing-buffer bytes in this operation's input or output. Excludes network and retained caches. */
  bytes: number;
}
/** Worker transport options. Original reader options stay in the argument tuple. */
export interface ReaderWorkerOptions {
  /** Session lifetime cancellation. Cancelling any call terminates its session, including synchronous parsing. */
  signal?: AbortSignal;
  /** Explicit input buffers to move, detaching them. Default none; unlisted input buffers are cloned. */
  transfer?: ArrayBuffer[];
  /** Per-operation response deadline in milliseconds. Default 30000. Expiration terminates the session. */
  timeout?: number;
  /** Ordered start/complete milestones for opening and lazy reads. Default none. */
  onProgress?: (progress: ReaderProgress) => void;
  /** Worker factory for hosts such as Node. Default a bundled classic browser Worker. Ownership passes to the session. */
  worker?: () => RpcEndpoint & { terminate(): unknown };
}
/** Owns one worker and all its lazy reader state. Dispose after the last read. */
export interface ReaderSession<T> {
  /** Cloneable metadata and asynchronous proxies to methods retained in the worker. */
  readonly value: RemoteReader<T>;
  /** True once the worker has been terminated. */
  readonly disposed: boolean;
  /** Cancels pending work, removes callbacks and immediately terminates the worker. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Runs a reader entirely in a dedicated worker through @margoengine/worker RPC. Never falls back to the page. */
export async function readInWorker<K extends keyof WorkerReaders>(
  reader: K,
  args: Parameters<WorkerReaders[K]>,
  options: ReaderWorkerOptions = {},
): Promise<ReaderSession<Awaited<ReturnType<WorkerReaders[K]>>>> {
  options.signal?.throwIfAborted();
  // Relative sources belong to the calling document, not to the worker asset's directory.
  const inputArgs: unknown[] = [...args];
  const absolute = (value: unknown) =>
    typeof value === 'string' || value instanceof URL ? new URL(value, globalThis.location?.href).href : value;
  if (['loadNRRD', 'loadNIfTI', 'openZarr', 'openNetCDF', 'openVTK'].includes(reader))
    inputArgs[0] = absolute(inputArgs[0]);
  else if (reader === 'loadDICOMSeries') inputArgs[0] = (inputArgs[0] as unknown[]).map(absolute);
  const callbacks = new Map<number, RemoteFunction>();
  const endpoint =
    options.worker?.() ??
    new Worker(new URL(/* @vite-ignore */ './workers/readers.js?no-inline', '' + import.meta.url));
  const client = new RpcClient<ReaderProtocol>(endpoint);
  let closed = false;
  const signals = new Set<AbortSignal>();
  const server = exposeRpc<ReaderCallbacks>(
    {
      async callback(id, encoded, context) {
        const fn = callbacks.get(id);
        if (!fn) throw fault('state', 'Reader callback has expired; open a new session', 'sciviz');
        const decoded = decodeReader(
          encoded,
          async () => {
            throw fault('state', 'Unexpected nested callback', 'sciviz');
          },
          context.signal,
        ) as unknown[];
        const result = encodeReader(await fn(...decoded), callbacks);
        // A store or resolver may retain its original buffers. Snapshot before transferring a response.
        const snapshot = structuredClone(result);
        return rpcTransfer(snapshot, readerBuffers(snapshot));
      },
    },
    endpoint,
  );
  const dispose = () => {
    if (closed) return;
    closed = true;
    for (const signal of signals) signal.removeEventListener('abort', dispose);
    signals.clear();
    client.dispose();
    server.dispose();
    callbacks.clear();
    endpoint.terminate();
  };
  const collectSignals = (value: unknown, current: AbortSignal[] = []): AbortSignal[] => {
    if (value instanceof AbortSignal) current.push(value);
    else if (Array.isArray(value)) value.forEach((v) => collectSignals(v, current));
    else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer))
      Object.values(value).forEach((v) => collectSignals(v, current));
    return current;
  };
  const call = async (
    method: 'open' | 'invoke',
    parameters: [string | number, unknown[]],
    transfer: ArrayBuffer[] = [],
  ): Promise<unknown> => {
    if (closed) throw fault('state', 'Reader session disposed; open a new session', 'sciviz');
    const active = [...(options.signal ? [options.signal] : []), ...collectSignals(parameters[1])];
    const signal = active.length ? AbortSignal.any(active) : undefined;
    signal?.throwIfAborted();
    const wire = encodeReader(parameters[1], callbacks);
    const rpcOptions = {
      signal,
      transfer,
      timeout: options.timeout,
      onProgress: (value: unknown) => options.onProgress?.(value as ReaderProgress),
    };
    const promise =
      method === 'open'
        ? client.call('open', [String(parameters[0]), wire], rpcOptions)
        : client.call('invoke', [Number(parameters[0]), wire], rpcOptions);
    // RPC installs its rejection listener first, preserving the caller's abort reason.
    if (signal) {
      signals.add(signal);
      signal.addEventListener('abort', dispose, { once: true });
    }
    try {
      const result = await promise;
      return decodeReader(result, (id, next) => call('invoke', [id, next]));
    } catch (error) {
      if (client.disposed || signal?.aborted) dispose();
      throw error;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', dispose);
        signals.delete(signal);
      }
    }
  };
  try {
    const value = await call('open', [reader, inputArgs], options.transfer);
    // An opening signal is also the lifetime signal of lazy reader state.
    for (const signal of [...(options.signal ? [options.signal] : []), ...collectSignals(args)]) {
      signals.add(signal);
      signal.addEventListener('abort', dispose, { once: true });
      if (signal.aborted) {
        dispose();
        signal.throwIfAborted();
      }
    }
    return {
      value: value as RemoteReader<Awaited<ReturnType<WorkerReaders[K]>>>,
      get disposed() {
        return closed;
      },
      dispose,
      [Symbol.dispose]: dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
