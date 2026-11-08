/// <reference lib="esnext.disposable" preserve="true" />
// Runtime sculpt and paint brushes for any terrain. Each dab runs one compute pass over the texels under the brush: it
// copies them (with a 2 texel border) to a scratch texture, reads the copy and writes the terrain's own heightmap or
// weight texture through a write-only storage binding, so a dab costs the texels it covers and nothing reads a texel
// another invocation writes. Brush falloff is Wendland's compactly supported C2 function (1 - t)^4 (4t + 1) (Wendland
// 1995, "Piecewise polynomial, positive definite and compactly supported radial functions of minimal degree", Advances
// in Computational Mathematics 4); smoothing blends toward the 5 x 5 binomial filter [1 4 6 4 1]^2 / 256 (Burt and
// Adelson 1983, "The Laplacian Pyramid as a Compact Image Code", IEEE Trans. Communications 31(4)). A CPU copy of the
// heights and weights follows the GPU after each stroke (the stroke's rectangle read back), and holds the undo steps:
// each stroke keeps the rectangle's values from before and after it (the memento of Gamma et al. 1994, "Design
// Patterns", ch. 5), so undo and redo are exact.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Terrain } from './index.js';
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_SRC: number; COPY_DST: number; STORAGE_BINDING: number };
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; MAP_READ: number };
declare const GPUMapMode: { READ: number };

/** What a brush does: move heights up or down, blur them, pull them to one height, or paint a layer's weight. */
export type TerrainBrush = 'raise' | 'lower' | 'smooth' | 'flatten' | 'paint';
/** How a brush fades from its centre to its edge. */
export type TerrainBrushFalloff = 'smooth' | 'linear' | 'constant';

/** Brush settings, for {@link TerrainSculpt.dab}, a stroke, or the sculpt's defaults. */
export interface TerrainBrushOptions {
  /** Default `'raise'`. */
  brush?: TerrainBrush;
  /** World radius, above 0. Default 8. */
  radius?: number;
  /** 0 to 1: the share of `amount` (raise, lower) or of the way to the result (smooth, flatten, paint) a dab moves at its centre. Default 0.5. */
  strength?: number;
  /** Default `'smooth'`: Wendland's (1 - t)^4 (4t + 1) of the distance over the radius. */
  falloff?: TerrainBrushFalloff;
  /** World Y a raise or lower dab moves at its centre at strength 1, above 0. Default a tenth of the radius. */
  amount?: number;
  /** Flatten's world Y. Default the height under the stroke's first dab, as `heights` held it when the stroke began. */
  height?: number;
  /** The layer `paint` raises (the others fall to keep their shares), 0 to the terrain's layers - 1. Default 0. */
  layer?: number;
}

/** {@link TerrainSculpt.attach} options. */
export interface TerrainSculptOptions extends TerrainBrushOptions {
  /** Strokes kept for undo, 0 to 1,000. Default 32. */
  undoLimit?: number;
  /** Aborts the initial read back. */
  signal?: AbortSignal;
}

/** A texel rectangle that changed: in the heightmap, or in weight texture `weights` (an index into `TerrainSculpt.weights`). */
export interface TerrainSculptChange {
  readonly weights?: number;
  readonly u: number;
  readonly v: number;
  readonly width: number;
  readonly depth: number;
}

/** An open stroke: `end()` (or `using`) closes it into one undo step. */
export interface TerrainStroke extends Disposable {
  end(): void;
}

interface Rect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}
interface Patch {
  /** -1 for the heightmap, else the weight texture's index. */
  map: number;
  u: number;
  v: number;
  width: number;
  depth: number;
  before: Float32Array | Uint8Array;
  after: Float32Array | Uint8Array;
}
interface Map2D {
  texture: GPUTexture;
  columns: number;
  rows: number;
  data: Float32Array | Uint8Array;
  channels: number;
}

const brushShader = (format: 'r32float' | 'rgba8unorm'): string => /* wgsl */ `
struct Dab {center:vec2f,radius:f32,strength:f32,amount:f32,goal:f32,mode:u32,falloff:u32,lo:vec2i,hi:vec2i,origin:vec2i,spacing:vec2f,paint:vec4f}
@group(0) @binding(0) var<uniform> dab:Dab;
@group(0) @binding(1) var source:texture_2d<f32>;
@group(0) @binding(2) var dest:texture_storage_2d<${format},write>;
fn fall(t:f32)->f32 {
  if(t>=1.0){return 0.0;}if(dab.falloff==1u){return 1.0-t;}if(dab.falloff==2u){return 1.0;}
  let s=1.0-t;return s*s*s*s*(4.0*t+1.0);
}
fn at(p:vec2i)->vec4f {return textureLoad(source,clamp(p-dab.origin,vec2i(0),vec2i(textureDimensions(source))-vec2i(1)),0);}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
  let p=dab.lo+vec2i(id.xy);if(any(p>=dab.hi)){return;}
  let f=fall(length((vec2f(p)-dab.center)*dab.spacing)/dab.radius)*dab.strength;let h=at(p);var out=h;
  ${
    format === 'rgba8unorm'
      ? // Paint: toward one layer; a step too small for 8 bits still moves one 255th so long strokes arrive.
        'let d=dab.paint-h;let s=d*f;out=h+select(s,sign(d)*min(abs(d),vec4f(1.0/255.0)),(abs(s)<vec4f(0.5/255.0))&(abs(d)>vec4f(0.0))&vec4<bool>(f>0.0));'
      : `switch dab.mode {
    case 0u:{out.x=h.x+dab.amount*f;}
    case 1u:{out.x=h.x-dab.amount*f;}
    case 2u:{var k=array<f32,5>(1,4,6,4,1);var s=0.0;for(var j=-2;j<=2;j++){for(var i=-2;i<=2;i++){s+=k[i+2]*k[j+2]*at(p+vec2i(i,j)).x;}}out.x=mix(h.x,s/256.0,f);}
    default:{out.x=mix(h.x,dab.goal,f);}
  }`
  }
  textureStore(dest,p,out);
}`;

let nextId = 0;
const MODES: Record<TerrainBrush, number> = { raise: 0, lower: 1, smooth: 2, flatten: 3, paint: 4 };
const FALLOFFS: Record<TerrainBrushFalloff, number> = { smooth: 0, linear: 1, constant: 2 };

/** Reads `texture`'s rectangle back: bytes per texel `size`, rows padded to 256 bytes on the GPU. */
async function readBack(
  device: GPUDevice,
  texture: GPUTexture,
  rect: Rect,
  size: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const width = rect.u1 - rect.u0,
    depth = rect.v1 - rect.v0,
    row = Math.ceil((width * size) / 256) * 256,
    buffer = device.createBuffer({ size: row * depth, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    encoder = device.createCommandEncoder();
  encoder.copyTextureToBuffer(
    { texture, origin: [rect.u0, rect.v0] },
    { buffer, bytesPerRow: row, rowsPerImage: depth },
    [width, depth],
  );
  device.queue.submit([encoder.finish()]);
  try {
    await buffer.mapAsync(GPUMapMode.READ);
    signal?.throwIfAborted();
    const mapped = new Uint8Array(buffer.getMappedRange()),
      out = new Uint8Array(width * depth * size);
    for (let j = 0; j < depth; j++) out.set(mapped.subarray(j * row, j * row + width * size), j * width * size);
    return out;
  } finally {
    buffer.destroy();
  }
}

/**
 * Sculpt and paint brushes on a live {@link Terrain}: raise, lower, smooth, flatten and paint layer weights, on the
 * GPU, with undo. The terrain's heightmap must be `r32float` and its weight textures (if any) `rgba8unorm`, all with
 * `STORAGE_BINDING | COPY_SRC | COPY_DST | TEXTURE_BINDING` usage (15). Make one with `await TerrainSculpt.attach`.
 */
export class TerrainSculpt implements EnginePlugin {
  readonly name = 'terrain-sculpt:' + nextId++;
  /** CPU copy of the heightmap, row by row (as `TerrainQuery` takes it): holds every finished stroke once `flush()` resolves. */
  heights!: Float32Array;
  /** Heightmap texels per row and rows. */
  columns = 0;
  rows = 0;
  /** CPU copies of the distinct weight textures, RGBA bytes, with their sizes. */
  weights: readonly { readonly data: Uint8Array; readonly columns: number; readonly rows: number }[] = [];
  /** Brush settings used where a dab or stroke leaves one out. */
  readonly brush: Required<Omit<TerrainBrushOptions, 'height' | 'amount'>> &
    Pick<TerrainBrushOptions, 'height' | 'amount'>;
  disposed = false;
  readonly #terrain: Terrain;
  readonly #limit: number;
  readonly #undo: Patch[][] = [];
  readonly #redo: Patch[][] = [];
  readonly #listeners = new Set<(change: TerrainSculptChange) => void>();
  #engine?: Engine;
  #device?: GPUDevice;
  #maps: Map2D[] = [];
  #pipelines = new Map<string, GPUComputePipeline>();
  #uniform?: GPUBuffer;
  #scratch = new Map<string, GPUTexture>();
  #stroke?: { options: TerrainBrushOptions; target?: number; dirty: Map<number, Rect> };
  #pending: Promise<void> = Promise.resolve();
  #failure: unknown;

  private constructor(terrain: Terrain, options: TerrainSculptOptions) {
    this.#terrain = terrain;
    this.#limit = options.undoLimit ?? 32;
    if (!Number.isInteger(this.#limit) || this.#limit < 0 || this.#limit > 1000)
      throw new RangeError('Invalid terrain sculpt undoLimit; give a whole number from 0 to 1000 (default 32).');
    this.brush = {
      brush: 'raise',
      radius: 8,
      strength: 0.5,
      falloff: 'smooth',
      layer: 0,
      ...this.#check(options),
    };
  }

  /**
   * Attaches brushes to `terrain`, which must already be attached to `engine`, and reads its heightmap and weights back
   * once for the CPU copy. `dispose()` removes them (the terrain keeps its edits).
   * @throws RangeError for bad options; TypeError for a heightmap or weights of the wrong format or usage; MargoError
   * `'unsupported'` on WebGL or a terrain that is not attached.
   */
  static async attach(
    engine: EngineKernel,
    terrain: Terrain,
    options: TerrainSculptOptions = {},
  ): Promise<TerrainSculpt> {
    if (!terrain || typeof terrain.invalidate !== 'function')
      throw new TypeError('Invalid terrain sculpt; pass a Terrain attached to the engine.');
    const sculpt = new TerrainSculpt(terrain, options);
    engineRuntime(engine).use(sculpt);
    try {
      await sculpt.#read(options.signal);
    } catch (error) {
      sculpt.dispose();
      throw error;
    }
    return sculpt;
  }

  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu || !this.#terrain.heightmap)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'Terrain sculpting requires WebGPU and an attached terrain; attach the Terrain first, on a WebGPU engine',
      );
    this.#engine = engine;
    this.#device = engine.gpu;
    this.#bind();
  }

  /** Takes the terrain's current textures (at attachment and after device restoration) and checks them. */
  #bind(): void {
    const height = this.#terrain.heightmap!,
      usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      weights = [...new Set(this.#terrain.weights ?? [])];
    if (height.format !== 'r32float' || (height.usage & usage) !== usage)
      throw new TypeError(
        'Terrain sculpting needs an r32float heightmap with STORAGE_BINDING, COPY_SRC and COPY_DST usage (15 with TEXTURE_BINDING); create it so in the textures factory.',
      );
    if (weights.some((w) => w.format !== 'rgba8unorm' || (w.usage & usage) !== usage))
      throw new TypeError(
        'Terrain weight painting needs rgba8unorm weights with STORAGE_BINDING, COPY_SRC and COPY_DST usage (15 with TEXTURE_BINDING); create them so in the textures factory.',
      );
    const old = this.#maps;
    this.#maps = [height, ...weights].map((texture, i) => ({
      texture,
      columns: texture.width,
      rows: texture.height,
      channels: i ? 4 : 1,
      data:
        old[i]?.data ??
        (i ? new Uint8Array(texture.width * texture.height * 4) : new Float32Array(texture.width * texture.height)),
    }));
  }

  /** Reads every map back into the CPU copies. */
  async #read(signal?: AbortSignal): Promise<void> {
    const device = this.#device!;
    for (const map of this.#maps) {
      const bytes = await readBack(device, map.texture, { u0: 0, v0: 0, u1: map.columns, v1: map.rows }, 4, signal);
      if (map.channels === 1) map.data = new Float32Array(bytes.buffer);
      else map.data = bytes;
    }
    this.#publish();
  }

  #publish(): void {
    const [height, ...weights] = this.#maps;
    this.heights = height.data as Float32Array;
    this.columns = height.columns;
    this.rows = height.rows;
    this.weights = weights.map((w) => ({ data: w.data as Uint8Array, columns: w.columns, rows: w.rows }));
  }

  #check(options: TerrainBrushOptions): TerrainBrushOptions {
    const o = options ?? {},
      layers = this.#terrain.options.layers.length;
    if (
      (o.brush !== undefined && !(o.brush in MODES)) ||
      (o.falloff !== undefined && !(o.falloff in FALLOFFS)) ||
      (o.radius !== undefined && !(o.radius > 0 && Number.isFinite(o.radius))) ||
      (o.strength !== undefined && !(o.strength >= 0 && o.strength <= 1)) ||
      (o.amount !== undefined && !(o.amount > 0 && Number.isFinite(o.amount))) ||
      (o.height !== undefined && !Number.isFinite(o.height)) ||
      (o.layer !== undefined && !(Number.isInteger(o.layer) && o.layer >= 0 && o.layer < layers))
    )
      throw new RangeError(
        `Invalid terrain brush; give brush raise, lower, smooth, flatten or paint, falloff smooth, linear or constant, radius and amount above 0, strength 0..1, a finite height and a layer 0..${layers - 1}.`,
      );
    const out: TerrainBrushOptions = {};
    for (const key of ['brush', 'radius', 'strength', 'falloff', 'amount', 'height', 'layer'] as const)
      if (o[key] !== undefined) (out as Record<string, unknown>)[key] = o[key];
    return out;
  }

  /**
   * Opens a stroke: the dabs until `end()` are one undo step and share `options` (over the sculpt's `brush`).
   * @example
   * { using stroke = sculpt.stroke({brush: 'smooth'}); sculpt.dab(10, 4); sculpt.dab(12, 5); }
   * @throws Error (MargoError 'state') when a stroke is already open; RangeError for bad options.
   */
  stroke(options: TerrainBrushOptions = {}): TerrainStroke {
    this.#live();
    if (this.#stroke) throw new MargoError('state', 'A terrain stroke is already open; end it before starting another');
    const stroke = (this.#stroke = { options: this.#check(options), dirty: new Map<number, Rect>() }),
      end = () => {
        if (this.#stroke !== stroke) return;
        this.#stroke = undefined;
        if (stroke.dirty.size) this.#commit(stroke.dirty);
      };
    return { end, [Symbol.dispose]: end };
  }

  /**
   * One dab at world (x, z): inside an open stroke, or as a stroke of its own. Runs on the GPU now; `heights` follows
   * once the stroke ends and its read back lands (`flush()`).
   */
  dab(x: number, z: number, options: TerrainBrushOptions = {}): void {
    this.#live();
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new TypeError('Invalid terrain dab; pass a finite world x and z.');
    const own = !this.#stroke,
      stroke = own ? this.stroke() : undefined;
    try {
      const s = this.#stroke!,
        o = { ...this.brush, ...s.options, ...this.#check(options) },
        t = this.#terrain.options,
        [ox, oz] = t.origin ?? [0, 0],
        [sx, sz] = t.size,
        scale = t.heightScale ?? 100,
        offset = t.heightOffset ?? 0;
      if (o.brush === 'flatten') s.target ??= o.height !== undefined ? (o.height - offset) / scale : this.#sample(x, z);
      const paint = o.brush === 'paint';
      if (paint && this.#maps.length < 2)
        throw new RangeError('Invalid terrain brush; paint needs a terrain with weights.');
      const maps = paint ? this.#maps.slice(1).map((map, i) => [i + 1, map] as const) : [[0, this.#maps[0]] as const];
      for (const [index, map] of maps) {
        // Heights sit at texel corners (texel 0 at origin, the last at origin + size); weights at texel centres.
        const spacingX = paint ? sx / map.columns : sx / Math.max(map.columns - 1, 1),
          spacingZ = paint ? sz / map.rows : sz / Math.max(map.rows - 1, 1),
          cu = (x - ox) / spacingX - (paint ? 0.5 : 0),
          cv = (z - oz) / spacingZ - (paint ? 0.5 : 0),
          rect = {
            u0: Math.max(0, Math.floor(cu - o.radius / spacingX)),
            v0: Math.max(0, Math.floor(cv - o.radius / spacingZ)),
            u1: Math.min(map.columns, Math.ceil(cu + o.radius / spacingX) + 1),
            v1: Math.min(map.rows, Math.ceil(cv + o.radius / spacingZ) + 1),
          };
        if (rect.u1 <= rect.u0 || rect.v1 <= rect.v0) continue;
        const paintChannel = new Float32Array(4);
        if (paint && Math.floor(o.layer / 4) === index - 1) paintChannel[o.layer % 4] = 1;
        this.#run(map, rect, [cu, cv], [spacingX, spacingZ], {
          radius: o.radius,
          strength: o.strength,
          amount: (o.amount ?? o.radius / 10) / scale,
          target: s.target ?? 0,
          mode: MODES[o.brush],
          falloff: FALLOFFS[o.falloff],
          paint: paintChannel,
        });
        const dirty = s.dirty.get(index);
        if (dirty) {
          dirty.u0 = Math.min(dirty.u0, rect.u0);
          dirty.v0 = Math.min(dirty.v0, rect.v0);
          dirty.u1 = Math.max(dirty.u1, rect.u1);
          dirty.v1 = Math.max(dirty.v1, rect.v1);
        } else s.dirty.set(index, { ...rect });
      }
      this.#terrain.invalidate();
    } finally {
      stroke?.end();
    }
  }

  /** The bilinear height in map units at world (x, z) from the CPU copy, as the vertex shader samples it. */
  #sample(x: number, z: number): number {
    const t = this.#terrain.options,
      [ox, oz] = t.origin ?? [0, 0],
      c = this.columns,
      r = this.rows,
      u = Math.min(Math.max(((x - ox) / t.size[0]) * (c - 1), 0), c - 1),
      v = Math.min(Math.max(((z - oz) / t.size[1]) * (r - 1), 0), r - 1),
      u0 = Math.floor(u),
      v0 = Math.floor(v),
      u1 = Math.min(u0 + 1, c - 1),
      v1 = Math.min(v0 + 1, r - 1),
      h = this.heights,
      a = h[v0 * c + u0] + (h[v0 * c + u1] - h[v0 * c + u0]) * (u - u0),
      b = h[v1 * c + u0] + (h[v1 * c + u1] - h[v1 * c + u0]) * (u - u0);
    return a + (b - a) * (v - v0);
  }

  #run(
    map: Map2D,
    rect: Rect,
    center: [number, number],
    spacing: [number, number],
    dab: {
      radius: number;
      strength: number;
      amount: number;
      target: number;
      mode: number;
      falloff: number;
      paint: Float32Array;
    },
  ): void {
    const device = this.#device!,
      format = map.texture.format as 'r32float' | 'rgba8unorm',
      // The source copy reaches 2 texels past the rectangle for the smoothing filter.
      from = [Math.max(0, rect.u0 - 2), Math.max(0, rect.v0 - 2)],
      to = [Math.min(map.columns, rect.u1 + 2), Math.min(map.rows, rect.v1 + 2)],
      width = to[0] - from[0],
      depth = to[1] - from[1];
    let scratch = this.#scratch.get(format);
    if (!scratch || scratch.width < width || scratch.height < depth) {
      scratch?.destroy();
      const side = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(n, 16)));
      scratch = device.createTexture({
        size: [Math.max(side(width), scratch?.width ?? 0), Math.max(side(depth), scratch?.height ?? 0)],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      this.#scratch.set(format, scratch);
    }
    let pipeline = this.#pipelines.get(format);
    if (!pipeline) {
      pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: brushShader(format) }), entryPoint: 'main' },
      });
      this.#pipelines.set(format, pipeline);
    }
    this.#uniform ??= device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const data = new ArrayBuffer(80),
      f = new Float32Array(data),
      i = new Int32Array(data),
      u = new Uint32Array(data);
    f.set([center[0], center[1], dab.radius, dab.strength, dab.amount, dab.target]);
    u[6] = dab.mode;
    u[7] = dab.falloff;
    i.set([rect.u0, rect.v0, rect.u1, rect.v1, from[0], from[1]], 8);
    f.set(spacing, 14);
    f.set(dab.paint, 16);
    device.queue.writeBuffer(this.#uniform, 0, data);
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture({ texture: map.texture, origin: from }, { texture: scratch }, [width, depth]);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.#uniform } },
          { binding: 1, resource: scratch.createView() },
          { binding: 2, resource: map.texture.createView() },
        ],
      }),
    );
    pass.dispatchWorkgroups(Math.ceil((rect.u1 - rect.u0) / 8), Math.ceil((rect.v1 - rect.v0) / 8));
    pass.end();
    // One submit per dab: the next dab's uniform write lands after this one has read its own.
    device.queue.submit([encoder.finish()]);
  }

  /** Reads a finished stroke's rectangles back into the CPU copies and keeps them as one undo step. */
  #commit(dirty: Map<number, Rect>): void {
    const device = this.#device!,
      reads = [...dirty].map(([index, rect]) => {
        const map = this.#maps[index];
        return readBack(device, map.texture, rect, 4).then((bytes) => ({ index, rect, bytes }));
      });
    this.#redo.length = 0;
    this.#pending = this.#pending.then(async () => {
      const step: Patch[] = [];
      for (const { index, rect, bytes } of await Promise.all(reads)) {
        const map = this.#maps[index],
          after = map.channels === 1 ? new Float32Array(bytes.buffer) : bytes;
        step.push({
          map: index,
          u: rect.u0,
          v: rect.v0,
          width: rect.u1 - rect.u0,
          depth: rect.v1 - rect.v0,
          before: this.#cut(map, rect),
          after,
        });
        this.#paste(index, rect, after);
      }
      if (this.#limit) {
        this.#undo.push(step);
        if (this.#undo.length > this.#limit) this.#undo.shift();
      }
    });
    this.#pending.catch((error) => (this.#failure ??= error));
  }

  #cut(map: Map2D, rect: Rect): Float32Array | Uint8Array {
    const c = map.channels,
      width = (rect.u1 - rect.u0) * c,
      out = c === 1 ? new Float32Array(width * (rect.v1 - rect.v0)) : new Uint8Array(width * (rect.v1 - rect.v0));
    for (let v = rect.v0; v < rect.v1; v++)
      out.set(
        map.data.subarray((v * map.columns + rect.u0) * c, (v * map.columns + rect.u1) * c),
        (v - rect.v0) * width,
      );
    return out;
  }

  /** Writes values into the CPU copy and tells the listeners. */
  #paste(index: number, rect: Rect, values: Float32Array | Uint8Array): void {
    const map = this.#maps[index],
      c = map.channels,
      width = (rect.u1 - rect.u0) * c;
    for (let v = rect.v0; v < rect.v1; v++)
      map.data.set(values.subarray((v - rect.v0) * width, (v - rect.v0 + 1) * width), (v * map.columns + rect.u0) * c);
    const change = { u: rect.u0, v: rect.v0, width: rect.u1 - rect.u0, depth: rect.v1 - rect.v0 };
    for (const callback of [...this.#listeners]) callback(index ? { ...change, weights: index - 1 } : change);
  }

  /** Puts one undo step's `before` (undo) or `after` (redo) back on the GPU and in the CPU copy. */
  #apply(step: Patch[], side: 'before' | 'after'): void {
    const queue = this.#device!.queue;
    for (const patch of step) {
      const map = this.#maps[patch.map],
        values = patch[side],
        rect = { u0: patch.u, v0: patch.v, u1: patch.u + patch.width, v1: patch.v + patch.depth };
      queue.writeTexture(
        { texture: map.texture, origin: [patch.u, patch.v] },
        values as Uint8Array<ArrayBuffer>,
        { bytesPerRow: patch.width * 4 },
        [patch.width, patch.depth],
      );
      this.#paste(patch.map, rect, values);
    }
    this.#terrain.invalidate();
  }

  /** Undoes the last finished stroke, once the pending read backs land. Resolves false with nothing to undo. */
  async undo(): Promise<boolean> {
    await this.flush();
    const step = this.#undo.pop();
    if (!step) return false;
    this.#apply(step, 'before');
    this.#redo.push(step);
    return true;
  }

  /** Redoes the last undone stroke. Resolves false with nothing to redo; a new stroke clears the redo steps. */
  async redo(): Promise<boolean> {
    await this.flush();
    const step = this.#redo.pop();
    if (!step) return false;
    this.#apply(step, 'after');
    this.#undo.push(step);
    return true;
  }

  /** Resolves when `heights` and `weights` hold every finished stroke (rejects with a read back's failure). */
  async flush(): Promise<void> {
    this.#live();
    await this.#pending;
    if (this.#failure) throw this.#failure;
  }

  /**
   * Calls `callback` for every rectangle the CPU copies take (after a stroke's read back, an undo or a redo), for a
   * `TerrainQuery` over `heights`: `query.refresh(u, v, width, depth)` when `weights` is undefined. Returns the remover.
   */
  onChange(callback: (change: TerrainSculptChange) => void): () => void {
    if (typeof callback !== 'function') throw new TypeError('Invalid terrain sculpt listener; pass a function.');
    this.#listeners.add(callback);
    return () => this.#listeners.delete(callback);
  }

  /** Puts the CPU copies (with every edit) into the terrain's new textures after device restoration. */
  onDeviceRestored(engine: Engine): void {
    this.#device = engine.gpu ?? undefined;
    this.#pipelines.clear();
    this.#scratch.clear();
    this.#uniform = undefined;
    this.#bind();
    for (const map of this.#maps)
      this.#device!.queue.writeTexture(
        { texture: map.texture },
        map.data as Uint8Array<ArrayBuffer>,
        { bytesPerRow: map.columns * 4 },
        [map.columns, map.rows],
      );
    this.#publish();
    this.#terrain.invalidate();
  }

  #live(): void {
    if (this.disposed || !this.#device)
      throw new MargoError('disposed', 'This terrain sculpt was disposed; attach a new TerrainSculpt');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#stroke = undefined;
    this.#engine?.removePlugin(this.name);
    for (const texture of this.#scratch.values()) texture.destroy();
    this.#scratch.clear();
    this.#uniform?.destroy();
    this.#listeners.clear();
    this.#undo.length = this.#redo.length = 0;
    this.#engine = this.#device = this.#uniform = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
