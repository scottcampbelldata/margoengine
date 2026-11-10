import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin } from '@margoengine/core/extension';
import type { StackHost, StackStage, StageOutput } from '../../shared/stack.js';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';

/** Coverage used to mix an effect with its unmodified input. */
export interface EffectMaskOptions {
  /** Single-sample red-channel object coverage, any size. Missing texture leaves the input unchanged. */
  mask: () => GPUTexture | undefined;
  /** Isolate one red-channel id instead of reading continuous coverage. Default unset. */
  maskId?: number;
  /** Affect unselected pixels. Default false; a missing mask still passes through. */
  inverted?: boolean;
  /** Coverage multiplier, 0..1. Default 1. */
  opacity?: number;
  /** Default true. */
  enabled?: boolean;
}
const shader = (hdr: boolean, sourceHDR: boolean) => `${fullscreen}${!hdr && sourceHDR ? displayShader : ''}
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var effect:texture_2d<f32>;
@group(0) @binding(2) var mask:texture_2d<f32>;
@group(0) @binding(3) var<uniform> u:vec4f;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {
 let q=vec2i(p.xy);var s=textureLoad(source,q,0);let e=textureLoad(effect,q,0);
 ${!hdr && sourceHDR ? 's=vec4f(toDisplay(s.rgb),s.a);' : ''}
 let m=clamp(vec2i(p.xy/vec2f(textureDimensions(source))*vec2f(textureDimensions(mask))),vec2i(0),vec2i(textureDimensions(mask))-1);
 let value=textureLoad(mask,m,0).r;
 var w=clamp(value,0.0,1.0);if(u.x>=0.0){w=select(0.0,1.0,abs(value-u.x)<0.002);}
 if(u.y>0.0){w=1.0-w;}
 return mix(s,e,w*u.z);
}`;

/** Object masks for SSAO, Bloom, Blur, Lens and any custom PostStack stage. Owns its wrapped effect. */
export class EffectMask extends ScreenEffect {
  readonly name: string;
  protected readonly kind: StackStage['kind'];
  private readonly stage: StackStage;
  private blank?: GPUTexture;
  private readonly values = new Float32Array(4);
  constructor(
    readonly effect: EnginePlugin,
    readonly options: EffectMaskOptions,
  ) {
    super();
    this.check();
    const join = (effect as { joinStack?: (host: StackHost) => StackStage }).joinStack;
    if (typeof join !== 'function')
      throw new TypeError('EffectMask needs a PostStack effect; pass Bloom, SSAO, Blur, Lens or a custom stack effect');
    const owner = this;
    this.stage = join.call(effect, {
      get target() {
        return owner.host?.target;
      },
      get depthTexture() {
        return owner.host?.depthTexture;
      },
    });
    this.kind = this.stage.kind;
    this.name = `mask:${effect.name}`;
  }
  /** Runs the wrapped effect alone in an owned PostStack. */
  static attach(engine: EngineKernel, effect: EnginePlugin, options: EffectMaskOptions): EffectMask {
    const mask = new EffectMask(effect, options);
    mask.stack = PostStack.attach(engine, [mask]);
    return mask;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    if (!engine.sceneOf(this.effect)) engine.use(this.effect);
  }
  protected check(): void {
    const o = this.options;
    if (typeof o.mask !== 'function') throw new TypeError('EffectMask mask must be a function; pass () => texture');
    for (const k of ['enabled', 'inverted'] as const)
      if (o[k] !== undefined && typeof o[k] !== 'boolean')
        throw new TypeError(`EffectMask ${k} must be boolean; pass true or false`);
    for (const k of ['maskId', 'opacity'] as const)
      if (o[k] !== undefined && !(Number.isFinite(o[k]) && o[k]! >= 0 && o[k]! <= 1))
        throw new RangeError(`Use EffectMask ${k} from 0 to 1`);
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      mask = o.mask(),
      format = output.hdr ? 'rgba16float' : output.format;
    const intermediate: StageOutput = {
      view: this.target(c, 0, format),
      format,
      multisample: { count: 1 },
      hdr: output.hdr,
    };
    const live = !!this.engine?.sceneOf(this.effect);
    const result = live ? this.stage.render(c, input, intermediate) || intermediate.view : input;
    this.blank ??= c.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x4 | 0x10 });
    this.values.set([
      o.maskId ?? -1,
      +(o.inverted ?? false),
      live && mask && o.enabled !== false ? (o.opacity ?? 1) : 0,
      0,
    ]);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    this.draw(c, shader(output.hdr, this.kind !== 'ldr'), output, [
      input,
      result,
      (mask ?? this.blank).createView(),
      { buffer: this.uniform! },
    ]);
  }
  protected override release(): void {
    super.release();
    this.blank?.destroy();
    this.blank = undefined;
  }
  override dispose(): void {
    const engine = this.engine;
    super.dispose();
    if (engine?.sceneOf(this.effect)) engine.sceneOf(this.effect)!.removePlugin(this.effect.name);
    else this.effect.dispose?.();
  }
}
