// LUT1D: one curve a channel from a lookup table, composited by the overlay pass. Linear interpolation between the
// entries (J. Selan, "Using Lookup Tables to Accelerate Color Transformations", GPU Gems 2, 2005, ch. 24). The text
// form is the 1D table of Adobe's Cube LUT Specification 1.0 (2013): LUT_1D_SIZE, DOMAIN_MIN, DOMAIN_MAX, rows.
import type { EngineKernel } from '@margoengine/core';
import type { Engine } from '@margoengine/core/extension';
import { rangeError, typeError } from '../../shared/errors.js';
import { TextureOption } from '../../shared/texture-option.js';
import { OverlayEffect, type OverlayOptions } from './overlays.js';
import type { ScreenContext } from './screen-effect.js';

/** Largest {@link Lut1D} size, the Cube specification's. */
export const MAX_LUT1D_SIZE = 65536;
// Entries a texture row holds.
const ROW = 1024;

/** A one-dimensional LUT: each channel is looked up on its own. */
export interface Lut1D {
  /** 2 to 65536 entries, three numbers (red, green, blue output) each. */
  data: ArrayLike<number>;
  /** The input given the first entry, per channel. Default [0, 0, 0]. */
  domainMin?: ArrayLike<number>;
  /** The input given the last entry, per channel, each above its `domainMin`. Default [1, 1, 1]. */
  domainMax?: ArrayLike<number>;
}
/** What {@link LUT1D} reads: `.cube` text, a table, a texture of one entry a texel, or a function returning one. */
export type Lut1DSource = string | Lut1D | GPUTexture | (() => GPUTexture | undefined);
/** Options for {@link LUT1D}; all are read each frame. */
export interface LUT1DOptions extends OverlayOptions {
  /** The table, applied to display values. `.cube` text with `LUT_1D_SIZE`, a {@link Lut1D}, or a 2D texture of a
   * linear format read row by row, 2 to 65536 texels (N x 1 is usual), or `() => texture`. Strings and tables are read
   * when the object handed in changes: assign a new one rather than writing into it. */
  lut: Lut1DSource;
}

/**
 * Reads a 1D `.cube` file (`LUT_1D_SIZE` 2 to 65536). Text is capped at 8 Mi characters.
 * @throws TypeError when `text` is not a string or has a malformed header, row or row count; RangeError when it is over
 * the cap, the size is out of range, a number is not finite or a domain minimum is not below its maximum.
 */
export function parseCube1D(text: string): Required<Lut1D> & { data: Float32Array } {
  if (typeof text !== 'string') throw typeError('Pass parseCube1D the text of a .cube file', 'arguments');
  if (text.length > 8 * 1024 * 1024)
    throw rangeError('.cube text exceeds 8 Mi characters; use a smaller 1D table', 'arguments');
  const domainMin = [0, 0, 0],
    domainMax = [1, 1, 1];
  let data: Float32Array | undefined,
    count = 0;
  const bad = (line: string): never => {
    throw typeError(`Fix the .cube line ${JSON.stringify(line.slice(0, 60))}: not part of a 1D table`, 'arguments');
  };
  const triple = (tokens: string[], line: string) => {
    if (tokens.length !== 3) bad(line);
    return tokens.map((token) => {
      const value = Number(token);
      if (!Number.isFinite(Math.fround(value)))
        throw rangeError(`Use finite numbers in the .cube table, not ${JSON.stringify(token)}`, 'arguments');
      return value;
    });
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || /^TITLE\s/.test(line)) continue;
    const tokens = line.split(/\s+/),
      key = tokens[0];
    if (key === 'LUT_1D_SIZE') {
      const size = Number(tokens[1]);
      if (data || tokens.length !== 2) bad(line);
      checkSize(size);
      data = new Float32Array(size * 3);
    } else if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      if (count) bad(line);
      const into = key === 'DOMAIN_MIN' ? domainMin : domainMax;
      triple(tokens.slice(1), line).forEach((v, i) => (into[i] = v));
    } else {
      if (!data || count >= data.length) bad(line);
      data!.set(triple(tokens, line), count);
      count += 3;
    }
  }
  if (!data || count !== data.length)
    throw typeError('Supply LUT_1D_SIZE and that many RGB rows in the .cube text', 'arguments');
  checkDomain(domainMin, domainMax);
  return { data, domainMin, domainMax };
}
function checkSize(size: number): void {
  if (!(Number.isInteger(size) && size >= 2 && size <= MAX_LUT1D_SIZE))
    throw rangeError(`Use a 1D LUT of 2 to ${MAX_LUT1D_SIZE} entries`, 'arguments');
}
function checkDomain(min: ArrayLike<number>, max: ArrayLike<number>): void {
  for (const bound of [min, max])
    if (bound.length !== 3) throw rangeError('Use a 1D LUT domain of three numbers', 'arguments');
  for (let i = 0; i < 3; i++)
    if (!(Number.isFinite(min[i]) && Number.isFinite(max[i]) && max[i] > min[i]))
      throw rangeError('Use finite 1D LUT domains with each minimum below its maximum', 'arguments');
}
/** A table as RGBA texels with its domain. */
interface Table {
  size: number;
  texels: Float32Array<ArrayBuffer>;
  min: number[];
  max: number[];
}
function table(source: string | Lut1D): Table {
  const lut = typeof source === 'string' ? parseCube1D(source) : source,
    { data, domainMin = [0, 0, 0], domainMax = [1, 1, 1] } = lut;
  if (!data || typeof data.length !== 'number' || data.length % 3)
    throw typeError('Use LUT1D lut data as three numbers an entry', 'arguments');
  const size = data.length / 3;
  checkSize(size);
  checkDomain(domainMin, domainMax);
  const width = Math.min(size, ROW),
    texels = new Float32Array(width * Math.ceil(size / width) * 4);
  for (let i = 0; i < size; i++)
    for (let c = 0; c < 3; c++) {
      const value = Math.fround(data[i * 3 + c]);
      if (!Number.isFinite(value)) throw rangeError('Use finite numbers in the LUT1D lut data', 'arguments');
      texels[i * 4 + c] = value;
    }
  return { size, texels, min: Array.from(domainMin), max: Array.from(domainMax) };
}

const shader = (slot: number) => ({
  declare: `@group(0) @binding(${slot}) var table:texture_2d<f32>;
fn entry(i:i32)->vec3f{let w=i32(textureDimensions(table).x);return textureLoad(table,vec2i(i%w,i/w),0).rgb;}`,
  body: `fn layer(p:vec2f)->vec4f{
 let s=textureLoad(scene,vec2i(p),0);let c=clamp(s.rgb/max(s.a,1e-6),vec3f(0.0),vec3f(1.0));
 let n=i32(u[3].w);let t=clamp((c-u[3].rgb)*u[4].rgb,vec3f(0.0),vec3f(1.0))*f32(n-1);
 let i=min(vec3i(t),vec3i(n-2));let f=t-vec3f(i);
 let low=vec3f(entry(i.r).r,entry(i.g).g,entry(i.b).b);
 let high=vec3f(entry(i.r+1).r,entry(i.g+1).g,entry(i.b+1).b);
 return vec4f(mix(low,high,f),1.0);
}`,
});
// The table binds after the depth when a depth mask takes binding 2.
const PLAIN = shader(2),
  MASKED = shader(3);

const isTexture = (source: unknown): source is GPUTexture | (() => GPUTexture | undefined) =>
  typeof source === 'function' || (typeof source === 'object' && !!source && 'createView' in source);

/**
 * Maps each channel of the frame through a one-dimensional lookup table: film curves, gamma and tone corrections and
 * duotone-like channel remaps, from a 1D `.cube` file, an array or a texture. An LDR `PostStack` effect.
 * @throws TypeError for a `lut` that is not a table, text or texture; RangeError for a table, domain or overlay option
 * out of range (checked now and every frame); MargoError `'state'` outside a PostStack, `'unsupported'` without a GPU
 * backend, `'disposed'` after `dispose()`, `'attached'` when joined twice.
 */
export class LUT1D extends OverlayEffect<LUT1DOptions> {
  readonly name = 'lut1d';
  private parsed?: { source: string | Lut1D; table: Table };
  private owned?: { table: Table; texture: GPUTexture };
  private blank?: GPUTexture;
  /** A GPUTexture or function `lut`, held by the borrowed-object rule (docs/conventions.md). */
  private held?: TextureOption;
  constructor(options: LUT1DOptions) {
    super(options);
    this.check();
    if (isTexture(options.lut)) this.hold(options.lut, undefined);
  }
  /** Runs alone in an owned PostStack. */
  static attach(engine: EngineKernel, options: LUT1DOptions): LUT1D {
    return OverlayEffect.alone(engine, new LUT1D(options));
  }
  /** Replaces `options.lut` from the next frame. A plain texture belongs to the device it was given on: call this from
   * `onDeviceRestored` with a texture of the new device. A refused value changes nothing. */
  setLUT(lut: Lut1DSource): this {
    if (!isTexture(lut)) this.read(lut);
    else this.hold(lut, this.engine?.gpu);
    this.options.lut = lut;
    return this;
  }
  override setup(engine: Engine): void {
    super.setup(engine);
    this.held?.fix(engine.gpu);
  }
  private hold(source: GPUTexture | (() => GPUTexture | undefined), device: GPUDevice | null | undefined): void {
    if (this.held) this.held.set(source as GPUTexture, device);
    else {
      this.held = new TextureOption(source as GPUTexture, 'LUT1D lut', 'setLUT');
      this.held.fix(device);
    }
  }
  private read(source: string | Lut1D): Table {
    if (this.parsed?.source !== source) {
      if (typeof source !== 'string' && (typeof source !== 'object' || !source))
        throw typeError('Use LUT1D lut as .cube text, { data }, a GPUTexture or () => texture', 'arguments');
      this.parsed = { source, table: table(source) };
    }
    return this.parsed.table;
  }
  protected override check(): void {
    super.check();
    const lut = this.options?.lut;
    if (!isTexture(lut)) this.read(lut);
  }
  protected source() {
    return this.options.mask === 'depth' ? MASKED : PLAIN;
  }
  protected override idle(c: ScreenContext): GPUBindingResource[] {
    this.blank ??= c.device.createTexture({ size: [2, 1], format: 'rgba32float', usage: 0x4 | 0x2 });
    return [this.view(this.blank)];
  }
  protected params(c: ScreenContext, v: Float32Array): GPUBindingResource[] | null {
    const lut = this.options.lut;
    let texture: GPUTexture | undefined,
      size: number,
      min = [0, 0, 0],
      max = [1, 1, 1];
    if (isTexture(lut)) {
      // The options object is read every frame: a `lut` assigned straight onto it is taken like `setLUT`.
      if (this.held?.value !== lut) this.hold(lut, c.device);
      texture = this.held!.get(c.device, this.engine);
      if (!texture) return null;
      if (texture.format.endsWith('-srgb'))
        throw typeError('Use a LUT1D texture of a linear format, such as rgba8unorm, not an -srgb one', 'arguments');
      size = texture.width * texture.height;
      checkSize(size);
    } else {
      const read = this.read(lut);
      if (this.owned?.table !== read) {
        this.owned?.texture.destroy();
        const width = Math.min(read.size, ROW),
          extent = [width, read.texels.length / 4 / width],
          made = c.device.createTexture({ size: extent, format: 'rgba32float', usage: 0x4 | 0x2 });
        c.device.queue.writeTexture({ texture: made }, read.texels, { bytesPerRow: width * 16 }, extent);
        this.owned = { table: read, texture: made };
      }
      texture = this.owned.texture;
      ({ size, min, max } = read);
    }
    v.set([min[0], min[1], min[2], size, 1 / (max[0] - min[0]), 1 / (max[1] - min[1]), 1 / (max[2] - min[2])]);
    return [this.view(texture)];
  }
  protected override release(): void {
    super.release();
    this.owned?.texture.destroy();
    this.blank?.destroy();
    this.owned = this.blank = undefined;
  }
}
