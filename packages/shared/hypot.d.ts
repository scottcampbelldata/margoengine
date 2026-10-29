/**
 * `Math.hypot` of the first `count` (2 to 4) of a, b, c, d, by V8's own steps, so V8 gets the same bits, without
 * allocating. The values must not be NaN.
 */
export function hypot(count: number, a: number, b: number, c?: number, d?: number): number;
