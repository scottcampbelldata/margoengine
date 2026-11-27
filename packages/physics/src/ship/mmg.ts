// A ship's manoeuvring (SEA-09): the MMG standard method of H. Yasukawa and Y. Yoshimura, "Introduction of MMG standard
// method for ship maneuvering predictions", J. Mar. Sci. Technol. 20, 37-52, 2015, doi:10.1007/s00773-014-0293-y (read, with
// its tables: the KVLCC2 particulars, hydrodynamic derivatives, interaction constants and the turning and zig-zag results
// the tests hold). Surge, sway and yaw about the midship (eq. 4): the hull's forces as polynomials of the drift and the yaw
// rate (eq. 7), the propeller's thrust through the wake it works in (eqs. 8 to 16), and the rudder's normal force in the
// propeller's race with the hull's flow straightening (eqs. 18 to 25), integrated by fourth-order Runge-Kutta.
//
// Heel (a fourth degree of freedom, roll): Y. Fukui, H. Yokota, H. Yano, M. Kondo, T. Nakano and Y. Yoshimura, "4-DOF
// mathematical model for manoeuvring simulation including roll motion", J. JASNAOE 24, 167-179, 2016,
// doi:10.2534/jjasnaoe.24.167 (all pages read): the hull's forces gain heel terms from captive tests at fixed heel (eq. 6),
// the roll moment about the centre of gravity balances the hull's and rudder's moments, the added masses' reaction at z_H,
// the restoring moment g m GM and the roll damping from the decay test's linear coefficient a (eqs. 4 and 5), and the
// rudder's forces carry cos(phi), its flow straightening (1 + c_gamma |phi|) and the roll rate's inflow (eqs. 7 to 9). The
// further heel terms of H. Yasukawa and N. Hirata, J. JASNAOE 17, 19-29, 2013 (v' phi^2, r' phi^2, phi^2; read) are in
// the same lists. The restoring moment is g m GM sin(phi), as H. Yasukawa, J. JASNAOE 4, 127-136, 2006, writes it (read).
//
// Axes: MMG's ship axes are x forward, y to starboard, z down; on the world's ground plane (x, z) with y up, the ship's
// position is (x, z) and its heading psi turns from +X toward +Z (a ship heading +X turns to starboard toward +Z).
import { cos, exp, sin } from '@margoengine/math/pinned';
import { atan2, Propeller, type PropellerCurves, KVLCC2_PROPELLER } from './propeller.js';
import { shipError } from './errors.js';
import { KVLCC2_SHALLOW, type ShallowTable } from './shallow.js';
import {
  type DriftLoads,
  driftLoads,
  type IrregularWaves,
  irregularDriftLoads,
  type RegularWaves,
  type WaveHull,
} from './waves.js';

const DEG = 3.141592653589793 / 180;

/** A ship's MMG model: its particulars, hydrodynamic derivatives and hull-propeller-rudder interaction constants. */
export interface ManoeuvringModel {
  /** Length between perpendiculars, beam and draught, m. */
  readonly length: number;
  readonly beam: number;
  readonly draught: number;
  /** Displaced volume, m^3. */
  readonly volume: number;
  /** Centre of gravity forward of the midship, m. */
  readonly centre: number;
  /** Radius of gyration in yaw, m (default 0.25 of the length). */
  readonly gyration?: number;
  /** Non-dimensional added masses m'_x, m'_y and inertia J'_z (by 1/2 rho L^2 d and 1/2 rho L^4 d). */
  readonly addedMass: readonly [number, number, number];
  /** Resistance coefficient R'_0 in straight running (by 1/2 rho L d U^2). */
  readonly resistance: number;
  /** X'vv, X'vr, X'rr, X'vvvv. */
  readonly surge: readonly [number, number, number, number];
  /** Y'v, Y'r, Y'vvv, Y'vvr, Y'vrr, Y'rrr. */
  readonly sway: readonly [number, number, number, number, number, number];
  /** N'v, N'r, N'vvv, N'vvr, N'vrr, N'rrr. */
  readonly yaw: readonly [number, number, number, number, number, number];
  /**
   * How the hull's nonlinear terms read (default 'cubic', MMG's v'^3 and r'^3): 'kijima' takes the third and sixth of `sway`
   * and `yaw` as Kijima's (1990) v'|v'| and r'|r'| terms, evaluated as they were fitted.
   */
  readonly form?: 'cubic' | 'kijima';
  /** The propeller: diameter, m, its curves, its position x'_P, thrust deduction t_P, straight-run wake w_P0, wake constants C1, C2 (beta_P > 0), C2 (beta_P < 0). */
  readonly propeller: {
    readonly diameter: number;
    readonly curves: PropellerCurves;
    readonly position: number;
    readonly thrustDeduction: number;
    readonly wake: number;
    readonly wakeChange: readonly [number, number, number];
  };
  /** The rudder: area, m^2, span, m, lift slope f_alpha, t_R, a_H, x'_H, gamma_R (beta_R < 0), gamma_R (beta_R > 0), l'_R, epsilon, kappa, its position x'_R (default -0.5). */
  readonly rudder: {
    readonly area: number;
    readonly span: number;
    readonly liftSlope: number;
    readonly resistanceDeduction: number;
    readonly forceIncrease: number;
    readonly forcePosition: number;
    readonly straightening: readonly [number, number];
    readonly lever: number;
    readonly wakeRatio: number;
    readonly kappa: number;
    readonly position?: number;
  };
  /** Heel: the ship rolls as it turns (Fukui et al. 2016). Without it the ship stays upright (MMG's three degrees of freedom). */
  readonly heel?: ManoeuvringHeel;
  /**
   * The hull's shallow-water corrections from captive tests, which `shallowWater` uses in place of Ankudinov et al.'s factors
   * (default none: Ankudinov's).
   */
  readonly shallow?: ShallowTable;
}

/**
 * A ship's roll: its stability, inertia and damping, the levers of its hull's and rudder's side forces, and the heel terms
 * of its hull's forces (phi in radians, positive with the starboard side down, v' and r' as in the hull's other terms).
 * Lists may be shorter than given: missing terms are 0.
 */
export interface ManoeuvringHeel {
  /** Transverse metacentric height GM, m (above 0). */
  readonly metacentricHeight: number;
  /** The centre of gravity's depth below the water plane, m (negative above it). */
  readonly gravityDepth: number;
  /** Roll radius of gyration of the ship's own mass, m (default 0.4 of the beam, SIMMAN's k_xx for KCS and KVLCC2). */
  readonly gyration?: number;
  /** The roll added inertia J_xx over the ship's own I_xx (default 0.2, an assumption: no source read gives it). */
  readonly addedInertia?: number;
  /** The linear coefficient a of the roll decay curve, B_44 = (2 a / pi) sqrt(g m GM (I_xx + J_xx)) (default 0.035, Yasukawa and Yoshimura 2013's a_0). */
  readonly decay?: number;
  /** Depth of the hull's side force and of its added masses' reaction below the water plane, m (default half the draught, Fukui et al.). */
  readonly hullDepth?: number;
  /** Depth of the rudder's side force below the water plane, m (default the draught less half the rudder's span). */
  readonly rudderDepth?: number;
  /** c_gamma: the flow straightening at the rudder gamma_R (1 + c_gamma |phi|) (default 0). */
  readonly straightening?: number;
  /** X'_|phi|, X'_r phi, X'_vv |phi|, X'_rr |phi|, X'_v phi, X'_phi phi (added to X'_H). */
  readonly surge?: readonly number[];
  /** Y'_phi, Y'_v |phi|, Y'_r |phi|, Y'_vv phi, Y'_vr phi, Y'_rr phi, Y'_v phi phi, Y'_r phi phi (added to Y'_H). */
  readonly sway?: readonly number[];
  /** N'_phi, N'_v |phi|, N'_r |phi|, N'_vv phi, N'_vr phi, N'_rr phi, N'_v phi phi, N'_r phi phi (added to N'_H). */
  readonly yaw?: readonly number[];
  /**
   * The hull's roll moment about the water plane by 1/2 rho L d^2 U^2: K'_phi, K'_v, K'_r, K'_vv phi, K'_vr phi, K'_rr phi,
   * K'_vvv, K'_vvr, K'_vrr, K'_rrr, K'_v phi phi, K'_r phi phi. Without it K_H = -z_H Y_H (the side force at its depth).
   */
  readonly roll?: readonly number[];
}

/**
 * KVLCC2's L7 model (7 m; Yasukawa and Yoshimura 2015, tables 1 and 3): scale it with {@link scaleModel} (Froude) for the
 * 320 m tanker. The propeller's position x'_P is -0.48 (the SIMMAN 2008 particulars, not in the paper's tables).
 */
export const KVLCC2_L7: ManoeuvringModel = Object.freeze({
  length: 7,
  beam: 1.27,
  draught: 0.46,
  volume: 3.27,
  centre: 0.25,
  gyration: 1.75,
  addedMass: [0.022, 0.223, 0.011] as const,
  resistance: 0.022,
  surge: [-0.04, 0.002, 0.011, 0.771] as const,
  sway: [-0.315, 0.083, -1.607, 0.379, -0.391, 0.008] as const,
  yaw: [-0.137, -0.049, -0.03, -0.294, 0.055, -0.013] as const,
  propeller: {
    diameter: 0.216,
    curves: KVLCC2_PROPELLER,
    position: -0.48,
    thrustDeduction: 0.22,
    wake: 0.4,
    wakeChange: [2.0, 1.6, 1.1] as const,
  },
  rudder: {
    area: 0.0539,
    span: 0.345,
    liftSlope: 2.747,
    resistanceDeduction: 0.387,
    forceIncrease: 0.312,
    forcePosition: -0.464,
    straightening: [0.395, 0.64] as const,
    lever: -0.71,
    wakeRatio: 1.09,
    kappa: 0.5,
  },
  shallow: KVLCC2_SHALLOW,
});

/** A model scaled by `factor` in length (Froude scaling: the non-dimensional coefficients stay; the heel's lengths scale too). */
export function scaleModel(model: ManoeuvringModel, factor: number): ManoeuvringModel {
  if (!(factor > 0 && Number.isFinite(factor)))
    throw shipError(`A scale is a finite factor above 0 (got ${factor}); pass one, such as 320 / 7.`);
  return {
    ...model,
    length: model.length * factor,
    beam: model.beam * factor,
    draught: model.draught * factor,
    volume: model.volume * factor * factor * factor,
    centre: model.centre * factor,
    gyration: (model.gyration ?? 0.25 * model.length) * factor,
    propeller: { ...model.propeller, diameter: model.propeller.diameter * factor },
    rudder: { ...model.rudder, area: model.rudder.area * factor * factor, span: model.rudder.span * factor },
    ...(model.heel && {
      heel: {
        ...model.heel,
        metacentricHeight: model.heel.metacentricHeight * factor,
        gravityDepth: model.heel.gravityDepth * factor,
        ...(model.heel.gyration !== undefined && { gyration: model.heel.gyration * factor }),
        ...(model.heel.hullDepth !== undefined && { hullDepth: model.heel.hullDepth * factor }),
        ...(model.heel.rudderDepth !== undefined && { rudderDepth: model.heel.rudderDepth * factor }),
      },
    }),
  };
}

/** The ship's state: position (x, z) m, heading rad, surge u and midship sway v m/s, yaw rate r rad/s, rudder angle rad. */
export interface ManoeuvringState {
  x: number;
  z: number;
  heading: number;
  u: number;
  v: number;
  r: number;
  rudder: number;
  /** Heel, rad (starboard down positive), and roll rate, rad/s: 0 for a model without {@link ManoeuvringModel.heel}. */
  heel?: number;
  rollRate?: number;
}

/** The forces on the ship at a state: surge X, sway Y (N, ship axes) and yaw N_m (N m about the midship), and the parts. */
export interface ManoeuvringForces {
  X: number;
  Y: number;
  N: number;
  thrust: number;
  rudderNormal: number;
  /** The rudder's inflow speed, m/s, and its angle of attack, rad. */
  rudderInflow: number;
  attack: number;
  /** Advance ratio of the propeller and its thrust coefficient. */
  advance: number;
  kt: number;
  /** The race's far-wake speed relative to the propeller, m/s, and the propeller's inflow speed, m/s. */
  race: number;
  inflow: number;
  /** The propeller's torque, N m. */
  torque: number;
  /** The hull's and rudder's roll moment about the centre of gravity, N m (starboard down positive; 0 without heel). */
  K: number;
  /** The waves' mean drift loads in it (Yasukawa 2006's X_W, Y_W, N_W; 0 without waves). */
  XW: number;
  YW: number;
  NW: number;
}

/**
 * A ship manoeuvring by the MMG standard method: give it the propeller's revolutions and the rudder's ordered angle, step it.
 * Rudder angles turn at `rudderRate` rad/s to the order; positive turns the ship to starboard (toward +Z from +X).
 */
export class Manoeuvring {
  model: ManoeuvringModel;
  /** The state, advanced by {@link step}. */
  readonly state: ManoeuvringState;
  /** The propeller's revolutions, rev/s (negative astern). */
  revolutions = 0;
  /** The rudder's ordered angle, rad. */
  order = 0;
  /** How fast the rudder turns, rad/s. */
  rudderRate: number;
  /** The most the rudder turns, rad (default 35 degrees). */
  rudderLimit = 35 * DEG;
  /** Simulated time, s. */
  time = 0;
  /** Work done so far: force evaluations and irregular-sea drift tables built (deterministic counts). */
  evaluations = 0;
  driftTables = 0;
  private readonly density: number;
  private readonly gravity: number;
  private mass = 0;
  private readonly propeller: Propeller;
  private matrix: [number, number, number, number, number] = [0, 0, 0, 0, 0];
  /** Roll: I_xx + J_xx, g m GM, B_44, z_H - z_G (all 0 without heel). */
  private roll: [number, number, number, number] = [0, 0, 0, 0];
  /** The hull's straight-run resistance at a speed, N, in place of R'_0 (a Holtrop and Mennen estimate), or none. */
  private readonly resistanceAt: ((speed: number) => number) | undefined;
  /** The waves it meets, regular or irregular, and its hull as they see it; and an irregular sea's loads tabled by heading. */
  waves: RegularWaves | IrregularWaves | undefined;
  private readonly waveHull: Partial<WaveHull>;
  private driftTable: { speed: number; key: string; loads: Float64Array } | undefined;
  private readonly drift: DriftLoads = { X: 0, Y: 0, N: 0 };

  /**
   * @param state The start: position, heading, velocities (default at rest, heading +X).
   * @param options `density` (default 1025), `gravity` (default 9.80665, for the heel's restoring moment), `rudderRate` (default 2.32 deg/s at full scale per sqrt of the scale, 1.76 deg/s
   * for KVLCC2), and `resistance`, the hull's straight-run resistance in N at a speed in m/s, used in place of R'_0 U^2 (a
   * Holtrop and Mennen estimate, whose wave resistance rises with the speed as a constant R'_0 cannot).
   */
  constructor(
    model: ManoeuvringModel,
    state: Partial<ManoeuvringState> = {},
    options: {
      readonly density?: number;
      readonly gravity?: number;
      readonly rudderRate?: number;
      readonly resistance?: (speed: number) => number;
      readonly waves?: RegularWaves | IrregularWaves;
      readonly waveHull?: Partial<WaveHull>;
    } = {},
  ) {
    for (const [name, value] of [
      ['length', model?.length],
      ['beam', model?.beam],
      ['draught', model?.draught],
      ['volume', model?.volume],
    ] as const)
      if (!(value! > 0 && Number.isFinite(value)))
        throw shipError(`A manoeuvring model's ${name} is finite and above 0 (got ${value}); pass it.`);
    this.model = model;
    this.density = options.density ?? 1025;
    this.gravity = options.gravity ?? 9.80665;
    if (options.resistance !== undefined && typeof options.resistance !== 'function')
      throw shipError("A hull's resistance is a function of the speed, m/s, giving N; pass one, or none for R'_0.");
    this.resistanceAt = options.resistance;
    this.waves = options.waves;
    this.waveHull = options.waveHull ?? {};
    this.state = { x: 0, z: 0, heading: 0, u: 0, v: 0, r: 0, rudder: 0, heel: 0, rollRate: 0, ...state };
    this.propeller = new Propeller(model.propeller.diameter, model.propeller.curves);
    this.rudderRate = options.rudderRate ?? 1.76 * DEG;
    this.setModel(model);
  }

  /**
   * Takes `model` in place of the ship's model (its hull derivatives and added masses in shallow water, say), with its mass
   * matrix worked out again; the state, propeller and rudder stay. The propeller's curves are the first model's.
   */
  setModel(model: ManoeuvringModel): this {
    this.model = model;
    const rho = this.density,
      L = model.length,
      d = model.draught,
      m = rho * model.volume,
      mass2 = 0.5 * rho * L * L * d,
      inertia4 = 0.5 * rho * L * L * L * L * d,
      [mx, my, jz] = model.addedMass,
      kz = model.gyration ?? 0.25 * L,
      xG = model.centre;
    this.mass = m;
    // Eq. 4's left side: [(m + m_x), (m + m_y), x_G m, I_zG + x_G^2 m + J_z].
    this.matrix = [m + mx * mass2, m + my * mass2, xG * m, m * kz * kz + xG * xG * m + jz * inertia4, xG];
    const H = model.heel;
    if (H) {
      const kx = H.gyration ?? 0.4 * model.beam,
        ixx = m * kx * kx * (1 + (H.addedInertia ?? 0.2)),
        c44 = this.gravity * m * H.metacentricHeight;
      for (const [name, value, least] of [
        ['metacentric height', H.metacentricHeight, 1e-300],
        ['roll gyration', kx, 1e-300],
        ['added roll inertia ratio', H.addedInertia ?? 0.2, 0],
        ['decay coefficient', H.decay ?? 0.035, 0],
      ] as const)
        if (!(value >= least && Number.isFinite(value)))
          throw shipError(
            `A ship's heel needs a finite ${name}${least > 0 ? ' above 0' : ' of 0 or more'} (got ${value}); pass one.`,
          );
      if (!Number.isFinite(H.gravityDepth))
        throw shipError(
          `A ship's heel needs the depth of its centre of gravity, m, finite (got ${H.gravityDepth}); pass it.`,
        );
      this.roll = [
        ixx,
        c44,
        ((2 * (H.decay ?? 0.035)) / Math.PI) * Math.sqrt(c44 * ixx),
        (H.hullDepth ?? 0.5 * d) - H.gravityDepth,
      ];
    } else this.roll = [0, 0, 0, 0];
    return this;
  }

  /** The forces at a state (eqs. 5 to 25). */
  forces(s: ManoeuvringState, out?: ManoeuvringForces): ManoeuvringForces {
    this.evaluations++;
    const o = out ?? {
        X: 0,
        Y: 0,
        N: 0,
        thrust: 0,
        rudderNormal: 0,
        rudderInflow: 0,
        attack: 0,
        advance: 0,
        kt: 0,
        race: 0,
        inflow: 0,
        torque: 0,
        K: 0,
        XW: 0,
        YW: 0,
        NW: 0,
      },
      M = this.model,
      H = M.heel,
      phi = H ? (s.heel ?? 0) : 0,
      aphi = Math.abs(phi),
      rho = this.density,
      L = M.length,
      d = M.draught,
      { u, v, r } = s,
      U = Math.sqrt(u * u + v * v);
    // The hull (eqs. 6 and 7).
    let XH = 0,
      YH = 0,
      NH = 0,
      KH = 0;
    if (U > 0) {
      const vp = v / U,
        rp = (r * L) / U,
        [xvv, xvr, xrr, xvvvv] = M.surge,
        [yv, yr, yvvv, yvvr, yvrr, yrrr] = M.sway,
        [nv, nr, nvvv, nvvr, nvrr, nrrr] = M.yaw,
        q = 0.5 * rho * L * d * U * U;
      // The straight run's resistance: R'_0 U^2, or the hull's own curve at the surge speed (a Holtrop and Mennen estimate).
      const straight = this.resistanceAt ? -Math.sign(u) * this.resistanceAt(Math.abs(u)) : -q * M.resistance;
      XH = straight + q * (xvv * vp * vp + xvr * vp * rp + xrr * rp * rp + xvvvv * vp * vp * vp * vp);
      // Kijima's form: v'|v'| and r'|r'| in place of v'^3 and r'^3.
      const kijima = M.form === 'kijima',
        vOdd = kijima ? vp * Math.abs(vp) : vp * vp * vp,
        rOdd = kijima ? rp * Math.abs(rp) : rp * rp * rp;
      YH = q * (yv * vp + yr * rp + yvvv * vOdd + yvvr * vp * vp * rp + yvrr * vp * rp * rp + yrrr * rOdd);
      NH = q * L * (nv * vp + nr * rp + nvvv * vOdd + nvvr * vp * vp * rp + nvrr * vp * rp * rp + nrrr * rOdd);
      if (H) {
        // The heel terms (Fukui et al. 2016, eq. 6; Yasukawa and Hirata 2013, eqs. 1 to 4).
        const [xa = 0, xrf = 0, xvva = 0, xrra = 0, xvf = 0, xff = 0] = H.surge ?? [],
          [ya = 0, yva = 0, yra = 0, yvvf = 0, yvrf = 0, yrrf = 0, yvff = 0, yrff = 0] = H.sway ?? [],
          [na = 0, nva = 0, nra = 0, nvvf = 0, nvrf = 0, nrrf = 0, nvff = 0, nrff = 0] = H.yaw ?? [],
          ff = phi * phi;
        XH +=
          q * (xa * aphi + xrf * rp * phi + xvva * vp * vp * aphi + xrra * rp * rp * aphi + xvf * vp * phi + xff * ff);
        YH +=
          q *
          (ya * phi +
            (yva * vp + yra * rp) * aphi +
            (yvvf * vp * vp + yvrf * vp * rp + yrrf * rp * rp) * phi +
            (yvff * vp + yrff * rp) * ff);
        NH +=
          q *
          L *
          (na * phi +
            (nva * vp + nra * rp) * aphi +
            (nvvf * vp * vp + nvrf * vp * rp + nrrf * rp * rp) * phi +
            (nvff * vp + nrff * rp) * ff);
        if (H.roll) {
          const [
            kf = 0,
            kv = 0,
            kr = 0,
            kvvf = 0,
            kvrf = 0,
            krrf = 0,
            kvvv = 0,
            kvvr = 0,
            kvrr = 0,
            krrr = 0,
            kvff = 0,
            krff = 0,
          ] = H.roll;
          KH =
            q *
            d *
            (kf * phi +
              kv * vp +
              kr * rp +
              (kvvf * vp * vp + kvrf * vp * rp + krrf * rp * rp) * phi +
              kvvv * vp * vp * vp +
              kvvr * vp * vp * rp +
              kvrr * vp * rp * rp +
              krrr * rp * rp * rp +
              (kvff * vp + krff * rp) * ff);
        } else KH = -(H.hullDepth ?? 0.5 * d) * YH;
      }
    }
    // The propeller (eqs. 8 to 16): the wake it works in changes with its geometrical inflow angle beta_P.
    const P = M.propeller,
      beta = U > 0 ? atan2(-v, u) : 0,
      rp = U > 0 ? (r * L) / U : 0,
      betaP = beta - P.position * rp,
      [c1, c2plus, c2minus] = P.wakeChange,
      c2 = betaP > 0 ? c2plus : c2minus,
      oneMinusW = (1 - P.wake) * (1 + (1 - exp(-c1 * Math.abs(betaP))) * (c2 - 1)),
      inflow = u * oneMinusW,
      load = this.propeller.load(this.revolutions, inflow, rho),
      thrust = load.thrust,
      XP = (1 - P.thrustDeduction) * thrust;
    // The rudder (eqs. 18 to 25).
    const R = M.rudder,
      eta = Math.min(1, P.diameter / R.span),
      // The race's speed-up: sqrt(1 + 8 K_T / (pi J^2)) = the far-wake over the inflow speed, by momentum.
      speedUp = inflow > 0 && thrust > 0 ? load.race / inflow : 1,
      uR =
        inflow > 0
          ? R.wakeRatio *
            inflow *
            Math.sqrt(eta * (1 + R.kappa * (speedUp - 1)) * (1 + R.kappa * (speedUp - 1)) + (1 - eta))
          : // Water from astern or a ship at rest: the race alone over the rudder's covered share.
            R.wakeRatio * Math.sqrt(eta) * R.kappa * Math.max(0, load.race) * (thrust > 0 ? 1 : 0) + Math.min(0, u),
      zG = H ? H.gravityDepth : 0,
      zR = H ? (H.rudderDepth ?? d - 0.5 * R.span) : 0,
      // The roll rate moves the rudder sideways: its inflow angle gains p (z_R - z_G) / U (Fukui et al., eq. 9).
      betaR = beta - R.lever * rp + (H && U > 0 ? ((s.rollRate ?? 0) * (zR - zG)) / U : 0),
      gammaR = (betaR < 0 ? R.straightening[0] : R.straightening[1]) * (1 + (H?.straightening ?? 0) * aphi),
      vR = U * gammaR * betaR,
      UR2 = uR * uR + vR * vR,
      attack = s.rudder - (uR !== 0 ? atan2(vR, Math.abs(uR)) : 0),
      FN = 0.5 * rho * R.area * UR2 * R.liftSlope * sin(attack),
      xR = (R.position ?? -0.5) * L,
      xH = R.forcePosition * L,
      // A heeled rudder's force is tilted: its horizontal part carries cos(phi) (eq. 8).
      cphi = H ? cos(phi) : 1,
      cd = cos(s.rudder) * cphi,
      sd = sin(s.rudder) * cphi,
      XR = -(1 - R.resistanceDeduction) * FN * sd,
      YR = -(1 + R.forceIncrease) * FN * cd,
      NR = -(xR + R.forceIncrease * xH) * FN * cd;
    // The waves' mean drift (Yasukawa 2006, eqs. 1 to 3).
    const w = this.waves ? this.waveDrift(s.heading, U) : null;
    o.XW = w ? w.X : 0;
    o.YW = w ? w.Y : 0;
    o.NW = w ? w.N : 0;
    o.X = XH + XR + XP + o.XW;
    o.Y = YH + YR + o.YW;
    o.N = NH + NR + o.NW;
    o.thrust = thrust;
    o.rudderNormal = FN;
    o.rudderInflow = Math.sqrt(UR2);
    o.attack = attack;
    o.advance = load.advance;
    o.kt = load.kt;
    o.race = load.race;
    o.inflow = inflow;
    o.torque = load.torque;
    // The roll moment about G: the hull's about the water plane moved to G, and the rudder's side force at its depth (eq. 4).
    o.K = H ? KH + zG * YH - (zR - zG) * YR : 0;
    return o;
  }

  /**
   * The waves' mean drift loads at `heading` rad and `speed` m/s: regular waves directly, an irregular sea from a table over
   * the waves' direction off the bow (5 degree steps), made again when the speed moves by 5 percent or the sea changes.
   */
  private waveDrift(heading: number, speed: number): DriftLoads {
    const M = this.model,
      hull: WaveHull = {
        length: M.length,
        beam: M.beam,
        draught: M.draught,
        block: M.volume / (M.length * M.beam * M.draught),
        ...this.waveHull,
      },
      waves = this.waves!;
    if ('amplitude' in waves) return driftLoads(hull, waves, heading, speed, this.gravity, this.density, this.drift);
    const key = `${waves.significantHeight},${waves.period},${waves.spread ?? 2},${M.length},${M.draught}`,
      steps = 72;
    let t = this.driftTable;
    if (!t || t.key !== key || Math.abs(speed - t.speed) > 0.05 * Math.max(t.speed, 1e-9)) {
      const loads = new Float64Array(3 * (steps + 1)),
        one: DriftLoads = { X: 0, Y: 0, N: 0 };
      for (let i = 0; i <= steps; i++) {
        irregularDriftLoads(
          hull,
          { ...waves, direction: (2 * Math.PI * i) / steps },
          0,
          speed,
          this.gravity,
          this.density,
          one,
        );
        loads[3 * i] = one.X;
        loads[3 * i + 1] = one.Y;
        loads[3 * i + 2] = one.N;
      }
      t = this.driftTable = { speed, key, loads };
      this.driftTables++;
    }
    let rel = (waves.direction - heading) / (2 * Math.PI);
    rel = (rel - Math.floor(rel)) * steps;
    const i = Math.min(steps - 1, Math.floor(rel)),
      f = rel - i,
      l = t.loads;
    this.drift.X = l[3 * i]! + f * (l[3 * i + 3]! - l[3 * i]!);
    this.drift.Y = l[3 * i + 1]! + f * (l[3 * i + 4]! - l[3 * i + 1]!);
    this.drift.N = l[3 * i + 2]! + f * (l[3 * i + 5]! - l[3 * i + 2]!);
    return this.drift;
  }

  /** The state's rates: d(x, z, heading, u, v, r, heel, roll rate)/dt from eq. 4 (and Fukui et al.'s roll, eq. 4). */
  private rates(s: ManoeuvringState, out: Float64Array): void {
    const f = this.forces(s),
      [mu, mv, xm, iz, xG] = this.matrix,
      m = this.mass,
      { u, v, r } = s,
      // Eq. 4: (m + m_x) u' = X + (m + m_y) v r + x_G m r^2; the sway and yaw rows coupled through x_G m.
      bu = f.X + mv * v * r + xG * m * r * r,
      bv = f.Y - mu * u * r,
      bn = f.N - xm * u * r,
      det = mv * iz - xm * xm,
      dv = (bv * iz - xm * bn) / det,
      dr = (mv * bn - xm * bv) / det,
      ch = cos(s.heading),
      sh = sin(s.heading);
    out[0] = u * ch - v * sh;
    out[1] = u * sh + v * ch;
    out[2] = r;
    out[3] = bu / mu;
    out[4] = dv;
    out[5] = dr;
    const [ixx, c44, b44, zHG] = this.roll;
    if (ixx > 0) {
      // (I_xx + J_xx) p' = (z_H - z_G)(m_y v' + m_x u r) + K - B_44 p - g m GM sin(phi).
      const p = s.rollRate ?? 0;
      out[6] = p;
      out[7] = (zHG * ((mv - m) * dv + (mu - m) * u * r) + f.K - b44 * p - c44 * sin(s.heel ?? 0)) / ixx;
    } else out[6] = out[7] = 0;
  }

  /** Advances the ship by `dt` s (fourth-order Runge-Kutta; the rudder turns toward its order at its rate first). */
  step(dt: number): this {
    if (!(dt > 0 && Number.isFinite(dt))) throw shipError(`A step is finite seconds above 0 (got ${dt}); pass one.`);
    const s = this.state,
      order = Math.max(-this.rudderLimit, Math.min(this.rudderLimit, this.order)),
      turn = this.rudderRate * dt;
    s.rudder += Math.max(-turn, Math.min(turn, order - s.rudder));
    const k = [new Float64Array(8), new Float64Array(8), new Float64Array(8), new Float64Array(8)],
      y0 = [s.x, s.z, s.heading, s.u, s.v, s.r, s.heel ?? 0, s.rollRate ?? 0],
      at = (y: number[]): ManoeuvringState => ({
        x: y[0]!,
        z: y[1]!,
        heading: y[2]!,
        u: y[3]!,
        v: y[4]!,
        r: y[5]!,
        rudder: s.rudder,
        heel: y[6]!,
        rollRate: y[7]!,
      }),
      add = (h: number, kk: Float64Array) => y0.map((y, i) => y + h * kk[i]!);
    this.rates(at(y0), k[0]!);
    this.rates(at(add(dt / 2, k[0]!)), k[1]!);
    this.rates(at(add(dt / 2, k[1]!)), k[2]!);
    this.rates(at(add(dt, k[2]!)), k[3]!);
    const y = y0.map((v, i) => v + (dt / 6) * (k[0]![i]! + 2 * k[1]![i]! + 2 * k[2]![i]! + k[3]![i]!));
    [s.x, s.z, s.heading, s.u, s.v, s.r, s.heel, s.rollRate] = y as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    this.time += dt;
    return this;
  }

  /**
   * The ship's sway and yaw linearised about a straight run at `speed` m/s, self-propelled, rudder amidships: d[v, r]/dt =
   * a [v, r] + b δ, as central differences of the model's own rates (a = [a_vv, a_vr, a_rv, a_rr], b = [b_v, b_r]). What an
   * autopilot places its poles on; a course-unstable hull shows as a positive eigenvalue of `a`.
   */
  linearize(speed: number): { a: [number, number, number, number]; b: [number, number] } {
    if (!(speed > 0 && Number.isFinite(speed)))
      throw shipError(`A speed is finite m/s above 0 (got ${speed}); pass one.`);
    const save = this.revolutions,
      L = this.model.length,
      out = new Float64Array(8),
      rate = (v: number, r: number, rudder: number): [number, number] => {
        this.rates({ x: 0, z: 0, heading: 0, u: speed, v, r, rudder }, out);
        return [out[4]!, out[5]!];
      };
    this.revolutions = this.selfPropulsion(speed);
    const dv = 1e-4 * speed,
      dr = (1e-4 * speed) / L,
      dd = 1e-4,
      [vp, rp] = [rate(dv, 0, 0), rate(-dv, 0, 0)],
      [vq, rq] = [rate(0, dr, 0), rate(0, -dr, 0)],
      [dp, dm] = [rate(0, 0, dd), rate(0, 0, -dd)];
    this.revolutions = save;
    return {
      a: [
        (vp[0] - rp[0]) / (2 * dv),
        (vq[0] - rq[0]) / (2 * dr),
        (vp[1] - rp[1]) / (2 * dv),
        (vq[1] - rq[1]) / (2 * dr),
      ],
      b: [(dp[0] - dm[0]) / (2 * dd), (dp[1] - dm[1]) / (2 * dd)],
    };
  }

  /**
   * The propeller revolutions, rev/s, at which the ship runs straight at `speed` m/s (thrust balancing R'_0 and `extra` N
   * more, an added resistance such as the waves' or the ice's): what the MMG method holds in its turning and zig-zag tests.
   */
  selfPropulsion(speed: number, extra = 0): number {
    if (!(speed > 0 && Number.isFinite(speed)))
      throw shipError(`A speed is finite m/s above 0 (got ${speed}); pass one.`);
    const M = this.model,
      resistance = this.resistanceAt
        ? this.resistanceAt(speed)
        : 0.5 * this.density * M.length * M.draught * speed * speed * M.resistance,
      inflow = speed * (1 - M.propeller.wake),
      need = resistance + Math.max(0, Number.isFinite(extra) ? extra : 0),
      save = this.revolutions;
    let lo = 1e-6,
      hi = 1e3;
    for (let i = 0; i < 200; i++) {
      const mid = Math.sqrt(lo * hi);
      this.revolutions = mid;
      const t = this.propeller.load(mid, inflow, this.density).thrust * (1 - M.propeller.thrustDeduction);
      if (t > need) hi = mid;
      else lo = mid;
    }
    this.revolutions = save;
    return Math.sqrt(lo * hi);
  }
}
