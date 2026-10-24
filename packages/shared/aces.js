// ACES-style filmic display transform (ACES 1.x RRT + sRGB 100-nit ODT look), fitted for this engine: linear Rec.709
// scene light in (non-negative, exposure applied, no extra scale), display-linear Rec.709 out, clamped to 0..1, before
// the sRGB encoding. Form: a 3x3 mix in (rows sum to 1), then per channel 1.002 * (w / (w + s))^q with w = x^k (a scaled
// Dagum, or Burr type III, distribution function: 0 at black, strictly rising, reaching display white at a finite
// input), then a 3x3 mix out (rows sum to 1, so greys stay grey) and the clamp. Fitted by least squares, then an L^p
// polish (p up to 12) toward minimax, in 8-bit sRGB code units against the grey ramp and colour samples that
// packages/tonemap/tests/aces.test.js holds (at most 1.3 codes off, mean 0.42). WGSL mat3x3f takes columns.
export const acesShader = `fn aces(v:vec3f)->vec3f{let x=max(mat3x3f(vec3f(0.593472,0.076823,0.028601),vec3f(0.358198,0.90752,0.139254),vec3f(0.04833,0.015657,0.832145))*v,vec3f(0.0));let w=pow(x,vec3f(1.332491));let y=1.002*pow(w/(w+0.445751),vec3f(1.325334));return clamp(mat3x3f(vec3f(1.624002,-0.102265,-0.001975),vec3f(-0.547579,1.110313,-0.089177),vec3f(-0.076423,-0.008048,1.091152))*y,vec3f(0.0),vec3f(1.0));}
`;

/**
 * WGSL `fn acesNarkowicz(c: vec3f) -> vec3f`: Krzysztof Narkowicz's fit of the ACES film curve (2016), after the 0.6
 * pre-scale of his reference, clamped to 0..1.
 */
export const acesNarkowiczShader = `fn acesNarkowicz(c:vec3f)->vec3f{let x=0.6*c;return clamp(x*(2.51*x+0.03)/(x*(2.43*x+0.59)+0.14),vec3f(0.0),vec3f(1.0));}
`;
/** Same curve as {@link acesNarkowiczShader} on the CPU. Writes into `out` when given and returns it. */
export function acesNarkowicz(c, out = [0, 0, 0]) {
  for (let i = 0; i < 3; i++) {
    const x = 0.6 * c[i];
    out[i] = Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
  }
  return out;
}
