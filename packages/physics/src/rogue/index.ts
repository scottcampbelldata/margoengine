// Nonlinear and rogue waves (SEA-03 of docs/physics-solvers.md): the sea a spectrum describes, to second order, with its
// rogue waves. From a directional spectrum (a `WaveSolver`'s, or any `WaveSpectrumField`'s) the sea is a finite set of
// components with phases from the world's counter-based random numbers; its surface is their linear sum plus the bound
// second-order waves every pair makes, so crests are sharper and higher than troughs are deep, as real storm seas are. Its
// statistics (kurtosis, the chance of a rogue, the expected largest wave) are the closed forms the ECMWF wave model forecasts
// freak waves with, and its rogue waves are real events: the extra rogues that four-wave (Benjamin-Feir) focusing makes
// beyond the second-order sea's own, drawn at the rate the statistics give and shaped as the most likely extreme wave in a
// random sea, a constrained NewWave, so the sea around a rogue stays the sea. It is a `SeaSurface`: hulls, floating bodies,
// swimmers and spray read its surface, slope, orbital motion and pressure as they read any sea's.
//
// Written from (papers and public documentation only; no code read):
// - Second order: the finite-depth sum and difference kernels of J. F. Dalzell, "A note on finite depth second-order
//   wave-wave interactions", Applied Ocean Research 21, 1999, as T. A. A. Adcock and S. Draper restate them ("The second order
//   contribution to wave crest amplitude: random simulations and NewWave", Proc. 25th ISOPE, 2015, appendix, read), each
//   unordered pair counted once and a component with itself at half weight, so a single component gives Stokes's (1/2) k a^2
//   cos 2 psi; a component's difference term with itself set to 0 (Adcock and Draper; A. Alberello et al., Coastal Engineering
//   110, 2016, arXiv:1510.01535).
// - Statistics: the ECMWF IFS documentation Cy50r1, Part VII, chapter 8 (read): BFI^2 = 2 eps^2 / delta_omega^2 with eps =
//   k_bar sqrt(m0), delta_omega = 1 / (Q_p sqrt(pi)) from Goda's peakedness, R = delta_theta^2 / (2 nu^2), the dynamic kurtosis
//   C4_dyn = J(R) BFI^2 with J's fit, the bound part 6 eps^2 (P. A. E. M. Janssen, J. Phys. Oceanogr. 33, 2003, as restated);
//   the height exceedance P(H) = e^(-2 H^2) (1 + C4 2 H^2 (H^2 - 1)) (N. Mori and P. A. E. M. Janssen, J. Phys. Oceanogr. 36,
//   2006, as restated); the crest exceedance of M. A. Tayfun and F. Fedele (Ocean Engineering 34, 2007, as F. Fedele, C.
//   Lugni and A. Chawla restate it, Sci. Rep. 7, 2017, arXiv:1703.08161): P(xi) = exp(-8 xi0^2) (1 + Lambda xi0^2 (4 xi0^2 -
//   1)), xi = xi0 + 2 mu xi0^2, mu = lambda_3 / 3, Lambda = 8 C4, and the narrowband bound kurtosis lambda_40 = 2 lambda_3^2.
// - Rogue events: a constrained NewWave (P. S. Tromans, A. R. Anaturk and P. Hagemeijer 1991, as Adcock and Draper restate
//   it; its constrained form after P. H. Taylor, P. Jonathan and L. A. Harland 1997, derived here and held by the tests): the
//   field plus (A - eta(0)) rho + eta'(0) (m0 / m2) rho' about the event, rho the field's normalised space-time autocovariance, so a crest of height A stands at the event's place and time;
//   the second order then acts on the whole constrained field. A rogue: a crest above 1.25 H_s (M. Christou and K. Ewans, J.
//   Phys. Oceanogr. 44, 2014).
// - Kinematics: linear theory under Wheeler's stretching (J. D. Wheeler, J. Petroleum Technology 22, 1970, as the offshore
//   literature restates it): the velocity at height y under a surface eta is linear theory's at (y - eta) d / (d + eta), in
//   deep water y - eta, so the crest carries the still level's velocity and no exponential runs away above it.
import type {
  FlowCell,
  FlowField,
  FlowSample,
  SeaSurface,
  SeaSurfaceSample,
  SeaWater,
  WaveSpectrumField,
  WaveSpectrumSample,
} from '@margoengine/math/fields';
import { DEFAULT_GRAVITY, gravityMagnitude } from '@margoengine/math/gravity';
import { cos, exp, ln, sin } from '@margoengine/math/pinned';
import { RandomStream, solverNumber } from '@margoengine/math/random';
import { bandWidth, wavenumber } from '../waves/spectral.js';

const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;
const SQRT_PI = 1.772453850905516;
const ROOT3 = 1.7320508075688772;
/** A crest above this share of H_s is a rogue (Christou and Ewans 2014). */
export const ROGUE_CREST = 1.25;

/** A sea's nonlinear statistics, from its spectrum (deep-water closed forms). */
export interface SeaStatistics {
  /** Significant wave height 4 sqrt(m0), m. */
  significantHeight: number;
  /** Peak period, s. */
  peakPeriod: number;
  /** Mean zero-crossing period 2 pi sqrt(m0 / m2), s. */
  zeroCrossingPeriod: number;
  /** Steepness eps = k_bar sqrt(m0). */
  steepness: number;
  /** The Benjamin-Feir index sqrt(2) eps / delta_omega. */
  benjaminFeir: number;
  /** R = delta_theta^2 / (2 nu^2): how directional the sea is against how broad (0 for long-crested). */
  directionality: number;
  /** Kurtosis share C4 = <eta^4> / (3 <eta^2>^2) - 1: dynamic plus bound. */
  kurtosis: number;
  /** The dynamic (four-wave, Benjamin-Feir) part of C4: J(R) BFI^2. */
  dynamicKurtosis: number;
  /** Skewness <eta^3> / <eta^2>^1.5 of the surface. */
  skewness: number;
  /** The chance a wave's crest passes {@link ROGUE_CREST} H_s. */
  rogueCrestChance: number;
  /** The chance a wave's height passes 2 H_s. */
  rogueHeightChance: number;
}

/** A rogue wave to place: a crest of `crest` m at `position` [x, z] m at `time` s. */
export interface RogueEvent {
  readonly position: readonly [number, number];
  readonly time: number;
  readonly crest: number;
}

/** Where and when to draw rogue waves: the region from `min` to `max` [x, z] m over the times `from` to `to` s. */
export interface RogueRegion {
  readonly min?: readonly [number, number];
  readonly max?: readonly [number, number];
  /** Default 0 s. */
  readonly from?: number;
  /** Default an hour after `from`. */
  readonly to?: number;
}

/** What a {@link NonlinearSea} is made from. */
export interface NonlinearSeaOptions {
  /** The sea: a spectrum, or a field (a `WaveSolver`'s `field`) sampled at `at`. */
  readonly spectrum?: WaveSpectrumSample;
  readonly waves?: WaveSpectrumField;
  /** Where to sample `waves`, and the middle of the default rogue region, [x, z] m (default [0, 0]). */
  readonly at?: readonly [number, number];
  /** Components drawn from the spectrum (default 160; the cost of a point goes with its square). */
  readonly components?: number;
  /** The highest frequency kept, a multiple of the peak (default 3; Adcock and Draper's 2.5 to Forristall's 4 or 5). */
  readonly cutoff?: number;
  /** Seed of the phases and the rogue events (default 0). */
  readonly seed?: number;
  /**
   * The rogue waves beyond the second-order sea's own: drawn over a region at the rate the statistics give (default the 2
   * km square about `at` over the first hour), `false` for none, or a list of crests to place.
   */
  readonly rogues?: false | RogueRegion | readonly RogueEvent[];
  /** Gravity's magnitude, m/s^2 (default the engine's). */
  readonly gravity?: number;
  /** A current under the waves, added to their motion (default none; the waves are not Doppler-shifted by it). */
  readonly current?: FlowField;
  /** The water's temperature, K, where no current gives one (default 288.15). */
  readonly temperature?: number;
}

/** The sea a spectrum describes, to second order, with its rogue waves: elevation, kinematics and statistics. */
export class NonlinearSea implements SeaSurface {
  /** The sea's statistics. */
  readonly statistics: SeaStatistics;
  /** The water's depth, m (Infinity for deep water). */
  readonly depth: number;
  /** The rogue waves placed or drawn, in time order. */
  readonly rogues: readonly RogueEvent[];
  /** The origin cell positions are offsets from (the wave field's; [0, 0, 0] for a spectrum). */
  readonly cell: FlowCell;
  /** Density of the water, kg/m^3 (the spectrum's). */
  readonly density: number;
  /** The water below the surface, the same waves and current (the {@link SeaWater} contract). */
  readonly water: SeaWater;
  private readonly current: FlowField | undefined;
  private readonly temperature: number;
  private readonly flow: FlowSample = { velocity: [0, 0, 0], density: 0, temperature: 0 };
  private readonly g: number;
  private readonly n: number;
  private readonly omega: Float64Array;
  private readonly kx: Float64Array;
  private readonly kz: Float64Array;
  private readonly k: Float64Array;
  /** Each component's cos and sin amplitudes: eta_1 = sum re cos(phi) + im sin(phi), phi = k.x - w t. */
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  /** Each rogue event's added amplitudes per component, applied under its window. */
  private readonly eventRe: Float64Array[] = [];
  private readonly eventIm: Float64Array[] = [];
  /** A rogue event's window: half its length in time, s, and its radius on the water, m. */
  private readonly span: number;
  private readonly reach: number;
  private readonly localRe: Float64Array;
  private readonly localIm: Float64Array;
  /** Dalzell's kernels per unordered pair (i <= j), upper triangle row by row. */
  private readonly bp: Float64Array;
  private readonly bm: Float64Array;
  private readonly m0: number;
  private readonly cr: Float64Array;
  private readonly ci: Float64Array;

  /** @throws TypeError without a spectrum; RangeError for a sea without energy or settings out of range. */
  constructor(options: NonlinearSeaOptions) {
    const { components = 160, cutoff = 3, seed = 0, at = [0, 0] } = options ?? {};
    const spectrum = options?.spectrum ?? options?.waves?.sample(at[0], at[1]);
    if (!spectrum?.frequencies || !spectrum.energy)
      throw new TypeError('A nonlinear sea comes from a spectrum: pass {spectrum} or {waves} (a WaveSolver.field).');
    if (!(Number.isInteger(components) && components >= 1 && components <= 4096))
      throw new RangeError(
        `A nonlinear sea has 1 to 4096 components (got ${components}); pass a whole number, or 160.`,
      );
    if (!(cutoff > 1 && cutoff <= 10))
      throw new RangeError(
        `The cutoff is above 1 and at most 10 times the peak frequency (got ${cutoff}); pass one, or 3.`,
      );
    if (!(Number.isInteger(seed) && seed >= 0 && seed < 4294967296))
      throw new RangeError(`A seed is a whole number from 0 to 4294967295 (got ${seed}); pass one.`);
    const g = options.gravity ?? gravityMagnitude(DEFAULT_GRAVITY);
    if (!(g > 0)) throw new RangeError(`Gravity's magnitude is above 0 (got ${g}); pass one, or leave it out.`);
    const { current, temperature = 288.15 } = options;
    if (current !== undefined && typeof current?.sample !== 'function')
      throw new TypeError("A sea's current is a flow field of water with sample(x, y, z, t); pass one or none.");
    if (!(temperature > 0 && Number.isFinite(temperature)))
      throw new RangeError(
        `A water temperature is finite kelvin above 0 (got ${temperature}); pass kelvin such as 288.15.`,
      );
    this.current = current;
    this.temperature = temperature;
    this.cell = options.waves?.cell ?? [0, 0, 0];
    this.density = spectrum.density > 0 ? spectrum.density : 1025;
    const sea = this;
    this.water = { medium: 'water', cell: this.cell, sample: (x, y, z, t, out) => sea.below(x, y, z, t, out) };
    this.g = g;
    this.depth = spectrum.depth > 0 && spectrum.depth < 1e6 ? spectrum.depth : Number.POSITIVE_INFINITY;
    const { frequencies: fs, directions: ds, energy } = spectrum,
      nf = fs.length,
      nd = ds.length,
      dtheta = TWO_PI / nd,
      // The frequency marginal and the peak.
      marginal = new Float64Array(nf);
    let peak = 0;
    for (let i = 0; i < nf; i++) {
      for (let j = 0; j < nd; j++) marginal[i]! += energy[i * nd + j]! * dtheta;
      if (marginal[i]! > marginal[peak]!) peak = i;
    }
    if (!(marginal[peak]! > 0)) throw new RangeError('This spectrum carries no energy; pass a sea with waves.');
    const top = cutoff * fs[peak]!,
      // The kept variance per frequency bin, and in all.
      share = new Float64Array(nf);
    let total = 0;
    for (let i = 0; i < nf; i++) {
      if (fs[i]! > top) continue;
      share[i] = marginal[i]! * bandWidth(fs, i);
      total += share[i]!;
    }
    const n = components;
    this.n = n;
    this.omega = new Float64Array(n);
    this.kx = new Float64Array(n);
    this.kz = new Float64Array(n);
    this.k = new Float64Array(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.cr = new Float64Array(n);
    this.ci = new Float64Array(n);
    const random = new RandomStream(seed, solverNumber('rogue')),
      draw: [number, number] = [0, 0],
      amplitude = Math.sqrt((2 * total) / n);
    // Equal variance: component m takes the m-th n-th of the kept variance, at a stratified random quantile; its frequency
    // inverts the frequency marginal (linear within the bin), its direction the bin's directional distribution (uniform
    // within the direction bin), and its phase is uniform.
    let bin = 0,
      below = 0;
    while (!(share[bin]! > 0)) bin++;
    for (let m = 0; m < n; m++) {
      random.unitF64(0, m, 0, draw);
      const target = ((m + draw[0]) / n) * total;
      while (below + share[bin]! < target && bin < nf - 1) {
        below += share[bin]!;
        bin++;
        while (!(share[bin]! > 0) && bin < nf - 1) bin++;
      }
      const width = bandWidth(fs, bin),
        lower = bin > 0 ? (fs[bin]! + fs[bin - 1]!) / 2 : fs[bin]! - width / 2,
        within = Math.min(1, Math.max(0, (target - below) / share[bin]!)),
        f = lower + within * width;
      let directionTotal = 0;
      for (let j = 0; j < nd; j++) directionTotal += energy[bin * nd + j]!;
      let pick = draw[1] * directionTotal,
        j = 0;
      while (j < nd - 1 && pick >= energy[bin * nd + j]!) pick -= energy[bin * nd + j++]!;
      random.unitF64(1, m, 0, draw);
      const theta = ds[j]! + (draw[0] - 0.5) * dtheta,
        phase = TWO_PI * draw[1],
        kk = wavenumber(f, this.depth, g);
      this.omega[m] = TWO_PI * f;
      this.k[m] = kk;
      this.kx[m] = kk * cos(theta);
      this.kz[m] = kk * sin(theta);
      this.re[m] = amplitude * cos(phase);
      this.im[m] = amplitude * sin(phase);
    }
    this.m0 = total;
    this.localRe = new Float64Array(n);
    this.localIm = new Float64Array(n);
    this.bp = new Float64Array((n * (n + 1)) / 2);
    this.bm = new Float64Array((n * (n + 1)) / 2);
    let p = 0;
    for (let i = 0; i < n; i++)
      for (let j = i; j < n; j++) {
        const w1 = this.omega[i]!,
          w2 = this.omega[j]!,
          x1 = this.kx[i]!,
          z1 = this.kz[i]!,
          x2 = this.kx[j]!,
          z2 = this.kz[j]!;
        if (i === j) {
          this.bp[p] = kernel(1, w1, x1, z1, w2, x2, z2, this.depth, g) / 2;
          this.bm[p] = 0;
        } else {
          this.bp[p] = kernel(1, w1, x1, z1, w2, x2, z2, this.depth, g);
          this.bm[p] = kernel(-1, w1, x1, z1, w2, x2, z2, this.depth, g);
        }
        p++;
      }
    this.statistics = seaStatistics(spectrum, { gravity: g, cutoff });
    // A rogue grows and fades within 8 zero-crossing periods, its group gathering from 8 zero-crossing wavelengths about
    // (the group at the edge of the window, cg 8 Tz away, is inside it).
    const tz = this.statistics.zeroCrossingPeriod;
    this.span = 8 * tz;
    this.reach = (8 * g * tz * tz) / TWO_PI;
    this.rogues = this.placeRogues(options.rogues, at, seed);
    if (this.rogues.length) this.constrain(this.rogues);
  }

  /**
   * A rogue event's window at (x, z, t) and its time slope: (1 - r^2)^2 inside r < 1, r^2 = |X - X_e|^2 / reach^2 + (t -
   * t_e)^2 / span^2, so its event stands at full height and the sea about is untouched.
   */
  private window(e: number, x: number, z: number, t: number, out: [number, number]): [number, number] {
    const event = this.rogues[e]!,
      dx = (x - event.position[0]) / this.reach,
      dz = (z - event.position[1]) / this.reach,
      dt = t - event.time,
      r2 = dx * dx + dz * dz + (dt * dt) / (this.span * this.span);
    if (!(r2 < 1)) {
      out[0] = 0;
      out[1] = 0;
    } else {
      out[0] = (1 - r2) * (1 - r2);
      out[1] = (-4 * (1 - r2) * dt) / (this.span * this.span);
    }
    return out;
  }

  /**
   * The components' values at (x, z, t) into cr (each one's elevation) and ci (its quadrature), each component's amplitude
   * the sea's plus every rogue event's under its window there: amplitudes that vary over many wavelengths, so the bound
   * waves of the pair sum ride on the local envelope.
   */
  private evaluate(x: number, z: number, t: number): void {
    const { n, cr, ci } = this;
    let re = this.re,
      im = this.im;
    const weight: [number, number] = [0, 0];
    for (let e = 0; e < this.eventRe.length; e++) {
      const w = this.window(e, x, z, t, weight)[0];
      if (w === 0) continue;
      if (re === this.re) {
        this.localRe.set(this.re);
        this.localIm.set(this.im);
        re = this.localRe;
        im = this.localIm;
      }
      const er = this.eventRe[e]!,
        ei = this.eventIm[e]!;
      for (let m = 0; m < n; m++) {
        re[m]! += w * er[m]!;
        im[m]! += w * ei[m]!;
      }
    }
    for (let m = 0; m < n; m++) {
      const phase = this.kx[m]! * x + this.kz[m]! * z - this.omega[m]! * t,
        c = cos(phase),
        s = sin(phase);
      cr[m] = re[m]! * c + im[m]! * s;
      ci[m] = re[m]! * s - im[m]! * c;
    }
  }

  /** The linear (first-order) surface at (x, z) at time t, m. */
  linearElevation(x: number, z: number, t: number): number {
    this.evaluate(x, z, t);
    let eta = 0;
    for (let m = 0; m < this.n; m++) eta += this.cr[m]!;
    return eta;
  }

  /** The surface elevation at (x, z) at time t, m: linear plus the second-order sum and difference waves, rogues included. */
  elevation(x: number, z: number, t: number): number {
    this.evaluate(x, z, t);
    // a_i a_j cos(psi_i + psi_j) = r_i r_j - q_i q_j; a_i a_j cos(psi_i - psi_j) = r_i r_j + q_i q_j.
    return this.height();
  }

  /** The surface's slope (d eta / dx, d eta / dz) at (x, z, t), linear and second order, from the last `evaluate`. */
  private slope(): [number, number] {
    const { n, cr, ci, bp, bm, kx, kz } = this;
    let sx = 0,
      sz = 0,
      p = 0;
    for (let i = 0; i < n; i++) {
      const ri = cr[i]!,
        qi = ci[i]!,
        xi = kx[i]!,
        zi = kz[i]!;
      // d r / dx = -k_x q, d q / dx = k_x r.
      sx -= xi * qi;
      sz -= zi * qi;
      for (let j = i; j < n; j++, p++) {
        const rj = cr[j]!,
          qj = ci[j]!,
          both = qi * rj + ri * qj,
          cross = ri * qj - qi * rj;
        sx += -bp[p]! * (xi + kx[j]!) * both + bm[p]! * (xi - kx[j]!) * cross;
        sz += -bp[p]! * (zi + kz[j]!) * both + bm[p]! * (zi - kz[j]!) * cross;
      }
    }
    return [sx, sz];
  }

  /** The second-order surface from the last `evaluate`. */
  private height(): number {
    const { n, cr, ci, bp, bm } = this;
    let eta = 0,
      p = 0;
    for (let i = 0; i < n; i++) {
      const ri = cr[i]!,
        qi = ci[i]!;
      eta += ri;
      for (let j = i; j < n; j++, p++) {
        const rr = ri * cr[j]!,
          qq = qi * ci[j]!;
        eta += bp[p]! * (rr - qq) + bm[p]! * (rr + qq);
      }
    }
    return eta;
  }

  /**
   * The waves' depth factors at stretched height y (at most 0) for wavenumber k: cosh(k (y + d)) / sinh(k d) and sinh(k (y +
   * d)) / sinh(k d), and cosh(k (y + d)) / cosh(k d) for the pressure, written with decaying exponentials only (e^(k y) in
   * deep water).
   */
  private factors(k: number, y: number, out: [number, number, number]): [number, number, number] {
    const rise = exp(k * y);
    if (!(this.depth < 1e6)) {
      out[0] = out[1] = out[2] = rise;
      return out;
    }
    const fall = exp(-k * (y + 2 * this.depth)),
      far = exp(-2 * k * this.depth);
    out[0] = (rise + fall) / (1 - far);
    out[1] = (rise - fall) / (1 - far);
    out[2] = (rise + fall) / (1 + far);
    return out;
  }

  /**
   * The waves' velocity [u, v, w] at (x, y, z) at time t, m/s, y up from the still level, the current aside: linear theory
   * under Wheeler's stretching of the second-order surface, so the crest carries the still level's velocity. 0 above the
   * surface and below the bed.
   */
  velocity(x: number, y: number, z: number, t: number): [number, number, number] {
    this.evaluate(x, z, t);
    const out: [number, number, number] = [0, 0, 0];
    this.orbital(y, this.height(), out);
    return out;
  }

  /** The orbital velocity at height y under a surface `surface` from the last `evaluate`, into `out`. */
  private orbital(y: number, surface: number, out: [number, number, number]): void {
    const { n, cr, ci } = this,
      d = this.depth;
    out[0] = out[1] = out[2] = 0;
    if (y > surface || (d < 1e6 && y < -d)) return;
    const stretched = d < 1e6 ? ((y - surface) * d) / (d + surface) : y - surface,
      f: [number, number, number] = [0, 0, 0];
    for (let m = 0; m < n; m++) {
      const kk = this.k[m]!,
        w = this.omega[m]!;
      this.factors(kk, stretched, f);
      const horizontal = (w * f[0] * cr[m]!) / kk;
      out[0] += horizontal * this.kx[m]!;
      out[2] += horizontal * this.kz[m]!;
      out[1] += w * f[1] * ci[m]!;
    }
  }

  /** The surface at (x, z) m from the sea's cell at time `t` s (the {@link SeaSurface} contract). */
  sample(x: number, z: number, t: number, out?: SeaSurfaceSample): SeaSurfaceSample {
    const s = out ?? { height: 0, normal: [0, 1, 0], velocity: [0, 0, 0], current: [0, 0, 0], depth: 0, density: 0 };
    this.evaluate(x, z, t);
    const h = this.height(),
      [dx, dz] = this.slope(),
      length = Math.sqrt(dx * dx + 1 + dz * dz);
    this.orbital(h, h, s.velocity);
    s.height = h;
    s.normal[0] = -dx / length;
    s.normal[1] = 1 / length;
    s.normal[2] = -dz / length;
    this.currentAt(x, h, z, t, s.current);
    s.velocity[0] += s.current[0];
    s.velocity[1] += s.current[1];
    s.velocity[2] += s.current[2];
    s.depth = this.depth;
    s.density = this.density;
    return s;
  }

  /** The water at (x, y, z) at time t: the waves' orbital velocity plus the current; none above the surface or below the bed. */
  private below(x: number, y: number, z: number, t: number, out?: FlowSample): FlowSample {
    const s = out ?? { velocity: [0, 0, 0], density: 0, temperature: 0 },
      d = this.depth;
    this.evaluate(x, z, t);
    const h = this.height();
    s.temperature = this.temperature;
    if (y > h || (d < 1e6 && y < -d)) {
      s.velocity[0] = s.velocity[1] = s.velocity[2] = 0;
      s.density = 0;
      return s;
    }
    this.orbital(y, h, s.velocity);
    if (this.current) {
      const c = this.current.sample(x, y, z, t, this.flow);
      s.velocity[0] += c.velocity[0];
      s.velocity[1] += c.velocity[1];
      s.velocity[2] += c.velocity[2];
      s.temperature = c.temperature;
    }
    s.density = this.density;
    return s;
  }

  private currentAt(x: number, y: number, z: number, t: number, into: [number, number, number]): void {
    if (!this.current) {
      into[0] = into[1] = into[2] = 0;
      return;
    }
    const c = this.current.sample(x, y, z, t, this.flow);
    into[0] = c.velocity[0];
    into[1] = c.velocity[1];
    into[2] = c.velocity[2];
  }

  /**
   * Gauge pressure at (x, y, z) at time t, Pa: rho g (head - y), the head linear theory's dynamic head under Wheeler's
   * stretching plus the second order's rise taken as hydrostatic, so it is 0 at the surface; 0 above it.
   */
  pressure(x: number, y: number, z: number, t: number): number {
    this.evaluate(x, z, t);
    const h = this.height();
    if (!(y < h)) return 0;
    const d = this.depth,
      stretched = d < 1e6 ? ((y - h) * d) / (d + h) : y - h,
      f: [number, number, number] = [0, 0, 0];
    let head = 0,
      linear = 0;
    for (let m = 0; m < this.n; m++) {
      this.factors(this.k[m]!, stretched, f);
      head += f[2] * this.cr[m]!;
      linear += this.cr[m]!;
    }
    return this.density * this.g * (head + (h - linear) - y);
  }

  /** The variance of the components' surface before the rogue events, m^2 (the kept spectrum's m0). */
  get variance(): number {
    return this.m0;
  }

  /** Places the rogue events: given, or drawn over a region at the excess rate, each as a constrained NewWave. */
  private placeRogues(
    rogues: NonlinearSeaOptions['rogues'],
    at: readonly [number, number],
    seed: number,
  ): RogueEvent[] {
    if (rogues === false) return [];
    let list: RogueEvent[];
    if (Array.isArray(rogues)) {
      list = (rogues as readonly RogueEvent[]).map((r) => {
        if (
          !(
            r?.position?.length === 2 &&
            Number.isFinite(r.position[0]) &&
            Number.isFinite(r.position[1]) &&
            Number.isFinite(r.time) &&
            r.crest > 0 &&
            Number.isFinite(r.crest)
          )
        )
          throw new RangeError(
            'A rogue wave is {position: [x, z], time, crest} with a crest in metres above 0; pass one.',
          );
        return { position: [r.position[0], r.position[1]] as const, time: r.time, crest: r.crest };
      });
    } else {
      const region = (rogues ?? {}) as RogueRegion,
        min = region.min ?? [at[0] - 1000, at[1] - 1000],
        max = region.max ?? [at[0] + 1000, at[1] + 1000],
        from = region.from ?? 0,
        to = region.to ?? from + 3600;
      if (!(min[0] < max[0] && min[1] < max[1] && from < to && Number.isFinite(to - from)))
        throw new RangeError(
          'A rogue region is {min: [x, z], max: [x, z], from, to} with min below max and from before to; pass them.',
        );
      list = this.draw(min, max, from, to, seed);
    }
    list.sort((a, b) => a.time - b.time);
    return list;
  }

  /**
   * The rogue waves four-wave focusing adds beyond the second-order sea's own: a Poisson count at the rate of one wave per
   * zero-crossing wavelength squared per zero-crossing period, times the chance a crest passes 1.25 H_s with the full
   * kurtosis less the chance with the bound kurtosis alone (none where focusing adds nothing); each at a uniform place and
   * time, its crest from the full crest law's tail above 1.25 H_s.
   */
  private draw(
    min: readonly [number, number],
    max: readonly [number, number],
    from: number,
    to: number,
    seed: number,
  ): RogueEvent[] {
    const s = this.statistics,
      out: RogueEvent[] = [],
      excess =
        s.rogueCrestChance -
        crestChance(ROGUE_CREST, { kurtosis: s.kurtosis - s.dynamicKurtosis, skewness: s.skewness });
    if (!(excess > 0)) return out;
    const wavelength = (this.g * s.zeroCrossingPeriod * s.zeroCrossingPeriod) / TWO_PI,
      waves =
        (((max[0] - min[0]) * (max[1] - min[1])) / (wavelength * wavelength)) * ((to - from) / s.zeroCrossingPeriod),
      mean = waves * excess,
      random = new RandomStream(seed, solverNumber('rogue events')),
      draw: [number, number] = [0, 0];
    random.unitF64(0, 0, 0, draw);
    // Poisson by inversion, in logs so a large mean does not underflow.
    const lnMean = ln(mean);
    let count = 0,
      logP = -mean,
      sum = exp(logP);
    while (draw[0] > sum && count < 10000) {
      count++;
      logP += lnMean - ln(count);
      sum += exp(logP);
    }
    for (let e = 0; e < count; e++) {
      random.unitF64(1, e, 0, draw);
      const x = min[0] + draw[0] * (max[0] - min[0]),
        z = min[1] + draw[1] * (max[1] - min[1]);
      random.unitF64(2, e, 0, draw);
      const time = from + draw[0] * (to - from),
        target = s.rogueCrestChance * (1 - draw[1]);
      // The crest whose exceedance is `target`: bisect the decreasing tail.
      let lo = ROGUE_CREST,
        hi = 5;
      for (let it = 0; it < 60; it++) {
        const mid = (lo + hi) / 2;
        if (crestChance(mid, s) > target) lo = mid;
        else hi = mid;
      }
      out.push({ position: [x, z], time, crest: ((lo + hi) / 2) * s.significantHeight });
    }
    return out;
  }

  /**
   * Constrains the sea to the events' crests (a constrained NewWave for each, solved together): each event adds alpha_e
   * rho(X - X_e) + beta_e rho_t(X - X_e) under its window, rho the sea's normalised space-time autocovariance, with the
   * alphas and betas that make the linear surface reach A_e at each event and stand still in time there; A_e is the event's
   * crest less the second order's rise there, found by a few corrections.
   */
  private constrain(events: readonly RogueEvent[]): void {
    const { n } = this,
      count = events.length,
      size = 2 * count,
      scale = 1 / n,
      ce = new Float64Array(count * n),
      se = new Float64Array(count * n),
      value = new Float64Array(count),
      slope = new Float64Array(count),
      matrix = new Float64Array(size * size),
      coefficients = new Float64Array(size),
      weight: [number, number] = [0, 0];
    for (let e = 0; e < count; e++) {
      const { position, time } = events[e]!;
      for (let m = 0; m < n; m++) {
        const phase = this.kx[m]! * position[0] + this.kz[m]! * position[1] - this.omega[m]! * time,
          c = cos(phase),
          s = sin(phase);
        ce[e * n + m] = c;
        se[e * n + m] = s;
        value[e]! += this.re[m]! * c + this.im[m]! * s;
        slope[e]! += this.omega[m]! * (this.re[m]! * s - this.im[m]! * c);
      }
      this.eventRe.push(new Float64Array(n));
      this.eventIm.push(new Float64Array(n));
    }
    // Row 2f: the surface at event f; row 2f + 1: its time slope. Column 2e: event e's cos basis (1/n) sum cos(phi - phi_e);
    // column 2e + 1: its sin basis (1/n) sum w sin(phi - phi_e). At event f, with D = phi_f - phi_e, the cos basis is
    // sum cos D / n with slope sum w sin D / n, the sin basis sum w sin D / n with slope -sum w^2 cos D / n; under event e's
    // window W there, value W v and slope W v' + W_t v.
    for (let f = 0; f < count; f++) {
      const { position, time } = events[f]!;
      for (let e = 0; e < count; e++) {
        const [w, wt] = this.window(e, position[0], position[1], time, weight);
        if (w === 0) continue;
        let c0 = 0,
          c1 = 0,
          c2 = 0;
        for (let m = 0; m < n; m++) {
          const cd = ce[f * n + m]! * ce[e * n + m]! + se[f * n + m]! * se[e * n + m]!,
            sd = se[f * n + m]! * ce[e * n + m]! - ce[f * n + m]! * se[e * n + m]!,
            omega = this.omega[m]!;
          c0 += cd;
          c1 += omega * sd;
          c2 += omega * omega * cd;
        }
        c0 *= scale;
        c1 *= scale;
        c2 *= scale;
        matrix[2 * f * size + 2 * e] = w * c0;
        matrix[(2 * f + 1) * size + 2 * e] = w * c1 + wt * c0;
        matrix[2 * f * size + 2 * e + 1] = w * c1;
        matrix[(2 * f + 1) * size + 2 * e + 1] = -w * c2 + wt * c1;
      }
    }
    const linear = events.map((event) => event.crest),
      lastLinear = new Float64Array(count),
      lastReached = new Float64Array(count),
      rhs = new Float64Array(size);
    for (let pass = 0; pass < 20; pass++) {
      for (let e = 0; e < count; e++) {
        rhs[2 * e] = linear[e]! - value[e]!;
        rhs[2 * e + 1] = -slope[e]!;
      }
      solve(matrix, rhs, coefficients, size);
      // Event e's added part of component m: (alpha cos(phi - phi_e) + beta w sin(phi - phi_e)) / n, written as cos(phi)
      // and sin(phi) amplitudes.
      for (let e = 0; e < count; e++) {
        const er = this.eventRe[e]!,
          ei = this.eventIm[e]!,
          alpha = coefficients[2 * e]! * scale;
        for (let m = 0; m < n; m++) {
          const beta = coefficients[2 * e + 1]! * scale * this.omega[m]!,
            c = ce[e * n + m]!,
            s = se[e * n + m]!;
          er[m] = alpha * c - beta * s;
          ei[m] = alpha * s + beta * c;
        }
      }
      // A secant step per event on the crest's rise with its linear target (the second order makes it about 1 + 2 k A).
      let worst = 0;
      for (let e = 0; e < count; e++) {
        const { position, time, crest } = events[e]!,
          reached = this.elevation(position[0], position[1], time),
          miss = crest - reached,
          gain =
            pass > 0 && linear[e] !== lastLinear[e] ? (reached - lastReached[e]!) / (linear[e]! - lastLinear[e]!) : 1;
        lastLinear[e] = linear[e]!;
        lastReached[e] = reached;
        linear[e]! += miss / (gain > 0.5 && gain < 2 ? gain : 1);
        worst = Math.max(worst, Math.abs(miss) / crest);
      }
      if (worst <= 1e-12) break;
    }
  }
}

/**
 * Solves `matrix` x = `rhs` (size by size, row-major) into `out` by Gaussian elimination with partial pivoting; `matrix`
 * and `rhs` are kept.
 * @throws RangeError when the events cannot all be met: two at one place and time.
 */
function solve(matrix: Float64Array, rhs: Float64Array, out: Float64Array, size: number): void {
  const a = Float64Array.from(matrix),
    b = Float64Array.from(rhs);
  let largest = 0;
  for (let i = 0; i < size * size; i++) largest = Math.max(largest, Math.abs(a[i]!));
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++)
      if (Math.abs(a[row * size + col]!) > Math.abs(a[pivot * size + col]!)) pivot = row;
    if (!(Math.abs(a[pivot * size + col]!) > 1e-12 * largest))
      throw new RangeError(
        'Two rogue waves are too close in place and time to stand as separate crests; move one, or merge them.',
      );
    if (pivot !== col) {
      for (let k = 0; k < size; k++) {
        const t = a[col * size + k]!;
        a[col * size + k] = a[pivot * size + k]!;
        a[pivot * size + k] = t;
      }
      const t = b[col]!;
      b[col] = b[pivot]!;
      b[pivot] = t;
    }
    for (let row = col + 1; row < size; row++) {
      const factor = a[row * size + col]! / a[col * size + col]!;
      if (factor === 0) continue;
      for (let k = col; k < size; k++) a[row * size + k]! -= factor * a[col * size + k]!;
      b[row]! -= factor * b[col]!;
    }
  }
  for (let row = size - 1; row >= 0; row--) {
    let sum = b[row]!;
    for (let k = row + 1; k < size; k++) sum -= a[row * size + k]! * out[k]!;
    out[row] = sum / a[row * size + row]!;
  }
}

/** The chance a wave's crest passes xi H_s (Tayfun and Fedele 2007): exp(-8 xi0^2) (1 + 8 C4 xi0^2 (4 xi0^2 - 1)). */
export function crestChance(xi: number, s: Pick<SeaStatistics, 'kurtosis' | 'skewness'>): number {
  const mu = s.skewness / 3,
    xi0 = mu > 0 ? (Math.sqrt(1 + 8 * mu * xi) - 1) / (4 * mu) : xi,
    q = xi0 * xi0;
  return Math.max(0, exp(-8 * q) * (1 + 8 * s.kurtosis * q * (4 * q - 1)));
}

/** The chance a wave's height passes h H_s (Mori and Janssen 2006): e^(-2 h^2) (1 + C4 2 h^2 (h^2 - 1)). */
export function heightChance(h: number, s: Pick<SeaStatistics, 'kurtosis'>): number {
  const q = h * h;
  return Math.max(0, exp(-2 * q) * (1 + s.kurtosis * 2 * q * (q - 1)));
}

/**
 * The expected largest of `waves` wave heights, in H_s: the mean of the largest of `waves` independent heights of
 * {@link heightChance}'s law, the integral of 1 - (1 - P(H))^N over H.
 */
export function expectedMaximum(waves: number, s: Pick<SeaStatistics, 'kurtosis'>): number {
  if (!(waves >= 1 && Number.isFinite(waves)))
    throw new RangeError(
      `The number of waves is 1 or more (got ${waves}); pass one, the record's length over its period.`,
    );
  let sum = 0;
  const dh = 0.0005;
  for (let h = dh / 2; h < 6; h += dh) {
    const p = Math.min(1, heightChance(h, s));
    sum += (p >= 1 ? 1 : 1 - exp(waves * ln(1 - p))) * dh;
  }
  return sum;
}

/** Settings of {@link seaStatistics}. */
export interface SeaStatisticsOptions {
  /** Gravity's magnitude, m/s^2 (default the engine's). */
  readonly gravity?: number;
  /** The highest frequency the second order counts, a multiple of the peak (default 3, as {@link NonlinearSea}'s). */
  readonly cutoff?: number;
}

/**
 * The nonlinear statistics of a spectrum: the ECMWF wave model's freak-wave parameters in their deep-water closed forms
 * (IFS Cy50r1, Part VII, chapter 8), the moments over the whole spectrum; the skewness is the second-order sea's own,
 * 3 <eta_1^2 eta_2> / sigma^3 summed over the spectrum's bins up to the cutoff with the kernels {@link NonlinearSea} uses
 * (so directional spreading lowers it, as Forristall's short-crested fits have it), and the bound kurtosis follows it by
 * the narrowband relation lambda_40 = 2 lambda_3^2 (Tayfun and Fedele 2007), 6 eps^2 for a narrow deep sea.
 */
export function seaStatistics(spectrum: WaveSpectrumSample, options: SeaStatisticsOptions = {}): SeaStatistics {
  const g = options.gravity ?? gravityMagnitude(DEFAULT_GRAVITY),
    cutoff = options.cutoff ?? 3;
  if (!(g > 0)) throw new RangeError(`Gravity's magnitude is above 0 (got ${g}); pass one, or leave it out.`);
  if (!(cutoff > 1 && cutoff <= 10))
    throw new RangeError(
      `The cutoff is above 1 and at most 10 times the peak frequency (got ${cutoff}); pass one, or 3.`,
    );
  const { frequencies: fs, directions: ds, energy } = spectrum,
    nf = fs.length,
    nd = ds.length,
    dtheta = TWO_PI / nd,
    one = new Float64Array(nf);
  let peak = 0;
  for (let i = 0; i < nf; i++) {
    for (let j = 0; j < nd; j++) one[i]! += energy[i * nd + j]! * dtheta;
    if (one[i]! > one[peak]!) peak = i;
  }
  if (!(one[peak]! > 0)) throw new RangeError('This spectrum carries no energy; pass a sea with waves.');
  // Moments in angular frequency: E(omega) = E(f) / (2 pi), d omega = 2 pi df.
  let m0 = 0,
    m1 = 0,
    m2 = 0,
    mInverse = 0;
  for (let i = 0; i < nf; i++) {
    const w = TWO_PI * fs[i]!,
      v = one[i]! * bandWidth(fs, i);
    m0 += v;
    m1 += v * w;
    m2 += v * w * w;
    mInverse += v / w;
  }
  // Goda's peakedness over E(omega) > 0.4 E(omega_p): Q_p = (2 / m0^2) integral of omega E(omega)^2 d omega.
  const ep = one[peak]!;
  let qp = 0;
  for (let i = 0; i < nf; i++)
    if (one[i]! > 0.4 * ep) {
      const w = TWO_PI * fs[i]!,
        e = one[i]! / TWO_PI;
      qp += w * e * e * TWO_PI * bandWidth(fs, i);
    }
  qp *= 2 / (m0 * m0);
  // The directional width delta_theta = sqrt(2 (1 - R1)), R1 the mean resultant length over omega_p +- omega_p / 2.
  const fp = fs[peak]!;
  let cx = 0,
    cz = 0,
    band = 0;
  for (let i = 0; i < nf; i++) {
    if (fs[i]! < 0.5 * fp || fs[i]! > 1.5 * fp) continue;
    const df = bandWidth(fs, i);
    for (let j = 0; j < nd; j++) {
      const e = energy[i * nd + j]! * df;
      cx += e * cos(ds[j]!);
      cz += e * sin(ds[j]!);
      band += e;
    }
  }
  const r1 = band > 0 ? Math.min(1, Math.sqrt(cx * cx + cz * cz) / band) : 1,
    deltaTheta2 = 2 * (1 - r1),
    depth = spectrum.depth > 0 && spectrum.depth < 1e6 ? spectrum.depth : Number.POSITIVE_INFINITY,
    // k_bar: 0.89 omega_bar = omega(k_bar), omega_bar = m0 / m_-1.
    kBar = wavenumber((0.89 * (m0 / mInverse)) / TWO_PI, depth, g),
    eps = kBar * Math.sqrt(m0),
    nu = Math.sqrt(Math.max(0, (m0 * m2) / (m1 * m1) - 1)),
    deltaOmega = 1 / (qp * SQRT_PI),
    bfi = (Math.SQRT2 * eps) / deltaOmega,
    r = nu > 0 ? deltaTheta2 / (2 * nu * nu) : 0,
    dynamic = kurtosisFactor(r) * bfi * bfi,
    skewness = secondOrderSkewness(spectrum, fs[peak]! * cutoff, depth, g),
    kurtosis = dynamic + (2 * skewness * skewness) / 3,
    partial = { kurtosis, skewness };
  return {
    significantHeight: 4 * Math.sqrt(m0),
    peakPeriod: 1 / fp,
    zeroCrossingPeriod: TWO_PI * Math.sqrt(m0 / m2),
    steepness: eps,
    benjaminFeir: bfi,
    directionality: r,
    kurtosis,
    dynamicKurtosis: dynamic,
    skewness,
    rogueCrestChance: crestChance(ROGUE_CREST, partial),
    rogueHeightChance: heightChance(2, partial),
  };
}

/**
 * The second-order sea's skewness 3 <eta_1^2 eta_2> / sigma^3 over the bins up to `top` Hz: with v the variance of a bin,
 * <eta_1^2 eta_2> = sum over bin pairs of 2 v_i v_j (B+ + B-) plus each bin's own v^2 B+ (its components' pairs with one
 * another), sigma^2 the bins' variance.
 */
function secondOrderSkewness(spectrum: WaveSpectrumSample, top: number, depth: number, g: number): number {
  const { frequencies: fs, directions: ds, energy } = spectrum,
    nf = fs.length,
    nd = ds.length,
    dtheta = TWO_PI / nd;
  let most = 0,
    variance = 0;
  for (let i = 0; i < nf; i++)
    if (fs[i]! <= top) for (let j = 0; j < nd; j++) most = Math.max(most, energy[i * nd + j]! * bandWidth(fs, i));
  // The bins that carry the sea (above a millionth of the largest), as frequency, wavenumber vector and variance.
  const w: number[] = [],
    x: number[] = [],
    z: number[] = [],
    v: number[] = [];
  for (let i = 0; i < nf; i++) {
    if (fs[i]! > top) continue;
    const df = bandWidth(fs, i),
      k = wavenumber(fs[i]!, depth, g);
    for (let j = 0; j < nd; j++) {
      const e = energy[i * nd + j]! * df;
      variance += e * dtheta;
      if (!(e > 1e-6 * most)) continue;
      w.push(TWO_PI * fs[i]!);
      x.push(k * cos(ds[j]!));
      z.push(k * sin(ds[j]!));
      v.push(e * dtheta);
    }
  }
  let sum = 0;
  for (let a = 0; a < w.length; a++) {
    sum += v[a]! * v[a]! * kernel(1, w[a]!, x[a]!, z[a]!, w[a]!, x[a]!, z[a]!, depth, g);
    for (let b = a + 1; b < w.length; b++)
      sum +=
        2 *
        v[a]! *
        v[b]! *
        (kernel(1, w[a]!, x[a]!, z[a]!, w[b]!, x[b]!, z[b]!, depth, g) +
          kernel(-1, w[a]!, x[a]!, z[a]!, w[b]!, x[b]!, z[b]!, depth, g));
  }
  return variance > 0 ? (3 * sum) / (variance * Math.sqrt(variance)) : 0;
}

/**
 * J(R), the dynamic kurtosis per BFI^2 as the sea's directionality R grows (the ECMWF fit, IFS Cy50r1 chapter 8): (pi Gamma
 * / (3 sqrt 3)) (1 - alpha sqrt R + beta R + delta R^2) for R up to 1, Gamma 0.9, alpha = 4 sqrt 3 / pi, beta = 1/3 + 2
 * sqrt 3 / pi, delta = 2 sqrt 3 / pi - 4/3; -J(1/R) / R above 1, where crossing seas defocus.
 */
export function kurtosisFactor(r: number): number {
  if (!(r >= 0)) return 0;
  if (r > 1) return -kurtosisFactor(1 / r) / r;
  const alpha = (4 * ROOT3) / PI,
    beta = 1 / 3 + (2 * ROOT3) / PI,
    delta = (2 * ROOT3) / PI - 4 / 3;
  return ((PI * 0.9) / (3 * ROOT3)) * (1 - alpha * Math.sqrt(r) + beta * r + delta * r * r);
}

/** A wave component for {@link pairKernels}: frequency `frequency` Hz travelling toward `direction` radians. */
export interface WaveComponent {
  readonly frequency: number;
  readonly direction: number;
}

/**
 * The second-order sum and difference kernels of two wave components in water `depth` m deep (Infinity for deep water):
 * their pair adds a1 a2 (sum cos(psi1 + psi2) + difference cos(psi1 - psi2)) to the surface (Dalzell 1999, as Adcock and
 * Draper 2015 restate it). Deep and in line: (k1 + k2) / 2 and -|k1 - k2| / 2.
 */
export function pairKernels(
  a: WaveComponent,
  b: WaveComponent,
  depth = Number.POSITIVE_INFINITY,
  gravity = gravityMagnitude(DEFAULT_GRAVITY),
): { sum: number; difference: number } {
  if (!(a?.frequency > 0 && b?.frequency > 0 && Number.isFinite(a.direction) && Number.isFinite(b.direction)))
    throw new RangeError('A wave component is {frequency, direction} with a frequency in Hz above 0; pass two.');
  if (!(depth > 0) || !(gravity > 0))
    throw new RangeError(
      `Depth and gravity are above 0 (got ${depth} and ${gravity}); pass them, Infinity for deep water.`,
    );
  const d = depth < 1e6 ? depth : Number.POSITIVE_INFINITY,
    k1 = wavenumber(a.frequency, d, gravity),
    k2 = wavenumber(b.frequency, d, gravity),
    w1 = TWO_PI * a.frequency,
    w2 = TWO_PI * b.frequency,
    x1 = k1 * cos(a.direction),
    z1 = k1 * sin(a.direction),
    x2 = k2 * cos(b.direction),
    z2 = k2 * sin(b.direction);
  return {
    sum: kernel(1, w1, x1, z1, w2, x2, z2, d, gravity),
    difference: kernel(-1, w1, x1, z1, w2, x2, z2, d, gravity),
  };
}

/**
 * Dalzell's second-order kernel of two components (Adcock and Draper's appendix): `sign` 1 for the sum B+, -1 for the
 * difference B- (0 where the difference wave has no frequency and no wavenumber, a component with itself).
 */
function kernel(
  sign: 1 | -1,
  w1: number,
  x1: number,
  z1: number,
  w2: number,
  x2: number,
  z2: number,
  depth: number,
  g: number,
): number {
  const ax = x1 + sign * x2,
    az = z1 + sign * z2,
    kk = Math.sqrt(ax * ax + az * az),
    ww = (w1 + sign * w2) * (w1 + sign * w2),
    gk = g * kk * tanhOf(kk * depth),
    delta = ww - gk;
  if (sign < 0 && !(Math.abs(delta) > 1e-12 * (w1 * w1 + w2 * w2))) return 0;
  const k1 = Math.sqrt(x1 * x1 + z1 * z1),
    k2 = Math.sqrt(x2 * x2 + z2 * z2),
    cosAngle = (x1 * x2 + z1 * z2) / (k1 * k2),
    alpha = (w1 * w1 + w2 * w2) / (2 * g),
    beta = ((w1 * w2) / (2 * g)) * (1 - (sign * cosAngle) / (tanhOf(k1 * depth) * tanhOf(k2 * depth))),
    epsilon = (w1 + sign * w2) / (2 * g),
    zeta = zetaOf(w1, k1 * depth) + sign * zetaOf(w2, k2 * depth);
  return alpha - (sign * beta * (ww + gk)) / delta + (epsilon * zeta) / delta;
}

/** omega^3 / sinh^2(k d), 0 in deep water. */
function zetaOf(w: number, kd: number): number {
  if (!(kd <= 20)) return 0;
  const s = sinhOf(kd);
  return (w * w * w) / (s * s);
}

function sinhOf(x: number): number {
  const e = exp(x);
  return (e - 1 / e) / 2;
}
function tanhOf(x: number): number {
  if (!(x <= 20)) return 1;
  const e = exp(2 * x);
  return (e - 1) / (e + 1);
}
