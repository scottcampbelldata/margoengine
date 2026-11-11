// Planet recipes: ridged noise, domain warp, combination and presets for PlanetTerrain's ground (`PlanetHeight`).
// Clean room, from: Musgrave, Kolb and Mace 1989, "The Synthesis and Rendering of Eroded Fractal Terrains", SIGGRAPH
// (ridged multifractal: 1 - |noise|, squared, each octave weighted by the one before); Perlin and Hoffert 1989,
// "Hypertexture", SIGGRAPH, and Quilez, "Domain warping" (noise displaced by noise); craters: see planet-craters.ts.
// Preset numbers are authored looks (documented in docs/limits.md), not fits to measured data.
import type { PlanetHeight } from './planet.js';
import { valueNoise } from './noise3.js';
import { craterField } from './planet-craters.js';

export { craterField } from './planet-craters.js';
export type { CraterField, CraterFieldOptions, PlanetCrater } from './planet-craters.js';

const finite = (v: number, lo: number) => Number.isFinite(v) && v >= lo;

/** `ridgeNoise` options. Every one is optional. */
export interface RidgeNoiseOptions {
  /** Planet radius in metres, above 0. Default 6,371,000. */
  radius?: number;
  /** Largest height in metres, 0 or more. The result is between 0 and `relief`. Default 8,000. */
  relief?: number;
  /** Octaves, an integer 1 to 24; octaves finer than twice the `detail` asked for are left out. Default 6. */
  octaves?: number;
  /** How strongly a ridge in one octave lets the next octave show, 0 or more. Default 2 (Musgrave et al. 1989). */
  gain?: number;
  /** Cycles of the first octave around the planet's circumference, above 0. Default 2. */
  frequency?: number;
  /** An integer. Default 1. */
  seed?: number;
}

/**
 * Ridged multifractal noise on the sphere: sharp crests that taper into valleys, 0 to `relief` metres. Octave k has an
 * amplitude of `relief / 2^k` relative to the first; the sum is scaled so it never exceeds `relief`.
 * @throws RangeError on an invalid option.
 */
export function ridgeNoise(options: RidgeNoiseOptions = {}): PlanetHeight {
  const { radius = 6371000, relief = 8000, octaves = 6, gain = 2, frequency = 2, seed = 1 } = options;
  if (
    !(Number.isFinite(radius) && radius > 0) ||
    !finite(relief, 0) ||
    !Number.isInteger(octaves) ||
    octaves < 1 ||
    octaves > 24 ||
    !finite(gain, 0) ||
    !(Number.isFinite(frequency) && frequency > 0) ||
    !Number.isInteger(seed)
  )
    throw new RangeError(
      'Invalid ridgeNoise options; pass radius above 0, relief 0 or more, octaves 1 to 24, gain 0 or more, frequency above 0 and an integer seed',
    );
  let total = 0;
  for (let k = 0; k < octaves; k++) total += 0.5 ** k;
  return (x, y, z, detail) => {
    let sum = 0,
      weight = 1;
    for (let k = 0; k < octaves && (2 * Math.PI * radius) / (frequency * 2 ** k) >= 2 * detail; k++) {
      const f = (frequency * 2 ** k) / (2 * Math.PI),
        ridge = 1 - Math.abs(valueNoise(x * f + k * 7.31, y * f - k * 3.17, z * f + k * 5.79, seed + k)),
        signal = ridge * ridge * weight;
      sum += signal * 0.5 ** k;
      weight = Math.min(1, Math.max(0, signal * gain));
    }
    return (sum / total) * relief;
  };
}

/** `domainWarp` options. Every one is optional. */
export interface DomainWarpOptions {
  /** Planet radius in metres, above 0. Default 6,371,000. */
  radius?: number;
  /** Largest sideways shift of the ground in metres, 0 or more. Default 100,000. */
  amplitude?: number;
  /** Cycles of the warp around the planet's circumference, above 0. Default 8. */
  frequency?: number;
  /** 1, or 2 to warp by a noise that is itself warped. Default 1. */
  levels?: 1 | 2;
  /** An integer. Default 1. */
  seed?: number;
}

/**
 * Reads `base` at positions moved sideways by noise, so straight features bend and craters stretch (Perlin and Hoffert
 * 1989). Heights are unchanged in size; only where they come from moves, by at most `amplitude` metres (twice with two
 * levels).
 * @throws RangeError on an invalid option.
 */
export function domainWarp(base: PlanetHeight, options: DomainWarpOptions = {}): PlanetHeight {
  const { radius = 6371000, amplitude = 100000, frequency = 8, levels = 1, seed = 1 } = options;
  if (
    typeof base !== 'function' ||
    !(Number.isFinite(radius) && radius > 0) ||
    !finite(amplitude, 0) ||
    !(Number.isFinite(frequency) && frequency > 0) ||
    (levels !== 1 && levels !== 2) ||
    !Number.isInteger(seed)
  )
    throw new TypeError(
      'Invalid domainWarp options; pass a height function, radius above 0, amplitude 0 or more, frequency above 0, levels 1 or 2 and an integer seed',
    );
  const f = frequency / (2 * Math.PI),
    shift = amplitude / radius;
  return (x, y, z, detail) => {
    let px = x,
      py = y,
      pz = z;
    for (let level = 0; level < levels; level++) {
      const s = seed + level * 101,
        qx = px * f,
        qy = py * f,
        qz = pz * f;
      px = x + shift * valueNoise(qx + 1.7, qy + 9.2, qz + 3.1, s);
      py = y + shift * valueNoise(qx + 8.3, qy + 2.8, qz + 5.5, s + 1);
      pz = z + shift * valueNoise(qx + 4.1, qy + 6.4, qz + 7.7, s + 2);
    }
    const length = Math.hypot(px, py, pz);
    return base(px / length, py / length, pz / length, detail);
  };
}

/** `combine` options. */
export interface CombineOptions {
  /** `'add'` sums the heights, `'max'` takes the highest, `'smoothMax'` takes the highest with rounded joins. Default `'add'`. */
  mode?: 'add' | 'max' | 'smoothMax';
  /** Width in metres of the `'smoothMax'` join, 0 or more. Default 100. */
  smooth?: number;
}

/**
 * Merges ground functions into one. With `'smoothMax'` more than two fold left to right, so the order matters.
 * @throws TypeError or RangeError on an invalid argument.
 */
export function combine(heights: readonly PlanetHeight[], options: CombineOptions = {}): PlanetHeight {
  const { mode = 'add', smooth = 100 } = options;
  if (!Array.isArray(heights) || heights.length === 0 || heights.some((h) => typeof h !== 'function'))
    throw new TypeError('Invalid combine heights; pass a non-empty array of height functions');
  if (mode !== 'add' && mode !== 'max' && mode !== 'smoothMax') throw new RangeError("Invalid combine mode; pass 'add', 'max' or 'smoothMax'");
  if (!finite(smooth, 0)) throw new RangeError('Invalid combine smooth; pass a width in metres, 0 or more');
  const list = heights.slice();
  return (x, y, z, detail) => {
    let h = list[0]!(x, y, z, detail);
    for (let i = 1; i < list.length; i++) {
      const v = list[i]!(x, y, z, detail);
      if (mode === 'add') h += v;
      else if (mode === 'max' || smooth === 0) h = Math.max(h, v);
      else {
        const t = Math.max(smooth - Math.abs(h - v), 0) / smooth;
        h = Math.max(h, v) + (t * t * smooth) / 4;
      }
    }
    return h;
  };
}

/** A body a preset is made for. */
export type PlanetPresetName = 'moon' | 'mars' | 'asteroid' | 'ice';

const BODIES: Record<PlanetPresetName, { radius: number; relief: number }> = {
  moon: { radius: 1737400, relief: 4000 },
  mars: { radius: 3389500, relief: 8000 },
  asteroid: { radius: 10000, relief: 600 },
  ice: { radius: 1560800, relief: 600 },
};

/**
 * The radius in metres a preset is made for (the Moon, Mars, a 10 km asteroid, Europa): pass it as `radius` to the
 * planet and to `planetPreset`.
 * @throws RangeError for an unknown name.
 */
export function planetPresetRadius(name: PlanetPresetName): number {
  const body = BODIES[name];
  if (!Object.hasOwn(BODIES, name) || !body) throw new RangeError("Invalid planet preset; pass 'moon', 'mars', 'asteroid' or 'ice'");
  return body.radius;
}

/**
 * A ready ground: `'moon'` (old cratered highlands), `'mars'` (fewer, softer craters on ridged uplands), `'asteroid'`
 * (crowded craters on a lumpy body) or `'ice'` (shallow craters and warped ridges). `radius` defaults to the body's own;
 * give the same one to `PlanetTerrain`. Looks are authored, not fits to data.
 * @throws RangeError on an invalid name, radius or seed.
 */
export function planetPreset(name: PlanetPresetName, options: { radius?: number; seed?: number } = {}): PlanetHeight {
  const bodyRadius = planetPresetRadius(name),
    radius = options.radius ?? bodyRadius,
    seed = options.seed ?? 1,
    body = BODIES[name];
  if (!(Number.isFinite(radius) && radius > 0) || !Number.isInteger(seed))
    throw new RangeError('Invalid planetPreset options; pass radius above 0 and an integer seed');
  const k = radius / body.radius,
    ridges = (relief: number, octaves: number) => ridgeNoise({ radius, relief: relief * k, octaves, seed: seed + 5 });
  switch (name) {
    case 'moon':
      return combine([
        ridges(1500, 5),
        craterField({ radius, density: 3000, dMin: radius / 40000, dMax: radius / 6, seed }),
      ]);
    case 'mars':
      return combine([
        ridges(3000, 6),
        craterField({ radius, density: 400, dMin: radius / 20000, dMax: radius / 8, depthRatio: 0.15, seed }),
      ]);
    case 'asteroid':
      return combine([
        ridges(150, 4),
        craterField({ radius, density: 3e6, dMin: radius / 200, dMax: radius / 2, blend: 0.3, seed }),
      ]);
    case 'ice':
      return combine([
        domainWarp(ridges(250, 4), { radius, amplitude: radius / 15, frequency: 6, levels: 2, seed }),
        craterField({ radius, density: 60, dMin: radius / 10000, dMax: radius / 10, depthRatio: 0.08, rimRatio: 0.02, seed }),
      ]);
    default:
      throw new RangeError("Invalid planet preset; pass 'moon', 'mars', 'asteroid' or 'ice'");
  }
}
