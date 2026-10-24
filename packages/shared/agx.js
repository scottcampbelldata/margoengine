// AgX display transform (Troy Sobotka's design with Eary Chow's parametric "AgX Base" formation), the one AgX in the
// engine: Tonemap, ImagePost and the voxel path tracer all use this file. Written from public descriptions only;
// sources in packages/tonemap/NOTICE.md. Linear Rec.709 in, linear Rec.709 display out, each channel in 0..1:
// 1. Rec.709 to Rec.2020 (ITU-R BT.709 / BT.2020 primaries, D65). Guard rail: a colour with a negative channel is
//    lifted until none is negative, then scaled back to its own luminance.
// 2. The AgX inset: Rec.2020 primaries rotated about white and pulled toward it (Eary Chow's published parameters).
// 3. Log2 encoding from BELOW stops under GREY to ABOVE stops over it, onto 0..1. Inputs at or below FLOOR, NaN and
//    -Infinity count as FLOOR (black).
// 4. The sigmoid: on each side of grey's position X a hyperbola k h(SLOPE t / k), h(u) = u / (1 + u^POWER)^(1/POWER),
//    with k chosen so the curve runs from (0, 0) through (X, GREY^(1/GAMMA)) to (1, 1); then the display power GAMMA.
// 5. Hue restoration: RESTORE of the way from the formed hue back to the hue after the inset (HSV hue).
// 6. The AgX outset (inverse of an un-rotated inset) and Rec.2020 to Rec.709 as one matrix, then the guard rail with
//    Rec.709 weights, then a clamp to 0..1.
// packages/tonemap/tests/agx.test.js derives every matrix, weight and constant below from those definitions.

const GREY = 0.18,
  BELOW = 10,
  ABOVE = 6.5,
  SLOPE = 2.4,
  POWER = 1.5,
  GAMMA = 2.4,
  FLOOR = 1e-10,
  RESTORE = 0.6;
/** Row-major 3x3 matrices. */
const TO2020 = [
    0.6274039, 0.32928304, 0.043313066, 0.069097289, 0.9195404, 0.011362316, 0.016391439, 0.088013308, 0.89559525,
  ],
  INSET = [
    0.85662716, 0.095121245, 0.048251598, 0.13731897, 0.76124199, 0.10143904, 0.11189821, 0.076799415, 0.81130238,
  ],
  OUTSET = [
    1.1271006, -0.11060664, -0.016493931, -0.14132975, 1.1578237, -0.016493931, -0.14132975, -0.11060664, 1.2519364,
  ],
  TO709 = [
    1.660491, -0.58764114, -0.072849863, -0.12455047, 1.1328999, -0.0083494226, -0.018150763, -0.1005789, 1.1187297,
  ],
  /** Luminance weights (the Y row of RGB to XYZ). */
  Y2020 = [0.26270021, 0.67799807, 0.059301716],
  Y709 = [0.21263901, 0.71516868, 0.072192315];
/** Outset, then Rec.2020 to Rec.709. */
const OUT = TO709.map((_, i) => {
  const r = i - (i % 3),
    c = i % 3;
  return TO709[r] * OUTSET[c] + TO709[r + 1] * OUTSET[c + 3] + TO709[r + 2] * OUTSET[c + 6];
});
const STOPS = BELOW + ABOVE,
  A = 1 / STOPS,
  B = (BELOW - Math.log2(GREY)) / STOPS,
  X = BELOW / STOPS,
  Y = GREY ** (1 / GAMMA),
  scale = (a, b) => a * ((a / b) ** POWER - 1) ** (-1 / POWER),
  KS = scale(SLOPE * (1 - X), 1 - Y),
  KT = scale(SLOPE * X, Y);

const n = (v) => (Number.isInteger(v) ? v + '.0' : String(v));
const mat = (m) => `mat3x3f(${[0, 1, 2].map((c) => `vec3f(${n(m[c])},${n(m[c + 3])},${n(m[c + 6])})`).join(',')})`;
const vec = (v) => `vec3f(${v.map(n).join(',')})`;

/**
 * WGSL `fn agx(c: vec3f) -> vec3f` (with helpers `agxRail`, `agxHsv`, `agxRgb` and `agxSide`): linear Rec.709 in,
 * linear Rec.709 display out, each channel in 0..1. Same transform as {@link agx}.
 */
export const agxShader = `fn agxRail(c:vec3f,w:vec3f)->vec3f{let o=c+max(-min(c.x,min(c.y,c.z)),0.0);let y=max(dot(c,w),0.0);
let s=dot(o,w);return select(o,o*(y/s),s>y);}
fn agxHsv(c:vec3f)->vec3f{let m=max(c.x,max(c.y,c.z));let d=m-min(c.x,min(c.y,c.z));var h=0.0;
if(d>0.0){if(m==c.x){h=(c.y-c.z)/d;}else if(m==c.y){h=(c.z-c.x)/d+2.0;}else{h=(c.x-c.y)/d+4.0;}}
return vec3f(fract(h/6.0),select(0.0,d/m,m>0.0),m);}
fn agxRgb(c:vec3f)->vec3f{let k=(vec3f(5.0,3.0,1.0)+c.x*6.0)%6.0;return c.z-c.z*c.y*clamp(min(k,4.0-k),vec3f(0.0),vec3f(1.0));}
fn agxSide(t:vec3f,k:vec3f)->vec3f{let u=${n(SLOPE)}*t/k;return k*u/pow(1.0+pow(u,vec3f(${n(POWER)})),vec3f(${n(1 / POWER)}));}
fn agx(c:vec3f)->vec3f{
let i=${mat(INSET)}*agxRail(${mat(TO2020)}*c,${vec(Y2020)});
let x=clamp(log2(select(vec3f(${n(FLOOR)}),i,i>vec3f(${n(FLOOR)})))*${n(A)}+${n(B)},vec3f(0.0),vec3f(1.0));
let d=x-${n(X)};let y=${n(Y)}+sign(d)*agxSide(abs(d),select(vec3f(${n(KT)}),vec3f(${n(KS)}),d>=vec3f(0.0)));
var f=agxHsv(pow(max(y,vec3f(0.0)),vec3f(${n(GAMMA)})));let p=agxHsv(i);
if(f.y>0.0&&p.y>0.0){let h=p.x-f.x;f.x=fract(f.x+${n(RESTORE)}*(h-floor(h+0.5)));}
return clamp(agxRail(${mat(OUT)}*agxRgb(f),${vec(Y709)}),vec3f(0.0),vec3f(1.0));}
`;

// CPU version on plain numbers: helpers write their result to these.
let R = 0,
  G = 0,
  Bl = 0,
  H = 0,
  S = 0,
  V = 0;
function apply(m, r, g, b) {
  R = m[0] * r + m[1] * g + m[2] * b;
  G = m[3] * r + m[4] * g + m[5] * b;
  Bl = m[6] * r + m[7] * g + m[8] * b;
}
function rail(r, g, b, w) {
  const lift = Math.max(-Math.min(r, g, b), 0),
    y = Math.max(r * w[0] + g * w[1] + b * w[2], 0);
  r += lift;
  g += lift;
  b += lift;
  const s = r * w[0] + g * w[1] + b * w[2],
    k = s > y ? y / s : 1;
  R = r * k;
  G = g * k;
  Bl = b * k;
}
function hsv(r, g, b) {
  const m = Math.max(r, g, b),
    d = m - Math.min(r, g, b);
  let h = 0;
  if (d > 0) h = (m === r ? (g - b) / d : m === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  H = h - Math.floor(h);
  S = m > 0 ? d / m : 0;
  V = m;
}
const channel = (offset) => {
  const k = (offset + H * 6) % 6;
  return V - V * S * Math.min(Math.max(Math.min(k, 4 - k), 0), 1);
};
/** Log encoding, sigmoid and display power of one channel. */
function curve(v) {
  const x = Math.min(Math.max(Math.log2(!(v > FLOOR) ? FLOOR : v) * A + B, 0), 1),
    d = x - X,
    k = d >= 0 ? KS : KT,
    u = (SLOPE * Math.abs(d)) / k;
  return Math.max(Y + (Math.sign(d) * k * u) / (1 + u ** POWER) ** (1 / POWER), 0) ** GAMMA;
}

/**
 * Linear Rec.709 in, linear Rec.709 display out, each channel in 0..1. Same transform as {@link agxShader}.
 * Writes into `out` when given (it may be the input array) and returns it.
 */
export function agx(c, out = [0, 0, 0]) {
  apply(TO2020, c[0], c[1], c[2]);
  rail(R, G, Bl, Y2020);
  apply(INSET, R, G, Bl);
  const ir = R,
    ig = G,
    ib = Bl;
  hsv(curve(ir), curve(ig), curve(ib));
  const fh = H,
    fs = S,
    fv = V;
  hsv(ir, ig, ib);
  if (fs > 0 && S > 0) {
    const gap = H - fh;
    H = fh + RESTORE * (gap - Math.floor(gap + 0.5));
    H -= Math.floor(H);
  } else H = fh;
  S = fs;
  V = fv;
  apply(OUT, channel(5), channel(3), channel(1));
  rail(R, G, Bl, Y709);
  out[0] = Math.min(Math.max(R, 0), 1);
  out[1] = Math.min(Math.max(G, 0), 1);
  out[2] = Math.min(Math.max(Bl, 0), 1);
  return out;
}
