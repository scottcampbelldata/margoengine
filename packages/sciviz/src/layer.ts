// Pieces the sciviz layers share: data inputs (CPU arrays or compute GpuArrays, read by the GPU where they already
// live), colour-map textures, and the figure's data-to-scene transform.
import type { GpuArray } from '@margoengine/compute';
import { rangeError, typeError } from '../../shared/errors.js';
import { colormap, type Colormap, type ColormapName, type SRGB } from './colormaps.js';

declare const GPUBufferUsage: { STORAGE: number; COPY_DST: number; COPY_SRC: number };
declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number };

/** Numbers a layer takes: a TypedArray or plain array (uploaded), or a GpuArray from @margoengine/compute (used in place). */
export type DataSource = ArrayLike<number> | GpuArray;

/** A colour map by name, a Colormap, or your own stops. */
export type ColormapSource = ColormapName | Colormap | readonly (string | SRGB | readonly [number, string | SRGB])[];

/** True for a compute GpuArray (checked by shape, so sciviz needs no static import of compute). */
export const isGpuArray = (value: unknown): value is GpuArray =>
  typeof value === 'object' && value !== null && 'storage' in value && 'buffer' in value && 'shape' in value;

/** Number of elements of a data source. */
export const sizeOf = (data: DataSource): number => (isGpuArray(data) ? data.size : data.length);

/** Min and max of CPU data, skipping NaN; [0, 1] when there is nothing finite. */
export function extent(data: ArrayLike<number>): [number, number] {
  let lo = Infinity,
    hi = -Infinity;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : [0, 1];
}

/**
 * A read-only storage buffer holding `data` as f32: a GpuArray's own buffer when it is a contiguous f32 array (no
 * copy; the caller must keep it alive), otherwise a new buffer the caller owns (`owned`).
 */
export function storageOf(device: GPUDevice, data: DataSource, what: string): { buffer: GPUBuffer; owned: boolean } {
  if (isGpuArray(data)) {
    if (data.dtype === 'f32' && data.contiguous && data.offset === 0) return { buffer: data.buffer, owned: false };
    throw typeError(`${what} GpuArray must be contiguous f32; pass array.astype('f32').eval()`, 'sciviz');
  }
  if (typeof data !== 'object' || data === null || typeof data.length !== 'number')
    throw typeError(`${what} must be a TypedArray, an array of numbers or a GpuArray`, 'sciviz');
  const values = data instanceof Float32Array ? data : Float32Array.from(data);
  const buffer = device.createBuffer({
    size: Math.max(16, Math.ceil(values.byteLength / 16) * 16),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(buffer, 0, values as Float32Array<ArrayBuffer>);
  return { buffer, owned: true };
}

/** A 256 x 1 colour-map texture (sRGB, so sampling filters in linear light). */
export function colormapTexture(device: GPUDevice, map: Colormap): GPUTexture {
  const texture = device.createTexture({
    size: [256, 1],
    format: 'rgba8unorm-srgb',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const table = map.table(256),
    bytes = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) bytes[i] = Math.round(table[i] * 255);
  device.queue.writeTexture({ texture }, bytes, { bytesPerRow: 1024 }, [256, 1]);
  return texture;
}

/** Resolves a colour map option (default `'aurora'`). */
export const resolveColormap = (source: ColormapSource | undefined): Colormap => colormap(source ?? 'aurora');

/** A checked [min, max] range option. */
export function rangeOption(range: readonly [number, number] | undefined, what: string): [number, number] | undefined {
  if (range === undefined) return undefined;
  const [lo, hi] = range;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo))
    throw rangeError(`${what} must be finite [min, max] with min < max, got [${lo}, ${hi}]`, 'sciviz');
  return [lo, hi];
}

/** Axis-aligned bounds in data units: [xmin, xmax, ymin, ymax, zmin, zmax]. */
export type Bounds = [number, number, number, number, number, number];

/**
 * The figure's mapping from data units to the scene: data x, y, z go to scene x, -z, y (z up in the plot, y up in
 * the engine), centred and scaled so the data bounds fill a box of half-size `half`. Returns a column-major 4x4.
 */
export function dataToScene(bounds: Bounds, half: readonly [number, number, number]): Float32Array {
  const scale = (lo: number, hi: number, h: number) => (hi > lo ? (2 * h) / (hi - lo) : 1),
    sx = scale(bounds[0], bounds[1], half[0]),
    sy = scale(bounds[2], bounds[3], half[1]),
    sz = scale(bounds[4], bounds[5], half[2]),
    cx = (bounds[0] + bounds[1]) / 2,
    cy = (bounds[2] + bounds[3]) / 2,
    cz = (bounds[4] + bounds[5]) / 2;
  // Columns: where data x, y and z units go, then the translation.
  return new Float32Array([sx, 0, 0, 0, 0, 0, -sy, 0, 0, sz, 0, 0, -sx * cx, -sz * cz, sy * cy, 1]);
}

/** Scene position of a data point under `model` (from {@link dataToScene}). */
export function toScene(model: ArrayLike<number>, x: number, y: number, z: number): [number, number, number] {
  return [
    model[0] * x + model[4] * y + model[8] * z + model[12],
    model[1] * x + model[5] * y + model[9] * z + model[13],
    model[2] * x + model[6] * y + model[10] * z + model[14],
  ];
}
