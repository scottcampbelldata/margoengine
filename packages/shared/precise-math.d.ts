/** The constants of the precise WGSL maths, for the host reference. */
export const PRECISE: Readonly<{
  twoOverPi: readonly number[];
  halfPiFixed: number;
  halfPi: readonly [number, number];
  quarterPi: readonly [number, number];
  pi: readonly [number, number];
  ln2: readonly [number, number];
  ln2Pair: readonly [number, number];
  log2e: readonly [number, number];
  sin: readonly number[];
  cos: readonly number[];
  atan: readonly number[];
  asin: readonly number[];
  sinh: readonly number[];
  cosh: readonly number[];
  tanh: readonly number[];
  expm1: readonly number[];
  log: readonly number[];
}>;
/** Every public function of {@link preciseMathWgsl}. */
export const PRECISE_FUNCTIONS: readonly string[];
/**
 * WGSL source of the named precise functions (`preciseSin`, `preciseAtan2`, ...) and the helpers they need, each
 * once. Every function takes and returns f32.
 */
export function preciseMathWgsl(names: Iterable<string>): string;
