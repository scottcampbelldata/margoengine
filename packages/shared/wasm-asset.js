// Compiles a package's shipped Wasm asset from its URL: read from disk under Node (file: URLs), fetched elsewhere.
// Both native kernels (entry profiles, surface energy) load the same way; each passes its own error constructor and
// messages so the thrown error keeps its package's code and fix text.

/**
 * Compile the Wasm module at `url`.
 * @param {URL} url Asset URL; a `file:` URL is read with `node:fs/promises`, any other is fetched.
 * @param {AbortSignal | undefined} signal Cancels the read or fetch.
 * @param {(message: string, cause?: unknown) => Error} failure Builds the package's error.
 * @param {(status: number) => string} httpMessage Message for a non-OK HTTP status.
 * @param {string} unsupported Message when the bytes cannot be read or compiled.
 * @returns {Promise<WebAssembly.Module>}
 */
export async function compileWasmAsset(url, signal, failure, httpMessage, unsupported) {
  let own;
  try {
    if (url.protocol === 'file:') {
      url.search = '';
      const fs = 'node:fs/promises';
      const { readFile } = await import(/* @vite-ignore */ /* webpackIgnore: true */ fs);
      return await WebAssembly.compile(await readFile(url, { signal }));
    }
    const response = await fetch(url, { signal });
    if (!response.ok) throw (own = failure(httpMessage(response.status)));
    return await WebAssembly.compile(await response.arrayBuffer());
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause === own) throw cause;
    throw failure(unsupported, cause);
  }
}
