import { fault } from '../../shared/errors.js';
// The tile layers of a biome map: names, formats and scales (spec 3.1), and the canonical bytes a digest hashes.

/** Storage format of a raster layer: little-endian integers. */
export type LayerFormat = 'i32' | 'i16' | 'u16' | 'u8' | 'rgba8';

/**
 * One raster of a tile, `width` x `depth` cells in rows of increasing z. `value * scale` is the value in `unit`. An
 * `rgba8` layer holds 4 bytes per cell.
 */
export interface RasterLayer {
  /** Layer name, such as `'temperature'`. */
  readonly name: string;
  readonly format: LayerFormat;
  readonly width: number;
  readonly depth: number;
  /** Cell values, row-major (index `z * width + x`). */
  readonly data: Int32Array | Int16Array | Uint16Array | Uint8Array;
  /** Size of one stored unit in `unit`. */
  readonly scale: number;
  /** Unit of `data * scale`. */
  readonly unit: string;
}

/** A layer's format, scale and unit. */
export interface LayerInfo {
  readonly format: LayerFormat;
  readonly scale: number;
  readonly unit: string;
  /** What the layer holds. */
  readonly about: string;
}

/** Every built-in tile layer, in canonical (digest) order. */
export const LAYERS: Readonly<Record<string, LayerInfo>> = Object.freeze({
  height: { format: 'i32', scale: 0.001, unit: 'm', about: 'terrain height' },
  slope: { format: 'i16', scale: 1 / 256, unit: 'tan', about: 'gradient magnitude (rise over run), Horn 3x3' },
  aspect: {
    format: 'i16',
    scale: 360 / 65536,
    unit: 'degrees',
    about: 'downslope direction, clockwise from north (-Z); east (+X) is 90',
  },
  curvature: {
    format: 'i16',
    scale: 0.0001,
    unit: '1/m',
    about: 'general curvature of the 3x3 quadratic fit, positive on convex ground',
  },
  tpi: { format: 'i16', scale: 0.1, unit: 'm', about: 'topographic position: height minus the 49 m box mean' },
  temperature: { format: 'i16', scale: 0.01, unit: 'C', about: 'mean annual air temperature' },
  coldest: { format: 'i16', scale: 0.01, unit: 'C', about: 'mean temperature of the coldest month' },
  warmest: { format: 'i16', scale: 0.01, unit: 'C', about: 'mean temperature of the warmest month' },
  gdd5: { format: 'u16', scale: 1, unit: 'C day', about: 'growing degree days above 5 C' },
  season: { format: 'u16', scale: 1, unit: 'days', about: 'days with a mean above 0.9 C (growing season)' },
  treeline: {
    format: 'i16',
    scale: 0.01,
    unit: 'K',
    about: 'Korner thermal treeline margin: trees grow where it is 0 or more',
  },
  rainfall: { format: 'u16', scale: 1, unit: 'mm/yr', about: 'annual rainfall with orography and rain shadow' },
  alpha: { format: 'u8', scale: 1 / 255, unit: '0..1', about: 'moisture index AET / PET (Fu-Budyko)' },
  moisture: {
    format: 'u8',
    scale: 1 / 255,
    unit: '0..1',
    about: 'soil moisture: moisture index plus topographic wetness and nearness to water',
  },
  exposure: { format: 'u8', scale: 1 / 255, unit: '0..1', about: 'wind exposure (Winstral Sx), 0.5 on flat ground' },
  waterDistance: { format: 'u16', scale: 0.1, unit: 'm', about: 'distance to the sea or a river' },
  soil: { format: 'u8', scale: 0.01, unit: 'm', about: 'soil depth proxy, 0 to 2.55 m' },
  profile: { format: 'i16', scale: 0.0001, unit: '1/m', about: 'profile curvature (on request)' },
  plan: { format: 'i16', scale: 0.0001, unit: '1/m', about: 'plan curvature (on request)' },
});

/** Layers a tile computes unless a request names others. */
export const DEFAULT_LAYERS: readonly string[] = Object.freeze(
  Object.keys(LAYERS).filter((name) => name !== 'profile' && name !== 'plan'),
);

const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Canonical bytes of a set of layers: per layer in the given order, its name, format, size and little-endian data. */
export function canonicalBytes(layers: readonly RasterLayer[]): Uint8Array {
  const encoder = new TextEncoder(),
    parts: Uint8Array[] = [];
  for (const layer of layers) {
    const head = encoder.encode(`${layer.name}:${layer.format}:${layer.width}x${layer.depth};`);
    parts.push(head);
    const bytes = new Uint8Array(layer.data.buffer, layer.data.byteOffset, layer.data.byteLength);
    if (littleEndian || layer.data.BYTES_PER_ELEMENT === 1) parts.push(bytes);
    else {
      const swapped = new Uint8Array(bytes.length),
        size = layer.data.BYTES_PER_ELEMENT;
      for (let i = 0; i < bytes.length; i += size)
        for (let b = 0; b < size; b++) swapped[i + b] = bytes[i + size - 1 - b];
      parts.push(swapped);
    }
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** SHA-256 hex digest through Web Crypto (browsers in a secure context, Node 20+, workers). */
export async function sha256(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle)
    throw fault(
      'unsupported',
      'Biome digests need Web Crypto (crypto.subtle); serve the page over https or localhost',
      'biomes',
    );
  const hash = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let hex = '';
  for (const b of hash) hex += b.toString(16).padStart(2, '0');
  return hex;
}
