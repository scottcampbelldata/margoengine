import { fault, rangeError } from '../../shared/errors.js';
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
/** Renderer grid plus its physical transform. Bounds retain first-to-last sample order on each axis. */
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
  const origin = image.world([0, 0, 0]),
    bounds: Bounds = [0, 0, 0, 0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const last = [0, 0, 0];
    last[axis] = dims[axis] - 1;
    bounds[2 * axis] = origin[axis] ?? 0;
    bounds[2 * axis + 1] = image.world(last)[axis] ?? 0;
  }
  // Include every axis: an orthogonal cell's cos(pi/2) terms can round into a
  // singleton axis whose own extent is zero.
  const rounding =
    32 *
    Number.EPSILON *
    Math.max(...bounds.map(Math.abs), ...[0, 1, 2].map((axis) => Math.abs(bounds[2 * axis + 1] - bounds[2 * axis])));
  let lo = Infinity,
    hi = -Infinity;
  for (let n = 0; n < data.length; n++) {
    const index = [n % dims[0], Math.floor(n / dims[0]) % dims[1], Math.floor(n / (dims[0] * dims[1]))],
      physical = image.world(index);
    // A box cannot encode cross-axis coupling or unequal physical sample spacing.
    // Check every sample, not just the corners, which can hide nonlinear distortion.
    for (let axis = 0; axis < 3; axis++) {
      const first = bounds[2 * axis],
        last = bounds[2 * axis + 1],
        expected = first + (dims[axis] > 1 ? index[axis] / (dims[axis] - 1) : 0) * (last - first),
        actual = physical[axis] ?? 0;
      if (!Number.isFinite(expected) || !Number.isFinite(actual) || Math.abs(actual - expected) > rounding)
        throw fault(
          'unsupported',
          'Scientific grid needs an axis-aligned uniformly spaced world transform; resample the image into physical axes before rendering',
          'sciviz',
        );
    }
    const v = data[n];
    if (Number.isFinite(v)) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  // Give a singleton axis a nonzero display extent while keeping its first sample fixed.
  for (let i = 0; i < 3; i++) if (bounds[2 * i] === bounds[2 * i + 1]) bounds[2 * i + 1]++;
  return { data, dims, bounds, range: lo <= hi ? [lo, hi] : [0, 0], image };
}
/** Draws a grid in physical axes; resample rotated, sheared or nonuniform images before drawing. */
export function imageVolume(figure: Figure, image: ScientificImage, options: VolumeLayerOptions = {}): VolumeLayer {
  const grid = imageGrid(image);
  return figure.volume(grid.data, {
    ...options,
    dims: grid.dims,
    bounds: options.bounds ?? grid.bounds,
    range: options.range ?? (grid.range[0] < grid.range[1] ? grid.range : undefined),
  });
}
