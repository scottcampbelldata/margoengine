/** Throws a TypeError unless `value` has three components, and a RangeError unless each is finite and within 1e100. */
export function validateVector(value: ArrayLike<number>, name?: string): void;
