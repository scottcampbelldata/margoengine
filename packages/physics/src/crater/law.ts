// The size of the crater a buried charge digs (EARTH-06), from its energy, its depth and the ground (docs/clean-room.md):
// - The scale: Holsapple and Housen's point-source scaling for explosions ("Craters from impacts and explosions", theory
//   notes v2.1, eq. 3 and Table 4, read): pi_V = K1 {pi_2 (rho / delta)^(-1/3) + (K2 pi_3)^((2 + mu) / 2)}^(-3 mu / (2 + mu)),
//   pi_V = rho V / W, pi_2 = (g / Q) (W / delta)^(1/3), pi_3 = Y / (rho Q), for a charge half buried; the scale length is
//   L = (pi_V W / rho)^(1/3). It runs from cube-root scaling for small charges (strength) to W^0.28 for large ones (gravity).
// - The burial: the crater's radius and depth over L against the cube-root scaled depth z = d / W^(1/3), m/kg^(1/3), fitted
//   to Nordyke's (UCRL-6578, 1961, Appendix A and Table III, read) desert-alluvium HE shots: the 256 lb series, Stagecoach 1
//   to 3 and Scooter. The radius rises as a parabola to its largest at z 0.705 and falls to nothing at 1.606, a mound and no
//   crater beyond; the depth peaks shallower and falls as a Gaussian. Validated on craters not fitted: NTS nuclear shots in
//   alluvium (Jangle U, Teapot ESS, Sedan), basalt and tuff (Buckboard, Danny Boy, Cabriolet, Schooner) and Fauld.
import { exp, pow } from '@margoengine/math/pinned';
import { craterError } from './errors.js';

/** A TNT kilogram's energy, J (the 1 kcal/g convention of every TNT equivalent): the charge's TNT weight W. */
const TNT = 4.184e6;
/** The explosive's specific energy Q, J/kg, and density delta, kg/m^3, in the scaling (Holsapple and Housen, after eq. 5). */
const SPECIFIC_ENERGY = 4.2e6;
const EXPLOSIVE_DENSITY = 1640;

/** The ground a charge digs into: Holsapple and Housen's explosion constants and what its crater's material does. */
export interface CraterGround {
  /** Bulk density, kg/m^3. */
  readonly density: number;
  /** K1, the scaling's constant for a half-buried charge. */
  readonly k1: number;
  /** mu, the coupling exponent (about 0.4 for dry soils, 0.55 for wet soil and rock). */
  readonly mu: number;
  /** The cratering strength Y, Pa (0 for cohesionless sand). */
  readonly strength: number;
  /** The share of the crater's mass thrown past its rim (default 0.6: Holsapple 2022; Sedan's measured 0.58). */
  readonly ejected?: number;
  /** The share lost to compaction (default 0); the rest of the crater's volume lifts its rim. */
  readonly compaction?: number;
  /** The bulk volume of thrown or fallen material over its volume in place (default 1). */
  readonly bulking?: number;
  /** The ejecta blanket's thickness exponent: thickness ~ r^-n beyond the rim (default 3, McGetchin et al. 1973). */
  readonly blanket?: number;
  /**
   * The ejecta's launch speed at the rim over sqrt(g R) (default 0.78: calibrated to Sedan's ejecta, half of it within two
   * crater radii, Nordyke and Williamson 1965; Housen and Holsapple's impacts into sand give 0.41, a buried burst's gas
   * throws faster).
   */
  readonly launch?: number;
}

/**
 * Holsapple and Housen's explosion constants (their Table 4; strength in Pa from its dyn/cm^2) with bulking from the
 * measured craters (Toman 1970: Danny Boy's basalt 1.33, Cabriolet's 1.09; Sedan's alluvium ejecta at its in-place density).
 */
export const CRATER_GROUNDS: Readonly<
  Record<'drySand' | 'drySoil' | 'wetSoil' | 'softRock' | 'hardRock' | 'ice', CraterGround>
> = Object.freeze({
  drySand: { density: 1700, k1: 0.12, mu: 0.4, strength: 0 },
  drySoil: { density: 1700, k1: 0.12, mu: 0.4, strength: 0.14e6 },
  wetSoil: { density: 2100, k1: 0.09, mu: 0.55, strength: 0.35e6 },
  softRock: { density: 2100, k1: 0.12, mu: 0.55, strength: 0.75e6, bulking: 1.09 },
  hardRock: { density: 3200, k1: 0.12, mu: 0.55, strength: 12e6, bulking: 1.33 },
  ice: { density: 930, k1: 0.12, mu: 0.55, strength: 0.5e6, bulking: 1.1 },
});

/** The radius over L against z: a parabola from 1.539 to 2.542 at z 0.705, then an ellipse to nothing at 1.606. */
const RADIUS = { surface: 1.539, peak: 2.542, at: 0.705, end: 1.606 };
/** The depth over L against z: a parabola from 0.461 to 1.163 at z 0.104, then a Gaussian of width 1.104. */
const DEPTH = { surface: 0.461, peak: 1.163, at: 0.104, width: 1.104 };

const square = (x: number): number => x * x;

/** A crater: its radius and depth at the original surface, m, its volume, m^3, and the scale length L, m. */
export interface CraterSize {
  readonly radius: number;
  readonly depth: number;
  /** The apparent crater's volume, a paraboloid's pi R^2 D / 2, m^3. */
  readonly volume: number;
  readonly scale: number;
  /** The cube-root scaled depth, m/kg^(1/3). */
  readonly scaledDepth: number;
  /** The time the crater takes to form, s: 0.8 sqrt(V^(1/3) / g) (Holsapple and Housen, eq. 6). */
  readonly formation: number;
}

/** Checks a ground, naming the first fault. */
export function checkGround(ground: CraterGround): void {
  const g = ground ?? ({} as CraterGround);
  for (const [name, value, ok] of [
    ['density', g.density, g.density > 0],
    ['k1', g.k1, g.k1 > 0],
    ['mu', g.mu, g.mu > 0 && g.mu < 1],
    ['strength', g.strength, g.strength >= 0],
    ['ejected', g.ejected ?? 0.6, (g.ejected ?? 0.6) >= 0 && (g.ejected ?? 0.6) <= 1],
    ['compaction', g.compaction ?? 0, (g.compaction ?? 0) >= 0 && (g.ejected ?? 0.6) + (g.compaction ?? 0) <= 1],
    ['bulking', g.bulking ?? 1, (g.bulking ?? 1) >= 1],
    ['blanket', g.blanket ?? 3, (g.blanket ?? 3) > 2],
    ['launch', g.launch ?? 0.78, (g.launch ?? 0.78) > 0],
  ] as const)
    if (!(ok && Number.isFinite(value)))
      throw craterError(
        `A crater ground's ${name} is out of range (got ${value}): density, k1 above 0, mu between 0 and 1, strength 0 or more, ejected and compaction shares summing to 1 or less, bulking 1 or more, blanket above 2, launch above 0. Use CRATER_GROUNDS or constants fitted to your ground.`,
      );
}

/**
 * The crater a charge of `energy` J digs with its centre `depth` m below the surface, in `ground`, under gravity `gravity`
 * m/s^2. A charge too deep (scaled depth past 1.606 m/kg^(1/3)) digs none: radius, depth and volume 0.
 * @throws MargoError for an energy not above 0, a negative depth or a ground out of range.
 */
export function craterSize(energy: number, depth: number, ground: CraterGround, gravity = 9.80665): CraterSize {
  if (!(energy > 0 && Number.isFinite(energy)) || !(depth >= 0 && Number.isFinite(depth)) || !(gravity > 0))
    throw craterError(
      `A crater needs a charge's energy above 0 J, its depth 0 or more m and gravity above 0 (got ${energy}, ${depth}, ${gravity}); pass them.`,
    );
  checkGround(ground);
  const { density: rho, k1, mu, strength } = ground,
    W = energy / TNT,
    pi2 = (gravity / SPECIFIC_ENERGY) * pow(W / EXPLOSIVE_DENSITY, 1 / 3),
    pi3 = strength / (rho * SPECIFIC_ENERGY),
    bracket = pi2 * pow(rho / EXPLOSIVE_DENSITY, -1 / 3) + pow(pi3, (2 + mu) / 2),
    piV = k1 * pow(bracket, (-3 * mu) / (2 + mu)),
    L = pow((piV * W) / rho, 1 / 3),
    z = depth / pow(W, 1 / 3),
    fr =
      z <= RADIUS.at
        ? RADIUS.peak - (RADIUS.peak - RADIUS.surface) * square(z / RADIUS.at - 1)
        : z >= RADIUS.end
          ? 0
          : RADIUS.peak * Math.sqrt(1 - square((z - RADIUS.at) / (RADIUS.end - RADIUS.at))),
    fd =
      z <= DEPTH.at
        ? DEPTH.peak - (DEPTH.peak - DEPTH.surface) * square(z / DEPTH.at - 1)
        : DEPTH.peak * exp(-square((z - DEPTH.at) / DEPTH.width)),
    radius = fr * L,
    craterDepth = fr > 0 ? fd * L : 0,
    volume = (Math.PI * radius * radius * craterDepth) / 2;
  return {
    radius,
    depth: craterDepth,
    volume,
    scale: L,
    scaledDepth: z,
    formation: volume > 0 ? 0.8 * Math.sqrt(pow(volume, 1 / 3) / gravity) : 0,
  };
}
