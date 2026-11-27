/** True when `engine` draws to a premultiplied canvas (TransparentCanvas), so display transforms take straight colour. */
export function premultipliedCanvas(engine: { canvas?: unknown } | undefined): boolean;
/** Marks `engine`'s output premultiplied or not and returns the previous mark (false without a canvas). */
export function markPremultiplied(engine: { canvas?: unknown } | undefined, on: boolean): boolean;
/** The display shader for a premultiplied canvas: `vec4f(toDisplay(c),a)` encodes the straight colour times a. */
export function straightDisplay(code: string): string;
/** `code` as straightDisplay gives it on a premultiplied canvas of `engine`, else unchanged. */
export function displayFor(engine: { canvas?: unknown } | undefined, code: string): string;
