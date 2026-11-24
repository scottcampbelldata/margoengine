type Filter = readonly [number, number, number, number, number];

// Bilinear re-expression of the published 48 kHz transfer functions at the target rate.
// old z^-1 = (B + A*new z^-1) / (A + B*new z^-1), A=1+r, B=1-r, r=rate/48000.
/** @internal Shared bilinear K-weighting coefficients from BS.1770 tables. */
export function loudnessFilters(sampleRate: number): Filter[] {
  const r = sampleRate / 48000, a = 1 + r, b = 1 - r;
  const polynomial = (p: readonly number[]) => [
    p[0] * a * a + p[1] * a * b + p[2] * b * b,
    2 * a * b * (p[0] + p[2]) + p[1] * (a * a + b * b),
    p[0] * b * b + p[1] * a * b + p[2] * a * a,
  ];
  const stage = (num: readonly number[], den: readonly number[]): Filter =>
    [num[0] / den[0], num[1] / den[0], num[2] / den[0], den[1] / den[0], den[2] / den[0]];
  // ITU-R BS.1770-5 Annex 1, Tables 1 and 2. Preserve the high-pass double DC zero algebraically.
  return [
    stage(polynomial([1.53512485958697, -2.69169618940638, 1.19839281085285]),
      polynomial([1, -1.69065929318241, 0.73248077421585])),
    stage([4 * r * r, -8 * r * r, 4 * r * r], polynomial([1, -1.99004745483398, 0.99007225036621])),
  ];
}

