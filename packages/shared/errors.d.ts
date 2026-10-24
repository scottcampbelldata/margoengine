/** `@margoengine/math`'s MargoErrorCode, repeated here because shared code cannot import the package. */
export type MargoErrorCode = 'disposed' | 'attached' | 'state' | 'unsupported' | 'failed';
/** An Error named `MargoError` with `code`: what `new MargoError(code, message)` builds, without the class. */
export function margoError(code: MargoErrorCode, message: string): Error & { code: MargoErrorCode };
/** `margoError` whose message links to `anchor` (default the code) on margoengine.com/errors. */
export function fault(code: MargoErrorCode, message: string, anchor?: string): Error & { code: MargoErrorCode };
/** TypeError whose message links to `anchor` on margoengine.com/errors. */
export function typeError(message: string, anchor: string): TypeError;
/** RangeError whose message links to `anchor` on margoengine.com/errors. */
export function rangeError(message: string, anchor: string): RangeError;
