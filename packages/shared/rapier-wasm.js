import { margoError } from './errors.js';

// Loading Rapier's Wasm for @margoengine/physics and @margoengine/physics2d. Each package bundles Rapier's JavaScript
// into a lazy solver chunk and ships the Wasm beside it as a file of its own; this module fetches and compiles that file
// (or another copy the app names) and checks it is the bundled build before Rapier's glue sees it.

// A name, not a literal: bundlers for the browser must not try to resolve Node's modules from this file.
const nodeImport = (name) => import(/* @vite-ignore */ /* webpackIgnore: true */ name);

/** FNV-1a over the module's exports and imports: each package build hashes its bundled Wasm the same way. */
export function interfaceHash(module) {
  const text =
    WebAssembly.Module.exports(module).map((entry) => `${entry.kind}:${entry.name}`).join(',') +
    '|' +
    WebAssembly.Module.imports(module).map((entry) => `${entry.kind}:${entry.module}:${entry.name}`).join(',');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

const failure = (build, what, cause) =>
  Object.assign(
    margoError(
      'failed',
      `Rapier's Wasm ${what}; serve dist/${build.file} from ${build.package}, or pass ${build.call}({wasm}) a URL that serves it`,
    ),
    cause === undefined ? {} : { cause },
  );

async function fromResponse(source, signal, build) {
  if (!source.ok)
    throw failure(build, `could not be fetched from ${source.url || 'the response'} (${source.status} ${source.statusText})`.trimEnd());
  // A server that labels the file application/wasm lets the browser compile it while it downloads; any other label
  // makes instantiateStreaming refuse it, so the bytes are read first.
  if (typeof WebAssembly.instantiateStreaming === 'function' && /^application\/wasm\b/i.test(source.headers.get('content-type') ?? ''))
    return WebAssembly.instantiateStreaming(source, build.imports);
  const bytes = await source.arrayBuffer();
  signal.throwIfAborted();
  return WebAssembly.instantiate(bytes, build.imports);
}

async function compile(source, signal, build) {
  const { imports } = build;
  if (source instanceof WebAssembly.Module) return { module: source, instance: await WebAssembly.instantiate(source, imports) };
  if (typeof Response === 'function' && source instanceof Response) return fromResponse(source, signal, build);
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) return WebAssembly.instantiate(source, imports);
  let url;
  try {
    url = new URL(source, globalThis.location?.href);
  } catch (error) {
    throw new TypeError(`${build.call} wasm must be a URL, a Response, bytes or a WebAssembly.Module; got ${String(source)}`, {
      cause: error,
    });
  }
  if (url.protocol === 'file:') {
    // Node, Bun and Deno read a file URL; fetch() in Node cannot.
    const { readFile } = await nodeImport('node:fs/promises');
    let bytes;
    try {
      bytes = await readFile(url, { signal });
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      throw failure(build, `could not be read from ${url.href}`, error);
    }
    return WebAssembly.instantiate(bytes, imports);
  }
  let fetched;
  try {
    fetched = await fetch(url, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw failure(build, `could not be fetched from ${url.href}`, error);
  }
  return fromResponse(fetched, signal, build);
}

/**
 * Throws unless `compiled` is the bundled Rapier build. Any valid Wasm instantiates, so a foreign module (a wrong URL
 * that serves some other Wasm, another Rapier version) would otherwise reach Rapier's glue, which keeps views of the
 * first memory it is given and cannot be pointed at another instance afterwards. So the check runs before the glue sees
 * the instance: the module's exports and imports must match the bundled build's, and the version it reports (read the
 * way the glue reads it) must be the bundled one.
 */
function check({ module, instance }, build) {
  if (interfaceHash(module) !== build.interface)
    throw failure(build, 'is not the Rapier build this package bundles (its exports and imports differ)');
  // The interface check guarantees these exports; `__wbindgen_export2` is the bundled builds' free(), which Rapier's
  // glue frees the version string with too.
  const wasm = instance.exports;
  const result = wasm.__wbindgen_add_to_stack_pointer(-16);
  let version;
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
  if (version !== build.version) throw failure(build, `is Rapier ${version}, not the ${build.version} build this package bundles`);
}

/**
 * Compiles Rapier's Wasm from `source`, checks it is `build`, and returns the instance's exports for the glue.
 * `signal` cancels the download and the wait.
 */
export async function instantiateRapier(source, signal, build) {
  signal.throwIfAborted();
  let compiled;
  try {
    compiled = await compile(source, signal, build);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError) {
      // A CSP that forbids Wasm is its own fix; leave that error to the caller's translation.
      if (/wasm-unsafe-eval|content security policy|\bCSP\b|disallowed by embedder/i.test(error.message)) throw error;
      throw failure(build, 'is not the Rapier build this package bundles', error);
    }
    throw error;
  }
  signal.throwIfAborted();
  check(compiled, build);
  return compiled.instance.exports;
}
