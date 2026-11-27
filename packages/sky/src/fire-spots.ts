// The glows fires put on a haze (`fog.fireSpots`) and on the smoke layer over it (`atmosphere.fireSpots`): one list
// shape, checked and packed here for both, two vec4 each: colour and reach squared, then x, lit height and z. A spot
// left out is all zero, and the shaders stop at the first reach of 0.
import type { SkyFireSpot } from './base.js';

/** Fire spots a haze or a smoke layer takes: `fog.fireSpots` and `atmosphere.fireSpots` hold at most this many. */
export const SKY_FIRE_SPOTS = 8;

const within = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && v >= lo && v <= hi;

/** Throws a RangeError naming `what` unless `spots` is left out or a list of at most eight valid spots. */
export function checkFireSpots(spots: readonly SkyFireSpot[] | undefined, what: string): void {
  if (spots === undefined) return;
  if (!Array.isArray(spots) || spots.length > SKY_FIRE_SPOTS)
    throw new RangeError(`Invalid sky ${what}; use a list of at most ${SKY_FIRE_SPOTS} spots {color, x, z}`);
  for (const s of spots as readonly SkyFireSpot[])
    if (
      typeof s !== 'object' ||
      s === null ||
      !Array.isArray(s.color) ||
      s.color.length !== 3 ||
      !s.color.every((v) => within(v, 0, 4)) ||
      !within(s.x, -1e7, 1e7) ||
      !within(s.z, -1e7, 1e7) ||
      !within(s.height ?? 1000, -1e5, 1e5) ||
      !within(s.reach ?? 1000, 1, 1e6)
    )
      throw new RangeError(
        `Invalid sky ${what}; each spot is {color: three numbers 0 to 4, x, z, height -1e5 to 1e5, reach 1 to 1e6}`,
      );
}

/** Writes the eight spots' 64 floats at `at`, each colour times `scale`. */
export function writeFireSpots(
  out: Float32Array,
  at: number,
  spots: readonly SkyFireSpot[] | undefined,
  scale = 1,
): void {
  out.fill(0, at, at + 8 * SKY_FIRE_SPOTS);
  spots?.forEach((s, i) => {
    const o = at + 8 * i;
    out[o] = s.color[0] * scale;
    out[o + 1] = s.color[1] * scale;
    out[o + 2] = s.color[2] * scale;
    out[o + 3] = (s.reach ?? 1000) ** 2;
    out[o + 4] = s.x;
    out[o + 5] = s.height ?? 1000;
    out[o + 6] = s.z;
  });
}
