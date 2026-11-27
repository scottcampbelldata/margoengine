// Planing hulls (SEA-09): a prismatic planing hull's lift, centre of pressure, wetted length and drag by D. Savitsky,
// "Hydrodynamic design of planing hulls", Marine Technology 1(1), 71-95, 1964, as two open texts reproduce his equations
// (the original could not be obtained): F. Ekman, C. Naudo Ribas and F. Rydelius, "Model for predicting resistance and
// running attitude of high-speed craft equipped with interceptors", KTH 2016, eqs. 2.1 to 2.13 (read), and P. Ghadimi, S.
// Tavakoli, M. A. Feizi Chekab and A. Dashtimanesh, J. Naval Arch. Marine Eng. 12, 73-94, 2015, eqs. 9 and 16 to 34 (read):
// - the flat plate's lift C_L0 = tau^1.1 (0.0120 lambda^0.5 + 0.0055 lambda^2.5 / C_v^2) (tau in degrees), its dynamic and
//   its buoyant part, and the deadrise surface's C_Lbeta = C_L0 - 0.0065 beta C_L0^0.6 (beta in degrees);
// - the centre of pressure C_p lambda b forward of the transom, C_p = 0.75 - 1 / (5.21 C_v^2 / lambda^2 + 2.39);
// - the mean bottom velocity V_m = V sqrt(1 - C_Lbeta,dynamic / (lambda cos tau)) and the friction over the wetted bottom
//   lambda b^2 / cos beta by the ITTC-1957 line with a roughness allowance;
// - the equilibrium of the normal force, friction and thrust (vertical, horizontal and pitch: Ekman et al. eqs. 2.1 to 2.3).
// The keel's and chine's wetted lengths differ by b tan beta / (pi tan tau): the stagnation line runs from the keel at
// tan alpha = (pi / 2) tan tau / tan beta (Ghadimi et al. eq. 9) and reaches the chine b / 2 out.
//
// Measured: Shoemaker's prismatic model 29 (NACA TN 509, 1934; b 16 in, deadrise 20 degrees, 80 lb) as P. G. Alourdas,
// SNAME Greek Section 2016, tabulates it (read): the tests' drag and trim (planing.test in tests/ship.test.js).
import { cos, ln, pow, sin } from '@margoengine/math/pinned';
import { shipError } from './errors.js';

const DEG = 180 / Math.PI;

/** A prismatic planing hull: chine beam, m, deadrise, rad, mass, kg, and its centre of gravity and thrust line. */
export interface PlaningHull {
  readonly beam: number;
  readonly deadrise: number;
  readonly mass: number;
  /** The centre of gravity forward of the transom along the keel, m. */
  readonly lcg: number;
  /** Its height above the keel, m (default the friction's line, a quarter beam's deadrise rise: friction through G). */
  readonly vcg?: number;
  /** The thrust line's distance below G, m, and its angle to the keel, rad (default 0 and 0: thrust through G along the keel). */
  readonly thrustDepth?: number;
  readonly thrustAngle?: number;
}

/** Water and friction for a planing hull: density (1025), kinematic viscosity (1.19e-6 m^2/s), gravity, roughness allowance. */
export interface PlaningWater {
  readonly density?: number;
  readonly viscosity?: number;
  readonly gravity?: number;
  /** Delta C_F added to the ITTC-1957 line (default 0.0004, Savitsky's allowance for a full-size hull; 0 for a smooth model). */
  readonly roughness?: number;
}

/** A planing surface's forces at an attitude: the bottom's normal force and friction, N, and where and how it is wetted. */
export interface PlaningLoads {
  /** The pressure's force normal to the bottom, N, and the friction along the keel, N. */
  normal: number;
  friction: number;
  /** The centre of pressure forward of the transom along the keel, m. */
  centre: number;
  /** Mean wetted length over beam, and the keel's and chine's wetted lengths, m. */
  lambda: number;
  keel: number;
  chine: number;
  /** C_v = V / sqrt(g b), C_Lbeta, and the dynamic part of C_Lbeta (the flat plate's 0.0120 term, deadrise-corrected). */
  speedCoefficient: number;
  lift: number;
  dynamic: number;
  /** Whether Savitsky's regression covers it: 0.6 <= C_v <= 13, 2 <= tau <= 15 degrees, lambda <= 4, chines wetted. */
  inRange: boolean;
}

/** A planing hull running steady: its trim, rad, the loads at it, the thrust it needs, N, and its resistance, N. */
export interface PlaningRun extends PlaningLoads {
  trim: number;
  thrust: number;
  resistance: number;
}

function check(hull: PlaningHull): void {
  const { beam, deadrise, mass, lcg } = hull ?? ({} as PlaningHull);
  if (
    !(beam > 0 && mass > 0 && lcg > 0 && deadrise >= 0 && deadrise < Math.PI / 2) ||
    ![beam, mass, lcg, deadrise, hull.vcg ?? 0, hull.thrustDepth ?? 0, hull.thrustAngle ?? 0].every(Number.isFinite)
  )
    throw shipError(
      `A planing hull is {beam, deadrise, mass, lcg}: beam, mass and lcg finite and above 0, deadrise 0 to under pi / 2 rad (got ${[beam, deadrise, mass, lcg].join(', ')}); pass them.`,
    );
}

function water(options: PlaningWater): Required<PlaningWater> {
  const w = {
    density: options.density ?? 1025,
    viscosity: options.viscosity ?? 1.19e-6,
    gravity: options.gravity ?? 9.80665,
    roughness: options.roughness ?? 0.0004,
  };
  if (!(w.density > 0 && w.viscosity > 0 && w.gravity > 0 && w.roughness >= 0) || !Object.values(w).every(Number.isFinite))
    throw shipError(
      `Planing water needs a density, viscosity and gravity above 0 and a roughness of 0 or more (got ${Object.values(w).join(', ')}); pass them.`,
    );
  return w;
}

/** The flat plate's dynamic and buoyant lift coefficients at trim `t` degrees, lambda and C_v. */
function plate(t: number, lambda: number, cv: number): [number, number] {
  const tt = pow(t, 1.1);
  return [tt * 0.012 * Math.sqrt(lambda), (tt * 0.0055 * pow(lambda, 2.5)) / (cv * cv)];
}

/** C_Lbeta from C_L0 for deadrise `b` degrees. */
function deadriseLift(cl0: number, b: number): number {
  return cl0 > 0 ? cl0 - 0.0065 * b * pow(cl0, 0.6) : 0;
}

/**
 * The bottom's loads at a trim `trim` rad and a mean wetted length over beam `lambda`, at `speed` m/s (Savitsky 1964). An
 * `attack` rad, the bottom's own sinking or pitching over the speed, adds to the trim in the lift (quasi-steady).
 */
export function planingLoads(
  hull: PlaningHull,
  trim: number,
  lambda: number,
  speed: number,
  options: PlaningWater & { readonly attack?: number } = {},
): PlaningLoads {
  check(hull);
  const w = water(options),
    b = hull.beam,
    beta = hull.deadrise * DEG,
    t = trim * DEG,
    te = Math.max(0, (trim + (options.attack ?? 0)) * DEG),
    cv = speed / Math.sqrt(w.gravity * b),
    q = 0.5 * w.density * speed * speed,
    out: PlaningLoads = {
      normal: 0,
      friction: 0,
      centre: 0,
      lambda,
      keel: 0,
      chine: 0,
      speedCoefficient: cv,
      lift: 0,
      dynamic: 0,
      inRange: false,
    };
  if (!(lambda > 0 && t > 0 && speed > 0)) return out;
  const [dynamic, buoyant] = plate(te, lambda, cv),
    cl0 = dynamic + buoyant,
    clb = deadriseLift(cl0, beta),
    // The deadrise's share of the dynamic part, for the bottom velocity.
    dyn = deadriseLift(plate(t, lambda, cv)[0], beta),
    ct = cos(trim),
    vm = speed * Math.sqrt(Math.max(0, 1 - dyn / (lambda * ct))),
    re = (vm * lambda * b) / w.viscosity,
    log = ln(re) * 0.4342944819032518 - 2,
    cf = re > 0 ? 0.075 / (log * log) + w.roughness : 0,
    cp = 0.75 - 1 / ((5.21 * cv * cv) / (lambda * lambda) + 2.39),
    rise = (b * sin(hull.deadrise)) / cos(hull.deadrise) / (Math.PI * (sin(trim) / ct));
  out.lift = clb;
  out.dynamic = dyn;
  out.normal = (q * b * b * clb) / ct;
  out.friction = (0.5 * w.density * vm * vm * cf * lambda * b * b) / cos(hull.deadrise);
  out.centre = cp * lambda * b;
  out.keel = lambda * b + rise / 2;
  out.chine = lambda * b - rise / 2;
  out.inRange = cv >= 0.6 && cv <= 13 && t >= 2 && t <= 15 && lambda <= 4 && out.chine > 0;
  return out;
}

/**
 * A planing hull running steady at `speed` m/s (Savitsky 1964): the trim and wetted length where the normal force, the
 * friction and the thrust hold its weight and balance in pitch (Ekman et al. 2016, eqs. 2.1 to 2.3), and the thrust that
 * takes, N. With the thrust and friction through G this is Savitsky's first case.
 */
export function savitsky(hull: PlaningHull, speed: number, options: PlaningWater = {}): PlaningRun {
  check(hull);
  const w = water(options);
  if (!(speed > 0 && Number.isFinite(speed)))
    throw shipError(`A planing speed is finite m/s above 0 (got ${speed}); pass one.`);
  const weight = hull.mass * w.gravity,
    eps = hull.thrustAngle ?? 0,
    f = hull.thrustDepth ?? 0,
    // The friction acts along the bottom, a quarter beam's deadrise rise above the keel.
    a = hull.vcg === undefined ? 0 : hull.vcg - (hull.beam / 4) * (sin(hull.deadrise) / cos(hull.deadrise)),
    balance = (trim: number, lambda: number) => {
      const l = planingLoads(hull, trim, lambda, speed, w),
        ct = cos(trim),
        st = sin(trim),
        thrust = (l.friction * ct + l.normal * st) / cos(trim + eps);
      return {
        l,
        thrust,
        vertical: l.normal * ct + thrust * sin(trim + eps) - l.friction * st - weight,
        moment: l.normal * (hull.lcg - l.centre) + l.friction * a - thrust * f,
      };
    },
    // The wetted length that holds the weight at a trim: the vertical balance rises with lambda.
    wetted = (trim: number) => {
      let lo = 1e-4,
        hi = 60;
      for (let i = 0; i < 80; i++) {
        const mid = 0.5 * (lo + hi);
        if (balance(trim, mid).vertical > 0) hi = mid;
        else lo = mid;
      }
      return 0.5 * (lo + hi);
    };
  // The trim that balances in pitch: the moment changes sign once over 0.2 to 30 degrees.
  let lo = 0.2 / DEG,
    hi = 30 / DEG;
  const sign = Math.sign(balance(lo, wetted(lo)).moment);
  if (sign === Math.sign(balance(hi, wetted(hi)).moment))
    throw shipError(
      `A planing hull at ${speed} m/s finds no trim from 0.2 to 30 degrees that balances it in pitch: its centre of gravity is too far forward or aft for its speed; move lcg, or run it faster.`,
    );
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (Math.sign(balance(mid, wetted(mid)).moment) === sign) lo = mid;
    else hi = mid;
  }
  const trim = 0.5 * (lo + hi),
    lambda = wetted(trim),
    { l, thrust } = balance(trim, lambda);
  return { ...l, trim, thrust, resistance: thrust * cos(trim + eps) };
}
