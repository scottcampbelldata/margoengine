// ACES fit by Stephen Hill; references in ../tonemap/NOTICE.md.
export const acesShader = `fn aces(v:vec3f)->vec3f{let x=mat3x3f(vec3f(0.59719,0.076,0.0284),vec3f(0.35458,0.90834,0.13383),vec3f(0.04823,0.01566,0.83777))*v;return clamp(mat3x3f(vec3f(1.60475,-0.10208,-0.00327),vec3f(-0.53108,1.10813,-0.07276),vec3f(-0.07367,-0.00605,1.07602))*((x*(x+0.0245786)-0.000090537)/(x*(0.983729*x+0.432951)+0.238081)),vec3f(0),vec3f(1));}`;

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
