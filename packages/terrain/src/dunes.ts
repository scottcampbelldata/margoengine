// Wind-built sand dunes as a height field: transverse ridges and barchans with a gentle windward (stoss) side and a lee
// slip face at the angle of repose. Clean room from the papers, no other engine's code:
// - Bagnold 1941, "The Physics of Blown Sand and Desert Dunes" (London, 1941): slip faces stand at the angle of
//   repose of dry sand, about 32 to 34 degrees; windward slopes are gentle.
// - Sauermann, Kroy and Herrmann 2001, "Continuum saltation model for sand dunes", Phys. Rev. E 64, 031305, and Kroy,
//   Sauermann and Herrmann 2002, "Minimal model for sand dunes", Phys. Rev. Lett. 88, 054301: a smooth, convex stoss
//   profile whose steepest slope is about 10 to 15 degrees, the brink at or just past the crest, the slip face
//   behind it.
// - Hersen, Douady and Andreotti 2002, "Relevant length scale of barchan dunes", Phys. Rev. Lett. 89, 264301: barchan
//   length and width grow in proportion to height (width about 10 to 12 heights for the dunes measured).
// - Andreotti, Claudin and Douady 2002, "Selection of dune shapes and velocities", Eur. Phys. J. B 28: crestlines of
//   transverse dunes are sinuous and break into barchanoid segments where sand is short.
// - Werner 1995, "Eolian dunes: computer simulations and attractor interpretation", Geology 23(12): transverse ridges
//   form across the wind where sand is plentiful, barchans where it is scarce.
// The profile shapes (a half cosine on the stoss so its steepest slope is exactly `stoss`, a straight slip face at
// `lee` with a rounded toe, a value-noise crest phase and height) are Margo's reading of those measurements.

/** Dune kinds: ridges across the wind where sand is plentiful, isolated crescents where it is scarce (Werner 1995). */
export type DuneType = 'transverse' | 'barchan';

/** Options for {@link duneField}. Lengths in metres, angles in degrees. */
export interface DuneFieldOptions {
  /** Cells along x and z (the grid has `width * depth` heights, row by row along x). */
  readonly width: number;
  readonly depth: number;
  /** Metres between neighbouring heights. Default 1. */
  readonly cellSize?: number;
  /** World x and z of the first height. Default 0, 0. */
  readonly origin?: readonly [number, number];
  /** Direction the wind blows toward, degrees from +x toward +z. Default 90 (toward +z). */
  readonly wind?: number;
  readonly type?: DuneType;
  /** Crest height in metres. Default 4. */
  readonly height?: number;
  /** Crest-to-crest spacing along the wind (transverse) or mean distance between dunes (barchan). Default 70. */
  readonly spacing?: number;
  /** Steepest windward slope in degrees, 3 to 20. Default 12 (Sauermann et al. 2001). */
  readonly stoss?: number;
  /** Slip face slope, the angle of repose of dry sand, 25 to 36 degrees. Default 32 (Bagnold 1941). */
  readonly lee?: number;
  /** How much crests wander and vary, 0 to 1. Default 0.35. */
  readonly irregularity?: number;
  /** Seed of the crest noise. Default 1. */
  readonly seed?: number;
  /** Metres over which each brink is rounded (see {@link duneProfile}). Default 0, a sharp brink. */
  readonly round?: number;
  /** Heights to build the dunes on (metres, the grid's layout); default flat 0. */
  readonly base?: Float32Array;
  /** Share of dune height per world point, 0 to 1 (no dunes where 0, as on wet sand). Default 1 everywhere. */
  readonly amount?: (x: number, z: number) => number;
}

const hash = (n: number, seed: number) => {
  let h = Math.imul(n ^ Math.imul(seed, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
/** Smooth 1D value noise in [-1, 1]. */
function noise1(t: number, seed: number): number {
  const i = Math.floor(t),
    f = t - i,
    s = f * f * (3 - 2 * f);
  return (hash(i, seed) * (1 - s) + hash(i + 1, seed) * s) * 2 - 1;
}
/** Smooth 2D value noise in [-1, 1]. */
function noise2(x: number, z: number, seed: number): number {
  const i = Math.floor(x),
    j = Math.floor(z),
    fx = x - i,
    fz = z - j,
    sx = fx * fx * (3 - 2 * fx),
    sz = fz * fz * (3 - 2 * fz),
    h = (a: number, b: number) => hash(Math.imul(a, 73856093) ^ Math.imul(b, 19349663), seed);
  const top = h(i, j) * (1 - sx) + h(i + 1, j) * sx,
    bottom = h(i, j + 1) * (1 - sx) + h(i + 1, j + 1) * sx;
  return (top * (1 - sz) + bottom * sz) * 2 - 1;
}

/**
 * Height of one dune profile `p` metres downwind of its windward toe: a half cosine up the stoss side (steepest slope
 * `tanStoss` at its middle, level at the crest), then the slip face at `tanLee` down to the floor, its toe rounded over
 * `toe` metres. `round` (metres, default 0) rounds the brink over that length, as on old dunes whose crest the wind
 * has blunted: a parabola level where it leaves the stoss side and meeting the slip face at its slope. 0 outside.
 */
export function duneProfile(p: number, height: number, tanStoss: number, tanLee: number, toe = 0.6, round = 0): number {
  if (height <= 0 || p <= 0) return 0;
  const stossLength = (height * Math.PI) / (2 * tanStoss),
    // Half the rounded length, kept within half the stoss side and half the slip face.
    d = Math.max(0, Math.min(round / 2, stossLength / 2, height / tanLee / 2)),
    start = stossLength - d,
    up = (q: number) => (height * (1 - Math.cos((Math.PI * q) / stossLength))) / 2;
  if (p <= start) return up(p);
  // The brink: a parabola leaving the stoss side at its height and slope (s0) and reaching the face's slope 2 d later,
  // so the profile has no slope step; the straight face then runs on from where the parabola ends (y1).
  const y0 = up(start),
    s0 = d > 0 ? ((height * Math.PI) / (2 * stossLength)) * Math.sin((Math.PI * start) / stossLength) : 0,
    a = d > 0 ? (s0 + tanLee) / (4 * d) : 0,
    y1 = y0 + d * (s0 - tanLee);
  if (p < stossLength + d) return y0 + s0 * (p - start) - a * (p - start) ** 2;
  const down = y1 - (p - stossLength - d) * tanLee;
  // Round the toe: a parabola meeting the face's slope at down = r and the floor's at 0 (r = toe * tanLee / 2).
  const r = (toe * tanLee) / 2;
  if (down >= r) return down;
  const x = r - down; // 0 at the tangent point, 2 r at the straight face's floor crossing
  if (x >= 2 * r) return 0;
  return ((2 * r - x) * (2 * r - x)) / (4 * r);
}

/** Lengths of a dune of `height`: windward side, slip face and their sum, in metres. */
export function duneLengths(height: number, stoss = 12, lee = 32): { stoss: number; lee: number; total: number } {
  const a = (height * Math.PI) / (2 * Math.tan((stoss * Math.PI) / 180)),
    b = height / Math.tan((lee * Math.PI) / 180);
  return { stoss: a, lee: b, total: a + b };
}

/**
 * A height field of wind-built dunes, row by row along x (`width` heights a row, `depth` rows), added to `base`.
 * Transverse: ridges across the wind every `spacing` metres with wandering, varying crests; a ridge that would not fit
 * its spacing at full height is lowered so its windward side and slip face fit. Barchan: crescents one per `spacing`
 * cell with horns pointing downwind, width about 11 heights (Hersen et al. 2002).
 * @throws RangeError for a bad size, an angle outside its range or a height of 0 or less.
 */
export function duneField(options: DuneFieldOptions): Float32Array {
  const { width, depth } = options,
    cell = options.cellSize ?? 1,
    [ox, oz] = options.origin ?? [0, 0],
    type = options.type ?? 'transverse',
    H = options.height ?? 4,
    spacing = options.spacing ?? 70,
    stoss = options.stoss ?? 12,
    lee = options.lee ?? 32,
    irregular = options.irregularity ?? 0.35,
    seed = options.seed ?? 1,
    round = options.round ?? 0;
  if (!(round >= 0)) throw new RangeError('duneField: round is out of range; pass 0 or more metres.');
  if (!Number.isInteger(width) || !Number.isInteger(depth) || width < 2 || depth < 2 || width * depth > 1 << 26)
    throw new RangeError(
      'duneField: width and depth are wrong; pass integers of 2 or more (at most 67,108,864 heights).',
    );
  if (!(cell > 0) || !(H > 0) || !(spacing > 0))
    throw new RangeError('duneField: cellSize, height and spacing must be above 0.');
  if (!(stoss >= 3 && stoss <= 20))
    throw new RangeError('duneField: stoss is out of range; pass a windward slope of 3 to 20 degrees.');
  if (!(lee >= 25 && lee <= 36))
    throw new RangeError('duneField: lee is out of range; pass an angle of repose of 25 to 36 degrees.');
  if (!(irregular >= 0 && irregular <= 1))
    throw new RangeError('duneField: irregularity is out of range; pass 0 to 1.');
  if (type !== 'transverse' && type !== 'barchan')
    throw new RangeError("duneField: unknown type; pass 'transverse' or 'barchan'.");
  if (options.base && options.base.length !== width * depth)
    throw new RangeError('duneField: base must hold width * depth heights.');
  const out = options.base ? Float32Array.from(options.base) : new Float32Array(width * depth),
    w = ((options.wind ?? 90) * Math.PI) / 180,
    du = [Math.cos(w), Math.sin(w)],
    dv = [-du[1], du[0]],
    tanS = Math.tan((stoss * Math.PI) / 180),
    tanL = Math.tan((lee * Math.PI) / 180);
  for (let j = 0; j < depth; j++)
    for (let i = 0; i < width; i++) {
      const x = ox + i * cell,
        z = oz + j * cell,
        u = x * du[0] + z * du[1],
        v = x * dv[0] + z * dv[1],
        share = options.amount ? Math.min(1, Math.max(0, options.amount(x, z))) : 1;
      if (share <= 0) continue;
      let h = 0;
      if (type === 'transverse') {
        // Crest k sits at u = k * spacing + phase(v); its height and phase wander along the crest over a few spacings.
        const k0 = Math.floor(u / spacing);
        for (let k = k0 - 1; k <= k0 + 1; k++) {
          const phase = irregular * 0.25 * spacing * noise1(v / (2.5 * spacing) + k * 7.31, seed),
            crestHeight = H * (1 + irregular * 0.6 * noise1(v / (1.7 * spacing) + k * 3.77, seed + 1)),
            // Fit the dune into its spacing: lower it when its stoss side and slip face would overrun the next.
            fit = Math.min(crestHeight, spacing / duneLengths(1, stoss, lee).total),
            { stoss: a } = duneLengths(fit, stoss, lee),
            toe = k * spacing + phase - a;
          h = Math.max(h, duneProfile(u - toe, fit, tanS, tanL, 0.6, round));
        }
      } else {
        // One barchan per spacing x spacing cell, jittered, some cells empty (scarce sand).
        const ci = Math.floor(u / spacing),
          cj = Math.floor(v / spacing);
        for (let a = ci - 1; a <= ci + 1; a++)
          for (let b = cj - 1; b <= cj + 1; b++) {
            const n = Math.imul(a, 92837111) ^ Math.imul(b, 689287499);
            if (hash(n, seed + 2) < 0.35 * irregular) continue;
            const hb = H * (1 + irregular * 0.5 * (hash(n, seed + 3) * 2 - 1)),
              cu = (a + 0.5 + irregular * 0.3 * (hash(n, seed + 4) - 0.5)) * spacing,
              cv = (b + 0.5 + irregular * 0.3 * (hash(n, seed + 5) - 0.5)) * spacing;
            h = Math.max(h, barchan(u - cu, v - cv, hb, tanS, tanL, round));
          }
      }
      // Low hummocks between dunes (a tenth of the height, 0.3 spacings across) so the floor is not a plane.
      h += H * 0.06 * irregular * noise2(x / (0.3 * spacing), z / (0.3 * spacing), seed + 9);
      out[j * width + i] += Math.max(0, h) * share;
    }
  return out;
}

/**
 * One barchan of crest height `height` centred (crest) at u = 0, v = 0: a stoss side rising along the wind, a slip face
 * at `tanLee` whose brink curves downwind toward the horns, and horns trailing downwind at the sides. Width about 11
 * heights, as Hersen et al. 2002 measured.
 */
export function barchan(u: number, v: number, height: number, tanStoss: number, tanLee: number, round = 0): number {
  const halfWidth = 5.5 * height,
    s = v / halfWidth;
  if (Math.abs(s) >= 1) return 0;
  // Along the crest the dune falls toward the horns; the brink bends downwind as the square of the side distance.
  const local = height * (1 - s * s) ** 1.5,
    brink = 1.2 * height * s * s * (halfWidth / height) * 0.5,
    p = u - brink + (local * Math.PI) / (2 * tanStoss);
  let h = duneProfile(p, local, tanStoss, tanLee, 0.6, round);
  // The horns: thin ridges trailing downwind from the sides, lower than the body.
  const across = 1 - Math.min(1, Math.abs(Math.abs(s) - 0.72) / 0.22),
    horn = height * 0.3 * across * across * (3 - 2 * across);
  if (horn > 0 && u > brink) h = Math.max(h, horn * Math.max(0, 1 - (u - brink) / (4 * height)));
  return h;
}

/** Options for {@link duneHill}. Lengths in metres, angles in degrees. */
export interface DuneHillOptions {
  /** World x and z of the crest. */
  readonly crest: readonly [number, number];
  /** Crest height above the floor. */
  readonly height: number;
  /** Direction the wind blows toward, degrees from +x toward +z, as {@link DuneFieldOptions.wind}. Default 90. */
  readonly wind?: number;
  /** Half the hill's width across the wind; the crest falls off to its ends as a raised cosine. Default 5 heights. */
  readonly halfWidth?: number;
  /** Steepest windward slope, 3 to 20 degrees. Default 12. */
  readonly stoss?: number;
  /** Slip face slope, 20 to 36 degrees (a lower value for an old face that has slumped and settled). Default 30. */
  readonly lee?: number;
  /** Metres over which the brink is rounded. Default a third of the height. */
  readonly round?: number;
}

/**
 * Height at world (x, z) of one big isolated dune: a long windward side, a rounded crest and a steeper lee face, its
 * crest falling off to the ends across the wind. The shape the hills of a coastal dune field take when the wind comes
 * mostly from one side (Bagnold 1941; Sauermann, Kroy and Herrmann 2001); add it to a {@link duneField} or real heights.
 * @throws RangeError for a height of 0 or less or an angle outside its range.
 */
export function duneHill(x: number, z: number, options: DuneHillOptions): number {
  const H = options.height,
    stoss = options.stoss ?? 12,
    lee = options.lee ?? 30,
    half = options.halfWidth ?? 5 * H;
  if (!(H > 0) || !(half > 0)) throw new RangeError('duneHill: height and halfWidth must be above 0; pass metres.');
  if (!(stoss >= 3 && stoss <= 20)) throw new RangeError('duneHill: stoss is out of range; pass 3 to 20 degrees.');
  if (!(lee >= 20 && lee <= 36)) throw new RangeError('duneHill: lee is out of range; pass 20 to 36 degrees.');
  const w = ((options.wind ?? 90) * Math.PI) / 180,
    dx = x - options.crest[0],
    dz = z - options.crest[1],
    u = dx * Math.cos(w) + dz * Math.sin(w),
    v = -dx * Math.sin(w) + dz * Math.cos(w),
    s = Math.min(1, Math.abs(v) / half),
    local = (H * (1 + Math.cos(Math.PI * s))) / 2;
  if (local <= 0) return 0;
  const tanS = Math.tan((stoss * Math.PI) / 180),
    // The windward toe sits a stoss length upwind of the crest, so every cross-section peaks over u = 0.
    p = u + (local * Math.PI) / (2 * tanS);
  return duneProfile(p, local, tanS, Math.tan((lee * Math.PI) / 180), 0.6, ((options.round ?? H / 3) * local) / H);
}

/** Steepest slope in degrees of a height grid around cell (i, j), from central differences. */
export function slopeAt(heights: Float32Array, width: number, i: number, j: number, cellSize = 1): number {
  const depth = heights.length / width,
    at = (a: number, b: number) =>
      heights[Math.min(depth - 1, Math.max(0, b)) * width + Math.min(width - 1, Math.max(0, a))],
    gx = (at(i + 1, j) - at(i - 1, j)) / (2 * cellSize),
    gz = (at(i, j + 1) - at(i, j - 1)) / (2 * cellSize);
  return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
}
