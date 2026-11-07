// Thin leaves and paper as casters: light that a surface lets through, from the shadow map to the tint map.
import type { ShadowPrimitive, ShadowSource, Shadows, TintedShadowPrimitive } from './index.js';
import type { ShadowEffect, ShadowEffectFrame } from './shader.js';
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
/** {@link transmission} settings, read every frame from the returned source's `options`. */
export interface TransmissionOptions {
  /** What the light through a caster is multiplied by, 0 or more. Default 1. A way to weigh in a transmission texture. */
  scale?: number;
  /**
   * World radius of a leaf or sheet, above 0. Default 0.05. A thin surface scatters what it lets through, so a receiver at
   * distance d behind it takes the share a disc of this radius subtends there, size^2 / (size^2 + d^2).
   */
  size?: number;
}
/** The source `transmission` returns, with live `options`. */
export interface TransmissionSource extends ShadowSource {
  readonly options: TransmissionOptions;
  /** Give it in the `effects` of the `Shadows`: it spreads the light behind every tint caster of those shadows. */
  readonly effect: ShadowEffect<{ device: GPUDevice }>;
}
/**
 * `source` with what lets light through (`ShadowPrimitive.transmits`: a gltf-pro material with
 * KHR_materials_diffuse_transmission) tinting the light behind it instead of blocking it, so the ground under leaves is lit
 * by what the leaves pass on. Give the `Shadows` `colored: true` and `effects: [leaves.effect]`, then `shadows.add(leaves)`.
 * Every other primitive casts as before. Throws TypeError on adding it to shadows that have no `colored`.
 */
export function transmission(source: ShadowSource, options: TransmissionOptions = {}): TransmissionSource {
  if (!source || !('shadowPrimitives' in source))
    throw new TypeError('transmission needs a source with shadowPrimitives; pass a gltf-pro model');
  const through = (p: ShadowPrimitive) => !!p.transmits;
  const values = new Float32Array(4);
  let at = 0,
    uniform: GPUBuffer | undefined;
  const effect: ShadowEffect<{ device: GPUDevice }> = {
    get tint() {
      return `shadowFxSpread${at}(through,gap)`;
    },
    wgsl(group, binding) {
      at = binding;
      return /* wgsl */ `@group(${group}) @binding(${binding}) var<uniform> shadowFxSpreadSize${binding}:vec4f;
fn shadowFxSpread${binding}(through:vec3f,gap:f32)->vec3f {let r=shadowFxSpreadSize${binding}.x*shadowFxSpreadSize${binding}.x;return through*r/(r+gap*gap);}
`;
    },
    resources: () => [{ buffer: uniform! }],
    setup(device) {
      uniform ??= device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    },
    update(frame: ShadowEffectFrame<{ device: GPUDevice }>) {
      const { size = 0.05 } = options;
      if (!(size > 0)) throw new RangeError('Invalid transmission size; use a number above 0');
      values[0] = size;
      frame.context.device.queue.writeBuffer(uniform!, 0, values);
    },
    dispose() {
      uniform?.destroy();
      uniform = undefined;
    },
  };
  return {
    options,
    effect,
    get shadowPrimitives() {
      return source.shadowPrimitives!.filter((p) => !through(p));
    },
    get tintPrimitives() {
      const { scale = 1 } = this.options,
        out: TintedShadowPrimitive[] = [...(source.tintPrimitives ?? [])];
      if (!(scale >= 0)) throw new RangeError('Invalid transmission scale; use 0 or more');
      for (const p of source.shadowPrimitives!)
        if (through(p)) out.push({ ...p, tint: p.transmits!.map((v) => Math.min(1, v * scale)) });
      return out;
    },
    get shadowVersion() {
      return source.shadowVersion;
    },
    get disposed() {
      return source.disposed;
    },
    addLighting(effect: Shadows) {
      if (effect.options?.colored !== true)
        throw new TypeError('transmission needs coloured maps; create the Shadows with colored: true');
      return source.addLighting?.(effect) ?? (() => {});
    },
  };
}
