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

const hex = ([r, g, b]: readonly number[]) =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Turns each colour's hue by `degrees` in Oklab, keeping its lightness and chroma as far as sRGB can. Returns `#rrggbb`. */
export function shiftPaletteHue(colors: readonly PaletteColor[], degrees: number): string[] {
  if (!Number.isFinite(degrees)) throw rangeError('Invalid palette value', 'pixel-palette');
  const cos = Math.cos((degrees * Math.PI) / 180),
    sin = Math.sin((degrees * Math.PI) / 180);
  return readPalette(colors).map(([r, g, b]) => {
    const [L, a, c] = oklabFromSRGB(r, g, b);
    return hex(sRGBFromOklab(L, a * cos - c * sin, a * sin + c * cos));
  });
}

/** `steps` colours from `from` to `to`, evenly spaced in Oklab, ends included. Returns `#rrggbb`. */
export function paletteRamp(from: PaletteColor, to: PaletteColor, steps: number): string[] {
  if (!Number.isInteger(steps) || steps < 2) throw rangeError('Invalid palette value', 'pixel-palette');
  const [start, end] = readPalette([from, to]).map(([r, g, b]) => oklabFromSRGB(r, g, b));
  return Array.from({ length: steps }, (_, i) => {
    const t = i / (steps - 1);
    return hex(sRGBFromOklab(...(start.map((v, k) => v + (end[k] - v) * t) as [number, number, number])));
  });
}

/**
 * The ordered dither matrix of side `size` (2, 4 or 8), row by row: each value `(rank + 0.5) / size^2`, so every value is
 * above 0 and below 1. @throws RangeError for another size.
 */
export function bayerMatrix(size: 2 | 4 | 8): Float32Array {
  if (size !== 2 && size !== 4 && size !== 8) throw rangeError('Invalid palette value', 'pixel-palette');
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
  if (!Number.isInteger(size) || size < 4 || size > 256) throw rangeError('Invalid palette value', 'pixel-palette');
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

/** The threshold matrix of a dither mode and its side, or undefined for `'none'`. */
export function ditherMatrix(mode: PaletteDither): { size: number; values: Float32Array } | undefined {
  if (mode === 'none') return undefined;
  if (mode === 'blue-noise') return { size: 64, values: blueNoise() };
  const size = Number(mode.slice(5)) as 2 | 4 | 8;
  return { size, values: bayerMatrix(size) };
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
struct Settings{count:u32,side:u32,oklab:u32,straight:u32,spread:f32}
@group(0) @binding(0) var<uniform> settings:Settings;
@group(0) @binding(1) var image:texture_2d<f32>;
@group(0) @binding(2) var candidates:texture_2d<f32>;
@group(0) @binding(3) var shown:texture_2d<f32>;
@group(0) @binding(4) var pattern:texture_2d<f32>;
@vertex fn vertexMain(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
  return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);
}
fn linear(v:f32)->f32{
  if(v<=0.04045){return v/12.92;}
  return pow((v+0.055)/1.055,2.4);
}
fn oklab(c:vec3f)->vec3f{
  let r=linear(c.r);
  let g=linear(c.g);
  let b=linear(c.b);
  let l=pow(0.4122214708*r+0.5363325363*g+0.0514459929*b,1.0/3.0);
  let m=pow(0.2119034982*r+0.6806995451*g+0.1073969566*b,1.0/3.0);
  let s=pow(0.0883024619*r+0.2817188376*g+0.6299787005*b,1.0/3.0);
  return vec3f(0.2104542553*l+0.793617785*m-0.0040720468*s,1.9779984951*l-2.428592205*m+0.4505937099*s,0.0259040371*l+0.7827717662*m-0.808675766*s);
}
@fragment fn fragmentMain(@builtin(position) p:vec4f)->@location(0) vec4f{
  let t=vec2i(p.xy);
  if(any(t>=vec2i(textureDimensions(image)))){return vec4f(0);}
  let source=textureLoad(image,t,0);
  if(source.a==0){return vec4f(0);}
  var c=source.rgb;
  if(settings.straight==0u){c/=source.a;}
  if(settings.side>0u){
    let at=vec2u(t)%settings.side;
    c+=settings.spread*(textureLoad(pattern,at,0).r-0.5);
  }
  c=clamp(c,vec3f(0),vec3f(1));
  if(settings.oklab==1u){c=oklab(c);}
  var best=0u;
  var least=1e30;
  for(var i=0u;i<settings.count;i++){
    let d=c-textureLoad(candidates,vec2u(i,0u),0).rgb;
    let e=dot(d,d);
    if(e<least){least=e;best=i;}
  }
  let color=textureLoad(shown,vec2u(best,0u),0).rgb;
  if(settings.straight==1u){return vec4f(color,source.a);}
  return vec4f(color*source.a,source.a);
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
  private readonly source: GPUTexture | (() => GPUTexture);
  private readonly target: GPUTexture | (() => GPUTexture);
  private readonly order: number;
  private readonly distance: PaletteDistance;
  private readonly straight: boolean;
  private colors!: [number, number, number][];
  private shown!: [number, number, number][];
  private engine?: Engine;
  private device?: GPUDevice;
  private layout?: GPUBindGroupLayout;
  private layoutPipeline?: GPUPipelineLayout;
  private module?: GPUShaderModule;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private uniform?: GPUBuffer;
  private matchTexture?: GPUTexture;
  private shownTexture?: GPUTexture;
  private readonly patterns = new Map<PaletteDither, GPUTexture>();
  private group?: GPUBindGroup;
  private groupFor?: GPUTexture;
  private groupDither?: PaletteDither;
  private targetTexture?: GPUTexture;
  private targetView?: GPUTextureView;
  private readonly values = new ArrayBuffer(SETTINGS_BYTES);
  private written = '';
  private disposed = false;

  constructor(options: PaletteQuantizeOptions) {
    if (!options?.palette || !options.source || !options.target)
      throw typeError('PaletteQuantize needs a palette, a source and a target', 'pixel-palette');
    const order = options.order ?? 20;
    if (!Number.isFinite(order)) throw rangeError('Invalid palette value', 'pixel-palette');
    this.source = options.source;
    this.target = options.target;
    this.order = order;
    this.distance = options.distance ?? 'oklab';
    if (this.distance !== 'oklab' && this.distance !== 'srgb')
      throw rangeError('Invalid palette value', 'pixel-palette');
    this.dither = options.dither ?? 'none';
    this.spread = options.spread ?? 0.125;
    this.straight = options.premultiplied === false;
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
    this.colors = colors;
    this.shown = shown;
    this.dropPalette();
  }
  setup(engine: Engine): void {
    if (this.disposed || engine.backend !== 'webgpu')
      throw fault(
        this.disposed ? 'disposed' : 'unsupported',
        this.disposed ? 'PaletteQuantize disposed; create a new one' : 'PaletteQuantize needs WebGPU',
        this.disposed ? 'disposed' : 'webgpu',
      );
    this.engine = engine;
    engine.frameGraph.add({
      name: this.name,
      order: this.order,
      execute: (c) => {
        if (c.backend === 'webgpu') this.run(c);
      },
    });
  }
  onDeviceRestored(): void {
    this.release();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.engine = undefined;
    this.release();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  private dropPalette(): void {
    this.matchTexture?.destroy();
    this.shownTexture?.destroy();
    this.matchTexture = this.shownTexture = this.group = this.groupFor = undefined;
  }
  private release(): void {
    this.dropPalette();
    for (const texture of this.patterns.values()) texture.destroy();
    this.patterns.clear();
    this.uniform?.destroy();
    this.uniform = this.layout = this.layoutPipeline = this.module = this.device = undefined;
    this.targetTexture = this.targetView = undefined;
    this.pipelines.clear();
    this.written = '';
  }
  private row(
    device: GPUDevice,
    format: GPUTextureFormat,
    data: ArrayBufferView<ArrayBuffer>,
    width: number,
    height = 1,
  ) {
    const texture = device.createTexture({
        size: [width, height],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      }),
      bytes = data.byteLength / (width * height);
    device.queue.writeTexture({ texture }, data, { bytesPerRow: width * bytes }, [width, height]);
    return texture;
  }
  private pattern(device: GPUDevice, mode: PaletteDither): GPUTexture {
    let texture = this.patterns.get(mode);
    if (!texture) {
      const matrix = ditherMatrix(mode);
      texture = matrix
        ? this.row(device, 'r32float', matrix.values as Float32Array<ArrayBuffer>, matrix.size, matrix.size)
        : this.row(device, 'r32float', new Float32Array(1), 1);
      this.patterns.set(mode, texture);
    }
    return texture;
  }
  private prepare(device: GPUDevice): void {
    if (this.device !== device) {
      if (this.device) this.release();
      this.device = device;
    }
    if (!this.module) {
      const texture = (binding: number) => ({
        binding,
        visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: 'unfilterable-float' as const },
      });
      this.layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          texture(1),
          texture(2),
          texture(3),
          texture(4),
        ],
      });
      this.layoutPipeline = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
      this.module = device.createShaderModule({ label: 'pixel palette', code: shader });
      this.uniform = device.createBuffer({
        label: 'pixel palette',
        size: SETTINGS_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    if (!this.matchTexture) {
      const count = this.colors.length,
        match = new Float32Array(count * 4),
        shown = new Uint8Array(count * 4);
      this.colors.forEach(([r, g, b], i) => {
        match.set(this.distance === 'oklab' ? oklabFromSRGB(r, g, b) : [r, g, b], i * 4);
        const out = this.shown[i];
        shown.set([Math.round(out[0] * 255), Math.round(out[1] * 255), Math.round(out[2] * 255), 255], i * 4);
      });
      this.matchTexture = this.row(device, 'rgba32float', match, count);
      this.shownTexture = this.row(device, 'rgba8unorm', shown, count);
      this.written = '';
    }
  }
  private run(c: Extract<PassContext, { backend: 'webgpu' }>): void {
    // Source and target are textures of their own: one run a frame, however many views it has.
    if (c.view?.index) return;
    const device = c.device,
      mode = this.dither;
    if (!['none', 'bayer2', 'bayer4', 'bayer8', 'blue-noise'].includes(mode) || !(this.spread >= 0))
      throw rangeError('Invalid palette value', 'pixel-palette');
    this.prepare(device);
    const source = typeof this.source === 'function' ? this.source() : this.source,
      target = typeof this.target === 'function' ? this.target() : this.target;
    if (source === target) throw fault('state', 'Palette source and target must differ', 'pixel-palette');
    const pattern = this.pattern(device, mode),
      side = mode === 'none' ? 0 : pattern.width;
    if (!this.group || this.groupFor !== source || this.groupDither !== mode) {
      this.group = device.createBindGroup({
        layout: this.layout!,
        entries: [
          { binding: 0, resource: { buffer: this.uniform! } },
          { binding: 1, resource: source.createView() },
          { binding: 2, resource: this.matchTexture!.createView() },
          { binding: 3, resource: this.shownTexture!.createView() },
          { binding: 4, resource: pattern.createView() },
        ],
      });
      this.groupFor = source;
      this.groupDither = mode;
    }
    const now = `${this.colors.length}/${side}/${this.spread}`;
    if (now !== this.written) {
      const words = new Uint32Array(this.values);
      words[0] = this.colors.length;
      words[1] = side;
      words[2] = this.distance === 'oklab' ? 1 : 0;
      words[3] = this.straight ? 1 : 0;
      new Float32Array(this.values)[4] = this.spread;
      device.queue.writeBuffer(this.uniform!, 0, this.values);
      this.written = now;
    }
    if (target !== this.targetTexture) {
      this.targetTexture = target;
      this.targetView = target.createView();
    }
    const key = target.format;
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      pipeline = device.createRenderPipeline({
        label: 'pixel palette',
        layout: this.layoutPipeline!,
        vertex: { module: this.module!, entryPoint: 'vertexMain' },
        fragment: { module: this.module!, entryPoint: 'fragmentMain', targets: [{ format: target.format }] },
      });
      this.pipelines.set(key, pipeline);
    }
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [{ view: this.targetView!, loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
}
