/** Compile the Wasm module at a URL: a `file:` URL is read from disk, any other is fetched. */
export function compileWasmAsset(
  url: URL,
  signal: AbortSignal | undefined,
  failure: (message: string, cause?: unknown) => Error,
  httpMessage: (status: number) => string,
  unsupported: string,
): Promise<WebAssembly.Module>;
