// Custom tone curve for Tonemap: replaces the display curve with your own, given either as WGSL (a function from
// exposed scene-linear RGB to display-linear RGB) or as a JavaScript function of one channel, sampled every frame at
// 128 points spaced evenly in log2 from 2^-12 to 2^8 and read with linear interpolation in log2 (below 2^-12 the
// curve runs linearly from its value at 0). Contrast, grading, the LUT and the sRGB encoding still follow the curve;
// under an HDR ColorOutput the result takes the same rolloff toward the display peak as AgX and ACES.
import type { TonemapExtension } from './index.js';

/** Options of {@link CustomCurve}; the object is kept and read every frame. Give exactly one of `wgsl` and `curve`. */
export interface CustomCurveOptions {
  /**
   * WGSL whose first function is the curve: `fn name(x: vec3f) -> vec3f`, from exposed scene-linear RGB (0 and up) to
   * display-linear RGB (0..1). Further functions in the string come along. The 16 `params` are in scope as
   * `curveParams[0]` to `curveParams[3]` (four vec4f). Changing the string compiles a new pipeline.
   */
  wgsl?: string;
  /** A curve of one channel, from scene-linear (0 and up) to display-linear (0..1), applied to R, G and B alike. */
  curve?: (x: number) => number;
  /** Up to 16 numbers for the WGSL curve, read every frame (live parameters without a recompile). Default zeros. */
  params?: readonly number[];
}

const SAMPLES = 128,
  LOW = -12,
  RANGE = 20,
  FN = /^\s*(?:\/\/[^\n]*\n\s*)*fn\s+([A-Za-z_]\w*)\s*\(\s*\w+\s*:\s*(?:vec3f|vec3<f32>)\s*\)\s*->\s*(?:vec3f|vec3<f32>)/;

const code = (binding: number, call: string) => `
struct CustomCurve {params:array<vec4f,4>,table:array<vec4f,${SAMPLES / 4 + 1}>}
@group(0) @binding(${binding}) var<uniform> customCurveData:CustomCurve;
fn customSample(x:f32)->f32 {
 let low=exp2(${LOW}.0);
 if(x<=low){return mix(customCurveData.table[${SAMPLES / 4}].x,customCurveData.table[0].x,max(x,0.0)/low);}
 let t=clamp((log2(x)-${LOW}.0)/${RANGE}.0,0.0,1.0)*${SAMPLES - 1}.0;let i=min(u32(t),${SAMPLES - 2}u);let j=i+1u;
 return mix(customCurveData.table[i/4u][i%4u],customCurveData.table[j/4u][j%4u],t-f32(i));
}
fn customCurve(x:vec3f)->vec3f {${call}}`;

/**
 * Your own tone curve for {@link Tonemap}, in place of `curve`: give it to Tonemap's `extensions`. With `wgsl` it
 * compiles your function into the presentation shader; with `curve` it samples your JavaScript function every frame.
 * @throws RangeError when both or neither of `wgsl` and `curve` are given, when `wgsl` does not start with
 * `fn name(x: vec3f) -> vec3f` or its name is taken by the shader, when `curve` gives a negative or non-finite value, or
 * when `params` holds more than 16 numbers or a non-finite one (checked now and every frame).
 */
export class CustomCurve implements TonemapExtension {
  private readonly buffer = new Float32Array(16 + SAMPLES + 4);
  constructor(readonly options: CustomCurveOptions) {
    this.check();
  }
  /** Names the curve in Tonemap's pipeline cache: a new WGSL string builds a new pipeline. */
  get key(): string {
    return this.options.wgsl === undefined ? 'custom:sampled' : 'custom:' + this.options.wgsl;
  }
  patch(shader: string, binding: number): string {
    this.check();
    const wgsl = this.options.wgsl;
    let call = 'return vec3f(customSample(x.r),customSample(x.g),customSample(x.b));',
      extra = '';
    if (wgsl !== undefined) {
      const name = FN.exec(wgsl)![1];
      if (new RegExp(`fn\\s+${name}\\s*\\(`).test(shader) || /^(custom(Sample|Curve|CurveData)|curveParams)$/.test(name))
        throw new RangeError(`CustomCurve: the name ${name} is already used by the Tonemap shader; rename the function.`);
      call = `return ${name}(x);`;
      extra = `\n${wgsl.replace(/\bcurveParams\b/g, 'customCurveData.params')}`;
    }
    // After the built-in curve, before contrast: SDR (clamp to 1) and the ColorOutput shader (clamp to white).
    const sdr = 'color=clamp((color-0.18)*p.grade.y+0.18,vec3f(0),vec3f(1));',
      hdr = 'color=clamp((color-0.18)*p.grade.y+0.18,vec3f(0),vec3f(white));';
    return (
      shader
        .replace(sdr, 'color=customCurve(hdr);\n  ' + sdr)
        .replace(hdr, 'color=customCurve(positive);if(m>=0.76){color*=rolloff(m,white)/rolloff(m,1.0);}\n  ' + hdr) +
      code(binding, call) +
      extra
    );
  }
  values(): Float32Array {
    this.check();
    const o = this.options,
      v = this.buffer;
    v.fill(0);
    if (o.params) v.set(o.params, 0);
    if (o.curve) {
      for (let i = 0; i < SAMPLES; i++) v[16 + i] = o.curve(2 ** (LOW + (RANGE * i) / (SAMPLES - 1)));
      v[16 + SAMPLES] = o.curve(0);
      for (let i = 16; i <= 16 + SAMPLES; i++)
        if (!(v[i] >= 0 && Number.isFinite(v[i])))
          throw new RangeError('CustomCurve: curve must give a finite value of 0 or more for every input.');
    }
    return v;
  }
  private check(): void {
    const { wgsl, curve, params } = this.options;
    if ((wgsl === undefined) === (curve === undefined))
      throw new RangeError('CustomCurve: give exactly one of wgsl and curve.');
    if (wgsl !== undefined && (typeof wgsl !== 'string' || !FN.test(wgsl)))
      throw new RangeError('CustomCurve: wgsl must start with a function fn name(x: vec3f) -> vec3f.');
    if (curve !== undefined && typeof curve !== 'function')
      throw new RangeError('CustomCurve: curve must be a function of one number.');
    if (params !== undefined && !(Array.isArray(params) && params.length <= 16 && params.every(Number.isFinite)))
      throw new RangeError('CustomCurve: params is up to 16 finite numbers.');
  }
}
