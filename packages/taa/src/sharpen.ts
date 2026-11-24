/// <reference lib="esnext.disposable" preserve="true" />
// Contrast-adaptive sharpen after TAA, at native resolution: the unsharp mask of `TAAUpscale` (./cas.ts) run in TAA's
// present pass, so the history stays unsharpened and only the shown frame is.
import { sharpenCode } from './cas.js';
import type { TAAPresent } from './index.js';
import { MargoError } from '@margoengine/math/errors';

/** Options for {@link Sharpen}. */
export interface SharpenOptions {
  /** Strength, 0 (off) to 1, read every frame from `sharpen.amount`. Default 0.3. */
  amount?: number;
}

/**
 * Contrast-adaptive sharpening of TAA's shown frame: `TAA.attach(engine, {present: new Sharpen()})`. An unsharp mask on
 * the four neighbours whose strength falls as the pixel's neighbourhood nears black or white, clamped to that
 * neighbourhood's range, so it adds no halo and never clips. TAA's history is not sharpened, so it does not build up.
 */
export class Sharpen implements TAAPresent {
  amount: number;
  private readonly settings = new Float32Array(4);
  constructor(options: SharpenOptions = {}) {
    this.amount = options.amount ?? 0.3;
    this.values();
  }
  /** The present shader with the sharpen in it; `image` at binding 0 is TAA's resolved linear frame. */
  code(present: string): string {
    const read = 'let c=max(textureLoad(image,vec2i(i.clip.xy),0).rgb,vec3f(0));';
    if (present.split(read).length !== 2)
      throw new MargoError('state', 'Sharpen needs the TAA present shader; use matching @margoengine/taa entries');
    return present
      .replace(
        '@group(0) @binding(0) var image:texture_2d<f32>;',
        '@group(0) @binding(0) var image:texture_2d<f32>;\n@group(0) @binding(1) var<uniform> sharpen:vec4f;\n' + sharpenCode,
      )
      .replace(read, 'let c=max(margoSharpen(image,vec2i(i.clip.xy),sharpen.x),vec3f(0));');
  }
  /** This frame's uniform: the strength in x; RangeError when `amount` is outside 0 to 1. */
  values(): Float32Array {
    const amount = this.amount;
    if (!Number.isFinite(amount) || amount < 0 || amount > 1)
      throw new RangeError('Invalid Sharpen amount; pass a number from 0 to 1.');
    this.settings[0] = amount;
    return this.settings;
  }
}
