import { rangeError } from '../../shared/errors.js';
import type { Bounds } from './layer.js';
import type { Figure } from './figure.js';
import type { VolumeLayer, VolumeLayerOptions } from './volume.js';

/** Scalar image or volume in storage order, x fastest. Coordinates are zero based sample centres. */
export interface ScientificImage {
  readonly data: ArrayLike<number>;
  readonly dims: readonly [number, number, number];
  /** Exact index to physical coordinate transform, including shear or rotated axes. */
  world(index: readonly number[]): readonly number[];
}
/** Renderer grid plus its physical transform. The bounds enclose transformed sample centres. */
export interface ScientificGrid {
  readonly data: Float32Array;
  readonly dims: [number, number, number];
  readonly bounds: Bounds;
  readonly range: [number, number];
  readonly image: ScientificImage;
}
/** Converts a selected scalar image to the renderer's Float32 grid, retaining the source world transform. */
export function imageGrid(image: ScientificImage): ScientificGrid {
  const dims: [number, number, number] = [...image.dims],
    data = Float32Array.from(image.data);
  if (data.length !== dims[0] * dims[1] * dims[2])
    throw rangeError('Scientific grid sample count differs from dimensions', 'sciviz');
  const bounds: Bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p = image.world(dims.map((n, i) => (corner & (1 << i) ? n - 1 : 0)));
    for (let i = 0; i < 3; i++) {
      bounds[2 * i] = Math.min(bounds[2 * i], p[i] ?? 0);
      bounds[2 * i + 1] = Math.max(bounds[2 * i + 1], p[i] ?? 0);
    }
  }
  // Singleton axes occupy one unit so 2D images remain usable as a one-plane volume.
  for (let i = 0; i < 3; i++) if (bounds[2 * i] === bounds[2 * i + 1]) bounds[2 * i + 1]++;
  let lo = Infinity,
    hi = -Infinity;
  for (const v of data)
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  return { data, dims, bounds, range: lo <= hi ? [lo, hi] : [0, 0], image };
}
/** Draws the storage grid. Use image.world for picking in rotated, sheared or celestial coordinates. */
export function imageVolume(figure: Figure, image: ScientificImage, options: VolumeLayerOptions = {}): VolumeLayer {
  const grid = imageGrid(image);
  return figure.volume(grid.data, {
    ...options,
    dims: grid.dims,
    bounds: options.bounds ?? grid.bounds,
    range: options.range ?? (grid.range[0] < grid.range[1] ? grid.range : undefined),
  });
}
