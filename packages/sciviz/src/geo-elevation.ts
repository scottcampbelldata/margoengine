import { fault, rangeError } from '../../shared/errors.js';
import type { TerrainStreamTile } from '@margoengine/terrain/stream';
import { geoTileHeight, type GeoTile, type GeoTileElevation } from './geo-lod-plan.js';

/** Loads heights in metres for an XYZ tile. Undefined denotes no data, rejection denotes a request error. */
export type GeoElevationSource = (tile: GeoTile, signal: AbortSignal) => Promise<GeoTileElevation | undefined>;
/** Mapzen Terrarium RGB equation, Mapzen (2016), preserving the 1/256 metre fractional channel. */
export function decodeTerrarium(image: {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}): GeoTileElevation {
  if (
    !Number.isInteger(image.width) ||
    image.width < 1 ||
    !Number.isInteger(image.height) ||
    image.height < 1 ||
    image.data.length !== image.width * image.height * 4
  )
    throw rangeError('Terrarium needs width * height RGBA bytes', 'sciviz');
  const heights = new Float32Array(image.width * image.height);
  for (let i = 0; i < heights.length; i++)
    heights[i] = image.data[i * 4] * 256 + image.data[i * 4 + 1] + image.data[i * 4 + 2] / 256 - 32768;
  return { width: image.width, height: image.height, heights };
}
/** Decodes a browser image without colour conversion (elevation bytes are data). Caller retains ownership of input bitmaps. */
export async function geoTilePixels(image: Blob | ImageBitmap | ImageData): Promise<ImageData> {
  if (typeof ImageData !== 'undefined' && image instanceof ImageData) return image;
  const own = image instanceof Blob;
  const bitmap = own
    ? await createImageBitmap(image, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })
    : (image as ImageBitmap);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw fault('unsupported', 'Tile decode needs OffscreenCanvas 2D', 'sciviz');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    if (own) bitmap.close();
  }
}
/** AWS Terrain Tiles, accessed without credentials. Display the provider attribution beside the map. */
export const AWS_TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
/** Global dataset credit; regional sources and their terms are linked in the recorded data notice. */
export const TERRARIUM_ATTRIBUTION = 'Mapzen terrain tiles: USGS, SRTM, GMTED2010, ETOPO1 and other sources';
/** Fetches a Terrarium elevation source. Default AWS public endpoint; 404 is missing, other HTTP errors reject. */
export function terrariumElevation(
  options: { readonly url?: string; readonly fetch?: typeof fetch } = {},
): GeoElevationSource {
  return async (tile, signal) => {
    const url = (options.url ?? AWS_TERRARIUM)
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));
    const response = await (options.fetch ?? fetch)(url, { signal });
    if (response.status === 404) return undefined;
    if (!response.ok) throw fault('failed', `Elevation request ${url} answered ${response.status}`, 'sciviz');
    const image = await geoTilePixels(await response.blob());
    signal.throwIfAborted();
    return decodeTerrarium(image);
  };
}
/** Adapts the same elevation loader to TerrainStream.attach's load(x,z,signal), at a fixed zoom. */
export function geoTerrainStreamSource(
  source: GeoElevationSource,
  options: {
    readonly zoom: number;
    /** Samples per side, matching TerrainStream.tileTexels. Default 256. */
    readonly tileTexels?: number;
    /** XYZ address corresponding to stream tile (0,0). Default [0,0]. */
    readonly origin?: readonly [number, number];
  },
): (x: number, z: number, signal: AbortSignal) => Promise<TerrainStreamTile | undefined> {
  const size = options.tileTexels ?? 256,
    zoom = options.zoom,
    origin = options.origin ?? [0, 0];
  if (
    !Number.isInteger(zoom) ||
    zoom < 0 ||
    zoom > 24 ||
    !Number.isInteger(size) ||
    size < 2 ||
    size > 1024 ||
    !origin.every(Number.isInteger)
  )
    throw rangeError('Stream source needs zoom 0..24, tileTexels 2..1024 and integer origin', 'sciviz');
  return async (x, z, signal) => {
    const n = 2 ** zoom,
      y = origin[1] + z;
    if (y < 0 || y >= n) return undefined;
    const data = await source({ z: zoom, x: (((origin[0] + x) % n) + n) % n, y }, signal);
    signal.throwIfAborted();
    if (!data) return undefined;
    if (data.width === size && data.height === size) return { heights: data.heights.slice() };
    const heights = new Float32Array(size * size);
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) heights[j * size + i] = geoTileHeight(data, (i + 0.5) / size, (j + 0.5) / size);
    return { heights };
  };
}
/** Decodes quantized-mesh with the owning tiles/terrain API, then rasterises its triangles at pixel centres. */
export async function quantizedGeoElevation(bytes: Uint8Array, size = 33): Promise<GeoTileElevation> {
  if (!Number.isInteger(size) || size < 2 || size > 1024)
    throw rangeError('Quantized height grid size must be 2..1024', 'sciviz');
  const { parseQuantizedMesh } = await import('@margoengine/tiles/terrain');
  const mesh = parseQuantizedMesh(bytes),
    heights = new Float32Array(size * size).fill(NaN);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const ids = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]],
      xs = ids.map((id) => (mesh.u[id] / 32767) * size - 0.5),
      ys = ids.map((id) => (1 - mesh.v[id] / 32767) * size - 0.5);
    const denominator = (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
    if (denominator === 0) continue;
    for (let y = Math.max(0, Math.ceil(Math.min(...ys))); y <= Math.min(size - 1, Math.floor(Math.max(...ys))); y++)
      for (let x = Math.max(0, Math.ceil(Math.min(...xs))); x <= Math.min(size - 1, Math.floor(Math.max(...xs))); x++) {
        const a = ((ys[1] - ys[2]) * (x - xs[2]) + (xs[2] - xs[1]) * (y - ys[2])) / denominator,
          b = ((ys[2] - ys[0]) * (x - xs[2]) + (xs[0] - xs[2]) * (y - ys[2])) / denominator,
          c = 1 - a - b;
        if (a >= -1e-10 && b >= -1e-10 && c >= -1e-10)
          heights[y * size + x] =
            mesh.minimumHeight +
            ((a * mesh.height[ids[0]] + b * mesh.height[ids[1]] + c * mesh.height[ids[2]]) / 32767) *
              (mesh.maximumHeight - mesh.minimumHeight);
      }
  }
  if (!heights.every(Number.isFinite)) throw rangeError('Quantized terrain triangles do not cover the tile', 'sciviz');
  return { width: size, height: size, heights };
}
