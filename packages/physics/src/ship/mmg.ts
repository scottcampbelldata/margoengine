// A ship's manoeuvring (SEA-09): the MMG standard method of H. Yasukawa and Y. Yoshimura, "Introduction of MMG standard
// method for ship maneuvering predictions", J. Mar. Sci. Technol. 20, 37-52, 2015, doi:10.1007/s00773-014-0293-y (read, with
// its tables: the KVLCC2 particulars, hydrodynamic derivatives, interaction constants and the turning and zig-zag results
// the tests hold). Surge, sway and yaw about the midship (eq. 4): the hull's forces as polynomials of the drift and the yaw
// rate (eq. 7), the propeller's thrust through the wake it works in (eqs. 8 to 16), and the rudder's normal force in the
// propeller's race with the hull's flow straightening (eqs. 18 to 25), integrated by fourth-order Runge-Kutta.
//
// Axes: MMG's ship axes are x forward, y to starboard, z down; on the world's ground plane (x, z) with y up, the ship's
// position is (x, z) and its heading psi turns from +X toward +Z (a ship heading +X turns to starboard toward +Z).
import { cos, exp, sin } from '@margoengine/math/pinned';
import { atan2, Propeller, type PropellerCurves, KVLCC2_PROPELLER } from './propeller.js';

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
});

/** A model scaled by `factor` in length (Froude scaling: the non-dimensional coefficients stay). */
export function scaleModel(model: ManoeuvringModel, factor: number): ManoeuvringModel {
  if (!(factor > 0 && Number.isFinite(factor)))
    throw new RangeError(`A scale is a finite factor above 0 (got ${factor}); pass one, such as 320 / 7.`);
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
}

/**
 * A ship manoeuvring by the MMG standard method: give it the propeller's revolutions and the rudder's ordered angle, step it.
 * Rudder angles turn at `rudderRate` rad/s to the order; positive turns the ship to starboard (toward +Z from +X).
 */
export class Manoeuvring {
  readonly model: ManoeuvringModel;
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
  private readonly density: number;
  private readonly mass: number;
  private readonly propeller: Propeller;
  private readonly matrix: [number, number, number, number, number];
  /** The hull's straight-run resistance at a speed, N, in place of R'_0 (a Holtrop and Mennen estimate), or none. */
  private readonly resistanceAt: ((speed: number) => number) | undefined;

  /**
   * @param state The start: position, heading, velocities (default at rest, heading +X).
   * @param options `density` (default 1025), `rudderRate` (default 2.32 deg/s at full scale per sqrt of the scale, 1.76 deg/s
   * for KVLCC2), and `resistance`, the hull's straight-run resistance in N at a speed in m/s, used in place of R'_0 U^2 (a
   * Holtrop and Mennen estimate, whose wave resistance rises with the speed as a constant R'_0 cannot).
   */
  constructor(
    model: ManoeuvringModel,
    state: Partial<ManoeuvringState> = {},
    options: {
      readonly density?: number;
      readonly rudderRate?: number;
      readonly resistance?: (speed: number) => number;
    } = {},
  ) {
    for (const [name, value] of [
      ['length', model?.length],
      ['beam', model?.beam],
      ['draught', model?.draught],
      ['volume', model?.volume],
    ] as const)
      if (!(value! > 0 && Number.isFinite(value)))
        throw new RangeError(`A manoeuvring model's ${name} is finite and above 0 (got ${value}); pass it.`);
    this.model = model;
    this.density = options.density ?? 1025;
    if (options.resistance !== undefined && typeof options.resistance !== 'function')
      throw new TypeError("A hull's resistance is a function of the speed, m/s, giving N; pass one, or none for R'_0.");
    this.resistanceAt = options.resistance;
    this.state = { x: 0, z: 0, heading: 0, u: 0, v: 0, r: 0, rudder: 0, ...state };
    this.propeller = new Propeller(model.propeller.diameter, model.propeller.curves);
    this.rudderRate = options.rudderRate ?? 1.76 * DEG;
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
  }

  /** The forces at a state (eqs. 5 to 25). */
  forces(s: ManoeuvringState, out?: ManoeuvringForces): ManoeuvringForces {
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
      },
      M = this.model,
      rho = this.density,
      L = M.length,
      d = M.draught,
      { u, v, r } = s,
      U = Math.sqrt(u * u + v * v);
    // The hull (eqs. 6 and 7).
    let XH = 0,
      YH = 0,
      NH = 0;
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
      betaR = beta - R.lever * rp,
      gammaR = betaR < 0 ? R.straightening[0] : R.straightening[1],
      vR = U * gammaR * betaR,
      UR2 = uR * uR + vR * vR,
      attack = s.rudder - (uR !== 0 ? atan2(vR, Math.abs(uR)) : 0),
      FN = 0.5 * rho * R.area * UR2 * R.liftSlope * sin(attack),
      xR = (R.position ?? -0.5) * L,
      xH = R.forcePosition * L,
      cd = cos(s.rudder),
      sd = sin(s.rudder),
      XR = -(1 - R.resistanceDeduction) * FN * sd,
      YR = -(1 + R.forceIncrease) * FN * cd,
      NR = -(xR + R.forceIncrease * xH) * FN * cd;
    o.X = XH + XR + XP;
    o.Y = YH + YR;
    o.N = NH + NR;
    o.thrust = thrust;
    o.rudderNormal = FN;
    o.rudderInflow = Math.sqrt(UR2);
    o.attack = attack;
    o.advance = load.advance;
    o.kt = load.kt;
    o.race = load.race;
    o.inflow = inflow;
    o.torque = load.torque;
    return o;
  }

  /** The state's rates: d(x, z, heading, u, v, r)/dt from eq. 4. */
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
  }

  /** Advances the ship by `dt` s (fourth-order Runge-Kutta; the rudder turns toward its order at its rate first). */
  step(dt: number): this {
    if (!(dt > 0 && Number.isFinite(dt)))
      throw new RangeError(`A step is finite seconds above 0 (got ${dt}); pass one.`);
    const s = this.state,
      order = Math.max(-this.rudderLimit, Math.min(this.rudderLimit, this.order)),
      turn = this.rudderRate * dt;
    s.rudder += Math.max(-turn, Math.min(turn, order - s.rudder));
    const k = [new Float64Array(6), new Float64Array(6), new Float64Array(6), new Float64Array(6)],
      y0 = [s.x, s.z, s.heading, s.u, s.v, s.r],
      at = (y: number[]): ManoeuvringState => ({
        x: y[0]!,
        z: y[1]!,
        heading: y[2]!,
        u: y[3]!,
        v: y[4]!,
        r: y[5]!,
        rudder: s.rudder,
      }),
      add = (h: number, kk: Float64Array) => y0.map((y, i) => y + h * kk[i]!);
    this.rates(at(y0), k[0]!);
    this.rates(at(add(dt / 2, k[0]!)), k[1]!);
    this.rates(at(add(dt / 2, k[1]!)), k[2]!);
    this.rates(at(add(dt, k[2]!)), k[3]!);
    const y = y0.map((v, i) => v + (dt / 6) * (k[0]![i]! + 2 * k[1]![i]! + 2 * k[2]![i]! + k[3]![i]!));
    [s.x, s.z, s.heading, s.u, s.v, s.r] = y as [number, number, number, number, number, number];
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
      throw new RangeError(`A speed is finite m/s above 0 (got ${speed}); pass one.`);
    const save = this.revolutions,
      L = this.model.length,
      out = new Float64Array(6),
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
   * The propeller revolutions, rev/s, at which the ship runs straight at `speed` m/s (thrust balancing R'_0): what the MMG
   * method holds in its turning and zig-zag tests.
   */
  selfPropulsion(speed: number): number {
    if (!(speed > 0 && Number.isFinite(speed)))
      throw new RangeError(`A speed is finite m/s above 0 (got ${speed}); pass one.`);
    const M = this.model,
      resistance = this.resistanceAt
        ? this.resistanceAt(speed)
        : 0.5 * this.density * M.length * M.draught * speed * speed * M.resistance,
      inflow = speed * (1 - M.propeller.wake),
      save = this.revolutions;
    let lo = 1e-6,
      hi = 1e3;
    for (let i = 0; i < 200; i++) {
      const mid = Math.sqrt(lo * hi);
      this.revolutions = mid;
      const t = this.propeller.load(mid, inflow, this.density).thrust * (1 - M.propeller.thrustDeduction);
      if (t > resistance) hi = mid;
      else lo = mid;
    }
    this.revolutions = save;
    return Math.sqrt(lo * hi);
  }
}
