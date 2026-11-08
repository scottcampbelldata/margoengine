// Grading controls for Tonemap, live without a LUT: shadows, midtones and highlights wheels, tone curves (master and
// per channel) and saturation against hue. Applied on display-linear colour after the curve and contrast, before the
// LUT. Wheels: an RGB offset each, weighted by luminance masks that sum to 1 (shadows 1 - smoothstep(0, 0.5, l),
// highlights smoothstep(0.5, 1, l), midtones the rest). Curves: monotone cubic through the points (Fritsch and Carlson,
// 1980), baked to 33 samples a frame and read with linear interpolation. Hue against saturation: six multipliers at
// red, yellow, green, cyan, blue and magenta, interpolated around the HSV hue circle, scaling the distance from luma.
import type { TonemapExtension } from './index.js';

/** Curve control points [input, output] in 0..1, inputs strictly increasing. Two or more points. */
export type GradeCurve = readonly (readonly [number, number])[];
/** RGB offset of a grading wheel, each -1 to 1 (a hue and amount on a wheel is an offset like [0.05, 0, -0.05]). */
export type GradeWheel = readonly [number, number, number];
/** Options of {@link Grade}; the object is kept and read every frame. */
export interface GradeOptions {
  /** Offset added to the shadows. Default [0, 0, 0]. */
  shadows?: GradeWheel;
  /** Offset added to the midtones. Default [0, 0, 0]. */
  midtones?: GradeWheel;
  /** Offset added to the highlights. Default [0, 0, 0]. */
  highlights?: GradeWheel;
  /** Tone curves: `master` on all channels, then `red`, `green`, `blue`. Default none (straight lines). */
  curves?: { master?: GradeCurve; red?: GradeCurve; green?: GradeCurve; blue?: GradeCurve };
  /** Saturation multipliers, each 0 to 4, at hues red, yellow, green, cyan, blue, magenta. Default all 1. */
  hueSaturation?: readonly [number, number, number, number, number, number];
}

const SAMPLES = 33;

/** Samples of a monotone cubic through `points` at x = i / (SAMPLES - 1), clamped to 0..1. */
export function sampleCurve(points: GradeCurve | undefined, out = new Float32Array(SAMPLES)): Float32Array {
  if (!points) {
    for (let i = 0; i < SAMPLES; i++) out[i] = i / (SAMPLES - 1);
    return out;
  }
  const n = points.length,
    x = points.map((p) => p[0]),
    y = points.map((p) => p[1]),
    d: number[] = [],
    m: number[] = [];
  for (let i = 0; i < n - 1; i++) d[i] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  // Fritsch-Carlson: keep each segment monotone.
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i],
      b = m[i + 1] / d[i],
      s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  for (let k = 0, i = 0; k < SAMPLES; k++) {
    const t0 = k / (SAMPLES - 1);
    let v: number;
    if (t0 <= x[0]) v = y[0];
    else if (t0 >= x[n - 1]) v = y[n - 1];
    else {
      while (t0 > x[i + 1]) i++;
      const h = x[i + 1] - x[i],
        t = (t0 - x[i]) / h,
        t2 = t * t,
        t3 = t2 * t;
      v =
        (2 * t3 - 3 * t2 + 1) * y[i] +
        (t3 - 2 * t2 + t) * h * m[i] +
        (-2 * t3 + 3 * t2) * y[i + 1] +
        (t3 - t2) * h * m[i + 1];
    }
    out[k] = Math.min(1, Math.max(0, v));
  }
  return out;
}

const code = (binding: number) => `
struct Grade {shadows:vec4f,midtones:vec4f,highlights:vec4f,hue0:vec4f,hue1:vec4f,curve:array<vec4f,${SAMPLES}>}
@group(0) @binding(${binding}) var<uniform> grading:Grade;
fn gradeCurve(x:f32,channel:i32)->f32 {
 let t=clamp(x,0.0,1.0)*${SAMPLES - 1}.0;let i=min(i32(t),${SAMPLES - 2});
 return mix(grading.curve[i][channel],grading.curve[i+1][channel],t-f32(i));
}
fn gradeColor(input:vec3f)->vec3f {
 var c=clamp(input,vec3f(0),vec3f(1));let extra=input-c;
 let l=dot(c,vec3f(0.2126,0.7152,0.0722));let ws=1.0-smoothstep(0.0,0.5,l);let wh=smoothstep(0.5,1.0,l);
 c=clamp(c+grading.shadows.rgb*ws+grading.midtones.rgb*(1.0-ws-wh)+grading.highlights.rgb*wh,vec3f(0),vec3f(1));
 c=vec3f(gradeCurve(gradeCurve(c.r,0),1),gradeCurve(gradeCurve(c.g,0),2),gradeCurve(gradeCurve(c.b,0),3));
 let hi=max(c.r,max(c.g,c.b));let lo=min(c.r,min(c.g,c.b));
 if(hi>lo){
  var h:f32;
  if(hi==c.r){h=(c.g-c.b)/(hi-lo);}else if(hi==c.g){h=2.0+(c.b-c.r)/(hi-lo);}else{h=4.0+(c.r-c.g)/(hi-lo);}
  h=fract(h/6.0+1.0)*6.0;let k=array<f32,7>(grading.hue0.x,grading.hue0.y,grading.hue0.z,grading.hue0.w,grading.hue1.x,grading.hue1.y,grading.hue0.x);
  let i=min(i32(h),5);let s=mix(k[i],k[i+1],h-f32(i));let y=dot(c,vec3f(0.2126,0.7152,0.0722));
  c=clamp(y+(c-y)*s,vec3f(0),vec3f(1));
 }
 return c+extra;
}`;

const isWheel = (w: unknown) =>
  w === undefined || (Array.isArray(w) && w.length === 3 && w.every((v) => v >= -1 && v <= 1));
const isCurve = (c: unknown) =>
  c === undefined ||
  (Array.isArray(c) &&
    c.length >= 2 &&
    c.every(
      (p, i) =>
        Array.isArray(p) &&
        p.length === 2 &&
        p[0] >= 0 &&
        p[0] <= 1 &&
        p[1] >= 0 &&
        p[1] <= 1 &&
        (i === 0 || p[0] > c[i - 1][0]),
    ));

/**
 * Live grading for {@link Tonemap}: wheels, curves and hue against saturation, without a LUT. Give it to Tonemap's
 * `extensions`; change `grade.options` any time (read every frame). With default options it changes nothing.
 * @throws RangeError for a wheel, curve or hue multiplier out of range (checked now and every frame).
 */
export class Grade implements TonemapExtension {
  readonly key = 'grade';
  private readonly buffer = new Float32Array(20 + 4 * SAMPLES);
  private readonly column = new Float32Array(SAMPLES);
  constructor(readonly options: GradeOptions = {}) {
    this.check();
  }
  patch(shader: string, binding: number): string {
    return shader.replace('if(p.grade.w==1.0){color=sampleLUT(', 'color=gradeColor(color);\n  $&') + code(binding);
  }
  values(): Float32Array {
    this.check();
    const o = this.options,
      v = this.buffer,
      c = o.curves ?? {},
      h = o.hueSaturation ?? [1, 1, 1, 1, 1, 1];
    v.fill(0, 0, 20);
    v.set(o.shadows ?? [0, 0, 0], 0);
    v.set(o.midtones ?? [0, 0, 0], 4);
    v.set(o.highlights ?? [0, 0, 0], 8);
    v.set(h, 12);
    [c.master, c.red, c.green, c.blue].forEach((points, channel) => {
      sampleCurve(points, this.column);
      for (let i = 0; i < SAMPLES; i++) v[20 + 4 * i + channel] = this.column[i];
    });
    return v;
  }
  private check(): void {
    const o = this.options,
      c = o.curves ?? {},
      h = o.hueSaturation;
    if (
      !isWheel(o.shadows) ||
      !isWheel(o.midtones) ||
      !isWheel(o.highlights) ||
      ![c.master, c.red, c.green, c.blue].every(isCurve) ||
      (h !== undefined && !(Array.isArray(h) && h.length === 6 && h.every((v) => v >= 0 && v <= 4)))
    )
      throw new RangeError(
        'Invalid Grade options; wheels are three numbers -1 to 1, curves two or more [x, y] points in 0..1 with x increasing, hueSaturation six numbers 0 to 4.',
      );
  }
}
