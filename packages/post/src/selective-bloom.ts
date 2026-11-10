import type { EngineKernel } from '@margoengine/core';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { Bloom, type BloomOptions } from './bloom.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';

/** HDR bloom from the selected red-channel mask, before convolution. */
export interface SelectiveBloomOptions extends BloomOptions {
  /** Current single-sample mask; any size, red coverage 0..1. Missing mask emits no glow. */
  mask: () => GPUTexture | undefined;
  /** Select all pixels outside the mask instead. Default false. */
  inverted?: boolean;
  /** Exclude clear-depth background, including inverted selections. Default true. */
  ignoreBackground?: boolean;
  /** Default true. */
  enabled?: boolean;
}
const extract = `${fullscreen}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var mask:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var<uniform> u:vec4f;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);let s=textureLoad(scene,q,0);
 let m=clamp(vec2i(p.xy/vec2f(textureDimensions(scene))*vec2f(textureDimensions(mask))),vec2i(0),vec2i(textureDimensions(mask))-1);
 var w=textureLoad(mask,m,0).r;
 if(u.x>0.0){w=1.0-w;}
 if(u.y>0.0&&textureLoad(depth,q,0)<=0.0){w=0.0;}
 return vec4f(s.rgb*w*u.z,0);
}`;
const composite = (hdr: boolean) => `${fullscreen}${hdr ? '' : displayShader}
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var selected:texture_2d<f32>;
@group(0) @binding(2) var bloomed:texture_2d<f32>;
@group(0) @binding(3) var<uniform> u:vec4f;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);let s=textureLoad(scene,q,0);
 let glow=max(textureLoad(bloomed,q,0).rgb-textureLoad(selected,q,0).rgb,vec3f(0));
 let c=(s.rgb+glow)*exp2(u.w);
 ${hdr ? 'return vec4f(c,s.a);' : 'let d=toDisplay(c);let a=max(s.a,max(d.r,max(d.g,d.b)));return vec4f(min(d,vec3f(a)),a);'}
}`;
/** Selective glow: masks the source light, lets its halo spread outside the selection, and preserves the scene. */
export class SelectiveBloom extends ScreenEffect {
  readonly name = 'selective-bloom';
  protected readonly kind = 'hdr';
  private bloom: Bloom;
  private blank?: GPUTexture;
  private readonly values = new Float32Array(4);
  constructor(readonly options: SelectiveBloomOptions) {
    super();
    this.check();
    this.bloom = new Bloom({ ...options, exposure: 0 });
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: SelectiveBloomOptions): SelectiveBloom {
    const effect = new SelectiveBloom(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  protected check(): void {
    if (typeof this.options.mask !== 'function')
      throw new TypeError('SelectiveBloom mask must be a function; pass () => texture');
    for (const key of ['enabled', 'inverted', 'ignoreBackground'] as const)
      if (this.options[key] !== undefined && typeof this.options[key] !== 'boolean')
        throw new TypeError(`SelectiveBloom ${key} must be boolean; pass true or false`);
    const o = this.options;
    if (!Number.isFinite(o.exposure ?? 0) || Math.abs(o.exposure ?? 0) > 10)
      throw new RangeError('Use SelectiveBloom exposure from -10 to 10');
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      mask = o.mask();
    this.blank ??= c.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x4 | 0x10 });
    this.values.set([
      +(o.inverted ?? false),
      +(o.ignoreBackground ?? true),
      +(o.enabled !== false && !!mask),
      o.exposure ?? 0,
    ]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    const selected = this.target(c, 0),
      bloomed = this.target(c, 1),
      uniform = { buffer: this.uniform! };
    this.draw(c, extract, { view: selected, format: 'rgba16float', multisample: { count: 1 }, hdr: true }, [
      input,
      (mask ?? this.blank).createView(),
      this.host!.depthTexture!.createView({ aspect: 'depth-only' }),
      uniform,
    ]);
    Object.assign(this.bloom.options, { strength: o.strength, threshold: o.threshold, radius: o.radius });
    this.bloom.encodeImage(c, selected, bloomed);
    this.draw(c, composite(output.hdr), output, [input, selected, bloomed, uniform]);
  }
  protected override release(): void {
    super.release();
    this.blank?.destroy();
    this.blank = undefined;
    this.bloom?.dispose();
    this.bloom = new Bloom();
  }
}
