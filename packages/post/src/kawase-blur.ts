/// <reference lib="esnext.disposable" preserve="true" />
// Wide blurs on a small pyramid, an HDR PostStack stage. 'dual' is the dual filter of M. Bjorge, "Bandwidth-Efficient
// Rendering", SIGGRAPH 2015 course "Moving Mobile Graphics": a 5-tap halving per level, then an 8-tap doubling back.
// 'kawase' is M. Kawase, "Frame Buffer Postprocessing Effects in DOUBLE-S.T.E.A.L (Wreckless)", GDC 2003: repeated
// passes of four bilinear taps on the diagonals, k + 0.5 texels out, at one reduced size (reached by dual halvings).
// A pass of offset k adds (k^2 + (k + 1)^2) / 2 texels^2 of variance on each axis; the size presets pick offsets whose
// sum approximates a Gaussian of sigma = kernel width / 6.
import type { EngineKernel } from '@margoengine/core';
import type { StageOutput } from '../../shared/stack.js';
import { fullscreen, group, render } from '../../shared/gpu.js';
import { displayFor, displayShader } from '../../shared/display.js';
import { rangeError, typeError } from '../../shared/errors.js';
import { applyView, viewLoadOp, viewRect, viewSize } from '../../shared/view-rect.js';
import { ScreenEffect, type ScreenContext } from './screen-effect.js';
import { PostStack } from './stack.js';

/** The passes of each {@link KawaseBlurOptions.size}: one offset (texels of the working size) a pass. */
export const KAWASE_KERNELS = {
  'very-small': [0, 0],
  small: [0, 1, 2, 2],
  medium: [0, 1, 2, 3, 4, 4, 5],
  large: [0, 1, 2, 3, 4, 5, 7, 8, 9, 10],
  'very-large': [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28],
  huge: [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 44],
} as const;
/** A named Kawase kernel. Sigma at the working size: about 1, 4, 10, 20, 66 and 101 texels. */
export type KawaseSize = keyof typeof KAWASE_KERNELS;

/** Options of {@link KawaseBlur}; the object is kept and read every frame. */
export interface KawaseBlurOptions {
  /** `'dual'` (default; dual filter, each level doubles the width) or `'kawase'` (repeated passes at one size). */
  method?: 'dual' | 'kawase';
  /** Dual: halvings, a whole number 1 to 8. Default 3. */
  levels?: number;
  /** Kawase: the kernel, `'very-small'`, `'small'`, `'medium'` (default), `'large'`, `'very-large'` or `'huge'`. */
  size?: KawaseSize;
  /** Kawase: your own passes in place of `size`, 1 to 32 offsets of 0 to 64 texels. Default none. */
  offsets?: readonly number[];
  /** Spreads the taps: a factor on every sample offset, 0 to 8. Default 1; far above 1 shows a pattern. */
  scale?: number;
  /** Kawase: the working size as a share of the view, 0.0625 to 1. Default 0.5. */
  resolutionScale?: number;
  /** 0 to 1: how much of the blurred frame replaces the sharp one. 0 passes the frame through. Default 1. */
  strength?: number;
  /** False passes frames through. Default true. */
  enabled?: boolean;
}

const SLOT = 256,
  SLOTS = 40,
  // Texture indices per view: 8 dual levels, or 4 halvings and the Kawase pair.
  STRIDE = 8;

const header = `${fullscreen}
struct P {map:vec4f,low:vec4f,high:vec4f,offset:vec2f,strength:f32,pad:f32}
@group(0) @binding(0) var<uniform> u:P;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;
fn tap(q:vec2f)->vec4f{return textureSampleLevel(source,bilinear,clamp(q,u.low.xy,u.high.xy),0.0);}`;
const main = (body: string) => `
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let uv=u.map.xy+at.xy*u.map.zw;let o=u.offset;
 ${body}
}`;
const DOWN = `${header}${main(`return (tap(uv)*4.0+tap(uv-o)+tap(uv+o)+tap(uv+vec2f(o.x,-o.y))+tap(uv-vec2f(o.x,-o.y)))/8.0;`)}`;
const spread = `fn up(uv:vec2f,o:vec2f)->vec4f{
 let corners=tap(uv+vec2f(-o.x,o.y))+tap(uv+o)+tap(uv+vec2f(o.x,-o.y))+tap(uv-o);
 let sides=tap(uv+vec2f(-2.0*o.x,0.0))+tap(uv+vec2f(0.0,2.0*o.y))+tap(uv+vec2f(2.0*o.x,0.0))+tap(uv+vec2f(0.0,-2.0*o.y));
 return (sides+corners*2.0)/12.0;
}`;
const UP = `${header}${spread}${main(`return up(uv,o);`)}`;
const KAWASE = `${header}${main(`return (tap(uv+vec2f(-o.x,-o.y))+tap(uv+vec2f(o.x,-o.y))+tap(uv+vec2f(-o.x,o.y))+tap(uv+o))*0.25;`)}`;
const composite = (dual: boolean, display: boolean) => `${header}${display ? displayShader : ''}${spread}
@group(0) @binding(3) var original:texture_2d<f32>;
${main(`let sharp=textureLoad(original,vec2i(at.xy),0);
 let out=mix(sharp,${dual ? 'up(uv,o)' : 'tap(uv)'},u.strength);
 ${display ? 'return vec4f(toDisplay(out.rgb),out.a);' : 'return out;'}`)}`;

const within = (v: unknown, min: number, max: number) => typeof v === 'number' && v >= min && v <= max;

/**
 * Dual-filter or Kawase blur: wide blurs at a fraction of the cost of a large Gaussian, for frosted glass, depth haze
 * and soft backgrounds. An HDR `PostStack` effect; {@link KawaseBlur.texture} holds the small blurred image.
 * @throws TypeError when `enabled` is not a boolean; RangeError for a `method`, `size` or number out of range (checked
 * now and every frame); MargoError `'state'` outside a PostStack, `'unsupported'` without a GPU backend, `'disposed'`
 * after `dispose()`, `'attached'` when joined twice.
 */
export class KawaseBlur extends ScreenEffect {
  readonly name = 'kawase-blur';
  protected readonly kind = 'hdr';
  private readonly values = new Float32Array((SLOTS * SLOT) / 4);
  private sampler?: GPUSampler;
  private result?: GPUTexture;
  // The pyramid, one index range a view, and the pass objects, kept by shader and by pass.
  private readonly chain = new Map<number, { texture: GPUTexture; view: GPUTextureView }>();
  private readonly compiled = new Map<string, GPURenderPipeline>();
  private readonly bound = new Map<string, { source: GPUTextureView; input?: GPUTextureView; group: GPUBindGroup }>();
  constructor(readonly options: KawaseBlurOptions = {}) {
    super();
    this.uniformBytes = SLOTS * SLOT;
    this.check();
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: KawaseBlurOptions = {}): KawaseBlur {
    const effect = new KawaseBlur(options);
    effect.stack = PostStack.attach(engine, [effect]);
    return effect;
  }
  /** The blurred image of the last frame drawn (rgba16float, linear, reduced size: half the view with `'dual'`,
   * `resolutionScale` with `'kawase'`), for materials and passes of your own. Replaced on resize and device restore;
   * undefined before the first blurred frame. */
  get texture(): GPUTexture | undefined {
    return this.result;
  }
  protected check(): void {
    const o = this.options,
      offsets = o.offsets;
    if (o.enabled !== undefined && typeof o.enabled !== 'boolean')
      throw typeError('Use KawaseBlur enabled as true or false', 'arguments');
    const fail = (message: string): never => {
      throw rangeError(`Use KawaseBlur ${message}`, 'arguments');
    };
    if (o.method !== undefined && o.method !== 'dual' && o.method !== 'kawase') fail("method 'dual' or 'kawase'");
    if (o.levels !== undefined && !(Number.isInteger(o.levels) && within(o.levels, 1, 8)))
      fail('levels as a whole number from 1 to 8');
    if (o.size !== undefined && !Object.hasOwn(KAWASE_KERNELS, o.size))
      fail(`size as one of ${Object.keys(KAWASE_KERNELS).join(', ')}`);
    if (
      offsets !== undefined &&
      !(Array.isArray(offsets) && within(offsets.length, 1, 32) && offsets.every((v) => within(v, 0, 64)))
    )
      fail('offsets as 1 to 32 numbers from 0 to 64');
    if (o.scale !== undefined && !within(o.scale, 0, 8)) fail('scale from 0 to 8');
    if (o.resolutionScale !== undefined && !within(o.resolutionScale, 0.0625, 1))
      fail('resolutionScale from 0.0625 to 1');
    if (o.strength !== undefined && !within(o.strength, 0, 1)) fail('strength from 0 to 1');
  }
  protected frame(c: ScreenContext, input: GPUTextureView, output: StageOutput): void {
    const o = this.options,
      strength = o.enabled === false ? 0 : (o.strength ?? 1);
    this.sampler ??= c.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const dual = (o.method ?? 'dual') === 'dual',
      scale = o.scale ?? 1,
      [width, height] = viewSize(c),
      rect = viewRect(c) ?? [0, 0, c.width, c.height],
      view = c.view?.index ?? 0,
      // The view inside the full-size input: the first pass reads it, and no tap leaves it.
      full: Region = [rect[0] / c.width, rect[1] / c.height, rect[2] / c.width, rect[3] / c.height],
      whole: Region = [0, 0, 1, 1],
      passes: Pass[] = [];
    let source: Source = { view: input, width: c.width, height: c.height, region: full };
    const add = (index: number, w: number, h: number, code: string, offset: (s: Source) => [number, number]) => {
      const slot = passes.length,
        key = view * STRIDE * 2 + index,
        target = this.level(c.device, key, w, h),
        [x, y, rw, rh] = source.region;
      this.write(slot, [x, y, rw / w, rh / h], source, offset(source), 0);
      passes.push({ slot, key, code, target, source: source.view });
      source = { view: target, width: w, height: h, region: whole };
    };
    const size = (factor: number): [number, number] => [
      Math.max(1, Math.round(width * factor)),
      Math.max(1, Math.round(height * factor)),
    ];
    if (strength && dual) {
      const sizes: [number, number][] = [];
      for (let i = 0; i < (o.levels ?? 3); i++) sizes.push(size(0.5 ** (i + 1)));
      sizes.forEach(([w, h], i) => add(i, w, h, DOWN, halving(w, h, scale)));
      for (let i = sizes.length - 2; i >= 0; i--)
        add(i, ...sizes[i], UP, (s) => [(0.5 / s.width) * scale, (0.5 / s.height) * scale]);
    } else if (strength) {
      const ratio = o.resolutionScale ?? 0.5,
        [w, h] = size(ratio);
      // Dual halvings down to twice the working size or less, so a small working size skips no texel.
      let i = 0;
      for (let f = 0.5; f > ratio * 1.0001; f /= 2, i++) {
        const [lw, lh] = size(f);
        add(i, lw, lh, DOWN, halving(lw, lh, 1));
      }
      if (ratio < 1) add(i, w, h, DOWN, halving(w, h, 1));
      (o.offsets ?? KAWASE_KERNELS[o.size ?? 'medium']).forEach((k, pass) =>
        add(STRIDE + (pass & 1), w, h, KAWASE, (s) => {
          const texels = (k + 0.5) * scale;
          return [texels / s.width, texels / s.height];
        }),
      );
    }
    // The last pass: mixes the blurred image over the input, into the stack's output (at strength 0, no blur).
    const last = passes.length,
      low = source,
      map = [-rect[0] / rect[2], -rect[1] / rect[3], 1 / rect[2], 1 / rect[3]];
    this.write(last, map, low, [(0.5 / low.width) * scale, (0.5 / low.height) * scale], strength);
    c.device.queue.writeBuffer(this.uniform!, 0, this.values, 0, ((last + 1) * SLOT) / 4);
    for (const p of passes) this.pass(c, p.code, p.target, p.slot, p.source);
    const code = displayFor(this.engine, composite(dual && !!strength, !output.hdr));
    this.pass(c, code, output.view, last, low.view, input, output);
    if (strength) this.result = this.chain.get(passes[last - 1].key)!.texture;
  }
  /** The pyramid texture `key` at the given size, made again when the size changes. */
  private level(device: GPUDevice, key: number, width: number, height: number): GPUTextureView {
    let held = this.chain.get(key);
    if (held?.texture.width !== width || held.texture.height !== height) {
      held?.texture.destroy();
      const texture = device.createTexture({ size: [width, height], format: 'rgba16float', usage: 0x10 | 0x4 });
      this.chain.set(key, (held = { texture, view: texture.createView() }));
    }
    return held.view;
  }
  /** One full-screen pass with the uniform slice `slot`: over a whole pyramid texture, or into the stage's `output`
   * (which reads `input` too and draws in the view's rectangle). */
  private pass(
    c: ScreenContext,
    code: string,
    target: GPUTextureView,
    slot: number,
    source: GPUTextureView,
    input?: GPUTextureView,
    output?: StageOutput,
  ): void {
    const format = output?.format ?? 'rgba16float',
      multisample = output?.multisample ?? ONE,
      key = `${format}:${multisample.count}:${code}`;
    let pipeline = this.compiled.get(key);
    if (!pipeline) this.compiled.set(key, (pipeline = render(c.device, code, format, { multisample })));
    const name = `${c.view?.index ?? 0}:${slot}:${key}`;
    let held = this.bound.get(name);
    if (!held || held.source !== source || held.input !== input) {
      const resources: GPUBindingResource[] = [
        { buffer: this.uniform!, offset: slot * SLOT, size: 64 },
        source,
        this.sampler!,
      ];
      if (input) resources.push(input);
      this.bound.set(name, (held = { source, input, group: group(c.device, pipeline, resources) }));
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: target, loadOp: output ? viewLoadOp(c, 'clear') : 'clear', storeOp: 'store' }],
    });
    try {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, held.group);
      if (output) applyView(pass, c);
      pass.draw(3);
    } finally {
      pass.end();
    }
  }
  /** One pass's uniform: the pixel to source map, the source's clamp rectangle, the tap offset and the strength. */
  private write(slot: number, map: readonly number[], source: Source, offset: readonly number[], strength: number) {
    const v = this.values,
      at = (slot * SLOT) / 4,
      [x, y, w, h] = source.region,
      [hx, hy] = [0.5 / source.width, 0.5 / source.height];
    v.set(map, at);
    v.set([x + hx, y + hy, 0, 0], at + 4);
    v.set([x + w - hx, y + h - hy, 0, 0], at + 8);
    v.set([offset[0], offset[1], strength, 0], at + 12);
  }
  protected override release(): void {
    super.release();
    for (const held of this.chain.values()) held.texture.destroy();
    this.chain.clear();
    this.compiled.clear();
    this.bound.clear();
    this.sampler = this.result = undefined;
  }
}
const ONE: GPUMultisampleState = { count: 1 };
/** The halving's tap offset: half a destination pixel, in the source's texture coordinates. */
const halving =
  (width: number, height: number, scale: number) =>
  (s: Source): [number, number] => [(0.5 / width) * s.region[2] * scale, (0.5 / height) * s.region[3] * scale];
type Region = [number, number, number, number];
interface Source {
  view: GPUTextureView;
  width: number;
  height: number;
  /** The part of the texture that holds the view, [x, y, width, height] in texture coordinates. */
  region: Region;
}
interface Pass {
  slot: number;
  key: number;
  code: string;
  target: GPUTextureView;
  source: GPUTextureView;
}
