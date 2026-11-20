/** [a, b, c] of y = a + b x + c x^2 through the points by least squares, or undefined under three points or when singular. */
export function parabolaFit(xs: readonly number[], ys: readonly number[]): number[] | undefined;
