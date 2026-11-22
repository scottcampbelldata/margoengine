// Far terrain past a world's edge, for BiomeView's `horizon`: the world ends at its bounds, so past them a view showed
// the sea's horizon (or nothing). This rings the world with coarse ground out to the horizon that continues its relief:
// the edge's own profile drawn outward (a valley that leaves the world keeps going), fading over a few kilometres into
// ridged mountains as high as the world's own relief. Ridged multifractal after F. K. Musgrave, "Procedural fractal
// terrains", in Ebert et al., Texturing and Modeling: A Procedural Approach, 3rd ed., 2003, ch. 16 (each octave
// 1 - |n|, squared, weighted by the octave before, so the ridges are sharp and the valleys smooth). The ring is a
// coarse far field around a detailed centre, as in F. Losasso and H. Hoppe, "Geometry clipmaps: terrain rendering using
// nested regular grids", SIGGRAPH 2004, and the distance haze over it is the scene's fog or aerial perspective
// (S. Hillaire, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020). Our own layout.
import { rangeError } from '../../shared/errors.js';
import { valueNoise } from './hash.js';

/** What {@link horizonHeights} reads: the world's heights on the view's texel grid. */
export interface HorizonSource {
  /** World rectangle `[x0, z0, x1, z1]`, metres. */
  readonly bounds: readonly [number, number, number, number];
  /** Heights at `width` x `depth` corners over `bounds`, rows of increasing z, metres. */
  readonly heights: Float32Array;
  readonly width: number;
  readonly depth: number;
  /** Seed of the mountains' noise. */
  readonly seed: number;
  /** How far past the world the ring reaches, metres. Default 3 world sizes, at most 48 km. */
  readonly reach?: number;
}

/** The ring's heights: a heightmap of corners over `size` from `origin`, `texel` metres apart. */
export interface HorizonHeights {
  readonly origin: readonly [number, number];
  readonly size: readonly [number, number];
  readonly texel: number;
  readonly width: number;
  readonly depth: number;
  readonly heights: Float32Array;
  /** Per corner, the world texel its ground continues (`v * width + u` of the source grid). */
  readonly nearest: Uint32Array;
  /** Per cell, 1 inside the world's own ground (the ring draws a hole there), else 0. */
  readonly inside: Uint8Array;
}

/** Metres the ring stands below the world under its first row of cells inside it: a skirt the world's ground hides. */
export const HORIZON_SKIRT = 40;
// Corners per world side, about: the ring's texel is the world's size over this, a power of two of view texels.
const ACROSS = 64;
// Metres over which the edge's profile gives way to mountains, at most.
const RAMP = 3000;
// Metres of a mountain's span at the first octave.
const FEATURE = 2600;

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Ridged multifractal of valueNoise, 0..1.
function ridged(seed: number, x: number, z: number, octaves = 6): number {
  let sum = 0,
    total = 0,
    weight = 1,
    amplitude = 1,
    fx = x / FEATURE, // float division: lattice cells
    fz = z / FEATURE; // float division: lattice cells
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise(seed + i * 7919, Math.round(fx * 65536), Math.round(fz * 65536)) / 65535, // float division: 0..1
      r = 1 - Math.abs(2 * n - 1),
      v = r * r * weight;
    sum += v * amplitude;
    total += amplitude;
    weight = Math.min(1, v * 2);
    amplitude *= 0.5;
    // Rotate each octave (about 37 degrees) and double it, so lattice lines do not line up.
    const nx = 1.6 * fx - 1.2 * fz + 17.3,
      nz = 1.2 * fx + 1.6 * fz - 9.1;
    fx = nx;
    fz = nz;
  }
  return sum / total; // float division: normalised
}

/**
 * Heights of a ring of far ground around a world, on a grid aligned with the world's own corners so the two meet
 * exactly at the edge. Inside the world the ring stands {@link HORIZON_SKIRT} m under it (its ground hides it there,
 * and the first row of cells inside closes any crack); past the edge the edge's height carries straight out and blends
 * over up to 3 km toward the world's mean edge height plus ridged mountains up to its relief (highest less lowest).
 * Cost: one ridged sample of 6 octaves per ring corner, about 200,000 for a 4 km world.
 * @example
 * const far = horizonHeights({ bounds: world.bounds, heights, width, depth, seed: 7 });
 */
export function horizonHeights(source: HorizonSource): HorizonHeights {
  const { bounds, heights, width, depth, seed } = source,
    [x0, z0, x1, z1] = bounds;
  if (!(width >= 2 && depth >= 2) || heights.length !== width * depth || !(x1 > x0 && z1 > z0))
    throw rangeError(
      'horizonHeights needs bounds with x1 > x0 and z1 > z0 and width x depth heights of 2 x 2 or more',
      'biomes',
    );
  const sx = x1 - x0,
    sz = z1 - z0,
    texel = sx / (width - 1); // float division: metres per world texel
  // The ring's step: a power of two of world texels dividing both sides, near the world's size over ACROSS.
  let k = 1;
  while (
    k * 2 * ACROSS <= Math.max(width, depth) - 1 &&
    ((width - 1) & (k * 2 - 1)) === 0 &&
    ((depth - 1) & (k * 2 - 1)) === 0
  )
    k *= 2;
  const step = k * texel,
    reach = Math.min(48000, source.reach ?? 3 * Math.max(sx, sz)),
    ring = Math.max(1, Math.round(reach / step)), // float division: corners past the edge
    iw = (width - 1) / k, // float division: exact, ring cells across the world
    id = (depth - 1) / k, // float division: exact
    nx = iw + 2 * ring + 1,
    nz = id + 2 * ring + 1,
    out = new Float32Array(nx * nz),
    nearest = new Uint32Array(nx * nz),
    inside = new Uint8Array((nx - 1) * (nz - 1));
  let low = Infinity,
    high = -Infinity,
    edge = 0,
    edges = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] < low) low = heights[i];
    if (heights[i] > high) high = heights[i];
  }
  for (let u = 0; u < width; u++) edge += heights[u] + heights[(depth - 1) * width + u];
  for (let v = 0; v < depth; v++) edge += heights[v * width] + heights[v * width + width - 1];
  edges = 2 * (width + depth);
  const mean = edge / edges, // float division: the mean edge height
    relief = high - low,
    ramp = Math.min(RAMP, Math.max(sx, sz) / 2); // float division
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const gi = i - ring,
        gj = j - ring,
        cu = Math.min(iw, Math.max(0, gi)) * k,
        cv = Math.min(id, Math.max(0, gj)) * k,
        c = j * nx + i,
        e = heights[cv * width + cu];
      nearest[c] = cv * width + cu;
      if (gi > 0 && gi < iw && gj > 0 && gj < id) {
        out[c] = e - HORIZON_SKIRT;
        continue;
      }
      const x = x0 + gi * step,
        z = z0 + gj * step,
        d = Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, z0 - z, z - z1)),
        w = smooth(d / ramp); // float division: 0 at the edge, 1 a ramp out
      out[c] = w ? e + (mean - e) * w + w * relief * ridged(seed, x, z) : e;
    }
  // A cell is a hole when all four corners are inside the world and it is not on the first row inside (the skirt).
  for (let j = 0; j < nz - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const gi = i - ring,
        gj = j - ring;
      inside[j * (nx - 1) + i] = gi >= 1 && gj >= 1 && gi + 1 <= iw - 1 && gj + 1 <= id - 1 ? 1 : 0;
    }
  return {
    origin: [x0 - ring * step, z0 - ring * step],
    size: [(nx - 1) * step, (nz - 1) * step],
    texel: step,
    width: nx,
    depth: nz,
    heights: out,
    nearest,
    inside,
  };
}
