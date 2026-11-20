// Skin from what is in it: the spectral two-layer model of Donner and Jensen ("A Spectral BSSRDF for Shading Human Skin",
// EGSR 2006). An epidermis 0.25 mm thick holds melanin, a blend of brown-black eumelanin and yellow-red pheomelanin
// (their Eq. 3 to 6); a dermis below it, deep enough to count as endless, holds blood, oxy- and deoxy-hemoglobin (Eq. 7);
// both carry the baseline absorption of the rest of the tissue (Eq. 5, after Jacques 1998) and the reduced scattering of
// Eq. 8 (after Bashkatov et al. 2005), halved in the dermis; the index is 1.4 throughout. Hemoglobin's absorption is the
// measured molar extinction compiled by Prahl (OMLC, from Gratzer and Kollias), every 4 nm from 380 to 780 nm, at 150 g
// of hemoglobin a litre of blood.
// Each layer's light is the multipole diffusion of Donner and Jensen ("Light Diffusion in Multi-Layered Translucent
// Materials", SIGGRAPH 2005) in the frequency domain, where layers add as in Kubelka and Munk, R = R1 + T1 R2 T2 /
// (1 - R1' R2) with T2 the epidermis's transmittance from below, at every spatial frequency. A point source at depth z sends a share 1/2 exp(-|z| sqrt(sigma_tr^2 + k^2))
// of its light through a plane at frequency k (rad/mm), so a layer's reflectance and transmittance are sums over its
// poles in closed form, and at k = 0 they are the total reflectance, which for a half-space is the Rd of Jensen et al.
// (SIGGRAPH 2001). The spectrum goes to linear sRGB through the CIE 1931 observer in the multi-lobe fit of Wyman, Sloan
// and Shirley (JCGT 2013) and the sRGB matrix (IEC 61966-2-1), under an equal-energy light, white balanced so that a flat
// reflectance r is the grey r. The profile is fitted with the Gaussians of d'Eon and Luebke (GPU Gems 3, 2007) and two
// narrower ones for the short reach of melanin-rich skin, by non-negative least squares on the frequency profile, where
// a Gaussian of variance v is exp(-v k^2 / 2).

/** What a skin is made of: the parameters of Donner and Jensen 2006 less its oil. */
export interface SkinPhysiology {
  /** Volume fraction of melanin in the epidermis, 0 to 0.5 (0.002 very fair, about 0.3 dark). Default 0.01. */
  melanin?: number;
  /** Share of the melanin that is eumelanin (brown-black), the rest pheomelanin (yellow-red), 0 to 1. Default 0.7. */
  melaninBlend?: number;
  /** Volume fraction of blood in the dermis, 0.001 to 0.2. Default 0.005. */
  hemoglobin?: number;
  /** Share of the hemoglobin carrying oxygen, 0 to 1. Default 0.75 (Donner and Jensen; 0.6 to 0.8 in life). */
  oxygenation?: number;
}
/** Hemoglobin molar extinction in 1 / (cm M), oxy then deoxy, every 4 nm from 380 nm (Prahl, OMLC). */
const blood = [
  109564, 145232, 125420, 148668, 148100, 159544, 189740, 180004, 231612, 202124, 266232, 223296, 308716, 253368,
  422320, 287356, 500200, 321344, 521880, 363848, 480360, 407560, 376236, 461200, 283112, 500840, 214120, 552160,
  132820, 547040, 102580, 413280, 81444, 282724, 67044, 173320, 58864, 62640, 49496, 30698.8, 44480, 23388.8, 39807.2,
  19260.8, 34870.8, 17025.6, 31620, 15310, 28850.8, 14792.8, 26629.2, 14550, 25180.4, 15212.4, 24174.8, 15898, 23086.8,
  17469.6, 21850.4, 19041.2, 20932.8, 20862, 20418, 22803.6, 19996, 24745.2, 20150.4, 26936.8, 21001.6, 29263.2,
  24202.4, 31589.6, 29269.2, 34397.6, 35990, 37490, 43876, 40584, 49752, 43592, 53236, 46592, 52096, 49708, 46660,
  52496, 39675.2, 54080, 34476.8, 54540, 32613.2, 53788, 33915.6, 50572, 40172, 46948, 49172, 43340, 55540, 40092,
  50104, 37020, 34639.6, 34332.8, 19763.2, 31075.2, 10468.4, 25470, 5683.6, 19800, 3200, 14677.2, 2128, 12567.6, 1647.6,
  10477.6, 1364.4, 8591.2, 1110, 7344.8, 942, 6509.6, 774, 5906.8, 658.8, 5366.8, 561.2, 4930.8, 478.8, 4602.4, 442,
  4345.2, 405.2, 4088.4, 379.2, 3857.6, 356.8, 3642.64, 335.2, 3427.68, 319.6, 3226.56, 308.4, 3053.96, 298, 2881.4,
  290, 2708.84, 282, 2554.4, 277.6, 2407.92, 274.4, 2261.48, 274.4, 2115, 277.6, 2000.48, 282, 1897.56, 290, 1794.28,
  298, 1687.76, 308.4, 1583.52, 319.6, 1497.4, 332, 1411.32, 348, 1325.88, 364, 1244.44, 381.2, 1152.8, 398.8, 1102.2,
  418.8, 1101.76, 446, 1115.88, 473.2, 1207.4, 502.8, 1333.24, 533.2, 1515.32, 562, 1560.48, 586, 1548.52, 610, 1459.56,
  636.4, 1361.32, 663.6, 1262.44, 689.2, 1163.56, 710, 1075.44,
];
const count = blood.length / 2;
/** The wavelengths of `skinReflectance`, in nanometres: 380 to 780 every 4. */
export const skinWavelengths: readonly number[] = Array.from({ length: count }, (_, i) => 380 + 4 * i);
const lobe = (w: number, mean: number, below: number, above: number) => {
  const t = (w - mean) * (w < mean ? below : above);
  return Math.exp(-0.5 * t * t);
};
// Linear sRGB per wavelength: the sRGB matrix times the observer, each channel divided by its sum (equal-energy white).
const toRgb = (() => {
  const rows = skinWavelengths.map((w) => {
      const x =
          0.362 * lobe(w, 442, 0.0624, 0.0374) +
          1.056 * lobe(w, 599.8, 0.0264, 0.0323) -
          0.065 * lobe(w, 501.1, 0.049, 0.0382),
        y = 0.821 * lobe(w, 568.8, 0.0213, 0.0247) + 0.286 * lobe(w, 530.9, 0.0613, 0.0322),
        z = 1.217 * lobe(w, 437, 0.0845, 0.0278) + 0.681 * lobe(w, 459, 0.0385, 0.0725);
      return [
        3.2406 * x - 1.5372 * y - 0.4986 * z,
        -0.9689 * x + 1.8758 * y + 0.0415 * z,
        0.0557 * x - 0.204 * y + 1.057 * z,
      ];
    }),
    white = [0, 1, 2].map((c) => rows.reduce((s, r) => s + r[c], 0));
  return rows.map((r) => r.map((v, c) => v / white[c]));
})();
/** Hemispherical internal reflectance of a boundary of relative index `n` (Egan and Hilgeman, as in Jensen et al. 2001). */
const internal = (n: number) => -1.44 / (n * n) + 0.71 / n + 0.668 + 0.0636 * n;
const boundary = (n: number) => (n === 1 ? 1 : (1 + internal(n)) / (1 - internal(n)));
interface Layer {
  absorb: number;
  scatter: number;
}
/** Reflectance from the entry face and transmittance to the far one, at frequency `k`, of a slab `depth` mm deep. */
function slab({ absorb, scatter }: Layer, depth: number, entry: number, far: number, k: number): [number, number] {
  const extinct = absorb + scatter,
    albedo = scatter / extinct,
    diffusion = 1 / (3 * extinct),
    source = 1 / extinct,
    q = Math.sqrt(3 * absorb * extinct + k * k),
    near = 2 * entry * diffusion,
    flux = (z: number) => Math.sign(z) * Math.exp(-q * Math.abs(z));
  if (depth === Infinity) return [(albedo / 2) * (flux(source) - flux(-2 * near - source)), 0];
  // The mirror images of the source in the two extrapolated boundaries repeat every 2 (depth + both distances).
  const period = 2 * (depth + near + 2 * far * diffusion);
  let r = 0,
    t = 0;
  for (let i = -8; i <= 8; i++) {
    const real = source + i * period,
      virtual = -2 * near - source + i * period;
    r += flux(real) - flux(virtual);
    t += flux(depth - real) - flux(depth - virtual);
  }
  return [(albedo / 2) * r, (albedo / 2) * t];
}
/**
 * Total diffuse reflectance of a half-space of a translucent material from its reduced scattering and absorption
 * coefficients (in any one unit of 1 / length) and its index: the dipole of Jensen, Marschner, Levoy and Hanrahan 2001.
 */
export function diffusionReflectance(scatter: number, absorb: number, ior = 1.4): number {
  if (!(scatter > 0) || !(absorb >= 0) || !(ior >= 1) || !Number.isFinite(scatter + absorb + ior))
    throw new RangeError('diffusionReflectance needs scatter above 0, absorb 0 or more and an ior of 1 or more');
  return slab({ absorb, scatter }, Infinity, boundary(ior), 1, 0)[0];
}
function fraction(v: unknown, low: number, high: number, label: string): number {
  if (typeof v !== 'number' || !(v >= low && v <= high))
    throw new RangeError(`skin ${label} must be from ${low} to ${high}; pass a fraction in that range`);
  return v;
}
/** The physiology with its defaults, checked. */
export function skinPhysiology(p: SkinPhysiology = {}): Required<SkinPhysiology> {
  if (typeof p !== 'object' || p === null)
    throw new TypeError('skin physiology must be an object such as { melanin: 0.05 }');
  return {
    melanin: fraction(p.melanin ?? 0.01, 0, 0.5, 'melanin'),
    melaninBlend: fraction(p.melaninBlend ?? 0.7, 0, 1, 'melaninBlend'),
    hemoglobin: fraction(p.hemoglobin ?? 0.005, 0.001, 0.2, 'hemoglobin'),
    oxygenation: fraction(p.oxygenation ?? 0.75, 0, 1, 'oxygenation'),
  };
}
function layers(p?: SkinPhysiology): { epidermis: Layer; dermis: Layer }[] {
  const { melanin, melaninBlend: blend, hemoglobin, oxygenation: oxygen } = skinPhysiology(p),
    // 2.303 e (150 g / l) / (64,500 g / mol) is in 1 / cm; a tenth of it per mm.
    perMm = (2.303 * 150) / 64500 / 10;
  return skinWavelengths.map((w, i) => {
    const base = 0.0244 + 8.53 * Math.exp(-(w - 154) / 66.2),
      scatter = 14.74 * w ** -0.22 + 2.2e11 * w ** -4;
    return {
      epidermis: {
        absorb: melanin * (blend * 6.6e10 * w ** -3.33 + (1 - blend) * 2.9e14 * w ** -4.75) + (1 - melanin) * base,
        scatter,
      },
      dermis: {
        absorb:
          hemoglobin * perMm * (oxygen * blood[2 * i] + (1 - oxygen) * blood[2 * i + 1]) + (1 - hemoglobin) * base,
        scatter: scatter / 2,
      },
    };
  });
}
const epidermis = 0.25,
  air = boundary(1.4);
/** Reflectance of the two layers at frequency `k` (rad/mm), per wavelength. */
function frequency(stack: ReturnType<typeof layers>, k: number): Float64Array {
  return Float64Array.from(stack, (l) => {
    const [r1, t1] = slab(l.epidermis, epidermis, air, 1, k),
      [back, t2] = slab(l.epidermis, epidermis, 1, air, k),
      [r2] = slab(l.dermis, Infinity, 1, 1, k);
    // Down through the epidermis, back from the dermis, up through the epidermis from below, with the light that
    // bounces between the two layers.
    return r1 + (t1 * r2 * t2) / (1 - back * r2);
  });
}
const project = (spectrum: Float64Array): [number, number, number] => {
  const out: [number, number, number] = [0, 0, 0];
  spectrum.forEach((v, i) => {
    for (let c = 0; c < 3; c++) out[c] += v * toRgb[i][c];
  });
  return out;
};
/** Total diffuse reflectance of skin at each of `skinWavelengths`, its surface sheen left out. */
export function skinReflectance(physiology?: SkinPhysiology): Float64Array {
  return frequency(layers(physiology), 0);
}
/**
 * The skin's frequency profile in linear sRGB at `k` rad/mm, each colour divided by its total: 1 at 0, falling as the
 * light spreads. The Hankel transform of the radial profile; tests compare it with measured and fitted profiles.
 */
export function skinFrequency(physiology: SkinPhysiology | undefined, k: number): [number, number, number] {
  const stack = layers(physiology),
    zero = project(frequency(stack, 0)),
    at = project(frequency(stack, k));
  return [at[0] / zero[0], at[1] / zero[1], at[2] / zero[2]];
}
/** The diffuse colour (albedo) of skin in linear sRGB: the `PbrMaterial` `color` that goes with `skin(physiology)`. */
export function skinColor(physiology?: SkinPhysiology): [number, number, number] {
  return project(skinReflectance(physiology));
}
/** The Gaussian variances, in square millimetres, a fitted profile may use: d'Eon and Luebke's six and two narrower. */
const variances = [0.0004, 0.0016, 0.0064, 0.0484, 0.187, 0.567, 1.99, 7.41];
/** Lawson and Hanson's non-negative least squares (Solving Least Squares Problems, 1974, ch. 23), for a few columns. */
function nonNegative(rows: number[][], b: number[]): number[] {
  const n = rows[0].length,
    x = new Array<number>(n).fill(0),
    held = new Set<number>(),
    solve = (cols: number[]) => {
      const k = cols.length,
        m = cols.map((a) => [
          ...cols.map((c) => rows.reduce((s, r) => s + r[a] * r[c], 0)),
          rows.reduce((s, r, i) => s + r[a] * b[i], 0),
        ]);
      for (let p = 0; p < k; p++) {
        let top = p;
        for (let r = p + 1; r < k; r++) if (Math.abs(m[r][p]) > Math.abs(m[top][p])) top = r;
        [m[p], m[top]] = [m[top], m[p]];
        for (let r = 0; r < k; r++)
          if (r !== p) {
            const f = m[r][p] / m[p][p];
            for (let c = p; c <= k; c++) m[r][c] -= f * m[p][c];
          }
      }
      return cols.map((_, a) => m[a][k] / m[a][a]);
    };
  for (let round = 0; round < 4 * n; round++) {
    const residual = b.map((v, i) => v - rows[i].reduce((s, a, j) => s + a * x[j], 0));
    let next = -1,
      best = 1e-12;
    for (let j = 0; j < n; j++) {
      const g = rows.reduce((s, r, i) => s + r[j] * residual[i], 0);
      if (!held.has(j) && g > best) [best, next] = [g, j];
    }
    if (next < 0) break;
    held.add(next);
    for (let inner = 0; inner < 4 * n; inner++) {
      const cols = [...held],
        z = solve(cols);
      if (z.every((v) => v > 0)) {
        x.fill(0);
        cols.forEach((c, a) => (x[c] = z[a]));
        break;
      }
      let step = 1;
      cols.forEach((c, a) => {
        if (z[a] <= 0) step = Math.min(step, x[c] / (x[c] - z[a]));
      });
      cols.forEach((c, a) => {
        x[c] += step * (z[a] - x[c]);
        if (x[c] <= 1e-14) {
          x[c] = 0;
          held.delete(c);
        }
      });
    }
  }
  return x;
}
/**
 * The diffusion profile of skin made of `physiology` as Gaussians: rows of a variance in square millimetres and the red,
 * green and blue weights, each colour's weights summing to 1, in the form of d'Eon and Luebke's fit. `skin(physiology)`
 * draws with it.
 */
export function skinProfileOf(physiology?: SkinPhysiology): [number, number, number, number][] {
  const stack = layers(physiology),
    zero = project(frequency(stack, 0)),
    // Spatial frequencies from 0.02 to 300 rad/mm, evenly in their logarithm.
    ks = Array.from({ length: 80 }, (_, i) => 0.02 * 15000 ** (i / 79)),
    values = ks.map((k) => project(frequency(stack, k))),
    weights = [0, 1, 2].map((c) => {
      const rows = ks.map((k) => variances.map((v) => Math.exp((-v * k * k) / 2))),
        b = values.map((v) => v[c] / zero[c]);
      // A heavy row holds the weights to a sum of 1, so the profile keeps all the light.
      rows.push(variances.map(() => 30));
      b.push(30);
      const w = nonNegative(rows, b),
        sum = w.reduce((s, v) => s + v, 0);
      return w.map((v) => v / sum);
    });
  return variances
    .map((v, j): [number, number, number, number] => [v, weights[0][j], weights[1][j], weights[2][j]])
    .filter(([, r, g, b]) => r + g + b > 0);
}
