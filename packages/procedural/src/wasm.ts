import { fault, wasmError } from '../../shared/errors.js';

/** Internal loader shared by feature-local Wasm entries; no work happens on import. */
export async function loadKernel<T>(url: URL, feature: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let bytes: ArrayBuffer;
  if (url.protocol === 'file:') {
    url.search = '';
    const nodeModule = 'node:fs/promises';
    const { readFile }: { readFile(path: URL, options: { signal?: AbortSignal }): Promise<Uint8Array<ArrayBuffer>> } =
      await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeModule);
    const file = await readFile(url, { signal });
    bytes = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  } else {
    const response = await fetch(url, { signal });
    if (!response.ok)
      throw fault(
        'failed',
        `${feature} Wasm fetch returned HTTP ${response.status}; serve the package assets`,
        'procedural',
      );
    bytes = await response.arrayBuffer();
  }
  let result: WebAssembly.WebAssemblyInstantiatedSource;
  try {
    result = await WebAssembly.instantiate(bytes);
  } catch (error) {
    throw wasmError(error);
  }
  signal?.throwIfAborted();
  return result.instance.exports as unknown as T;
}
