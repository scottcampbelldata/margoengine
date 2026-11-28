import { MargoError } from '@margoengine/math/errors';

/** A knot in a depth-dependent sound-speed profile. */
export interface SoundSpeedKnot {
  /** Depth below the free surface in metres. */
  readonly depth: number;
  /** Sound speed in m/s. */
  readonly speed: number;
}

export const PROFILE_WORDS = 3;

export function prepareProfile(knots: readonly SoundSpeedKnot[]): Float64Array {
  if (!Array.isArray(knots) || knots.length < 2 || knots[0]?.depth !== 0)
    throw new MargoError(
      'state',
      'An underwater profile needs a surface and a bottom; start at zero depth and pass at least two knots.',
    );
  const profile = new Float64Array(PROFILE_WORDS * knots.length);
  let previous = -1;
  for (let i = 0; i < knots.length; i++) {
    const knot = knots[i];
    const depth = knot?.depth;
    const speed = knot?.speed;
    if (
      typeof depth !== 'number' ||
      !Number.isFinite(depth) ||
      depth <= previous ||
      typeof speed !== 'number' ||
      !Number.isFinite(speed) ||
      speed <= 0
    )
      throw new MargoError(
        'state',
        'Invalid sound-speed knot; use strictly increasing finite depths and positive finite speeds.',
      );
    const j = i * PROFILE_WORDS;
    profile[j] = depth;
    profile[j + 1] = speed;
    if (i > 0) {
      const slope = (speed - profile[j - 2]!) / (depth - previous);
      if (!Number.isFinite(slope))
        throw new MargoError('state', 'Sound-speed gradient overflows; increase the depth between knots.');
      profile[j - 1] = slope;
    }
    previous = depth;
  }
  return profile;
}

export function soundLayer(profile: Float64Array, depth: number, down: boolean): number {
  let lower = 0;
  let upper = profile.length / PROFILE_WORDS - 1;
  if (!(depth >= 0 && depth <= profile[upper * PROFILE_WORDS]!))
    throw new MargoError('state', 'Depth is outside the acoustic profile; use a depth between the surface and bottom.');
  while (upper - lower > 1) {
    const middle = (lower + upper) >>> 1;
    const boundary = profile[middle * PROFILE_WORDS]!;
    if (depth > boundary || (depth === boundary && down)) lower = middle;
    else upper = middle;
  }
  return lower;
}

export function layerSpeed(profile: Float64Array, offset: number, depth: number): number {
  if (depth === profile[offset + PROFILE_WORDS]) return profile[offset + PROFILE_WORDS + 1]!;
  return profile[offset + 1]! + (depth - profile[offset]!) * profile[offset + 2]!;
}
