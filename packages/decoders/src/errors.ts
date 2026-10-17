// The error convention (docs/conventions.md): a decode that ran and produced no result is a MargoError with code
// 'failed'. This package has no dependency on @margoengine/math and its tsc build does not bundle packages/shared, so
// it builds the same shape here (name 'MargoError', code), which `error instanceof MargoError` matches by name.

/** A decode that ran and produced no result (a Wasm trap, a time limit): MargoError code 'failed', cause attached. */
export const decodeFailed = (message: string, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), {
    name: 'MargoError',
    code: 'failed' as const,
  });
