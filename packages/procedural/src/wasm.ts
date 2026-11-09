import { fault, wasmError } from '../../shared/errors.js';

/** Internal loader shared by feature-local Wasm entries; no work happens on import. */
export async function loadKernel<T>(url: URL, feature: string, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  try {
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
    const result = await WebAssembly.instantiate(bytes);
    signal?.throwIfAborted();
    return result.instance.exports as unknown as T;
  } catch (error) {
    signal?.throwIfAborted();
    const translated = wasmError(error);
    if (translated !== error || (error instanceof Error && error.name === 'MargoError')) throw translated;
    throw Object.assign(fault('failed', `${feature} Wasm could not load; serve valid package assets`, 'procedural'), {
      cause: error,
    });
  }
}
