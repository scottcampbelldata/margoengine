// Callers validate a unit transmission channel and a nonnegative exponent (which may overflow to Infinity).
// White transmits unchanged at every distance; JavaScript's 1 ** Infinity would otherwise produce NaN.
export function attenuationPower(channel, exponent) {
  return channel === 1 ? 1 : channel ** exponent;
}
