// A gun's firing (FIRE-05): the propellant burning in the chamber, the shot driven down the bore, the gun's recoil, and the
// gas blowing down out of the muzzle after the shot has left. A lumped model in the tradition of Resal's energy equation
// and Lagrange's pressure gradient, as Corner (1950) sets out interior ballistics:
//
// - The propellant burns from its surface inward at r = beta p^alpha (p the mean space pressure); `f` is the fraction of
//   the web left, and the fraction burnt is z = (1 - f)(1 + theta f) (theta 1 for a cord, 0 for a tube or strip).
// - The gas obeys the Noble-Abel law, p (V - eta m) = m R T, and its internal energy is what the burnt propellant released,
//   lambda C z / (gamma - 1), less the kinetic energy of the shot, the gun and the gas, and the work the bore's resistance
//   took. That fixes the mean pressure from the free volume K0 + A x - (C / delta)(1 - z) - eta C z.
// - The gas moves with a velocity linear from the breech to the shot, so its momentum is C (U + V) / 2 and its kinetic
//   energy C (U^2 + U V + V^2) / 6. Its mean pressure is the shot base's times (1 + C / (3 W)) (Lagrange), and the breech
//   takes the base pressure plus what accelerates the gas, so momentum is conserved exactly: the gun recoils with what the
//   shot and the gas carry forward.
// - After the shot leaves, the bore empties through the muzzle as a choked nozzle until it can no longer choke; the thrust
//   of that flow, less the momentum the gas already had, is the after-effect on the gun.
//
// Sources (docs/clean-room.md): the Encyclopaedia Britannica, 11th edition (1911), "Ballistics" (interior ballistics), for
// Noble and Abel's closed-vessel pressures of pebble powder and cordite against gravimetric density (its Table 1), the
// cordite gas's 700 cc per gram at 0 C and 4758 K, the expansion index 1.2, the factor of effect 0.9 (here the
// losses are carried one by one), and the 6-in. gun firing used to calibrate cordite's burning rate and to validate the peak
// pressure; A. Noble and F. A. Abel, "Researches on explosives. Fired
// gunpowder", Phil. Trans. R. Soc. 165, 1875 (through that article); C. Corner, "Theory of the Interior Ballistics of
// Guns", 1950, for the lumped model's shape (known through its standard restatements, not read); J. D. Anderson, "Modern
// Compressible Flow", for the choked nozzle.
import { MargoError } from '@margoengine/math/errors';
import { pow } from '@margoengine/math/pinned';

/** Cordite's burning rate coefficient, m/s per Pa, calibrated so the 1911 article's 6-in. gun fires at 2150 ft/s. */
const CORDITE_BURN_RATE = 2.4295e-9;

/** A propellant: its Noble-Abel gas, its burning law and its solid density. */
export interface Propellant {
  readonly name: string;
  /** The force constant lambda = R T0 of its gas, J/kg. */
  readonly force: number;
  /** The covolume eta of its gas, m^3/kg. */
  readonly covolume: number;
  /** The ratio of specific heats of its gas (default 1.2, the expansion index the 1911 article takes for cordite). */
  readonly gamma?: number;
  /** The solid's density, kg/m^3. */
  readonly density: number;
  /** The burning rate coefficient beta, m/s per Pa^alpha: the surface regresses at beta p^alpha. */
  readonly burnRate?: number;
  /** The pressure index alpha of the burning law (default 1). */
  readonly pressureIndex?: number;
}

/**
 * Propellants with Noble-Abel constants fitted to Noble and Abel's closed-vessel pressures (1911 Britannica, Table 1,
 * 21 densities of loading from 0.05 to 0.6 each). Pebble powder's fit is within 5 % of every measurement, cordite's within
 * 14 % (8 % from a density of loading of 0.08 up; the lowest densities lose the most heat to the vessel). Cordite's burning
 * rate is calibrated to the 1911 article's 6-in. gun (2150 ft/s); pebble powder's was not measured there, so give one.
 * The solid densities are assumptions (a double-base propellant's 1560 kg/m^3; a black powder's 1700 kg/m^3).
 */
export const PROPELLANTS = {
  cordite: {
    name: 'cordite',
    force: 1.0158e6,
    covolume: 6.982e-4,
    gamma: 1.2,
    density: 1560,
    burnRate: CORDITE_BURN_RATE,
    pressureIndex: 1,
  },
  pebblePowder: { name: 'pebble powder', force: 2.539e5, covolume: 6.067e-4, gamma: 1.2, density: 1700 },
} as const satisfies Record<string, Propellant>;

/**
 * The pressure of a propellant burnt in a closed vessel, Pa, by the Noble-Abel law p = lambda Delta / (1 - eta Delta), with
 * `loading` the density of loading Delta, kg of propellant per m^3 of vessel (Noble and Abel's gravimetric density times
 * 1000).
 * @throws RangeError for a loading at or past the covolume's limit 1 / eta.
 */
export function closedVesselPressure(propellant: Propellant, loading: number): number {
  const lambda = positive(propellant.force, 'Propellant force', 'Give R T0 in J/kg.');
  const eta = nonNegative(propellant.covolume, 'Propellant covolume', 'Give it in m^3/kg.');
  nonNegative(loading, 'Density of loading', 'Give kg of propellant per m^3 of vessel.');
  if (eta * loading >= 1)
    fail(`A density of loading of ${loading} kg/m^3 fills the covolume (1 / eta = ${1 / eta}); load less.`);
  return (lambda * loading) / (1 - eta * loading);
}

/** A gun and its load. */
export interface GunOptions {
  /** The bore's diameter, m. */
  readonly bore: number;
  /** How far the shot travels to the muzzle, m. */
  readonly travel: number;
  /** The chamber's volume, m^3 (it must hold the charge). */
  readonly chamber: number;
  /** The shot's mass, kg. */
  readonly shotMass: number;
  /** The charge's mass, kg. */
  readonly charge: number;
  /** The propellant (default cordite). */
  readonly propellant?: Propellant;
  /** The grain's web: the distance the burning surface travels to consume it, m (a cord's radius). */
  readonly web: number;
  /** The grain's form coefficient theta (default 1, a cord; 0 a tube or strip; 2 a sphere). */
  readonly form?: number;
  /** The mass that recoils, kg (default fixed: the mounting holds the gun). */
  readonly recoilMass?: number;
  /**
   * The bore's resistance (engraving the bands, friction) as a share of the thrust on the shot base (default 0). The 1911
   * article's factor of effect of 0.9 lumps every loss; this model already carries the gas's kinetic energy and the
   * recoil, so a resistance is only for what is left.
   */
  readonly resistance?: number;
  /** The base pressure the shot needs before it moves, Pa (default 0, a loose ball). */
  readonly startPressure?: number;
  /**
   * The pressure the igniter raises in the chamber, Pa (default 2 MPa): the propellant starts from that much of itself
   * burnt. A burning rate that grows with pressure cannot start from none; the muzzle velocity moves under 1 % between 1
   * and 10 MPa.
   */
  readonly ignitionPressure?: number;
  /** The atmosphere's pressure at the muzzle, Pa (default 101325). */
  readonly atmosphere?: number;
  /** The integration step, s (default the travel over 4000 times an estimated muzzle speed). */
  readonly step?: number;
}

/** What a firing did. */
export interface Firing {
  /** The shot's speed relative to the gun as it leaves the muzzle, m/s. */
  readonly muzzleVelocity: number;
  /** The shot's speed over the ground as it leaves, m/s (the gun recoils the other way). */
  readonly shotVelocity: number;
  /** The time from ignition to the shot leaving the muzzle, s. */
  readonly muzzleTime: number;
  /** The highest mean space pressure, Pa, and the highest pressures at the breech and on the shot base. */
  readonly peakPressure: number;
  readonly peakBreech: number;
  readonly peakBase: number;
  /** The share of the charge burnt when the shot leaves, 0 to 1. */
  readonly burnt: number;
  /** The gun's momentum when the shot leaves, kg m/s, backward positive, and after the gas has blown down. */
  readonly recoilMomentumAtExit: number;
  readonly recoilMomentum: number;
  /** The gun's free recoil speed after the blowdown, m/s (0 for a fixed gun). */
  readonly recoilVelocity: number;
  /** The blowdown's time, s, and the impulse it gave the gun, N s, backward positive. */
  readonly blowdownTime: number;
  readonly afterEffect: number;
  /** The gas's internal energy at the muzzle (the muzzle blast's source), J, and its mass, kg. */
  readonly muzzleGasEnergy: number;
  readonly muzzleGasMass: number;
  /** The shot's kinetic energy over the charge's energy lambda C / (gamma - 1). */
  readonly efficiency: number;
  /**
   * The history, `HISTORY_WORDS` per row: time (s), shot travel (m), shot speed relative to the gun (m/s), mean pressure
   * (Pa), and the gun's backward momentum so far (kg m/s, the impulse the gas has given it), through the blowdown.
   */
  readonly history: Float64Array;
  /** Integration steps taken in the bore and in the blowdown. */
  readonly steps: number;
}

/** Words of a {@link Firing} history row. */
export const HISTORY_WORDS = 5;

const fail = (message: string): never => {
  throw new RangeError(message);
};

function positive(value: unknown, what: string, fix: string): number {
  if (typeof value !== 'number' || !(Number.isFinite(value) && value > 0))
    fail(`${what} must be a finite number above 0; got ${String(value)}. ${fix}`);
  return value as number;
}

function nonNegative(value: unknown, what: string, fix: string): number {
  if (typeof value !== 'number' || !(Number.isFinite(value) && value >= 0))
    fail(`${what} must be a finite number of 0 or more; got ${String(value)}. ${fix}`);
  return value as number;
}

const sqrt = (v: number) => pow(v, 0.5);

/**
 * Fire a gun: the shot's travel down the bore and the gas's blowdown after it.
 * @throws RangeError for a load that does not fit or a value that is not finite; MargoError ('state') for a charge too weak
 * to move the shot, or a propellant with no burning rate.
 */
export function fireGun(options: GunOptions): Firing {
  const d = positive(options.bore, 'Bore', 'Give the bore diameter in metres.');
  const L = positive(options.travel, 'Shot travel', 'Give the distance to the muzzle in metres.');
  const K0 = positive(options.chamber, 'Chamber volume', 'Give it in m^3.');
  const W = positive(options.shotMass, 'Shot mass', 'Give it in kilograms.');
  const C = positive(options.charge, 'Charge mass', 'Give it in kilograms.');
  const prop = options.propellant ?? PROPELLANTS.cordite;
  const lambda = positive(prop.force, 'Propellant force', 'Give R T0 in J/kg.');
  const eta = nonNegative(prop.covolume, 'Propellant covolume', 'Give it in m^3/kg.');
  const gamma = prop.gamma ?? 1.2;
  if (!(Number.isFinite(gamma) && gamma > 1 && gamma < 2))
    fail(`Propellant gamma must be between 1 and 2; got ${gamma}. Use about 1.2 for a propellant gas.`);
  const delta = positive(prop.density, 'Propellant density', 'Give the solid density in kg/m^3.');
  if (prop.burnRate === undefined)
    throw new MargoError(
      'state',
      `${prop.name} has no burning rate; give burnRate (m/s per Pa^pressureIndex) measured for it.`,
    );
  const beta = positive(prop.burnRate, 'Burning rate', 'Give beta in m/s per Pa^pressureIndex.');
  const alpha = positive(prop.pressureIndex ?? 1, 'Pressure index', 'Give alpha, such as 1.');
  const D = positive(options.web, 'Web', 'Give the distance the burning surface travels through a grain, in metres.');
  const theta = options.form ?? 1;
  if (!(Number.isFinite(theta) && theta >= -0.5 && theta <= 3))
    fail(`Form coefficient must be from -0.5 to 3; got ${theta}. Use 1 for a cord, 0 for a tube, 2 for a sphere.`);
  const M = options.recoilMass === undefined ? Infinity : positive(options.recoilMass, 'Recoil mass', 'Give it in kg.');
  const kappa = options.resistance ?? 0;
  if (!(Number.isFinite(kappa) && kappa >= 0 && kappa < 1))
    fail(`Resistance must be from 0 to under 1; got ${kappa}. Use a small share such as 0.05.`);
  const p0 = nonNegative(options.startPressure ?? 0, 'Start pressure', 'Give it in pascals.');
  const pa = nonNegative(options.atmosphere ?? 101325, 'Atmosphere', 'Give it in pascals.');
  if (C / delta >= K0)
    fail(`The charge's solid volume ${C / delta} m^3 does not fit the chamber of ${K0} m^3; make the chamber larger.`);
  if (eta * C >= K0)
    fail(`The charge's gas covolume ${eta * C} m^3 fills the chamber of ${K0} m^3; make the chamber larger.`);
  const A = (Math.PI * d * d) / 4;
  const E0 = (lambda * C) / (gamma - 1);
  const fixed = M === Infinity;
  const estimate = sqrt((2 * E0 * 0.3) / (W + C / 3));
  const h0 = options.step ?? L / (4000 * estimate);
  positive(h0, 'Step', 'Give the integration step in seconds.');

  // The igniter: the share z0 burnt that gives its pressure in the closed chamber, and the web left f0 for it.
  const pIgnite = positive(options.ignitionPressure ?? 2e6, 'Ignition pressure', 'Give it in pascals, such as 2e6.');
  const z0 = Math.min((pIgnite * (K0 - C / delta)) / (C * (lambda + pIgnite * (eta - 1 / delta))), 1);
  if (!(z0 > 0)) fail(`Ignition pressure ${pIgnite} Pa cannot be reached in this chamber; lower it.`);
  const f0 =
    theta === 0 ? 1 - z0 : (-(1 - theta) + pow((1 - theta) * (1 - theta) + 4 * theta * (1 - z0), 0.5)) / (2 * theta);
  // State: x (travel), V (shot, ground), U (gun, ground, forward positive), f (web left), Wr (resistance work).
  const y = [0, 0, 0, f0, 0];
  let moving = p0 === 0;
  let peak = 0,
    peakB = 0,
    peakS = 0;
  const burnt = (f: number) => (f > 0 ? (1 - f) * (1 + theta * f) : 1);
  const pressure = (s: readonly number[]): number => {
    const z = burnt(s[3]!);
    const V = s[1]!,
      U = s[2]!;
    const ke = 0.5 * W * V * V + (fixed ? 0 : 0.5 * M * U * U) + (C / 6) * (U * U + U * V + V * V);
    const free = K0 + A * s[0]! - (C / delta) * (1 - z) - eta * C * z;
    return ((gamma - 1) * (E0 * z - ke - s[4]!)) / free;
  };
  const derivative = (s: readonly number[], out: number[]): void => {
    const p = Math.max(pressure(s), 0);
    const base = p / (1 + C / (3 * W));
    out[3] = s[3]! > 0 ? (-beta * pow(p, alpha)) / D : 0;
    if (!moving) {
      out[0] = out[1] = out[2] = out[4] = 0;
      return;
    }
    const resist = kappa * A * base;
    const aV = (A * base - resist) / W;
    const aU = fixed ? 0 : -(A * base + (C * aV) / 2 - resist) / (M + C / 2);
    out[0] = s[1]! - s[2]!;
    out[1] = aV;
    out[2] = aU;
    out[4] = resist * (s[1]! - s[2]!);
  };
  const k1 = [0, 0, 0, 0, 0],
    k2 = [0, 0, 0, 0, 0],
    k3 = [0, 0, 0, 0, 0],
    k4 = [0, 0, 0, 0, 0],
    t2 = [0, 0, 0, 0, 0];
  const rk4 = (s: readonly number[], h: number, out: number[]): void => {
    derivative(s, k1);
    for (let i = 0; i < 5; i++) t2[i] = s[i]! + 0.5 * h * k1[i]!;
    derivative(t2, k2);
    for (let i = 0; i < 5; i++) t2[i] = s[i]! + 0.5 * h * k2[i]!;
    derivative(t2, k3);
    for (let i = 0; i < 5; i++) t2[i] = s[i]! + h * k3[i]!;
    derivative(t2, k4);
    for (let i = 0; i < 5; i++) out[i] = s[i]! + (h / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!);
    if (out[3]! < 0) out[3] = 0;
  };
  const gunMomentum = (s: readonly number[]) => (fixed ? W * s[1]! + (C * s[1]!) / 2 : -M * s[2]!);
  const history: number[] = [];
  const record = (t: number, s: readonly number[], p: number) =>
    history.push(t, s[0]!, s[1]! - s[2]!, p, gunMomentum(s));
  let t = 0,
    steps = 0;
  const next = [0, 0, 0, 0, 0];
  record(0, y, pressure(y));
  const limit = 2e6;
  while (y[0]! < L) {
    if (steps > limit || (!moving && y[3] === 0))
      throw new MargoError(
        'state',
        `The charge cannot drive the shot out: it ${moving ? 'stalls in the bore' : 'never reaches the start pressure'}. Use a larger charge, a lighter shot or a lower start pressure.`,
      );
    rk4(y, h0, next);
    let h = h0;
    if (next[0]! > L) {
      // Land the last step on the muzzle: two secant corrections of its length.
      for (let k = 0; k < 2; k++) {
        h = (h * (L - y[0]!)) / (next[0]! - y[0]!);
        rk4(y, h, next);
      }
      next[0] = L;
    }
    for (let i = 0; i < 5; i++) y[i] = next[i]!;
    t += h;
    steps++;
    const p = pressure(y);
    if (!moving && p / (1 + C / (3 * W)) >= p0) moving = true;
    const base = p / (1 + C / (3 * W));
    if (p > peak) peak = p;
    if (base > peakS) peakS = base;
    const aV = moving ? (A * base * (1 - kappa)) / W : 0;
    const breech = base + (C * aV) / (2 * A);
    if (breech > peakB) peakB = breech;
    record(t, y, p);
  }
  const muzzleTime = t;
  const z = burnt(y[3]!);
  const V = y[1]!,
    U = y[2]!;
  const exitMomentum = gunMomentum(y);
  // The blowdown: the bore's gas (a stagnant reservoir in the gun's frame) choking through the muzzle.
  let m = C * z;
  const bore = K0 + A * L - (C / delta) * (1 - z);
  let pBore = pressure(y);
  let e = (pBore * (bore - eta * m)) / (gamma - 1);
  const muzzleGasEnergy = e,
    muzzleGasMass = m;
  const crit = 2 / (gamma + 1);
  const pStar = pow(crit, gamma / (gamma - 1));
  let thrust = 0,
    tb = 0;
  // The gas already carried C (V - U) / 2 forward relative to the gun; what leaves takes its share of that with it.
  const relativeGas = (C * (V - U)) / 2;
  const share = (left: number) => relativeGas * (1 - left / muzzleGasMass);
  while (pBore * pStar > pa && m > 0) {
    const rt = (pBore * (bore - eta * m)) / m;
    const aStar = sqrt(gamma * rt * crit);
    const rhoStar = (pBore * pStar) / (rt * crit);
    const flow = rhoStar * aStar * A;
    const force = flow * aStar + (pBore * pStar - pa) * A;
    const enthalpy = (e + pBore * bore) / m;
    // A step of a fiftieth of the emptying time m / flow.
    const h = (0.02 * m) / flow;
    m -= flow * h;
    e -= flow * enthalpy * h;
    thrust += force * h;
    tb += h;
    steps++;
    if (m <= 0 || e <= 0 || steps > limit) break;
    pBore = ((gamma - 1) * e) / (bore - eta * m);
    history.push(muzzleTime + tb, L, V - U, pBore, exitMomentum + thrust - share(m));
  }
  const afterEffect = thrust - share(Math.max(m, 0));
  const recoil = exitMomentum + afterEffect;
  const ke = 0.5 * W * V * V;
  return {
    muzzleVelocity: V - U,
    shotVelocity: V,
    muzzleTime,
    peakPressure: peak,
    peakBreech: peakB,
    peakBase: peakS,
    burnt: z,
    recoilMomentumAtExit: exitMomentum,
    recoilMomentum: recoil,
    recoilVelocity: fixed ? 0 : recoil / M,
    blowdownTime: tb,
    afterEffect,
    muzzleGasEnergy,
    muzzleGasMass,
    efficiency: ke / E0,
    history: Float64Array.from(history),
    steps,
  };
}
