/**
 * Unit sun direction for a clock time: rises at 6 (+x), zenith at 12 (+y), sets at 18 (-x), in the XY plane. Writes
 * into `out` (3 elements) and returns it.
 * @throws RangeError when `hours` is not finite or `out` does not have 3 elements.
 */
export function sunDirection(hours: number, out = new Float32Array(3)): Float32Array {
  if (!Number.isFinite(hours) || out.length !== 3)
    throw new RangeError('Invalid sun clock; pass finite hours and an out array of 3 elements.');
  // Margo clock model (not astronomical): the sun moves on a circle through east and the zenith.
  const angle = (((hours % 24) - 6) * Math.PI) / 12;
  out[0] = Math.cos(angle);
  out[1] = Math.sin(angle);
  out[2] = 0;
  return out;
}
