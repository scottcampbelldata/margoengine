import { MargoError } from '@margoengine/math/errors';
import { exp, ln, pow } from '@margoengine/math/pinned';

/** An age-dependent, isotropic horizontal diffusion law for parcels released as one cloud. */
export interface TracerHorizontalDispersion {
  /** Scale in metres at which `horizontalDiffusivity` applies. Scale is three times the RMS radial displacement. */
  referenceScale: number;
  /** Diffusivity scale exponent from zero up to two, exclusive. Defaults to Richardson's four-thirds law. */
  exponent?: number;
  /** Initial unresolved scale, m (default 0 for a point release). */
  initialScale?: number;
}

export interface HorizontalDispersionLaw {
  referenceVariance: number;
  initial: number;
  rate: number;
  power: number;
}

export function horizontalDispersionLaw(
  { referenceScale, exponent = 4 / 3, initialScale = 0 }: TracerHorizontalDispersion,
  diffusivity: number,
): HorizontalDispersionLaw {
  if (
    !(
      referenceScale > 0 &&
      Number.isFinite(referenceScale) &&
      initialScale >= 0 &&
      Number.isFinite(initialScale) &&
      exponent >= 0 &&
      exponent < 2
    )
  )
    throw new MargoError(
      'unsupported',
      'The horizontal dispersion law is outside range; supply finite scales with a positive reference and an exponent from zero to less than two.',
    );
  const referenceRms = referenceScale / 3;
  const referenceVariance = referenceRms * referenceRms;
  const ratio = initialScale / referenceScale;
  const p = 1 - exponent / 2;
  const initial = pow(ratio, 2 * p);
  const rate = (4 * p * diffusivity) / referenceVariance;
  if (
    !(
      referenceVariance > 0 &&
      [referenceVariance, initial, rate].every(Number.isFinite) &&
      (rate > 0 || diffusivity === 0)
    )
  )
    throw new MargoError(
      'unsupported',
      'The horizontal diffusion scales exceed numeric range; use finite physical scales and diffusivity.',
    );
  return { referenceVariance, initial, rate, power: 1 / p };
}

/** Axis standard deviation over one step from d<R²>/dt = 4 K_ref (3 sqrt(<R²>)/L_ref)^exponent. */
export function horizontalSpread(law: HorizontalDispersionLaw, age: number, dt: number): number {
  const { referenceVariance, initial, rate, power } = law;
  const start = initial + rate * age;
  const increment = rate * dt;
  if (increment === 0) return 0;
  let growth: number;
  if (start === 0) {
    growth = pow(increment, power);
  } else {
    const ratio = increment / start;
    const sum = 1 + ratio;
    const change = power * (sum === 1 ? ratio : (ln(sum) / (sum - 1)) * ratio);
    const before = pow(start, power);
    // Subtract the variances directly for large changes. For small changes, use a relative increment.
    if (change < 1e-3) growth = before * change * (1 + change * (0.5 + change * (1 / 6 + change / 24)));
    else if (change < 0.5) growth = before * (exp(change) - 1);
    else growth = pow(start + increment, power) - before;
  }
  const spread = Math.sqrt(0.5 * referenceVariance * growth);
  if (!Number.isFinite(spread))
    throw new MargoError(
      'unsupported',
      'Horizontal dispersion exceeded numeric range; use physical scales, age and diffusivity.',
    );
  return spread;
}

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
