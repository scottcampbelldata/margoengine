// Node has no Web Worker, so the Draco decoders decode in the calling thread there (GAP-FILM-DRACO-NODE), as `nodeKTX2`
// and `decodeImage` do for Basis Universal: the same Wasm and the same decode functions the workers run, so a model
// loads with the same geometry in Node as in a browser. Elsewhere without workers (an edge runtime) decoding still
// rejects with `unsupported`. Nothing here runs at import time and no Node module is named statically, so browser
// bundles never try to resolve one.
import { wasmError } from '../../shared/errors.js';
import { decodeFailed, deviceUnsupported, isDecoderCrash } from './errors.js';
import type { ModuleBox } from './codec.js';
import type { DracoPointsRequest, DracoRequest } from './protocol.js';
import type { DracoModule } from './vendor-codecs.js';

/** True in Node, which has no Web Worker: decode in this thread. */
export const inThread = (): boolean =>
  typeof Worker === 'undefined' &&
  typeof (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node === 'string';

// A name, not a literal: bundlers for the browser must not try to resolve Node's modules from this file.
const nodeImport = <T>(name: string): Promise<T> => import(/* @vite-ignore */ /* webpackIgnore: true */ name);

interface NodeModules {
  createRequire(from: string): (id: string) => unknown;
  readFile(file: URL): Promise<Uint8Array>;
  fileURLToPath(file: URL): string;
  pathToFileURL(path: string): URL;
  resolve(...paths: string[]): string;
}

let node: Promise<NodeModules> | undefined;
function nodeModules(): Promise<NodeModules> {
  node ??= Promise.all([
    nodeImport<{ createRequire: NodeModules['createRequire'] }>('node:module'),
    nodeImport<{ readFile: NodeModules['readFile'] }>('node:fs/promises'),
    nodeImport<{ fileURLToPath: NodeModules['fileURLToPath']; pathToFileURL: NodeModules['pathToFileURL'] }>(
      'node:url',
    ),
    nodeImport<{ resolve: NodeModules['resolve'] }>('node:path'),
  ]).then(([{ createRequire }, { readFile }, { fileURLToPath, pathToFileURL }, { resolve }]) => ({
    createRequire,
    readFile,
    fileURLToPath,
    pathToFileURL,
    resolve,
  }));
  return node;
}

/**
 * The folder a decoder's Wasm lives in, in Node: the folder of the package's own copy (`bundled`, a file in it), or `decoderPath` as a folder on disk (a path,
 * relative to the working directory, or a file: URL). A web address is refused: Node loads the decoder from disk.
 */
export async function nodeFolder(decoderPath: string | undefined, bundled: () => URL): Promise<URL> {
  if (decoderPath === undefined) return new URL('.', bundled());
  const { pathToFileURL, resolve } = await nodeModules(),
    slash = (text: string) => (text.endsWith('/') || text.endsWith('\\') ? text : text + '/');
  // Two or more letters before the colon: a URL scheme, not a Windows drive letter.
  if (/^[a-z][a-z0-9+.-]+:/i.test(decoderPath)) {
    const url = new URL(slash(decoderPath));
    if (url.protocol !== 'file:')
      throw deviceUnsupported(
        `Node loads the decoder from disk, not ${url.protocol}; set decoderPath to a folder on disk or leave it unset`,
      );
    return url;
  }
  return pathToFileURL(slash(resolve(decoderPath)));
}

/** Read a file of the package or of `decoderPath` in Node. */
export async function nodeBytes(file: URL): Promise<ArrayBuffer> {
  const { readFile } = await nodeModules(),
    bytes = await readFile(file);
  return bytes.slice().buffer as ArrayBuffer;
}

const draco = new Map<string, Promise<ModuleBox<DracoModule>>>();

/**
 * Google's Draco Emscripten build from `folder` (draco_wasm_wrapper.js and draco_decoder.wasm), loaded once per folder
 * with Node's require, so the glTF and the full build keep their own module objects. `drop` forgets a module after a
 * Wasm trap, as a worker does, so the next decode starts a fresh one.
 */
export const nodeDraco = {
  load(folder: URL): Promise<ModuleBox<DracoModule>> {
    let loading = draco.get(folder.href);
    if (!loading) {
      loading = (async () => {
        const { createRequire, fileURLToPath } = await nodeModules(),
          wasmBinary = await nodeBytes(new URL('draco_decoder.wasm', folder)),
          // The Emscripten wrapper is a CommonJS script; its folder's package.json says so (scripts/build.js).
          factory = createRequire(import.meta.url)(fileURLToPath(new URL('draco_wasm_wrapper.js', folder)));
        if (typeof factory !== 'function')
          throw decodeFailed(
            'Draco wrapper did not export DracoDecoderModule in Node; use the unmodified draco_wasm_wrapper.js, in a folder that is not an ES module package',
          );
        return new Promise<ModuleBox<DracoModule>>((resolve, reject) => {
          (factory as (options: { wasmBinary: ArrayBuffer }) => PromiseLike<DracoModule>)({ wasmBinary }).then(
            (module) => resolve({ module }),
            reject,
          );
        }).catch((error) => {
          throw wasmError(error);
        });
      })();
      const mine = loading;
      mine.catch(() => {
        if (draco.get(folder.href) === mine) draco.delete(folder.href);
      });
      draco.set(folder.href, mine);
    }
    return loading;
  },
  drop(folder: URL): void {
    draco.delete(folder.href);
  },
};

const instances = new Map<string, Promise<WebAssembly.Exports>>();

/** A Wasm module with no imports (the clean-room Draco decoder), read from disk and instantiated once per file. */
export const nodeInstance = {
  load(file: URL): Promise<WebAssembly.Exports> {
    let loading = instances.get(file.href);
    if (!loading) {
      const mine = (async () => {
        const bytes = await nodeBytes(file);
        try {
          return (await WebAssembly.instantiate(bytes)).instance.exports;
        } catch (error) {
          throw wasmError(error);
        }
      })();
      mine.catch(() => {
        if (instances.get(file.href) === mine) instances.delete(file.href);
      });
      instances.set(file.href, (loading = mine));
    }
    return loading;
  },
  drop(file: URL): void {
    instances.delete(file.href);
  },
};

/**
 * Decode a Draco buffer in this thread with Google's build from `decoderPath` or the package's `bundled` folder: the
 * same decode the worker runs. Signals are checked before and after; a Wasm trap drops the module, as in a worker.
 */
export async function dracoHere<T>(
  decoderPath: string | undefined,
  bundled: () => URL,
  bytes: ArrayBuffer,
  request: DracoRequest | DracoPointsRequest,
  signal: AbortSignal | undefined,
  points: boolean,
): Promise<T> {
  const folder = await nodeFolder(decoderPath, bundled),
    [{ module }, codec] = await Promise.all([nodeDraco.load(folder), import('./draco-here.js')]);
  signal?.throwIfAborted();
  try {
    return codec.decodeHere<T>(module, bytes, request, points);
  } catch (error) {
    if (isDecoderCrash(error)) nodeDraco.drop(folder);
    throw error;
  }
}
