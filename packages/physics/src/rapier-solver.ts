// The Rapier solver, a lazy chunk of its own: Physics.load() imports it, nothing else does. The package build bundles
// Rapier's JavaScript from @dimforge/rapier3d and copies its Wasm beside this chunk as dist/rapier3d.wasm, so the Wasm
// stays a file that bundlers emit as an asset and browsers compile while it downloads (WebAssembly.instantiateStreaming).
import { MargoError } from '@margoengine/math/errors';
import * as RAPIER from '@dimforge/rapier3d';
import * as glue from '@dimforge/rapier3d/rapier_wasm3d_bg.js';
import type { RapierModule } from './rapier-types.js';

/** Where Rapier's Wasm comes from: a URL, a fetched `Response`, its bytes or a compiled `WebAssembly.Module`. */
export type RapierWasmSource = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module;

// A name, not a literal: bundlers for the browser must not try to resolve Node's modules from this file.
const nodeImport = <T>(name: string): Promise<T> => import(/* @vite-ignore */ /* webpackIgnore: true */ name);

/**
 * The Wasm this package ships, beside this chunk in dist. The literal reaches the app's bundler unchanged, which emits
 * the file as an asset; `?no-inline` keeps Vite (in library mode too) from inlining it as base64.
 */
export const defaultWasm = (): URL => new URL(/* @vite-ignore */ './rapier3d.wasm?no-inline', import.meta.url);
// The version of the Rapier build bundled here and a hash of its Wasm's exports and imports, swapped in by the package
// build after bundling.
declare const __RAPIER_VERSION__: string;
declare const __RAPIER_INTERFACE__: number;

const failed = (what: string, cause?: unknown): MargoError =>
  Object.assign(
    new MargoError(
      'failed',
      `Rapier's Wasm ${what}; serve dist/rapier3d.wasm from @margoengine/physics, or pass Physics.load({wasm}) a URL that serves it`,
    ),
    cause === undefined ? {} : { cause },
  );

// What the Wasm imports: the glue module, under the name wasm-bindgen gave it.
const imports = { './rapier_wasm3d_bg.js': glue as unknown as WebAssembly.ModuleImports };

async function response(source: Response, signal: AbortSignal): Promise<WebAssembly.WebAssemblyInstantiatedSource> {
  if (!source.ok) throw failed(`could not be fetched from ${source.url || 'the response'} (${source.status} ${source.statusText})`.trimEnd());
  // A server that labels the file application/wasm lets the browser compile it while it downloads; any other label
  // makes instantiateStreaming refuse it, so the bytes are read first.
  if (typeof WebAssembly.instantiateStreaming === 'function' && /^application\/wasm\b/i.test(source.headers.get('content-type') ?? ''))
    return WebAssembly.instantiateStreaming(source, imports);
  const bytes = await source.arrayBuffer();
  signal.throwIfAborted();
  return WebAssembly.instantiate(bytes, imports);
}

/**
 * Compiles Rapier's Wasm from `source` and returns the ready module. Rapier keeps one instance per app, so the first
 * call that succeeds wins. `signal` cancels the download and the wait.
 * @throws MargoError (`failed`) when the Wasm cannot be fetched or is not Rapier's.
 */
export async function startRapier(source: RapierWasmSource, signal: AbortSignal): Promise<RapierModule> {
  signal.throwIfAborted();
  let compiled: WebAssembly.WebAssemblyInstantiatedSource;
  try {
    if (source instanceof WebAssembly.Module) compiled = { module: source, instance: await WebAssembly.instantiate(source, imports) };
    else if (typeof Response === 'function' && source instanceof Response) compiled = await response(source, signal);
    else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source))
      compiled = await WebAssembly.instantiate(source as BufferSource, imports);
    else {
      let url: URL;
      try {
        url = new URL(source as string | URL, globalThis.location?.href);
      } catch (error) {
        throw new TypeError(`Physics.load wasm must be a URL, a Response, bytes or a WebAssembly.Module; got ${String(source)}`, { cause: error });
      }
      if (url.protocol === 'file:') {
        // Node, Bun and Deno read a file URL; fetch() in Node cannot.
        const { readFile } = await nodeImport<{ readFile(file: URL, options: { signal: AbortSignal }): Promise<Uint8Array> }>(
          'node:fs/promises',
        );
        let bytes: Uint8Array;
        try {
          bytes = await readFile(url, { signal });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw failed(`could not be read from ${url.href}`, error);
        }
        compiled = await WebAssembly.instantiate(bytes as BufferSource, imports);
      } else {
        let fetched: Response;
        try {
          fetched = await fetch(url, { signal });
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw failed(`could not be fetched from ${url.href}`, error);
        }
        compiled = await response(fetched, signal);
      }
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError) {
      // A CSP that forbids Wasm is its own fix; leave that error to the caller's translation.
      if (/wasm-unsafe-eval|content security policy|\bCSP\b|disallowed by embedder/i.test(error.message)) throw error;
      throw failed('is not the Rapier build this package bundles', error);
    }
    throw error;
  }
  signal.throwIfAborted();
  checkRapier(compiled);
  glue.__wbg_set_wasm(compiled.instance.exports);
  return RAPIER as unknown as RapierModule;
}

/** FNV-1a over `text`: the package build hashes the bundled Wasm's interface the same way. */
function interfaceHash(module: WebAssembly.Module): number {
  const text =
    WebAssembly.Module.exports(module).map((entry) => `${entry.kind}:${entry.name}`).join(',') +
    '|' +
    WebAssembly.Module.imports(module).map((entry) => `${entry.kind}:${entry.module}:${entry.name}`).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

/**
 * Throws unless `compiled` is the Rapier build bundled here. Any valid Wasm instantiates, so a foreign module (a wrong
 * URL that serves some other Wasm, another Rapier version) would otherwise reach Rapier's glue, which keeps views of
 * the first memory it is given and cannot be pointed at another instance afterwards. So the check runs before the glue
 * sees the instance: the module's exports and imports must match the bundled build's, and the version it reports
 * (read the way the glue reads it) must be the bundled one.
 */
function checkRapier({ module, instance }: WebAssembly.WebAssemblyInstantiatedSource): void {
  if (interfaceHash(module) !== __RAPIER_INTERFACE__)
    throw failed('is not the Rapier build this package bundles (its exports and imports differ)');
  const wasm = instance.exports as {
    memory: WebAssembly.Memory;
    version(result: number): void;
    __wbindgen_add_to_stack_pointer(delta: number): number;
    // The bundled build's name for its free(); the interface check above guarantees it exists. Rapier's glue frees
    // the version string with it too.
    __wbindgen_export2(pointer: number, length: number, align: number): void;
  };
  const result = wasm.__wbindgen_add_to_stack_pointer(-16);
  let version: string;
  try {
    wasm.version(result);
    const view = new DataView(wasm.memory.buffer),
      pointer = view.getInt32(result, true),
      length = view.getInt32(result + 4, true);
    version = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, pointer, length));
    wasm.__wbindgen_export2(pointer, length, 1);
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16);
  }
  if (version !== __RAPIER_VERSION__) throw failed(`is Rapier ${version}, not the ${__RAPIER_VERSION__} build this package bundles`);
}
