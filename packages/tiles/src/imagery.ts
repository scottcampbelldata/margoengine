/// <reference lib="esnext.disposable" preserve="true" />
// Clean room: OGC WMS/WMTS, quantized-mesh layer.json and metadata availability, EPSG:3857.
import { MargoError } from '@margoengine/math/errors';
import { meshB3dm, parseQuantizedMesh, LEVEL_ZERO_ERROR, type QuantizedMesh, type TerrainOptions } from './terrain.js';
import { WGS84_A } from './wgs84.js';

/** Geographic bounds in radians: west, south, east, north. */
export type ImageryRectangle = readonly [number, number, number, number];
/** Supported global terrain/imagery coordinate systems. */
export type MapProjection = 'EPSG:4326' | 'EPSG:3857';
/** A fetch used by all terrain and map requests, including access headers supplied by the application. */
export type ImageryFetch = NonNullable<TerrainOptions['fetch']>;
interface Raster {
  canvas: OffscreenCanvas | ImageBitmap;
  uv: (longitude: number, latitude: number) => [number, number];
  close(): void;
}
/** One ordered imagery layer. Rendering is optional and opacity defaults to one. */
export interface ImageryLayer {
  opacity?: number;
  show?: boolean;
  /** Requests a raster covering these bounds; the caller closes it after compositing. */
  request(rectangle: ImageryRectangle, level: number, fetch: ImageryFetch, signal: AbortSignal): Promise<Raster>;
}
/** Web Map Service 1.1.1 or 1.3.0 GetMap parameters. */
export interface WMSImageryOptions {
  url: string;
  layers: string;
  styles?: string;
  version?: '1.1.1' | '1.3.0';
  crs?: MapProjection | 'CRS:84';
  format?: string;
  size?: number;
  parameters?: Readonly<Record<string, string>>;
}
/** A WMTS tile matrix in projected east/north coordinates (metres for 3857, degrees for 4326). */
export interface ImageryMatrix {
  id: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** Projected coordinate units per pixel, positive. */
  resolution: number;
  topLeft: readonly [number, number];
}
/** Web Map Tile Service configuration. Defaults to a global Mercator matrix pyramid. */
export interface WMTSImageryOptions {
  url: string;
  layer: string;
  matrixSet: string;
  style?: string;
  format?: string;
  projection?: MapProjection;
  /** Explicit service matrices, when they differ from the global pyramid. */
  matrices?: readonly ImageryMatrix[];
  matrixLabels?: readonly string[];
  maximumLevel?: number;
  parameters?: Readonly<Record<string, string>>;
}
/** XYZ/TMS tile imagery configuration. */
export interface XYZImageryOptions {
  url: string;
  projection?: MapProjection;
  scheme?: 'xyz' | 'tms';
  tileSize?: number;
  maximumLevel?: number;
}
const PI = Math.PI,
  MAX_LAT = Math.atan(Math.sinh(PI)),
  DEGREES = 180 / PI;
const mercator = (latitude: number) => Math.asinh(Math.tan(Math.max(-MAX_LAT, Math.min(MAX_LAT, latitude))));
const projected = (lon: number, lat: number, projection: MapProjection): [number, number] =>
  projection === 'EPSG:3857' ? [lon * WGS84_A, mercator(lat) * WGS84_A] : [lon * DEGREES, lat * DEGREES];
const failed = (subject: string) =>
  new MargoError('failed', `${subject}; check the service URL, requested layers and access`);
function checkRectangle(rectangle: ImageryRectangle): void {
  if (
    rectangle.length !== 4 ||
    !rectangle.every(Number.isFinite) ||
    rectangle[0] >= rectangle[2] ||
    rectangle[1] >= rectangle[3] ||
    rectangle[1] < -PI / 2 ||
    rectangle[3] > PI / 2
  )
    throw new RangeError(
      'Imagery bounds need ordered west/south/east/north radians and latitudes in -pi/2..pi/2; correct the rectangle',
    );
}
function query(url: string, parameters: Readonly<Record<string, string>>): string {
  const result = new URL(url, globalThis.location?.href);
  for (const [key, value] of Object.entries(parameters)) {
    for (const old of [...result.searchParams.keys()])
      if (old.toLowerCase() === key.toLowerCase()) result.searchParams.delete(old);
    result.searchParams.set(key, value);
  }
  return result.href;
}
/** Constructs a WMS GetMap URL with the version's required CRS key and axis order. */
export function wmsURL(options: WMSImageryOptions, rectangle: ImageryRectangle): string {
  checkRectangle(rectangle);
  if (
    !options.layers ||
    !['1.1.1', '1.3.0'].includes(options.version ?? '1.3.0') ||
    !['EPSG:3857', 'EPSG:4326', 'CRS:84'].includes(options.crs ?? 'CRS:84')
  )
    throw new TypeError('WMS needs layers, version 1.1.1/1.3.0 and a supported CRS; correct its provider options');
  const version = options.version ?? '1.3.0',
    crs = options.crs ?? (version === '1.1.1' ? 'EPSG:4326' : 'CRS:84'),
    projection = crs === 'EPSG:3857' ? 'EPSG:3857' : 'EPSG:4326';
  const [west, south] = projected(rectangle[0], rectangle[1], projection),
    [east, north] = projected(rectangle[2], rectangle[3], projection);
  const bbox = version === '1.3.0' && crs === 'EPSG:4326' ? [south, west, north, east] : [west, south, east, north];
  const size = options.size ?? 256;
  if (!Number.isInteger(size) || size < 1 || size > 4096)
    throw new RangeError('WMS map size must be 1..4096; choose a supported map resolution');
  return query(options.url, {
    ...options.parameters,
    SERVICE: 'WMS',
    REQUEST: 'GetMap',
    VERSION: version,
    LAYERS: options.layers,
    STYLES: options.styles ?? '',
    FORMAT: options.format ?? 'image/png',
    TRANSPARENT: 'TRUE',
    WIDTH: String(size),
    HEIGHT: String(size),
    [version === '1.3.0' ? 'CRS' : 'SRS']: crs,
    BBOX: bbox.join(','),
  });
}
async function bitmap(url: string, fetch: ImageryFetch, signal: AbortSignal): Promise<ImageBitmap> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw failed(`Map request answered ${response.status}`);
  const image = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
  if (signal.aborted) {
    image.close();
    signal.throwIfAborted();
  }
  return image;
}
/** Creates a WMS imagery layer; 1.3.0 EPSG:4326 is latitude/longitude, while CRS:84 and 1.1.1 use longitude/latitude. */
function emptyRaster(): Raster {
  return { canvas: new OffscreenCanvas(1, 1), uv: () => [0, 0], close() {} };
}
const outsideMercator = (rectangle: ImageryRectangle) => rectangle[1] >= MAX_LAT || rectangle[3] <= -MAX_LAT;
/** Creates a WMS imagery layer with version-correct axes and transparent Mercator polar coverage. */
export function wms(options: WMSImageryOptions): ImageryLayer {
  return {
    request: async (rectangle, _level, fetch, signal) => {
      if (options.crs === 'EPSG:3857' && outsideMercator(rectangle)) return emptyRaster();
      const image = await bitmap(wmsURL(options, rectangle), fetch, signal),
        projection = options.crs === 'EPSG:3857' ? 'EPSG:3857' : 'EPSG:4326';
      const [west, south] = projected(rectangle[0], rectangle[1], projection),
        [east, north] = projected(rectangle[2], rectangle[3], projection);
      return {
        canvas: image,
        uv: (lon, lat) => {
          const [x, y] = projected(lon, lat, projection);
          return [(x - west) / (east - west), (north - y) / (north - south)];
        },
        close: () => image.close(),
      };
    },
  };
}
function globalMatrix(level: number, projection: MapProjection, size = 256, id = String(level)): ImageryMatrix {
  const width = 2 ** level * (projection === 'EPSG:4326' ? 2 : 1),
    height = 2 ** level,
    span = projection === 'EPSG:4326' ? 360 : 2 * PI * WGS84_A;
  return {
    id,
    width,
    height,
    tileWidth: size,
    tileHeight: size,
    resolution: span / width / size,
    topLeft: projection === 'EPSG:4326' ? [-180, 90] : [-PI * WGS84_A, PI * WGS84_A],
  };
}
/** Constructs a WMTS KVP GetTile URL, retaining custom dimensions and access parameters. */
export function wmtsURL(options: WMTSImageryOptions, matrix: string, x: number, y: number): string {
  const replacements: Record<string, string> = {
    TileMatrixSet: options.matrixSet,
    TileMatrix: matrix,
    TileCol: String(x),
    TileRow: String(y),
    Style: options.style ?? 'default',
    Layer: options.layer,
  };
  if (/\{Tile(?:Matrix|Col|Row)/i.test(options.url))
    return query(
      options.url.replace(/\{([^}]+)\}/g, (_, key) => {
        const value = replacements[key] ?? options.parameters?.[key];
        if (value === undefined)
          throw new TypeError(`WMTS ResourceURL lacks dimension ${key}; supply it in parameters`);
        return encodeURIComponent(value);
      }),
      options.parameters ?? {},
    );
  return query(options.url, {
    ...options.parameters,
    SERVICE: 'WMTS',
    REQUEST: 'GetTile',
    VERSION: '1.0.0',
    LAYER: options.layer,
    STYLE: options.style ?? 'default',
    FORMAT: options.format ?? 'image/png',
    TILEMATRIXSET: options.matrixSet,
    TILEMATRIX: matrix,
    TILEROW: String(y),
    TILECOL: String(x),
  });
}
async function mosaic(
  rectangle: ImageryRectangle,
  projection: MapProjection,
  matrix: ImageryMatrix,
  url: (x: number, y: number) => string,
  fetch: ImageryFetch,
  signal: AbortSignal,
): Promise<Raster> {
  if (projection === 'EPSG:3857' && outsideMercator(rectangle)) return emptyRaster();
  if (
    [matrix.width, matrix.height, matrix.tileWidth, matrix.tileHeight].some((v) => !Number.isInteger(v) || v < 1) ||
    !Number.isFinite(matrix.resolution) ||
    matrix.resolution <= 0 ||
    matrix.topLeft.length !== 2 ||
    !matrix.topLeft.every(Number.isFinite)
  )
    throw new RangeError(
      'WMTS matrix needs positive dimensions/resolution and a finite east/north origin; correct the matrix definition',
    );
  const [west, south] = projected(rectangle[0], rectangle[1], projection),
    [east, north] = projected(rectangle[2], rectangle[3], projection),
    [ox, oy] = matrix.topLeft;
  const sx = matrix.resolution * matrix.tileWidth,
    sy = matrix.resolution * matrix.tileHeight;
  const x0 = Math.max(0, Math.floor((west - ox) / sx)),
    x1 = Math.min(matrix.width - 1, Math.ceil((east - ox) / sx) - 1),
    y0 = Math.max(0, Math.floor((oy - north) / sy)),
    y1 = Math.min(matrix.height - 1, Math.ceil((oy - south) / sy) - 1);
  if (x1 < x0 || y1 < y0) return emptyRaster();
  const width = (x1 - x0 + 1) * matrix.tileWidth,
    height = (y1 - y0 + 1) * matrix.tileHeight;
  if (width > 16384 || height > 16384)
    throw new RangeError(
      'Imagery mosaic exceeds 16384 pixels per side; use a closer terrain LOD or a coarser imagery matrix',
    );
  const canvas = new OffscreenCanvas(width, height),
    context = canvas.getContext('2d')!;
  // Requests follow the caller's cancellation; no retries or hidden error tiles.
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const image = await bitmap(url(x, y), fetch, signal);
      try {
        context.drawImage(
          image,
          (x - x0) * matrix.tileWidth,
          (y - y0) * matrix.tileHeight,
          matrix.tileWidth,
          matrix.tileHeight,
        );
      } finally {
        image.close();
      }
    }
  return {
    canvas,
    uv: (lon, lat) => {
      const [x, y] = projected(lon, lat, projection);
      return [(x - ox - x0 * sx) / (width * matrix.resolution), (oy - y - y0 * sy) / (height * matrix.resolution)];
    },
    close() {
      canvas.width = canvas.height = 1;
    },
  };
}
/** Creates a WMTS layer using KVP or a REST ResourceURL template and explicit or global matrices. */
export function wmts(options: WMTSImageryOptions): ImageryLayer {
  return {
    request: (rectangle, level, fetch, signal) => {
      const z = Math.min(
          level,
          options.maximumLevel ??
            (options.matrices
              ? options.matrices.length - 1
              : options.matrixLabels
                ? options.matrixLabels.length - 1
                : 19),
        ),
        projection = options.projection ?? 'EPSG:3857';
      if (
        z < 0 ||
        !Number.isInteger(z) ||
        (options.matrices && !options.matrices[z]) ||
        (options.matrixLabels && !options.matrixLabels[z])
      )
        throw new RangeError('WMTS level has no matrix or label; supply all requested matrix levels');
      const matrix = options.matrices?.[z] ?? globalMatrix(z, projection, 256, options.matrixLabels?.[z] ?? String(z));
      return mosaic(rectangle, projection, matrix, (x, y) => wmtsURL(options, matrix.id, x, y), fetch, signal);
    },
  };
}
/** Creates an XYZ or TMS imagery layer, mosaicking every source tile intersecting the terrain tile. */
export function xyz(options: XYZImageryOptions): ImageryLayer {
  return {
    request: (rectangle, level, fetch, signal) => {
      const z = Math.min(level, options.maximumLevel ?? 19),
        projection = options.projection ?? 'EPSG:3857',
        matrix = globalMatrix(z, projection, options.tileSize ?? 256);
      return mosaic(
        rectangle,
        projection,
        matrix,
        (x, y) =>
          options.url
            .replaceAll('{z}', String(z))
            .replaceAll('{x}', String(x))
            .replaceAll('{y}', String(options.scheme === 'tms' ? matrix.height - 1 - y : y)),
        fetch,
        signal,
      );
    },
  };
}
/** Composites ordered layers into one geographic drape, reprojecting each scanline before alpha-over composition. */
export async function compositeImagery(
  layers: readonly ImageryLayer[],
  rectangle: ImageryRectangle,
  level: number,
  fetch: ImageryFetch,
  signal: AbortSignal,
  size = 256,
): Promise<{ bytes: Uint8Array; mimeType: string; uv: (lon: number, lat: number) => [number, number] }> {
  checkRectangle(rectangle);
  if (!Number.isInteger(size) || size < 1 || size > 4096)
    throw new RangeError('Imagery output size must be 1..4096; choose a supported tile resolution');
  const canvas = new OffscreenCanvas(size, size),
    context = canvas.getContext('2d')!;
  const [west, south, east, north] = rectangle;
  for (const layer of layers) {
    if (layer.show === false) continue;
    const opacity = layer.opacity ?? 1;
    if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
      throw new RangeError('Imagery opacity must be 0..1; clamp the layer opacity');
    if (opacity === 0) continue;
    const raster = await layer.request(rectangle, level, fetch, signal);
    try {
      context.globalAlpha = opacity;
      for (let row = 0; row < size; row++) {
        signal.throwIfAborted();
        const top = north - ((north - south) * row) / size,
          bottom = north - ((north - south) * (row + 1)) / size,
          [u, v] = raster.uv(west, top),
          [u2, v2] = raster.uv(east, bottom);
        const x = u * raster.canvas.width,
          y = v * raster.canvas.height,
          w = (u2 - u) * raster.canvas.width,
          h = (v2 - v) * raster.canvas.height;
        if (h > 0 && w > 0) context.drawImage(raster.canvas, x, y, w, h, 0, row, size, 1);
      }
    } finally {
      raster.close();
    }
  }
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
  signal.throwIfAborted();
  return {
    bytes,
    mimeType: 'image/png',
    uv: (lon, lat) => [(lon - west) / (east - west), (north - lat) / (north - south)],
  };
}
interface Range {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}
interface Layer {
  tiles: string[];
  version?: string;
  projection?: MapProjection;
  scheme?: 'tms' | 'slippyMap';
  maxzoom?: number;
  available?: Range[][];
  metadataAvailability?: number;
}
/** Options of the wider terrain/imagery adapter. */
export interface TerrainImageryOptions {
  imagery?: readonly ImageryLayer[];
  fetch?: ImageryFetch;
  signal?: AbortSignal;
  skirt?: number;
  imagerySize?: number;
  /** Bounded decoded terrain staging cache. Default 32 MiB. */
  maximumCachedBytes?: number;
}
/** A lazy terrain source. Dispose cancels its requests and releases the staging cache. */
export interface TerrainImagerySource extends Disposable {
  readonly url: string;
  readonly maximumLevel: number;
  readonly projection: MapProjection;
  fetch(input: string, init?: { signal?: AbortSignal }): Promise<Response>;
  dispose(): void;
}
/** Exact geographic rectangle of a geographic or Web Mercator TMS terrain tile. */
export function terrainRectangle(level: number, x: number, y: number, projection: MapProjection): ImageryRectangle {
  if (!['EPSG:3857', 'EPSG:4326'].includes(projection))
    throw new TypeError('Terrain projection must be EPSG:3857 or EPSG:4326; correct the projection');
  if (
    !Number.isInteger(level) ||
    level < 0 ||
    level > 30 ||
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 ||
    y < 0 ||
    x >= 2 ** level * (projection === 'EPSG:4326' ? 2 : 1) ||
    y >= 2 ** level
  )
    throw new RangeError('Terrain tile coordinates are outside their pyramid; use a valid level/x/y');
  const columns = 2 ** level * (projection === 'EPSG:4326' ? 2 : 1),
    rows = 2 ** level;
  const latitude = (v: number) =>
    projection === 'EPSG:4326' ? -PI / 2 + v * PI : Math.atan(Math.sinh(-PI + v * 2 * PI));
  return [
    -PI + (x / columns) * 2 * PI,
    latitude(y / rows),
    -PI + ((x + 1) / columns) * 2 * PI,
    latitude((y + 1) / rows),
  ];
}
let sourceId = 0;
/**
 * Loads geographic or Mercator quantized-mesh terrain, including metadataAvailability, with ordered imagery layers.
 * Branch tilesets expand lazily so Mercator latitude bounds remain exact at every level.
 */
export async function terrainImagery(
  layerUrl: string | URL,
  options: TerrainImageryOptions = {},
): Promise<TerrainImagerySource> {
  const base = new URL(String(layerUrl), globalThis.location?.href).href,
    outer = options.fetch ?? globalThis.fetch.bind(globalThis),
    controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const response = await outer(base, { signal });
  if (!response.ok) throw failed(`Terrain manifest answered ${response.status}`);
  const layer = (await response.json()) as Layer,
    projection = layer.projection ?? 'EPSG:4326',
    scheme = layer.scheme ?? 'tms';
  signal.throwIfAborted();
  if (
    !Array.isArray(layer.tiles) ||
    !layer.tiles.length ||
    !['EPSG:4326', 'EPSG:3857'].includes(projection) ||
    !['tms', 'slippyMap'].includes(scheme)
  )
    throw new TypeError('Terrain manifest needs tile templates, EPSG:4326/3857 and tms/slippyMap; correct layer.json');
  const maximumLevel =
      layer.maxzoom ?? (layer.metadataAvailability ? 19 : layer.available?.length ? layer.available.length - 1 : 19),
    period = layer.metadataAvailability;
  if (
    !Number.isInteger(maximumLevel) ||
    maximumLevel < 0 ||
    maximumLevel > 30 ||
    (period !== undefined && (!Number.isInteger(period) || period < 1))
  )
    throw new RangeError('Terrain levels must be 0..30 and metadataAvailability positive; correct layer.json');
  const limit = options.maximumCachedBytes ?? 32 * 1024 * 1024;
  if (!Number.isFinite(options.skirt ?? 2) || (options.skirt ?? 2) < 0)
    throw new RangeError('Terrain skirt factor must be finite and non-negative; choose a supported skirt depth');
  if (!Number.isFinite(limit) || limit < 0)
    throw new RangeError('Terrain staging cache bytes must be finite and non-negative; set maximumCachedBytes');
  const root = `margo-imagery:/${++sourceId}/`,
    cache = new Map<string, { mesh: QuantizedMesh; bytes: number }>(),
    availability = new Map<string, { z: number; x: number; y: number; ranges: Range[][] }>();
  let used = 0;
  const key = (z: number, x: number, y: number) => `${z}/${x}/${y}`;
  const available = (z: number, x: number, y: number): boolean => {
    if (z > maximumLevel) return false;
    if (period) {
      for (let ancestor = z - 1; ancestor >= 0; ancestor--) {
        const shift = 2 ** (z - ancestor),
          record = availability.get(key(ancestor, Math.floor(x / shift), Math.floor(y / shift)));
        if (!record) continue;
        const ranges = record.ranges[z - ancestor - 1];
        if (ranges !== undefined)
          return ranges.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY);
      }
      return z === 0;
    }
    return (
      !layer.available ||
      !!layer.available[z]?.some((r) => x >= r.startX && x <= r.endX && y >= r.startY && y <= r.endY)
    );
  };
  const load = async (z: number, x: number, y: number, requestSignal: AbortSignal): Promise<QuantizedMesh> => {
    const id = key(z, x, y),
      cached = cache.get(id);
    if (cached) {
      cache.delete(id);
      cache.set(id, cached);
      return cached.mesh;
    }
    const url = new URL(
      layer.tiles[0]
        .replaceAll('{z}', String(z))
        .replaceAll('{x}', String(x))
        .replaceAll('{y}', String(scheme === 'slippyMap' ? 2 ** z - 1 - y : y))
        .replaceAll('{version}', layer.version ?? '1.0.0'),
      base,
    ).href;
    const answer = await outer(url, {
      signal: requestSignal,
      headers: { Accept: 'application/vnd.quantized-mesh;extensions=octvertexnormals-watermask-metadata' },
    });
    if (!answer.ok) throw failed(`Terrain tile answered ${answer.status}`);
    const data = new Uint8Array(await answer.arrayBuffer()),
      mesh = parseQuantizedMesh(data);
    requestSignal.throwIfAborted();
    if (period && z % period === 0) {
      const ranges = (mesh.metadata as { available?: Range[][] } | undefined)?.available;
      if (!Array.isArray(ranges))
        throw new TypeError(
          'Terrain tile omitted metadata availability; enable the metadata extension on the terrain server',
        );
      availability.set(id, { z, x, y, ranges });
    }
    const bytes =
      data.byteLength +
      [mesh.u, mesh.v, mesh.height, mesh.indices, mesh.west, mesh.south, mesh.east, mesh.north].reduce(
        (sum, a) => sum + a.byteLength,
        0,
      );
    if (bytes <= limit) {
      while (used + bytes > limit) {
        const first = cache.keys().next().value!;
        used -= cache.get(first)!.bytes;
        cache.delete(first);
      }
      cache.set(id, { mesh, bytes });
      used += bytes;
    }
    return mesh;
  };
  const tile = (z: number, x: number, y: number, branch = true) => ({
    boundingVolume: { region: [...terrainRectangle(z, x, y, projection), -500, 9000] },
    geometricError: (LEVEL_ZERO_ERROR * (projection === 'EPSG:3857' ? 2 : 1)) / 2 ** z,
    refine: 'REPLACE',
    content: { uri: root + key(z, x, y) + (branch ? '.json' : '.b3dm') },
  });
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  const result: TerrainImagerySource = {
    url: root + 'tileset.json',
    maximumLevel,
    projection,
    fetch: async (input, init) => {
      const requestSignal = init?.signal ? AbortSignal.any([signal, init.signal]) : signal;
      requestSignal.throwIfAborted();
      if (!input.startsWith(root)) return outer(input, { signal: requestSignal });
      const path = input.slice(root.length);
      if (path === 'tileset.json')
        return json({
          asset: { version: '1.1' },
          geometricError: LEVEL_ZERO_ERROR * 4,
          root: {
            boundingVolume: {
              region: [
                -PI,
                projection === 'EPSG:3857' ? -MAX_LAT : -PI / 2,
                PI,
                projection === 'EPSG:3857' ? MAX_LAT : PI / 2,
                -500,
                9000,
              ],
            },
            geometricError: LEVEL_ZERO_ERROR * 4,
            refine: 'REPLACE',
            children: Array.from({ length: projection === 'EPSG:4326' ? 2 : 1 }, (_, x) => tile(0, x, 0)).filter(
              (_, x) => !layer.available || period || available(0, x, 0),
            ),
          },
        });
      const match = /^(\d+)\/(\d+)\/(\d+)\.(json|b3dm)$/.exec(path);
      if (!match) throw new TypeError('Unknown terrain source URL; request a URL from the generated tileset');
      const z = Number(match[1]),
        x = Number(match[2]),
        y = Number(match[3]),
        rectangle = terrainRectangle(z, x, y, projection),
        mesh = await load(z, x, y, requestSignal);
      if (match[4] === 'json')
        return json({
          asset: { version: '1.1' },
          geometricError: LEVEL_ZERO_ERROR * 4,
          root: {
            ...tile(z, x, y, false),
            children:
              z >= maximumLevel
                ? []
                : Array.from({ length: 4 }, (_, i) => [x * 2 + (i & 1), y * 2 + (i >> 1)])
                    .filter(([x, y]) => available(z + 1, x, y))
                    .map(([x, y]) => tile(z + 1, x, y)),
          },
        });
      const drape = options.imagery?.length
        ? await compositeImagery(options.imagery, rectangle, z, outer, requestSignal, options.imagerySize)
        : undefined;
      const body = meshB3dm(
        mesh,
        rectangle,
        drape,
        ((LEVEL_ZERO_ERROR * (projection === 'EPSG:3857' ? 2 : 1)) / 2 ** z) * (options.skirt ?? 2),
      );
      const held = cache.get(key(z, x, y));
      if (held) {
        used -= held.bytes;
        cache.delete(key(z, x, y));
      }
      return new Response(body as Uint8Array<ArrayBuffer>);
    },
    dispose() {
      controller.abort(new DOMException('Terrain imagery source disposed', 'AbortError'));
      cache.clear();
      availability.clear();
      used = 0;
    },
    [Symbol.dispose]() {
      this.dispose();
    },
  };
  return result;
}
