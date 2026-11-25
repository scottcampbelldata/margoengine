// The ST4 source terms of Ardhuin et al. (2010) for the sea's waves (spectral.ts): wind input after Janssen (1991) with
// the wave-supported stress fed back on the roughness and a sheltering of the short waves, swell dissipation by the air's
// boundary layer, and dissipation by breaking from the spectrum's saturation, local and cumulative.
//
// Written from the WAVEWATCH III user manual (version 5.16, The WAVEWATCH III Development Group 2016, section 2.3.9, eqs.
// 2.99 to 2.105, and section 2.3.10, eqs. 2.110 to 2.124, with its parameter tables 2.6 and 2.7, read 2026-11-25: public
// documentation, the code was not read), cross-checked against F. Ardhuin et al., "Semi-empirical dissipation source
// functions for ocean waves. Part I", J. Phys. Oceanogr. 40, 2010 (arXiv:0907.4240, read in part: eqs. 8 to 25). The
// constants are the manual's TEST471 set, the one it recommends at global scale, with two the sources disagree on settled:
// the roughness cap z0_max = 0.002 of TEST405 (the paper's eq. 23 gives 0.0015 as an example; the growth tests cannot tell
// them apart) and the sheltering s_u calibrated to 1, the paper's own TEST441 value (see `ST4.shelter`).
//
// - Input: S_in = (rho_a / rho_w) (beta_max / kappa^2) e^Z Z^4 (u*' / C + z_alpha)^2 cos^2(theta - theta_u) sigma E for
//   Z < 0, Z = ln(k z_1) + kappa / [cos(theta - theta_u) (u*' / C + z_alpha)] (eqs. 2.99 and 2.100), with U10 = (u* /
//   kappa) ln(z_u / z_1) and z_1 = alpha_0 u*^2 / (g sqrt(1 - tau_w / tau)) (eqs. 2.101 and 2.102), tau_w the stress the
//   waves carry, resolved plus an f^-5 tail (eqs. 2.103 and 2.104), and u*'(k)^2 = |u*^2 e_u - s_u tau_w(< k)| the
//   sheltered friction velocity (eq. 2.110).
// - Swell dissipation: S_out = r_vis S_vis + r_tur S_tur with S_vis = -s5 (rho_a / rho_w) 2 k sqrt(2 nu_a sigma) E and S_tur
//   = -(rho_a / rho_w) 16 f_e sigma^2 u_orb / g E, the weights 0.5 (1 -+ tanh((Re - Re_c) / s7)), Re = 2 u_orb H_s / nu_a,
//   f_e = s1 f_e,GM + (|s3| + s2 cos(theta - theta_u)) u* / u_orb (eqs. 2.111 to 2.117); f_e,GM, the friction factor of a
//   rough oscillatory boundary layer, from 1 / (4 sqrt(f_w)) + log10(1 / (4 sqrt(f_w))) = -0.08 + log10(a_b / K_N) (Madsen et
//   al. 1988, as the SWAN documentation states it, eq. 2.63), with K_N = 30 z_0' the Nikuradse roughness of z_0' = r_z z_1.
// - Breaking: S_sat = sigma (C_ds / B_r^2) [delta_d max(B - B_r, 0)^2 + (1 - delta_d) max(B' - B_r, 0)^2] E with the
//   saturation B'(k, theta) = integral over +-80 degrees of k^3 cos^2(theta - theta') E(k, theta') d theta' and B(k) its
//   largest over theta (eqs. 2.118 to 2.120), and the cumulative breaking S_cu = C_cu (14.2 / pi^2) E integral over k' below
//   r_cu^2 k (frequencies below r_cu f) of |C - C'| max(sqrt(B') - sqrt(B_r), 0)^2 dk' d theta' (eqs. 2.123 and 2.124, from
//   the breaking probability 56.8 (sqrt(B') - sqrt(B_r))^2 halved and the crest length 1 / (2 pi^2 k) of eqs. 2.121 and
//   2.122; C_cu negative, as the paper's eq. 18 writes it).

import { cos, exp, hypot, ln, pow, sin } from '@margoengine/math/pinned';

/** The manual's TEST471 constants (WAVEWATCH III 5.16, tables 2.6 and 2.7). */
export const ST4 = {
  windHeight: 10,
  /** The largest Charnock roughness, m: caps the drag of the roughest seas (the paper's eq. 23; TEST405 0.002). */
  roughnessMax: 0.002,
  alpha0: 0.0095,
  betaMax: 1.43,
  zAlpha: 0.006,
  /**
   * The sheltering s_u, calibrated: the sources give 0.3 (TEST471), 0.4 and 1 (the paper's TEST441); fitted on Kahma and
   * Calkoen's fetch-limited growth at 10 and 20 m/s over 0, 0.3, 0.6 and 1 (docs/clean-room.md), 1 fits best.
   */
  shelter: 1,
  s1: 0.66,
  s2: -0.018,
  s3: 0.022,
  reynoldsCritical: 1.5e5,
  s5: 1.2,
  s7: 3.6e5,
  roughnessRatio: 0.04,
  saturationCoefficient: -2.2e-5,
  saturationThreshold: 0.0009,
  sector: (80 * Math.PI) / 180,
  cumulative: -0.40344,
  cumulativeRatio: 0.5,
  isotropic: 0.3,
  tailFactor: 2.5,
  nonlinear: 2.5e7,
} as const;

const KAPPA = 0.41;
const TWO_PI = 6.283185307179586;
const PI = 3.141592653589793;

/** A cell's spectral grid and water. */
export interface SpectralCell {
  readonly nf: number;
  readonly nd: number;
  readonly freqs: Float64Array;
  readonly widths: Float64Array;
  readonly dirs: Float64Array;
  /** Wavenumber and group velocity of each frequency here. */
  readonly k: Float64Array;
  readonly cg: Float64Array;
  readonly depth: number;
  readonly g: number;
  /** rho_a / rho_w. */
  readonly densityRatio: number;
  /** Kinematic viscosity of air, m^2/s. */
  readonly airViscosity: number;
}

/**
 * The ST4 rates of a cell's spectrum `e` (E(f, theta), m^2/(Hz rad)): `grow` gets the wind's input rate per bin (1/s, to
 * multiply E), `decay` the swell and breaking dissipation rates (1/s, 0 or less). Returns u* and the index of the highest
 * prognostic frequency (2.5 times the mean frequency); above it the spectrum is the f^-5 tail.
 */
export function st4Rates(
  e: Float64Array,
  cell: SpectralCell,
  u10: number,
  windDirection: number,
  grow: Float64Array,
  decay: Float64Array,
): { ustar: number; cutoff: number } {
  const { nf, nd, freqs, widths, dirs, k, cg, g, densityRatio } = cell,
    dtheta = TWO_PI / nd;
  grow.fill(0);
  decay.fill(0);
  // Integrals: variance, the significant orbital velocity, the mean frequency of action with p = 1/2.
  let m0 = 0,
    orbital = 0,
    actionRoot = 0,
    action = 0;
  for (let i = 0; i < nf; i++) {
    const sigma = TWO_PI * freqs[i]!,
      df = widths[i]!;
    for (let j = 0; j < nd; j++) {
      const v = e[i * nd + j]! * df * dtheta;
      m0 += v;
      orbital += sigma * sigma * v;
      action += v / sigma;
      actionRoot += (v / sigma) * pow(sigma, 0.5);
    }
  }
  const meanSigma = action > 0 ? pow(actionRoot / action, 2) : TWO_PI * freqs[nf - 1]!,
    fhf = (ST4.tailFactor * meanSigma) / TWO_PI;
  let cutoff = nf - 1;
  for (let i = 0; i < nf; i++)
    if (freqs[i]! > fhf) {
      cutoff = i > 0 ? i - 1 : 0;
      break;
    }
  // The wind: u* and the roughness with the waves' stress fed back.
  let ustar = 0,
    z1 = 0;
  if (u10 > 0) [ustar, z1] = friction(e, cell, u10, windDirection, grow);
  // Swell dissipation by the air's boundary layer.
  if (m0 > 0) {
    const hs = 4 * pow(m0, 0.5),
      uorb = 2 * pow(orbital, 0.5),
      re = (2 * uorb * hs) / cell.airViscosity,
      reCritical = (ST4.reynoldsCritical * 4) / hs,
      wTurbulent = 0.5 * (1 + tanh((re - reCritical) / ST4.s7)),
      wViscous = 1 - wTurbulent,
      // f_e,GM from the orbital excursion a_b = H_s / 2 over K_N = 30 r_z z_1.
      kn = 30 * ST4.roughnessRatio * (z1 > 0 ? z1 : 1e-5),
      feGM = grantMadsen(hs / 2 / kn);
    for (let i = 0; i < nf; i++) {
      const sigma = TWO_PI * freqs[i]!,
        kk = k[i]!,
        viscous = -ST4.s5 * densityRatio * 2 * kk * pow(2 * cell.airViscosity * sigma, 0.5);
      for (let j = 0; j < nd; j++) {
        const along = cos(dirs[j]! - windDirection),
          fe = ST4.s1 * feGM + ((ST4.s3 < 0 ? -ST4.s3 : ST4.s3) + ST4.s2 * along) * (uorb > 0 ? ustar / uorb : 0),
          turbulent = (-densityRatio * 16 * fe * sigma * sigma * uorb) / g;
        decay[i * nd + j]! += wViscous * viscous + wTurbulent * turbulent;
      }
    }
  }
  // Breaking: the saturation over a sector, local and cumulative.
  const saturation = new Float64Array(nf * nd),
    largest = new Float64Array(nf),
    half = Math.round(ST4.sector / dtheta),
    // cos(n dtheta) for each step n between two directions.
    turn = new Float64Array(nd);
  for (let n = 0; n < nd; n++) turn[n] = cos(n * dtheta);
  for (let i = 0; i < nf; i++) {
    const kk = k[i]!,
      level = (kk * kk * kk * cg[i]!) / TWO_PI;
    for (let j = 0; j < nd; j++) {
      let b = 0;
      for (let m = -half; m <= half; m++) {
        const c = turn[(m + nd) % nd]!;
        b += c * c * e[i * nd + ((j + m + nd) % nd)]!;
      }
      const value = level * b * dtheta;
      saturation[i * nd + j] = value;
      if (value > largest[i]!) largest[i] = value;
    }
  }
  const br = ST4.saturationThreshold,
    rootBr = Math.sqrt(br),
    coefficient = ST4.saturationCoefficient / (br * br),
    // Each breaker's weight in the cumulative term: max(sqrt(B') - sqrt(B_r), 0)^2 dk d theta.
    sweep = new Float64Array(nf * nd);
  for (let m = 0; m < nf; m++) {
    const dk = (TWO_PI * widths[m]!) / cg[m]!;
    for (let n = 0; n < nd; n++) {
      const excess = Math.sqrt(saturation[m * nd + n]!) - rootBr;
      sweep[m * nd + n] = excess > 0 ? excess * excess * dk * dtheta : 0;
    }
  }
  for (let i = 0; i < nf; i++) {
    const sigma = TWO_PI * freqs[i]!,
      kk = k[i]!,
      c = sigma / kk,
      over = largest[i]! > br ? largest[i]! - br : 0;
    for (let j = 0; j < nd; j++) {
      const local = saturation[i * nd + j]! > br ? saturation[i * nd + j]! - br : 0;
      let rate = sigma * coefficient * (ST4.isotropic * over * over + (1 - ST4.isotropic) * local * local);
      // Cumulative: the passage of breakers of frequencies below r_cu f over these waves.
      let swept = 0;
      for (let m = 0; m < i && freqs[m]! < ST4.cumulativeRatio * freqs[i]!; m++) {
        const cm = (TWO_PI * freqs[m]!) / k[m]!;
        for (let n = 0; n < nd; n++) {
          const w = sweep[m * nd + n]!;
          if (!(w > 0)) continue;
          // |C - C'|, the speed at which the breaker sweeps over these waves.
          swept += w * Math.sqrt(c * c + cm * cm - 2 * c * cm * turn[(j - n + nd) % nd]!);
        }
      }
      rate += ((ST4.cumulative * 14.2) / (PI * PI)) * swept;
      decay[i * nd + j]! += rate;
    }
  }
  return { ustar, cutoff };
}

/** What the input needs of a cell, computed once per call: each band's sigma, phase speed, ln k and energy weight. */
interface Bands {
  readonly sigma: Float64Array;
  readonly speed: Float64Array;
  readonly lnK: Float64Array;
  /** The band's width times d theta, Hz rad. */
  readonly width: Float64Array;
  /** The band's energy E(f, theta), m^2/(Hz rad), frequency-major; the tail's from E(f_max) (f / f_max)^-5. */
  readonly energy: Float64Array;
  /** Resolved bands; the rest are the tail. */
  readonly resolved: number;
  /** cos(theta_j - theta_u), cos theta_j and sin theta_j. */
  readonly along: Float64Array;
  readonly cosines: Float64Array;
  readonly sines: Float64Array;
}

/** The resolved bands and an f^-5 tail out to 50 Hz, deep water, with the direction tables. */
function bandsOf(e: Float64Array, cell: SpectralCell, direction: number): Bands {
  const { nf, nd, freqs, widths, dirs, k, g } = cell,
    dtheta = TWO_PI / nd,
    ratio = freqs[nf - 1]! / freqs[nf - 2]!,
    tail = Math.max(0, Math.ceil(ln(50 / freqs[nf - 1]!) / ln(ratio))),
    n = nf + tail,
    bands: Bands = {
      sigma: new Float64Array(n),
      speed: new Float64Array(n),
      lnK: new Float64Array(n),
      width: new Float64Array(n),
      energy: new Float64Array(n * nd),
      resolved: nf,
      along: new Float64Array(nd),
      cosines: new Float64Array(nd),
      sines: new Float64Array(nd),
    };
  for (let j = 0; j < nd; j++) {
    bands.along[j] = cos(dirs[j]! - direction);
    bands.cosines[j] = cos(dirs[j]!);
    bands.sines[j] = sin(dirs[j]!);
  }
  for (let i = 0; i < n; i++) {
    const f = i < nf ? freqs[i]! : freqs[nf - 1]! * pow(ratio, i - nf + 1),
      sigma = TWO_PI * f,
      kk = i < nf ? k[i]! : (sigma * sigma) / g,
      decline = i < nf ? 1 : pow(ratio, -5 * (i - nf + 1));
    bands.sigma[i] = sigma;
    bands.speed[i] = sigma / kk;
    bands.lnK[i] = ln(kk);
    bands.width[i] = (i < nf ? widths[i]! : f * (ratio - 1)) * dtheta;
    for (let j = 0; j < nd; j++) bands.energy[i * nd + j] = (i < nf ? e[i * nd + j]! : e[(nf - 1) * nd + j]!) * decline;
  }
  return bands;
}

/**
 * Janssen's u* and roughness z_1 for the wind U10 over spectrum `e`, iterated with the wave-supported stress (resolved and
 * the f^-5 tail beyond the grid); fills `grow` with the sheltered input rates of the last pass.
 */
function friction(
  e: Float64Array,
  cell: SpectralCell,
  u10: number,
  direction: number,
  grow: Float64Array,
): [number, number] {
  const { g } = cell,
    bands = bandsOf(e, cell, direction);
  let ustar = u10 * Math.sqrt(1.2e-3),
    z1 = (ST4.alpha0 * ustar * ustar) / g;
  for (let pass = 0; pass < 30; pass++) {
    const [tx, tz] = inputAndStress(bands, cell, ustar, z1, direction, undefined),
      tau = ustar * ustar,
      share = hypot(tx, tz) / tau,
      ratio = share < 0.999 ? share : 0.999,
      charnock = (ST4.alpha0 * tau) / g,
      next = (charnock < ST4.roughnessMax ? charnock : ST4.roughnessMax) / Math.sqrt(1 - ratio),
      speed = (KAPPA * u10) / ln(ST4.windHeight / next);
    const change = speed > ustar ? speed - ustar : ustar - speed;
    ustar = speed;
    z1 = next;
    if (change <= 1e-7 * ustar) break;
  }
  inputAndStress(bands, cell, ustar, z1, direction, grow);
  return [ustar, z1];
}

/**
 * The kinematic stress the waves carry, (rho_w / rho_a) g integral of S_in / C along each direction, over the grid and the
 * tail, with the friction velocity sheltered by the stress of the longer waves; the input rates of the resolved bands into
 * `grow` when given.
 */
function inputAndStress(
  bands: Bands,
  cell: SpectralCell,
  ustar: number,
  z1: number,
  direction: number,
  grow: Float64Array | undefined,
): [number, number] {
  const { nd, g, densityRatio } = cell,
    stressFactor = g / densityRatio,
    lnZ1 = ln(z1),
    ux = ustar * ustar * cos(direction),
    uz = ustar * ustar * sin(direction),
    n = bands.sigma.length;
  let tx = 0,
    tz = 0;
  for (let i = 0; i < n; i++) {
    const sigma = bands.sigma[i]!,
      c = bands.speed[i]!,
      sheltered = Math.sqrt(hypot(ux - ST4.shelter * tx, uz - ST4.shelter * tz)),
      age = sheltered / c + ST4.zAlpha,
      base = bands.lnK[i]! + lnZ1,
      scale = (densityRatio * ST4.betaMax * age * age * sigma) / (KAPPA * KAPPA);
    let fx = 0,
      fz = 0,
      any = false;
    for (let j = 0; j < nd; j++) {
      const along = bands.along[j]!;
      let rate = 0;
      if (along > 0) {
        const z = base + KAPPA / (along * age);
        if (z < 0) {
          const z2 = z * z;
          rate = scale * exp(z) * z2 * z2 * along * along;
          any = true;
        }
      }
      if (grow && i < bands.resolved) grow[i * nd + j] = rate;
      const momentum = (stressFactor * rate * bands.energy[i * nd + j]! * bands.width[i]!) / c;
      fx += momentum * bands.cosines[j]!;
      fz += momentum * bands.sines[j]!;
    }
    tx += fx;
    tz += fz;
    if (!any && i >= bands.resolved) break;
  }
  return [tx, tz];
}

/** The friction factor of a rough oscillatory boundary layer for excursion over roughness `r` (Madsen et al. 1988; 0.30 below 1.57). */
function grantMadsen(r: number): number {
  if (!(r >= 1.57)) return 0.3;
  // 1 / (4 sqrt(f)) + log10(1 / (4 sqrt(f))) = -0.08 + log10(r): solve for x = 1 / (4 sqrt(f)) by bisection.
  const target = -0.08 + ln(r) / 2.302585092994046;
  let lo = 0.01,
    hi = 100;
  for (let i = 0; i < 80; i++) {
    const x = 0.5 * (lo + hi);
    if (x + ln(x) / 2.302585092994046 < target) lo = x;
    else hi = x;
  }
  const x = 0.5 * (lo + hi);
  return 1 / (16 * x * x);
}

function tanh(x: number): number {
  if (x > 20) return 1;
  if (x < -20) return -1;
  const e = exp(-2 * x);
  return (1 - e) / (1 + e);
}
