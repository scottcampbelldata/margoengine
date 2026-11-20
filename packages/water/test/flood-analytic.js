// Exact and closed-form shallow-water solutions the flood solver is measured against (disaster water plan, section 3).
// Each is written from the paper or book named on it; formulas were checked against the source text where it could be
// opened (SWASHES, Delestre et al. 2013, https://arxiv.org/abs/1110.0288, International Journal for Numerical Methods
// in Fluids 72(3) 269-300, https://doi.org/10.1002/fld.3741).
import { G, RHO_AIR, RHO_WATER } from './flood-reference.js';

/**
 * Dam break on a dry bed (Ritter 1892; SWASHES section 4.1.2): reservoir depth h0 left of x0, dry right of it, flat,
 * frictionless. Returns { h, u } at (x, t).
 */
export function ritter(h0, x0, x, t) {
  const c = Math.sqrt(G * h0);
  if (x <= x0 - c * t) return { h: h0, u: 0 };
  if (x >= x0 + 2 * c * t) return { h: 0, u: 0 };
  const r = c - (x - x0) / (2 * t);
  return { h: (4 / (9 * G)) * r * r, u: (2 / 3) * ((x - x0) / t + c) };
}

/**
 * Dam break on a wet bed (Stoker 1957, pp. 333-341; SWASHES section 4.1.1): depth hl left of x0, hr right. cm =
 * sqrt(g hm) solves -8 g hr cm^2 (sqrt(g hl) - cm)^2 + (cm^2 - g hr)^2 (cm^2 + g hr) = 0. Returns the middle depth hm,
 * the middle velocity, the shock speed and { h, u } at (x, t).
 */
export function stoker(hl, hr, x0 = 0) {
  const cl = Math.sqrt(G * hl),
    f = (c) => -8 * G * hr * c * c * (cl - c) ** 2 + (c * c - G * hr) ** 2 * (c * c + G * hr);
  // f < 0 just above sqrt(g hr) and > 0 at cl: bisect between them.
  let lo = Math.sqrt(G * hr) * (1 + 1e-12),
    hi = cl;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  const cm = 0.5 * (lo + hi),
    hm = (cm * cm) / G,
    um = 2 * (cl - cm),
    shock = (2 * cm * cm * (cl - cm)) / (cm * cm - G * hr);
  const at = (x, t) => {
    const xa = x0 - t * cl,
      xb = x0 + t * (2 * cl - 3 * cm),
      xc = x0 + t * shock;
    if (x <= xa) return { h: hl, u: 0 };
    if (x <= xb) return { h: (4 / (9 * G)) * (cl - (x - x0) / (2 * t)) ** 2, u: (2 / 3) * ((x - x0) / t + cl) };
    if (x <= xc) return { h: hm, u: um };
    return { h: hr, u: 0 };
  };
  return { hm, um, shock, at };
}

/**
 * A bore running into still water of depth h0 with depth h1 behind it: from the Rankine-Hugoniot jump conditions of
 * mass and momentum (Stoker 1957, chapter 10; Whitham 1974, section 13.10) its speed is c = sqrt(g h1 (h0 + h1) / (2 h0))
 * and the water behind moves at u1 = c (1 - h0 / h1).
 */
export function bore(h0, h1) {
  const c = Math.sqrt((G * h1 * (h0 + h1)) / (2 * h0));
  return { speed: c, u1: c * (1 - h0 / h1) };
}

/**
 * The bore reflected from a wall: water of depth h1 moving at u1 into the wall stops behind a reflected bore of depth
 * h2 with u1 = (h2 - h1) sqrt(g (h1 + h2) / (2 h1 h2)) (the same jump conditions in the wall's frame, the water behind it
 * at rest). Returns h2 and the reflected bore's speed away from the wall, h1 u1 / (h2 - h1).
 */
export function reflectedBore(h1, u1) {
  const f = (h2) => (h2 - h1) * Math.sqrt((G * (h1 + h2)) / (2 * h1 * h2)) - u1;
  let lo = h1,
    hi = h1 * 2;
  while (f(hi) < 0) hi *= 2;
  for (let k = 0; k < 200; k++) {
    const mid = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  const h2 = 0.5 * (lo + hi);
  return { h2, speed: (h1 * u1) / (h2 - h1) };
}

/**
 * The hydraulic jump's conjugate depths (the Belanger equation, after Belanger 1828; Chanson 2009, J. Hydraul. Eng.
 * 135(3) 159-163, https://doi.org/10.1061/(ASCE)0733-9429(2009)135:3(159); Chow 1959, Open-Channel Hydraulics,
 * section 15-2): h2 / h1 = (sqrt(1 + 8 Fr1^2) - 1) / 2, Fr1 = u1 / sqrt(g h1).
 */
export function belanger(froude) {
  return (Math.sqrt(1 + 8 * froude * froude) - 1) / 2;
}

/**
 * Uniform flow on a slope (Manning; Chow 1959, section 5-6): in a wide channel the hydraulic radius is the depth, so
 * u = h^(2/3) sqrt(S) / n and the normal depth for discharge q per metre is (q n / sqrt(S))^(3/5).
 */
export const manning = {
  speed: (h, slope, n) => (Math.pow(h, 2 / 3) * Math.sqrt(slope)) / n,
  normalDepth: (q, slope, n) => Math.pow((q * n) / Math.sqrt(slope), 3 / 5),
};

/**
 * Thacker's planar surface in a paraboloid (Thacker 1981, J. Fluid Mech. 107 499-508,
 * https://doi.org/10.1017/S0022112081001882; SWASHES section 4.2.2): bed z = -h0 (1 - r^2 / a^2) about (L/2, L/2),
 * h = eta h0 / a^2 (2 (x - L/2) cos wt + 2 (y - L/2) sin wt - eta) - z where positive, u = -eta w sin wt,
 * v = eta w cos wt, w = sqrt(2 g h0) / a.
 */
export function thacker({ a = 1, h0 = 0.1, eta = 0.5, L = 4 } = {}) {
  const w = Math.sqrt(2 * G * h0) / a,
    bed = (x, y) => -h0 * (1 - ((x - L / 2) ** 2 + (y - L / 2) ** 2) / (a * a)),
    surface = (x, y, t) => ((eta * h0) / (a * a)) * (2 * (x - L / 2) * Math.cos(w * t) + 2 * (y - L / 2) * Math.sin(w * t) - eta),
    depth = (x, y, t) => Math.max(0, surface(x, y, t) - bed(x, y));
  return { w, period: (2 * Math.PI) / w, bed, surface, depth, u: (t) => -eta * w * Math.sin(w * t), v: (t) => eta * w * Math.cos(w * t) };
}

/**
 * The run-up of a non-breaking solitary wave of height H on depth d up a plane beach of angle beta (Synolakis 1987,
 * J. Fluid Mech. 185 523-545, https://doi.org/10.1017/S002211208700329X, the run-up law): R / d = 2.831
 * sqrt(cot beta) (H / d)^(5/4). The NOAA canonical case is cot beta = 19.85, H / d = 0.0185 (Synolakis et al. 2008,
 * Pure Appl. Geophys. 165 2197-2228, https://doi.org/10.1007/s00024-004-0427-y; NOAA PMEL-135).
 */
export function solitaryRunup(heightOverDepth, cotBeta) {
  return 2.831 * Math.sqrt(cotBeta) * Math.pow(heightOverDepth, 5 / 4);
}

/** The solitary wave's surface over depth d: H sech^2(gamma (x - x1)), gamma = sqrt(3 H / (4 d^3)), speed sqrt(g (d + H)). */
export function solitary(H, d, x1) {
  const gamma = Math.sqrt((3 * H) / (4 * d * d * d)),
    c = Math.sqrt(G * (d + H));
  return {
    gamma,
    speed: c,
    eta: (x) => H / Math.cosh(gamma * (x - x1)) ** 2,
  };
}

/**
 * The highest a bore of speed U0 at the shoreline can run up a beach (Shen, Meyer 1963, J. Fluid Mech. 16(1) 113-125,
 * https://doi.org/10.1017/S0022112063000628): the shoreline tip moves as a particle under gravity alone, so it climbs at
 * most U0^2 / (2 g).
 */
export const boreRunup = (U0) => (U0 * U0) / (2 * G);

/**
 * Wind set-up over a closed basin at rest: the surface slope balances the wind stress, d eta / dx = tau / (rho g h), with
 * tau = rho_air Cd U^2 (Resio, Westerink 2008, Physics Today 61(9) 33-38, https://doi.org/10.1063/1.2982120). Cd =
 * (0.75 + 0.067 U) 1e-3 (Garratt 1977, Mon. Weather Rev. 105 915-929, https://doi.org/10.1175/1520-0493(1977)105<0915:RODCOO>2.0.CO;2,
 * the line fitted to measurements from about 4 to 21 m/s), carried on up to 26 m/s and held there, at 2.49e-3, above it:
 * drag measured under hurricanes stops growing with wind speed near that level (Powell, Vickery, Reinhold 2003,
 * Nature 422 279-283, https://doi.org/10.1038/nature01481).
 */
export const dragCoefficient = (U) => (0.75 + 0.067 * Math.min(U, 26)) * 1e-3;
export const windStress = (U) => RHO_AIR * dragCoefficient(U) * U * U;
export const windTilt = (U, depth, length) => (windStress(U) / (RHO_WATER * G * depth)) * length;
