// Film time for the seekable effects (vfx Debris, weather BlastCloud): their output is a function of the film time
// alone, so a seek or an update only checks the number and moves the clock.

/** `value` when it is a finite number of 0 or more; otherwise `fail("<what> must be 0 or more.")`, which throws. */
export function filmTime(value, fail, what) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`${what} must be 0 or more.`);
  return value;
}
