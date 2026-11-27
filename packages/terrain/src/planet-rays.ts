// Young rayed craters: bright ray systems and the chains of secondary craters along them. They reach tens of crater
// radii, far past the lattice cells a field reads, so they are a short explicit list that every sample checks.
// Clean room, from these sources only (kilometres):
// - Elliott, Huang, Minton and Freed 2018, "The length of lunar crater rays explained using secondary crater scaling",
//   Icarus 312, 231-246, https://doi.org/10.1016/j.icarus.2018.04.015: median ray length 6.59 Rp^1.27 (Rp the primary's
//   radius), on average 10.7 rays of 2.2 to 52.5 radii, each 22 degrees wide (standard deviation 8.3) seen from the
//   centre at 2 radii.
// - Singer, Jolliff and McKinnon 2020, "Lunar secondary craters and estimated ejecta block sizes reveal a scale-dependent
//   fragmentation trend", JGR Planets 125, https://arxiv.org/abs/2008.10132: the largest secondary at range r is
//   a r^-b with a = 0.022 D^1.96 and b = 0.14 ln D, the largest overall 4 to 6 percent of D; distinct secondaries begin
//   about 1.3 D beyond the rim; they lie in radial chains and clusters and are shallower than primaries.
// Authored here, not measured: the spread of ray lengths, the narrowing and patchiness of a ray, the spacing and length
// of chains, a secondary's depth (half a primary's), its 1.25 stretch along the ray and the bright halo to 3 radii.
import { valueNoise } from './noise3.js';

/** A young crater with rays. */
export interface RayedCrater {
  /** Direction of the centre from the planet's centre (any non-zero length). */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Rim diameter in metres. */
  readonly diameter: number;
}

interface Ray {
  azimuth: number;
  length: number;
  halfWidth: number;
  strength: number;
  // Secondary craters sorted by distance from the primary's centre: along the ray, across it, diameter (metres).
  along: Float64Array;
  across: Float64Array;
  size: Float64Array;
  largest: number;
  reach: number;
}
export interface RaySystem extends RayedCrater {
  readonly rays: readonly Ray[];
  readonly east: readonly [number, number, number];
  readonly north: readonly [number, number, number];
  /** Cosine of the angle past which nothing of the system reaches. */
  readonly limit: number;
}

const STRETCH = 1.25;
const smooth = (v: number): number => {
  const t = v < 0 ? 0 : v > 1 ? 1 : v;
  return t * t * (3 - 2 * t);
};

// How far ray `j` swings sideways off its great circle at `along` metres from the centre of a crater of radius
// `primary`: rays and their chains are not ruled lines.
const swing = (along: number, primary: number, halfWidth: number, j: number): number =>
  0.35 * halfWidth * valueNoise((along / primary) * 0.35, j * 3.7, 0.5, 31);

/** The rays and secondary chains of one young crater on a planet of `radius` metres. Deterministic for `next`. */
export function raySystem(crater: RayedCrater, radius: number, next: () => number): RaySystem {
  const length = Math.hypot(crater.x, crater.y, crater.z),
    x = crater.x / length,
    y = crater.y / length,
    z = crater.z / length,
    primary = crater.diameter / 2,
    km = crater.diameter / 1000,
    up = Math.abs(z) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let ex = up[1]! * z - up[2]! * y,
    ey = up[2]! * x - up[0]! * z,
    ez = up[0]! * y - up[1]! * x;
  const l = Math.hypot(ex, ey, ez);
  ex /= l;
  ey /= l;
  ez /= l;
  const count = 8 + Math.floor(next() * 7),
    turn = next() * 2 * Math.PI,
    median = 6.59 * (primary / 1000) ** 1.27 * 1000,
    longest = Math.min(52.5 * primary, 0.45 * Math.PI * radius),
    // Distinct secondaries begin about 1.3 diameters beyond the rim.
    first = primary + 1.3 * crater.diameter,
    rays: Ray[] = [];
  let reach = 3 * primary;
  for (let j = 0; j < count; j++) {
    const azimuth = turn + ((j + 0.8 * (next() - 0.5)) * 2 * Math.PI) / count,
      rayLength = Math.min(longest, Math.max(2.2 * primary, median * (0.5 + next()))),
      angle = ((11 + 4.15 * (2 * next() - 1)) * Math.PI) / 180,
      halfWidth = 2 * primary * Math.sin(angle),
      along: number[] = [],
      across: number[] = [],
      size: number[] = [];
    let largest = 0,
      wide = halfWidth,
      end = 0;
    for (let at = first * (1 + 0.3 * next()); km > 1 && at < rayLength; at *= 1.18 + 0.17 * next()) {
      const range = at / 1000,
        // Singer et al. 2020: the largest secondary at this range, never past 5 percent of the primary.
        cap = Math.min(0.05 * km, 0.022 * km ** 1.96 * range ** (-0.14 * Math.log(km))) * 1000,
        members = 3 + Math.floor(next() * 4),
        side = (next() - 0.5) * halfWidth;
      for (let m = 0, d = at; m < members && d < rayLength; m++) {
        const diameter = cap * (0.5 + 0.5 * next()),
          offset = side + (next() - 0.5) * 0.6 * diameter;
        const shifted = offset + swing(d, primary, halfWidth, j);
        along.push(d);
        across.push(shifted);
        size.push(diameter);
        largest = Math.max(largest, diameter);
        wide = Math.max(wide, Math.abs(shifted) + diameter);
        end = Math.max(end, d + diameter * STRETCH);
        d += 0.8 * diameter;
      }
    }
    // Clusters do not overlap in distance often, but a long chain can run past the next one's start: sort for the search.
    const order = along.map((_, i) => i).sort((a, b) => along[a]! - along[b]!);
    rays.push({
      azimuth,
      length: rayLength,
      halfWidth,
      strength: 0.6 + 0.4 * next(),
      along: Float64Array.from(order, (i) => along[i]!),
      across: Float64Array.from(order, (i) => across[i]!),
      size: Float64Array.from(order, (i) => size[i]!),
      largest,
      reach: wide,
    });
    reach = Math.max(reach, rayLength, end);
  }
  return {
    x,
    y,
    z,
    diameter: crater.diameter,
    rays,
    east: [ex, ey, ez],
    north: [y * ez - z * ey, z * ex - x * ez, x * ey - y * ex],
    limit: Math.cos(Math.min(Math.PI, reach / radius)),
  };
}

// Calls `visit` for every ray whose band (`width` of the ray, metres) holds the sample, with the sample's distance along
// that ray and across it. `cosine` is the cosine of the angle between the sample and the primary's centre.
function eachRay(
  system: RaySystem,
  radius: number,
  x: number,
  y: number,
  z: number,
  cosine: number,
  width: (ray: Ray) => number,
  visit: (ray: Ray, along: number, across: number, index: number) => void,
): void {
  const { east, north } = system,
    e = x * east[0] + y * east[1] + z * east[2],
    n = x * north[0] + y * north[1] + z * north[2],
    sine = Math.hypot(e, n),
    bearing = Math.atan2(n, e);
  for (let j = 0; j < system.rays.length; j++) {
    const ray = system.rays[j]!,
      turn = bearing - ray.azimuth,
      forward = Math.cos(turn);
    if (forward <= 0) continue;
    const across = Math.asin(Math.max(-1, Math.min(1, sine * Math.sin(turn)))) * radius;
    if (Math.abs(across) > width(ray)) continue;
    visit(ray, Math.atan2(sine * forward, cosine) * radius, across, j);
  }
}

/**
 * The ground after the system's secondary chains cut it: `previous` metres in, the new height out. Secondaries under
 * twice `detail` are left out.
 */
export function secondaryHeight(
  system: RaySystem,
  radius: number,
  x: number,
  y: number,
  z: number,
  detail: number,
  previous: number,
  depthRatio: number,
  rimRatio: number,
  blend: number,
): number {
  const cosine = x * system.x + y * system.y + z * system.z;
  if (cosine <= system.limit) return previous;
  let height = previous;
  eachRay(
    system,
    radius,
    x,
    y,
    z,
    cosine,
    (ray) => ray.reach,
    (ray, along, across) => {
      // The first crater that can reach this distance: a crater reaches two radii, stretched along the ray.
      const window = ray.largest * STRETCH;
      let low = 0,
        high = ray.along.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (ray.along[mid]! < along - window) low = mid + 1;
        else high = mid;
      }
      for (let k = low; k < ray.along.length && ray.along[k]! <= along + window; k++) {
        const diameter = ray.size[k]!;
        if (diameter < 2 * detail) continue;
        const q = Math.hypot((along - ray.along[k]!) / STRETCH, across - ray.across[k]!) / (diameter / 2);
        if (q >= 2) continue;
        // Half a primary's depth and rim.
        const km = diameter / 1000,
          depth = 0.5 * depthRatio * km ** 1.01 * 1000,
          rim = 0.5 * rimRatio * km ** 1.01 * 1000;
        if (q < 1) height = rim - depth + depth * q * q;
        else
          height = height * (blend > 0 ? smooth((q - 1) / blend) : 1) + rim * q ** -4 * (1 - smooth((q - 1.5) / 0.5));
      }
    },
  );
  return height;
}

/** Fresh bright material at the sample from one system, 0 (none) to 1: the halo around the crater and its rays. */
export function rayBrightness(system: RaySystem, radius: number, x: number, y: number, z: number): number {
  const cosine = x * system.x + y * system.y + z * system.z;
  if (cosine <= system.limit) return 0;
  const primary = system.diameter / 2,
    chord = Math.hypot(x - system.x, y - system.y, z - system.z),
    s = (radius * 2 * Math.asin(Math.min(1, chord / 2))) / primary;
  let bright = 1 - smooth((s - 1) / 2);
  if (s < 1) return bright;
  eachRay(
    system,
    radius,
    x,
    y,
    z,
    cosine,
    // The widest a swollen, swung ray reaches.
    (ray) => 2.2 * ray.halfWidth,
    (ray, along, across, j) => {
      const part = along / ray.length;
      if (part >= 1) return;
      const far = along / primary,
        side = across - swing(along, primary, ray.halfWidth, j),
        half = ray.halfWidth * (1 - 0.5 * part) * (1 + 0.45 * valueNoise(far * 0.8, j * 5.1, 0.5, 37)),
        core = 1 - smooth(2 * (Math.abs(side) / half) - 1);
      if (core <= 0) return;
      // Clumps along the ray and thin filaments that run with it.
      const clumps = 0.65 + 0.8 * valueNoise(far * 1.6, (side / primary) * 3, j * 7.31, 19),
        filaments = 0.75 + 0.45 * valueNoise(far * 0.35, (side / primary) * 9, j * 1.9, 41),
        value = core * (1 - smooth(2 * part - 1)) * ray.strength * Math.max(0.2, clumps * filaments);
      if (value > bright) bright = value;
    },
  );
  return Math.min(1, bright);
}
