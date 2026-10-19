// Spectral dispersion support: wavelength sampling and the RGB weight of one wavelength.
// - Colour matching: the multi-lobe piecewise Gaussian fit of the CIE 1931 2-degree observer by Wyman, Sloan and
//   Shirley ("Simple Analytic Approximations to the CIE XYZ Color Matching Functions", JCGT 2013), converted to linear
//   sRGB (IEC 61966-2-1 matrix) and normalised per channel over 380-780 nm, so an equal-energy spectrum is white
//   (1, 1, 1). Weights are negative where spectral colours lie outside the sRGB gamut; their mean is exact.
// - Index: Cauchy's n(lambda) = A + B / lambda^2 through n_d at 587.6 nm with Abbe number V_d = (n_d - 1) / (n_F - n_C)
//   (486.1 and 656.3 nm), so B = (n_d - 1) / (V_d (1 / 0.4861^2 - 1 / 0.6563^2)) in square micrometres.

/** Wavelength range sampled for dispersion, in nanometres. */
export const LAMBDA_MIN = 380,
  LAMBDA_MAX = 780;
/** Fraunhofer d, F and C lines (micrometres). */
const D = 0.5876,
  F = 0.4861,
  C = 0.6563;

/** Cauchy coefficient B (square micrometres) of a glass with index `ior` at the d line and Abbe number `abbe`. */
export function cauchyB(ior: number, abbe: number): number {
  return abbe > 0 ? (ior - 1) / (abbe * (1 / (F * F) - 1 / (C * C))) : 0;
}

const lobe = (x: number, mu: number, s1: number, s2: number) => {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
};
const xyzBar = (l: number) => [
  1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2),
  0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1),
  1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8),
];
// XYZ to linear sRGB (D65), rows.
const M = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
const rgbBar = (l: number) => {
  const [x, y, z] = xyzBar(l);
  return [0, 1, 2].map((r) => M[r * 3] * x + M[r * 3 + 1] * y + M[r * 3 + 2] * z);
};
// Per-channel integrals over the sampled range (midpoint rule, 0.05 nm).
const NORM = (() => {
  const k = [0, 0, 0],
    h = 0.05;
  for (let l = LAMBDA_MIN + h / 2; l < LAMBDA_MAX; l += h) {
    const c = rgbBar(l);
    for (let i = 0; i < 3; i++) k[i] += c[i] * h;
  }
  return k;
})();

// Wavelength sampling density: 25% uniform plus 75% a logistic bump (centre 550 nm, scale 28 nm) truncated to the
// range, which follows the summed magnitude of the RGB weights closely enough to keep their ratio to it small.
const UNIFORM = 0.25,
  MU = 550,
  S = 28;
const num = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);

/** WGSL: `spectralRgb(lambda)` (RGB weight per nanometre), `sampleLambda(u)` (wavelength and its density). */
export const SPECTRUM: string = /* wgsl */ `
const LAMBDA_MIN=${num(LAMBDA_MIN)};
const LAMBDA_MAX=${num(LAMBDA_MAX)};
const LAMBDA_D=${D};
fn cmfLobe(x:f32,mu:f32,s1:f32,s2:f32)->f32 {let t=(x-mu)/select(s2,s1,x<mu);return exp(-0.5*t*t);}
fn spectralRgb(l:f32)->vec3f {
 let x=1.056*cmfLobe(l,599.8,37.9,31.0)+0.362*cmfLobe(l,442.0,16.0,26.7)-0.065*cmfLobe(l,501.1,20.4,26.2);
 let y=0.821*cmfLobe(l,568.8,46.9,40.5)+0.286*cmfLobe(l,530.9,16.3,31.1);
 let z=1.217*cmfLobe(l,437.0,11.8,36.0)+0.681*cmfLobe(l,459.0,26.0,13.8);
 let rgb=vec3f(${M[0]}*x+${M[1]}*y+${M[2]}*z,${M[3]}*x+${M[4]}*y+${M[5]}*z,${M[6]}*x+${M[7]}*y+${M[8]}*z);
 return rgb/vec3f(${NORM.map((v) => v.toPrecision(9)).join(',')});
}
fn lambdaPdf(l:f32)->f32 {
 let ta=tanh((LAMBDA_MIN-${num(MU)})/${num(2 * S)});let tb=tanh((LAMBDA_MAX-${num(MU)})/${num(2 * S)});
 let t=tanh((l-${num(MU)})/${num(2 * S)});
 return ${UNIFORM}/(LAMBDA_MAX-LAMBDA_MIN)+${1 - UNIFORM}*(1.0-t*t)/(${num(2 * S)}*(tb-ta));
}
// A wavelength for uniform numbers u (choice, position) and its density.
fn sampleLambda(u:vec2f)->vec2f {
 var l:f32;
 if(u.x<${UNIFORM}){l=mix(LAMBDA_MIN,LAMBDA_MAX,u.y);}
 else{
  let ta=tanh((LAMBDA_MIN-${num(MU)})/${num(2 * S)});let tb=tanh((LAMBDA_MAX-${num(MU)})/${num(2 * S)});
  l=clamp(${num(MU)}+${num(2 * S)}*atanh(clamp(mix(ta,tb,u.y),-0.999999,0.999999)),LAMBDA_MIN,LAMBDA_MAX);
 }
 return vec2f(l,lambdaPdf(l));
}
`;
