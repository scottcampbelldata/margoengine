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

// Wyman, Sloan and Shirley 2013, Table 1 and eq. 4: weight, mean (nm), and the inverse widths below and above the
// mean, exactly as published (Listing 1 multiplies by them), per lobe of x, y and z.
const CMF: readonly (readonly (readonly [number, number, number, number])[])[] = [
  [
    [0.362, 442.0, 0.0624, 0.0374],
    [1.056, 599.8, 0.0264, 0.0323],
    [-0.065, 501.1, 0.049, 0.0382],
  ],
  [
    [0.821, 568.8, 0.0213, 0.0247],
    [0.286, 530.9, 0.0613, 0.0322],
  ],
  [
    [1.217, 437.0, 0.0845, 0.0278],
    [0.681, 459.0, 0.0385, 0.0725],
  ],
];
/** The CIE 1931 colour matching functions x, y, z at `l` nanometres (the fit above). */
export const xyzBar = (l: number): number[] =>
  CMF.map((lobes) =>
    lobes.reduce((sum, [w, mu, below, above]) => {
      const t = (l - mu) * (l < mu ? below : above);
      return sum + w * Math.exp(-0.5 * t * t);
    }, 0),
  );
const wgslCmf = (lobes: (typeof CMF)[number]) =>
  lobes.map(([w, mu, below, above]) => `${w}*cmfLobe(l,${num(mu)},${below},${above})`).join('+');
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
fn cmfLobe(x:f32,mu:f32,k1:f32,k2:f32)->f32 {let t=(x-mu)*select(k2,k1,x<mu);return exp(-0.5*t*t);}
fn spectralRgb(l:f32)->vec3f {
 let x=${wgslCmf(CMF[0])};
 let y=${wgslCmf(CMF[1])};
 let z=${wgslCmf(CMF[2])};
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
