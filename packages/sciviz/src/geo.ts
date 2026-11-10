import { trackSpecLayer } from './spec-hooks.js';
// Geographic layers: map projections, slippy-map raster tiles and a globe under a figure's data layers.
// - Web Mercator (EPSG:3857 on the sphere; J. P. Snyder, "Map Projections: A Working Manual", USGS Professional Paper
//   1395, 1987, chapter 7), equirectangular (Snyder chapter 12) and the WGS 84 ellipsoid (NIMA TR8350.2, 3rd ed.,
//   a = 6378137 m, 1/f = 298.257223563) for the globe, geodetic to Earth-centred coordinates.
// - Tiles in the OpenStreetMap slippy-map scheme (z/x/y, 2^z by 2^z tiles of Web Mercator, y from the north).
// Data units: 'mercator' puts the world in [-1, 1] x [-1, 1] (x = lon / 180, y = Mercator northing / pi); 'plate'
// (equirectangular) in [-1, 1] x [-0.5, 0.5]; 'globe' is Earth-centred with the equatorial radius 1, z to the north
// pole. `project(lon, lat, height)` maps degrees and metres into the same units, so scatter and line layers sit on the
// map. Each tile draws as a 16 x 16 grid whose vertices the shader projects, so the globe is round and seams close.
import { rangeError, typeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';
import type { LayerAppearance } from './appearance.js';
import { frameWGSL, type Drawable, type GpuContext, type SciRenderer } from './render.js';
import type { Figure } from './figure.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
declare const GPUShaderStage: { VERTEX: number; FRAGMENT: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** A map projection of the figure's data frame. */
export type Projection = 'mercator' | 'plate' | 'globe';

/** WGS 84 equatorial radius in metres and first eccentricity squared. */
export const WGS84 = { a: 6378137, f: 1 / 298.257223563, e2: (2 - 1 / 298.257223563) / 298.257223563 } as const;
/** The latitude where the square Web Mercator world ends, in degrees. */
export const MERCATOR_MAX_LAT = (Math.atan(Math.sinh(Math.PI)) * 180) / Math.PI;

const RAD = Math.PI / 180;

// Snyder (1987) under equations 7-1 and 12-1: a longitude difference outside +-180 degrees has 360 added or taken
// away, so the point lands inside the map. +-180 itself stays, as the map's two edges.
const wrap = (lon: number) => (lon > 180 || lon < -180 ? ((((lon + 180) % 360) + 360) % 360) - 180 : lon);

/** Degrees and metres to the projection's data units: `[x, y, z]`. */
export function project(
  lon: number,
  lat: number,
  height = 0,
  projection: Projection = 'mercator',
): [number, number, number] {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(height))
    throw rangeError('project needs finite lon, lat and height', 'sciviz');
  if (!(lat >= -90 && lat <= 90)) throw rangeError(`Latitude ${lat} is outside -90 to 90 degrees`, 'sciviz');
  lon = wrap(lon);
  if (projection === 'globe') {
    const phi = lat * RAD,
      lambda = lon * RAD,
      s = Math.sin(phi),
      n = 1 / Math.sqrt(1 - WGS84.e2 * s * s),
      h = height / WGS84.a;
    return [
      (n + h) * Math.cos(phi) * Math.cos(lambda),
      (n + h) * Math.cos(phi) * Math.sin(lambda),
      (n * (1 - WGS84.e2) + h) * s,
    ];
  }
  if (projection === 'plate') return [lon / 180, lat / 180, height / WGS84.a];
  if (projection !== 'mercator') throw rangeError(`Unknown projection ${String(projection)}`, 'sciviz');
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * RAD;
  return [lon / 180, Math.asinh(Math.tan(clamped)) / Math.PI, height / WGS84.a];
}

/** The inverse of {@link project} for the planes: data `[x, y]` to `[lon, lat]` in degrees. */
export function unproject(
  x: number,
  y: number,
  projection: Exclude<Projection, 'globe'> = 'mercator',
): [number, number] {
  if (projection === 'plate') return [x * 180, y * 180];
  return [x * 180, (Math.atan(Math.sinh(y * Math.PI)) * 180) / Math.PI];
}

/** The tile `[x, y]` at `zoom` that holds a point, in the slippy-map scheme. */
export function tileAt(lon: number, lat: number, zoom: number): [number, number] {
  const n = 2 ** zoom,
    [x, y] = project(lon, lat, 0, 'mercator');
  return [
    Math.min(n - 1, Math.max(0, Math.floor(((x + 1) / 2) * n))),
    Math.min(n - 1, Math.max(0, Math.floor(((1 - y) / 2) * n))),
  ];
}

/** A tile's west, south, east and north edges in degrees. */
export function tileBounds(zoom: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** zoom;
  const [west, north] = unproject((x / n) * 2 - 1, 1 - (y / n) * 2);
  const [east, south] = unproject(((x + 1) / n) * 2 - 1, 1 - ((y + 1) / n) * 2);
  return [west, south, east, north];
}

/**
 * The tiles at `zoom` that cover a box given as west, south, east and north in degrees. A box whose west edge lies
 * east of its east edge crosses the 180th meridian and takes the tiles on both sides.
 */
export function tilesIn(box: readonly [number, number, number, number], zoom: number): [number, number, number][] {
  const [west, s, east, n] = box,
    w = wrap(west),
    e = wrap(east);
  if (w > e) {
    const both = [...tilesIn([w, s, 180, n], zoom), ...tilesIn([-180, s, e, n], zoom)];
    return both.filter(([, x, y], i) => both.findIndex(([, x2, y2]) => x2 === x && y2 === y) === i);
  }
  const [x0, y0] = tileAt(w, n, zoom),
    [x1, y1] = tileAt(e, s, zoom),
    out: [number, number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push([zoom, x, y]);
  return out;
}

/** Where tiles come from: a URL template with `{z}`, `{x}` and `{y}`, or a function giving each tile's image. */
export type TileSource =
  | string
  | ((z: number, x: number, y: number, signal?: AbortSignal) => Promise<Blob | ImageBitmap | ImageData | undefined>);

/** Options for a tile layer. */
export interface TileLayerOptions {
  /** Optional physical appearance, supplied by sciviz/atmosphere. Default headlight. */
  readonly appearance?: LayerAppearance;
  /** Where the tiles come from. Required. */
  readonly tiles: TileSource;
  /** The figure's projection. Default `'mercator'`. */
  readonly projection?: Projection;
  /** Zoom level of the tiles. Default 2 (16 tiles of the world). */
  readonly zoom?: number;
  /** Area to cover as west, south, east, north in degrees. Default the whole Mercator world. */
  readonly area?: readonly [number, number, number, number];
  /** Most tiles loaded. Default 256. */
  readonly maxTiles?: number;
  /** Credit the tile provider asks for; shown in the figure's corner. Default none. */
  readonly attribution?: string;
  /** Request options for URL tiles. */
  readonly init?: RequestInit;
  readonly signal?: AbortSignal;
}

const tileShader = /* wgsl */ `${frameWGSL}
struct Tile { model: mat4x4f, tile: vec4f, params: vec4f }
@group(1) @binding(0) var<uniform> tile: Tile;
@group(1) @binding(1) var image: texture_2d<f32>;
@group(1) @binding(2) var imageSampler: sampler;
struct Out { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) world: vec3f, @location(2) normal: vec3f }
const PI = 3.14159265358979;
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Out {
  let segments = u32(tile.params.x);
  let cell = index / 6u;
  let corner = index % 6u;
  let di = select(0u, 1u, corner == 1u || corner == 2u || corner == 4u);
  let dj = select(0u, 1u, corner == 2u || corner == 4u || corner == 5u);
  let u = f32(cell % segments + di) / f32(segments);
  let v = f32(cell / segments + dj) / f32(segments);
  let mx = (tile.tile.x + u) / tile.tile.z;
  let my = (tile.tile.y + v) / tile.tile.z;
  let lon = mx * 2.0 * PI - PI;
  let lat = atan(sinh(PI * (1.0 - 2.0 * my)));
  var data = vec3f(2.0 * mx - 1.0, 1.0 - 2.0 * my, 0.0);
  var normal = vec3f(0.0, 0.0, 1.0);
  if (tile.tile.w == 1.0) { data = vec3f(lon / PI, lat / PI, 0.0); }
  if (tile.tile.w == 2.0) {
    let s = sin(lat);
    let n = 1.0 / sqrt(1.0 - tile.params.y * s * s);
    data = vec3f(n * cos(lat) * cos(lon), n * cos(lat) * sin(lon), n * (1.0 - tile.params.y) * s);
    normal = vec3f(cos(lat) * cos(lon), cos(lat) * sin(lon), s);
  }
  let world = tile.model * vec4f(data, 1.0);
  var out: Out;
  out.clip = frame.clip * world;
  out.uv = vec2f(u, v);
  out.world = world.xyz;
  out.normal = normalize((tile.model * vec4f(normal, 0.0)).xyz);
  return out;
}
@fragment fn fragment(in: Out) -> @location(0) vec4f {
  let albedo = textureSampleLevel(image, imageSampler, in.uv, 0.0).rgb;
  var colour = albedo;
  if (tile.tile.w == 2.0) { colour = shade(albedo, in.normal, normalize(frame.eye.xyz - in.world)); }
  return vec4f(toOutput(colour), 1.0);
}`;

interface LoadedTile {
  readonly z: number;
  readonly x: number;
  readonly y: number;
  readonly pixels: ImageData;
  readonly texture: GPUTexture;
  readonly uniform: GPUBuffer;
  readonly group: GPUBindGroup;
}

const SEGMENTS = 16;

async function pixelsOf(image: Blob | ImageBitmap | ImageData): Promise<ImageData> {
  if (typeof ImageData !== 'undefined' && image instanceof ImageData) return image;
  const bitmap = image instanceof Blob ? await createImageBitmap(image) : (image as ImageBitmap);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
    g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) throw typeError('Tile images need an OffscreenCanvas 2D context', 'sciviz');
  g.drawImage(bitmap, 0, 0);
  return g.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Raster map tiles drawn on the figure's projection: a plane for `'mercator'` and `'plate'`, the WGS 84 ellipsoid for
 * `'globe'`. Create it with {@link tileLayer}, which resolves once the tiles are in.
 */
export class TileLayer implements Drawable {
  readonly #appearance: LayerAppearance | undefined;
  visible = true;
  readonly transparent = false;
  readonly projection: Projection;
  readonly zoom: number;
  readonly attribution: string | undefined;
  /** Tiles drawn, and tiles the source had none for. */
  loaded = 0;
  missing = 0;
  readonly #renderer: SciRenderer;
  readonly #tiles: LoadedTile[] = [];
  #layout!: GPUBindGroupLayout;
  #sampler!: GPUSampler;
  #device: GPUDevice | undefined;
  readonly #model = new Float32Array(16);
  readonly #values = new Float32Array(24);
  #note: HTMLElement | undefined;
  #disposed = false;

  /** @internal Use {@link tileLayer}. */
  constructor(renderer: SciRenderer, options: TileLayerOptions) {
    this.#renderer = renderer;
    this.#appearance = options.appearance;
    this.projection = options.projection ?? 'mercator';
    if (!['mercator', 'plate', 'globe'].includes(this.projection))
      throw rangeError(`Unknown projection ${this.projection}`, 'sciviz');
    this.zoom = options.zoom ?? 2;
    if (!Number.isInteger(this.zoom) || this.zoom < 0 || this.zoom > 24)
      throw rangeError('Tile zoom must be a whole number from 0 to 24', 'sciviz');
    this.attribution = options.attribution;
    this.#build();
  }

  #build(): void {
    const device = this.#renderer.device!;
    this.#device = device;
    this.#layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    });
    this.#sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
  }

  /** Data bounds of the map in the projection's units. */
  get bounds(): Bounds {
    if (this.projection === 'globe') return [-1, 1, -1, 1, -1, 1];
    return this.projection === 'plate'
      ? [-1, 1, -MERCATOR_MAX_LAT / 180, MERCATOR_MAX_LAT / 180, 0, 0]
      : [-1, 1, -1, 1, 0, 0];
  }

  /** Projects degrees and metres into this layer's data units. */
  project(lon: number, lat: number, height = 0): [number, number, number] {
    return project(lon, lat, height, this.projection);
  }

  /** @internal Fetches and uploads the tiles. */
  async load(options: TileLayerOptions): Promise<void> {
    const list = tilesIn(options.area ?? [-180, -MERCATOR_MAX_LAT, 180, MERCATOR_MAX_LAT], this.zoom),
      max = options.maxTiles ?? 256;
    if (list.length > max)
      throw rangeError(
        `${list.length} tiles at zoom ${this.zoom} is over maxTiles ${max}; lower zoom or area`,
        'sciviz',
      );
    const source = options.tiles;
    if (typeof source !== 'string' && typeof source !== 'function')
      throw typeError('tileLayer needs tiles: a URL template or a function', 'sciviz');
    const get = async (z: number, x: number, y: number): Promise<Blob | ImageBitmap | ImageData | undefined> => {
      if (typeof source === 'function') return source(z, x, y, options.signal);
      const url = source.replaceAll('{z}', String(z)).replaceAll('{x}', String(x)).replaceAll('{y}', String(y));
      const response = await fetch(url, { ...options.init, signal: options.signal });
      if (response.status === 404) return undefined;
      if (!response.ok) throw rangeError(`Tile ${z}/${x}/${y} answered ${response.status}`, 'sciviz');
      return response.blob();
    };
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const [z, x, y] = list[next++];
        const image = await get(z, x, y);
        options.signal?.throwIfAborted();
        if (this.#disposed) return;
        if (!image) {
          this.missing++;
          continue;
        }
        const pixels = await pixelsOf(image);
        // A layer disposed while this tile decoded (another tile failed, say) must not take a texture it never frees.
        if (this.#disposed) return;
        this.#tiles.push(
          this.#upload(z, x, y, new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height)),
        );
        this.loaded++;
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
    const host = (this.#renderer.engine as unknown as { canvas?: HTMLCanvasElement }).canvas?.parentElement;
    if (this.attribution && host && typeof document !== 'undefined') {
      const note = document.createElement('small');
      note.textContent = this.attribution;
      note.style.cssText =
        'position:absolute;right:4px;bottom:2px;font:11px system-ui,sans-serif;color:#cfd6df;background:#0008;padding:0 4px;pointer-events:none';
      host.append(note);
      this.#note = note;
    }
  }

  #upload(z: number, x: number, y: number, pixels: ImageData): LoadedTile {
    if (this.#device !== this.#renderer.device) this.restore();
    const device = this.#renderer.device!;
    const texture = device.createTexture({
      size: [pixels.width, pixels.height],
      format: 'rgba8unorm-srgb',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({ texture }, pixels.data, { bytesPerRow: pixels.width * 4 }, [
      pixels.width,
      pixels.height,
    ]);
    const uniform = device.createBuffer({
      size: this.#values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const group = device.createBindGroup({
      layout: this.#layout,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: this.#sampler },
      ],
    });
    return { z, x, y, pixels, texture, uniform, group };
  }

  /** @internal Reuploads retained tile pixels without fetching or decoding again. */
  restore(): void {
    const tiles = this.#tiles.splice(0);
    for (const tile of tiles) {
      tile.texture.destroy();
      tile.uniform.destroy();
    }
    this.#build();
    for (const tile of tiles) this.#tiles.push(this.#upload(tile.z, tile.x, tile.y, tile.pixels));
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
  prepare(context?: GpuContext): void {
    if (context) this.#appearance?.prepare?.(context);
    const mode = this.projection === 'mercator' ? 0 : this.projection === 'plate' ? 1 : 2;
    for (const t of this.#tiles) {
      const v = this.#values;
      v.set(this.#model, 0);
      v.set([t.x, t.y, 2 ** t.z, mode], 16);
      v.set([SEGMENTS, WGS84.e2, 0, 0], 20);
      this.#renderer.device!.queue.writeBuffer(t.uniform, 0, v);
    }
  }

  /** @internal */
  draw(pass: GPURenderPassEncoder, context: GpuContext, renderer: SciRenderer): void {
    if (!this.#tiles.length) return;
    const pipeline = renderer.pipeline(`geo-tiles:${this.#appearance?.key ?? ''}`, context, (target) => {
      const module = renderer.device!.createShaderModule({ code: this.#appearance ? tileShader.replace('shade(albedo, in.normal, normalize(frame.eye.xyz - in.world))', 'planetSurface(in.world, albedo)') + this.#appearance.shader : tileShader, label: 'sciviz tiles' });
      return {
        label: 'sciviz tiles',
        layout: renderer.device!.createPipelineLayout({ bindGroupLayouts: [renderer.frameLayout!, this.#layout, ...(this.#appearance ? [this.#appearance.layout] : [])] }),
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'fragment', targets: [{ format: target.format }] },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        multisample: target.multisample,
        depthStencil: { format: target.depth, depthWriteEnabled: true, depthCompare: 'greater-equal' },
      };
    });
    pass.setPipeline(pipeline);
    if (this.#appearance) pass.setBindGroup(2, this.#appearance.group);
    for (const t of this.#tiles) {
      pass.setBindGroup(1, t.group);
      pass.draw(SEGMENTS * SEGMENTS * 6);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderer.remove(this);
    for (const t of this.#tiles) t.texture.destroy(), t.uniform.destroy();
    this.#tiles.length = 0;
    this.#note?.remove();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

/** Loads map tiles and draws them under a figure's data layers; resolves once every tile is in. */
export async function tileLayer(figure: Figure, options: TileLayerOptions): Promise<TileLayer> {
  const layer = new TileLayer(figure.renderer, options);
  try {
    await layer.load(options);
  } catch (error) {
    layer.dispose();
    throw error;
  }
  figure.renderer.add(layer);
  return trackSpecLayer(figure, 'tiles', [options], figure.addLayer(layer));
}
