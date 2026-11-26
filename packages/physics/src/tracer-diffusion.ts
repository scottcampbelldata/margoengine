import { MargoError } from '@margoengine/math/errors';

/** A vertical eddy diffusivity at a specified distance below the local water surface. */
export interface TracerDiffusionKnot {
  /** Depth below the local free surface, m. */
  depth: number;
  /** Vertical eddy diffusivity in m²/s. */
  diffusivity: number;
}

interface DiffusionSegment extends TracerDiffusionKnot {
  gradient: number;
}

export function depthDiffusivity(knots: readonly TracerDiffusionKnot[]): readonly DiffusionSegment[] {
  if (knots.length < 2)
    throw new MargoError(
      'unsupported',
      'A depth diffusivity profile needs two or more knots; use at least two depths.',
    );
  return knots.map(({ depth, diffusivity }, index) => {
    const next = knots[index + 1];
    if (!(Number.isFinite(depth) && depth >= 0 && Number.isFinite(diffusivity) && diffusivity >= 0))
      throw new MargoError(
        'unsupported',
        'A diffusivity knot is outside range; use finite nonnegative depth and diffusivity.',
      );
    if (next && !(next.depth > depth))
      throw new MargoError(
        'unsupported',
        'Diffusivity depths overlap or run backwards; list distinct depths in ascending order.',
      );
    const gradient = next ? (next.diffusivity - diffusivity) / (next.depth - depth) : 0;
    if (!Number.isFinite(gradient))
      throw new MargoError(
        'unsupported',
        'The diffusivity gradient is outside range; use finite diffusivities at well-separated depths.',
      );
    return { depth, diffusivity, gradient };
  });
}

function segmentAt(profile: readonly DiffusionSegment[], depth: number): number {
  let low = 0;
  let high = profile.length - 1;
  if (depth < profile[low]!.depth) return -1;
  if (depth > profile[high]!.depth) return high;
  while (high - low > 1) {
    const mid = (low + high) >>> 1;
    if (profile[mid]!.depth <= depth) low = mid;
    else high = mid;
  }
  return low;
}

/** Vertical displacement, positive up. Visser (1997), equation 6, applied to a depth coordinate positive down. */
export function turbulentVerticalStep(
  profile: readonly DiffusionSegment[],
  depth: number,
  dt: number,
  normal: number,
): number {
  const drift = -(profile[segmentAt(profile, depth)]?.gradient ?? 0) * dt;
  const midpoint = depth - 0.5 * drift;
  const index = segmentAt(profile, midpoint);
  const start = profile[Math.max(index, 0)]!;
  const end = profile[index + 1] ?? start;
  const blend = start === end ? 0 : (midpoint - start.depth) / (end.depth - start.depth);
  const diffusivity = (1 - blend) * start.diffusivity + blend * end.diffusivity;
  return drift + Math.sqrt(2 * dt * diffusivity) * normal;
}
