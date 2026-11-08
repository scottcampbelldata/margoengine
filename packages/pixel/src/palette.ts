/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import { hexColor } from '@margoengine/math';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { FRAGMENT: number };

/** A palette colour: `#rrggbb` or `[r, g, b]` bytes. */
export type PaletteColor = string | readonly [number, number, number];
/** How close two colours are: in Oklab, which follows what the eye sees, or plain sRGB values. */
export type PaletteDistance = 'oklab' | 'srgb';
/** The pattern that nudges colours before matching. `'none'` matches each colour as it is. */
export type PaletteDither = 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'blue-noise';

const invalid = () => rangeError('Invalid palette value', 'pixel-palette');

/** A palette as sRGB values from 0 to 1, `[r, g, b]` per colour. */
export type PaletteRGB = readonly (readonly [number, number, number])[];

/** Reads palette colours to sRGB values from 0 to 1. @throws RangeError for an empty, oversized or unreadable palette. */
export function readPalette(colors: readonly PaletteColor[]): [number, number, number][] {
  if (!Array.isArray(colors) || !colors.length || colors.length > 256)
    throw rangeError('A palette holds 1 to 256 colours', 'pixel-palette');
  return colors.map((color) => {
    const rgb =
      typeof color === 'string'
        ? hexColor(color)?.slice(0, 3)
        : Array.isArray(color) && color.length === 3 && color.every((v) => v >= 0 && v <= 255)
          ? color.map((v) => v / 255)
          : undefined;
    if (!rgb) throw rangeError('Invalid palette colour', 'pixel-palette');
    return rgb as [number, number, number];
  });
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toEncoded = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB values from 0 to 1 to Oklab `[L, a, b]`. */
export function oklabFromSRGB(r: number, g: number, b: number): [number, number, number] {
  const lr = toLinear(r),
    lg = toLinear(g),
    lb = toLinear(b),
    l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb),
    m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb),
    s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Oklab `[L, a, b]` to sRGB values, clamped to 0 to 1. */
export function sRGBFromOklab(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3,
    out = (v: number) => Math.min(1, Math.max(0, toEncoded(Math.max(0, v))));
  return [
    out(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    out(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    out(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

const hex = (rgb: readonly number[]) =>
  `#${rgb
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Turns each colour's hue by `degrees` in Oklab, keeping its lightness and chroma as far as sRGB can. Returns `#rrggbb`. */
export function shiftPaletteHue(colors: readonly PaletteColor[], degrees: number): string[] {
  if (!Number.isFinite(degrees)) throw invalid();
  const cos = Math.cos((degrees * Math.PI) / 180),
    sin = Math.sin((degrees * Math.PI) / 180);
  return readPalette(colors).map(([r, g, b]) => {
    const [L, a, c] = oklabFromSRGB(r, g, b);
    return hex(sRGBFromOklab(L, a * cos - c * sin, a * sin + c * cos));
  });
}

/** `steps` colours from `from` to `to`, evenly spaced in Oklab, ends included. Returns `#rrggbb`. */
export function paletteRamp(from: PaletteColor, to: PaletteColor, steps: number): string[] {
  if (!Number.isInteger(steps) || steps < 2) throw invalid();
  const [start, end] = readPalette([from, to]).map(([r, g, b]) => oklabFromSRGB(r, g, b));
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return hex(sRGBFromOklab(...(start.map((v, k) => v + (end[k] - v) * t) as [number, number, number])));
  });
}

/** A run of palette entries that cycles: {@link cyclePalette}. */
export interface PaletteCycle {
  /** First index of the run. */
  from: number;
  /** Last index of the run, included; above `from`. */
  to: number;
  /** Entries a second the colours move toward `to`; below 0 toward `from`. */
  rate: number;
  /** Mixes each step in Oklab instead of jumping a whole entry at a time. Default false. */
  blend?: boolean;
}

/**
 * The palette at time `seconds` with each run's colours rotated along it, for water, fire and conveyor belts drawn in
 * a few palette entries: entry `from + i` shows the colour that started at `from + (i - rate * seconds)`, wrapping
 * inside the run. Entries outside every run stay. Feed it to {@link PaletteQuantize.setSwap} each frame. Returns
 * `#rrggbb`.
 */
export function cyclePalette(
  colors: readonly PaletteColor[],
  cycles: readonly PaletteCycle[],
  seconds: number,
): string[] {
  const rgb = readPalette(colors),
    out = rgb.map((c) => hex(c));
  if (!Number.isFinite(seconds)) throw rangeError('cyclePalette seconds must be a finite number', 'pixel-palette');
  const owner = new Int32Array(rgb.length).fill(-1);
  cycles.forEach((cycle, k) => {
    const { from, to, rate } = cycle;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= rgb.length || to <= from)
      throw rangeError(
        `A palette cycle needs whole from < to inside the palette, got ${from} to ${to}`,
        'pixel-palette',
      );
    if (!Number.isFinite(rate)) throw rangeError('A palette cycle rate must be a finite number', 'pixel-palette');
    for (let i = from; i <= to; i++) {
      if (owner[i] >= 0)
        throw rangeError(`Palette cycles ${owner[i]} and ${k} must not share entry ${i}`, 'pixel-palette');
      owner[i] = k;
    }
    const length = to - from + 1,
      shift = rate * seconds,
      whole = Math.floor(shift),
      part = cycle.blend ? shift - whole : 0,
      wrap = (i: number) => from + (((i % length) + length) % length);
    for (let i = 0; i < length; i++) {
      const a = rgb[wrap(i - whole)];
      if (!part) {
        out[from + i] = hex(a);
        continue;
      }
      const b = rgb[wrap(i - whole - 1)],
        la = oklabFromSRGB(...a),
        lb = oklabFromSRGB(...b);
      out[from + i] = hex(sRGBFromOklab(...(la.map((v, c) => v + (lb[c] - v) * part) as [number, number, number])));
    }
  });
  return out;
}

/**
 * Each entry mixed from `a` toward `b` by `t` (0 gives `a`, 1 gives `b`) in Oklab, for day and night or seasons: two
 * palettes of the same length, one index meaning the same thing in both. Returns `#rrggbb`.
 */
export function mixPalettes(a: readonly PaletteColor[], b: readonly PaletteColor[], t: number): string[] {
  const from = readPalette(a),
    to = readPalette(b);
  if (from.length !== to.length) throw rangeError('mixPalettes needs two palettes of the same length', 'pixel-palette');
  if (!(t >= 0 && t <= 1)) throw rangeError(`mixPalettes t must be between 0 and 1, got ${t}`, 'pixel-palette');
  return from.map((c, i) => {
    const p = oklabFromSRGB(...c),
      q = oklabFromSRGB(...to[i]);
    return hex(sRGBFromOklab(...(p.map((v, k) => v + (q[k] - v) * t) as [number, number, number])));
  });
}

/**
 * The ordered dither matrix of side `size` (2, 4 or 8), row by row: each value `(rank + 0.5) / size^2`, so every value is
 * above 0 and below 1. @throws RangeError for another size.
 */
export function bayerMatrix(size: 2 | 4 | 8): Float32Array {
  if (![2, 4, 8].includes(size)) throw invalid();
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let rank = 0;
      for (let bit = 1; bit < size; bit <<= 1) rank = rank * 4 + ((x & bit ? 2 : 0) ^ (y & bit ? 3 : 0));
      out[y * size + x] = (rank + 0.5) / (size * size);
    }
  return out;
}

/**
 * A tiling blue-noise threshold matrix of side `size`, by the void-and-cluster method: a seeded pattern settles until its
 * tightest cluster is also its largest void, then pixels are ranked by removing clusters and filling voids. Same size and
 * seed, same matrix. Each value is `(rank + 0.5) / size^2`.
 */
export function blueNoise(size = 64, seed = 1): Float32Array {
  if (!Number.isInteger(size) || size < 4 || size > 256) throw invalid();
  const count = size * size,
    kernel = new Float64Array(count),
    energy = new Float64Array(count),
    on = new Uint8Array(count),
    ranks = new Float32Array(count);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = Math.min(x, size - x),
        dy = Math.min(y, size - y);
      kernel[y * size + x] = Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5));
    }
  const toggle = (at: number, value: 1 | 0) => {
      on[at] = value;
      const sign = value ? 1 : -1,
        ax = at % size,
        ay = (at - ax) / size;
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++)
          energy[y * size + x] += sign * kernel[((y - ay + size) % size) * size + ((x - ax + size) % size)];
    },
    /** The tightest set pixel, or the emptiest unset one. Ties go to the lowest index. */
    extreme = (set: 0 | 1) => {
      let best = -1;
      for (let i = 0; i < count; i++)
        if (on[i] === set && (best < 0 || (set ? energy[i] > energy[best] : energy[i] < energy[best]))) best = i;
      return best;
    };
  let state = (Math.floor(seed) ^ 0x9e3779b9) >>> 0 || 1,
    ones = 0;
  while (ones < count >> 3) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    const at = state % count;
    if (!on[at]) {
      toggle(at, 1);
      ones++;
    }
  }
  for (let step = 0; step < count; step++) {
    const cluster = extreme(1);
    toggle(cluster, 0);
    const hole = extreme(0);
    toggle(hole, 1);
    if (hole === cluster) break;
  }
  const prototype = on.slice(),
    protoEnergy = energy.slice();
  for (let rank = ones - 1; rank >= 0; rank--) {
    const at = extreme(1);
    ranks[at] = rank;
    toggle(at, 0);
  }
  on.set(prototype);
  energy.set(protoEnergy);
  for (let rank = ones; rank < count; rank++) {
    const at = extreme(0);
    ranks[at] = rank;
    toggle(at, 1);
  }
  for (let i = 0; i < count; i++) ranks[i] = (ranks[i] + 0.5) / count;
  return ranks;
}

const SIDES: Record<string, number> = { none: 0, bayer2: 2, bayer4: 4, bayer8: 8, 'blue-noise': 64 };

/** The threshold matrix of a dither mode and its side, or undefined for `'none'`. @throws RangeError for another mode. */
export function ditherMatrix(mode: PaletteDither): { size: number; values: Float32Array } | undefined {
  const size = SIDES[mode];
  if (!(size >= 0)) throw invalid();
  return size ? { size, values: size > 8 ? blueNoise() : bayerMatrix(size as 2 | 4 | 8) } : undefined;
}

/**
 * Which palette entry a colour (sRGB values from 0 to 1) matches: the CPU form of the pass, for tools and tests. `palette`
 * is what {@link readPalette} returns; `threshold` is the pattern's value at this pixel, if any.
 */
export function nearestPaletteIndex(
  r: number,
  g: number,
  b: number,
  palette: PaletteRGB,
  distance: PaletteDistance = 'oklab',
  threshold?: number,
  spread = 0.125,
): number {
  const shift = threshold === undefined ? 0 : spread * (threshold - 0.5),
    at = (v: number) => Math.min(1, Math.max(0, v + shift)),
    coord = (cr: number, cg: number, cb: number) => (distance === 'oklab' ? oklabFromSRGB(cr, cg, cb) : [cr, cg, cb]),
    c = coord(at(r), at(g), at(b));
  let best = 0,
    least = Infinity;
  palette.forEach((p, i) => {
    const q = coord(p[0], p[1], p[2]),
      e = (c[0] - q[0]) ** 2 + (c[1] - q[1]) ** 2 + (c[2] - q[2]) ** 2;
    if (e < least) {
      least = e;
      best = i;
    }
  });
  return best;
}

const shader = /* wgsl */ `
struct S{n:u32,side:u32,lab:u32,straight:u32,spread:f32}
@group(0) @binding(0) var<uniform> s:S;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var near:texture_2d<f32>;
@group(0) @binding(3) var shown:texture_2d<f32>;
@group(0) @binding(4) var noise:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
fn lin(v:f32)->f32{
if(v<=0.04045){return v/12.92;}
return pow((v+0.055)/1.055,2.4);
}
fn oklab(c:vec3f)->vec3f{
let r=lin(c.r);
let g=lin(c.g);
let b=lin(c.b);
let l=pow(0.4122214708*r+0.5363325363*g+0.0514459929*b,1.0/3.0);
let m=pow(0.2119034982*r+0.6806995451*g+0.1073969566*b,1.0/3.0);
let k=pow(0.0883024619*r+0.2817188376*g+0.6299787005*b,1.0/3.0);
return vec3f(0.2104542553*l+0.793617785*m-0.0040720468*k,1.9779984951*l-2.428592205*m+0.4505937099*k,0.0259040371*l+0.7827717662*m-0.808675766*k);
}
@fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f{
let t=vec2i(p.xy);
if(any(t>=vec2i(textureDimensions(image)))){return vec4f(0);}
let a=textureLoad(image,t,0);
if(a.a==0){return vec4f(0);}
var c=a.rgb;
if(s.straight==0u){c/=a.a;}
if(s.side>0u){c+=s.spread*(textureLoad(noise,vec2u(t)%s.side,0).r-0.5);}
c=clamp(c,vec3f(0),vec3f(1));
if(s.lab==1u){c=oklab(c);}
var best=0u;
var least=1e30;
for(var i=0u;i<s.n;i++){
let d=c-textureLoad(near,vec2u(i,0u),0).rgb;
let e=dot(d,d);
if(e<least){least=e;best=i;}
}
let o=textureLoad(shown,vec2u(best,0u),0).rgb;
if(s.straight==1u){return vec4f(o,a.a);}
return vec4f(o*a.a,a.a);
}`;

const SETTINGS_BYTES = 32;

/** Settings of {@link PaletteQuantize}. */
export interface PaletteQuantizeOptions {
  /** The colours to reduce to, 1 to 256. Required. */
  palette: readonly PaletteColor[];
  /** What each match draws instead of its palette colour: palette swap, same length. Default the palette itself. */
  swap?: readonly PaletteColor[];
  /** The picture to read, one sample per pixel, or a function returning it such as a pixel layer's `target`. Required. */
  source: GPUTexture | (() => GPUTexture);
  /** Where the result goes, as large as `source` or larger; pixels past `source` clear. It must be another texture. Required. */
  target: GPUTexture | (() => GPUTexture);
  /** Default `'oklab'`. */
  distance?: PaletteDistance;
  /** Read each frame. Default `'none'`. */
  dither?: PaletteDither;
  /** How far the pattern moves a colour, in sRGB values, read each frame. Default 0.125. */
  spread?: number;
  /** Colours in `source` are multiplied by alpha, as in a pixel layer, and stay so in `target`. Default true. */
  premultiplied?: boolean;
  /** Frame-graph order. Runs after the sprites and maps (10), before a compositor (30). Default 20. */
  order?: number;
  /** Plugin name, unique per scene. Default `palette-1`, `palette-2`, ... */
  name?: string;
}

let passCount = 0;

/**
 * Reduces a low-res picture to a palette, with optional ordered or blue-noise dithering and palette swap: one frame-graph
 * pass from `source` to `target`, once a frame. Each pixel becomes exactly one palette colour (alpha kept). WebGPU only.
 * @throws TypeError / RangeError on invalid options or, each frame, an invalid field.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` after `dispose()`, `'state'` when the source and the
 * target are the same texture.
 */
export class PaletteQuantize implements EnginePlugin {
  readonly name: string;
  /** The pattern, read each frame. */
  dither: PaletteDither;
  /** How far the pattern moves a colour, read each frame. */
  spread: number;
  readonly #source: GPUTexture | (() => GPUTexture);
  readonly #target: GPUTexture | (() => GPUTexture);
  readonly #order: number;
  readonly #distance: PaletteDistance;
  readonly #straight: boolean;
  #colors!: [number, number, number][];
  #shown!: [number, number, number][];
  #engine?: Engine;
  #device?: GPUDevice;
  #module?: GPUShaderModule;
  #pipeline?: GPURenderPipeline;
  #format?: GPUTextureFormat;
  #uniform?: GPUBuffer;
  #matchTexture?: GPUTexture;
  #shownTexture?: GPUTexture;
  readonly #patterns = new Map<PaletteDither, GPUTexture>();
  #group?: GPUBindGroup;
  #groupFor?: GPUTexture;
  #groupDither?: PaletteDither;
  readonly #values = new ArrayBuffer(SETTINGS_BYTES);
  #disposed = false;

  constructor(options: PaletteQuantizeOptions) {
    if (!options?.palette || !options.source || !options.target)
      throw typeError('PaletteQuantize needs a palette, a source and a target', 'pixel-palette');
    const order = options.order ?? 20;
    if (!Number.isFinite(order)) throw invalid();
    this.#source = options.source;
    this.#target = options.target;
    this.#order = order;
    this.#distance = options.distance ?? 'oklab';
    if (this.#distance !== 'oklab' && this.#distance !== 'srgb') throw invalid();
    this.dither = options.dither ?? 'none';
    this.spread = options.spread ?? 0.125;
    this.#straight = options.premultiplied === false;
    this.name = options.name ?? `palette-${++passCount}`;
    this.setPalette(options.palette, options.swap);
  }
  /** Creates a pass and attaches it to `instance`. */
  static attach(instance: EngineKernel, options: PaletteQuantizeOptions): PaletteQuantize {
    const pass = new PaletteQuantize(options);
    engineRuntime(instance).use(pass);
    return pass;
  }
  /** Replaces the palette and the swap colours from the next frame. */
  setPalette(palette: readonly PaletteColor[], swap?: readonly PaletteColor[]): void {
    const colors = readPalette(palette),
      shown = swap ? readPalette(swap) : colors;
    if (shown.length !== colors.length)
      throw rangeError('A palette swap has as many colours as its palette', 'pixel-palette');
    this.#colors = colors;
    this.#shown = shown;
    this.#dropPalette();
  }
  /**
   * Replaces only the colours drawn for each match, from the next frame, writing them into the texture already made:
   * the matching stays, so it is cheap enough for every frame (palette cycling, day and night).
   */
  setSwap(swap: readonly PaletteColor[]): void {
    const shown = readPalette(swap);
    if (shown.length !== this.#colors.length)
      throw rangeError('A palette swap has as many colours as its palette', 'pixel-palette');
    this.#shown = shown;
    if (this.#shownTexture && this.#device) {
      const bytes = new Uint8Array(shown.length * 4);
      shown.forEach((c, i) => bytes.set([...c.map((v) => Math.round(v * 255)), 255], i * 4));
      this.#device.queue.writeTexture({ texture: this.#shownTexture }, bytes, { bytesPerRow: bytes.byteLength }, [
        shown.length,
        1,
      ]);
    }
  }
  setup(engine: Engine): void {
    if (this.#disposed) throw fault('disposed', 'PaletteQuantize disposed; create a new one');
    if (engine.backend !== 'webgpu') throw fault('unsupported', 'PaletteQuantize needs WebGPU', 'webgpu');
    this.#engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.#order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.#run(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.#release();
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#engine?.removePlugin(this.name);
    this.#engine = undefined;
    this.#release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  #dropPalette(): void {
    this.#matchTexture?.destroy();
    this.#shownTexture?.destroy();
    this.#matchTexture = this.#shownTexture = this.#group = this.#groupFor = undefined;
  }
  #release(): void {
    this.#dropPalette();
    for (const texture of this.#patterns.values()) texture.destroy();
    this.#patterns.clear();
    this.#uniform?.destroy();
    this.#uniform = this.#module = this.#device = this.#pipeline = this.#format = undefined;
  }
  #row(device: GPUDevice, format: GPUTextureFormat, data: ArrayBufferView<ArrayBuffer>, width: number, height = 1) {
    const texture = device.createTexture({
      size: [width, height],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, data, { bytesPerRow: data.byteLength / height }, [width, height]);
    return texture;
  }
  #pattern(device: GPUDevice, mode: PaletteDither): GPUTexture {
    let texture = this.#patterns.get(mode);
    if (!texture) {
      const matrix = ditherMatrix(mode);
      texture = matrix
        ? this.#row(device, 'r32float', matrix.values as Float32Array<ArrayBuffer>, matrix.size, matrix.size)
        : this.#row(device, 'r32float', new Float32Array(1), 1);
      this.#patterns.set(mode, texture);
    }
    return texture;
  }
  #prepare(device: GPUDevice): void {
    if (this.#device !== device) {
      if (this.#device) this.#release();
      this.#device = device;
    }
    if (!this.#module) {
      this.#module = device.createShaderModule({ label: 'pixel palette', code: shader });
      this.#uniform = device.createBuffer({
        label: 'pixel palette',
        size: SETTINGS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.#matchTexture) {
      const count = this.#colors.length,
        match = new Float32Array(count * 4),
        shown = new Uint8Array(count * 4);
      this.#colors.forEach(([r, g, b], i) => {
        match.set(this.#distance === 'oklab' ? oklabFromSRGB(r, g, b) : [r, g, b], i * 4);
        const out = this.#shown[i];
        shown.set([...out.map((v) => Math.round(v * 255)), 255], i * 4);
      });
      this.#matchTexture = this.#row(device, 'rgba32float', match, count);
      this.#shownTexture = this.#row(device, 'rgba8unorm', shown, count);
    }
  }
  #run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    // Source and target are textures of their own: one run a frame, however many views it has.
    if (c.view?.index) return;
    const device = c.device,
      mode = this.dither;
    if (!(this.spread >= 0)) throw invalid();
    this.#prepare(device);
    const pick = (texture: GPUTexture | (() => GPUTexture)) => (typeof texture === 'function' ? texture() : texture),
      source = pick(this.#source),
      target = pick(this.#target);
    if (source === target) throw fault('state', 'Palette source and target must differ', 'pixel-palette');
    const pattern = this.#pattern(device, mode);
    if (target.format !== this.#format) {
      this.#format = target.format;
      this.#pipeline = device.createRenderPipeline({
        label: 'pixel palette',
        layout: 'auto',
        vertex: { module: this.#module! },
        fragment: { module: this.#module!, targets: [{ format: target.format }] },
      });
      this.#group = undefined;
    }
    if (!this.#group || this.#groupFor !== source || this.#groupDither !== mode) {
      this.#group = device.createBindGroup({
        layout: this.#pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform! } },
          { binding: 1, resource: source.createView() },
          { binding: 2, resource: this.#matchTexture!.createView() },
          { binding: 3, resource: this.#shownTexture!.createView() },
          { binding: 4, resource: pattern.createView() },
        ],
      });
      this.#groupFor = source;
      this.#groupDither = mode;
    }
    const words = new Uint32Array(this.#values);
    words[0] = this.#colors.length;
    words[1] = mode === 'none' ? 0 : pattern.width;
    words[2] = this.#distance === 'oklab' ? 1 : 0;
    words[3] = this.#straight ? 1 : 0;
    new Float32Array(this.#values)[4] = this.spread;
    device.queue.writeBuffer(this.#uniform!, 0, this.#values);
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    pass.setPipeline(this.#pipeline!);
    pass.setBindGroup(0, this.#group!);
    pass.draw(3);
    pass.end();
  }
}
