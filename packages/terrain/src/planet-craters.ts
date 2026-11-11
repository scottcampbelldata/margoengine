// Crater fields for PlanetTerrain: a procedural, deterministic, lazily generated impact crater population.
// Clean room, from these sources only:
// - Pike 1977, "Size-Dependence in the Shape of Fresh Impact Craters on the Moon", in Impact and Explosion Cratering
//   (Pergamon), pp. 489-509: simple craters have depth about 0.196 D^1.01 and rim height about 0.036 D^1.01 (kilometres);
//   apparent depth never exceeds about 3,400 m.
// - Neukum, Ivanov and Hartmann 2001, "Cratering Records in the Inner Solar System in Relation to the Lunar Reference
//   System", Space Science Reviews 96: sizes follow a power law in diameter (cumulative exponent about -2).
// - McGetchin, Settle and Head 1973, "Radial thickness variation in impact crater ejecta", Earth and Planetary Science
//   Letters 20: ejecta thickness t = 0.14 R^0.74 (r / R)^-3 beyond the rim.
// - Rosenburg 2014, PhD thesis, Caltech, chapter 4: synthetic cratered terrain by accumulating craters of a power-law size
//   distribution, a younger crater cutting an older one.
// Placement is a jittered 3D lattice (a spatial hash) instead of equal-area cube-sphere cells: points are Poisson in a
// thin shell around the sphere and projected onto it, so the density on the sphere is uniform, and a sample reads only
// the 27 cells around it. One lattice per octave of diameter keeps the work per sample bounded.
import type { PlanetHeight } from './planet.js';

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
  /** Depth coefficient: depth = depthRatio * D^1.01 with D in kilometres (Pike 1977), 0 or more. Default 0.196. */
  depthRatio?: number;
  /** Rim height coefficient: rim = rimRatio * D^1.01 with D in kilometres, 0 or more. Default 0.036. */
  rimRatio?: number;
  /** Deepest a crater gets, in metres, above 0. Default 3,400 (Pike 1977); larger craters are scaled down, not clipped. */
  maxDepth?: number;
  /** Fraction of a crater's radius that is flat floor, 0 to below 1. Default 0. */
  floor?: number;
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
    blend = o.blend ?? 0.15;
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
    typeof ejecta !== 'boolean'
  )
    throw new RangeError(
      'Invalid craterField options; pass radius above 0, 0 < dMin < dMax <= radius, exponent 1 to 3, an integer seed, density or count 0 or more, floor 0 up to 1, blend 0 to 1',
    );
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
    let n = 0,
      s = 0;
    const next = (): number => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
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
            s = mix(Math.imul(a, 0x8da6b343) ^ Math.imul(b, 0xd8163841) ^ Math.imul(d, 0xcb1ab31f) ^ bin.salt);
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
      const k0 = dia[i]!, k1 = dist[i]!, k2 = age[i]!, k3 = cx[i]!, k4 = cy[i]!, k5 = cz[i]!;
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
    for (let i = 0; i < n; i++) h = craterHeight(h, dist[i]!, dia[i]!);
    return h;
  }) as CraterField;
  function craterHeight(previous: number, s: number, diameter: number): number {
    const km = diameter / 1000,
      simple = depthRatio * km ** 1.01 * 1000,
      scale = simple > maxDepth ? maxDepth / simple : 1,
      depth = simple * scale,
      rim = rimRatio * km ** 1.01 * 1000 * scale,
      radiusM = diameter / 2,
      thickness = ejecta ? 0.14 * radiusM ** 0.74 : 0,
      uplift = Math.max(0, rim - 0.14 * radiusM ** 0.74),
      crest = uplift + thickness;
    if (s < 1) {
      if (s <= floor) return -depth;
      const t = (s - floor) / (1 - floor);
      return -depth + (depth + crest) * t * t;
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
    return out;
  };
  return field;
}
