/// <reference lib="esnext.disposable" preserve="true" />
// Opens IFC bytes in a caller-owned web-ifc API after the checks web-ifc needs (STEP header and syntax, size,
// abort), and returns a handle that closes the model on dispose. Every reader of this package takes that handle.
import type { IfcAPI, LoaderSettings } from 'web-ifc';
import { LoaderError } from '@margoengine/loaders/common';
import { checkStep } from './step.js';

/** Options of openIFC: an input size limit, an AbortSignal and native web-ifc settings. */
export interface IFCOpenOptions {
  /** Inputs larger than this reject with `LoaderError` code `limit`. Default 256 MiB. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Native web-ifc settings. Model coordinates are kept unless COORDINATE_TO_ORIGIN is set. */
  settings?: LoaderSettings;
}

/** An open web-ifc model. `close()` (or `using`) releases it; readers reject on a closed model. */
export interface IFCModel {
  readonly api: IfcAPI;
  /** web-ifc's model ID. */
  readonly id: number;
  /** Schema name from the file header, such as `IFC2X3`, `IFC4` or `IFC4X3_ADD2`. */
  readonly schema: string;
  readonly closed: boolean;
  close(): void;
  [Symbol.dispose](): void;
}

export type IFCErrorCode = 'range' | 'limit' | 'header' | 'syntax' | 'unsupported' | 'aborted';
export const fail = (code: IFCErrorCode, message: string): never => {
  throw new LoaderError('IFC', code, message);
};
export const checkAbort = (signal?: AbortSignal) => {
  if (signal?.aborted) fail('aborted', 'aborted; pass a signal that is not aborted to read the model');
};

/** Runs a web-ifc call; its own failures (a JS TypeError from its API layer, a Wasm trap) become named errors. */
export function native<T>(what: string, call: () => T): T {
  try {
    return call();
  } catch (error) {
    if (error instanceof LoaderError) throw error;
    const reason = error instanceof WebAssembly.RuntimeError ? 'Wasm trap' : (error as Error)?.name || 'Error';
    throw Object.assign(
      new LoaderError('IFC', 'unsupported', `web-ifc failed while ${what} (${reason}: ${(error as Error)?.message})`),
      { cause: error },
    );
  }
}

const deletions = new WeakMap<IfcAPI, Map<number, Set<number>>>();
/**
 * expressIDs of the lines deleted from an open model through this package. web-ifc 0.0.78 keeps a deleted line in
 * GetLineIDsWithType (GetAllLines and SaveModel drop it), so readers leave these out.
 */
export function deletedLines(model: IFCModel): Set<number> {
  let byModel = deletions.get(model.api);
  if (!byModel) deletions.set(model.api, (byModel = new Map()));
  let set = byModel.get(model.id);
  if (!set) byModel.set(model.id, (set = new Set()));
  return set;
}

/** Throws unless `model` is an open handle from openIFC. */
export function checkModel(model: IFCModel): void {
  if (!model || typeof model.id !== 'number' || !model.api) fail('range', 'expected an IFCModel; call openIFC first');
  if (model.closed) fail('range', 'the IFC model is closed; open it again with openIFC');
}

/**
 * Checks and opens IFC bytes with an initialized, caller-owned web-ifc API. The bytes must be well-formed
 * ISO 10303-21 first (web-ifc 0.0.78 loops forever on some malformed parameter lists), so a syntax error is
 * `LoaderError` code `syntax`. Close the handle when done: `using model = openIFC(api, bytes)`.
 */
export function openIFC(api: IfcAPI, data: Uint8Array, options: IFCOpenOptions = {}): IFCModel {
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('range', 'limits must be non-negative integers');
  checkAbort(options.signal);
  if (!api || typeof api.OpenModel !== 'function')
    fail('range', 'expected an initialized web-ifc IfcAPI; call Init() first');
  if (!(data instanceof Uint8Array)) fail('range', 'expected Uint8Array; pass the file bytes');
  if (data.byteLength > maxBytes) fail('limit', 'input exceeds maxBytes; raise maxBytes or pass a smaller file');
  if (!/^\s*ISO-10303-21;/i.test(new TextDecoder().decode(data.subarray(0, 128))))
    fail('header', 'expected a STEP IFC file starting with ISO-10303-21;');
  const syntax = checkStep(data);
  if (syntax) fail('syntax', `malformed STEP: ${syntax}; export the file again`);
  const id = native('opening the model', () =>
    api.OpenModel(data, { ALLOW_INCOMPATIBLE_SCHEMA_ALIASES: false, ...options.settings }),
  );
  if (id < 0 || !native('opening the model', () => api.IsModelOpen(id)))
    fail('unsupported', 'web-ifc could not open the model; check the schema is IFC2X3, IFC4 or IFC4X3');
  let schema: string;
  try {
    schema = native('reading the schema', () => api.GetModelSchema(id));
  } catch (error) {
    try {
      api.CloseModel(id);
    } catch {}
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    deletions.get(api)?.delete(id);
    // After a trap CloseModel may throw too; the first error is the one to report.
    try {
      api.CloseModel(id);
    } catch {}
  };
  const handle = {
    api,
    id,
    schema,
    get closed() {
      return closed;
    },
    close,
  };
  // Symbol.dispose is missing in browsers without explicit resource management; close() works everywhere.
  if (typeof Symbol.dispose === 'symbol') Object.defineProperty(handle, Symbol.dispose, { value: close });
  return handle as IFCModel;
}
