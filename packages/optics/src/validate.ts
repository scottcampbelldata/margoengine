// Argument checks shared by the optics entries (docs/conventions.md: argument errors are TypeError or RangeError).
const HELP = 'see https://margoengine.com/errors#optics-argument';

/** Throws a RangeError unless `value` is a finite number. */
export function checkFinite(fn: string, name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RangeError(`${fn}: ${name} must be a finite number, got ${String(value)}; ${HELP}`);
}

/** Throws a RangeError unless `value` is a finite number above zero. */
export function checkPositive(fn: string, name: string, value: number): void {
  if (typeof value !== 'number' || !(value > 0) || !Number.isFinite(value))
    throw new RangeError(`${fn}: ${name} must be a finite number above 0, got ${String(value)}; ${HELP}`);
}
