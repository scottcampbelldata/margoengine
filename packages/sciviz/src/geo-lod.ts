/// <reference lib="esnext.disposable" preserve="true" />
import { fault, rangeError } from '../../shared/errors.js';
import type { Projection, TileSource } from './geo.js';
import type { Figure } from './figure.js';
import type { Bounds } from './layer.js';
import { dataToClip } from './pick.js';
import { frameWGSL, requireGPU, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import { GeoTileCache } from './geo-lod-cache.js';
import { geoTileMesh, selectGeoTiles, type GeoLodSelection, type GeoTile, type GeoTileView } from './geo-lod-plan.js';
import { geoTilePixels, type GeoElevationSource } from './geo-elevation.js';
export { GeoTileCache } from './geo-lod-cache.js';
export {
  geoTileAncestors,
  geoTileChildren,
  geoTileHeight,
  geoTileKey,
  geoTileLonLat,
  geoTileMesh,
  selectGeoTiles,
} from './geo-lod-plan.js';
export type { GeoLodSelection, GeoTile, GeoTileElevation, GeoTileView } from './geo-lod-plan.js';
export {
  AWS_TERRARIUM,
  TERRARIUM_ATTRIBUTION,
  decodeTerrarium,
  geoTerrainStreamSource,
  quantizedGeoElevation,
  terrariumElevation,
} from './geo-elevation.js';
export type { GeoElevationSource } from './geo-elevation.js';

declare const GPUBufferUsage: { VERTEX: number; INDEX: number; UNIFORM: number; COPY_DST: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };

/** Camera-driven raster geography, height draping and globe quadtree refinement. */
export interface GeoLodOptions extends GeoLodSelection {
  readonly tiles: TileSource;
  readonly elevation?: GeoElevationSource;
  /** Total resident tiles, including visible leaves and fallback. Default 128; must exceed tileBudget. */
  readonly cacheTiles?: number;
  /** Concurrent tile requests, default 6. */
  readonly concurrency?: number;
  /** Fade duration in seconds, default 0.3. */
  readonly fadeSeconds?: number;
  /** Regular mesh subdivisions per tile, default 32. */
  readonly segments?: number;
  /** Downward edge skirt depth in metres, default 1000. */
  readonly skirt?: number;
  /** Provider credit, displayed in the figure corner. */
  readonly attribution?: string;
  readonly signal?: AbortSignal;
  /** Default fetch options for URL imagery. */
  readonly init?: RequestInit;
  /** Monotonic clock in seconds. Default performance.now()/1000. Inject for deterministic playback. */
  readonly clock?: () => number;
}
interface TileGpu {
  vertices: GPUBuffer;
  indices: GPUBuffer;
  uniform: GPUBuffer;
  texture: GPUTexture;
  group: GPUBindGroup;
  count: number;
}
interface TileData {
  pixels: ImageData;
  mesh: { vertices: Float32Array; indices: Uint32Array };
  /** Every texel has alpha 255, so the tile at full opacity draws without blending. */
  opaque: boolean;
  gpu?: TileGpu;
}
/** True when no texel is translucent. */
function opaqueTexels(pixels: ImageData): boolean {
  const data = pixels.data;
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  return true;
}
const shader = /* wgsl */ `${frameWGSL}
struct Tile { model: mat4x4f, params: vec4f }
@group(1) @binding(0) var<uniform> tile: Tile;
@group(1) @binding(1) var image: texture_2d<f32>;
@group(1) @binding(2) var imageSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) uv: vec2f }
@vertex fn vertex(@location(0) position: vec3f, @location(1) uv: vec2f) -> Out {
  var out: Out;
  out.clip = frame.clip * tile.model * vec4f(position, 1.0);
  out.uv = uv;
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let rgba = textureSample(image, imageSampler, in.uv);
  return vec4f(toOutput(rgba.rgb), rgba.a * tile.params.x);
}`;

/** Streaming layer. ready() reports load errors; error exposes failures from automatic camera updates. */
export class GeoLodLayer implements Drawable {
  visible = true;
  readonly transparent = true;
  readonly projection: Projection;
  readonly #figure: Figure;
  readonly #options: GeoLodOptions;
  readonly #cache: GeoTileCache<TileData>;
  readonly #model = new Float32Array(16);
  #layout!: GPUBindGroupLayout;
  #sampler!: GPUSampler;
  #note?: HTMLElement;
  #disposed = false;
  #drawn: { data: TileData; alpha: number }[] = [];
  #viewSignature = '';
  #noteSignal: AbortSignal | undefined;
  readonly #abort = () => this.dispose();
  /** @internal Use geoLodLayer. */
  constructor(figure: Figure, options: GeoLodOptions) {
    requireGPU(figure.renderer);
    options.signal?.throwIfAborted();
    this.#figure = figure;
    this.#options = options;
    this.projection = options.projection ?? 'mercator';
    const capacity = options.cacheTiles ?? 128,
      budget = options.tileBudget ?? 64;
    if (
      capacity <= budget ||
      !Number.isFinite(options.fadeSeconds ?? 0.3) ||
      (options.fadeSeconds ?? 0.3) < 0 ||
      !['mercator', 'plate', 'globe'].includes(this.projection) ||
      !['function', 'string'].includes(typeof options.tiles)
    )
      throw rangeError(
        'Geo LOD needs tiles, a projection, nonnegative fadeSeconds and cacheTiles greater than tileBudget',
        'sciviz',
      );
    // Validate mesh and selection before publishing or allocating device resources.
    geoTileMesh({ z: 0, x: 0, y: 0 }, this.projection, undefined, options.segments ?? 32, options.skirt ?? 1000);
    selectGeoTiles({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 1], width: 1, height: 1 }, options);
    this.#cache = new GeoTileCache((tile, signal) => this.#load(tile, signal), {
      capacity,
      concurrency: options.concurrency,
      drop: (data) => this.#drop(data),
      signal: options.signal,
    });
    this.#build();
    if (options.attribution) {
      const note = document.createElement('div');
      note.textContent = options.attribution;
      note.style.cssText =
        'position:absolute;bottom:3px;right:6px;font:10px sans-serif;background:#ffffffcc;color:#111;padding:2px 4px;pointer-events:none';
      (figure.renderer.engine as unknown as { canvas?: HTMLCanvasElement }).canvas?.parentElement?.append(note);
      this.#note = note;
    }
    this.#noteSignal = options.signal;
    this.#noteSignal?.addEventListener('abort', this.#abort, { once: true });
  }
  get bounds(): Bounds {
    return this.projection === 'globe'
      ? [-1.01, 1.01, -1.01, 1.01, -1.01, 1.01]
      : [-1, 1, this.projection === 'plate' ? -0.5 : -1, this.projection === 'plate' ? 0.5 : 1, -0.002, 0.002];
  }
  get selected(): readonly GeoTile[] {
    return this.#cache.selected;
  }
  get stats(): { resident: number; pending: number; missing: number; drawn: number } {
    return {
      resident: this.#cache.residents.length,
      pending: this.#cache.pending,
      missing: this.#cache.missing,
      drawn: this.#drawn.length,
    };
  }
  get error(): unknown {
    return this.#cache.error;
  }
  #now(): number {
    return this.#options.clock?.() ?? performance.now() / 1000;
  }
  #build(): void {
    const device = this.#figure.renderer.device!;
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }
  async #load(tile: GeoTile, signal: AbortSignal): Promise<TileData | undefined> {
    const source = this.#options.tiles;
    const imagery = async () => {
      if (typeof source === 'function') return source(tile.z, tile.x, tile.y, signal);
      const url = source.replace('{z}', String(tile.z)).replace('{x}', String(tile.x)).replace('{y}', String(tile.y));
      const r = await fetch(url, { ...this.#options.init, signal });
      if (r.status === 404) return undefined;
      if (!r.ok) throw fault('failed', `Map tile ${url} answered ${r.status}`, 'sciviz');
      return r.blob();
    };
    const [image, elevation] = await Promise.all([imagery(), this.#options.elevation?.(tile, signal)]);
    signal.throwIfAborted();
    if (!image) return undefined;
    const pixels = await geoTilePixels(image);
    signal.throwIfAborted();
    const mesh = geoTileMesh(
      tile,
      this.projection,
      elevation,
      this.#options.segments ?? 32,
      this.#options.skirt ?? 1000,
    );
    return { pixels, mesh, opaque: opaqueTexels(pixels) };
  }
  #upload(data: TileData): TileGpu {
    const device = this.#figure.renderer.device!;
    const buffer = (values: Float32Array | Uint32Array, usage: number) => {
      const b = device.createBuffer({ size: values.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(b, 0, values);
      return b;
    };
    const vertices = buffer(data.mesh.vertices, GPUBufferUsage.VERTEX),
      indices = buffer(data.mesh.indices, GPUBufferUsage.INDEX),
      uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const texture = device.createTexture({
      size: [data.pixels.width, data.pixels.height],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, data.pixels.data, { bytesPerRow: data.pixels.width * 4 }, [
      data.pixels.width,
      data.pixels.height,
    ]);
    const group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: this.#sampler },
      ],
    });
    return (data.gpu = { vertices, indices, uniform, texture, group, count: data.mesh.indices.length });
  }
  #drop(data: TileData): void {
    const g = data.gpu;
    if (g) {
      g.vertices.destroy();
      g.indices.destroy();
      g.uniform.destroy();
      g.texture.destroy();
      data.gpu = undefined;
    }
  }
  /** Supplies an explicit view; automatic frame updates use the figure camera and model. */
  updateView(view: GeoTileView, now = this.#now()): void {
    this.#cache.update(selectGeoTiles(view, this.#options), now);
  }
  /** Resolves current tile work, with optional cancellation of the wait. */
  ready(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    return this.#cache.ready(options);
  }
  /** @internal */
  setModel(model: Float32Array): void {
    this.#model.set(model);
  }
  /** @internal */
  center(): readonly [number, number, number] {
    return [this.#model[12], this.#model[13], this.#model[14]];
  }
  /** @internal */
  prepare(context: GpuContext): void {
    const now = this.#now(),
      matrix = dataToClip(context.camera.matrix, this.#model),
      signature = `${context.width},${context.height},${Array.from(matrix).join(',')}`;
    if (signature !== this.#viewSignature) {
      this.#viewSignature = signature;
      this.updateView({ matrix, width: context.width, height: context.height }, now);
    }
    // Refresh only the cache's clock, so a tile's fade starts on the frame it actually becomes resident.
    else this.#cache.update(this.#cache.selected, now);
    this.#drawn = this.#cache
      .drawTiles(now, this.#options.fadeSeconds ?? 0.3)
      .map((d) => ({ data: d.resident.value, alpha: d.opacity }));
    const values = new Float32Array(20);
    values.set(this.#model);
    for (const entry of this.#drawn) {
      const g = entry.data.gpu ?? this.#upload(entry.data);
      values[16] = entry.alpha;
      this.#figure.renderer.device!.queue.writeBuffer(g.uniform, 0, values);
    }
  }
  /** @internal Rebuilds device resources from retained pixels and meshes, without refetching. */
  restore(): void {
    for (const r of this.#cache.residents) this.#drop(r.value);
    this.#build();
  }
  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#drawn.length) return;
    // A fully opaque tile at full opacity replaces what is under it, so it skips the blend unit: on the RTX A6000
    // (D3D12) a src-alpha blend whose result is mathematically the source still changed one level at a few rounding
    // ties from frame to frame with identical commands (KB-GEO1); an unblended write is bit-stable. Fading and
    // translucent tiles keep the blend, in the same coarse-to-fine order.
    const pipeline = (blend: boolean) =>
      renderer.pipeline(blend ? 'geo-lod' : 'geo-lod-opaque', context, (target) => {
        const device = renderer.device!,
          module = device.createShaderModule({ code: shader, label: 'geo-lod' });
        return {
          layout: device.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout] }),
          vertex: {
            module,
            entryPoint: 'vertex',
            buffers: [
              {
                arrayStride: 20,
                attributes: [
                  { shaderLocation: 0, offset: 0, format: 'float32x3' },
                  { shaderLocation: 1, offset: 12, format: 'float32x2' },
                ],
              },
            ],
          },
          fragment: {
            module,
            entryPoint: 'fragment',
            targets: [
              blend
                ? {
                    format: target.format,
                    blend: {
                      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                    },
                  }
                : { format: target.format },
            ],
          },
          primitive: { topology: 'triangle-list', cullMode: 'back' },
          multisample: target.multisample,
          depthStencil: { format: target.depth, depthWriteEnabled: false, depthCompare: 'greater-equal' },
        };
      });
    let bound: boolean | undefined;
    for (const entry of this.#drawn) {
      const blend = entry.alpha < 1 || !entry.data.opaque;
      if (blend !== bound) pass.setPipeline(pipeline((bound = blend)));
      const g = entry.data.gpu!;
      pass.setBindGroup(1, g.group);
      pass.setVertexBuffer(0, g.vertices);
      pass.setIndexBuffer(g.indices, 'uint32');
      pass.drawIndexed(g.count);
    }
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#noteSignal?.removeEventListener('abort', this.#abort);
    this.#cache.dispose();
    this.#figure.renderer.remove(this);
    this.#note?.remove();
    this.#drawn = [];
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
/** Adds a view-driven map/globe. First frame selects tiles; await layer.ready() after rendering to await requests. */
export function geoLodLayer(figure: Figure, options: GeoLodOptions): GeoLodLayer {
  const layer = new GeoLodLayer(figure, options);
  figure.renderer.add(layer);
  try {
    return figure.addLayer(layer);
  } catch (error) {
    layer.dispose();
    throw error;
  }
}
