import { hypot } from '@margoengine/math/pinned';
import type { Physics } from '../physics.js';
import { fallingError } from './errors.js';
import { dot, finiteVector, type Vector } from './model.js';

/** First blocking contact of a sphere swept along a segment. */
export interface FallingHit {
  /** Position along the sweep segment in [0, 1]. */
  readonly fraction: number;
  /** Outward normal of the static scene. Its magnitude need only be nonzero. */
  readonly normal: Vector;
}

/** Pure fixed-geometry query. Rewrite positions in this boundary's cell before calling it. */
export interface FallingBoundary {
  /** Integer cell that bounds the coordinates given to sweep. */
  readonly cell: Vector;
  /** Returns the first inward hit or null, including an inward hit at fraction zero. A departing or tangent contact is free. */
  sweep(centre: Vector, displacement: Vector, radius: number): FallingHit | null;
}

const IDENTITY = [0, 0, 0, 1] as const;

/** Adapts a rigid scene's fixed, nonsensor colliders to the falling solver's swept-sphere query. */
export function fallingBoundaryFromPhysics(physics: Physics, cell: Vector = [0, 0, 0]): FallingBoundary {
  return {
    cell,
    sweep(centre, displacement, radius) {
      const distance = hypot(...displacement);
      if (distance === 0) return null;
      const hit = physics.shapeCast({ shape: 'sphere', radius }, centre, IDENTITY, displacement, {
        maxDistance: distance,
        stopAtPenetration: false,
        onlyFixed: true,
        excludeSensors: true,
      });
      if (!hit || dot(hit.normal, displacement) >= 0) return null;
      // The rigid query reports distance in f32, so the fraction can be
      // one rounding unit past the requested displacement length.
      return { fraction: Math.min(hit.distance / distance, 1), normal: hit.normal };
    },
  };
}

const step = (a: Vector, b: Vector, scale: number): Vector => [
  a[0] + b[0] * scale,
  a[1] + b[1] * scale,
  a[2] + b[2] * scale,
];

/**
 * Sweep the per-tick displacement and reflect its residual along each
 * blocking face. The chord approximates the curved trajectory over this
 * tick. A sustained contact uses the same normal projection to support
 * the weight as long as the predicted displacement points into it.
 */
export function collideSphere(
  boundary: FallingBoundary,
  radius: number,
  restitution: number,
  previous: Vector,
  trial: Vector,
  velocity: Vector,
  originShift: Vector,
): { centre: Vector; velocity: Vector } {
  let centre = previous;
  let remaining = step(trial, previous, -1);
  let samePoint = false;
  for (;;) {
    const end = step(centre, remaining, 1);
    const query = step(centre, originShift, 1);
    if (!finiteVector(end) || !finiteVector(query) || !finiteVector(velocity))
      throw fallingError('Falling sweep overflowed. Use local origins, lower speeds or shorter steps.', 'failed');
    if (end[0] === centre[0] && end[1] === centre[1] && end[2] === centre[2]) return { centre, velocity };
    const hit = boundary.sweep(query, remaining, radius);
    if (hit === null) return { centre: end, velocity };
    const normalInput = hit?.normal;
    const scale = finiteVector(normalInput) ? hypot(normalInput[0], normalInput[1], normalInput[2]) : 0;
    if (
      !Number.isFinite(hit?.fraction) ||
      hit.fraction < 0 ||
      hit.fraction > 1 ||
      !Number.isFinite(scale) ||
      !(scale > 0)
    )
      throw fallingError(
        'Falling boundary produced an invalid contact. Provide a segment fraction and a nonzero finite outward normal.',
        'failed',
      );
    const normal: Vector = [hit.normal[0] / scale, hit.normal[1] / scale, hit.normal[2] / scale];
    const normalDistance = dot(remaining, normal);
    if (!(normalDistance < 0))
      throw fallingError(
        'Falling boundary returned a contact without approach. Use null for tangent and departing sweeps.',
        'failed',
      );
    const next = step(centre, remaining, hit.fraction);
    const madeProgress = next[0] !== centre[0] || next[1] !== centre[1] || next[2] !== centre[2];
    // Multiple zero-time faces are one contact set rather than repeated
    // elastic impacts. Project the additional faces to avoid generating
    // bounce energy at corners sharing a contact point.
    const bounce = !madeProgress && samePoint ? 0 : restitution;
    const factor = 1 + bounce;
    const normalSpeed = Math.min(0, dot(velocity, normal));
    velocity = step(velocity, normal, -factor * normalSpeed);
    centre = next;
    samePoint = !madeProgress;
    const reflected = step(remaining, normal, -factor * normalDistance);
    const unspent = 1 - hit.fraction;
    const output = reflected.map((value) => unspent * value) as [number, number, number];
    if (!madeProgress) {
      // Stop when further projection is below floating-point resolution.
      // Compare magnitudes of changes in the small displacement, rather
      // than metres from the scene origin.
      const change = hypot(output[0] - remaining[0], output[1] - remaining[1], output[2] - remaining[2]);
      if (change <= Number.EPSILON * hypot(...remaining)) return { centre, velocity };
    }
    remaining = output;
  }
}
