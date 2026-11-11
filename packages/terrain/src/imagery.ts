/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: OGC WMTS 1.0 / Simple Profile, Tanner et al. 1998, Losasso and Hoppe 2004.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type FrameGraph } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import type { Terrain, TerrainLighting } from './index.js';
import type { PlanetTerrain } from './planet.js';
import type { TerrainVirtualTexture } from './rvt.js';
/** The shift of a terrain without a floating origin. */
const NO_SHIFT: readonly number[] = [0, 0, 0];

/** Rectangle [minimum X, minimum Z, maximum X, maximum Z], or planet [west,south,east,north] in degrees. */
export type ImageryBounds = readonly [number, number, number, number];
/** A north-origin tile address. */
export interface ImageryTile {
  /** Zoom. */ level: number /** Column. */;
  x: number /** Row. */;
  y: number;
}
/** Tiled imagery, decoded in the browser; a custom loader may return an ImageBitmap or RGBA bytes. */
export interface TiledImagerySource {
  /** Tile URL, with optional {z}, {x}, {y} placeholders, or a URL function. */
  url: string | ((tile: ImageryTile) => string);
  /** Tile side in pixels. Default 256. */ tileSize?: number;
  /** Projection on planets. Default mercator. */ projection?: 'mercator' | 'geographic';
  /** Columns at level zero (geographic WMTS commonly uses 2). Default 1. */ columns?: number;
  /** Lowest available zoom. Default 0. */ minLevel?: number;
  /** Highest available zoom. Default 18. */ maxLevel?: number;
  /** Credit retained by the collection for display by the application. */ attribution?: string;
  /** Custom authenticated or cached fetch/decode, honoring signal; byte data is straight RGBA in sRGB. */
  load?: (tile: ImageryTile, signal: AbortSignal) => Promise<ImageBitmap | Uint8Array>;
}
/** A borrowed GPU texture. The factory runs again on restoration; the collection never destroys it. */
export interface TextureImagerySource {
  /** A single-layer filterable RGBA 2D texture with TEXTURE_BINDING. */ texture: (device: GPUDevice) => GPUTexture;
  /** Credit for application display. */ attribution?: string;
}
/** Source of one imagery layer. */
export type ImagerySource = TiledImagerySource | TextureImagerySource;
/** Live display properties; call set() to apply a change. */
export interface ImageryLayerOptions {
  /** Source; fixed for the lifetime of this layer. */ source: ImagerySource;
  /** Clip bounds, also the texture extent for GPU sources. Default the terrain bounds, or the whole planet. */ bounds?: ImageryBounds;
  /** Straight alpha multiplier 0..1. Default 1. */ alpha?: number;
  /** Linear-light brightness multiplier, 0 or greater. Default 1. */ brightness?: number;
  /** Visibility. Default true. */ show?: boolean;
}
/** Fixed collection options. */
export interface TerrainImageryOptions {
  /** Bake imagery through this borrowed clipmap RVT, before later surface providers such as vector overlays. Default none. */
  virtualTexture?: TerrainVirtualTexture;
  /** Clipmap extent corresponding to the full tile pyramid. Default terrain origin/size. */ bounds?: ImageryBounds;
  /** Maximum layers, 1..8 (also subject to device resource limits). Default 4. */ maxLayers?: number;
  /** Resident tiles per layer, 4..256. Default 64. */ maxTiles?: number;
  /** Simultaneous requests per collection, 1..16. Default 4. */ concurrency?: number;
  /** Camera-driven tile selection. Default true; update() remains available for deterministic/offline use. */ automatic?: boolean;
}
/** WMTS GetTile parameters. REST templates may use {TileMatrix}, {TileRow}, {TileCol}. */
export interface WMTSImageryOptions extends Omit<TiledImagerySource, 'url'> {
  /** Service URL or REST tile template. */ url: string;
  /** Layer identifier. */ layer: string;
  /** Tile matrix set identifier. */ matrixSet: string;
  /** Explicit matrix identifiers in zoom order. Default decimal zoom strings. */ matrices?: readonly string[];
  /** Style identifier. Default default. */ style?: string;
  /** MIME type. Default image/png. */ format?: string;
  /** Extra dimensions such as TIME, included in every request. */ dimensions?: Readonly<Record<string, string>>;
}
/** XYZ source using north-origin rows. No network work occurs before attachment/update. */
export function xyzImagery(url: string, options: Omit<TiledImagerySource, 'url'> = {}): TiledImagerySource {
  return { ...options, url };
}
/** OGC WMTS REST or KVP source, including named tile matrices, styles and dimensions. */
export function wmtsImagery(options: WMTSImageryOptions): TiledImagerySource {
  const {
    url,
    layer,
    matrixSet,
    matrices,
    style = 'default',
    format = 'image/png',
    dimensions = {},
    ...rest
  } = options;
  if (!url || !layer || !matrixSet || (matrices && !matrices.length))
    throw new TypeError('Invalid WMTS source; give url, layer, matrixSet and nonempty matrices when supplied.');
  return {
    ...rest,
    maxLevel: rest.maxLevel ?? (matrices ? matrices.length - 1 : 18),
    url: (tile) => {
      const values: Record<string, string> = {
        ...dimensions,
        Layer: layer,
        Style: style,
        TileMatrixSet: matrixSet,
        TileMatrix: matrices?.[tile.level] ?? String(tile.level),
        TileRow: String(tile.y),
        TileCol: String(tile.x),
      };
      if (url.includes('{Tile')) return url.replace(/\{([^}]+)\}/g, (_, key) => encodeURIComponent(values[key] ?? key));
      const result = new URL(url);
      for (const [key, value] of Object.entries({
        SERVICE: 'WMTS',
        REQUEST: 'GetTile',
        VERSION: '1.0.0',
        FORMAT: format,
        ...values,
      }))
        result.searchParams.set(key.toUpperCase(), value);
      return result.href;
    },
  };
}

function rect(bounds: ImageryBounds): ImageryBounds {
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every(Number.isFinite) ||
    bounds[0] >= bounds[2] ||
    bounds[1] >= bounds[3]
  )
    throw new RangeError('Invalid imagery bounds; give four finite increasing rectangle coordinates.');
  return [bounds[0], bounds[1], bounds[2], bounds[3]];
}
function integer(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}
function tiled(source: ImagerySource): source is TiledImagerySource {
  return !('texture' in source);
}
function tileKey(t: ImageryTile): string {
  return `${t.level}/${t.x}/${t.y}`;
}
/**
 * Bounded nested tile windows with coarse parents first; rows clamp at the poles. Columns wrap in longitude, or with
 * `wrap` false (a clipmap rectangle) clamp at the east and west edges.
 */
export function imageryTiles(
  center: readonly [number, number],
  level: number,
  capacity = 64,
  columns = 1,
  minLevel = 0,
  wrap = true,
): ImageryTile[] {
  if (
    center.length !== 2 ||
    !center.every(Number.isFinite) ||
    !integer(level, 0, 22) ||
    !integer(minLevel, 0, level) ||
    !integer(capacity, 4, 256) ||
    !integer(columns, 1, 2)
  )
    throw new RangeError(
      'Invalid imagery window; give finite center, levels 0..22, capacity 4..256 and columns 1 or 2.',
    );
  const out = new Map<string, ImageryTile>();
  // Reserve fine tiles first, then sort coarse-first for deterministic parent fallback.
  for (let z = level; z >= minLevel; z--) {
    const rows = 2 ** z,
      cols = rows * columns;
    const cx = wrap ? Math.floor(center[0] * cols) : Math.min(cols - 1, Math.max(0, Math.floor(center[0] * cols))),
      cy = Math.min(rows - 1, Math.max(0, Math.floor(center[1] * rows)));
    const offsets = z === level ? [0, -1, 1, -2, 2] : [0, -1, 1];
    for (const dy of offsets)
      for (const dx of offsets) {
        const y = cy + dy,
          x = wrap ? (((cx + dx) % cols) + cols) % cols : cx + dx;
        if (y < 0 || y >= rows || x < 0 || x >= cols) continue;
        const tile = { level: z, x, y },
          key = tileKey(tile);
        if (!out.has(key) && out.size < capacity - columns) out.set(key, tile);
      }
  }
  // The center's own minLevel tile (minLevel has columns * 2^minLevel columns), then a neighbour: east, or west at
  // a clipmap's east edge.
  const cols = columns * 2 ** minLevel,
    floor = Math.floor(center[0] * cols),
    cx = wrap ? floor : Math.min(cols - 1, Math.max(0, floor)),
    cy = Math.min(2 ** minLevel - 1, Math.max(0, Math.floor(center[1] * 2 ** minLevel)));
  for (let k = 0; k < columns; k++) {
    const x = !wrap && cx + k >= cols ? cx - k : cx + k,
      t = { level: minLevel, x: ((x % cols) + cols) % cols, y: cy };
    out.set(tileKey(t), t);
  }
  return [...out.values()].sort((a, b) => a.level - b.level || a.y - b.y || a.x - b.x);
}

interface Layer {
  id: number;
  options: Required<Omit<ImageryLayerOptions, 'source'>> & { source: ImagerySource };
  texture?: GPUTexture;
  cache: Map<string, { tile: ImageryTile; slot: number }>;
  controller?: AbortController;
  generation: number;
  owned: boolean;
}
let nextId = 0;
/** Ordered draped imagery on clipmap or planet terrain. No geometry offsets, extra terrain draws or core changes. */
export class TerrainImagery implements EnginePlugin, TerrainLighting, Disposable {
  readonly name = 'terrain-imagery:' + nextId++;
  /** Engine owning the collection while attached. */ owner?: Engine;
  /** Whether resources and registration have been released. */ disposed = false;
  /** Most recent asynchronous load error; update() also rejects with it. No automatic retries. */ error?: unknown;
  readonly #layers: Layer[] = [];
  readonly #options: Required<Omit<TerrainImageryOptions, 'virtualTexture'>>;
  readonly #virtual?: TerrainVirtualTexture;
  readonly #planet: boolean;
  #device?: GPUDevice;
  #buffer?: GPUBuffer;
  #sampler?: GPUSampler;
  #remove?: () => void;
  #next = 0;
  #code = new Map<string, string>();
  #view = '';
  #pending: Promise<void> = Promise.resolve();
  #center: [number, number] = [0.5, 0.5];
  #level = 0;

  constructor(
    private readonly terrain: Terrain | PlanetTerrain,
    options: TerrainImageryOptions = {},
  ) {
    if (!terrain || typeof terrain.addLighting !== 'function')
      throw new TypeError('Invalid imagery terrain; pass Terrain or PlanetTerrain.');
    this.#planet = 'radius' in terrain;
    this.#virtual = options.virtualTexture;
    if (this.#virtual && (this.#planet || typeof this.#virtual.addSurface !== 'function'))
      throw new TypeError(
        'Imagery virtualTexture requires a clipmap RVT; use a clipmap terrain and live TerrainVirtualTexture.',
      );
    const map = 'options' in terrain ? terrain.options : undefined;
    const origin = map?.origin ?? [0, 0];
    this.#options = {
      bounds: rect(
        options.bounds ??
          (this.#planet
            ? [-180, -90, 180, 90]
            : [origin[0], origin[1], origin[0] + map!.size[0], origin[1] + map!.size[1]]),
      ),
      maxLayers: options.maxLayers ?? 4,
      maxTiles: options.maxTiles ?? 64,
      concurrency: options.concurrency ?? 4,
      automatic: options.automatic ?? true,
    };
    if (
      !integer(this.#options.maxLayers, 1, 8) ||
      !integer(this.#options.maxTiles, 4, 256) ||
      !integer(this.#options.concurrency, 1, 16)
    )
      throw new RangeError('Invalid imagery capacity; give maxLayers 1..8, maxTiles 4..256 and concurrency 1..16.');
  }
  /** Attaches the collection to the same engine as its terrain. */
  static attach(
    engine: EngineKernel,
    terrain: Terrain | PlanetTerrain,
    options: TerrainImageryOptions = {},
  ): TerrainImagery {
    const imagery = new TerrainImagery(terrain, options);
    engineRuntime(engine).use(imagery);
    return imagery;
  }
  /** Number of ordered layers. */ get length(): number {
    return this.#layers.length;
  }
  /** Layer IDs from bottom to top. */ get order(): readonly number[] {
    return this.#layers.map((l) => l.id);
  }
  /** Unique nonempty source credits for the application to display. */
  get credits(): readonly string[] {
    return [...new Set(this.#layers.map((l) => l.options.source.attribution).filter((v): v is string => !!v))];
  }
  /** Latest camera/update load, rejecting on a failed request. */ get ready(): Promise<void> {
    return this.#pending;
  }
  #live(): void {
    if (this.disposed) throw new MargoError('disposed', 'Imagery is disposed; attach a new collection.');
  }
  #layer(id: number): Layer {
    const l = this.#layers.find((v) => v.id === id);
    if (!l) throw new RangeError('Unknown imagery layer; use an ID returned by add().');
    return l;
  }
  /** Adds a layer at index (default top), returning its stable ID. */
  add(options: ImageryLayerOptions, index = this.length): number {
    this.#live();
    if (this.length === this.#options.maxLayers || !integer(index, 0, this.length))
      throw new RangeError('Imagery collection is full or index invalid; remove a layer or use an index in 0..length.');
    const source = options?.source;
    if (
      !source ||
      (tiled(source)
        ? !(typeof source.url === 'string' || typeof source.url === 'function')
        : typeof source.texture !== 'function')
    )
      throw new TypeError('Invalid imagery source; give an XYZ/WMTS source or a texture factory.');
    if (
      tiled(source) &&
      (!integer(source.tileSize ?? 256, 1, 4096) ||
        !integer(source.columns ?? 1, 1, 2) ||
        !integer(source.minLevel ?? 0, 0, 22) ||
        !integer(source.maxLevel ?? 18, source.minLevel ?? 0, 22) ||
        !['mercator', 'geographic'].includes(source.projection ?? 'mercator'))
    )
      throw new RangeError(
        'Invalid tile source; give tileSize 1..4096, columns 1 or 2 and increasing levels in 0..22, with mercator or geographic projection.',
      );
    const layer: Layer = {
      id: this.#next++,
      options: { source, bounds: this.#options.bounds, alpha: 1, brightness: 1, show: true },
      cache: new Map(),
      generation: 0,
      owned: tiled(source),
    };
    this.#properties(layer, options);
    if (this.#device) this.#createLayer(layer);
    this.#layers.splice(index, 0, layer);
    this.#changed();
    this.#schedule();
    return layer.id;
  }
  #properties(layer: Layer, changes: Partial<Omit<ImageryLayerOptions, 'source'>>): void {
    const next = { ...layer.options, ...changes, bounds: rect(changes.bounds ?? layer.options.bounds) };
    if (
      !(next.alpha >= 0 && next.alpha <= 1) ||
      !Number.isFinite(next.brightness) ||
      next.brightness < 0 ||
      typeof next.show !== 'boolean'
    )
      throw new RangeError('Invalid imagery style; give alpha 0..1, finite brightness >=0 and boolean show.');
    if (this.#planet && (next.bounds[0] < -180 || next.bounds[2] > 180 || next.bounds[1] < -90 || next.bounds[3] > 90))
      throw new RangeError(
        'Invalid planet bounds; give west/east in -180..180 and south/north in -90..90. Split antimeridian rectangles into two layers.',
      );
    layer.options = next;
  }
  /** Changes bounds, alpha, brightness or visibility atomically. */
  set(id: number, changes: Partial<Omit<ImageryLayerOptions, 'source'>>): void {
    this.#live();
    this.#properties(this.#layer(id), changes);
    this.#write();
  }
  /** Moves a layer to index, 0 is bottom. */
  move(id: number, index: number): void {
    this.#live();
    if (!integer(index, 0, this.length - 1)) throw new RangeError('Invalid layer index; use 0..length-1.');
    const l = this.#layer(id);
    this.#layers.splice(this.#layers.indexOf(l), 1);
    this.#layers.splice(index, 0, l);
    this.#changed();
  }
  /** Removes a layer, cancels its requests and releases owned textures. */
  remove(id: number): boolean {
    this.#live();
    const i = this.#layers.findIndex((l) => l.id === id);
    if (i < 0) return false;
    const l = this.#layers[i];
    l.controller?.abort();
    if (l.owned) l.texture?.destroy();
    this.#layers.splice(i, 1);
    this.#changed();
    return true;
  }

  setup(engine: Engine): void {
    this.#live();
    requireWebGPU(engine, 'TerrainImagery');
    if ('owner' in this.terrain && this.terrain.owner && this.terrain.owner !== engine)
      throw new MargoError('attached', 'Imagery and terrain must belong to the same engine; attach them together.');
    this.owner = engine;
    this.#device = engine.gpu;
    // Terrain root can use up to 9 sampled textures. Reserve that headroom even on a planet.
    if (this.#options.maxLayers + 9 > engine.gpu.limits.maxSampledTexturesPerShaderStage)
      throw new RangeError('Imagery layer capacity exceeds device sampled-texture limits; lower maxLayers.');
    this.#buffer = engine.gpu.createBuffer({
      size: this.#options.maxLayers * (2 + this.#options.maxTiles) * 16,
      usage: 0x80 | 0x8,
    });
    this.#sampler = engine.gpu.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
    for (const l of this.#layers) this.#createLayer(l);
    this.#remove ??= this.#virtual ? this.#virtual.addSurface(this) : this.terrain.addLighting(this);
    this.#changed();
    this.#schedule();
  }
  #createLayer(l: Layer): void {
    const d = this.#device!,
      s = l.options.source;
    if (tiled(s)) {
      const size = s.tileSize ?? 256;
      if (size > d.limits.maxTextureDimension2D || this.#options.maxTiles > d.limits.maxTextureArrayLayers)
        throw new RangeError('Imagery cache exceeds texture limits; lower tileSize or maxTiles.');
      l.texture = d.createTexture({
        size: [size, size, this.#options.maxTiles],
        format: 'rgba8unorm-srgb',
        usage: 0x4 | 0x2 | 0x10,
      });
    } else {
      const t = s.texture(d);
      if (
        !t ||
        t.dimension !== '2d' ||
        t.sampleCount !== 1 ||
        t.depthOrArrayLayers !== 1 ||
        !(t.usage & 0x4) ||
        !['rgba8unorm', 'rgba8unorm-srgb', 'rgba16float', 'bgra8unorm', 'bgra8unorm-srgb'].includes(t.format)
      )
        throw new TypeError(
          'Invalid imagery texture; return a single-sample, single-layer filterable RGBA 2D texture with TEXTURE_BINDING.',
        );
      l.texture = t;
    }
  }
  #changed(): void {
    this.#code.clear();
    this.#write();
    this.#virtual?.refreshSurfaces();
  }
  /**
   * With a terrain's `floatingOrigin`, its anchor (origin at construction): the shader's XZ are relative to it, so the
   * bounds are written less it, in float64 first. Undefined otherwise (planets keep their own origin handling).
   */
  #anchor(): readonly [number, number] | undefined {
    return this.#planet ? undefined : (this.terrain as Terrain).anchor;
  }
  #write(): void {
    if (!this.#device || !this.#buffer) return;
    const stride = (2 + this.#options.maxTiles) * 4,
      values = new Float32Array(stride * this.#options.maxLayers),
      [ax, az] = this.#anchor() ?? [0, 0];
    this.#layers.forEach((l, i) => {
      const at = i * stride,
        o = l.options,
        b = o.bounds;
      values.set(this.#anchor() ? [b[0] - ax, b[1] - az, b[2] - ax, b[3] - az] : b, at);
      values.set(
        [
          o.show ? o.alpha : 0,
          o.brightness,
          tiled(o.source) ? 1 : 0,
          tiled(o.source) && o.source.projection !== 'geographic' ? 1 : 0,
        ],
        at + 4,
      );
      // A GPU source is one tile spanning its bounds, in the same pyramid space as tiled sources, so both paths
      // sample through identical arithmetic (a separate geographic formula rounded differently on Metal).
      if (!tiled(o.source)) {
        const b = o.bounds,
          c = this.#options.bounds;
        values.set(
          this.#planet
            ? [(b[0] + 180) / 360, (90 - b[3]) / 180, (b[2] - b[0]) / 360, (b[3] - b[1]) / 180]
            : [
                (b[0] - c[0]) / (c[2] - c[0]),
                (b[1] - c[1]) / (c[3] - c[1]),
                (b[2] - b[0]) / (c[2] - c[0]),
                (b[3] - b[1]) / (c[3] - c[1]),
              ],
          at + 8,
        );
      }
      for (const { tile: t, slot } of l.cache.values()) {
        const rows = 2 ** t.level,
          cols = rows * ((o.source as TiledImagerySource).columns ?? 1);
        values.set([t.x / cols, t.y / rows, 1 / cols, 1 / rows], at + 8 + slot * 4);
      }
    });
    this.#device.queue.writeBuffer(this.#buffer, 0, values);
    this.#virtual?.invalidate();
  }
  #schedule(): void {
    if (!this.#device || this.disposed) return;
    this.update(this.#center, this.#level);
  }
  /** Loads nested windows about normalized XZ, or longitude/latitude (north=0) on planets, at zoom level. */
  update(center: readonly [number, number] = this.#center, level = this.#level, signal?: AbortSignal): Promise<void> {
    this.#pending = this.#load(center, level, signal);
    // Observe background rejection while preserving the rejecting promise returned to the caller.
    void this.#pending.catch((error: unknown) => {
      this.error = error;
    });
    return this.#pending;
  }
  async #load(center: readonly [number, number], level: number, signal?: AbortSignal): Promise<void> {
    this.#live();
    if (center.length !== 2 || !center.every(Number.isFinite) || !integer(level, 0, 22))
      throw new RangeError('Invalid imagery view; give finite normalized center and zoom in 0..22.');
    signal?.throwIfAborted();
    this.#center = [...center];
    this.#level = level;
    if (!this.#device) return;
    const device = this.#device,
      jobs: (() => Promise<void>)[] = [],
      layerLoads: Promise<void[]>[] = [];
    for (const l of this.#layers) {
      const source = l.options.source;
      if (!tiled(source)) continue;
      l.controller?.abort();
      const controller = new AbortController();
      l.controller = controller;
      const generation = ++l.generation;
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const z = Math.max(source.minLevel ?? 0, Math.min(source.maxLevel ?? 18, level));
      const selected: [number, number] = [center[0], center[1]];
      if (this.#planet && source.projection !== 'geographic') {
        const lat = (Math.max(-85.05112878, Math.min(85.05112878, 90 - center[1] * 180)) * Math.PI) / 180;
        selected[1] = (1 - Math.log(Math.tan(Math.PI / 4 + lat / 2)) / Math.PI) / 2;
      }
      // Only planets wrap in longitude: a clipmap camera past an edge selects that edge's tiles, not the far side.
      const tiles = imageryTiles(
        selected,
        z,
        this.#options.maxTiles,
        source.columns ?? 1,
        source.minLevel ?? 0,
        this.#planet,
      );
      const wanted = new Set(tiles.map(tileKey));
      for (const key of l.cache.keys()) if (!wanted.has(key)) l.cache.delete(key);
      const free = Array.from({ length: this.#options.maxTiles }, (_, k) => k).filter(
        (slot) => ![...l.cache.values()].some((v) => v.slot === slot),
      );
      const tasks: Promise<void>[] = [];
      for (const tile of tiles) {
        const key = tileKey(tile);
        if (l.cache.has(key)) continue;
        const slot = free.shift()!;
        let resolve!: () => void, reject!: (e: unknown) => void;
        tasks.push(
          new Promise<void>((yes, no) => {
            resolve = yes;
            reject = no;
          }),
        );
        jobs.push(async () => {
          let image: ImageBitmap | Uint8Array | undefined;
          try {
            controller.signal.throwIfAborted();
            if (source.load) image = await source.load(tile, controller.signal);
            else {
              const url =
                typeof source.url === 'function'
                  ? source.url(tile)
                  : source.url.replace(/\{([zxy])\}/g, (_, k) =>
                      String(k === 'z' ? tile.level : k === 'x' ? tile.x : tile.y),
                    );
              const response = await fetch(url, { signal: controller.signal });
              if (!response.ok)
                throw new MargoError(
                  'failed',
                  `Imagery HTTP ${response.status} for ${url}; check the provider URL and permissions.`,
                );
              image = await createImageBitmap(await response.blob(), {
                colorSpaceConversion: 'none',
                premultiplyAlpha: 'none',
              });
            }
            controller.signal.throwIfAborted();
            if (l.generation !== generation || this.disposed || this.#device !== device) {
              resolve();
              return;
            }
            const size = source.tileSize ?? 256;
            if (image instanceof Uint8Array) {
              if (image.length !== size * size * 4)
                throw new RangeError('Invalid imagery tile bytes; return tileSize squared RGBA pixels.');
              device.queue.writeTexture(
                { texture: l.texture!, origin: [0, 0, slot] },
                image as Uint8Array<ArrayBuffer>,
                { bytesPerRow: size * 4 },
                [size, size],
              );
            } else {
              if (image.width !== size || image.height !== size)
                throw new RangeError('Invalid imagery tile dimensions; return a square image matching tileSize.');
              device.queue.copyExternalImageToTexture(
                { source: image },
                { texture: l.texture!, origin: [0, 0, slot] },
                [size, size],
              );
            }
            l.cache.set(key, { tile, slot });
            this.#write();
            resolve();
          } catch (error) {
            if (controller.signal.aborted && !signal?.aborted) resolve();
            else reject(error);
          } finally {
            if (image && !(image instanceof Uint8Array)) image.close();
          }
        });
      }
      // Attach handlers before workers can reject; cleanup signal listeners once this layer's jobs finish.
      const done = Promise.all(tasks).finally(() => signal?.removeEventListener('abort', abort));
      void done.catch(() => {});
      layerLoads.push(done);
    }
    this.#write();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(jobs.length, this.#options.concurrency) }, async () => {
        while (cursor < jobs.length) await jobs[cursor++]();
      }),
    );
    await Promise.all(layerLoads);
    this.error = undefined;
  }

  /** Shader effect resources in the terrain's group 1. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.length || !this.#buffer || !this.#sampler) return [];
    return [
      { binding: 98, resource: this.#sampler },
      { binding: 99, resource: { buffer: this.#buffer } },
      ...this.#layers.map((l, i) => ({ binding: 100 + i, resource: l.texture!.createView({ dimension: '2d-array' }) })),
    ];
  }
  /** Adds ordered linear-light alpha composition immediately before terrain lighting. */
  shader(source: string, group: number): string {
    if (!this.length) return source;
    const key = group + source,
      cached = this.#code.get(key);
    if (cached) return cached;
    const marker = this.#planet ? 'let nl=clamp(dot(n,planet.light.xyz)' : 'let base=terrainColor(i.position,';
    let patched: string;
    if (this.#virtual) {
      if (!source.includes('return terrainSurfaceColor;'))
        throw new MargoError(
          'unsupported',
          'Cached imagery needs the RVT surface hook; attach it through virtualTexture.',
        );
      patched = source.replace(
        'return terrainSurfaceColor;',
        'terrainSurfaceColor=terrainImagery(terrainSurfaceColor,vec3f(position.x,0.0,position.y));return terrainSurfaceColor;',
      );
    } else if (this.#planet) {
      if (!source.includes(marker))
        throw new MargoError(
          'unsupported',
          'Imagery needs the planet surface shader; attach it before a replacement shader.',
        );
      patched = source.replace(marker, 'base=terrainImagery(base,i.position);' + marker);
    } else {
      // Also composes after an RVT reader; the cache still owns only its ground, not imagery.
      const match = /let base=(terrainColor|terrainVirtualGround)\(i\.position,([^;]+);/.exec(source);
      if (!match)
        throw new MargoError(
          'unsupported',
          'Imagery needs the terrain color call; attach after RVT and before a replacement shader.',
        );
      patched = source.replace(
        match[0],
        `let base=terrainImagery(${match[1]}(i.position,${match[2]},i.position${this.#anchor() ? '+vec3f(frame.anchor.x,0.0,frame.anchor.y)' : ''});`,
      );
    }
    const anchor = this.#anchor(),
      whole = this.#options.bounds,
      bounds = anchor
        ? [whole[0] - anchor[0], whole[1] - anchor[1], whole[2] - anchor[0], whole[3] - anchor[1]]
        : whole,
      span = [whole[2] - whole[0], whole[3] - whole[1]];
    const coordinate = this.#planet
      ? 'let direction=normalize(position-planet.center.xyz);let geographic=vec2f(atan2(direction.z,direction.x)*57.295779513,asin(clamp(direction.y,-1.0,1.0))*57.295779513);let pyramid=vec2f((geographic.x+180.0)/360.0,(90.0-geographic.y)/180.0);'
      : `let geographic=position.xz;let pyramid=(geographic-vec2f(${bounds[0]},${bounds[1]}))/vec2f(${span[0]},${span[1]});`;
    const stride = 2 + this.#options.maxTiles;
    // Mercator rows on a planet: the pyramid's geographic y is (90 - lat) / 180, so dy/dlat is 1 / pi per radian, and
    // Mercator's (1 - ln(tan(pi / 4 + lat / 2)) / pi) / 2 has dy/dlat = sec(lat) / (2 pi): the gradients scale by
    // sec(lat) / 2 (batch 132b; it was sec(lat), one mip level too coarse, unseen while tiles carry one level).
    // Bindings 98 (sampler), 99 (rules) and 100 + layer (up to 107), clear of the other terrain entries (test/bindings.test.js).
    let code = `@group(${group}) @binding(98) var imagerySampler:sampler;\n@group(${group}) @binding(99) var<storage,read> imageryRules:array<vec4f>;\n`;
    this.#layers.forEach((_, i) => {
      code += `@group(${group}) @binding(${100 + i}) var imagery${i}:texture_2d_array<f32>;\n`;
    });
    code += `fn terrainImagery(base:vec3f,position:vec3f)->vec3f {${coordinate}let dx=dpdx(pyramid);let dy=dpdy(pyramid);var result=base;`;
    this.#layers.forEach((_, i) => {
      const at = i * stride;
      code += `{let box=imageryRules[${at}];let style=imageryRules[${at + 1}];var uv=pyramid;var sx=dx;var sy=dy;
        if(style.w>0.5&&${this.#planet ? 'true' : 'false'}){let lat=clamp(geographic.y,-85.05112878,85.05112878)*0.01745329252;uv.y=(1.0-log(tan(0.7853981634+lat*0.5))/3.14159265359)*0.5;let scale=0.5/max(cos(lat),0.086);sx.y*=scale;sy.y*=scale;}
        if(style.x>0.0&&all(geographic>=box.xy)&&all(geographic<=box.zw)){
          var slot=0;var tile=imageryRules[${at + 2}];var found=style.z<0.5;var smallest=2.0;
          if(style.z>0.5){for(var k=0;k<${this.#options.maxTiles};k++){let p=imageryRules[${at + 2}+k];if(p.z>0.0&&p.z<smallest&&all(uv>=p.xy)&&all(uv<=p.xy+p.zw)){slot=k;tile=p;smallest=p.z;found=true;}}}
          if(found){let d=vec2f(textureDimensions(imagery${i}));let tuv=clamp((uv-tile.xy)/tile.zw,vec2f(0.5)/d,vec2f(1)-vec2f(0.5)/d);let sample=textureSampleGrad(imagery${i},imagerySampler,tuv,slot,sx/tile.zw,sy/tile.zw);result=mix(result,sample.rgb*style.y,sample.a*style.x);}
        }} `;
    });
    code += 'return result;}\n';
    if (this.#virtual)
      code = code.replace(
        'let dx=dpdx(pyramid);let dy=dpdy(pyramid);',
        `let dx=terrainDx.xz/vec2f(${span[0]},${span[1]});let dy=terrainDy.xz/vec2f(${span[0]},${span[1]});`,
      );
    code += patched;
    this.#code.set(key, code);
    return code;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':view',
      order: -4,
      execute: (c) => {
        if (!this.#options.automatic || c.backend !== 'webgpu' || !this.#layers.some((l) => tiled(l.options.source)))
          return;
        const b = this.#options.bounds;
        let u: number, v: number, height: number, world: number;
        if ('radius' in this.terrain) {
          const center = this.terrain.localCenter,
            p = c.camera.position;
          const x = p[0] - center[0],
            y = p[1] - center[1],
            z = p[2] - center[2],
            length = Math.hypot(x, y, z);
          u = (Math.atan2(z, x) / Math.PI + 1) / 2;
          v = (1 - Math.asin(Math.max(-1, Math.min(1, y / (length || 1)))) / (Math.PI / 2)) / 2;
          height = Math.max(1, length - this.terrain.radius);
          world = 2 * Math.PI * this.terrain.radius;
        } else {
          // A floating origin's camera is local: the view is placed from its float64 world position.
          const p = c.camera.position,
            s = this.#anchor() ? (this.terrain as Terrain).shift : NO_SHIFT;
          u = (p[0] + s[0] - b[0]) / (b[2] - b[0]);
          v = (p[2] + s[2] - b[1]) / (b[3] - b[1]);
          height = Math.max(1, Math.abs(p[1] + s[1]));
          world = b[2] - b[0];
        }
        const level = Math.max(0, Math.min(22, Math.floor(Math.log2((world / height) * 2))));
        const view = `${Math.floor(u * 2 ** level)}/${Math.floor(v * 2 ** level)}/${level}`;
        if (view !== this.#view) {
          this.#view = view;
          this.#center = [u, v];
          this.#level = level;
          this.#schedule();
        }
      },
    });
  }
  /** Recreates owned caches and reacquires borrowed textures, rejecting stale in-flight results. */
  onDeviceRestored(engine: Engine): void {
    this.#release();
    this.#view = '';
    this.setup(engine);
  }
  #release(): void {
    for (const l of this.#layers) {
      l.controller?.abort();
      l.generation++;
      if (l.owned) l.texture?.destroy();
      l.texture = undefined;
      l.cache.clear();
    }
    this.#buffer?.destroy();
    this.#buffer = undefined;
    this.#device = undefined;
  }
  /** Cancels requests, removes the effect/scene registration and releases only owned resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#remove?.();
    this.#remove = undefined;
    this.#release();
    this.#code.clear();
    this.owner?.sceneOf(this)?.removePlugin(this.name);
    this.owner = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
