// Smallest and largest values by a loop. Math.min(...values) passes every value as an argument, and engines cap how
// many arguments one call may take (V8 overflows its call stack past about 125,000), so a large boundary or loop
// threw RangeError there.

/** The smallest value, or Infinity when there is none. */
export function leastOf(values: Iterable<number>): number {
  let least = Infinity;
  for (const value of values) if (value < least) least = value;
  return least;
}

/** Where the smallest value first sits, or -1 for an empty list. */
export function indexOfLeast(values: readonly number[]): number {
  let at = -1;
  for (let i = 0; i < values.length; i++) if (at < 0 || values[i] < values[at]) at = i;
  return at;
}

/** The largest value, or -Infinity when there is none. */
export function greatestOf(values: Iterable<number>): number {
  let greatest = -Infinity;
  for (const value of values) if (value > greatest) greatest = value;
  return greatest;
}
