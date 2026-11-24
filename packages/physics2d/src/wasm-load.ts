// Loads the kernel's Wasm: a URL, a fetched `Response`, bytes or a compiled module, checked to be this package's build
// before anything calls into it. The kernel imports nothing and reports its interface version through `api_version()`.
// The fetching follows the other bundled builds of this repository (packages/shared/bindgen-wasm.js, which reads a
// wasm-bindgen build's version and cannot read this one's).
import { MargoError } from '@margoengine/math/errors';

// A name, not a literal: bundlers for the browser must not try to resolve Node's modules from this file.
const nodeImport = (name: string): Promise<{ readFile(url: URL, options: { signal: AbortSignal }): Promise<Uint8Array> }> =>
  import(/* @vite-ignore */ /* webpackIgnore: true */ name);

/** Where the kernel's Wasm comes from: a URL, a fetched `Response`, its bytes or a compiled `WebAssembly.Module`. */
export type KernelWasmSource = string | URL | Response | ArrayBuffer | ArrayBufferView | WebAssembly.Module;

/** What the loader knows of the build it expects. */
export interface KernelBuild {
  file: string;
  /** The interface version `api_version()` reports. */
  version: string;
  /** A hash of the module's exports and imports. */
  interface: number;
}

/** FNV-1a over the module's exports and imports. */
export function interfaceHash(module: WebAssembly.Module): number {
  const text =
    WebAssembly.Module.exports(module).map((entry) => `${entry.kind}:${entry.name}`).join(',') +
    '|' +
    WebAssembly.Module.imports(module).map((entry) => `${entry.kind}:${entry.module}:${entry.name}`).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

const failure = (build: KernelBuild, what: string, cause?: unknown): MargoError =>
  Object.assign(
    new MargoError(
      'failed',
      `Physics2D kernel's Wasm ${what}; serve dist/${build.file} from @margoengine/physics2d, or pass Physics2D.load({wasm}) a URL that serves it`,
    ),
    cause === undefined ? {} : { cause },
  );

interface Compiled {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
}

async function fromBytes(bytes: BufferSource): Promise<Compiled> {
  const { module, instance } = await WebAssembly.instantiate(bytes, {});
  return { module, instance };
}

async function fromResponse(source: Response, signal: AbortSignal, build: KernelBuild): Promise<Compiled> {
  if (!source.ok)
    throw failure(build, `could not be fetched from ${source.url || 'the response'} (${source.status} ${source.statusText})`.trimEnd());
  // A server that labels the file application/wasm lets the browser compile it while it downloads; any other label
  // makes instantiateStreaming refuse it, so the bytes are read first.
  if (typeof WebAssembly.instantiateStreaming === 'function' && /^application\/wasm\b/i.test(source.headers.get('content-type') ?? ''))
    return WebAssembly.instantiateStreaming(source, {}).then(({ module, instance }) => ({ module, instance }));
  const bytes = await source.arrayBuffer();
  signal.throwIfAborted();
  return fromBytes(bytes);
}

async function compile(source: KernelWasmSource, signal: AbortSignal, build: KernelBuild): Promise<Compiled> {
  if (source instanceof WebAssembly.Module) return { module: source, instance: await WebAssembly.instantiate(source, {}) };
  if (typeof Response === 'function' && source instanceof Response) return fromResponse(source, signal, build);
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return fromBytes(source as BufferSource);
  let url: URL;
  try {
    url = new URL(source as string | URL, (globalThis as { location?: { href: string } }).location?.href);
  } catch (error) {
    throw new TypeError(`Physics2D.load wasm must be a URL, a Response, bytes or a WebAssembly.Module; got ${String(source)}`, { cause: error });
  }
  if (url.protocol === 'file:') {
    // Node, Bun and Deno read a file URL; fetch() in Node cannot.
    const { readFile } = await nodeImport('node:fs/promises');
    let bytes: Uint8Array;
    try {
      bytes = await readFile(url, { signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw failure(build, `could not be read from ${url.href}`, error);
    }
    return fromBytes(bytes as BufferSource);
  }
  let fetched: Response;
  try {
    fetched = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw failure(build, `could not be fetched from ${url.href}`, error);
  }
  return fromResponse(fetched, signal, build);
}

/**
 * Compiles the kernel's Wasm from `source`, checks it is the bundled build and returns the instance's exports. Any valid
 * Wasm instantiates, so a foreign module (a wrong URL that serves some other Wasm, an older kernel) would otherwise
 * reach the typed calls: its exports and imports must match the bundled build's, and the version it reports must be the
 * bundled one. `signal` cancels the download and the wait.
 */
export async function instantiateKernel(source: KernelWasmSource, signal: AbortSignal, build: KernelBuild): Promise<WebAssembly.Exports> {
  signal.throwIfAborted();
  let compiled: Compiled;
  try {
    compiled = await compile(source, signal, build);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError) {
      // A CSP that forbids Wasm is its own fix; leave that error to the caller's translation.
      if (/wasm-unsafe-eval|content security policy|\bCSP\b|disallowed by embedder/i.test(error.message)) throw error;
      throw failure(build, 'is not the Physics2D kernel build this package bundles', error);
    }
    throw error;
  }
  signal.throwIfAborted();
  if (interfaceHash(compiled.module) !== build.interface)
    throw failure(build, 'is not the Physics2D kernel build this package bundles (its exports and imports differ)');
  const version = String((compiled.instance.exports as { api_version(): number }).api_version());
  if (version !== build.version)
    throw failure(build, `is Physics2D kernel ${version}, not the ${build.version} build this package bundles`);
  return compiled.instance.exports;
}
