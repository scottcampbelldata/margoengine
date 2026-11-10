import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { rangeError } from '../../shared/errors.js';
import { SpriteLayer, type SpriteLayerOptions } from './index.js';
import { Sprite, sortSprites, type SpriteOptions } from './sprite.js';

/** Per-image compositing operators, evaluated in draw order. */
export type SpriteBlendMode = 'normal' | 'add' | 'multiply' | 'screen';
/** Sprite settings with a per-image blend mode. */
export interface BlendSpriteOptions extends SpriteOptions {
  blendMode?: SpriteBlendMode;
}
const valid = (mode: unknown): mode is SpriteBlendMode =>
  ['normal', 'add', 'multiply', 'screen'].includes(mode as string);

/** A sprite whose blend mode can be changed at any time. */
export class BlendSprite extends Sprite {
  private mode: SpriteBlendMode = 'normal';
  constructor(options: BlendSpriteOptions = {}) {
    super(options);
    this.blendMode = options.blendMode ?? 'normal';
  }
  /** Default normal. Changing it rebuilds the ordered batches on the next frame. */
  get blendMode(): SpriteBlendMode {
    return this.mode;
  }
  set blendMode(mode: SpriteBlendMode) {
    if (!valid(mode)) throw rangeError('Invalid sprite blend mode', 'sprite-options');
    this.mode = mode;
  }
}
/** One contiguous run in the packed visible-sprite buffer. */
export interface SpriteBlendBatch {
  mode: SpriteBlendMode;
  first: number;
  count: number;
}
/** Groups adjacent equal modes without changing z/y/add order or mutating the input. Hidden sprites occupy no instance. */
export function blendBatches(sprites: readonly Sprite[], ySort = false): SpriteBlendBatch[] {
  const ordered = [...sprites],
    batches: SpriteBlendBatch[] = [];
  sortSprites(ordered, ySort);
  let first = 0;
  for (const sprite of ordered) {
    if (!sprite.visible) continue;
    const mode = (sprite as Partial<BlendSprite>).blendMode ?? 'normal';
    if (!valid(mode)) throw rangeError('Invalid sprite blend mode', 'sprite-options');
    const last = batches.at(-1);
    if (last?.mode === mode) last.count++;
    else batches.push({ mode, first, count: 1 });
    first++;
  }
  return batches;
}

/** Blend layers retain the standard atlas, smooth filtering, masks, normals, camera and target options. */
export type BlendLayerOptions = Omit<SpriteLayerOptions, 'shader'>;
const shader = (smooth: boolean) => ({
  code: `
override multiplyCorrection:bool=false;
fn effect(c:vec4f,s:SpriteInput)->vec4f{
  ${
    smooth
      ? `if(!multiplyCorrection){return c;}
  let straight=select(c.rgb,decode(c.rgb),frame.size.z>0);
  let d=vec3f(1-c.a)+straight*c.a;
  let q=select(straight/d,vec3f(0),d==vec3f(0));
  return vec4f(select(q,encode(q),frame.size.z>0),c.a);`
      : `let p=c.rgb*c.a;
  if(!multiplyCorrection){return vec4f(p,c.a);}
  let d=vec3f(1-c.a)+p;
  return vec4f(select(p/d,vec3f(0),d==vec3f(0)),c.a);`
  }
}`,
});

/**
 * Mixed per-sprite blend modes in one layer. Adjacent equal modes share a draw, preserving visual order.
 * Multiply uses two draws per sprite to preserve uncovered source colour on transparent targets.
 */
export class BlendLayer extends SpriteLayer {
  private current: SpriteBlendMode = 'normal';
  private correction = false;
  constructor(options: BlendLayerOptions) {
    super({ ...options, shader: shader(options?.filter === 'linear') });
  }
  static override attach(instance: EngineKernel, options: BlendLayerOptions): BlendLayer {
    const layer = new BlendLayer(options);
    engineRuntime(instance).use(layer);
    return layer;
  }
  /** Adds a sprite with an independently mutable blendMode. Ordinary add() sprites use normal. */
  addBlend(sprite: BlendSprite | BlendSpriteOptions = {}): BlendSprite {
    return super.add(sprite instanceof BlendSprite ? sprite : new BlendSprite(sprite)) as BlendSprite;
  }
  protected override pipelineVariant(): string {
    return `${this.current}/${this.correction}`;
  }
  protected override configurePipeline(descriptor: GPURenderPipelineDescriptor): GPURenderPipelineDescriptor {
    const targets = [...descriptor.fragment!.targets],
      base = targets[0]!;
    const color: GPUBlendComponent = this.correction
      ? { srcFactor: 'one-minus-dst-alpha', dstFactor: 'one' }
      : this.current === 'add'
        ? { srcFactor: 'one', dstFactor: 'one' }
        : this.current === 'multiply'
          ? { srcFactor: 'dst', dstFactor: 'one-minus-src-alpha' }
          : this.current === 'screen'
            ? { srcFactor: 'one', dstFactor: 'one-minus-src' }
            : { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };
    targets[0] = {
      ...base,
      writeMask: this.correction ? 7 : 15,
      blend: {
        color,
        alpha: { srcFactor: 'one', dstFactor: this.current === 'add' ? 'one' : 'one-minus-src-alpha' },
      },
    };
    return {
      ...descriptor,
      fragment: {
        ...descriptor.fragment!,
        targets,
        constants: { ...descriptor.fragment!.constants, multiplyCorrection: Number(this.correction) },
      },
    };
  }
  protected override drawInstances(
    pass: GPURenderPassEncoder,
    device: GPUDevice,
    format: GPUTextureFormat,
    samples: number,
    normal: GPUTextureFormat | undefined,
    _count: number,
  ): void {
    for (const batch of blendBatches(this.sprites, this.ySort)) {
      this.current = batch.mode;
      if (batch.mode === 'multiply')
        for (let i = batch.first; i < batch.first + batch.count; i++) {
          this.correction = true;
          super.drawInstances(pass, device, format, samples, normal, 1, i);
          this.correction = false;
          super.drawInstances(pass, device, format, samples, normal, 1, i);
        }
      else {
        this.correction = false;
        super.drawInstances(pass, device, format, samples, normal, batch.count, batch.first);
      }
    }
  }
}
