import type { Spline } from '@margoengine/splines';
import type { JunctionMesh, JunctionOptions } from '@margoengine/road/junctions';
import { fault } from '../../shared/errors.js';

/** Planar tight-bend repair settings. */
export interface RoadRepairOptions extends Omit<JunctionOptions, 'elevation'> {
  /** Full surface width, above zero through 1000 m. Default 6. */
  width?: number;
  /** Arc-distance chords, integer 1..4095. Default 128. More chords improve the spline approximation. */
  segments?: number;
}

/** Replace a folding planar road sweep with the union of its stroked centre line, triangulated at renderer precision. */
export async function repairRoad(
  curve: Spline,
  { width = 6, segments = 128, ...options }: RoadRepairOptions = {},
): Promise<JunctionMesh> {
  options.signal?.throwIfAborted();
  if (
    !Number.isInteger(segments) ||
    segments < 1 ||
    segments > 4095 ||
    !Number.isFinite(curve.length) ||
    curve.length <= 0
  )
    throw fault(
      'failed',
      'Road repair needs a nonzero spline and 1..4095 segments; pass valid planar road settings',
      'geometry',
    );
  const points: [number, number][] = [],
    p = new Float64Array(3);
  curve.atDistance(0, p);
  const elevation = p[1];
  // Cubic basis summation can move a constant elevation by a few float64 ulps; this bound is below a float32 ulp.
  const tolerance = 128 * Number.EPSILON * Math.max(1, Math.abs(elevation));
  // Each supported span is cubic in its raw parameter. Four distinct values determine it,
  // independently of both the requested chord count and the arc-length lookup divisions.
  const count = curve.points.length / 3;
  const spans = curve.kind === 'bezier' ? (count - 1) / 3 : curve.closed ? count : count - 1;
  for (let span = 0; span < spans; span++)
    for (let k = 0; k <= 3; k++) {
      curve.at((span + k / 3) / spans, p);
      if (!Number.isFinite(p[1]) || Math.abs(p[1] - elevation) > tolerance)
        throw fault(
          'unsupported',
          'Road repair supports constant-elevation curves; split grades or use the root sweep without planar repair',
          'geometry',
        );
    }
  for (let i = 0; i <= segments; i++) {
    curve.atDistance((curve.length * i) / segments, p);
    if (!Number.isFinite(p[1]) || Math.abs(p[1] - elevation) > tolerance)
      throw fault(
        'unsupported',
        'Road repair supports constant-elevation curves; split grades or use the root sweep without planar repair',
        'geometry',
      );
    points.push([p[0], p[2]]);
  }
  const { junctions } = await import('@margoengine/road/junctions');
  options.signal?.throwIfAborted();
  return junctions([{ points, width }], { ...options, elevation });
}
