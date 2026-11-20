// Grading controls for Tonemap, live without a LUT: shadows, midtones and highlights wheels, tone curves (master and
// per channel) and saturation against hue. Applied on display-linear colour after the curve and contrast, before the
// LUT. Wheels: an RGB offset each, weighted by luminance masks that sum to 1 (shadows 1 - smoothstep(0, 0.5, l),
// highlights smoothstep(0.5, 1, l), midtones the rest). Curves: monotone cubic through the points (Fritsch and Carlson,
// 1980), baked to 33 samples a frame and read with linear interpolation. Hue against saturation: six multipliers at
// red, yellow, green, cyan, blue and magenta, interpolated around the HSV hue circle, scaling the distance from luma.
// Primary controls, applied first and compiled only while one is away from its default (so a Grade without them sends
// the GPU the same program and data as before they existed): lift, gamma and gain per channel, the colourist's three
// primaries, out = (gain (x + lift (1 - x)))^(1 / gamma), which keeps white under lift and black under gain (the slope,
// offset and power of the ASC Color Decision List, American Society of Cinematographers, ASC CDL v1.2, 2009, written so
// each control holds one end of the range); then saturation about Rec. 709 luma (ITU-R BT.709-6, 2015), as the CDL's
// saturation, out = luma + s (x - luma).
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
  /** Lift per channel, -1 to 1: raises (or lowers) the blacks and leaves white where it is. Default [0, 0, 0]. */
  lift?: GradeWheel;
  /** Gamma per channel, 0.1 to 10: above 1 brightens the midtones, below 1 darkens them; black and white stay. Default [1, 1, 1]. */
  gamma?: readonly [number, number, number];
  /** Gain per channel, 0 to 4: scales the whites and leaves black where it is. Default [1, 1, 1]. */
  gain?: readonly [number, number, number];
  /** Saturation about Rec. 709 luma, 0 (grey) to 4, after lift, gamma and gain. Default 1. */
  saturation?: number;
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

// Every name carries the binding, so several Grade and HueGrade extensions in one Tonemap each declare their own and
// apply in order (KB-OWN-TONE2).
const code = (b: number, tone: boolean) => `
struct Grade${b} {shadows:vec4f,midtones:vec4f,highlights:vec4f,hue0:vec4f,hue1:vec4f,curve:array<vec4f,${SAMPLES}>${tone ? ',lift:vec4f,gamma:vec4f,gain:vec4f' : ''}}
@group(0) @binding(${b}) var<uniform> grading${b}:Grade${b};${
  tone
    ? `
fn gradeTone${b}(input:vec3f)->vec3f {
 let lifted=grading${b}.gain.rgb*(input+grading${b}.lift.rgb*(1.0-input));
 let c=clamp(pow(max(lifted,vec3f(0)),1.0/grading${b}.gamma.rgb),vec3f(0),vec3f(1));
 let y=dot(c,vec3f(0.2126,0.7152,0.0722));return clamp(y+(c-y)*grading${b}.lift.w,vec3f(0),vec3f(1));
}`
    : ''
}
fn gradeCurve${b}(x:f32,channel:i32)->f32 {
 let t=clamp(x,0.0,1.0)*${SAMPLES - 1}.0;let i=min(i32(t),${SAMPLES - 2});
 return mix(grading${b}.curve[i][channel],grading${b}.curve[i+1][channel],t-f32(i));
}
fn gradeColor${b}(input:vec3f)->vec3f {
 var c=clamp(input,vec3f(0),vec3f(1));let extra=input-c;${tone ? `c=gradeTone${b}(c);` : ''}
 let l=dot(c,vec3f(0.2126,0.7152,0.0722));let ws=1.0-smoothstep(0.0,0.5,l);let wh=smoothstep(0.5,1.0,l);
 c=clamp(c+grading${b}.shadows.rgb*ws+grading${b}.midtones.rgb*(1.0-ws-wh)+grading${b}.highlights.rgb*wh,vec3f(0),vec3f(1));
 c=vec3f(gradeCurve${b}(gradeCurve${b}(c.r,0),1),gradeCurve${b}(gradeCurve${b}(c.g,0),2),gradeCurve${b}(gradeCurve${b}(c.b,0),3));
 let hi=max(c.r,max(c.g,c.b));let lo=min(c.r,min(c.g,c.b));
 if(hi>lo){
  var h:f32;
  if(hi==c.r){h=(c.g-c.b)/(hi-lo);}else if(hi==c.g){h=2.0+(c.b-c.r)/(hi-lo);}else{h=4.0+(c.r-c.g)/(hi-lo);}
  h=fract(h/6.0+1.0)*6.0;let k=array<f32,7>(grading${b}.hue0.x,grading${b}.hue0.y,grading${b}.hue0.z,grading${b}.hue0.w,grading${b}.hue1.x,grading${b}.hue1.y,grading${b}.hue0.x);
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
  private readonly buffer = new Float32Array(20 + 4 * SAMPLES);
  // With lift, gamma, gain or saturation in use: the same values and three more vec4s (lift and saturation, gamma, gain).
  private readonly toneBuffer = new Float32Array(32 + 4 * SAMPLES);
  private readonly column = new Float32Array(SAMPLES);
  constructor(readonly options: GradeOptions = {}) {
    this.check();
  }
  /** `'grade'`, or `'grade:tone'` while lift, gamma, gain or saturation is away from its default (Tonemap recompiles). */
  get key(): string {
    return this.tone() ? 'grade:tone' : 'grade';
  }
  /** Whether lift, gamma, gain or saturation is away from its default this frame. */
  protected tone(): boolean {
    const o = this.options,
      off = (v: readonly number[] | undefined, at: number) => v === undefined || v.every((x) => x === at);
    return !(off(o.lift, 0) && off(o.gamma, 1) && off(o.gain, 1) && (o.saturation ?? 1) === 1);
  }
  patch(shader: string, binding: number): string {
    return (
      shader.replace('if(p.grade.w==1.0){color=sampleLUT(', `color=gradeColor${binding}(color);\n  $&`) +
      code(binding, this.tone())
    );
  }
  values(): Float32Array {
    this.check();
    const o = this.options,
      tone = this.tone(),
      v = tone ? this.toneBuffer : this.buffer,
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
    if (tone) {
      const at = 20 + 4 * SAMPLES;
      v.set(o.lift ?? [0, 0, 0], at);
      v[at + 3] = o.saturation ?? 1;
      v.set(o.gamma ?? [1, 1, 1], at + 4);
      v.set(o.gain ?? [1, 1, 1], at + 8);
    }
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
    const rgb = (v: unknown, lo: number, hi: number) =>
      v === undefined || (Array.isArray(v) && v.length === 3 && v.every((x) => x >= lo && x <= hi));
    if (
      !isWheel(o.lift) ||
      !rgb(o.gamma, 0.1, 10) ||
      !rgb(o.gain, 0, 4) ||
      !(o.saturation === undefined || (o.saturation >= 0 && o.saturation <= 4))
    )
      throw new RangeError(
        'Invalid Grade options; lift is three numbers -1 to 1, gamma three from 0.1 to 10, gain three from 0 to 4 and saturation 0 to 4.',
      );
  }
}
