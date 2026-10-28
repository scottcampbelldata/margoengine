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
}

/** Every built-in tile layer, in canonical (digest) order. */
export const LAYERS: Readonly<Record<string, LayerInfo>> = Object.freeze({
  height: { format: 'i32', scale: 0.001, unit: 'm' },
  slope: { format: 'i16', scale: 1 / 256, unit: 'tan' },
  aspect: { format: 'i16', scale: 360 / 65536, unit: 'degrees' },
  curvature: { format: 'i16', scale: 0.0001, unit: '1/m' },
  tpi: { format: 'i16', scale: 0.1, unit: 'm' },
  temperature: { format: 'i16', scale: 0.01, unit: 'C' },
  coldest: { format: 'i16', scale: 0.01, unit: 'C' },
  warmest: { format: 'i16', scale: 0.01, unit: 'C' },
  gdd5: { format: 'u16', scale: 1, unit: 'C day' },
  season: { format: 'u16', scale: 1, unit: 'days' },
  treeline: { format: 'i16', scale: 0.01, unit: 'K' },
  rainfall: { format: 'u16', scale: 1, unit: 'mm/yr' },
  alpha: { format: 'u8', scale: 1 / 255, unit: '0..1' },
  moisture: { format: 'u8', scale: 1 / 255, unit: '0..1' },
  exposure: { format: 'u8', scale: 1 / 255, unit: '0..1' },
  waterDistance: { format: 'u16', scale: 0.1, unit: 'm' },
  soil: { format: 'u8', scale: 0.01, unit: 'm' },
  biome: { format: 'rgba8', scale: 1, unit: 'index' },
  biomeWeight: { format: 'rgba8', scale: 1 / 255, unit: '0..1' },
  profile: { format: 'i16', scale: 0.0001, unit: '1/m' },
  plan: { format: 'i16', scale: 0.0001, unit: '1/m' },
});

/** Layers a tile computes unless a request names others. */
export const DEFAULT_LAYERS: readonly string[] = Object.freeze(
  Object.keys(LAYERS).filter((name) => name !== 'profile' && name !== 'plan'),
);
