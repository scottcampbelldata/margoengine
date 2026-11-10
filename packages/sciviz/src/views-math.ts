import { rangeError } from '../../shared/errors.js';
import type { AnnotationPoint, PickVolume } from './annotate-math.js';

/** A nearest-sample orthogonal plane, retaining physical endpoint order and original voxel IDs. */
export interface VolumeSlice {
  readonly data: Float64Array;
  readonly indices: Uint32Array;
  readonly nx: number;
  readonly ny: number;
  readonly x: readonly [number, number];
  readonly y: readonly [number, number];
  readonly axes: readonly [number, number];
  readonly index: number;
  readonly position: number;
}
/** Validate a regular CPU volume once before creating linked views. */
export function validateViewVolume(volume: PickVolume): readonly number[] {
  const d = volume.dims,
    b = volume.bounds ?? [0, d[0] - 1, 0, d[1] - 1, 0, d[2] - 1];
  if (
    d.length !== 3 ||
    !d.every((v) => Number.isSafeInteger(v) && v >= 2) ||
    !Number.isSafeInteger(d[0] * d[1] * d[2]) ||
    d[0] * d[1] * d[2] !== volume.data.length ||
    volume.data.length > 0xffffffff ||
    b.length !== 6 ||
    !b.every(Number.isFinite) ||
    [0, 1, 2].some((i) => b[2 * i] === b[2 * i + 1] || !Number.isFinite(b[2 * i + 1] - b[2 * i]))
  )
    throw rangeError(
      'Linked volume views need exact CPU samples, dimensions >=2 and finite nonzero physical spans',
      'sciviz',
    );
  return b;
}
/** Clamp a finite physical crosshair to the volume's sample-centre domain. */
export function clampCrosshair(bounds: readonly number[], position: AnnotationPoint): [number, number, number] {
  if (position.length !== 3 || !position.every(Number.isFinite))
    throw rangeError('Crosshair needs three finite physical coordinates', 'sciviz');
  return position.map((v, i) =>
    Math.max(Math.min(bounds[2 * i], bounds[2 * i + 1]), Math.min(Math.max(bounds[2 * i], bounds[2 * i + 1]), v)),
  ) as [number, number, number];
}
/** Extract an exact nearest-sample x/y/z slice, x-fastest in the returned plane. */
export function volumeSlice(volume: PickVolume, axis: 'x' | 'y' | 'z', position: number): VolumeSlice {
  const b = validateViewVolume(volume),
    d = volume.dims,
    a = ['x', 'y', 'z'].indexOf(axis);
  if (a < 0 || !Number.isFinite(position))
    throw rangeError('Choose x, y or z and a finite physical slice position', 'sciviz');
  const index = Math.round(Math.max(0, Math.min(1, (position - b[2 * a]) / (b[2 * a + 1] - b[2 * a]))) * (d[a] - 1));
  const axes = [0, 1, 2].filter((i) => i !== a) as [number, number],
    nx = d[axes[0]],
    ny = d[axes[1]],
    data = new Float64Array(nx * ny),
    indices = new Uint32Array(nx * ny),
    xyz = [0, 0, 0];
  xyz[a] = index;
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      xyz[axes[0]] = x;
      xyz[axes[1]] = y;
      const id = xyz[0] + d[0] * (xyz[1] + d[1] * xyz[2]),
        k = x + nx * y;
      data[k] = volume.data[id];
      indices[k] = id;
    }
  return {
    data,
    indices,
    nx,
    ny,
    x: [b[axes[0] * 2], b[axes[0] * 2 + 1]],
    y: [b[axes[1] * 2], b[axes[1] * 2 + 1]],
    axes,
    index,
    position: b[a * 2] + (index * (b[a * 2 + 1] - b[a * 2])) / (d[a] - 1),
  };
}
