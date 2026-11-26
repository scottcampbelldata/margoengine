// Colour enhancement for Tonemap, on scene-linear colour after exposure, white balance and local exposure and before
// the display curve (and so before contrast, Grade and the LUT). In order:
// 1. Channel mixer: out = M in, M the 3x3 matrix whose rows are `red`, `green` and `blue` (linear Rec.709).
// 2. Dehaze, on the haze image model I = J t + A (1 - t) with airlight A (H. Koschmieder, 1924; S. G. Narasimhan and
//    S. K. Nayar, "Vision and the Atmosphere", IJCV 48(3), 2002). Positive: the model inverted, J = (I - A) / t + A, with
//    t = 1 - v and v = 0.5 amount min(I / A, 1) over the channels, the dark channel of K. He, J. Sun and X. Tang,
//    "Single Image Haze Removal Using Dark Channel Prior" (CVPR 2009) taken over one pixel, the per-pixel channel
//    minimum J.-P. Tarel and N. Hautiere start their veil from ("Fast Visibility Restoration from a Single Color or Gray
//    Level Image", ICCV 2009); channels at or above A are left as they are. Negative: the model forwards,
//    I = J t + A (1 - t) with 1 - t = 0.5 |amount|.
// 3. Shadows, midtones and highlights: a gain of 2^stops on all channels, so hue is kept. With e = log2(Y / 0.18),
//    Y Rec.709 luma (ITU-R BT.709-6): low = smoothstep(-7, 0, e), high = smoothstep(0, 7, e), and
//    stops = shadows (1 - low) + midtones (low - high) + highlights high. The weights sum to 1; middle grey moves by
//    `midtones` alone. e + stops rises with e over every allowed setting (the weights' slope is at most 1.5 / 7 and two
//    neighbouring controls differ by at most 4 stops), so no setting reverses two tones.
// 4. Vibrance: out = x + (x - Y) amount (1 - S), S = (max - min) / max the HSV saturation (A. R. Smith, "Color Gamut
//    Transform Pairs", SIGGRAPH 1978), so a dull colour moves most and a pure one not at all.
// Every step is an exact identity at its default.
import { rangeError, typeError } from '../../shared/errors.js';
import type { TonemapExtension } from './index.js';

/** One row of the channel mixer: how much of the input red, green and blue goes into one output channel, each -2 to 2. */
export type MixerRow = readonly [number, number, number];

/** Options of {@link ColorEnhance}; the object is kept and read every frame. */
export interface ColorEnhanceOptions {
  /** The 3x3 RGB channel mixer, a row per output channel. Default the identity (no change). */
  mixer?: {
    /** Input red, green and blue in the output red, each -2 to 2. Default [1, 0, 0]. */
    red?: MixerRow;
    /** Input red, green and blue in the output green, each -2 to 2. Default [0, 1, 0]. */
    green?: MixerRow;
    /** Input red, green and blue in the output blue, each -2 to 2. Default [0, 0, 1]. */
    blue?: MixerRow;
  };
  /** Stops for the dark tones (below middle grey), -3 to 3. Default 0. */
  shadows?: number;
  /** Stops at middle grey, fading out toward black and bright light, -1 to 1. Default 0. */
  midtones?: number;
  /** Stops for the bright tones (above middle grey), -3 to 3. Default 0. */
  highlights?: number;
  /** Saturation that favours dull colours, -1 to 1: above 0 boosts them, below 0 mutes them. Default 0. */
  vibrance?: number;
  /** Haze, -1 to 1: above 0 removes it (deeper shadows, clearer colour), below 0 adds it. Default 0. */
  dehaze?: number;
  /** Colour of the haze (the airlight) after exposure, linear Rec.709, 0.01 to 16 per channel. Default [1, 1, 1]. */
  hazeColor?: readonly [number, number, number];
}

const RED: MixerRow = [1, 0, 0],
  GREEN: MixerRow = [0, 1, 0],
  BLUE: MixerRow = [0, 0, 1],
  WHITE: MixerRow = [1, 1, 1];

function number(value: unknown, name: string, lo: number, hi: number): number {
  if (typeof value !== 'number' || !(value >= lo && value <= hi))
    throw rangeError(
      `ColorEnhance ${name} must be a number from ${lo} to ${hi}, not ${String(value)}; pass a value in that range`,
      'arguments',
    );
  return value;
}

const code = (b: number) => `
struct ColorEnhance${b} {red:vec4f,green:vec4f,blue:vec4f,haze:vec4f,vibrance:vec4f}
@group(0) @binding(${b}) var<uniform> enhancing${b}:ColorEnhance${b};
fn colorEnhance${b}(input:vec3f)->vec3f {
 let e=enhancing${b};let luma=vec3f(0.2126,0.7152,0.0722);
 let mixed=vec3f(dot(e.red.rgb,input),dot(e.green.rgb,input),dot(e.blue.rgb,input));
 let outside=min(mixed,vec3f(0));var c=max(mixed,vec3f(0));
 let air=e.haze.rgb;let veiled=min(c/air,vec3f(1));
 let v=0.5*max(e.haze.w,0.0)*min(veiled.r,min(veiled.g,veiled.b));
 c-=air*(vec3f(1)-veiled)*(v/(1.0-v));
 c+=(air-c)*(0.5*max(-e.haze.w,0.0));
 let stop=log2(max(dot(c,luma),0.000001)/0.18);
 let low=smoothstep(-7.0,0.0,stop);let high=smoothstep(0.0,7.0,stop);
 c*=exp2(e.red.w*(1.0-low)+e.green.w*(low-high)+e.blue.w*high);
 let hi=max(c.r,max(c.g,c.b));let lo=min(c.r,min(c.g,c.b));let saturation=(hi-lo)/max(hi,0.000001);
 c+=(c-vec3f(dot(c,luma)))*(e.vibrance.x*(1.0-saturation));
 return max(c,vec3f(0))+outside;
}`;

/**
 * Colour enhancement for {@link Tonemap}: a 3x3 RGB channel mixer, dehaze, shadows, midtones and highlights in stops,
 * and vibrance, on the HDR picture before the display curve. Give it to Tonemap's `extensions`; change
 * `enhance.options` any time (read every frame, no recompile). With default options it changes nothing. One uniform
 * buffer, which the Tonemap owns; no pass or texture of its own.
 * @throws RangeError or TypeError for an option out of range or of the wrong shape (checked now and every frame).
 */
export class ColorEnhance implements TonemapExtension {
  readonly key = 'enhance';
  private readonly buffer = new Float32Array(20);
  constructor(readonly options: ColorEnhanceOptions = {}) {
    this.values();
  }
  patch(shader: string, binding: number): string {
    // Right before the display curve: ahead of the P3 conversion in the ColorOutput shader (which keeps colours below
    // zero as colours outside sRGB), and ahead of the curve in the SDR shader (which takes none).
    const output = shader.includes('if(p.settings.z==1.0){'),
      at = output ? 'if(p.settings.z==1.0){' : 'var color:vec3f;';
    if (!shader.includes(at))
      throw rangeError(
        'ColorEnhance found no display curve to run before; use it only in Tonemap extensions',
        'arguments',
      );
    const call = output ? `hdr=colorEnhance${binding}(hdr);` : `hdr=max(colorEnhance${binding}(hdr),vec3f(0));`;
    return shader.replace(at, `${call}\n  ${at}`) + code(binding);
  }
  values(): Float32Array {
    const o = this.options;
    if (typeof o !== 'object' || o === null || (o.mixer !== undefined && (typeof o.mixer !== 'object' || !o.mixer)))
      throw typeError('ColorEnhance options and mixer must be objects; pass {} for the defaults', 'arguments');
    this.row(0, o.mixer?.red ?? RED, 'mixer.red', -2, 2);
    this.row(4, o.mixer?.green ?? GREEN, 'mixer.green', -2, 2);
    this.row(8, o.mixer?.blue ?? BLUE, 'mixer.blue', -2, 2);
    this.row(12, o.hazeColor ?? WHITE, 'hazeColor', 0.01, 16);
    const v = this.buffer;
    v[3] = number(o.shadows ?? 0, 'shadows', -3, 3);
    v[7] = number(o.midtones ?? 0, 'midtones', -1, 1);
    v[11] = number(o.highlights ?? 0, 'highlights', -3, 3);
    v[15] = number(o.dehaze ?? 0, 'dehaze', -1, 1);
    v[16] = number(o.vibrance ?? 0, 'vibrance', -1, 1);
    return v;
  }
  private row(at: number, row: readonly number[], name: string, lo: number, hi: number): void {
    if (!Array.isArray(row) || row.length !== 3)
      throw typeError(`ColorEnhance ${name} must be an array of three numbers`, 'arguments');
    for (let i = 0; i < 3; i++) this.buffer[at + i] = number(row[i], name, lo, hi);
  }
}
