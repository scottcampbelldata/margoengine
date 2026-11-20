// The error convention (docs/conventions.md): a decode that ran and produced no result is a MargoError with code
// 'failed'. This package has no dependency on @margoengine/math and its tsc build does not bundle packages/shared, so
// it builds the same shape here (name 'MargoError', code), which `error instanceof MargoError` matches by name.

/** A decode that ran and produced no result (a Wasm trap, a time limit): MargoError code 'failed', cause attached. */
export const decodeFailed = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: 'MargoError',
    code: 'failed' as const,
  });

/** The device lacks a feature a texture needs: MargoError code 'unsupported'. */
export const deviceUnsupported = (message: string): Error =>
  Object.assign(new Error(message), { name: 'MargoError', code: 'unsupported' as const });

/**
 * True for the error a Wasm trap or Emscripten abort inside a decoder leaves (`unreachable`, `memory access out of
 * bounds`, `Aborted(OOM)`), directly or as the `cause` of the decoder's own error. The module's state is undefined
 * afterwards, so the decoder worker drops it and instantiates a fresh one for the next file.
 */
export const isDecoderCrash = (error: unknown): boolean =>
  error instanceof WebAssembly.RuntimeError ||
  (error instanceof Error && error.cause instanceof WebAssembly.RuntimeError);

// A trap becomes the decoder's own error (trap as its cause); anything else passes through.
export const trapped = (label: string, error: unknown): unknown =>
  error instanceof WebAssembly.RuntimeError
    ? decodeFailed(`${label}: corrupt or unsupported data stopped the decoder (${error.message})`, error)
    : error;
// Runs `make` (a constructor that copies input into the Wasm heap) with a trap turned into the decoder's own error.
export function guard<T>(label: string, make: () => T): T {
  try {
    return make();
  } catch (error) {
    throw trapped(label, error);
  }
}
// Releases handles after a decode; after a trap the module is discarded, so a second trap here is dropped.
export function release(failure: unknown, cleanup: () => void): void {
  try {
    cleanup();
  } catch (error) {
    if (!isDecoderCrash(failure)) throw trapped('Decoder', error);
  }
}
