/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type PassContext } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { LocalShadows, type LocalShadowOptions } from './shadows.js';
import { viewSize } from '../../shared/view-rect.js';

type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** One light's atlas request. All cube faces keep the same square resolution. */
export interface AtlasRequest {
  /** Stable caller identifier. */
  id: string;
  /** Requested power-of-two face size, at least 16. */
  resolution: number;
  /** Number of faces or cascades, 1 to 6. */
  faces: number;
  /** Nonnegative priority; lower-priority lights lose resolution first. */
  importance: number;
}
/** One packed depth face in pixel coordinates. */
export interface AtlasTile {
  /** Light identifier. */
  id: string;
  /** Face/cascade index. */
  face: number;
  /** Tile origin. */
  x: number;
  /** Tile origin. */
  y: number;
  /** Square side, including the two-pixel guard band on each edge. */
  size: number;
}
const power = (v: number) => Number.isInteger(v) && v >= 16 && v <= 16384 && (v & (v - 1)) === 0;
/**
 * Deterministic quadtree packing. Reduces the least-important light one level at a time until all faces fit.
 * No light is dropped. Throws RangeError when even minimum-sized faces exceed the atlas.
 */
export function packShadowAtlas(requests: readonly AtlasRequest[], size = 2048, minimum = 32): readonly AtlasTile[] {
  const list = fitShadowAtlas(requests, size, minimum), tiles: AtlasTile[] = [];
  const free = new Map<number, [number, number][]>([[size, [[0, 0]]]]);
  for (const r of [...list].sort((a, b) => b.resolution - a.resolution || a.id.localeCompare(b.id))) {
    for (let face = 0; face < r.faces; face++) {
      let side = r.resolution;
      while (!free.get(side)?.length) side *= 2;
      const [x, y] = free.get(side)!.shift()!;
      while (side > r.resolution) {
        side /= 2;
        const queue = free.get(side) ?? [];
        queue.push([x + side, y], [x, y + side], [x + side, y + side]);
        free.set(side, queue);
      }
      tiles.push({ id: r.id, face, x, y, size: r.resolution });
    }
  }
  // Preserve the caller's layer order: point faces, directional cascades, then area faces.
  return Object.freeze(requests.flatMap((r) => tiles.filter((t) => t.id === r.id).map((t) => Object.freeze(t))));
}
/** Validated copies of `requests` with resolutions lowered, least important first, until every face fits the atlas. */
function fitShadowAtlas(requests: readonly AtlasRequest[], size: number, minimum: number): AtlasRequest[] {
  if (!Array.isArray(requests) || !power(size) || !power(minimum) || minimum > size)
    throw new RangeError('Atlas needs power-of-two size and minimum from 16 to 16384; minimum must fit size');
  if (requests.reduce((n, r) => n + (r?.faces ?? 0), 0) > 256)
    throw new RangeError('Atlas supports at most 256 logical faces; reduce lights or cascades');
  const ids = new Set<string>();
  const list = requests.map((r) => {
    if (!r || typeof r.id !== 'string' || ids.has(r.id) || !power(r.resolution) || r.resolution > size ||
      !Number.isInteger(r.faces) || r.faces < 1 || r.faces > 6 || !(r.importance >= 0 && Number.isFinite(r.importance)))
      throw new RangeError('Atlas requests need unique ids, a fitting power-of-two resolution, 1..6 faces and finite importance');
    ids.add(r.id);
    return { ...r };
  });
  const texels = () => list.reduce((n, r) => n + r.faces * r.resolution ** 2, 0);
  while (texels() > size * size) {
    const candidates = list.filter((r) => r.resolution > Math.min(minimum, requests.find((q) => q.id === r.id)!.resolution));
    candidates.sort((a, b) => a.importance - b.importance || b.resolution - a.resolution || a.id.localeCompare(b.id));
    if (!candidates.length) throw new RangeError('Shadow atlas is full at minimum resolution; raise atlas size or lower minimum');
    candidates[0].resolution /= 2;
  }
  return list;
}
/**
 * Square power-of-two tiles in a square atlas by the buddy method (Knowlton 1965, "A fast storage allocator"): a free
 * block splits into four quadrants and four free quadrants merge back. Blocks are `x + y * 65536`.
 */
class BuddyAtlas {
  private readonly free = new Map<number, number[]>();
  constructor(private readonly size: number) { this.clear(); }
  clear(): void { this.free.clear(); this.free.set(this.size, [0]); }
  /** The free tile of `side` texels lowest in the atlas (row, then column), or undefined when none is left. */
  allocate(side: number): [number, number] | undefined {
    let from = side;
    while (from <= this.size && !this.free.get(from)?.length) from *= 2;
    if (from > this.size) return undefined;
    const list = this.free.get(from)!;
    let best = 0;
    for (let i = 1; i < list.length; i++) {
      const a = list[i], b = list[best];
      if (a >>> 16 < b >>> 16 || (a >>> 16 === b >>> 16 && (a & 0xffff) < (b & 0xffff))) best = i;
    }
    const block = list.splice(best, 1)[0], x = block & 0xffff, y = block >>> 16;
    for (let half = from / 2; half >= side; half /= 2) {
      const queue = this.free.get(half) ?? [];
      queue.push(x + half + y * 65536, x + (y + half) * 65536, x + half + (y + half) * 65536);
      this.free.set(half, queue);
    }
    return [x, y];
  }
  /** Returns a tile `allocate` gave, merging it with its three free siblings while they are free. */
  release(x: number, y: number, side: number): void {
    while (side < this.size) {
      const parent = side * 2, px = x - (x % parent), py = y - (y % parent), list = this.free.get(side) ?? [],
        self = x + y * 65536,
        siblings = [px + py * 65536, px + side + py * 65536, px + (py + side) * 65536, px + side + (py + side) * 65536];
      if (!siblings.every((s) => s === self || list.includes(s))) break;
      for (const s of siblings) if (s !== self) list.splice(list.indexOf(s), 1);
      x = px; y = py; side = parent;
    }
    const list = this.free.get(side) ?? [];
    list.push(x + y * 65536);
    this.free.set(side, list);
  }
}
/** Camera-driven atlas settings; LocalShadows caster, bias and maxLights settings also apply. */
export interface ShadowAtlasOptions extends LocalShadowOptions {
  /** Atlas side in pixels, a power of two. Default 2048. */
  resolution?: number;
  /** Minimum face size, power of two. Default 32. */
  minResolution?: number;
  /** Maximum face size, power of two. Default 1024, capped to atlas size. */
  maxResolution?: number;
  /** Shadow texels per covered screen pixel. Positive finite, default 1. */
  texelDensity?: number;
}
/**
 * Local shadows packed into one depth image. Point/spot resolution follows screen coverage each frame; directional
 * and area maps share the atlas with their authored resolution. Every light retains all faces, even under pressure.
 * Uses the same casters, bias, PCF and PCSS as LocalShadows. Replace LocalShadows with this plugin on a Clustered.
 * Faces are cached: a face keeps its tile while its size is unchanged and re-renders only when its light or tile
 * changes or a caster whose bounds reach it moves, shows, hides, is added or is removed.
 */
export class ShadowAtlas extends LocalShadows {
  private buffer?: GPUBuffer;
  private atlasEntries?: GPUBindGroupEntry[];
  private baseEntries?: GPUBindGroupEntry[];
  private readonly rects = new Float32Array(256 * 4);
  private tiles: readonly AtlasTile[] = [];
  private readonly resolutions = new Map<string, number>();
  /** Placed faces by `id:face`; a face keeps its tile while its size is unchanged, so its cached depth stays valid. */
  private readonly placed = new Map<string, AtlasTile>();
  private allocator?: BuddyAtlas;
  private written = false;
  /** Create an atlas; dimensions and density are validated before any GPU allocation. */
  constructor(readonly atlasOptions: ShadowAtlasOptions) {
    super({ ...atlasOptions, resolution: atlasOptions.resolution ?? 2048 });
    const size = this.options.resolution!, min = atlasOptions.minResolution ?? 32,
      max = atlasOptions.maxResolution ?? Math.min(1024, size), density = atlasOptions.texelDensity ?? 1;
    if (!power(size) || !power(min) || !power(max) || min > max || max > size || !(density > 0 && Number.isFinite(density)))
      throw new RangeError('Atlas size, minimum and maximum must be fitting powers of two; use positive finite texelDensity');
  }
  /** Attach a single shared shadow atlas to this engine's clustered lights. */
  static override attach(instance: EngineKernel, options: ShadowAtlasOptions): ShadowAtlas {
    const atlas = new ShadowAtlas(options);
    engineRuntime(instance).use(atlas);
    return atlas;
  }
  /** Current face rectangles, in logical layer order. Updated on rendering. */
  get layout(): readonly AtlasTile[] { return this.tiles; }
  /** Number of allocated depth texels, independent of the number of lights. */
  get allocatedTexels(): number { return this.options.resolution! ** 2; }
  /** Number of texels rasterized when every current face is dirty. */
  get usedTexels(): number { return this.tiles.reduce((n, t) => n + t.size ** 2, 0); }
  /** @internal One physical layer for all logical shadow faces. */
  protected override get atlasMode(): boolean { return true; }
  /** @internal Plan from the current camera before LocalShadows builds its face matrices. */
  protected override prepare(c: Context): void {
    const size = this.options.resolution!, minimum = this.atlasOptions.minResolution ?? 32,
      maximum = this.atlasOptions.maxResolution ?? Math.min(1024, size),
      density = this.atlasOptions.texelDensity ?? 1, requests: AtlasRequest[] = [];
    const quantize = (pixels: number) => Math.min(maximum, 2 ** Math.ceil(Math.log2(Math.max(16, pixels))));
    let ordinal = 0;
    this.lights.list.forEach((light, index) => {
      if (!light.castShadow || ordinal++ >= (this.options.maxLights ?? 4)) return;
      const settings = light.shadow && typeof light.shadow === 'object' ? light.shadow : undefined,
        radius = settings?.far ?? light.range,
        coverage = projectedCoverage(c, light.position, radius),
        authored = settings?.resolution,
        cap = typeof authored === 'number' ? authored : authored ? Math.max(...authored) : maximum,
        resolution = quantize(Math.min(cap, Math.max(minimum, coverage * density + 4))),
        point = !('direction' in light) || Math.cos(light.angle ?? light.outerAngle!) < 1e-6;
      requests.push({ id: `point:${index}`, resolution, faces: point ? 6 : 1, importance: coverage });
    });
    for (const light of this.lights.directional?.shadowLights?.() ?? []) requests.push({
      id: `directional:${light.index}`, resolution: quantize(Math.max(light.width, light.height) || maximum),
      faces: light.bounds ? 1 : light.cascades, importance: maximum,
    });
    for (const light of [...(this.lights.area?.shadowLights?.() ?? []), ...(this.lights.shapes?.shadowLights?.() ?? [])])
      requests.push({ id: `area:${light.index}`, resolution: quantize(Math.max(light.width, light.height) || maximum),
        faces: light.twoSided ? 6 : 5, importance: maximum });
    this.tiles = this.placeFaces(requests, size, minimum);
    this.resolutions.clear();
    for (const tile of this.tiles) this.resolutions.set(tile.id, tile.size);
  }
  /**
   * Stable placement: faces that keep their size keep their tile; faces that changed size, or are new, take free tiles,
   * largest first. If fragmentation leaves no room, every face is placed afresh (and so re-rendered).
   */
  private placeFaces(requests: readonly AtlasRequest[], size: number, minimum: number): readonly AtlasTile[] {
    const list = fitShadowAtlas(requests, size, minimum), allocator = (this.allocator ??= new BuddyAtlas(size)),
      wanted = new Map(list.map((r) => [r.id, r]));
    for (const [key, tile] of this.placed) {
      const r = wanted.get(tile.id);
      if (r && r.resolution === tile.size && tile.face < r.faces) continue;
      allocator.release(tile.x, tile.y, tile.size);
      this.placed.delete(key);
    }
    const order = [...list].sort((a, b) => b.resolution - a.resolution || a.id.localeCompare(b.id));
    const fill = () => {
      for (const r of order)
        for (let face = 0; face < r.faces; face++) {
          const key = `${r.id}:${face}`;
          if (this.placed.has(key)) continue;
          const at = allocator.allocate(r.resolution);
          if (!at) return false;
          this.placed.set(key, Object.freeze({ id: r.id, face, x: at[0], y: at[1], size: r.resolution }));
        }
      return true;
    };
    if (!fill()) {
      allocator.clear();
      this.placed.clear();
      // Sorted largest first, power-of-two squares whose area fits always pack into an empty quadtree.
      if (!fill()) throw new RangeError('Shadow atlas is full at minimum resolution; raise atlas size or lower minimum');
    }
    return Object.freeze(list.flatMap((r) => Array.from({ length: r.faces }, (_, face) => this.placed.get(`${r.id}:${face}`)!)));
  }
  /** @internal All faces of a light use its packed resolution. */
  protected override mapResolution(kind: string, index: number, width: number, height: number): readonly [number, number] {
    const size = this.resolutions.get(`${kind}:${index}`);
    return size ? [size, size] : [width, height];
  }
  /** @internal Publish layer origins for comparison and blocker taps; a face whose tile moved re-renders alone. */
  protected override placeMaps(c: Context, layers: number, dirty: Uint8Array): void {
    if (layers !== this.tiles.length) throw new MargoError('state', 'Atlas face plan changed; update lights before rendering');
    const size = this.options.resolution!, rects = this.rects;
    let changed = !this.written;
    this.tiles.forEach((tile, layer) => {
      const o = layer * 4, x = tile.x / size, y = tile.y / size, w = tile.size / size;
      if (rects[o] === x && rects[o + 1] === y && rects[o + 2] === w && rects[o + 3] === w) return;
      rects.set([x, y, w, w], o);
      dirty[layer] = 1;
      changed = true;
    });
    // A layer out of use forgets its rectangle: its tile may be redrawn by another face before the layer returns.
    rects.fill(NaN, this.tiles.length * 4);
    if (changed) c.device.queue.writeBuffer(this.buffer!, 0, rects as Float32Array<ArrayBuffer>);
    this.written = true;
  }
  /** @internal Pixel origin for depth rendering. */
  protected override mapOrigin(layer: number): readonly [number, number] { return [this.tiles[layer].x, this.tiles[layer].y]; }
  /** Shader composition remaps every comparison and blocker read to its guarded tile on physical layer zero. */
  override declarations(group: number): string {
    return `struct ShadowAtlasRects {rects:array<vec4f,256>}
@group(${group}) @binding(155) var<uniform> shadowAtlas:ShadowAtlasRects;
fn atlasCompare(uv:vec2f,layer:i32,depth:f32)->f32 {let r=shadowAtlas.rects[u32(layer)];let half=0.5/vec2f(textureDimensions(localShadowMap));
return textureSampleCompareLevel(localShadowMap,localShadowSampler,clamp(uv+r.xy,r.xy+half,r.xy+r.zw-half),0,depth);}
fn atlasLoad(p:vec2i,layer:i32,level:i32)->f32 {let r=shadowAtlas.rects[u32(layer)];let size=vec2f(textureDimensions(localShadowMap));let start=vec2i(r.xy*size);
return textureLoad(localShadowMap,clamp(p+start,start,start+vec2i(r.zw*size)-1),0,level);}
` + super.declarations(group)
      .replaceAll('textureSampleCompareLevel(localShadowMap,localShadowSampler,', 'atlasCompare(')
      .replaceAll('textureLoad(localShadowMap,', 'atlasLoad(');
  }
  /** Atlas rectangle binding beside the standard LocalShadows entries. */
  override bindings(): GPUBindGroupEntry[] {
    const base = super.bindings();
    if (base !== this.baseEntries) {
      this.baseEntries = base;
      this.atlasEntries = [...base, { binding: 155, resource: { buffer: this.buffer! } }];
    }
    return this.atlasEntries!;
  }
  /** Allocate the rectangle table and the shared depth atlas. */
  override setup(engine: Engine): void {
    this.buffer?.destroy();
    if (!engine.gpu) throw new MargoError('unsupported', 'ShadowAtlas needs WebGPU or full WebGL2; enable the compatibility backend');
    this.buffer = engine.gpu.createBuffer({ size: this.rects.byteLength, usage: 64 | 8 });
    this.written = false;
    this.rects.fill(NaN);
    this.placed.clear();
    this.allocator = undefined;
    this.baseEntries = undefined;
    try { super.setup(engine); } catch (error) { this.buffer.destroy(); this.buffer = undefined; throw error; }
  }
  /** Release owned atlas resources; registered casters remain caller-owned. */
  override dispose(): void { super.dispose(); this.buffer?.destroy(); this.buffer = undefined; }
}

function projectedCoverage(c: Context, center: ArrayLike<number>, radius: number): number {
  const [width, height] = viewSize(c), m = c.camera.matrix;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  let minW = Infinity, maxW = -Infinity;
  for (let i = 0; i < 8; i++) {
    const x = center[0] + (i & 1 ? radius : -radius), y = center[1] + (i & 2 ? radius : -radius),
      z = center[2] + (i & 4 ? radius : -radius), w = m[3] * x + m[7] * y + m[11] * z + m[15];
    minW = Math.min(minW, w); maxW = Math.max(maxW, w);
  }
  if (maxW <= 0) return 0;
  if (minW <= 0) return Math.max(width, height);
  for (let i = 0; i < 8; i++) {
    const x = center[0] + (i & 1 ? radius : -radius), y = center[1] + (i & 2 ? radius : -radius),
      z = center[2] + (i & 4 ? radius : -radius), w = m[3] * x + m[7] * y + m[11] * z + m[15];
    const px = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      py = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
  }
  return Math.max(Math.max(0, Math.min(1, x1) - Math.max(-1, x0)) * width / 2,
    Math.max(0, Math.min(1, y1) - Math.max(-1, y0)) * height / 2);
}
