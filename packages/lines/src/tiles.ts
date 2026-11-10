import type { Camera } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';
import { lineTiles } from './tile-state.js';
/** Full-image pixel coordinate system for a cropped rendering camera. */
export interface LineCameraTile {
  /** Full, uncropped view-projection matrix. Copied on assignment. */
  readonly matrix: ArrayLike<number>;
  readonly fullWidth: number;
  readonly fullHeight: number;
  /** Output tile rectangle in full-image pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/**
 * Keeps line joins, widths, dashes and edge distances in the whole image's coordinate system, applying the tile
 * crop only to the completed vertex. Returns an idempotent remover. Does not alter the camera or other views.
 * Use with a camera cropped to the same tile; applies to Lines and LineBatch, including their shader variants.
 */
export function setLineCameraTile(camera: Camera, tile: LineCameraTile): () => void {
  if (
    tile.matrix.length !== 16 ||
    !Array.from(tile.matrix).every(Number.isFinite) ||
    ![tile.fullWidth, tile.fullHeight, tile.width, tile.height].every((n) => Number.isSafeInteger(n) && n > 0) ||
    ![tile.x, tile.y].every((n) => Number.isSafeInteger(n) && n >= 0) ||
    tile.x + tile.width > tile.fullWidth ||
    tile.y + tile.height > tile.fullHeight
  )
    throw rangeError('Line tile needs a finite matrix and a positive rectangle inside the full image', 'arguments');
  const state = { ...tile, matrix: Float32Array.from(tile.matrix) };
  lineTiles.set(camera, state);
  return () => {
    if (lineTiles.get(camera) === state) lineTiles.delete(camera);
  };
}
