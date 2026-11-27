// The energy a high-explosive charge releases and where it goes (FIRE-05, docs/physics-solvers.md): the heat of detonation
// and its TNT equivalent, the speed it gives metal around it by Gurney's method, and, for a buried charge, the share that
// escapes into the air as a function of scaled depth.
//
// Sources (docs/clean-room.md):
// - J. E. Kennedy, "Gurney Energy of Explosives: Estimation of the Velocity and Impulse Imparted to Driven Metal", Sandia
//   SC-RR-70-790, 1970: the Gurney equations of its Fig. 3 (eqs 4, 6 to 9), their range 0.2 < M/C < 10 (Table 1), the
//   measured Gurney velocities and heats of detonation of Table 2, and E ~ 0.7 dHd (eq 16).
// - R. W. Gurney, "The Initial Velocities of Fragments from Bombs, Shell and Grenades", BRL report 405, 1943 (through Kennedy).
// - S. R. Ford, A. J. Rodgers, H. Xu et al., "Partitioning of seismoacoustic energy and estimation of yield and
//   height-of-burst/depth-of-burial for near-surface explosions", Bull. Seismol. Soc. Am. 104(2), 2014, in the form
//   Sonder et al. (2022) restate as their eq 9: the airborne impulse of a buried charge falls as
//   exp(-d/d3) / (1 + exp(-10 d/d3))^(1/10) with scaled depth d (m J^-1/3), d3 = 1.2e-3 m J^-1/3.
// - I. Sonder, A. H. Graettinger, T. Neeley et al., "Experimental multiblast craters and ejecta", J. Geophys. Res. Solid
//   Earth, 2022 (doi 10.1029/2022JB023952): scaled depth d / E^(1/3), and the 23 measured airborne energy fractions of
//   their Table 3 that validate the depth law here (they were not used to set it); the crater law of their eq 11 (from
//   Sonder, Graettinger and Valentine 2015) and their energy partition Eb = Ea + Es + Erem (eq 21), with the airborne and
//   seismic energy together about 17 % of a blast, which sets the default seismic coupling.
// - The crater work is the least mechanical work that empties a crater of the given size (lift and a throw past the rim at
//   the best angle, elementary ballistics), a lower bound that needs no ejecta law.
import { invalidExplosive } from './errors.js';
import { exp, pow } from '@margoengine/math/pinned';

/** Joules in a kilogram of TNT by the convention every TNT equivalent uses (1 kcal/g). */
export const TNT_JOULES_PER_KG = 4.184e6;

/** Joules a kilocalorie a gram is, per kilogram. */
const KCAL_PER_G = 4.184e6;

/** An explosive: its heat of detonation and, where it was measured, its Gurney velocity. */
export interface Explosive {
  readonly name: string;
  /** Heat of detonation, J/kg. */
  readonly heatOfDetonation: number;
  /** Measured Gurney velocity sqrt(2E), m/s, or undefined where only the heat is known. */
  readonly gurney?: number;
}

/** Kennedy (1970) Table 2: measured Gurney velocities (the first listed for each) and heats of detonation. */
export const EXPLOSIVES = {
  tnt: { name: 'TNT', heatOfDetonation: 1.09 * KCAL_PER_G, gurney: 2370 },
  rdx: { name: 'RDX', heatOfDetonation: 1.51 * KCAL_PER_G, gurney: 2830 },
  compB: { name: 'Composition B', heatOfDetonation: 1.2 * KCAL_PER_G, gurney: 2710 },
  hmx: { name: 'HMX', heatOfDetonation: 1.48 * KCAL_PER_G, gurney: 2970 },
  pbx9404: { name: 'PBX-9404', heatOfDetonation: 1.37 * KCAL_PER_G, gurney: 2900 },
  petn: { name: 'PETN', heatOfDetonation: 1.49 * KCAL_PER_G, gurney: 2930 },
  nitromethane: { name: 'nitromethane', heatOfDetonation: 1.23 * KCAL_PER_G, gurney: 2410 },
} as const satisfies Record<string, Explosive>;

/** Kennedy's eq 16: the Gurney energy is about 0.7 of the heat of detonation (0.61 to 0.76 measured; nitromethane 0.56). */
export const GURNEY_FRACTION = 0.7;

function finitePositive(value: number, what: string, fix: string): number {
  if (!(Number.isFinite(value) && value > 0))
    throw invalidExplosive(`${what} must be a finite number above 0; got ${value}. ${fix}`);
  return value;
}

/** The energy a charge of `mass` kg releases, J: its mass times its heat of detonation. */
export function chargeEnergy(mass: number, explosive: Explosive = EXPLOSIVES.tnt): number {
  finitePositive(mass, 'Charge mass', 'Give the explosive mass in kilograms.');
  return mass * finitePositive(explosive.heatOfDetonation, 'Heat of detonation', 'Give it in J/kg.');
}

/** The TNT equivalent, kg, of an energy in joules (4.184 MJ to the kilogram). */
export function tntEquivalent(energy: number): number {
  return finitePositive(energy, 'Explosion energy', 'Give it in joules.') / TNT_JOULES_PER_KG;
}

/**
 * The Gurney velocity sqrt(2E) of an explosive, m/s: the measured value where there is one, otherwise from the heat of
 * detonation by E = 0.7 dHd (Kennedy eq 16; within 10 % of every measured value of Table 2 but nitromethane's).
 */
export function gurneyVelocity(explosive: Explosive): number {
  if (explosive.gurney !== undefined) return finitePositive(explosive.gurney, 'Gurney velocity', 'Give it in m/s.');
  const heat = finitePositive(explosive.heatOfDetonation, 'Heat of detonation', 'Give it in J/kg.');
  return pow(2 * GURNEY_FRACTION * heat, 0.5);
}

/** A metal and charge arrangement Gurney's equations cover (Kennedy Fig. 3). */
export type GurneyGeometry = 'cylinder' | 'sphere' | 'flatSandwich' | 'openFacedSandwich' | 'asymmetricSandwich';

/**
 * The speed metal reaches when the charge under it detonates, m/s, by Gurney's equations (Kennedy 1970, Fig. 3):
 * `metalToCharge` is M/C, the metal mass over the charge mass, and `tamperToCharge` N/C the tamper's for an asymmetric
 * sandwich. Nominally 10 % uncertain; the fragments of a case that breaks early go up to 10 % slower.
 * @throws MargoError (`unsupported`) for an M/C outside 0.2 to 10, where the method no longer holds (Kennedy Table 1).
 */
export function metalSpeed(
  gurney: number,
  geometry: GurneyGeometry,
  metalToCharge: number,
  tamperToCharge = 0,
): number {
  finitePositive(gurney, 'Gurney velocity', 'Give it in m/s.');
  const m = metalToCharge;
  if (!(Number.isFinite(m) && m >= 0.2 && m <= 10))
    throw invalidExplosive(
      `Gurney's method holds for a metal to charge ratio of 0.2 to 10; got ${m}. Pass M/C inside it.`,
    );
  let inverse: number;
  switch (geometry) {
    case 'cylinder':
      inverse = m + 1 / 2;
      break;
    case 'sphere':
      inverse = m + 3 / 5;
      break;
    case 'flatSandwich':
      inverse = m + 1 / 3;
      break;
    case 'openFacedSandwich': {
      const a = 1 + 2 * m;
      inverse = (a * a * a + 1) / (6 * (1 + m)) + m;
      break;
    }
    case 'asymmetricSandwich': {
      const n = tamperToCharge;
      if (!(Number.isFinite(n) && n >= 0))
        throw invalidExplosive(`Tamper to charge ratio must be 0 or more; got ${n}. Pass N/C.`);
      const a = (1 + 2 * m) / (1 + 2 * n);
      inverse = (1 + a * a * a) / (3 * (1 + a)) + n * a * a + m;
      break;
    }
    default:
      throw invalidExplosive(
        `Unknown Gurney geometry "${geometry as string}"; use cylinder, sphere, flatSandwich, openFacedSandwich or asymmetricSandwich.`,
      );
  }
  return gurney * pow(inverse, -0.5);
}

/** Scaled depth d / E^(1/3), m J^-1/3, of a charge `depth` metres under the surface releasing `energy` joules. */
export function scaledDepth(depth: number, energy: number): number {
  if (!(Number.isFinite(depth) && depth >= 0))
    throw invalidExplosive(`Charge depth must be 0 or more metres; got ${depth}. Pass the depth of its centre.`);
  return depth / pow(finitePositive(energy, 'Explosion energy', 'Give it in joules.'), 1 / 3);
}

/** Ford et al.'s depth constant d3, m J^-1/3. */
export const AIR_DEPTH_SCALE = 1.2e-3;

/**
 * The share of a buried charge's energy that escapes into the air as a blast, 0 to 1, by Ford et al. (2014): the airborne
 * impulse falls as g(d) = exp(-d/d3) / (1 + exp(-10 d/d3))^(1/10) with scaled depth d, and blast energy goes as impulse to
 * the 3/2 (energy scales as distance cubed, impulse as distance), so the share is g(d)^(3/2) of a free-air burst: 0.90 at
 * the surface, 0.7 % at 4e-3 m J^-1/3. Sonder et al.'s 23 measured blasts lie above it by a factor of 1.8 on average
 * (spread a factor of 1.6), the difference between the two studies' reference charges that Sonder et al. note.
 */
export function airborneFraction(scaled: number): number {
  if (!(Number.isFinite(scaled) && scaled >= 0))
    throw invalidExplosive(`Scaled depth must be 0 or more; got ${scaled}. Pass depth / E^(1/3).`);
  const x = scaled / AIR_DEPTH_SCALE;
  const g = exp(-x) / pow(1 + exp(-10 * x), 0.1);
  return pow(g, 1.5);
}

/**
 * Sonder, Graettinger and Valentine's (2015) single-blast crater law: the scaled crater radius (m J^-1/3) against scaled
 * depth, a parabola up to the optimal depth and a decaying root beyond it (Sonder et al. 2022, eq 11).
 */
export interface CraterLaw {
  /** The scaled depth that digs the largest crater, m J^-1/3. */
  readonly optimalDepth: number;
  /** The largest scaled radius, at the optimal depth, m J^-1/3. */
  readonly maxRadius: number;
  /** The scaled radius of a charge at the surface, m J^-1/3. */
  readonly surfaceRadius: number;
  /** How fast the radius falls past the optimal depth, m^2 J^-2/3. */
  readonly decay: number;
}

/** The law's constants for an unconsolidated host and a TNT and PETN charge (Sonder et al. 2015, restated 2022). */
export const SONDER_CRATER_LAW: CraterLaw = {
  optimalDepth: 3.85e-3,
  maxRadius: 7.51e-3,
  surfaceRadius: 2.38e-3,
  decay: 1.72e-5,
};

/** The scaled crater radius, m J^-1/3, of a charge at scaled depth `scaled` (m J^-1/3) by Sonder et al.'s law. */
export function scaledCraterRadius(scaled: number, law: CraterLaw = SONDER_CRATER_LAW): number {
  if (!(Number.isFinite(scaled) && scaled >= 0))
    throw invalidExplosive(`Scaled depth must be 0 or more; got ${scaled}. Pass depth / E^(1/3).`);
  const { optimalDepth: o, maxRadius: m, surfaceRadius: s, decay: b } = law;
  for (const [value, what] of [
    [o, 'optimalDepth'],
    [m, 'maxRadius'],
    [b, 'decay'],
  ] as const)
    finitePositive(value, `Crater law ${what}`, 'Use SONDER_CRATER_LAW or constants fitted to your host.');
  if (!(Number.isFinite(s) && s >= 0 && s <= m))
    throw invalidExplosive(`Crater law surfaceRadius must be from 0 to maxRadius; got ${s}. Fit it to your host.`);
  if (scaled <= o) {
    const t = scaled / o - 1;
    return m - (m - s) * t * t;
  }
  const t = scaled - o;
  return m / pow(1 + (t * t) / b, 0.5);
}

/** The ground a charge is buried in, for its energy budget. */
export interface GroundOptions {
  /** Bulk density of the host, kg/m^3 (default 1800, a dry soil). */
  readonly density?: number;
  /** Gravity's magnitude, m/s^2 (default 9.81). */
  readonly gravity?: number;
  /**
   * The share of the ground energy radiated as elastic (seismic) waves, 0 to 1 (default 0.15, from Sonder et al.'s 2022
   * estimate that the airborne and seismic energy together were about 17 % of each blast in an unconsolidated host).
   */
  readonly seismicCoupling?: number;
  /** The crater's radius, m, where it is known (a survey, or the cratering solver); default from `law`. */
  readonly craterRadius?: number;
  /** The apparent crater's depth over its radius (default 0.5). */
  readonly depthRatio?: number;
  /** The crater law for the default radius (default {@link SONDER_CRATER_LAW}). */
  readonly law?: CraterLaw;
}

/** Where a charge's energy goes (joules). Every joule is in `air`, `groundShock`, `craterWork` or `heat`. */
export interface EnergyBudget {
  /** All the energy the charge releases. */
  readonly energy: number;
  /** Its TNT equivalent, kg. */
  readonly tntEquivalent: number;
  /** Scaled depth, m J^-1/3 (0 at or above the surface). */
  readonly scaledDepth: number;
  /** The share that leaves as an air blast (FIRE-04 reads it). */
  readonly air: number;
  /** The rest, held in the ground: `groundShock` + `craterWork` + `heat`. */
  readonly ground: number;
  /** Radiated as elastic waves in the ground (the seismic solvers read it). */
  readonly groundShock: number;
  /**
   * The least work that empties the crater: lifting its bowl to the surface and throwing it past the rim (the cratering
   * solver reads it). 0 for a charge in the air or one too deep to break the surface.
   */
  readonly craterWork: number;
  /** Dissipated in the ground as heat: the cavity's hot gas, crushing, friction and plastic work. */
  readonly heat: number;
  /** The crater's radius, m (0 for a charge in the air). */
  readonly craterRadius: number;
  /** The mass the crater moves, kg. */
  readonly craterMass: number;
}

/**
 * The energy budget of a charge releasing `energy` joules with its centre `depth` metres below the surface (0 for a
 * surface burst), in the ground `options` describes:
 * - `air` by Ford et al. ({@link airborneFraction});
 * - `groundShock`, the seismic coupling times the ground's share;
 * - `craterWork`, the least work to empty a paraboloid crater of radius R and depth h of host of density rho: its mass M =
 *   rho pi R^2 h / 2 raised by its centroid's depth h / 3 and thrown at least the radius R, which takes 1/2 M g R at the best
 *   angle, so M g (h / 3 + R / 2); never more than the ground's share left after the shock;
 * - `heat`, the rest.
 * `aboveGround` marks a charge in the air: it digs no crater and couples no shock (its blast loads the ground through
 * FIRE-04).
 */
export function energyBudget(
  energy: number,
  depth = 0,
  options: GroundOptions = {},
  aboveGround = false,
): EnergyBudget {
  const d = scaledDepth(depth, energy);
  const air = aboveGround ? energy : energy * airborneFraction(d);
  const ground = energy - air;
  const density = finitePositive(options.density ?? 1800, 'Ground density', 'Give it in kg/m^3.');
  const g = finitePositive(options.gravity ?? 9.81, 'Gravity', 'Give its magnitude in m/s^2.');
  const coupling = options.seismicCoupling ?? 0.15;
  if (!(Number.isFinite(coupling) && coupling >= 0 && coupling <= 1))
    throw invalidExplosive(`Seismic coupling must be from 0 to 1; got ${coupling}. Pass a share such as 0.15.`);
  const ratio = finitePositive(options.depthRatio ?? 0.5, 'Crater depth ratio', 'Pass depth over radius, such as 0.5.');
  let radius = 0;
  if (!aboveGround) {
    if (options.craterRadius !== undefined) {
      radius = options.craterRadius;
      if (!(Number.isFinite(radius) && radius >= 0))
        throw invalidExplosive(`Crater radius must be 0 or more metres; got ${radius}.`);
    } else radius = scaledCraterRadius(d, options.law) * pow(energy, 1 / 3);
  }
  const groundShock = ground * coupling;
  const h = radius * ratio;
  const craterMass = (density * Math.PI * radius * radius * h) / 2;
  const craterWork = Math.min(craterMass * g * (h / 3 + radius / 2), ground - groundShock);
  return {
    energy,
    tntEquivalent: tntEquivalent(energy),
    scaledDepth: d,
    air,
    ground,
    groundShock,
    craterWork,
    heat: ground - groundShock - craterWork,
    craterRadius: radius,
    craterMass,
  };
}
