// The breaker line of a coast on the CPU (sheet row 8). Water's surf breaks on the GPU (surf.ts): the swell components'
// envelope 2|E|, shoaled by Ks = sqrt(cg0 / cg), breaks where it reaches gamma h, gamma = 0.78 (J. McCowan, "On the
// highest wave of permanent type", Philosophical Magazine 38(233), 1894, https://doi.org/10.1080/14786449408620653).
// Nothing on the CPU knew where, so a weather drive could not find the breakers. Here the same sea gives the depth at
// which the waves start breaking on average: the root-mean-square envelope of components with independent phases,
// H(h) = 2 sqrt(sum (a_i Ks_i(h))^2) (the Rayleigh sea of M. S. Longuet-Higgins, "On the statistical distribution of the
// heights of sea waves", J. Mar. Res. 11(3), 1952), against gamma h; and the line is that depth's contour of the
// seabed, by marching squares (W. E. Lorensen and H. E. Cline, "Marching cubes: a high resolution 3D surface
// construction algorithm", SIGGRAPH 1987, https://doi.org/10.1145/37402.37422, in two dimensions, the saddle split by
// the cell's mean). Linear shoaling as in surf.ts: R. G. Dean and R. A. Dalrymple, "Water Wave Mechanics for Engineers
// and Scientists", 1991, ch. 4; the local wavenumber by J. D. Fenton and W. D. McKee, "On calculating the lengths of
// water waves", Coastal Engineering 14(6), 1990, https://doi.org/10.1016/0378-3839(90)90032-R.

/** McCowan's ratio of the highest wave to the depth (the surf shader's SURF_GAMMA). */
export const BREAKER_GAMMA = 0.78;

// The three spectral components every swell train is drawn as (swell-wgsl.ts `swellComponent`): wavenumber factor and
// amplitude share.
const COMPONENTS: readonly (readonly [number, number])[] = [
  [1, 0.4],
  [0.84, 0.35],
  [1.18, 0.25],
];

const localK = (k0: number, d: number): number => k0 / Math.tanh((k0 * Math.max(d, 0.01)) ** 0.75) ** (2 / 3);
const shoal = (k0: number, d: number): number => {
  const k = localK(k0, d),
    kh = Math.min(k * Math.max(d, 0.01), 10);
  return Math.sqrt((0.5 * k) / ((0.5 + kh / Math.sinh(2 * kh)) * k0));
};

/** A swell train as the breaker depth reads it: its amplitude (m) and wavenumber (radians per metre). */
export interface BreakerWave {
  readonly amplitude: number;
  readonly wavenumber: number;
}

/**
 * The still-water depth in metres at which the swell of `waves` starts breaking on average: the deepest h with
 * H(h) >= gamma h, H the root-mean-square height of the shoaled swell components (those the surf shader treats as
 * swell: wavenumber up to 2.5 times that of the highest train's lowest component), gamma {@link BREAKER_GAMMA}. 0 for no waves with height.
 * @throws RangeError for an amplitude or wavenumber that is not a finite number of 0 or more (wavenumber above 0).
 */
export function breakerDepth(waves: readonly BreakerWave[]): number {
  // The field: the lowest component of the train with the most height (the surf shader's surfFieldK).
  let field = Infinity,
    top = 0;
  for (const w of waves) {
    if (!(Number.isFinite(w.amplitude) && w.amplitude >= 0) || !(Number.isFinite(w.wavenumber) && w.wavenumber > 0))
      throw new RangeError('Breaker waves need a finite amplitude of 0 or more and a wavenumber above 0');
    if (w.amplitude > top) (top = w.amplitude), (field = w.wavenumber * 0.84);
  }
  if (field === Infinity) return 0;
  const parts: [number, number][] = [];
  for (const w of waves)
    if (w.amplitude > 0)
      for (const [m, share] of COMPONENTS) if (w.wavenumber * m <= field * 2.5) parts.push([w.wavenumber * m, w.amplitude * share]);
  const excess = (d: number): number => {
    let sum = 0;
    for (const [k0, a] of parts) sum += (a * shoal(k0, d)) ** 2;
    return 2 * Math.sqrt(sum) - BREAKER_GAMMA * d;
  };
  // From deep water inward: the first depth that breaks, then bisection to a millimetre.
  let deep = Math.max(1, Math.PI / field);
  while (excess(deep) >= 0) deep *= 2;
  let shallow = deep;
  while (shallow > 1e-3 && excess(shallow) < 0) shallow /= 1.25;
  if (excess(shallow) < 0) return 0;
  let lo = shallow,
    hi = shallow * 1.25;
  while (hi - lo > 1e-3) {
    const mid = 0.5 * (lo + hi);
    if (excess(mid) >= 0) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Heights of a terrain on the CPU: `width` x `height` texel values, rows along z, as the GPU heightmap holds them. */
export interface TerrainHeights {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/**
 * The contour at height `level` of terrain heights spread over `origin` and `size` (texel centres, as the water samples
 * its heightmap): the [x, z] segments where the bilinear ground crosses `level`, by marching squares. Empty when the
 * ground never crosses it.
 */
export function contourSegments(
  heights: TerrainHeights,
  origin: readonly [number, number],
  size: readonly [number, number],
  level: number,
): [number, number][][] {
  const { data, width: w, height: h } = heights,
    sx = size[0] / w,
    sz = size[1] / h,
    out: [number, number][][] = [],
    at = (i: number, j: number) => data[j * w + i]! - level,
    point = (i0: number, j0: number, v0: number, i1: number, j1: number, v1: number): [number, number] => {
      const t = v0 / (v0 - v1);
      return [origin[0] + (i0 + t * (i1 - i0) + 0.5) * sx, origin[1] + (j0 + t * (j1 - j0) + 0.5) * sz];
    };
  for (let j = 0; j + 1 < h; j++)
    for (let i = 0; i + 1 < w; i++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      // Crossings on the four edges in order: bottom (a-b), right (b-c), top (d-c), left (a-d).
      const cut: [number, number][] = [];
      if (a < 0 !== b < 0) cut.push(point(i, j, a, i + 1, j, b));
      if (b < 0 !== c < 0) cut.push(point(i + 1, j, b, i + 1, j + 1, c));
      if (d < 0 !== c < 0) cut.push(point(i, j + 1, d, i + 1, j + 1, c));
      if (a < 0 !== d < 0) cut.push(point(i, j, a, i, j + 1, d));
      if (cut.length === 2) out.push([cut[0]!, cut[1]!]);
      else if (cut.length === 4) {
        // A saddle: the cell's mean says which corners join.
        const above = (a + b + c + d) / 4 >= 0;
        if (above === a >= 0) out.push([cut[0]!, cut[1]!], [cut[2]!, cut[3]!]);
        else out.push([cut[0]!, cut[3]!], [cut[1]!, cut[2]!]);
      }
    }
  return out;
}
