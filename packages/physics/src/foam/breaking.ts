// Breaking waves from a sea's spectrum (SEA-13): the statistics of the breakers that ST4's dissipation describes, so the
// whitecaps, the foam and the spray come from the same breaking that takes the waves' energy (waves/st4.ts).
//
// From F. Leckler, F. Ardhuin, J.-F. Filipot and A. Mironov, "Dissipation source terms and whitecap statistics", Ocean
// Modelling 70, 62-74, 2013 (author draft read), and F. Ardhuin et al. 2010 (J. Phys. Oceanogr. 40, eqs. 12 to 17):
// - the directional saturation B'(k, theta) = integral over +-80 degrees of k^3 cos^2(theta - theta') F(k, theta') dtheta'
//   (eq. 2; the factor C_g / 2 pi of Ardhuin's eq. 12 is a misprint, Leckler's footnote 3), F the spectrum in wavenumber;
// - the breaking probability P_b = 28.4 max(sqrt(B') - sqrt(B_r), 0)^2, B_r = 0.0009 (eq. 4), with Ardhuin's depth
//   correction of B_r (his eq. 15);
// - the length of breaking crests per area per dk dtheta, Lambda(k, theta) = P_b / (2 pi^2) (eq. 5);
// - the whitecap coverage W = kappa integral of lambda Lambda, kappa = 0.30 for ST4 (eqs. 14 and 15), lambda = 2 pi / k.
// The active share of it, the crests still breaking, is 0.8 / 5 of the total: N. Reul and B. Chapron (J. Geophys. Res. 108,
// 2003, eq. 21) reproduce crest foam with a persistence of 0.8 T and all foam with 5 T. The surface Stokes drift is the
// textbook u_s = integral of 2 sigma k E(f, theta) cosh(2 k d) / (2 sinh^2(k d)) (cos, sin) df dtheta.
import { cos, exp as expOf, sin } from '@margoengine/math/pinned';
import type { WaveSpectrumSample } from '@margoengine/math/fields';
import { bandWidth, wavenumber } from '../waves/spectral.js';
import { foamError } from './errors.js';

/** ST4's saturation threshold B_r (TEST471). */
export const SATURATION_THRESHOLD = 0.0009;
/** Leckler et al.'s whitecap coefficient kappa for ST4. */
export const WHITECAP_COEFFICIENT = 0.3;
/** The share of the whitecap coverage still breaking: Reul and Chapron's 0.8 T against 5 T of persistence. */
export const ACTIVE_SHARE = 0.8 / 5;
/** The active breaking time of a crest in wave periods (Reul and Chapron, after Phillips et al. 2001). */
export const ACTIVE_PERIODS = 0.8;
/** A breaking crest's length as a share of its wavelength (Duncan 1981, as Reul and Chapron restate it). */
export const CREST_SHARE = 0.3;

const TWO_PI = 6.283185307179586;
const SECTOR = (80 * Math.PI) / 180;

/** What the breakers of a spectrum are like. */
export interface BreakingStatistics {
  /** The whitecap coverage, all foam, 0 to 1 (Leckler et al. eq. 15). */
  coverage: number;
  /** The share still breaking (crest foam), 0 to 1. */
  active: number;
  /** The total length of breaking crests per area, m/m^2. */
  crestLength: number;
  /** The share of the surface turned over by breakers each second, integral of c Lambda, 1/s. */
  turnover: number;
  /** The surface Stokes drift, m/s along x and z. */
  stokes: [number, number];
  /**
   * Breaking events per area per second in each (frequency, direction) bin, frequency-major as the spectrum: the crest
   * length there over each crest's length and its active time.
   */
  events: Float64Array;
  /** The wavenumber of each frequency, 1/m. */
  wavenumbers: Float64Array;
}

/** The breaking statistics of `spectrum` under gravity `g`. Writes into `out` when given (its arrays sized to it). */
export function breakingStatistics(
  spectrum: WaveSpectrumSample,
  g: number,
  out?: BreakingStatistics,
): BreakingStatistics {
  if (!spectrum || !(g > 0 && Number.isFinite(g)))
    throw foamError(
      'unsupported',
      'Breaking waves need a spectrum and finite positive gravity. Pass both to breakingStatistics.',
    );
  const { frequencies: fs, directions: ds, energy, depth } = spectrum;
  if (
    !(
      fs instanceof Float64Array &&
      ds instanceof Float64Array &&
      energy instanceof Float64Array &&
      fs.length > 0 &&
      ds.length > 0 &&
      energy.length === fs.length * ds.length &&
      (Number.isFinite(depth) || depth === Infinity)
    )
  )
    throw foamError(
      'unsupported',
      'Breaking-wave spectrum shape or depth is invalid. Use matching f64 bins and a valid depth.',
    );
  if (
    !fs.every((frequency, i) => frequency > 0 && Number.isFinite(frequency) && (i === 0 || frequency > fs[i - 1]!)) ||
    !ds.every(Number.isFinite) ||
    !energy.every((value) => value >= 0 && Number.isFinite(value))
  )
    throw foamError(
      'unsupported',
      'Breaking waves need increasing positive frequencies and finite energy and directions. Correct the spectrum bins.',
    );
  if (out && (out.events.length !== energy.length || out.wavenumbers.length !== fs.length))
    throw foamError(
      'unsupported',
      'The reused breaking statistics arrays do not fit the spectrum. Resize them or omit out.',
    );
  const nf = fs.length,
    nd = ds.length,
    dtheta = TWO_PI / nd,
    s = out ?? {
      coverage: 0,
      active: 0,
      crestLength: 0,
      turnover: 0,
      stokes: [0, 0],
      events: new Float64Array(nf * nd),
      wavenumbers: new Float64Array(nf),
    };
  s.coverage = s.active = s.crestLength = s.turnover = 0;
  s.stokes[0] = s.stokes[1] = 0;
  s.events.fill(0);
  if (!(depth > 0)) return s;
  // The saturation's weights over the +-80 degree sector, cos^2 of the difference.
  const span = Math.floor(SECTOR / dtheta + 1e-9),
    weight = new Float64Array(2 * span + 1);
  for (let m = -span; m <= span; m++) {
    const c = cos(m * dtheta);
    weight[m + span] = c * c * dtheta;
  }
  for (let i = 0; i < nf; i++) {
    const f = fs[i]!,
      sigma = TWO_PI * f,
      k = wavenumber(f, depth, g),
      df = bandWidth(fs, i);
    s.wavenumbers[i] = k;
    if (!(k > 0)) continue;
    const kd = k * depth,
      deep = !(kd < 20),
      tanh = deep ? 1 : tanhOf(kd),
      // c_g = (sigma / k) (1/2 + k d / sinh(2 k d)); F(k, theta) = E(f, theta) df/dk = E c_g / (2 pi).
      cg = (sigma / k) * (0.5 + (deep ? 0 : kd / sinhOf(2 * kd))),
      toK = cg / TWO_PI,
      // Ardhuin's depth correction of B_r: B_r Y (M4 Y^3 + M3 Y^2 + M2 Y + M1), Y = tanh(k d).
      threshold = deep
        ? SATURATION_THRESHOLD
        : SATURATION_THRESHOLD * tanh * (1.3286 * tanh * tanh * tanh - 2.5709 * tanh * tanh + 1.9995 * tanh + 0.2428),
      root = Math.sqrt(threshold),
      c = sigma / k,
      lambda = TWO_PI / k,
      period = 1 / f,
      // The Stokes drift's depth factor cosh(2kd) / (2 sinh^2 kd), 1 in deep water.
      drift = deep ? 1 : coshOf(2 * kd) / (2 * sinhOf(kd) * sinhOf(kd)),
      dk = df / toK;
    for (let j = 0; j < nd; j++) {
      let saturation = 0;
      for (let m = -span; m <= span; m++) saturation += weight[m + span]! * energy[i * nd + ((j + m + nd) % nd)]!;
      saturation *= k * k * k * toK;
      const excess = Math.sqrt(saturation) - root,
        probability = excess > 0 ? 28.4 * excess * excess : 0,
        crest = probability / (2 * Math.PI * Math.PI),
        e = energy[i * nd + j]!;
      // Lambda dk dtheta of this bin, and its moments.
      const length = crest * dk * dtheta;
      s.crestLength += length;
      s.turnover += c * length;
      s.coverage += WHITECAP_COEFFICIENT * lambda * length;
      s.events[i * nd + j] = length / (CREST_SHARE * lambda * ACTIVE_PERIODS * period);
      const u = 2 * sigma * k * e * df * dtheta * drift;
      s.stokes[0] += u * cos(ds[j]!);
      s.stokes[1] += u * sin(ds[j]!);
    }
  }
  if (
    !(
      Number.isFinite(s.coverage) &&
      Number.isFinite(s.turnover) &&
      Number.isFinite(s.crestLength) &&
      s.stokes.every(Number.isFinite)
    ) ||
    !s.wavenumbers.every(Number.isFinite) ||
    !s.events.every(Number.isFinite)
  )
    throw foamError(
      'failed',
      'Breaking statistics exceed numeric range. Reduce wave energy, use finite wet depth and rescale frequencies.',
    );
  if (s.coverage > 1) s.coverage = 1;
  s.active = ACTIVE_SHARE * s.coverage;
  return s;
}

function sinhOf(x: number): number {
  const e = expOf(x);
  return (e - 1 / e) / 2;
}
function coshOf(x: number): number {
  const e = expOf(x);
  return (e + 1 / e) / 2;
}
function tanhOf(x: number): number {
  const e = expOf(2 * x);
  return (e - 1) / (e + 1);
}
