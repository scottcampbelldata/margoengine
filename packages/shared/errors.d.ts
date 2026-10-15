/** `@margoengine/math`'s MargoErrorCode, repeated here because shared code cannot import the package. */
export type MargoErrorCode = 'disposed' | 'attached' | 'state' | 'unsupported' | 'failed';
/** An Error named `MargoError` with `code`: what `new MargoError(code, message)` builds, without the class. */
export function margoError(code: MargoErrorCode, message: string): Error & { code: MargoErrorCode };
