// Crater fields for PlanetTerrain: a procedural, deterministic, lazily generated impact crater population.
// Clean room, from these sources only:
// - Pike 1977, "Size-Dependence in the Shape of Fresh Impact Craters on the Moon", in Impact and Explosion Cratering
//   (Pergamon), pp. 489-509: simple craters have depth, rim crest to floor, about 0.196 D^1.01 and rim height above the
//   surrounding ground about 0.036 D^1.01 (kilometres); apparent depth (floor below that ground) never exceeds about
//   3,400 m. That depth is measured from the rim crest agrees with Collins, Melosh and Marcus 2005, "Earth Impact Effects
//   Program", Meteoritics & Planetary Science 40, 817-840, and with Pike's apparent depth about 0.2 of the apparent
//   diameter, itself about 0.83 of the rim diameter (NTRS 19780057837): 0.166 D against 0.196 D - 0.036 D = 0.16 D. Checked against secondary sources (2026-11-11): Pike's own summary gives
//   depth/diameter about 0.2 for simple lunar craters under 15 km (NASA NTRS 19780057837, Pike 1977, "Apparent
//   depth/apparent diameter relation for lunar craters", Proc. Lunar Sci. Conf. 8, 3427-3436), and "IMPACTS: A program
//   to calculate the effects of a hypervelocity impact into a Solar System body" (2022, arXiv:2203.07476) cites Pike
//   for a simple-crater rim height of 0.036 D. Both match the coefficients here; the exponents (1.01) are not stated in
//   those two sources, so they stand on the Pike 1977 citation above alone.
// - Neukum, Ivanov and Hartmann 2001, "Cratering Records in the Inner Solar System in Relation to the Lunar Reference
//   System", Space Science Reviews 96: sizes follow a power law in diameter (cumulative exponent about -2).
// - McGetchin, Settle and Head 1973, "Radial thickness variation in impact crater ejecta", Earth and Planetary Science
//   Letters 20: ejecta thickness t = 0.14 R^0.74 (r / R)^-3 beyond the rim, t and R in metres (as used below).
// - Rosenburg 2014, PhD thesis, Caltech, chapter 4: synthetic cratered terrain by accumulating craters of a power-law size
//   distribution, a younger crater cutting an older one.
// Placement is a jittered 3D lattice (a spatial hash) instead of equal-area cube-sphere cells: points are Poisson in a
// thin shell around the sphere and projected onto it, so the density on the sphere is uniform, and a sample reads only
// the 27 cells around it. One lattice per octave of diameter keeps the work per sample bounded.
// Complex craters (flat floor, central peak, terraces): planet-complex.ts. Rays and secondary chains: planet-rays.ts.
import { type CraterShape, craterInterior, craterShape, LUNAR_TRANSITION } from './planet-complex.js';
import { type RayedCrater, type RaySystem, rayBrightness, raySystem, secondaryHeight } from './planet-rays.js';
import type { PlanetHeight } from './planet.js';

export type { RayedCrater } from './planet-rays.js';

/** `craterField` options. Every one is optional. */
export interface CraterFieldOptions {
  /** Radius in metres of the planet the field is for, above 0. Default 6,371,000; pass the planet's own radius. */
  radius?: number;
  /** Craters of diameter `dMin` or more per million square kilometres, 0 or more. Default 1,000. Excludes `count`. */
  density?: number;
  /** Craters of diameter `dMin` or more on the whole planet, 0 or more; instead of `density`. */
  count?: number;
  /** Smallest diameter in metres, above 0. Default `radius / 20,000`. */
  dMin?: number;
  /** Largest diameter in metres, above `dMin` and at most `radius`. Default `radius / 4`. */
  dMax?: number;
  /** Cumulative size exponent: craters with diameter at least D number about D^-exponent, 1 to 3. Default 2 (Neukum et al. 2001). */
  exponent?: number;
  /** An integer. Default 1. Another seed makes another population. */
  seed?: number;
  /** Depth coefficient: rim crest to floor = depthRatio * D^1.01 with D in kilometres (Pike 1977), 0 or more. Default 0.196. */
  depthRatio?: number;
  /** Rim height coefficient: rim = rimRatio * D^1.01 with D in kilometres, 0 or more. Default 0.036. */
  rimRatio?: number;
  /** Deepest a floor gets below the surrounding ground, in metres, above 0. Default 3,400 (Pike 1977); larger craters are scaled down, not clipped. */
  maxDepth?: number;
  /** Fraction of a crater's radius that is flat floor, 0 to below 1. Default 0. Complex craters have at least Pike's. */
  floor?: number;
  /**
   * Rim diameter in metres past which craters are complex (flat floor, central peak, terraces, shallower for their
   * size), above 0. Default 10,583, the Moon's (Pike 1977); Infinity keeps every crater a simple bowl.
   */
  transition?: number;
  /** Scale of the central peaks of complex craters, 0 (none) or more. Default 1 (Pike 1977's height). */
  peaks?: number;
  /** Strength of the wall terraces of complex craters, 0 (smooth walls) to 1. Default 1. */
  terraces?: number;
  /**
   * Young craters with bright rays and secondary crater chains: a count, an integer 0 to 64 placed by the seed, or the
   * craters themselves (at most 64, the last the youngest). Default 0. They are younger than every other crater.
   */
  rayed?: number | readonly RayedCrater[];
  /** Smallest and largest diameter in metres of counted rayed craters. Default [radius / 60, radius / 16]. */
  rayedSize?: readonly [number, number];
  /** Add the ejecta blanket (McGetchin et al. 1973) beyond the rim. Default true. */
  ejecta?: boolean;
  /** Width, as a fraction of the radius beyond the rim, over which a younger crater fades into what was there, 0 to 1. Default 0.15. */
  blend?: number;
}

/** A crater that shapes a sample point. */
export interface PlanetCrater {
  /** Unit direction of the centre from the planet's centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Rim diameter in metres. */
  readonly diameter: number;
  /** 0 (oldest) to 1 (youngest): a younger crater cuts an older one. */
  readonly age: number;
}

/** A {@link PlanetHeight} that can also list the craters that shape a point. */
export interface CraterField extends PlanetHeight {
  /**
   * The craters whose rim diameter is at least twice `detail` and whose ejecta reach the direction (x, y, z), oldest first.
   * At most about 27 cells times the octaves of diameter are read, whatever the planet's size.
   */
  craters(x: number, y: number, z: number, detail?: number): PlanetCrater[];
  /** The young craters that have rays, oldest first, centres as unit directions. */
  readonly rayed: readonly RayedCrater[];
  /**
   * Fresh bright ground at a direction, 0 (none) to 1: halos and rays of the rayed craters. Pass it to
   * `PlanetTerrain`'s `brightness`.
   */
  readonly brightness: PlanetHeight;
}

interface Bin {
  lo: number;
  hi: number;
  cell: number;
  eps: number;
  mean: number;
  limit: number;
  salt: number;
}

const MAX_PER_CELL = 256;
// Ejecta and rim uplift are gone at 3 radii; they fade over 2.5 to 3 so no ring shows at the cut.
const REACH = 3;
const mix = (h: number): number => {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
};

// A seeded generator of numbers from 0 to below 1.
const random = (seed: number): (() => number) => {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Craters for a planet's ground, heights in metres relative to the undisturbed surface (bowls below 0, rims and ejecta
 * above). Combine it with a base ground through `combine`. Deterministic for a seed; a sample reads only the cells near it.
 * @throws RangeError on an invalid option, or when the density puts more than 256 craters in a lattice cell.
 */
export function craterField(options: CraterFieldOptions = {}): CraterField {
  const o = options,
    radius = o.radius ?? 6371000,
    exponent = o.exponent ?? 2,
    dMin = o.dMin ?? radius / 20000,
    dMax = o.dMax ?? radius / 4,
    seed = o.seed ?? 1,
    depthRatio = o.depthRatio ?? 0.196,
    rimRatio = o.rimRatio ?? 0.036,
    maxDepth = o.maxDepth ?? 3400,
    floor = o.floor ?? 0,
    ejecta = o.ejecta ?? true,
    blend = o.blend ?? 0.15,
    transition = o.transition ?? LUNAR_TRANSITION,
    peaks = o.peaks ?? 1,
    terraces = o.terraces ?? 1,
    rayed = o.rayed ?? 0,
    rayedSize = o.rayedSize ?? [radius / 60, radius / 16];
  const area = 4 * Math.PI * radius * radius;
  if (o.density !== undefined && o.count !== undefined)
    throw new RangeError('Invalid craterField options; pass density or count, not both');
  const perM2 = o.count !== undefined ? o.count / area : (o.density ?? 1000) / 1e12;
  const ok = (v: number, lo: number, hi: number) => Number.isFinite(v) && v >= lo && v <= hi;
  if (
    !(Number.isFinite(radius) && radius > 0) ||
    !(Number.isFinite(dMin) && dMin > 0) ||
    !(Number.isFinite(dMax) && dMax > dMin && dMax <= radius) ||
    !ok(exponent, 1, 3) ||
    !Number.isInteger(seed) ||
    !ok(perM2, 0, Infinity) ||
    !ok(depthRatio, 0, Infinity) ||
    !ok(rimRatio, 0, Infinity) ||
    !(Number.isFinite(maxDepth) && maxDepth > 0) ||
    !(Number.isFinite(floor) && floor >= 0 && floor < 1) ||
    !ok(blend, 0, 1) ||
    typeof ejecta !== 'boolean' ||
    !(transition > 0) ||
    !(Number.isFinite(peaks) && peaks >= 0) ||
    !ok(terraces, 0, 1)
  )
    throw new RangeError(
      'Invalid craterField options; pass radius above 0, 0 < dMin < dMax <= radius, exponent 1 to 3, an integer seed, density or count 0 or more, floor 0 up to 1, blend 0 to 1, transition above 0, peaks 0 or more, terraces 0 to 1',
    );
  const given = typeof rayed === 'number' ? undefined : rayed,
    total = given ? given.length : (rayed as number);
  if (
    !(Number.isInteger(total) && total >= 0 && total <= 64) ||
    given?.some((c) => {
      const length = Math.hypot(c?.x, c?.y, c?.z);
      return !(Number.isFinite(length) && length > 0 && c.diameter > 0 && c.diameter <= radius);
    })
  )
    throw new RangeError(
      'Invalid craterField rayed; pass a count 0 to 64 or up to 64 craters {x, y, z, diameter} with a direction and 0 < diameter <= radius',
    );
  const [rayedLow, rayedHigh] = rayedSize;
  if (!(rayedSize.length === 2 && rayedLow > 0 && rayedHigh > rayedLow && rayedHigh <= radius))
    throw new RangeError(
      'Invalid craterField rayedSize; pass [smallest, largest] metres, 0 < smallest < largest <= radius',
    );
  const systems: RaySystem[] = [];
  for (let i = 0; i < total; i++) {
    const next = random(mix(Math.imul(i + 1, 0x85ebca6b) ^ seed));
    let crater = given?.[i];
    if (!crater) {
      // Uniform on the sphere, diameters from the same power law within `rayedSize`.
      const z = 2 * next() - 1,
        turn = 2 * Math.PI * next(),
        ring = Math.sqrt(1 - z * z),
        span = rayedLow ** -exponent - rayedHigh ** -exponent;
      crater = {
        x: ring * Math.cos(turn),
        y: ring * Math.sin(turn),
        z,
        diameter: (rayedLow ** -exponent - next() * span) ** (-1 / exponent),
      };
    }
    systems.push(raySystem(crater, radius, next));
  }
  const laws = { depthRatio, rimRatio, floor, transition, peaks, terraces },
    shape: CraterShape = { depth: 0, rim: 0, floor: 0, peak: 0, peakWidth: 0, terraces: 0, step: 0 };
  const bins: Bin[] = [],
    c = perM2 * dMin ** exponent;
  for (let lo = dMin, k = 0; lo < dMax; lo *= 2, k++) {
    const hi = Math.min(lo * 2, dMax),
      sigma = c * (lo ** -exponent - hi ** -exponent),
      cell = 3 * hi,
      eps = cell / 4,
      shell = ((4 * Math.PI) / 3) * ((radius + eps) ** 3 - Math.max(0, radius - eps) ** 3),
      mean = ((sigma * area) / shell) * cell ** 3;
    if (mean > MAX_PER_CELL)
      throw new RangeError(
        `craterField puts ${mean.toFixed(0)} craters in a lattice cell at diameters ${lo.toFixed(1)} to ${hi.toFixed(1)} m (limit ${MAX_PER_CELL}); raise dMin or lower the density`,
      );
    bins.push({ lo, hi, cell, eps, mean, limit: Math.exp(-mean), salt: mix(Math.imul(k + 1, 0x9e3779b1) ^ seed) });
  }
  // Scratch for the craters of one sample: diameter, normalised distance, age and centre.
  let cap = 64,
    dia = new Float64Array(cap),
    dist = new Float64Array(cap),
    age = new Float64Array(cap),
    cx = new Float64Array(cap),
    cy = new Float64Array(cap),
    cz = new Float64Array(cap);
  const grow = () => {
    cap *= 2;
    const g = (a: Float64Array) => {
      const b = new Float64Array(cap);
      b.set(a);
      return b;
    };
    dia = g(dia);
    dist = g(dist);
    age = g(age);
    cx = g(cx);
    cy = g(cy);
    cz = g(cz);
  };
  // Fills the scratch with the craters reaching the sample, sorted oldest first; returns how many.
  function gather(x: number, y: number, z: number, detail: number): number {
    let n = 0;
    const qx = x * radius,
      qy = y * radius,
      qz = z * radius;
    for (const bin of bins) {
      if (bin.hi < 2 * detail) continue;
      const L = bin.cell,
        ix = Math.floor(qx / L),
        iy = Math.floor(qy / L),
        iz = Math.floor(qz / L),
        rLo = radius - bin.eps,
        rHi = radius + bin.eps,
        span = bin.lo ** -exponent - bin.hi ** -exponent;
      for (let a = ix - 1; a <= ix + 1; a++)
        for (let b = iy - 1; b <= iy + 1; b++)
          for (let d = iz - 1; d <= iz + 1; d++) {
            // A cell that does not meet the shell holds no crater centre: skip it before drawing anything.
            const nx = Math.max(a * L, -(a + 1) * L, 0),
              ny = Math.max(b * L, -(b + 1) * L, 0),
              nz = Math.max(d * L, -(d + 1) * L, 0),
              fx = Math.max(Math.abs(a * L), Math.abs((a + 1) * L)),
              fy = Math.max(Math.abs(b * L), Math.abs((b + 1) * L)),
              fz = Math.max(Math.abs(d * L), Math.abs((d + 1) * L));
            if (nx * nx + ny * ny + nz * nz > rHi * rHi || fx * fx + fy * fy + fz * fz < rLo * rLo) continue;
            const next = random(
              mix(Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(d, 0xcb1ab31f) ^ bin.salt),
            );
            let count = 0;
            for (let p = 1; ; count++) {
              p *= next();
              if (p <= bin.limit) break;
            }
            for (let i = 0; i < count; i++) {
              const px = (a + next()) * L,
                py = (b + next()) * L,
                pz = (d + next()) * L,
                u = next(),
                born = next(),
                norm = Math.hypot(px, py, pz);
              if (norm < rLo || norm > rHi) continue;
              // Inverse CDF of the power law truncated to this octave.
              const diameter = (bin.lo ** -exponent - u * span) ** (-1 / exponent);
              if (diameter < 2 * detail) continue;
              const ux = px / norm,
                uy = py / norm,
                uz = pz / norm,
                chord = Math.hypot(ux - x, uy - y, uz - z),
                arc = radius * 2 * Math.asin(Math.min(1, chord / 2)),
                q = arc / (diameter / 2);
              if (q >= REACH) continue;
              if (n === cap) grow();
              dia[n] = diameter;
              dist[n] = q;
              age[n] = born;
              cx[n] = ux;
              cy[n] = uy;
              cz[n] = uz;
              n++;
            }
          }
    }
    // Insertion sort by age, oldest first (a handful of craters).
    for (let i = 1; i < n; i++) {
      const k0 = dia[i]!,
        k1 = dist[i]!,
        k2 = age[i]!,
        k3 = cx[i]!,
        k4 = cy[i]!,
        k5 = cz[i]!;
      let j = i - 1;
      for (; j >= 0 && age[j]! > k2; j--) {
        dia[j + 1] = dia[j]!;
        dist[j + 1] = dist[j]!;
        age[j + 1] = age[j]!;
        cx[j + 1] = cx[j]!;
        cy[j + 1] = cy[j]!;
        cz[j + 1] = cz[j]!;
      }
      dia[j + 1] = k0;
      dist[j + 1] = k1;
      age[j + 1] = k2;
      cx[j + 1] = k3;
      cy[j + 1] = k4;
      cz[j + 1] = k5;
    }
    return n;
  }
  const field = ((x: number, y: number, z: number, detail: number): number => {
    const n = gather(x, y, z, detail || 0);
    let h = 0;
    for (let i = 0; i < n; i++) h = craterHeight(h, dist[i]!, dia[i]!, age[i]!, x, y, z);
    for (const system of systems) {
      h = secondaryHeight(system, radius, x, y, z, detail || 0, h, depthRatio, rimRatio, blend);
      const q = reached(system, x, y, z, detail || 0);
      if (q < REACH) h = craterHeight(h, q, system.diameter, 1, x, y, z);
    }
    return h;
  }) as CraterField;
  // The sample's distance from a rayed crater's centre in its radii; REACH or more when it does not shape the sample.
  function reached(system: RaySystem, x: number, y: number, z: number, detail: number): number {
    if (system.diameter < 2 * detail) return REACH;
    const chord = Math.hypot(system.x - x, system.y - y, system.z - z);
    return (radius * 2 * Math.asin(Math.min(1, chord / 2))) / (system.diameter / 2);
  }
  function craterHeight(
    previous: number,
    s: number,
    diameter: number,
    born: number,
    x: number,
    y: number,
    z: number,
  ): number {
    craterShape(diameter, laws, shape);
    const below = Math.max(0, shape.depth - shape.rim),
      scale = below > maxDepth ? maxDepth / below : 1,
      depth = below * scale,
      rim = shape.rim * scale,
      radiusM = diameter / 2,
      thickness = ejecta ? 0.14 * radiusM ** 0.74 : 0,
      uplift = Math.max(0, rim - 0.14 * radiusM ** 0.74),
      crest = uplift + thickness;
    if (s < 1) {
      shape.peak *= scale;
      const grain = radius / (0.12 * diameter),
        u = x * grain + born * 113.1,
        v = y * grain - born * 71.7,
        w = z * grain + born * 31.3;
      return craterInterior(s, -depth, crest, shape, u, v, w);
    }
    const tail = Math.min(1, Math.max(0, (s - 2.5) / 0.5)),
      outside = (uplift * s ** -4 + thickness * s ** -3) * (1 - tail * tail * (3 - 2 * tail)),
      fade = blend > 0 ? Math.min(1, Math.max(0, (s - 1) / blend)) : 1,
      older = fade * fade * (3 - 2 * fade);
    return previous * older + outside;
  }
  field.craters = (x, y, z, detail = 0) => {
    const n = gather(x, y, z, detail),
      out: PlanetCrater[] = [];
    for (let i = 0; i < n; i++) out.push({ x: cx[i]!, y: cy[i]!, z: cz[i]!, diameter: dia[i]!, age: age[i]! });
    for (const s of systems)
      if (reached(s, x, y, z, detail) < REACH) out.push({ x: s.x, y: s.y, z: s.z, diameter: s.diameter, age: 1 });
    return out;
  };
  Object.defineProperties(field, {
    rayed: {
      enumerable: true,
      value: Object.freeze(systems.map((s) => Object.freeze({ x: s.x, y: s.y, z: s.z, diameter: s.diameter }))),
    },
    brightness: {
      enumerable: true,
      value: (x: number, y: number, z: number): number => {
        let bright = 0;
        for (const system of systems) bright = Math.max(bright, rayBrightness(system, radius, x, y, z));
        return bright;
      },
    },
  });
  return field;
}
