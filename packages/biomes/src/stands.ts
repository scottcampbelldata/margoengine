// Stands and clearings of a species: the 0..1 share of its density at a point, in integers on world-anchored noise.
// Placement thins candidates with it; the canopy cover of a view (cover.ts) reads the same stands, so far forest and
// its darker ground fall where the trees stand.
import { clampInt, divFloor, fbm, hash2, ONE, qmul, wendland } from '@margoengine/biomes/toolkit';
import type { SpeciesRule } from './define.js';

/** Position unit of placement: 1/256 m (3.9 mm), the step of a record inside a 256 m tile. */
export const TICK = 256;
/** Fade of a stand's edge, in units of the 0..65535 noise (0.6 of its standard deviation): about a quarter of `scale`. */
const STAND_BAND = 6000;
/**
 * The noise level a stand's band is centred on for a cover of 1/16, 2/16 .. 16/16 of the ground: the mean of the band
 * over 3-octave fbm equals the cover. Measured once, 320,000 samples over 16 seeds; the distribution is the same for
 * every seed, and the placement test checks the share it gives.
 */
const STAND_LEVELS = [
  46857, 43445, 40954, 38837, 36934, 35151, 33433, 31745, 30058, 28339, 26559, 24661, 22553, 20044, 16667, 0,
];

/** A stand rule in integers. */
export interface Stands {
  readonly scale: number; // one noise cell, ticks
  readonly top: number; // the noise level (0..65535) from which the density is full
  readonly boost: number; // 1 / cover, Q16: the whole density lives on the cover share of the ground
}

/** A stand rule in integers. A cover of 1 is no stand at all: the same bytes as leaving the rule out. */
export function standsOf(rule: SpeciesRule): Stands | undefined {
  const s = rule.stands;
  if (!s || s.cover >= 1) return undefined;
  const cover = Math.round(s.cover * ONE),
    i = (cover * 16) >> 16, // the cover is at least 0.1, so i is at least 1
    level = STAND_LEVELS[i - 1] + qmul(STAND_LEVELS[i] - STAND_LEVELS[i - 1], (cover * 16) & 0xffff);
  return { scale: Math.round(s.scale * TICK), top: level + (STAND_BAND >> 1), boost: divFloor(ONE * ONE, cover) };
}

/** The stand's share (Q16, 0 in a clearing, `ONE` inside) at world ticks (x, z) from the world's low corner. */
export function standAt(seed: number, st: Stands, x: number, z: number): number {
  const noise = fbm(hash2(seed, st.scale), divFloor(x * ONE, st.scale), divFloor(z * ONE, st.scale), 3);
  return wendland(clampInt(divFloor((st.top - noise) * ONE, STAND_BAND), 0, ONE));
}
