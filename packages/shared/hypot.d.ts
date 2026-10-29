/**
 * `Math.hypot` of the first `count` (2 to 4) of a, b, c, d, by V8's own steps, so V8 gets the same bits, without
 * allocating. The values must not be NaN.
 */
export function hypot(count: number, a: number, b: number, c?: number, d?: number): number;
/** Terms (0 to 3) and result (4) of {@link hypotOf}. */
export const hypotTerms: Float64Array;
/**
 * {@link hypot} of `hypotTerms[0]` to `hypotTerms[count - 1]` into `hypotTerms[4]` (the terms become their magnitudes).
 * For hot paths where V8 would box hypot's arguments and result into heap numbers.
 */
export function hypotOf(count: number): void;
