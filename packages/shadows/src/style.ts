// How dark a light's shadow is and what colour it leaves: given to `Shadows` or `VirtualShadows` in `effects`. A point keeps
// mix(floor, 1, visibility) of the light, per channel, where the floor is what a full shadow lets through. Art direction, not
// physics: the light in the floor reaches where no light could, as a second sun that casts nothing would.
import type { ShadowEffect, ShadowEffectFrame } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** {@link shadowStyle} settings, read every frame from the effect's `options`. */
export interface ShadowStyleOptions {
  /** How much of the light a full shadow takes away, 0 to 1: 0 is no shadow, 1 takes all of it. Default 1. */
  intensity?: number;
  /** The colour a full shadow takes the light towards, linear RGB, each 0 to 1. Default [0, 0, 0]. */
  color?: readonly [number, number, number];
}
/** The effect `shadowStyle` returns, with live `options`. */
export interface ShadowStyle<Context = unknown> extends ShadowEffect<Context> {
  readonly options: ShadowStyleOptions;
}
/**
 * Sets how dark this light's shadow is and tints it: `Shadows.attach(engine, {effects: [shadowStyle({intensity: 0.7, color:
 * [0.1, 0.1, 0.4]})]})`. It takes the whole shadow of that light, the map's, tinted casters' and the other effects' together.
 * Lit ground keeps its light exactly. One per `Shadows` or `VirtualShadows`. Out of range values throw RangeError at the frame.
 */
export function shadowStyle<Context extends { device: GPUDevice }>(options: ShadowStyleOptions = {}): ShadowStyle<Context> {
  const values = new Float32Array(4);
  let binding = 0,
    uniform: GPUBuffer | undefined;
  return {
    options,
    get style() {
      return `shadowFxStyle${binding}`;
    },
    wgsl(group, at) {
      binding = at;
      return /* wgsl */ `@group(${group}) @binding(${at}) var<uniform> shadowFxStyleFloor${at}:vec4f;
fn shadowFxStyle${at}(shade:vec3f)->vec3f {return mix(shadowFxStyleFloor${at}.rgb,vec3f(1),shade);}
`;
    },
    resources: () => [{ buffer: uniform! }],
    setup(device) {
      uniform ??= device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    },
    update(frame: ShadowEffectFrame<Context>) {
      const { intensity = 1, color = [0, 0, 0] } = this.options;
      if (!(intensity >= 0 && intensity <= 1)) throw new RangeError('Invalid shadow intensity; use a number from 0 to 1');
      if (color.length !== 3 || !color.every((v) => v >= 0 && v <= 1))
        throw new RangeError('Invalid shadow color; use [r, g, b], each from 0 to 1');
      for (let i = 0; i < 3; i++) values[i] = 1 - intensity + intensity * color[i]!;
      frame.context.device.queue.writeBuffer(uniform!, 0, values);
    },
    dispose() {
      uniform?.destroy();
      uniform = undefined;
    },
  };
}
