// Small helpers the robot model, the planner and the GPU check share. They read @margoengine/kinematics-constraints
// volumes through that package's public classes; where a helper needs a volume's own geometry (a hull's points, a
// field's grid) it reads the same fields the volume keeps, by name, as that package's own internal helpers do.
import type { ConstraintVolume, ConvexHullVolume, Vec3View } from '@margoengine/kinematics-constraints';

export { validateVector } from '../../shared/validate-vector.js';

/**
 * Signed gap of a capsule link to any volume, written to `outDistance[0]`; NaN when the volume gives no finite gap. It
 * goes through the volume's public contract, which the built-in volumes answer without allocating.
 */
export function segmentVolumeInto(
  volume: ConstraintVolume,
  start: Vec3View,
  end: Vec3View,
  radius: number,
  outDistance: Float64Array,
): void {
  if (volume.segmentClearanceInto) volume.segmentClearanceInto(start, end, radius, outDistance);
  else {
    const distance = volume.segmentClearance(start, end, radius);
    outDistance[0] = Number.isFinite(distance) ? distance : NaN;
  }
}

interface HullShape {
  points: Float64Array;
  matrix: Float64Array;
}

/** The distinct points of a hull in its local space, flat. Read, do not write. */
export function hullPoints(hull: ConvexHullVolume): Float64Array {
  return (hull['shape' as keyof ConvexHullVolume] as unknown as HullShape).points;
}

/** The distinct points of a hull in the world, flat. */
export function hullWorldPoints(hull: ConvexHullVolume): Float64Array {
  const { points, matrix: m } = hull['shape' as keyof ConvexHullVolume] as unknown as HullShape,
    out = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i],
      y = points[i + 1],
      z = points[i + 2];
    for (let r = 0; r < 3; r++) out[i + r] = m[r] * x + m[3 + r] * y + m[6 + r] * z + m[9 + r];
  }
  return out;
}

/** A sampled field as plain numbers, as `GPUClearance` uploads it. */
export interface GridColliderData {
  /** One sample per grid corner, x fastest. */
  samples: Float32Array;
  size: readonly [number, number, number];
  min: ArrayLike<number>;
  max: ArrayLike<number>;
  spacing: ArrayLike<number>;
  /** World to field space: the columns of a 3x4 matrix. */
  inverse: Float64Array;
  scale: number;
  margin: number;
  precision: number;
  lipschitz: number;
  maxCells: number;
}

interface FieldVolume {
  grid: boolean;
  field: {
    distance(point: Float64Array): number;
    min?: ArrayLike<number>;
    max?: ArrayLike<number>;
    spacing?: ArrayLike<number>;
  };
  placement: { inverse: Float64Array; scale: number };
  margin: number;
  precision: number;
  lipschitz: number;
  maxCells: number;
}

/**
 * The grid of an `SDFVolume` (from `@margoengine/kinematics-constraints/sdf`) with that volume's settings, read at every
 * corner; null for any other volume and for a field that is a plain function. A volume of the caller's own may give its
 * grid by a `gridData()` method of the same shape.
 */
export function gridData(volume: ConstraintVolume): GridColliderData | null {
  const own = (volume as { gridData?: () => GridColliderData | null }).gridData;
  if (typeof own === 'function') return own.call(volume);
  const v = volume as unknown as Partial<FieldVolume>;
  if (v.grid !== true || !v.field || !v.placement) return null;
  const { field, placement } = v as FieldVolume,
    min = field.min!,
    max = field.max!,
    spacing = field.spacing!,
    nx = Math.round((max[0] - min[0]) / spacing[0]) + 1,
    ny = Math.round((max[1] - min[1]) / spacing[1]) + 1,
    nz = Math.round((max[2] - min[2]) / spacing[2]) + 1,
    samples = new Float32Array(nx * ny * nz),
    corner = new Float64Array(3);
  for (let z = 0, at = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, at++) {
        corner[0] = Math.min(min[0] + x * spacing[0], max[0]);
        corner[1] = Math.min(min[1] + y * spacing[1], max[1]);
        corner[2] = Math.min(min[2] + z * spacing[2], max[2]);
        samples[at] = field.distance(corner);
      }
    }
  }
  return {
    samples,
    size: [nx, ny, nz],
    min,
    max,
    spacing,
    inverse: placement.inverse.slice(),
    scale: placement.scale,
    margin: v.margin!,
    precision: v.precision!,
    lipschitz: v.lipschitz!,
    maxCells: v.maxCells!,
  };
}
