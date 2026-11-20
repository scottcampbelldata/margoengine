// The period cast kit: cloth that reflects light the way measured cloth does, bodies with measured proportions, period
// garments built in code with seams and layers that fit those bodies, outfit sets per role and era, and outfit picks for
// crowds. Everything here is data and plain maths: no GPU object is made until a model built from `outfitGLB` is loaded.
//
// Sources (docs/clean-room.md, "humans/cast"; every value below names its table):
// - Cloth optics: I. Sadeghi, O. Bisker, J. De Deken, H. W. Jensen, "A Practical Microcylinder Appearance Model for
//   Cloth Rendering", ACM TOG 32(2):14, 2013 (technical report version, UCSD Computer Graphics Lab, June 2011,
//   https://escholarship.org/uc/item/6v11p5b0): Eq. 2 to 13, Table 2 (thread parameters), Table 3 (tangent curves).
// - Sheen lobe the GPU shades with: Estevez and Kulla 2017 "Production Friendly Microfacet Sheen BRDF" as
//   KHR_materials_sheen gives it (packages/shared/sheen.js); the fit below maps the measured model onto it.
// - Fibre refractive index of cotton: S. M. Burkinshaw, "Physico-chemical Aspects of Textile Coloration", SDC/Wiley
//   2016, Table 1.5 (n parallel 1.578, n perpendicular 1.532); keratin (wool) 1.55: Marschner et al. 2003 "Light
//   Scattering from Human Hair Fibers", Table 1.
// - Bodies: AIST/HQL 3D Anthropometric Database 2003, Statistics, Young Male (N 49) and Young Female (N 48),
//   https://www.airc.aist.go.jp/dhrt/fbodydb/2003_Statistics.pdf; AIST Japanese Head Dimension Database 2001
//   (young male N 56, young female N 61), https://www.airc.aist.go.jp/dhrt/head/; C. B. Davenport and A. G. Love,
//   "Army Anthropology", Medical Department of the US Army in the World War vol. XV, GPO 1921, Table 117 (blouse group
//   4m) and Table 119 (breeches group 5m), https://archive.org/details/medicaldepartmen15unituoft.
// - Garments: F. J. Harmon, "What Should Foresters Wear?", Journal of Forest History (Forest History Society),
//   https://foresthistory.org/wp-content/uploads/2017/01/foresterswear.pdf; Tucker and Fitzpatrick, Region 3 history
//   ch. 7, https://npshistory.com/publications/usfs/region/3/tucker-fitzpatrick/chap7.htm (1910 hat: light drab
//   Stetson, 4 inch crown, 3 inch brim; puttee leggings with breeches; denim coat and trousers in the 1910 catalogue);
//   Levi Strauss & Co., History of Levi's 501 Jeans (9 oz XX denim); Japan Ministry of the Environment press release
//   13775 (Super Cool Biz from 1 May 2011); Fisheries Agency, guide to life jacket wear for fishers (about 3 in 10 wore
//   one); Boston Children's Museum Japanese House collection records (gakuran trousers, wool blend).
import { GLB_BIN, GLB_JSON, GLB_MAGIC } from '../../shared/glb.js';
import { crownRows, crownTaper } from './crown.js';
import { sheenAlbedoGrid, sheenAlbedoTable } from '../../shared/sheen.js';
import {
  applySettings,
  checkSettings,
  choiceSetting,
  colorSetting,
  numberSetting,
  settingDefaults,
  type SettingRow,
} from '../../shared/settings.js';

/** Linear RGB. */
export type Rgb = readonly [number, number, number];
type V3 = [number, number, number];

// ---------------------------------------------------------------------------------------------------------------------
// Cloth optics: the microcylinder model of Sadeghi et al. 2013.
// ---------------------------------------------------------------------------------------------------------------------

/** One thread direction of a woven fabric (Sadeghi et al. 2013, Tables 2 and 3). Angles in degrees. */
export interface ThreadOptics {
  /** Area the thread covers in the smallest patch, a1 or a2 of Eq. 5. */
  readonly a: number;
  /** Coloured albedo A of Eq. 3, linear RGB. */
  readonly albedo: Rgb;
  /** Isotropic scattering kd of Eq. 3, 0 to 1. */
  readonly kd: number;
  /** Surface reflection Gaussian width (Eq. 2), degrees. */
  readonly gammaS: number;
  /** Volume scattering Gaussian width (Eq. 3), degrees. */
  readonly gammaV: number;
  /** Tangent curve: tangent offsets at its control points, degrees (Table 3). */
  readonly offsets: readonly number[];
  /** Tangent curve: length of each segment between control points (Table 3). */
  readonly lengths: readonly number[];
}
/** A fabric: refractive index and two thread directions, warp along the surface's u and weft along its v. */
export interface FabricOptics {
  readonly name: string;
  /** Index of refraction of the fibre. */
  readonly eta: number;
  readonly threads: readonly [ThreadOptics, ThreadOptics];
  /** A layer of loose fibre ends over the weave (wool's nap and hairiness), or none: {@link FabricFuzz}. */
  readonly fuzz?: FabricFuzz;
  /** Where the numbers come from. */
  readonly source: string;
}
/**
 * The loose fibre ends standing over a woven cloth (its hairiness, a wool's nap), shaded as a thin volume of fibre
 * microflakes over the weave: single scattering in a slab (W. Jakob, A. Arbree, J. T. Moon, K. Bala and S. Marschner,
 * "A Radiative Transfer Framework for Rendering Materials with Anisotropic Structure", SIGGRAPH 2010,
 * https://doi.org/10.1145/1778765.1778790), its flake normals spread as sin^exponent of their angle from the cloth's
 * normal: the fibre distribution the Charlie sheen was drawn from (A. C. Estevez and C. Kulla, "Production Friendly
 * Microfacet Sheen BRDF", Sony Pictures Imageworks 2017) and the volumetric fibre layer behind the LTC sheen of T.
 * Zeltner, B. Burley and M. J.-Y. Chiang, "Practical Multiple-Scattering Sheen Using Linearly Transformed Cosines",
 * SIGGRAPH 2022 Talks, https://doi.org/10.1145/3532836.3536240. The woven model under it (Sadeghi et al. 2013, Irawan
 * and Marschner 2012) has threads only, so without this layer a wool shows no grazing rim at all (KB-HUMANS-SHEENZERO1).
 */
export interface FabricFuzz {
  /** Optical depth of the fibre layer seen along the cloth's normal: the share of light a fibre end meets, about. */
  readonly depth: number;
  /** How tightly the fibres stand up from the cloth: flake normals spread as sin^exponent from the normal. */
  readonly exponent: number;
}
const SADEGHI = 'Sadeghi et al. 2013, Tables 2 and 3';
const scaled = (c: Rgb, s: number): Rgb => [c[0] * s, c[1] * s, c[2] * s];
const thread = (a: number, albedo: Rgb, kd: number, gammaS: number, gammaV: number, offsets: number[], lengths: number[]): ThreadOptics => ({
  a,
  albedo,
  kd,
  gammaS,
  gammaV,
  offsets,
  lengths,
});
// Table 3 prints the linen curve as "25, 25"; section 3.2.1 describes linen as orthogonally symmetric and a plain
// weave's thread rises and falls alike, so the sign the printed row lost is restored: -25 to 25 degrees.
const linen = thread(0.33, scaled([0.2, 0.8, 1], 0.3), 0.3, 12, 24, [-25, 25], [1]);
/**
 * The fabrics Sadeghi et al. measured, with their published parameters as printed (Table 2: eta, A, kd, gamma_s,
 * gamma_v; Table 3: area a, tangent offsets and segment lengths). The back face of the polyester satin is left out:
 * its printed row lists eight offsets with six lengths, so its curve cannot be rebuilt from the table.
 */
export const MEASURED_FABRICS = {
  linenPlain: { name: 'Linen Plain', eta: 1.46, threads: [linen, linen], source: SADEGHI },
  silkCrepeDeChine: {
    name: 'Silk Crepe de Chine',
    eta: 1.345,
    threads: [
      thread(0.75, scaled([1, 0.95, 0.05], 0.12), 0.2, 5, 10, [-35, -35, 35, 35], [1, 1, 1]),
      thread(0.25, scaled([1, 0.95, 0.05], 0.16), 0.3, 18, 32, [0, 0], [1]),
    ],
    source: SADEGHI,
  },
  polyesterSatinCharmeuse: {
    name: 'Polyester Satin Charmeuse (front)',
    eta: 1.539,
    threads: [
      thread(0.9, scaled([1, 0.37, 0.3], 0.035), 0.1, 2.5, 5, [-32, -32, -18, 0, 0, 18, 32, 32], [1.33, 0.66, 2, 2, 2, 0.66, 1.33]),
      thread(0.1, scaled([1, 0.37, 0.3], 0.2), 0.7, 30, 60, [0, 0], [1]),
    ],
    source: SADEGHI,
  },
  silkShot: {
    name: 'Silk Shot Fabric',
    eta: 1.345,
    threads: [
      thread(0.86, scaled([0.1, 1, 0.4], 0.2), 0.1, 4, 8, [-25, -25, 25, 25], [1.33, 2.67, 1.33]),
      thread(0.14, scaled([1, 0, 0.1], 0.6), 0.1, 5, 10, [0, 0], [1]),
    ],
    source: SADEGHI,
  },
  velvet: {
    name: 'Velvet',
    eta: 1.46,
    threads: [
      thread(0.5, scaled([0.05, 0.02, 0], 0.3), 0.1, 6, 12, [-90, -50], [1]),
      thread(0.5, scaled([0.05, 0.02, 0], 0.3), 0.1, 6, 12, [-90, -55, 55, 90], [0.5, 0, 0.5]),
    ],
    source: SADEGHI,
  },
} as const satisfies Record<string, FabricOptics>;

/** The cloth kinds period garments are cut from. */
export type FabricKind = 'cotton-denim' | 'cotton-duck' | 'cotton-shirting' | 'cotton-corduroy' | 'wool-worsted' | 'wool-flannel' | 'polyester-blend' | 'silk';
/** Cotton's mean refractive index, (1.578 + 1.532) / 2 (Burkinshaw 2016, Table 1.5). */
export const COTTON_ETA = 1.555;
/** Keratin's refractive index, 1.55 (Marschner et al. 2003, Table 1); wool is a keratin fibre. */
export const WOOL_ETA = 1.55;
/**
 * A period fabric dyed `color`: the threads of the closest fabric Sadeghi et al. measured with the fibre's own
 * refractive index. Spun staple yarns (cotton, wool, the polyester blends of uniforms) take the linen threads, the
 * paper's measured spun yarn, which it singles out for isotropic volume scattering; corduroy takes the velvet threads
 * (a cut pile); silk takes the crepe de chine. `color` is the cloth's reflectance as a colour measurement gives it
 * (linear RGB): the coloured albedo A of Eq. 3 is solved per channel so that the model's directional albedo at normal
 * incidence equals it. The angular shape is the measured model's; the brightness is the dye's. (Eq. 1 scatters per
 * unit length of thread, so the paper's A values are tied to its renderer's scale; this pins the scale to a measurement.)
 */
export function periodFabric(kind: FabricKind, color: Rgb): FabricOptics {
  checkColor(color, 'periodFabric color');
  const base = periodBase(kind),
    { surface, volume } = periodCalibration(kind),
    albedo = [0, 1, 2].map((c) => Math.max(0, (color[c] - surface) / volume)) as unknown as Rgb;
  return { ...base, threads: [{ ...base.threads[0], albedo }, { ...base.threads[1], albedo }] };
}
/** Every period fabric kind. */
export const FABRIC_KINDS: readonly FabricKind[] = [
  'cotton-denim',
  'cotton-duck',
  'cotton-shirting',
  'cotton-corduroy',
  'wool-worsted',
  'wool-flannel',
  'polyester-blend',
  'silk',
];
/**
 * Each period fabric's loose fibre ends. The depth is the area the fibre ends project over the cloth per unit area, from
 * yarn hairiness (the Uster H index: centimetres of protruding fibre per centimetre of yarn), fibre diameter and the
 * yarns per centimetre: H x diameter x (ends + picks), halved for the fibres' tilt. Worsted is combed and clear-finished
 * (H about 4, 20 micron wool, about 60 yarns a centimetre: about 0.25); flannel is woollen-spun and napped (H about 10,
 * 25 micron, about 40: about 0.5); carded cotton duck and denim about 0.1 to 0.15; combed shirting about 0.05; filament
 * polyester and silk have no fibre ends. Corduroy's pile is already its velvet threads. These are estimates from the
 * typical figures, not measurements of one cloth; the exponent 4 is a loose spread (Estevez and Kulla's alpha 0.25).
 */
const PERIOD_FUZZ: Partial<Record<FabricKind, FabricFuzz>> = {
  'wool-worsted': { depth: 0.25, exponent: 4 },
  'wool-flannel': { depth: 0.5, exponent: 4 },
  'cotton-duck': { depth: 0.1, exponent: 4 },
  'cotton-denim': { depth: 0.15, exponent: 4 },
  'cotton-shirting': { depth: 0.05, exponent: 4 },
};
const periodBases = new Map<FabricKind, FabricOptics>();
/** The period fabric's threads with a white albedo A = 1 (see {@link periodFabric}). */
function periodBase(kind: FabricKind): FabricOptics {
  if (!FABRIC_KINDS.includes(kind)) throw new RangeError(`Unknown fabric ${kind}; use one of ${FABRIC_KINDS.join(', ')}`);
  let base = periodBases.get(kind);
  if (!base) {
    const m: FabricOptics =
        kind === 'cotton-corduroy' ? MEASURED_FABRICS.velvet : kind === 'silk' ? MEASURED_FABRICS.silkCrepeDeChine : MEASURED_FABRICS.linenPlain,
      eta = kind.startsWith('wool') ? WOOL_ETA : kind === 'polyester-blend' ? MEASURED_FABRICS.polyesterSatinCharmeuse.eta : kind === 'silk' ? m.eta : COTTON_ETA,
      white: Rgb = [1, 1, 1];
    const fuzz = PERIOD_FUZZ[kind];
    base = {
      name: kind,
      eta,
      threads: [{ ...m.threads[0], albedo: white }, { ...m.threads[1], albedo: white }],
      ...(fuzz ? { fuzz } : {}),
      source: `${m.source} (${m.name} threads)${fuzz ? '; fibre ends as PERIOD_FUZZ' : ''}`,
    };
    periodBases.set(kind, base);
  }
  return base;
}
const withAlbedo = (f: FabricOptics, albedo: Rgb): FabricOptics => ({ ...f, threads: [{ ...f.threads[0], albedo }, { ...f.threads[1], albedo }] });
const calibrations = new Map<FabricKind, { surface: number; volume: number }>();
/**
 * The period fabric's directional albedo at normal incidence split into its surface part (A = 0) and its volume part
 * per unit A: albedo = surface + A volume, channel by channel.
 */
export function periodCalibration(kind: FabricKind): { surface: number; volume: number } {
  let c = calibrations.get(kind);
  if (!c) {
    const base = periodBase(kind),
      surface = fabricAlbedo(withAlbedo(base, [0, 0, 0]), 0)[0],
      volume = fabricAlbedo(base, 0)[0] - surface;
    calibrations.set(kind, (c = { surface, volume }));
  }
  return c;
}
function checkColor(c: unknown, what: string): asserts c is Rgb {
  if (!Array.isArray(c) || c.length !== 3 || !c.every((v) => typeof v === 'number' && v >= 0 && v <= 1))
    throw new RangeError(`${what} must be three linear RGB numbers from 0 to 1`);
}

const RAD = Math.PI / 180;
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** Unpolarised Fresnel reflectance of a dielectric of index `eta` at incidence cosine `c` (from outside). */
export function fresnelDielectric(eta: number, c: number): number {
  const ci = Math.min(1, Math.max(0, c)),
    st2 = (1 - ci * ci) / (eta * eta);
  if (st2 >= 1) return 1;
  const ct = Math.sqrt(1 - st2),
    rs = (ci - eta * ct) / (ci + eta * ct),
    rp = (eta * ci - ct) / (eta * ci + ct);
  return 0.5 * (rs * rs + rp * rp);
}
/** Unit-area Gaussian of standard deviation `width` (radians) at `x` (radians). */
const gauss = (width: number, x: number) => Math.exp((-x * x) / (2 * width * width)) / (width * Math.sqrt(2 * Math.PI));
/** Unit-height Gaussian of standard deviation 20 degrees, the u of Eq. 9 and 12 (the paper: 15 to 25 degrees). */
const unitHeight = (x: number) => Math.exp((-x * x) / (2 * (20 * RAD) ** 2));
const wrap = (x: number) => x - 2 * Math.PI * Math.round(x / (2 * Math.PI));

/**
 * The thread scattering function f_s of Sadeghi et al. 2013 (Eq. 2 to 4) for a thread along unit `t` with local normal
 * `n` (perpendicular to t), light from unit `wi`, seen from unit `wr`. Returns linear RGB, per unit length of thread.
 * The two transmission Fresnel terms of Eq. 3 are taken at the same reflection-normal angle as Eq. 2's Fresnel term.
 */
export function threadScattering(th: ThreadOptics, eta: number, t: V3, n: V3, wi: V3, wr: V3): V3 {
  const si = Math.max(-1, Math.min(1, dot(wi, t))),
    sr = Math.max(-1, Math.min(1, dot(wr, t))),
    ti = Math.asin(si),
    tr = Math.asin(sr),
    b: V3 = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]],
    pi = Math.atan2(dot(wi, b), dot(wi, n)),
    pr = Math.atan2(dot(wr, b), dot(wr, n)),
    pd = wrap(pi - pr),
    th_ = (ti + tr) / 2,
    td = (ti - tr) / 2,
    cd2 = Math.cos(pd / 2),
    Fr = fresnelDielectric(eta, Math.cos(td) * cd2),
    Ft = (1 - Fr) * (1 - Fr),
    surface = Fr * cd2 * gauss(th.gammaS * RAD, th_),
    volume = (Ft * ((1 - th.kd) * gauss(th.gammaV * RAD, th_) + th.kd)) / Math.max(Math.cos(ti) + Math.cos(tr), 1e-6),
    k = 1 / Math.max(Math.cos(td) ** 2, 1e-6);
  return [(surface + volume * th.albedo[0]) * k, (surface + volume * th.albedo[1]) * k, (surface + volume * th.albedo[2]) * k];
}
/** `count` tangent offsets (radians) sampled at equal steps along a thread's tangent curve (Table 3, Eq. 6). */
export function tangentSamples(th: ThreadOptics, count = 16): Float64Array {
  if (th.offsets.length !== th.lengths.length + 1) throw new RangeError('A tangent curve needs one more offset than segment lengths');
  const total = th.lengths.reduce((s, l) => s + l, 0),
    out = new Float64Array(count);
  for (let k = 0; k < count; k++) {
    let at = ((k + 0.5) / count) * total,
      seg = 0;
    while (seg < th.lengths.length - 1 && at > th.lengths[seg]) at -= th.lengths[seg++];
    const f = th.lengths[seg] > 0 ? Math.min(1, at / th.lengths[seg]) : 1;
    out[k] = (th.offsets[seg] + (th.offsets[seg + 1] - th.offsets[seg]) * f) * RAD;
  }
  return out;
}
const curves = new WeakMap<ThreadOptics, Float64Array>();
/**
 * The fabric BRDF of Sadeghi et al. 2013 (Eq. 13): for the surface frame normal +z, warp along +x and weft along +y,
 * light from unit `wi`, seen from unit `wr` (both above the surface). Each thread's tangent curve is sampled at 16
 * points; shadowing and masking (Eq. 7 to 9) and the projected-length reweighting (Eq. 11, 12) are applied. Linear RGB.
 * @example
 * fabricBRDF(MEASURED_FABRICS.linenPlain, [0, 0, 1], [0.5, 0, Math.sqrt(0.75)]); // [r, g, b]
 */
export function fabricBRDF(fabric: FabricOptics, wi: readonly number[], wr: readonly number[]): V3 {
  const out: V3 = [0, 0, 0];
  if (wi[2] <= 0 || wr[2] <= 0) return out;
  const i: V3 = [wi[0], wi[1], wi[2]],
    r: V3 = [wr[0], wr[1], wr[2]];
  let weights = 0;
  for (let j = 0; j < 2; j++) {
    const th = fabric.threads[j];
    let curve = curves.get(th);
    if (!curve) curves.set(th, (curve = tangentSamples(th)));
    // Warp runs along x, weft along y; the offset tilts the tangent toward the normal.
    const u: V3 = j === 0 ? [1, 0, 0] : [0, 1, 0];
    for (const psi of curve) {
      const c = Math.cos(psi),
        s = Math.sin(psi),
        t: V3 = [u[0] * c, u[1] * c, s],
        n: V3 = [-u[0] * s, -u[1] * s, c],
        b: V3 = [t[1] * n[2] - t[2] * n[1], t[2] * n[0] - t[0] * n[2], t[0] * n[1] - t[1] * n[0]];
      // Masking (Eq. 7 to 9): the cosine of each direction's azimuth about the thread, from its local normal.
      const ai = Math.atan2(dot(i, b), dot(i, n)),
        ar = Math.atan2(dot(r, b), dot(r, n)),
        mi = Math.max(Math.cos(ai), 0),
        mr = Math.max(Math.cos(ar), 0),
        um = unitHeight(wrap(ai - ar)),
        M = (1 - um) * mi * mr + um * Math.min(mi, mr);
      // Reweighting (Eq. 11, 12): the longitudinal angle between the normal and each direction in the (t, n) plane.
      const li = Math.atan2(dot(i, u), i[2]),
        lr = Math.atan2(dot(r, u), r[2]),
        qi = Math.max(Math.cos(li), 0),
        qr = Math.max(Math.cos(lr), 0),
        up = unitHeight(li - lr),
        P = (1 - up) * qi * qr + up * Math.min(qi, qr);
      weights += P;
      if (M * P <= 0) continue;
      const f = threadScattering(th, fabric.eta, t, n, i, r),
        w = th.a * M * P;
      out[0] += f[0] * w;
      out[1] += f[1] * w;
      out[2] += f[2] * w;
    }
  }
  const woven: V3 = weights > 0 ? [out[0] / weights, out[1] / weights, out[2] / weights] : [0, 0, 0];
  return fabric.fuzz ? fuzzed(fabric, woven, i, r) : woven;
}
/** Projected area of the fuzz's flakes along a direction at cosine `mu` to the normal, per exponent (64 steps). */
const fuzzAreas = new Map<number, Float64Array>();
function fuzzArea(exponent: number, mu: number): number {
  let table = fuzzAreas.get(exponent);
  if (!table) {
    // sigma(w) = integral of |w.m| D(m) over the sphere, D = c sin^p(theta) normalised to 1 over the sphere.
    const n = 64,
      steps = 96,
      dT = Math.PI / steps,
      dP = (2 * Math.PI) / steps,
      norm = sphereNorm(exponent);
    table = new Float64Array(n + 1);
    for (let j = 0; j <= n; j++) {
      const m = j / n,
        st = Math.sqrt(1 - m * m);
      let sum = 0;
      for (let a = 0; a < steps; a++) {
        const t = (a + 0.5) * dT,
          sn = Math.sin(t),
          d = sn ** exponent / norm;
        for (let b = 0; b < steps; b++) sum += Math.abs(st * sn * Math.cos((b + 0.5) * dP) + m * Math.cos(t)) * d * sn * dT * dP;
      }
      table[j] = sum;
    }
    fuzzAreas.set(exponent, table);
  }
  const x = Math.min(1, Math.abs(mu)) * (table.length - 1),
    j = Math.min(table.length - 2, Math.floor(x));
  return table[j] + (table[j + 1] - table[j]) * (x - j);
}
/**
 * The weave seen through the fuzz, plus the fuzz's own single scattering (Jakob et al. 2010, a homogeneous slab):
 * f = a D(h) (1 - e^-(rho sigma_i / mu_i + rho sigma_o / mu_o)) / (4 (sigma_i mu_o + sigma_o mu_i)), each flake a fibre
 * surface reflecting white by Fresnel and passing the rest into the dyed fibre (the thread's albedo, as the weave's
 * volume term does). Light the fuzz scatters forward is not followed (one bounce).
 */
function fuzzed(fabric: FabricOptics, woven: V3, i: V3, r: V3): V3 {
  const { depth, exponent } = fabric.fuzz!,
    mi = i[2],
    mo = r[2],
    si = fuzzArea(exponent, mi),
    so = fuzzArea(exponent, mo),
    rho = depth / fuzzArea(exponent, 1),
    tau = rho * (si / mi + so / mo),
    through = Math.exp(-tau),
    h: V3 = [i[0] + r[0], i[1] + r[1], i[2] + r[2]],
    hl = Math.hypot(h[0], h[1], h[2]) || 1,
    ch = h[2] / hl,
    sh = Math.sqrt(Math.max(0, 1 - ch * ch)),
    // The same normalisation fuzzArea uses: the sphere integral of sin^p.
    D = sh ** exponent / sphereNorm(exponent),
    F = fresnelDielectric(fabric.eta, dot(i, h) / hl),
    A = fabric.threads[0].albedo,
    single = (D * (1 - through)) / Math.max(4 * (si * mo + so * mi), 1e-9);
  return [0, 1, 2].map((c) => woven[c] * through + single * (F + (1 - F) * A[c])) as unknown as V3;
}
const sphereNorms = new Map<number, number>();
function sphereNorm(p: number): number {
  let v = sphereNorms.get(p);
  if (v === undefined) {
    v = 0;
    const steps = 96,
      dT = Math.PI / steps;
    for (let a = 0; a < steps; a++) v += Math.sin((a + 0.5) * dT) ** (p + 1) * dT * 2 * Math.PI;
    sphereNorms.set(p, v);
  }
  return v;
}
/**
 * Directional albedo of a fabric at incidence `thetaI` (radians, light in the xz plane rotated `phiI` about the normal):
 * the integral of the BRDF times n.l over the viewing hemisphere, by a midpoint rule of `steps` x 2`steps` cells.
 */
export function fabricAlbedo(fabric: FabricOptics, thetaI: number, phiI = 0, steps = 48): V3 {
  const wi: V3 = [Math.sin(thetaI) * Math.cos(phiI), Math.sin(thetaI) * Math.sin(phiI), Math.cos(thetaI)],
    sum: V3 = [0, 0, 0],
    dT = Math.PI / 2 / steps,
    dP = Math.PI / steps;
  for (let a = 0; a < steps; a++) {
    const t = (a + 0.5) * dT,
      st = Math.sin(t),
      ct = Math.cos(t);
    for (let b = 0; b < 2 * steps; b++) {
      const p = (b + 0.5) * dP,
        f = fabricBRDF(fabric, wi, [st * Math.cos(p), st * Math.sin(p), ct]),
        w = ct * st * dT * dP;
      sum[0] += f[0] * w;
      sum[1] += f[1] * w;
      sum[2] += f[2] * w;
    }
  }
  return sum;
}

// --- The GPU lobes: the measured model fitted to glTF base colour + KHR_materials_sheen, as the engine shades them. ---

/** The glTF material values a fabric is drawn with, fitted to its microcylinder BRDF. */
export interface ClothLobes {
  /** glTF baseColorFactor RGB (linear), metallic 0. */
  readonly baseColor: Rgb;
  /** glTF roughnessFactor of the dielectric layer. */
  readonly roughness: number;
  /** KHR_materials_sheen sheenColorFactor (linear). */
  readonly sheenColor: Rgb;
  /** KHR_materials_sheen sheenRoughnessFactor. */
  readonly sheenRoughness: number;
  /** Relative RMS difference between the fitted lobes and the measured model over the fit's directions. */
  readonly fitError: number;
}
const sheenLambdaL = (x: number, w: number) => {
  const a = 21.5473 + (25.3245 - 21.5473) * w,
    b = 3.82987 + (3.32435 - 3.82987) * w,
    c = 0.19823 + (0.16801 - 0.19823) * w,
    d = -1.9776 + (-1.27393 + 1.9776) * w,
    e = -4.32054 + (-4.85967 + 4.32054) * w;
  return a / (1 + b * Math.max(x, 1e-12) ** c) + d * x + e;
};
const sheenLambda = (c: number, w: number) => Math.exp(c < 0.5 ? sheenLambdaL(c, w) : 2 * sheenLambdaL(0.5, w) - sheenLambdaL(1 - c, w));
/** The KHR_materials_sheen BRDF without its colour, as packages/shared/sheen.js shades it. */
export function sheenBRDF(roughness: number, nl: number, nv: number, nh: number): number {
  const alpha = Math.max(roughness, 1e-4) ** 2,
    spread = 1 / alpha,
    D = ((2 + spread) * Math.max(1 - nh * nh, 0) ** (0.5 * spread)) / (2 * Math.PI),
    w = (1 - alpha) ** 2;
  return D / Math.max((1 + sheenLambda(nv, w) + sheenLambda(nl, w)) * 4 * nl * nv, 1e-6);
}
/** The sheen layer's directional albedo E(mu, r), read from the table the shaders use (packages/shared/sheen.js). */
export function sheenAlbedo(mu: number, roughness: number): number {
  const R = Math.min(1, Math.max(roughness, 1e-4)),
    m = Math.min(1, Math.max(mu, 1e-4)),
    { size, k, p } = sheenAlbedoGrid,
    u = (m * (R + k) / (R + k * m)) ** p * (size - 1),
    v = Math.sqrt(Math.min(1, Math.max(roughness, 0))) * (size - 1),
    u0 = Math.min(size - 2, Math.floor(u)),
    v0 = Math.min(size - 2, Math.floor(v)),
    fu = u - u0,
    fv = v - v0,
    at = (x: number, y: number) => sheenAlbedoTable[y * size + x],
    T = (at(u0, v0) * (1 - fu) + at(u0 + 1, v0) * fu) * (1 - fv) + (at(u0, v0 + 1) * (1 - fu) + at(u0 + 1, v0 + 1) * fu) * fv;
  return Math.min(1, Math.max(0, Math.exp(T) / R));
}
/** glTF's dielectric specular (F0 0.04, GGX, height-correlated Smith) at roughness `r`. */
function dielectricSpecular(r: number, nl: number, nv: number, nh: number, vh: number): number {
  const a2 = Math.max(r * r, 1e-3) ** 2,
    d = (1 - nh * nh) + a2 * nh * nh, // |n x h|^2 + a2 nh^2, the KB6016c form core uses
    D = a2 / (Math.PI * d * d),
    V = 0.5 / (nl * Math.sqrt(nv * nv * (1 - a2) + a2) + nv * Math.sqrt(nl * nl * (1 - a2) + a2)),
    F = 0.04 + 0.96 * (1 - vh) ** 5;
  return D * V * F;
}
interface FitSample {
  nl: number;
  nv: number;
  nh: number;
  vh: number;
  w: number;
  target: V3;
}
/** The fit's directions: incidence and view to 80 degrees, view azimuths over half a turn. */
function fitSamples(brdf: (wi: V3, wr: V3) => V3): FitSample[] {
  const samples: FitSample[] = [],
    turns = 8;
  for (let a = 0; a < 7; a++)
    for (let b = 0; b < 7; b++)
      for (let c = 0; c < 6; c++) {
        const ti = ((a + 0.5) / 7) * 80 * RAD,
          tr = ((b + 0.5) / 7) * 80 * RAD,
          pr = (c / 6) * Math.PI,
          target: V3 = [0, 0, 0];
        // Averaged over the cloth's turn about its normal: a garment shows every thread direction.
        for (let s = 0; s < turns; s++) {
          const rot = (s / turns) * 2 * Math.PI,
            f = brdf(
              [Math.sin(ti) * Math.cos(rot), Math.sin(ti) * Math.sin(rot), Math.cos(ti)],
              [Math.sin(tr) * Math.cos(rot + pr), Math.sin(tr) * Math.sin(rot + pr), Math.cos(tr)],
            );
          target[0] += f[0] / turns;
          target[1] += f[1] / turns;
          target[2] += f[2] / turns;
        }
        const nl = Math.cos(ti),
          nv = Math.cos(tr),
          wi: V3 = [Math.sin(ti), 0, nl],
          wr: V3 = [Math.sin(tr) * Math.cos(pr), Math.sin(tr) * Math.sin(pr), nv],
          h: V3 = [wi[0] + wr[0], wi[1] + wr[1], wi[2] + wr[2]],
          hl = Math.hypot(h[0], h[1], h[2]);
        samples.push({ nl, nv, nh: h[2] / hl, vh: dot(wr, h) / hl, w: nl * nv * Math.sin(ti) * Math.sin(tr), target });
      }
  return samples;
}
const gridTerms: { e: number; spec: number; sb: number }[][] = [];
const specularAlbedos: number[] = [];
/** Directional albedo of glTF's dielectric GGX at normal incidence, roughness `r` (midpoint rule). */
function specularAlbedo(r: number): number {
  const key = Math.round(r * 10);
  if (specularAlbedos[key] !== undefined) return specularAlbedos[key];
  let sum = 0;
  const steps = 128;
  for (let a = 0; a < steps; a++) {
    const t = ((a + 0.5) / steps) * (Math.PI / 2),
      nl = Math.cos(t),
      nh = Math.cos(t / 2);
    // View along the normal, light at t: the half vector sits at t / 2 and v.h = nh.
    sum += dielectricSpecular(r, nl, 1, nh, nh) * nl * Math.sin(t) * (Math.PI / 2 / steps) * 2 * Math.PI;
  }
  return (specularAlbedos[key] = sum);
}
/**
 * Fits base colour and sheen over the sheen and dielectric roughness grids, the base colour tied to `albedo` (the
 * model's directional albedo at normal incidence) so the drawn colour is the measured one; the fit error is the
 * weighted relative RMS of the shape that is left.
 */
function fitLobes(samples: readonly FitSample[], albedo: Rgb): ClothLobes {
  let best: ClothLobes | undefined;
  for (let ri = 0; ri < 6; ri++) {
    const roughness = 0.5 + ri * 0.1;
    for (let si = 1; si <= 20; si++) {
      const sheenRoughness = si / 20,
        // Every fit samples the same directions (fitSamples), so the lobe terms are computed once per grid cell.
        terms = (gridTerms[ri * 20 + si - 1] ??= samples.map((q) => ({
          e: Math.max(sheenAlbedo(q.nv, sheenRoughness), sheenAlbedo(q.nl, sheenRoughness)),
          spec: dielectricSpecular(roughness, q.nl, q.nv, q.nh, q.vh),
          sb: sheenBRDF(sheenRoughness, q.nl, q.nv, q.nh),
        })));
      const base: V3 = [0, 0, 0],
        sheen: V3 = [0, 0, 0],
        e0 = sheenAlbedo(1, sheenRoughness),
        spec0 = specularAlbedo(roughness);
      // The base colour is tied to the albedo: at normal incidence the drawn cloth reflects what the model (the dye)
      // does, scale0 (base + spec0) + sheen e0 = albedo, so only the sheen is fitted to the angular shape. The layer
      // under the sheen is scaled by 1 - max(sheen) E, which couples the channels: a few fixed-point rounds.
      for (let round = 0; round < 4; round++) {
        const m = Math.max(sheen[0], sheen[1], sheen[2]),
          scale0 = Math.max(1e-6, 1 - m * e0);
        for (let ch = 0; ch < 3; ch++) {
          let dd = 0,
            dy = 0;
          samples.forEach((q, k) => {
            const t = terms[k],
              scale = Math.max(0, 1 - m * t.e),
              // model = c + s d with base = (albedo - s e0) / scale0 - spec0.
              c = scale * ((albedo[ch] / scale0 - spec0) / Math.PI + t.spec),
              d = t.sb - (scale * e0) / (scale0 * Math.PI);
            dd += q.w * d * d;
            dy += q.w * d * (q.target[ch] - c);
          });
          const s0 = Math.min(1, Math.max(0, dd > 0 ? dy / dd : 0), Math.max(0, albedo[ch] / e0));
          sheen[ch] = s0;
          base[ch] = Math.min(1, Math.max(0, (albedo[ch] - s0 * e0) / scale0 - spec0));
        }
      }
      let err = 0,
        norm = 0;
      const m = Math.max(sheen[0], sheen[1], sheen[2]);
      samples.forEach((q, k) => {
        const t = terms[k],
          scale = Math.max(0, 1 - m * t.e);
        for (let ch = 0; ch < 3; ch++) {
          err += q.w * (scale * (base[ch] / Math.PI + t.spec) + sheen[ch] * t.sb - q.target[ch]) ** 2;
          norm += q.w * q.target[ch] ** 2;
        }
      });
      const fitError = Math.sqrt(err / Math.max(norm, 1e-30));
      if (!best || fitError < best.fitError) best = { baseColor: [...base], roughness, sheenColor: [...sheen], sheenRoughness, fitError };
    }
  }
  return best!;
}
const fitCache = new WeakMap<FabricOptics, ClothLobes>();
/**
 * Fits the engine's lobes (Lambert base colour scaled under a Charlie sheen, plus glTF's dielectric GGX) to the
 * fabric's microcylinder BRDF averaged over the fabric's turn about its normal, by weighted least squares over
 * incidence and view angles to 80 degrees. Cached per fabric object.
 * @example
 * const lobes = clothLobes(MEASURED_FABRICS.silkCrepeDeChine);
 */
export function clothLobes(fabric: FabricOptics): ClothLobes {
  let lobes = fitCache.get(fabric);
  if (!lobes) fitCache.set(fabric, (lobes = fitLobes(fitSamples((wi, wr) => fabricBRDF(fabric, wi, wr)), fabricAlbedo(fabric, 0))));
  return lobes;
}
const periodSamples = new Map<FabricKind, { surface: Float64Array; volume: Float64Array; samples: FitSample[] }>();
/**
 * {@link clothLobes} of `periodFabric(kind, color)`, fast: the model is surface + A volume per channel, so the two
 * parts are sampled once per kind and only the least squares runs per colour (a crowd of dye lots stays cheap).
 * @example
 * const lobes = periodLobes('wool-worsted', [0.07, 0.075, 0.035]);
 */
export function periodLobes(kind: FabricKind, color: Rgb): ClothLobes {
  const A = periodFabric(kind, color).threads[0].albedo;
  let parts = periodSamples.get(kind);
  if (!parts) {
    const base = periodBase(kind),
      white = fitSamples((wi, wr) => fabricBRDF(base, wi, wr)),
      zero = fitSamples((wi, wr) => fabricBRDF(withAlbedo(base, [0, 0, 0]), wi, wr));
    parts = {
      surface: Float64Array.from(zero, (q) => q.target[0]),
      volume: Float64Array.from(white, (q, k) => q.target[0] - zero[k].target[0]),
      samples: zero,
    };
    periodSamples.set(kind, parts);
  }
  const p = parts;
  return fitLobes(
    p.samples.map((q, k) => ({ ...q, target: [p.surface[k] + A[0] * p.volume[k], p.surface[k] + A[1] * p.volume[k], p.surface[k] + A[2] * p.volume[k]] as V3 })),
    color.map((c) => Math.max(c, periodCalibration(kind).surface)) as unknown as Rgb,
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Bodies: measured proportions, metres, y up, facing +z, feet at y = 0.
// ---------------------------------------------------------------------------------------------------------------------

/** A body the garments are cut for. Lengths in metres; girths are circumferences; breadths and depths full widths. */
export interface CastBody {
  readonly name: string;
  readonly source: string;
  readonly stature: number;
  readonly headGirth: number;
  readonly neckGirth: number;
  readonly neckHeight: number;
  readonly shoulderHeight: number;
  readonly shoulderBreadth: number;
  /** Fore-and-aft depth across the armscye at shoulder level. */
  readonly scyeDepth: number;
  readonly axillaHeight: number;
  readonly chestHeight: number;
  readonly chestGirth: number;
  readonly chestBreadth: number;
  readonly chestDepth: number;
  readonly waistHeight: number;
  readonly waistGirth: number;
  readonly waistBreadth: number;
  readonly waistDepth: number;
  readonly hipHeight: number;
  readonly hipGirth: number;
  readonly hipBreadth: number;
  readonly hipDepth: number;
  readonly crotchHeight: number;
  readonly thighHeight: number;
  readonly thighGirth: number;
  readonly kneeHeight: number;
  readonly kneeGirth: number;
  readonly calfHeight: number;
  readonly calfGirth: number;
  /** Acromion to wrist (ulnar styloid). */
  readonly armLength: number;
  readonly armGirth: number;
}
const AIST = 'AIST/HQL 3D Anthropometric Database 2003 (young male N 49, young female N 48); AIST head database 2001';
const mm = (v: number) => v / 1000;
/** Straight shoulder breadth from the neck root breadth, the side-neck-to-shoulder length and the shoulder slope. */
const shoulderFrom = (neckRoot: number, slope: number, slopeDeg: number) => mm(neckRoot + 2 * slope * Math.cos(slopeDeg * RAD));
const japanMan: CastBody = {
  name: 'Japan 2003 young man',
  source: AIST,
  stature: mm(1696.7),
  headGirth: mm(575.9),
  neckGirth: mm(422.8),
  neckHeight: mm(1431.6),
  shoulderHeight: mm(1363.5),
  shoulderBreadth: shoulderFrom(142.3, 152.4, 27.2),
  scyeDepth: mm(126.3),
  axillaHeight: mm(1242.2),
  chestHeight: mm(1217.3),
  chestGirth: mm(888.5),
  chestBreadth: mm(305.9),
  chestDepth: mm(209.7),
  waistHeight: mm(1058.6),
  waistGirth: mm(746.3),
  waistBreadth: mm(261.6),
  waistDepth: mm(197.8),
  hipHeight: mm(833.9),
  hipGirth: mm(907.6),
  hipBreadth: mm(322.8),
  hipDepth: mm(241.9),
  crotchHeight: mm(754.9),
  thighHeight: mm(710.1),
  thighGirth: mm(539.2),
  kneeHeight: mm(448.9),
  kneeGirth: mm(365.5),
  calfHeight: mm(302.3),
  calfGirth: mm(362.5),
  armLength: mm(563.2),
  armGirth: mm(282.2),
};
const japanWoman: CastBody = {
  name: 'Japan 2003 young woman',
  source: AIST,
  stature: mm(1578.3),
  headGirth: mm(551.1),
  neckGirth: mm(371.4),
  neckHeight: mm(1324.8),
  shoulderHeight: mm(1268.1),
  shoulderBreadth: shoulderFrom(124.8, 136.6, 27.55),
  scyeDepth: mm(111.7),
  axillaHeight: mm(1155.7),
  chestHeight: mm(1129.1),
  chestGirth: mm(868.7),
  chestBreadth: mm(273.5),
  chestDepth: mm(220.7),
  waistHeight: mm(987.3),
  waistGirth: mm(672.7),
  waistBreadth: mm(236.4),
  waistDepth: mm(177.5),
  hipHeight: mm(775.4),
  hipGirth: mm(900.2),
  hipBreadth: mm(327.5),
  hipDepth: mm(217.7),
  crotchHeight: mm(701.2),
  thighHeight: mm(672.5),
  thighGirth: mm(535.5),
  kneeHeight: mm(412.7),
  kneeGirth: mm(354.1),
  calfHeight: mm(280.3),
  calfGirth: mm(346.5),
  armLength: mm(519.9),
  armGirth: mm(262.8),
};
/** The AIST young man's value for `key` scaled by stature, for measures the 1921 tables do not give. */
const byStature = (key: keyof CastBody, stature: number) => ((japanMan[key] as number) / japanMan.stature) * stature;
const usStature = 1.72;
// Davenport and Love take the hip breadth as twice the thigh girth over pi (Army Anthropology, "thigh circumference").
const usHipBreadth = (2 * 0.525) / Math.PI;
const us1919Man: CastBody = {
  name: 'US 1919 man',
  source:
    'Davenport and Love 1921, Army Anthropology, Table 117 blouse group 4m (stature, chest, neck, shoulder, chest diameters, arm) and Table 119 breeches group 5m (waist, thigh, knee, calf, knee height); crotch = stature - sitting height; other heights and the girth-to-breadth ratios scaled from the AIST 2003 young man',
  stature: usStature,
  headGirth: byStature('headGirth', usStature),
  neckGirth: 0.357,
  neckHeight: byStature('neckHeight', usStature),
  shoulderHeight: byStature('shoulderHeight', usStature),
  shoulderBreadth: 0.415,
  scyeDepth: (japanMan.scyeDepth / japanMan.chestDepth) * 0.213,
  axillaHeight: byStature('axillaHeight', usStature),
  chestHeight: byStature('chestHeight', usStature),
  chestGirth: 0.876,
  chestBreadth: 0.288,
  chestDepth: 0.213,
  waistHeight: byStature('waistHeight', usStature),
  waistGirth: 0.77,
  waistBreadth: (japanMan.waistBreadth / japanMan.waistGirth) * 0.77,
  waistDepth: (japanMan.waistDepth / japanMan.waistGirth) * 0.77,
  hipHeight: byStature('hipHeight', usStature),
  hipGirth: (japanMan.hipGirth / japanMan.hipBreadth) * usHipBreadth,
  hipBreadth: usHipBreadth,
  hipDepth: (japanMan.hipDepth / japanMan.hipBreadth) * usHipBreadth,
  crotchHeight: usStature - 0.905,
  thighHeight: byStature('thighHeight', usStature),
  thighGirth: 0.525,
  kneeHeight: 0.469,
  kneeGirth: 0.362,
  calfHeight: byStature('calfHeight', usStature),
  calfGirth: 0.34,
  armLength: byStature('armLength', usStature),
  armGirth: (japanMan.armGirth / japanMan.chestGirth) * 0.876,
};
/** Measured bodies: the AIST 2003 young adults of Japan and the 1919 US Army demobilisation central sizes. */
export const BODIES = { japan2003Man: japanMan, japan2003Woman: japanWoman, us1919Man } as const satisfies Record<string, CastBody>;

/** Perimeter of the superellipse |x/a|^n + |y/b|^n = 1. */
export function superellipsePerimeter(a: number, b: number, n: number, steps = 256): number {
  let p = 0,
    px = a,
    py = 0;
  for (let k = 1; k <= steps; k++) {
    const t = (k / steps) * (Math.PI / 2),
      c = Math.cos(t),
      s = Math.sin(t),
      x = a * c ** (2 / n),
      y = b * s ** (2 / n);
    p += Math.hypot(x - px, y - py);
    px = x;
    py = y;
  }
  return 4 * p;
}
/** The superellipse exponent whose perimeter with half-axes a and b equals `girth` (bisection, 1.2 to 12). */
export function superellipseExponent(a: number, b: number, girth: number): number {
  let lo = 1.2,
    hi = 12;
  if (girth <= superellipsePerimeter(a, b, lo)) return lo;
  if (girth >= superellipsePerimeter(a, b, hi)) return hi;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (superellipsePerimeter(a, b, mid) < girth) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
/** Distance from the centre to the superellipse along the direction at angle `phi` (from +x toward +z). */
export const superellipseRadius = (a: number, b: number, n: number, phi: number) =>
  (Math.abs(Math.cos(phi) / a) ** n + Math.abs(Math.sin(phi) / b) ** n) ** (-1 / n);

/** One horizontal cross-section of the trunk: half breadth `a` (x), half depth `b` (z), exponent `n`, centre z. */
export interface Section {
  readonly y: number;
  readonly a: number;
  readonly b: number;
  readonly n: number;
}
const section = (y: number, breadth: number, depth: number, girth: number): Section => ({
  y,
  a: breadth / 2,
  b: depth / 2,
  n: superellipseExponent(breadth / 2, depth / 2, girth),
});
/**
 * The trunk's measured cross-sections from the crotch to the side neck point: hip, waist and chest are superellipses
 * with the measured breadth, depth and girth; the armpit keeps the chest section; the shoulder line has the shoulder
 * breadth and the scye depth; the neck is the neck girth's circle.
 */
export function trunkSections(body: CastBody): Section[] {
  const neck = body.neckGirth / Math.PI;
  return [
    section(body.crotchHeight, body.hipBreadth, body.hipDepth, body.hipGirth),
    section(body.hipHeight, body.hipBreadth, body.hipDepth, body.hipGirth),
    section(body.waistHeight, body.waistBreadth, body.waistDepth, body.waistGirth),
    section(body.chestHeight, body.chestBreadth, body.chestDepth, body.chestGirth),
    section(body.axillaHeight, body.chestBreadth, body.chestDepth, body.chestGirth),
    { y: body.shoulderHeight, a: body.shoulderBreadth / 2, b: body.scyeDepth / 2 + 0.5 * (body.chestDepth / 2 - body.scyeDepth / 2), n: 2.4 },
    { y: body.neckHeight, a: neck / 2, b: neck / 2, n: 2 },
  ];
}
/** The trunk section at height y, interpolated linearly between measured sections (clamped at the ends). */
export function trunkAt(sections: readonly Section[], y: number): Section {
  if (y <= sections[0].y) return sections[0];
  for (let k = 1; k < sections.length; k++)
    if (y <= sections[k].y) {
      const s0 = sections[k - 1],
        s1 = sections[k],
        f = (y - s0.y) / Math.max(s1.y - s0.y, 1e-9);
      return { y, a: s0.a + (s1.a - s0.a) * f, b: s0.b + (s1.b - s0.b) * f, n: s0.n + (s1.n - s0.n) * f };
    }
  return sections[sections.length - 1];
}
/** Leg radius at height y: thigh at the crotch and the thigh's height, then knee and calf; the calf below it. */
export function legRadius(body: CastBody, y: number): number {
  const pts: [number, number][] = [
    [0, body.calfGirth],
    [body.calfHeight, body.calfGirth],
    [body.kneeHeight, body.kneeGirth],
    [body.thighHeight, body.thighGirth],
    [body.crotchHeight, body.thighGirth],
  ];
  for (let k = 1; k < pts.length; k++)
    if (y <= pts[k][0]) {
      const f = (y - pts[k - 1][0]) / Math.max(pts[k][0] - pts[k - 1][0], 1e-9);
      return (pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f) / (2 * Math.PI);
    }
  return body.thighGirth / (2 * Math.PI);
}

// ---------------------------------------------------------------------------------------------------------------------
// Garments built in code.
// ---------------------------------------------------------------------------------------------------------------------

/** What a garment covers. */
export type GarmentCut = 'top' | 'legs' | 'skirt' | 'hat' | 'boots' | 'leggings' | 'tie';
/** One garment of an outfit. */
export interface GarmentSpec {
  readonly name: string;
  readonly cut: GarmentCut;
  /** Cloth; `coated` is a waterproof PVC or rubber layer, `leather` boots and belts: neither is woven, both are drawn as plain dielectrics. */
  readonly fabric: FabricKind | 'coated' | 'leather' | 'felt';
  readonly color: Rgb;
  /** Order from the skin out: 0 touches the body. */
  readonly layer: number;
  /** Cloth thickness, metres. */
  readonly thickness: number;
  /** Gap left to the layer beneath, metres. */
  readonly ease: number;
  /** Top: hem height as a fraction of the way from the crotch (0) to the waist (1); negative reaches down the thigh. Legs: hem height in metres. */
  readonly hem?: number;
  /** Top: sleeve length as a fraction of the arm (0 none, 1 to the wrist). */
  readonly sleeves?: number;
  /** Top: open at the centre front with this many buttons. */
  readonly buttons?: number;
  /** Legs: the cut below the knee hugs the leg (riding breeches) instead of hanging straight. */
  readonly fitted?: boolean;
  /** Legs or skirt: reaches up to the chest (bib overalls). */
  readonly bib?: boolean;
  /** Skirt: hem height in metres and the flare, metres of radius per metre of drop. */
  readonly flare?: number;
  /** Hat: crown height and brim width, metres. */
  readonly crown?: number;
  readonly brim?: number;
  /**
   * Hat: the share of the crown's height that rounds over into its top, 0 to 1. Default 0, a flat top (a top hat, a
   * campaign hat's crown); a derby's crown rounds over from about halfway up.
   */
  readonly dome?: number;
  /** Boots and leggings: top height in metres. */
  readonly top?: number;
  /**
   * Top, fitted to a body (`@margoengine/humans/fit`): the front opens in a V from the neck base down to the break, this
   * share of the way from the neck base (0) to the waist (1); the buttons start under the break. A waistcoat with one
   * goes over the shoulders without sleeves.
   */
  readonly opening?: number;
  /** Top with an opening, fitted to a body: lapels this wide, metres, folded back from the V. */
  readonly lapel?: number;
  /**
   * Top, fitted to a body: a collar standing this high up the neck from its base, metres (a shirt's standing collar; on
   * a top with an opening, a coat collar turned down over its stand).
   */
  readonly collar?: number;
  /**
   * Top with a standing collar, fitted to a body: the collar's fronts part from the stud at its base and their top
   * corners turn down and out into points this long, metres (the wing collar of the 1900s; 0 or unset: the band closes).
   */
  readonly points?: number;
  /**
   * Tie (`cut: 'tie'`): the knot at the collar's front, over the shirt and under the waistcoat. A four-in-hand hangs its
   * blade down the shirt front to the waist; a bow has no blade. Default 'four-in-hand'.
   */
  readonly knot?: 'four-in-hand' | 'bow';
}
/** A mesh of the garment: positions, normals, uvs, indices (the `@margoengine/geometry` GeometryData shape). */
export interface GarmentGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
}
/** A ring of the garment's surface around one axis, for fit and layer checks: centre, angle count and radii. */
export interface GarmentRing {
  /** 'trunk', 'armL', 'armR', 'legL', 'legR', 'head', 'skirt'. */
  readonly part: string;
  /** Height (trunk, legs, skirt, head) or distance along the arm from the shoulder (arms). */
  readonly at: number;
  /** Inner surface (the cloth's face toward the body) and outer surface, metres from the axis, per angle step. */
  readonly inner: Float32Array;
  readonly outer: Float32Array;
}
/** A garment built for a body. */
export interface Garment {
  readonly spec: GarmentSpec;
  readonly geometry: GarmentGeometry;
  /** Vertex index runs along each seam (side seams, inseams, centre front, shoulder line). */
  readonly seams: readonly (readonly number[])[];
  readonly rings: readonly GarmentRing[];
  /** Offset of the cloth's inner face from the skin, metres. */
  readonly offset: number;
}
/** Angle steps around every tube. Even, so the side seams fall on vertices. */
export const RING_STEPS = 48;
const SEAM_DEPTH = 0.0008;

class Builder {
  p: number[] = [];
  n: number[] = [];
  uv: number[] = [];
  ix: number[] = [];
  vert(p: V3, n: V3, u: number, v: number) {
    this.p.push(...p);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    this.n.push(n[0] / l, n[1] / l, n[2] / l);
    this.uv.push(u, v);
    return this.p.length / 3 - 1;
  }
  /** A tube: `rows` rings of `RING_STEPS + 1` vertices (the last repeats the first for the uv seam). */
  tube(rows: { centre: V3; along: V3; side: V3; radius: (phi: number) => number; v: number }[], flip = false) {
    const first = this.p.length / 3,
      cols = RING_STEPS + 1;
    for (const row of rows) {
      const front: V3 = [
        row.along[1] * row.side[2] - row.along[2] * row.side[1],
        row.along[2] * row.side[0] - row.along[0] * row.side[2],
        row.along[0] * row.side[1] - row.along[1] * row.side[0],
      ];
      for (let k = 0; k < cols; k++) {
        const phi = ((k % RING_STEPS) / RING_STEPS) * 2 * Math.PI,
          r = row.radius(phi),
          d: V3 = [
            row.side[0] * Math.cos(phi) + front[0] * Math.sin(phi),
            row.side[1] * Math.cos(phi) + front[1] * Math.sin(phi),
            row.side[2] * Math.cos(phi) + front[2] * Math.sin(phi),
          ];
        this.vert([row.centre[0] + d[0] * r, row.centre[1] + d[1] * r, row.centre[2] + d[2] * r], flip ? [-d[0], -d[1], -d[2]] : d, k / RING_STEPS, row.v);
      }
    }
    for (let r = 0; r + 1 < rows.length; r++)
      for (let k = 0; k < RING_STEPS; k++) {
        const a = first + r * cols + k,
          b = a + 1,
          c = a + cols,
          d = c + 1;
        // along x front points inward (along x (along x side) = -side), so the outward winding is a, b, c.
        if (flip) this.ix.push(a, c, b, b, c, d);
        else this.ix.push(a, b, c, b, d, c);
      }
    return { first, cols };
  }
  geometry(): GarmentGeometry {
    return { positions: new Float32Array(this.p), normals: new Float32Array(this.n), uvs: new Float32Array(this.uv), indices: new Uint32Array(this.ix) };
  }
}
/**
 * The seam angles of a tube: the two sides (0 and pi) and, for open tops, the centre front. A tube's angle runs from its
 * `side` toward `along x side`, which is -z for the upright trunk, so the front (+z) is at 3 pi / 2.
 */
const seamDip = (phi: number, front: boolean) => {
  const steps = [0, Math.PI, ...(front ? [1.5 * Math.PI] : [])];
  return steps.some((s) => Math.abs(wrap(phi - s)) < 1e-6) ? SEAM_DEPTH : 0;
};
const column = (start: number, cols: number, rows: number, k: number) => Array.from({ length: rows }, (_, r) => start + r * cols + k);
/**
 * How far from the trunk's axis, along the direction at angle `phi` (from +x toward -z, the trunk tubes' angle), a
 * garment must reach to clear two legs of radius `r` standing at x = +-`legX`: the far side of either leg's circle.
 */
export function legsReach(phi: number, legX: number, r: number): number {
  const c = Math.cos(phi),
    s = Math.sin(phi);
  let reach = 0;
  for (const cx of [-legX, legX]) {
    const disc = r * r - (cx * s) ** 2;
    if (disc >= 0) reach = Math.max(reach, cx * c + Math.sqrt(disc));
  }
  return reach;
}
/** Pose of the cut: the angle each arm hangs out from the vertical so its sleeves clear the trunk, and the leg axes. */
export interface CastPose {
  readonly armAngle: number;
  readonly legX: number;
}
/**
 * The rest pose the garments are cut in for `body` with clothes `offset` metres thick on the trunk and `armOffset` on
 * the arms: each arm hangs from the shoulder point at the smallest angle (to 0.05 degree) at which the dressed arm
 * clears the dressed trunk by 5 mm down to the wrist; each leg stands vertical at a quarter of the hip breadth from the
 * middle, or further out if the dressed thighs would touch.
 */
export function castPose(body: CastBody, offset = 0.02, armOffset = 0.02, legOffset = 0.01): CastPose {
  const sections = trunkSections(body),
    armR = body.armGirth / (2 * Math.PI) + armOffset,
    clears = (angle: number) => {
      for (let s = 0.08; s <= body.armLength; s += 0.01) {
        const x = body.shoulderBreadth / 2 + Math.sin(angle) * s,
          y = body.shoulderHeight - Math.cos(angle) * s;
        if (y < body.crotchHeight) break;
        // Above the armpit the sleeve is sewn into the body at the armscye: they join there by design.
        if (y > body.axillaHeight - 0.02) continue;
        const t = trunkAt(sections, y);
        if (x - armR < t.a + offset + 0.005) return false;
      }
      return true;
    };
  let lo = 0,
    hi = 25 * RAD;
  while (!clears(hi)) hi += 5 * RAD;
  while (hi - lo > 0.05 * RAD) {
    const mid = (lo + hi) / 2;
    if (clears(mid)) hi = mid;
    else lo = mid;
  }
  return { armAngle: hi, legX: Math.max(body.hipBreadth / 4, body.thighGirth / (2 * Math.PI) + legOffset + 0.003) };
}
/**
 * Builds every garment of `outfit` for `body` in one rest pose: layers stack from the skin out, each garment's inner face
 * sitting its own ease outside the outer face of everything beneath it on the same part of the body.
 * @example
 * const garments = dress(BODIES.us1919Man, OUTFITS['ranger-1910']);
 */
export function dress(body: CastBody, outfit: Outfit): Garment[] {
  checkOutfit(outfit);
  const sorted = [...outfit.garments].sort((a, b) => a.layer - b.layer),
    covers = (g: GarmentSpec, part: 'trunk' | 'arm' | 'leg') =>
      part === 'trunk' ? g.cut === 'top' || g.cut === 'skirt' || (g.cut === 'legs' && true) : part === 'arm' ? g.cut === 'top' && (g.sleeves ?? 0) > 0 : g.cut === 'legs' || g.cut === 'leggings' || g.cut === 'boots';
  const total = (part: 'trunk' | 'arm' | 'leg') => sorted.filter((g) => covers(g, part)).reduce((s, g) => s + g.ease + g.thickness, 0);
  const pose = castPose(body, total('trunk'), total('arm'), total('leg')),
    sections = trunkSections(body),
    out: Garment[] = [],
    below = { trunk: 0, arm: 0, leg: 0 };
  for (const spec of sorted) {
    // A tie lies on the shirt front under the waistcoat's own ease: it takes no girth from the layers over it.
    const part = spec.cut === 'top' || spec.cut === 'skirt' || spec.cut === 'tie' ? 'trunk' : spec.cut === 'hat' ? 'head' : 'leg';
    let offset: number;
    if (part === 'head') offset = spec.ease;
    else {
      offset = below[part] + spec.ease;
      // Legs garments also cover the trunk below the waist; take the larger stack so the seat clears both.
      if (spec.cut === 'legs') offset = Math.max(below.trunk, below.leg) + spec.ease;
    }
    const armOffset = below.arm + spec.ease;
    const g = build(body, sections, pose, spec, offset, armOffset, below.leg, floorOf(out));
    out.push(g);
    if ((part === 'trunk' && spec.cut !== 'tie') || spec.cut === 'legs') below.trunk = Math.max(below.trunk, offset + spec.thickness);
    if (spec.cut === 'legs' || spec.cut === 'leggings' || spec.cut === 'boots') below.leg = Math.max(below.leg, offset + spec.thickness);
    if (spec.cut === 'top' && (spec.sleeves ?? 0) > 0) below.arm = armOffset + spec.thickness;
  }
  return out;
}
/** The outer face of the garments already built on `part` at `at`, angle step `k`, or 0 where none reaches. */
type Floor = (part: string, at: number, k: number) => number;
function floorOf(built: readonly Garment[]): Floor {
  return (part, at, k) => {
    let most = 0;
    for (const g of built) {
      const rings = g.rings.filter((r) => r.part === part).sort((a, b) => a.at - b.at);
      if (!rings.length || at < rings[0].at - 1e-9 || at > rings[rings.length - 1].at + 1e-9) continue;
      for (let i = 0; i < rings.length; i++)
        if (at <= rings[i].at + 1e-9) {
          const a = rings[Math.max(0, i - 1)],
            b = rings[i],
            f = b.at > a.at ? Math.max(0, (at - a.at) / (b.at - a.at)) : 1;
          most = Math.max(most, a.outer[k] + (b.outer[k] - a.outer[k]) * f);
          break;
        }
    }
    return most;
  };
}
function build(
  body: CastBody,
  sections: readonly Section[],
  pose: CastPose,
  spec: GarmentSpec,
  offset: number,
  armOffset: number,
  legStack: number,
  floor: Floor,
): Garment {
  const b = new Builder(),
    seams: number[][] = [],
    rings: GarmentRing[] = [],
    th = spec.thickness;
  const ring = (part: string, at: number, inner: (phi: number) => number) => {
    const i = new Float32Array(RING_STEPS),
      o = new Float32Array(RING_STEPS);
    for (let k = 0; k < RING_STEPS; k++) {
      i[k] = inner((k / RING_STEPS) * 2 * Math.PI);
      o[k] = i[k] + th;
    }
    rings.push({ part, at, inner: i, outer: o });
  };
  // A thick tube: the outer face, the inner face (flipped) and the hem bands that join them at each open end.
  const thickTube = (
    part: string,
    given: { at: number; centre: V3; along: V3; side: V3; inner: (phi: number) => number }[],
    front: boolean,
  ) => {
    // Every station rests on the cloth already there: its inner face sits its ease outside their outer face (rings are
    // sampled at the same angle steps), so a later layer never passes through an earlier one.
    const stations = given.map((s) => ({
      ...s,
      inner: (phi: number) => Math.max(s.inner(phi), floor(part, s.at, Math.round((phi / (2 * Math.PI)) * RING_STEPS) % RING_STEPS) + spec.ease),
    }));
    const outer = b.tube(
      stations.map((s, r) => ({ centre: s.centre, along: s.along, side: s.side, radius: (phi) => s.inner(phi) + th - seamDip(phi, front), v: r / (stations.length - 1) })),
    );
    const inner = b.tube(
      stations.map((s, r) => ({ centre: s.centre, along: s.along, side: s.side, radius: (phi) => s.inner(phi), v: r / (stations.length - 1) })),
      true,
    );
    for (const s of stations) ring(part, s.at, s.inner);
    for (const end of [0, stations.length - 1]) {
      const cols = RING_STEPS + 1;
      for (let k = 0; k < RING_STEPS; k++) {
        const a = outer.first + end * cols + k,
          c = inner.first + end * cols + k;
        if (end === 0) b.ix.push(a, a + 1, c, a + 1, c + 1, c);
        else b.ix.push(a, c, a + 1, a + 1, c, c + 1);
      }
    }
    for (const k of [0, RING_STEPS / 2, ...(front ? [(3 * RING_STEPS) / 4] : [])]) seams.push(column(outer.first, RING_STEPS + 1, stations.length, k));
  };
  const up: V3 = [0, 1, 0],
    side: V3 = [1, 0, 0],
    trunkStations = (y0: number, y1: number, extra: (y: number, phi: number) => number) => {
      const rows = Math.max(2, Math.ceil((y1 - y0) / 0.02) + 1);
      return Array.from({ length: rows }, (_, r) => {
        const y = y0 + ((y1 - y0) * r) / (rows - 1),
          t = trunkAt(sections, y);
        return {
          at: y,
          centre: [0, y, 0] as V3,
          along: up,
          side,
          // Below the crotch the cloth hangs around both legs and whatever they wear.
          inner: (phi: number) =>
            Math.max(
              superellipseRadius(t.a, t.b, t.n, phi) + offset,
              y < body.crotchHeight ? legsReach(phi, pose.legX, legRadius(body, y) + legStack + 0.004) + spec.ease : 0,
            ) + extra(y, phi),
        };
      });
    };
  if (spec.cut === 'top') {
    const hem = spec.hem ?? 0.5,
      y0 = body.crotchHeight + (body.waistHeight - body.crotchHeight) * hem,
      // Collar: the cloth rises from the shoulder line to the side neck point.
      stations = trunkStations(Math.min(y0, body.waistHeight), body.neckHeight, () => 0);
    thickTube('trunk', stations, (spec.buttons ?? 0) > 0);
    const sleeves = spec.sleeves ?? 0;
    if (sleeves > 0)
      for (const s of [-1, 1]) {
        const along: V3 = [s * Math.sin(pose.armAngle), -Math.cos(pose.armAngle), 0],
          length = body.armLength * sleeves,
          start = 0.06,
          rows = Math.max(2, Math.ceil((length - start) / 0.03) + 1),
          r = body.armGirth / (2 * Math.PI) + armOffset;
        const st = Array.from({ length: rows }, (_, k) => {
          const d = start + ((length - start) * k) / (rows - 1);
          return {
            at: d,
            centre: [s * body.shoulderBreadth / 2 + along[0] * d, body.shoulderHeight + along[1] * d, 0] as V3,
            along,
            side: [Math.cos(pose.armAngle), s * Math.sin(pose.armAngle), 0] as V3,
            inner: () => r,
          };
        });
        thickTube(s < 0 ? 'armR' : 'armL', st, false);
      }
    if (spec.buttons)
      for (let k = 0; k < spec.buttons; k++) {
        const y = body.waistHeight + ((body.axillaHeight - body.waistHeight) * (k + 0.5)) / spec.buttons,
          t = trunkAt(sections, y),
          z = superellipseRadius(t.a, t.b, t.n, Math.PI / 2) + offset + th;
        disc(b, [0, y, z], 0.0085, 0.003);
      }
  } else if (spec.cut === 'legs') {
    const hem = spec.hem ?? 0.02,
      top = spec.bib ? body.chestHeight : body.waistHeight;
    thickTube('trunk', trunkStations(body.crotchHeight, top, () => 0), false);
    for (const s of [-1, 1]) {
      const rows = Math.max(2, Math.ceil((body.crotchHeight - hem) / 0.02) + 1);
      let widest = 0;
      const st = Array.from({ length: rows }, (_, k) => {
        const y = body.crotchHeight - ((body.crotchHeight - hem) * k) / (rows - 1),
          leg = legRadius(body, y);
        // Cloth hangs straight down from the widest girth above it, unless the cut is fitted below the knee.
        widest = Math.max(widest, leg);
        const r = (spec.fitted && y < body.kneeHeight ? leg : widest) + offset;
        return { at: y, centre: [s * pose.legX, y, 0] as V3, along: [0, -1, 0] as V3, side: [-1, 0, 0] as V3, inner: () => r };
      });
      thickTube(s < 0 ? 'legR' : 'legL', st, false);
    }
  } else if (spec.cut === 'skirt') {
    // Hangs from the waist: below the hips it falls from its widest point, flares by `flare` per metre of drop and
    // clears both legs; built bottom up in the trunk's frame so its rings line up with the tops over and under it.
    const hem = spec.hem ?? body.kneeHeight,
      flare = spec.flare ?? 0.15,
      hip = trunkAt(sections, body.hipHeight);
    thickTube(
      'trunk',
      trunkStations(hem, body.waistHeight, () => 0).map((s) => {
        const y = s.at,
          drop = Math.max(0, body.hipHeight - y);
        return {
          ...s,
          inner: (phi: number) =>
            y >= body.hipHeight
              ? s.inner(phi)
              : Math.max(
                  superellipseRadius(hip.a, hip.b, hip.n, phi) + offset,
                  legsReach(phi, pose.legX, legRadius(body, y) + legStack + 0.004) + spec.ease,
                ) +
                flare * drop,
        };
      }),
      false,
    );
  } else if (spec.cut === 'tie') {
    // The unfitted kit's tie: a knot under the neck and, for a four-in-hand, a blade down the shirt front to the waist,
    // in slabs that follow the front of the trunk (a fitted body gets the knot and blade of @margoengine/humans/fit).
    const front = (y: number) => {
        const t = trunkAt(sections, y);
        return superellipseRadius(t.a, t.b, t.n, Math.PI / 2) + offset;
      },
      knotY = body.neckHeight - 0.02;
    box(b, [0, knotY, front(knotY) + 0.007], [0.014, 0.018, 0.007]);
    if ((spec.knot ?? 'four-in-hand') === 'four-in-hand')
      for (let y = knotY - 0.018; y > body.waistHeight + 0.045; y -= 0.04) {
        const low = Math.max(body.waistHeight + 0.04, y - 0.04),
          yc = (y + low) / 2;
        box(b, [0, yc, front(yc) + th / 2], [Math.min(0.028, 0.012 + (knotY - yc) * 0.08), (y - low) / 2, th / 2]);
      }
  } else if (spec.cut === 'leggings' || spec.cut === 'boots') {
    const topY = spec.top ?? body.calfHeight + 0.08,
      rows = Math.max(2, Math.ceil(topY / 0.02) + 1);
    for (const s of [-1, 1]) {
      const st = Array.from({ length: rows }, (_, k) => {
        const y = topY - (topY * k) / (rows - 1),
          r = legRadius(body, y) + offset;
        return { at: y, centre: [s * pose.legX, y, 0] as V3, along: [0, -1, 0] as V3, side: [-1, 0, 0] as V3, inner: () => r };
      });
      thickTube(s < 0 ? 'legR' : 'legL', st, false);
      if (spec.cut === 'boots') {
        // The sole: a slab under the foot, 0.27 m long, as wide as the calf.
        const w = legRadius(body, 0) + offset + th;
        box(b, [s * pose.legX, -0.012, 0.06], [w, 0.012, 0.135]);
      }
    }
  } else {
    // Hat: a crown ring sized to the head girth plus ease, closed on top (flat, or rounded over as a derby's), and a
    // flat brim.
    const r = body.headGirth / (2 * Math.PI) + offset,
      crown = spec.crown ?? 0.1,
      brim = spec.brim ?? 0.06,
      base = body.stature - 0.09,
      dome = spec.dome ?? 0,
      st = crownRows(dome).map((f) => ({ at: base + crown * f, centre: [0, base + crown * f, 0] as V3, along: up, side, inner: () => r * crownTaper(f, dome) }));
    thickTube('head', st, false);
    disc(b, [0, base + crown + th / 2, 0], r * crownTaper(1, dome) + th, th, [0, 1, 0]);
    annulus(b, base, r + th, r + th + brim, th);
  }
  return { spec, geometry: b.geometry(), seams, rings, offset };
}
/** A flat disc facing `normal` (default +z) with a rim, radius r, thickness t. */
function disc(b: Builder, c: V3, r: number, t: number, normal: V3 = [0, 0, 1]) {
  const [u, v] = normal[1] !== 0 ? [[1, 0, 0] as V3, [0, 0, 1] as V3] : [[1, 0, 0] as V3, [0, 1, 0] as V3],
    steps = 16,
    centre = b.vert([c[0] + normal[0] * t, c[1] + normal[1] * t, c[2] + normal[2] * t], normal, 0.5, 0.5),
    rim: number[] = [];
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * 2 * Math.PI,
      d: V3 = [u[0] * Math.cos(a) + v[0] * Math.sin(a), u[1] * Math.cos(a) + v[1] * Math.sin(a), u[2] * Math.cos(a) + v[2] * Math.sin(a)];
    rim.push(b.vert([c[0] + d[0] * r + normal[0] * t, c[1] + d[1] * r + normal[1] * t, c[2] + d[2] * r + normal[2] * t], normal, 0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2));
    rim.push(b.vert([c[0] + d[0] * r, c[1] + d[1] * r, c[2] + d[2] * r], d, 0, 0));
  }
  for (let k = 0; k < steps; k++) {
    const a = rim[2 * k],
      a2 = rim[2 * ((k + 1) % steps)],
      s = rim[2 * k + 1],
      s2 = rim[2 * ((k + 1) % steps) + 1];
    b.ix.push(centre, a, a2, a, s, a2, a2, s, s2);
  }
}
/** A flat ring at height y between radii r0 and r1, thickness t, faces up and down. */
function annulus(b: Builder, y: number, r0: number, r1: number, t: number) {
  const steps = RING_STEPS,
    first = b.p.length / 3;
  for (let k = 0; k < steps; k++) {
    const a = (k / steps) * 2 * Math.PI,
      c = Math.cos(a),
      s = Math.sin(a);
    b.vert([c * r0, y + t, s * r0], [0, 1, 0], k / steps, 0);
    b.vert([c * r1, y + t, s * r1], [0, 1, 0], k / steps, 1);
    b.vert([c * r0, y, s * r0], [0, -1, 0], k / steps, 0);
    b.vert([c * r1, y, s * r1], [0, -1, 0], k / steps, 1);
    b.vert([c * r1, y + t, s * r1], [c, 0, s], k / steps, 1);
    b.vert([c * r1, y, s * r1], [c, 0, s], k / steps, 1);
  }
  for (let k = 0; k < steps; k++) {
    const a = first + 6 * k,
      n = first + 6 * ((k + 1) % steps);
    b.ix.push(a, n, a + 1, a + 1, n, n + 1);
    b.ix.push(a + 2, a + 3, n + 2, a + 3, n + 3, n + 2);
    b.ix.push(a + 4, n + 4, a + 5, a + 5, n + 4, n + 5);
  }
}
/** An axis-aligned box of half extents h centred at c. */
function box(b: Builder, c: V3, h: V3) {
  for (let axis = 0; axis < 3; axis++)
    for (const s of [-1, 1]) {
      const n: V3 = [0, 0, 0];
      n[axis] = s;
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        first = b.p.length / 3;
      for (const [du, dv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const p: V3 = [c[0], c[1], c[2]];
        p[axis] += s * h[axis];
        p[u] += du * h[u];
        p[v] += dv * h[v];
        b.vert(p, n, (du + 1) / 2, (dv + 1) / 2);
      }
      if (s > 0) b.ix.push(first, first + 1, first + 2, first, first + 2, first + 3);
      else b.ix.push(first, first + 2, first + 1, first, first + 3, first + 2);
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Outfits per role and era.
// ---------------------------------------------------------------------------------------------------------------------

/** An outfit: garments for one role, the body it is cut for, and its sources. */
export interface Outfit {
  readonly role: string;
  readonly era: '1910-american-west' | '2011-coastal-japan';
  readonly body: keyof typeof BODIES;
  readonly garments: readonly GarmentSpec[];
  /** Chance the outfit's optional garments (those named in `optional`) are worn, 0 to 1. */
  readonly optional?: { readonly names: readonly string[]; readonly chance: number };
  readonly source: string;
}
const inch = 0.0254;
// Colours are the linear RGB of the colour the source names (no measured reflectance of these dyes was found).
const OLIVE_GREEN: Rgb = [0.07, 0.075, 0.035],
  LIGHT_DRAB: Rgb = [0.4, 0.33, 0.22],
  GRAY_FLANNEL: Rgb = [0.28, 0.28, 0.27],
  INDIGO_DENIM: Rgb = [0.03, 0.05, 0.12],
  DUCK_TAN: Rgb = [0.45, 0.36, 0.22],
  BLUE_FLANNEL: Rgb = [0.05, 0.08, 0.2],
  CORDUROY_BROWN: Rgb = [0.12, 0.07, 0.035],
  LEATHER_BROWN: Rgb = [0.08, 0.04, 0.02],
  BLACK_WOOL: Rgb = [0.012, 0.012, 0.014],
  CHARCOAL: Rgb = [0.03, 0.032, 0.036],
  // A dark grey-brown worsted, the dye's albedo: the drawn base colour is this less the surface reflection (about
  // sRGB 68, 61, 54). Pure charcoal at 0.03 left a base colour of 0.004 once the fit took the cloth's surface share out.
  DARK_WORSTED: Rgb = [0.085, 0.075, 0.065],
  NAVY: Rgb = [0.012, 0.018, 0.05],
  // A black silk tie: the dye's albedo under the silk's own sheen.
  BLACK_SILK: Rgb = [0.014, 0.013, 0.015],
  WHITE_COTTON: Rgb = [0.78, 0.78, 0.76],
  COATED_ORANGE: Rgb = [0.8, 0.2, 0.02],
  COATED_NAVY: Rgb = [0.02, 0.04, 0.12],
  RUBBER_BLACK: Rgb = [0.02, 0.02, 0.02];
const g = (spec: GarmentSpec) => spec;
// Footwear is the first layer on the legs: trousers hang over it, puttees wrap it.
const boots = (color: Rgb, top: number): GarmentSpec => g({ name: 'boots', cut: 'boots', fabric: 'leather', color, layer: 0, thickness: 0.003, ease: 0.004, top });
/**
 * The cast: outfits per role. 1910 American West roles are cut for `us1919Man`; 2011 coastal Japan for the AIST bodies.
 * Women of 1910 are not in the kit: no measured body of the period was found.
 */
export const OUTFITS = {
  'ranger-1910': {
    role: 'US Forest Service ranger, 1910 uniform',
    era: '1910-american-west',
    body: 'us1919Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'wool-flannel', color: GRAY_FLANNEL, layer: 0, thickness: 0.0012, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'breeches', cut: 'legs', fabric: 'wool-worsted', color: OLIVE_GREEN, layer: 1, thickness: 0.0012, ease: 0.004, hem: 0.36, fitted: true }),
      g({ name: 'coat', cut: 'top', fabric: 'wool-worsted', color: OLIVE_GREEN, layer: 2, thickness: 0.0018, ease: 0.006, hem: -0.6, sleeves: 0.98, buttons: 5 }),
      g({ name: 'puttees', cut: 'leggings', fabric: 'cotton-duck', color: LIGHT_DRAB, layer: 2, thickness: 0.0015, ease: 0.002, top: 0.4 }),
      boots(LEATHER_BROWN, 0.16),
      g({ name: 'hat', cut: 'hat', fabric: 'felt', color: LIGHT_DRAB, layer: 0, thickness: 0.0025, ease: 0.003, crown: 4 * inch, brim: 3 * inch }),
    ],
    source:
      'Harmon, What Should Foresters Wear? (olive green worsted, sack style, 1909; gray flannel shirt; cavalry breeches); Tucker and Fitzpatrick ch. 7 (1910 light drab Stetson, 4 inch crown, 3 inch brim; puttee leggings)',
  },
  'ranger-1910-field': {
    role: 'US Forest Service ranger, denim work uniform',
    era: '1910-american-west',
    body: 'us1919Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'wool-flannel', color: BLUE_FLANNEL, layer: 0, thickness: 0.0012, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'trousers', cut: 'legs', fabric: 'cotton-denim', color: INDIGO_DENIM, layer: 1, thickness: 0.0009, ease: 0.006, hem: 0.03 }),
      g({ name: 'coat', cut: 'top', fabric: 'cotton-denim', color: INDIGO_DENIM, layer: 2, thickness: 0.0009, ease: 0.008, hem: 0.1, sleeves: 0.98, buttons: 4 }),
      boots(LEATHER_BROWN, 0.16),
      g({ name: 'hat', cut: 'hat', fabric: 'felt', color: LIGHT_DRAB, layer: 0, thickness: 0.0025, ease: 0.003, crown: 4 * inch, brim: 3 * inch }),
    ],
    source: 'Harmon (dark-denim army-style work uniform; blue flannel shirts of 1905); Tucker and Fitzpatrick ch. 7 (denim coat and trousers in the 1910 catalogue)',
  },
  'townsman-1910': {
    role: 'Townsman in a business sack suit',
    era: '1910-american-west',
    body: 'us1919Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'cotton-shirting', color: WHITE_COTTON, layer: 0, thickness: 0.0005, ease: 0.003, hem: 0.2, sleeves: 1, collar: 2.25 * inch, points: 0.875 * inch }),
      g({ name: 'trousers', cut: 'legs', fabric: 'wool-worsted', color: DARK_WORSTED, layer: 1, thickness: 0.0011, ease: 0.004, hem: 0.03 }),
      g({ name: 'tie', cut: 'tie', fabric: 'silk', color: BLACK_SILK, layer: 1.5, thickness: 0.0012, ease: 0.0008, knot: 'four-in-hand' }),
      g({ name: 'vest', cut: 'top', fabric: 'wool-worsted', color: DARK_WORSTED, layer: 2, thickness: 0.0011, ease: 0.003, hem: 0.95, buttons: 6, opening: 0.22 }),
      g({ name: 'coat', cut: 'top', fabric: 'wool-worsted', color: DARK_WORSTED, layer: 3, thickness: 0.0016, ease: 0.006, hem: 0, sleeves: 0.97, buttons: 4, opening: 0.42, lapel: 2.25 * inch, collar: 1.25 * inch }),
      boots(BLACK_WOOL, 0.13),
      g({ name: 'hat', cut: 'hat', fabric: 'felt', color: CHARCOAL, layer: 0, thickness: 0.0025, ease: 0.003, crown: 5.25 * inch, brim: 2 * inch, dome: 0.6 }),
    ],
    source:
      'Harmon (the business sack coat the ranger uniform was cut against, 1907); S. S. Gordon, The American Coat, Vest and Trousers System (1895): the single-breasted sack coat cut to a 30 inch length on a 17 inch natural waist (its hem near the crotch), 2 1/4 inch lapels, trousers to its seat-to-knee-to-bottom proportions; a high-cut waistcoat and a 2 1/4 inch standing shirt collar as the Wright brothers wear them in the Library of Congress photographs of 1903 to 1910 (Wilbur about 1905, LOC Prints and Photographs ppprs.00683: a high white collar and a dark tie under the coat lapels); the collar fronts turned into 7/8 inch points over a black silk four-in-hand (the knot of T. Fink and Y. Mao, "Designing tie knots by random walks", Nature 398, 31-32, 1999: Li Ro Li Co T); a stiff felt derby, its crown rounded over, 5 1/4 inches tall on a 2 inch brim (Vintage Dancer, the 1900s and 1910s hat styles of men, from the period catalogues: derby crowns 4 1/2 to 5 1/2 inches, brims about 2 inches), as the Wrights wear in town in the Library of Congress photographs',
  },
  'miner-1910': {
    role: 'Hard-rock miner',
    era: '1910-american-west',
    body: 'us1919Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'wool-flannel', color: GRAY_FLANNEL, layer: 0, thickness: 0.0012, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'overalls', cut: 'legs', fabric: 'cotton-denim', color: INDIGO_DENIM, layer: 1, thickness: 0.0009, ease: 0.008, hem: 0.03, bib: true }),
      boots(LEATHER_BROWN, 0.17),
      g({ name: 'hat', cut: 'hat', fabric: 'felt', color: CHARCOAL, layer: 0, thickness: 0.0025, ease: 0.003, crown: 0.09, brim: 0.035 }),
    ],
    source: "Levi Strauss & Co. (9 oz XX denim waist overalls); University of Northern Colorado, Colorado miners' clothing (heavy hobnailed leather boots)",
  },
  'logger-1910': {
    role: 'Logger',
    era: '1910-american-west',
    body: 'us1919Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'wool-flannel', color: BLUE_FLANNEL, layer: 0, thickness: 0.0014, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'trousers', cut: 'legs', fabric: 'cotton-duck', color: DUCK_TAN, layer: 1, thickness: 0.0012, ease: 0.006, hem: 0.2 }),
      boots(LEATHER_BROWN, 0.25),
      g({ name: 'hat', cut: 'hat', fabric: 'felt', color: CHARCOAL, layer: 0, thickness: 0.0025, ease: 0.003, crown: 0.1, brim: 0.05 }),
    ],
    source: "Filson, a 1925 Forest Service testimony listing logger's boots, water-repellent pants and woollen underwear (a weak secondary source)",
  },
  'railwayman-1910': {
    role: 'Railwayman',
    era: '1910-american-west',
    body: 'us1919Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'cotton-shirting', color: BLUE_FLANNEL, layer: 0, thickness: 0.0006, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'overalls', cut: 'legs', fabric: 'cotton-denim', color: INDIGO_DENIM, layer: 1, thickness: 0.0009, ease: 0.008, hem: 0.03, bib: true }),
      g({ name: 'jumper', cut: 'top', fabric: 'cotton-denim', color: INDIGO_DENIM, layer: 2, thickness: 0.0009, ease: 0.006, hem: 0.3, sleeves: 0.97, buttons: 4 }),
      boots(BLACK_WOOL, 0.15),
    ],
    source: 'Harmon (blue denim overalls and short blue denim jumpers, 1905 working dress); Levi Strauss & Co. (9 oz denim)',
  },
  'office-worker-2011': {
    role: 'Office worker, March 2011 (before Super Cool Biz began on 1 May)',
    era: '2011-coastal-japan',
    body: 'japan2003Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'cotton-shirting', color: WHITE_COTTON, layer: 0, thickness: 0.0004, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'trousers', cut: 'legs', fabric: 'wool-worsted', color: CHARCOAL, layer: 1, thickness: 0.0008, ease: 0.006, hem: 0.03 }),
      g({ name: 'jacket', cut: 'top', fabric: 'wool-worsted', color: CHARCOAL, layer: 2, thickness: 0.0014, ease: 0.006, hem: -0.5, sleeves: 0.97, buttons: 2 }),
      boots(BLACK_WOOL, 0.09),
    ],
    source: 'Japan Ministry of the Environment press 13775 (Super Cool Biz 2011 ran 1 May to 31 October, so March dress kept the jacket)',
  },
  'office-worker-2011-woman': {
    role: 'Office worker, March 2011',
    era: '2011-coastal-japan',
    body: 'japan2003Woman',
    garments: [
      g({ name: 'blouse', cut: 'top', fabric: 'cotton-shirting', color: WHITE_COTTON, layer: 0, thickness: 0.0004, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'skirt', cut: 'skirt', fabric: 'polyester-blend', color: CHARCOAL, layer: 1, thickness: 0.0008, ease: 0.004, hem: 0.42, flare: 0.1 }),
      g({ name: 'jacket', cut: 'top', fabric: 'polyester-blend', color: CHARCOAL, layer: 2, thickness: 0.0012, ease: 0.006, hem: 0.1, sleeves: 0.97, buttons: 2 }),
      boots(BLACK_WOOL, 0.08),
    ],
    source: 'Japan Ministry of the Environment press 13775',
  },
  'schoolboy-2011': {
    role: 'Schoolboy in a gakuran',
    era: '2011-coastal-japan',
    body: 'japan2003Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'cotton-shirting', color: WHITE_COTTON, layer: 0, thickness: 0.0004, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'trousers', cut: 'legs', fabric: 'polyester-blend', color: BLACK_WOOL, layer: 1, thickness: 0.0009, ease: 0.006, hem: 0.03 }),
      g({ name: 'gakuran', cut: 'top', fabric: 'polyester-blend', color: BLACK_WOOL, layer: 2, thickness: 0.0014, ease: 0.006, hem: 0, sleeves: 0.97, buttons: 5 }),
      boots(WHITE_COTTON, 0.08),
    ],
    source: "Boston Children's Museum Japanese House collection (gakuran trousers, wool blend); nippon.com, school uniform column",
  },
  'schoolgirl-2011': {
    role: 'Schoolgirl in a sailor uniform',
    era: '2011-coastal-japan',
    body: 'japan2003Woman',
    garments: [
      g({ name: 'sailor top', cut: 'top', fabric: 'polyester-blend', color: NAVY, layer: 0, thickness: 0.0009, ease: 0.006, hem: 0.3, sleeves: 0.97 }),
      g({ name: 'pleated skirt', cut: 'skirt', fabric: 'polyester-blend', color: NAVY, layer: 1, thickness: 0.0009, ease: 0.004, hem: 0.42, flare: 0.3 }),
      boots(BLACK_WOOL, 0.08),
    ],
    source: "Boston Children's Museum Japanese House collection records; nippon.com, school uniform column",
  },
  'fisherman-2011': {
    role: 'Coastal fisherman',
    era: '2011-coastal-japan',
    body: 'japan2003Man',
    garments: [
      g({ name: 'shirt', cut: 'top', fabric: 'cotton-shirting', color: GRAY_FLANNEL, layer: 0, thickness: 0.0006, ease: 0.003, hem: 0.2, sleeves: 1 }),
      g({ name: 'bib overalls', cut: 'legs', fabric: 'coated', color: COATED_NAVY, layer: 1, thickness: 0.0008, ease: 0.01, hem: 0.12, bib: true }),
      g({ name: 'rain jacket', cut: 'top', fabric: 'coated', color: COATED_ORANGE, layer: 2, thickness: 0.0008, ease: 0.01, hem: -0.2, sleeves: 0.95 }),
      g({ name: 'life jacket', cut: 'top', fabric: 'coated', color: COATED_ORANGE, layer: 3, thickness: 0.02, ease: 0.004, hem: 0.9 }),
      boots(RUBBER_BLACK, 0.36),
    ],
    optional: { names: ['life jacket'], chance: 0.3 },
    source: 'Fisheries Agency, life jacket guide for fishers (about 3 in 10 fishers wore one); rain gear and boots: no period source found (docs/limits.md)',
  },
} as const satisfies Record<string, Outfit>;
/** An outfit name. */
export type OutfitName = keyof typeof OUTFITS;
function checkOutfit(o: Outfit) {
  if (!o || !Array.isArray(o.garments) || !o.garments.length) throw new TypeError('An outfit needs garments; pass one of OUTFITS');
  for (const s of o.garments) {
    checkColor(s.color, `garment ${s.name} color`);
    if (!(s.thickness > 0) || !(s.ease >= 0)) throw new RangeError(`garment ${s.name} needs a thickness above 0 and an ease of 0 or more, metres`);
  }
}
/**
 * The material a garment is drawn with: woven cloth gets its microcylinder fit (`clothLobes`); coated, leather and felt
 * layers are plain glTF dielectrics with the given roughness (no measured data: the values are look defaults).
 */
export function garmentMaterial(spec: GarmentSpec): ClothLobes {
  if (spec.fabric === 'coated') return { baseColor: spec.color, roughness: 0.42, sheenColor: [0, 0, 0], sheenRoughness: 0, fitError: 0 };
  if (spec.fabric === 'leather') return { baseColor: spec.color, roughness: 0.55, sheenColor: [0, 0, 0], sheenRoughness: 0, fitError: 0 };
  if (spec.fabric === 'felt') return { baseColor: spec.color, roughness: 1, sheenColor: scaled(spec.color, 0.6), sheenRoughness: 0.8, fitError: 0 };
  return periodLobes(spec.fabric, spec.color);
}

/**
 * The outfit as one GLB (binary glTF 2.0): a mesh per garment named after it, each with its material (glTF base colour
 * and roughness, and `KHR_materials_sheen` in `extensionsUsed` only, so `loadGLTF` reads it and `install(model)` from
 * `@margoengine/materials` puts the sheen on). Lengths in metres, y up, the body facing +z.
 * @example
 * const model = await parseGLTFAsync(engine, outfitGLB(OUTFITS['ranger-1910']));
 * install(model); // the cloth sheen
 */
export function outfitGLB(outfit: Outfit, body: CastBody = BODIES[outfit.body]): Uint8Array {
  const garments = dress(body, outfit),
    chunks: Uint8Array[] = [],
    bufferViews: object[] = [],
    accessors: object[] = [],
    meshes: object[] = [],
    materials: object[] = [],
    nodes: object[] = [];
  let length = 0;
  const view = (data: Float32Array | Uint32Array, target: number) => {
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, target });
    length += data.byteLength;
    return bufferViews.length - 1;
  };
  for (const garment of garments) {
    const { positions, normals, uvs, indices } = garment.geometry,
      min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i++) {
      min[i % 3] = Math.min(min[i % 3], positions[i]);
      max[i % 3] = Math.max(max[i % 3], positions[i]);
    }
    const count = positions.length / 3,
      acc = (data: Float32Array | Uint32Array, type: string, target: number, extra = {}) => {
        accessors.push({ bufferView: view(data, target), componentType: data instanceof Float32Array ? 5126 : 5125, count: type === 'SCALAR' ? data.length : count, type, ...extra });
        return accessors.length - 1;
      };
    const lobes = garmentMaterial(garment.spec);
    materials.push({
      name: garment.spec.name,
      pbrMetallicRoughness: { baseColorFactor: [...lobes.baseColor, 1], metallicFactor: 0, roughnessFactor: lobes.roughness },
      // Hems show both faces of the cloth band.
      doubleSided: true,
      ...(lobes.sheenColor.some((c) => c > 0)
        ? { extensions: { KHR_materials_sheen: { sheenColorFactor: [...lobes.sheenColor], sheenRoughnessFactor: lobes.sheenRoughness } } }
        : {}),
    });
    meshes.push({
      name: garment.spec.name,
      primitives: [
        {
          attributes: {
            POSITION: acc(positions, 'VEC3', 34962, { min, max }),
            NORMAL: acc(normals, 'VEC3', 34962),
            TEXCOORD_0: acc(uvs, 'VEC2', 34962),
          },
          indices: acc(indices, 'SCALAR', 34963),
          material: materials.length - 1,
        },
      ],
    });
    nodes.push({ name: garment.spec.name, mesh: meshes.length - 1 });
  }
  const bin = new Uint8Array((length + 3) & ~3);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  const doc = {
    asset: { version: '2.0', generator: '@margoengine/humans/cast' },
    extensionsUsed: ['KHR_materials_sheen'],
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
  };
  const raw = new TextEncoder().encode(JSON.stringify(doc)),
    json = new Uint8Array((raw.length + 3) & ~3).fill(0x20);
  json.set(raw);
  const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length),
    dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, GLB_JSON, true);
  out.set(json, 20);
  dv.setUint32(20 + json.length, bin.length, true);
  dv.setUint32(24 + json.length, GLB_BIN, true);
  out.set(bin, 28 + json.length);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Crowds: outfit picks, dye-lot variation, and atlas regions for walkCrowd's `variants`.
// ---------------------------------------------------------------------------------------------------------------------

const hash = (n: number): number => {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
/** Options of {@link castCrowd}. */
export interface CastCrowdOptions {
  /** Outfit names with their share of the crowd (any positive weights). */
  readonly roles: Readonly<Partial<Record<OutfitName, number>>>;
  /** Seed of the picks. Default 1. */
  readonly seed?: number;
  /** Largest relative change of each dye colour between people (dye lots and wear), 0 to 0.5. Default 0.08. */
  readonly dyeSpread?: number;
}
/** One person of a cast crowd. */
export interface CastMember {
  readonly outfit: OutfitName;
  /** The outfit with this person's dye colours and optional garments decided. */
  readonly dressed: Outfit;
}
/**
 * Picks an outfit for each of `count` people by the given role shares, varies each dye a little per person, and decides
 * optional garments (a fisher's life jacket) by the outfit's chance. Deterministic for a seed.
 * @example
 * const cast = castCrowd(200, { roles: { 'ranger-1910': 1, 'miner-1910': 3, 'logger-1910': 4 } });
 */
export function castCrowd(count: number, options: CastCrowdOptions): CastMember[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('castCrowd count must be a whole number of people, 0 or more');
  const entries = Object.entries(options?.roles ?? {}) as [OutfitName, number][],
    seed = options.seed ?? 1,
    spread = options.dyeSpread ?? 0.08;
  if (!entries.length || entries.some(([name, w]) => !(name in OUTFITS) || !(w > 0) || !Number.isFinite(w)))
    throw new RangeError(`castCrowd roles must name outfits (${Object.keys(OUTFITS).join(', ')}) with weights above 0`);
  if (!(spread >= 0 && spread <= 0.5)) throw new RangeError('castCrowd dyeSpread must be from 0 to 0.5');
  const total = entries.reduce((s, [, w]) => s + w, 0),
    out: CastMember[] = [];
  for (let i = 0; i < count; i++) {
    let pick = hash(seed * 7919 + i) * total,
      name = entries[entries.length - 1][0];
    for (const [n, w] of entries) {
      if (pick < w) {
        name = n;
        break;
      }
      pick -= w;
    }
    const outfit: Outfit = OUTFITS[name],
      wear = outfit.optional && hash(seed * 104729 + i) < outfit.optional.chance;
    const garments = outfit.garments
      .filter((s) => !outfit.optional?.names.includes(s.name) || wear)
      .map((s, k) => {
        const f = 1 + spread * (2 * hash(seed * 15485863 + i * 64 + k) - 1);
        return { ...s, color: s.color.map((c) => Math.min(1, c * f)) as unknown as Rgb };
      });
    out.push({ outfit: name, dressed: { ...outfit, garments } });
  }
  return out;
}
/**
 * Atlas regions for `@margoengine/humans/crowd` walkCrowd's `variants`: one region per outfit name in a grid of
 * `columns`, repeated by weight so walkCrowd's even pick follows the role shares (weights rounded to whole repeats of
 * the smallest). Lay the outfits' textures out in the same grid order.
 * @example
 * const variants = castVariants({ 'ranger-1910': 1, 'miner-1910': 3 });
 * walkCrowd(crowd, people, { stride: 1.4, variants });
 */
export function castVariants(roles: Readonly<Partial<Record<OutfitName, number>>>, columns?: number): { offset: number[]; scale: number[] }[] {
  const entries = Object.entries(roles) as [OutfitName, number][];
  if (!entries.length || entries.some(([name, w]) => !(name in OUTFITS) || !(w > 0) || !Number.isFinite(w)))
    throw new RangeError('castVariants needs outfit names with weights above 0');
  const cols = columns ?? Math.ceil(Math.sqrt(entries.length)),
    rows = Math.ceil(entries.length / cols),
    least = Math.min(...entries.map(([, w]) => w)),
    out: { offset: number[]; scale: number[] }[] = [];
  entries.forEach(([, w], k) => {
    const region = { offset: [(k % cols) / cols, Math.floor(k / cols) / rows], scale: [1 / cols, 1 / rows] };
    for (let r = 0; r < Math.max(1, Math.round(w / least)); r++) out.push(region);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Slider rows on the shared shape (@margoengine/sky/settings is the model).
// ---------------------------------------------------------------------------------------------------------------------

/** Values by cast setting name. */
export type CastSettingValues = Readonly<Record<string, number | Rgb | string>>;
/** The cast's slider rows: the outfit, its body, one garment's cloth and colour, and the fit. All rebuild the garments. */
export const CAST_SETTINGS: readonly SettingRow[] = [
  choiceSetting('outfit', 'outfit', Object.keys(OUTFITS), 'The role and era of the outfit (OUTFITS).', false),
  choiceSetting('body', 'outfit', ['outfit', ...Object.keys(BODIES)], 'The body it is cut for: the outfit\'s own, or a measured body (BODIES).', false),
  numberSetting('garment', 'garment', 0, 0, 7, 1, '', 'Which garment of the outfit the rows below change, by its place in the outfit.', false),
  choiceSetting(
    'fabric',
    'garment',
    ['outfit', 'cotton-denim', 'cotton-duck', 'cotton-shirting', 'cotton-corduroy', 'wool-worsted', 'wool-flannel', 'polyester-blend', 'silk', 'coated', 'leather', 'felt'],
    'The cloth of that garment: the outfit\'s own, or a period fabric (periodFabric).',
    false,
  ),
  colorSetting('color', 'garment', [-1, -1, -1], -1, 1, 'Dye colour of that garment, linear RGB; -1 keeps the outfit\'s.', false),
  numberSetting('thickness', 'fit', 0, 0, 0.03, 0.0001, 'm', 'Cloth thickness of that garment; 0 keeps the outfit\'s.', false),
  numberSetting('ease', 'fit', -1, -1, 0.05, 0.0005, 'm', 'Gap to the layer beneath; -1 keeps the outfit\'s.', false),
  numberSetting('dyeSpread', 'crowd', 0.08, 0, 0.5, 0.01, '', 'Largest relative change of each dye between people in castCrowd.', false),
];
/** The row defaults. */
export const castSettingDefaults = (): Record<string, unknown> => settingDefaults(CAST_SETTINGS);
/**
 * The outfit and body the slider values describe: `values` (rows left out take their defaults) applied to the chosen
 * outfit. Pass the result to {@link dress} or {@link outfitGLB}.
 * @example
 * const { outfit, body } = applyCastSettings({ outfit: 'miner-1910', garment: 1, color: [0.05, 0.06, 0.1] });
 */
export function applyCastSettings(values: CastSettingValues): { outfit: Outfit; body: CastBody; dyeSpread: number } {
  checkSettings(CAST_SETTINGS, values as never, 'humans/cast', 'CAST_SETTINGS in @margoengine/humans/cast');
  const v: Record<string, unknown> = {};
  applySettings(CAST_SETTINGS, values as never, 'humans/cast', (row, value) => (v[row.name] = value));
  const base: Outfit = OUTFITS[v.outfit as OutfitName],
    k = v.garment as number;
  if (k >= base.garments.length) throw new RangeError(`outfit ${v.outfit} has ${base.garments.length} garments; pass garment 0 to ${base.garments.length - 1}`);
  const color = v.color as Rgb;
  const garments = base.garments.map((s, i) =>
    i !== k
      ? s
      : {
          ...s,
          ...(v.fabric !== 'outfit' ? { fabric: v.fabric as GarmentSpec['fabric'] } : {}),
          ...(color[0] >= 0 ? { color: color.map((c) => Math.max(0, c)) as unknown as Rgb } : {}),
          ...((v.thickness as number) > 0 ? { thickness: v.thickness as number } : {}),
          ...((v.ease as number) >= 0 ? { ease: v.ease as number } : {}),
        },
  );
  return { outfit: { ...base, garments }, body: BODIES[(v.body === 'outfit' ? base.body : v.body) as keyof typeof BODIES], dyeSpread: v.dyeSpread as number };
}
