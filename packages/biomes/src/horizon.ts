// Far terrain past a world's edge, for BiomeView's `horizon`: the world ends at its bounds, so past them a view showed
// the sea's horizon (or nothing). This rings the world with coarse ground out to the horizon that continues its relief:
// the edge's own profile drawn outward (a valley that leaves the world keeps going), fading over a few kilometres into
// mountains as high as the world's own relief. The mountains are a hybrid multifractal (F. K. Musgrave, "Procedural
// fractal terrains", in Ebert et al., Texturing and Modeling: A Procedural Approach, 3rd ed., 2003, ch. 16): smooth
// massifs of a few octaves of gradient noise carry ridged octaves whose weight follows the signal so far, so ranges
// stand rough over smoother valleys. Each ridged octave is damped by the slope the octaves before it built, which keeps
// the fine relief off steep flanks and in the valleys and on the shoulders, the look of eroded ground (I. Quilez,
// "Value noise derivatives", 2008, and "Gradient noise derivatives", 2017, iquilezles.org; the slope damping of
// G. Cordonnier et al., "Large scale terrain generation from tectonic uplift and fluvial erosion", Computer Graphics
// Forum 35(2), 2016, reaches the same balance by simulation). The ridge fold |n| is softened to sqrt(n^2 + e^2)
// (round crests), the noise is gradient noise with analytic derivatives (K. Perlin, "Improving noise", SIGGRAPH 2002)
// and its domain is warped by a low octave (Quilez, "Domain warping", 2002), so crests do not trace the lattice. The
// ring is a coarse far field around a detailed centre, as in F. Losasso and H. Hoppe, "Geometry clipmaps: terrain
// rendering using nested regular grids", SIGGRAPH 2004, on texels of up to 32 m (and a 64th of the world; for an 8 km
// world at 128 m a ridge's crest was one corner and a peak drew as a straight-sided cone, Above the Treeline round 8,
// KB-BIOMES-HORIZONCONE1), and the distance haze over it is the scene's fog or aerial perspective (S. Hillaire, "A
// Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020). Our own layout.
import { rangeError } from '../../shared/errors.js';
import { pcg } from './hash.js';

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
  /**
   * Per corner past the edge, the half-width in world texels of the stretch of edge round `nearest` it continues
   * ({@link HORIZON_SPREAD} of its distance from the world); 0 on and inside the edge. {@link horizonEdgeMean} averages
   * the world's per-texel values over it.
   */
  readonly spread: Float32Array;
  /**
   * Per corner, the share 0 to 1 the mountains have taken over from the edge: 0 on and inside the edge, a smoothstep to 1
   * over the ramp (up to 3 km). The heights give way to the mountains by it; a material map should give way by it to
   * the whole edge's mean (`BiomeView` does), so the edge's large patches do not fan out to the horizon either.
   */
  readonly blend: Float32Array;
  /** Per cell, 1 inside the world's own ground (the ring draws a hole there), else 0. */
  readonly inside: Uint8Array;
}

/**
 * How fast the stretch of edge a far corner continues widens with its distance from the world: its half-width over the
 * distance. Each corner takes the mean of that stretch, so the edge blurs out with distance as rays from it spread;
 * a corner copying its nearest edge texel ran that one texel's ground and material in a straight streak to the
 * horizon (KB-BIOMES-HORIZONSTREAK1).
 */
export const HORIZON_SPREAD = 0.125;
/** Metres the ring stands below the world under its first row of cells inside it: a skirt the world's ground hides. */
export const HORIZON_SKIRT = 40;
// The ring's texel, metres, at most (and at most a 64th of the world), a power of two of view texels; coarser only to
// keep the ring within HORIZON_CORNERS a side.
const HORIZON_TEXEL = 32;
const HORIZON_CORNERS = 2049;
// Metres over which the edge's profile gives way to mountains, at most.
const RAMP = 3000;
// Metres of a ridge's span at the first ridged octave, and of a massif.
const FEATURE = 2400;
const MASSIF = 7000;
// Ridged octaves (down to about 19 m), the crest's rounding and the slope damping (see the header).
const OCTAVES = 8;
const ROUND = 0.15;
const DAMP = 0.08;

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// Gradient noise at lattice coordinates (x, z) with its derivatives, into N: value (about -0.7 to 0.7), d/dx, d/dz.
// Each lattice corner's gradient is a unit vector at an angle hashed from (seed, corner); quintic fade.
const N = new Float64Array(3),
  G = new Float64Array(8);
function corner(seed: number, ix: number, iz: number, o: number) {
  const a = (pcg((seed | 0) + pcg(ix + pcg(iz))) / 4294967296) * 2 * Math.PI; // float division: hash to angle
  G[o] = Math.cos(a);
  G[o + 1] = Math.sin(a);
}
function gradientNoise(seed: number, x: number, z: number): void {
  const ix = Math.floor(x),
    iz = Math.floor(z),
    fx = x - ix,
    fz = z - iz,
    u = fx * fx * fx * (fx * (fx * 6 - 15) + 10),
    du = 30 * fx * fx * (fx * (fx - 2) + 1),
    v = fz * fz * fz * (fz * (fz * 6 - 15) + 10),
    dv = 30 * fz * fz * (fz * (fz - 2) + 1);
  corner(seed, ix, iz, 0);
  corner(seed, ix + 1, iz, 2);
  corner(seed, ix, iz + 1, 4);
  corner(seed, ix + 1, iz + 1, 6);
  const a = G[0] * fx + G[1] * fz,
    b = G[2] * (fx - 1) + G[3] * fz,
    c = G[4] * fx + G[5] * (fz - 1),
    d = G[6] * (fx - 1) + G[7] * (fz - 1),
    k = a - b - c + d;
  N[0] = a + u * (b - a) + v * (c - a) + u * v * k;
  N[1] = G[0] + u * (G[2] - G[0]) + v * (G[4] - G[0]) + u * v * (G[0] - G[2] - G[4] + G[6]) + du * (b - a + v * k);
  N[2] = G[1] + u * (G[3] - G[1]) + v * (G[5] - G[1]) + u * v * (G[1] - G[3] - G[5] + G[7]) + dv * (c - a + u * k);
}

/**
 * The far mountains' height at world (x, z) metres, 0 to about 1 (a share of the world's relief): massifs carrying
 * eroded ridges (see the header). Deterministic for a seed; about 1.5 microseconds a corner.
 * @example horizonMountains(7, 12000, -3000); // about 0.4
 */
export function horizonMountains(seed: number, x: number, z: number): number {
  // Massifs: three octaves of gradient noise, so ranges stand over broad valleys.
  let mx = x / MASSIF, // float division: lattice cells
    mz = z / MASSIF, // float division: lattice cells
    m = 0,
    ma = 1,
    mt = 0;
  for (let i = 0; i < 3; i++) {
    gradientNoise(seed ^ (0x51ed27 + i * 131), mx, mz);
    m += ma * N[0];
    mt += ma;
    ma *= 0.5;
    const nx = 1.6 * mx - 1.2 * mz,
      nz = 1.2 * mx + 1.6 * mz;
    mx = nx;
    mz = nz;
  }
  const mass = Math.min(1, Math.max(0, (1.6 * m) / mt + 0.5)); // float division: normalised
  let fx = x / FEATURE, // float division: lattice cells
    fz = z / FEATURE; // float division: lattice cells
  gradientNoise(seed ^ 0x2c1b3c6d, fx * 0.4, fz * 0.4);
  const wx = N[0];
  gradientNoise(seed ^ 0x297a2d39, fx * 0.4, fz * 0.4);
  fx += 0.35 * wx;
  fz += 0.35 * N[0];
  // m00..m11: the octave's lattice per base lattice cell, so its derivatives come back to the base lattice.
  let sum = 0,
    total = 0,
    weight = 0.2 + 0.8 * mass,
    amplitude = 1,
    gx = 0,
    gz = 0,
    m00 = 1,
    m01 = 0,
    m10 = 0,
    m11 = 1;
  for (let i = 0; i < OCTAVES; i++) {
    gradientNoise(seed + i * 7919, fx, fz);
    const s = 1.4 * N[0],
      q = Math.sqrt(s * s + ROUND * ROUND),
      r = 1 + ROUND - q,
      ds = (1.4 * s) / q, // float division: q >= ROUND
      lx = -ds * N[1],
      lz = -ds * N[2],
      v = r * r * weight;
    gx += amplitude * 2 * r * weight * (m00 * lx + m10 * lz);
    gz += amplitude * 2 * r * weight * (m01 * lx + m11 * lz);
    sum += (v * amplitude) / (1 + DAMP * (gx * gx + gz * gz)); // float division: slope damping
    total += amplitude;
    weight = Math.min(1, v * 2);
    amplitude *= 0.5;
    // Rotate each octave (about 37 degrees) and double it, so lattice lines do not line up.
    const nx = 1.6 * fx - 1.2 * fz + 17.3,
      nz = 1.2 * fx + 1.6 * fz - 9.1,
      a00 = 1.6 * m00 - 1.2 * m10,
      a01 = 1.6 * m01 - 1.2 * m11,
      a10 = 1.2 * m00 + 1.6 * m10,
      a11 = 1.2 * m01 + 1.6 * m11;
    fx = nx;
    fz = nz;
    m00 = a00;
    m01 = a01;
    m10 = a10;
    m11 = a11;
  }
  // The power 1.4 widens valley floors and keeps the peaks: a median near 0.32 of the relief and a 99th centile near
  // 0.73, as main's ridged ring had, so the edge's valleys still carry on outward at their own height.
  return Math.pow(0.8 * (0.45 * mass * mass * (3 - 2 * mass) + (0.75 * sum) / total), 1.4); // float division: normalised
}

/**
 * Heights of a ring of far ground around a world, on a grid aligned with the world's own corners so the two meet
 * exactly at the edge. Inside the world the ring stands {@link HORIZON_SKIRT} m under it (its ground hides it there,
 * and the first row of cells inside closes any crack); past the edge the edge's height carries straight out and blends
 * over up to 3 km toward the world's mean edge height plus mountains ({@link horizonMountains}) up to about its relief
 * (highest less lowest). Cost: one mountain sample per ring corner, about 3.2 million for an 8 km world (2 to 5 s) and
 * 800,000 for a 4 km one.
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
  // The ring's step: a power of two of world texels dividing both sides, up to 32 m and a 64th of the world, coarser
  // only while the ring would pass 2,049 corners a side.
  const reach = Math.min(48000, source.reach ?? 3 * Math.max(sx, sz)),
    target = Math.min(HORIZON_TEXEL, Math.max(sx, sz) / 64), // float division: metres
    across = (q: number) => (Math.max(width, depth) - 1) / q + 2 * Math.round(reach / (q * texel)) + 1; // float division
  let k = 1;
  while (
    ((width - 1) & (k * 2 - 1)) === 0 &&
    ((depth - 1) & (k * 2 - 1)) === 0 &&
    (k * 2 * texel <= target || across(k) > HORIZON_CORNERS)
  )
    k *= 2;
  const step = k * texel,
    ring = Math.max(1, Math.round(reach / step)), // float division: corners past the edge
    iw = (width - 1) / k, // float division: exact, ring cells across the world
    id = (depth - 1) / k, // float division: exact
    nx = iw + 2 * ring + 1,
    nz = id + 2 * ring + 1,
    out = new Float32Array(nx * nz),
    nearest = new Uint32Array(nx * nz),
    spread = new Float32Array(nx * nz),
    blend = new Float32Array(nx * nz),
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
        d = Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, z0 - z, z - z1));
      spread[c] = (HORIZON_SPREAD * d) / texel; // float division: world texels
    }
  // Each corner past the edge carries on the mean of its stretch of edge, then gives way to the mountains.
  const edgeHeights = horizonEdgeMean({ width, depth }, { nearest, spread }, heights, 1);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++) {
      const gi = i - ring,
        gj = j - ring,
        c = j * nx + i;
      if (gi > 0 && gi < iw && gj > 0 && gj < id) continue;
      const x = x0 + gi * step,
        z = z0 + gj * step,
        e = edgeHeights[c],
        d = Math.hypot(Math.max(0, x0 - x, x - x1), Math.max(0, z0 - z, z - z1)),
        w = smooth(d / ramp); // float division: 0 at the edge, 1 a ramp out
      blend[c] = w;
      // The mountains rise by w squared, so the edge's own valleys run out a while before the ranges stand up in them.
      out[c] = w ? e + (mean - e) * w + w * w * relief * horizonMountains(seed, x, z) : e;
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
    spread,
    blend,
    inside,
  };
}

// The edge texels of a width x depth grid as one loop: the north row west to east, the east column, the south row east
// to west, the west column; a texel off the edge gives -1.
function loopIndex(u: number, v: number, width: number, depth: number): number {
  const a = width - 1,
    b = depth - 1;
  if (v === 0) return u;
  if (u === a) return a + v;
  if (v === b) return a + b + (a - u);
  if (u === 0) return 2 * a + b + (b - v);
  return -1;
}

/**
 * Per far corner, the mean of the world's per-texel `data` (`channels` values a texel, `v * width + u`) over the
 * stretch of edge it continues: `spread[c]` texels each way round the edge loop from `nearest[c]` (the whole edge
 * once that is wider than it). A corner whose `nearest` is off the edge takes that texel's own values. `channels`
 * values a corner.
 * @example
 * const far = horizonHeights({ bounds, heights, width, depth, seed: 7 });
 * const weights = horizonEdgeMean({ width, depth }, far, painted, 4); // RGBA weights of the far ground
 */
export function horizonEdgeMean(
  grid: { readonly width: number; readonly depth: number },
  far: { readonly nearest: Uint32Array; readonly spread: Float32Array },
  data: ArrayLike<number>,
  channels: number,
): Float32Array {
  const { width, depth } = grid;
  if (!(width >= 2 && depth >= 2) || !(channels >= 1) || data.length !== width * depth * channels)
    throw rangeError('horizonEdgeMean needs width x depth x channels values on a 2 x 2 or larger grid', 'biomes');
  const loop = 2 * (width - 1) + 2 * (depth - 1),
    sums = new Float64Array((loop + 1) * channels);
  // Prefix sums round the loop, in double precision.
  for (let p = 0; p < loop; p++) {
    const a = width - 1,
      b = depth - 1,
      [u, v] =
        p < a ? [p, 0] : p < a + b ? [a, p - a] : p < 2 * a + b ? [a - (p - a - b), b] : [0, b - (p - 2 * a - b)],
      t = (v * width + u) * channels;
    for (let k = 0; k < channels; k++) sums[(p + 1) * channels + k] = sums[p * channels + k] + data[t + k];
  }
  const n = far.nearest.length,
    out = new Float32Array(n * channels),
    span = (from: number, to: number, k: number) => sums[to * channels + k] - sums[from * channels + k];
  for (let c = 0; c < n; c++) {
    const t = far.nearest[c],
      u = t % width, // float division: view only, width >= 2
      v = (t - u) / width, // float division: view only, exact whole rows
      p = loopIndex(u, v, width, depth),
      r = Math.round(far.spread[c]);
    if (p < 0 || r <= 0) {
      for (let k = 0; k < channels; k++) out[c * channels + k] = data[t * channels + k];
      continue;
    }
    if (2 * r + 1 >= loop) {
      for (let k = 0; k < channels; k++) out[c * channels + k] = sums[loop * channels + k] / loop; // float division: mean
      continue;
    }
    // [p - r, p + r] round the loop, as one or two runs of the prefix sums.
    const lo = p - r,
      hi = p + r + 1;
    for (let k = 0; k < channels; k++) {
      const sum =
        lo < 0
          ? span(loop + lo, loop, k) + span(0, hi, k)
          : hi > loop
            ? span(lo, loop, k) + span(0, hi - loop, k)
            : span(lo, hi, k);
      out[c * channels + k] = sum / (2 * r + 1); // float division: the mean
    }
  }
  return out;
}

/**
 * The world's mean per-texel `data` (`channels` values a texel) by height: `bins` bands from the lowest height to the
 * highest, each the mean over the world texels in it (an empty band takes the nearest band below that has texels, else
 * above). `at(h)` reads the band of height `h` metres, clamped to the world's range, so far mountains above the world's
 * top take its top band (KB-BIOMES-HORIZONALTITUDE1: the ring gave way to the whole edge's mean, so a far summit wore
 * the valley grass of the world's edge while the world's own summits were rock).
 * @example
 * const byHeight = horizonAltitudeMeans(heights, painted, 4);
 * byHeight.at(3900); // the mean RGBA weights of the world's ground near 3,900 m
 */
export function horizonAltitudeMeans(
  heights: ArrayLike<number>,
  data: ArrayLike<number>,
  channels: number,
  bins = 64,
): { readonly at: (height: number, out: Float32Array, offset?: number) => void } {
  if (!(channels >= 1) || data.length !== heights.length * channels || !(bins >= 1))
    throw rangeError('horizonAltitudeMeans needs channels values a height and 1 bin or more', 'biomes');
  let low = Infinity,
    high = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] < low) low = heights[i];
    if (heights[i] > high) high = heights[i];
  }
  const span = Math.max(high - low, 1e-6),
    band = (h: number) => Math.min(bins - 1, Math.max(0, Math.floor(((h - low) / span) * bins))), // float division
    sums = new Float64Array(bins * channels),
    counts = new Uint32Array(bins);
  for (let i = 0; i < heights.length; i++) {
    const b = band(heights[i]);
    counts[b]++;
    for (let k = 0; k < channels; k++) sums[b * channels + k] += data[i * channels + k];
  }
  const means = new Float32Array(bins * channels);
  for (let b = 0; b < bins; b++) {
    // The nearest band with texels, the lower one first at an equal distance.
    let s = b;
    for (let d = 1; !counts[s] && d < bins; d++)
      if (b - d >= 0 && counts[b - d]) s = b - d;
      else if (b + d < bins && counts[b + d]) s = b + d;
    for (let k = 0; k < channels; k++) means[b * channels + k] = counts[s] ? sums[s * channels + k] / counts[s] : 0; // float division: mean
  }
  return {
    at(height, out, offset = 0) {
      const b = band(height);
      for (let k = 0; k < channels; k++) out[offset + k] = means[b * channels + k];
    },
  };
}
