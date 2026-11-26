// ColorAverage: the frame as the mean of its channels (HSI intensity, R. Gonzalez and R. Woods, "Digital Image
// Processing", ch. 6), composited by the overlay pass, so it takes a blend mode, an opacity and a mask.
import type { EngineKernel } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';
import { OverlayEffect, type OverlayOptions } from './overlays.js';
import type { ScreenContext } from './screen-effect.js';

/** Options for {@link ColorAverage}; all are read each frame. */
export interface ColorAverageOptions extends OverlayOptions {
  /** The share of red, green and blue in the grey, each 0 or more with a sum above 0 (they are divided by the sum).
   * Default [1, 1, 1], the plain average; [0.2126, 0.7152, 0.0722] is Rec. 709 luma. */
  weights?: readonly [number, number, number];
}
const AVERAGE = {
  body: `fn layer(p:vec2f)->vec4f{
 let s=textureLoad(scene,vec2i(p),0);
 return vec4f(vec3f(dot(clamp(s.rgb/max(s.a,1e-6),vec3f(0.0),vec3f(1.0)),u[3].rgb)),1.0);
}`,
};
const PLAIN = [1, 1, 1] as const;

/**
 * A fast greyscale: every pixel's channels averaged, on display values. An LDR `PostStack` effect.
 * @throws RangeError for weights, a blend mode, an opacity or a mask out of range (checked now and every frame);
 * MargoError `'state'` outside a PostStack, `'unsupported'` without a GPU backend, `'disposed'` after `dispose()`,
 * `'attached'` when joined twice.
 */
export class ColorAverage extends OverlayEffect<ColorAverageOptions> {
  readonly name = 'color-average';
  constructor(options: ColorAverageOptions = {}) {
    super(options);
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: ColorAverageOptions = {}): ColorAverage {
    return OverlayEffect.alone(engine, new ColorAverage(options));
  }
  protected override check(): void {
    super.check();
    const w = this.options.weights ?? PLAIN;
    if (!(Array.isArray(w) && w.length === 3 && w.every((v) => v >= 0 && Number.isFinite(v)) && w[0] + w[1] + w[2] > 0))
      throw rangeError('Use ColorAverage weights as three numbers of 0 or more with a sum above 0', 'arguments');
  }
  protected source() {
    return AVERAGE;
  }
  protected params(_c: ScreenContext, v: Float32Array): GPUBindingResource[] {
    const [r, g, b] = this.options.weights ?? PLAIN,
      sum = r + g + b;
    v.set([r / sum, g / sum, b / sum]);
    return [];
  }
}
