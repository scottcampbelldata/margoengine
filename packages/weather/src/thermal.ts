// An instantaneous release: the buoyant thermal of a large explosion (an ammunition dump, a quarry blast, a buried
// charge), rising as a mushroom cloud over film time. Every output is a function of the film time and the seed alone:
// the rise is solved once per source when it is made (fourth-order Runge-Kutta in time, steps of 1/20 s) and read back
// by interpolation, so a seek, a re-render or a frame rendered out of order gives the same cloud. Sources (papers, read
// as text; no code; docs/clean-room.md "Blast thermal"):
// - B. R. Morton, G. I. Taylor and J. S. Turner, "Turbulent gravitational convection from maintained and instantaneous
//   sources", Proc. R. Soc. Lond. A 234(1196), 1-23, 1956, https://doi.org/10.1098/rspa.1956.0011: the instantaneous
//   source (a thermal) as a top-hat cloud of radius b entraining ambient air at a speed proportional to its own, so in
//   still air b grows linearly with height, its volume flux and buoyancy obey d(b^3)/dt = 3 alpha b^2 w and
//   d(b^3 g')/dt = -N^2 b^3 w, and in stable air it stops at a height proportional to B^(1/4) N^(-1/2).
// - R. S. Scorer, "Experiments on convection of isolated masses of buoyant fluid", J. Fluid Mech. 2(6), 583-594, 1957,
//   https://doi.org/10.1017/S0022112057000397: laboratory thermals spread with b / z near 0.25 (our default
//   `entrainment`), and in uniform surroundings rise as z proportional to (B t^2)^(1/4).
// - J. S. Turner, "Buoyant vortex rings", Proc. R. Soc. Lond. A 239(1216), 61-75, 1957,
//   https://doi.org/10.1098/rspa.1957.0023: a thermal carries its buoyancy in a rising vortex ring, the mushroom's cap,
//   whose circulation draws the dust under it up the stem.
// - M. P. Escudier and T. Maxworthy, "On the motion of turbulent thermals", J. Fluid Mech. 61(3), 541-552, 1973,
//   https://doi.org/10.1017/S0022112073000856: the thermal's momentum includes the ambient fluid it pushes aside, an
//   added mass coefficient near that of a sphere, 1/2 (our default `addedMass`), and a thermal much lighter than its
//   surroundings carries its own small mass plus that added mass, so a hot start accelerates far harder than the
//   Boussinesq equations allow.
// - F. P. Ricou and D. B. Spalding, "Measurements of entrainment by axisymmetrical turbulent jets", J. Fluid Mech.
//   11(1), 21-32, 1961, https://doi.org/10.1017/S0022112061000834, and B. R. Morton, "Modeling fire plumes", Symp.
//   (Int.) Combust. 10(1), 973-982, 1965, https://doi.org/10.1016/S0082-0784(65)80240-5: a light flow entrains mass at
//   the rate of a Boussinesq one times (rho / rho_a)^(1/2).
// - J. S. Turner, "Buoyant plumes and thermals", Annu. Rev. Fluid Mech. 1, 29-44, 1969,
//   https://doi.org/10.1146/annurev.fl.01.010169.000333: the review of the entrainment equations used here.
// - T. B. Benjamin, "Gravity currents and related phenomena", J. Fluid Mech. 31(2), 209-248, 1968,
//   https://doi.org/10.1017/S0022112068000133, and M. Ungarish, "An Introduction to Gravity Currents and Intrusions",
//   CRC Press, 2009, ch. 13 to 15: an intrusion into stratified air advances at a Froude number times N h, so a cap of
//   fixed volume V that stops at its neutral height spreads as R^3 = R_s^3 + (3 Fr / pi) N V t (Fr 0.5, a model
//   choice): the umbrella.
// - P. D. Kaye and P. F. Linden, "Coalescing axisymmetric turbulent plumes", J. Fluid Mech. 502, 41-63, 2004: two
//   buoyant flows merge into one once their edges touch; here two caps blend into one thermal of their summed volume
//   as their spheres overlap.
// - A. Bouthors and F. Neyret, "Modeling clouds shape", Eurographics 2004 short papers, and F. Neyret, "Qualitative
//   simulation of convective cloud formation and evolution", Eurographics Workshop on Animation and Simulation, 1997,
//   113-124: a convective cloud's cauliflower surface as a hierarchy of blobs, each level's blobs sitting on the
//   outward side of their parent at about half its size. The cap and stem are laid out that way here.
// - S. Glasstone and P. J. Dolan, "The Effects of Nuclear Weapons", 3rd ed., US DoD and ERDA, 1977, ch. 2: a shallow
//   buried burst throws up a column of earth with a dense dust cloud at its top, and the cloud rises and spreads as the
//   hot gas inside it is buoyant; the base surge rolls out along the ground.
// - W. E. Baker, P. A. Cox, P. S. Westine, J. J. Kulesz and R. A. Strehlow, "Explosion Hazards and Evaluation",
//   Elsevier, 1983: the cube-root scaling of an explosion's sizes with its charge mass and the TNT heat of detonation,
//   4.184 MJ/kg.
// - M. Planck, "Ueber das Gesetz der Energieverteilung im Normalspectrum", Ann. Phys. 309(3), 553-563, 1901,
//   https://doi.org/10.1002/andp.19013090310, in its Wien limit (lambda T well under c2 = 14,388 um K): the fire's
//   brightness at 555 nm, the eye's peak, goes as exp(-c2 / (lambda T)), so a fireball a fifth cooler is a tenth as
//   bright; the Stefan-Boltzmann law puts the radiating fire's temperature at T0 f^(1/4) for a share f of its power. Its
//   colour is the blackbody's (`blackbodyColor` of `@margoengine/math/color`, Kim et al. 2002): near-white at the core
//   of a fresh fireball once exposed for daylight, orange and red as it cools.
// The buoyancy of the released heat Q in air of density rho, heat capacity c_p and temperature T is B = g Q / (rho c_p T)
// (the heat-to-buoyancy flux relation of Morton et al. 1956), and for an ideal gas at the air's pressure the same B
// is g (rho_a - rho) V / rho_a whatever the cloud's temperature, so the hot start holds the heat in the volume at which
// the cloud is `fireTemperature`; `heatShare` of the charge's energy heats the air (a model choice). The atmosphere is
// the ICAO standard one (`standardAtmosphere`), whose N^2 = g / T (dT/dz + g / c_p) stops the rise. The wind drifts the
// cap as the 1/7 power of height to the tropopause, as `Eruption`.
import { blackbodyColor } from '@margoengine/math/color';
import { standardAtmosphere } from './eruption.js';
import { filmTime } from '../../shared/film-time.js';

const G = 9.80665;
const C_AIR = 1005;
const TNT = 4.184e6;
const DT = 0.05;
/** Columns of a solved row: z, b, w, g', drift, rho / rho_a, N^2. */
const COLS = 7;
/** Lightest cloud, as a share of the air's density (a floor on the hot start, about 5,800 K). */
const LIGHTEST = 0.05;
/** Froude number of the umbrella's front (Benjamin 1968; Ungarish 2009), a model choice. */
const FROUDE = 0.5;

/** One instantaneous release of {@link BlastCloud}. */
export interface BlastSource {
  /** Film seconds it goes off. Default 0. */
  at?: number;
  /** World place of the charge, [x, y, z] metres. Default [0, 0, 0]. */
  position?: readonly [number, number, number];
  /** Charge as kilograms of TNT, 1 to 1e9. Default 1e6 (1,000 tonnes). */
  tnt?: number;
  /**
   * Initial cloud radius, metres above 0. Default the larger of tnt^(1/3) (cube-root scaling, Baker et al. 1983) and
   * the radius at which the released heat holds the cloud at `fireTemperature`.
   */
  radius?: number;
  /** Initial rise speed of the cloud, m/s, 0 to 500: the upward throw of a buried or ground burst. Default 0. */
  speed?: number;
}

/** Options of {@link BlastCloud}. Every field has a documented default; the constructor checks the ranges. */
export interface BlastCloudOptions {
  /** The releases, 1 to 8. Default one source of 1,000 tonnes at the origin at film time 0. */
  sources?: readonly BlastSource[];
  /** Ground height above sea level, metres, 0 to 8,000 (the air's density and stability). Default 0. */
  altitude?: number;
  /** Share of the charge's energy that heats the air, 0.01 to 1. Default 0.4 (a model choice). */
  heatShare?: number;
  /** Temperature of the hot cloud when it starts, kelvin, 400 to 5,000 (sets the default radius). Default 2,000. */
  fireTemperature?: number;
  /** Thermal spread b / z (Scorer 1957), 0.1 to 0.5. Default 0.25. */
  entrainment?: number;
  /** Added mass coefficient (Escudier and Maxworthy 1973), 0 to 2. Default 0.5. */
  addedMass?: number;
  /** Air temperature at sea level, kelvin, 220 to 320. Default 288.15 (ICAO). */
  airTemperature?: number;
  /** Height of the tropopause above sea level, metres, 6,000 to 20,000. Default 11,000 (ICAO). */
  tropopause?: number;
  /** Air stability N^2, 1/s^2, 0 to 0.01: a value holds it constant; null follows the standard atmosphere. Default null. */
  stability?: number | null;
  /** Wind at 10 m, m/s, 0 to 60, growing with height as the 1/7 power to the tropopause. Default 0. */
  wind?: number;
  /** Direction the wind blows toward, degrees, 0 is +Z, 90 is +X. Default 0. */
  windDirection?: number;
  /** Seconds the rise is solved for, 10 to 7,200; afterwards the cloud holds its last state. Default 900. */
  horizon?: number;
  /** Seconds the fire inside the cloud burns, 0 to 600. Default 4. */
  fireDuration?: number;
  /**
   * Colour of the cap (smoke and fine dust), linear RGB 0 to 1. Default [0.16, 0.16, 0.165], soot grey-black: TNT's
   * oxygen balance is -74 percent (J. Akhavan, "The Chemistry of Explosives", 3rd ed., RSC, 2011), so its detonation
   * leaves free carbon, the black smoke of the Halifax (1917) and ammunition-dump photographs.
   */
  color?: readonly [number, number, number];
  /** Colour of the stem and base surge (thrown earth in the soot), linear RGB 0 to 1. Default [0.12, 0.117, 0.113]. */
  stemColor?: readonly [number, number, number];
  /**
   * Colour of the fire, linear RGB 0 to 1: the glow of the puffs near the fire, and the fire puffs. Default null: the
   * colour of a blackbody at each puff's temperature, near-white in a fresh fireball, orange to red as it cools.
   */
  fireColor?: readonly [number, number, number] | null;
  /**
   * Temperature of the fireball's light at the moment of the release, kelvin, 1,000 to 5,000: the detonation products
   * glow at the Chapman-Jouguet temperatures of 3,000 to 4,000 K that C. L. Mader ("Numerical Modeling of Explosives
   * and Propellants", 3rd ed., CRC Press, 2008) tabulates for military explosives, and cool as the fire burns down.
   * Default 3,000 (a model choice at the low end, the afterburning cloud being cooler than the detonation front).
   */
  fireballTemperature?: number;
  /** Brightness of the fire's glow at `fireballTemperature`, 0 to 100 (above 1 blooms); cooler fire is dimmer. Default 6. */
  fireGlow?: number;
  /**
   * Dark jets of thrown earth shooting out of the fireball in its first seconds, 0 to 64, a whole number: each a trail
   * of dust puffs behind a clod launched at 250 to 450 m/s and slowed by the air (a linear drag of time constant 1.5 s,
   * a model choice after the ballistic paths of Mastin 2001), settling into the cloud by `jetLife`. While they show they take a quarter of the stem's puffs (`draw` counts.stem),
   * up to 14 a jet. Default 16.
   */
  jets?: number;
  /** Seconds the jets show, 1 to 30. Default 6. */
  jetLife?: number;
  /** Seed of the puff layout, an integer. Default 1. */
  seed?: number;
}

/** One thermal at a film time, from {@link BlastCloud.thermals}. */
export interface BlastThermal {
  /** Seconds since its source went off (0 before it). */
  readonly age: number;
  /** World place of the cap's centre, metres (merged caps share it): `thickness` under the thermal's top, z + b. */
  readonly centre: readonly [number, number, number];
  /** Height of the cap's centre above the source, metres. */
  readonly height: number;
  /** Cap radius b, metres (the merged cap's once caps merge). */
  readonly radius: number;
  /** Rise speed, m/s. */
  readonly speed: number;
  /** Reduced gravity g' of the cap, m/s^2 (negative once it overshoots its neutral level). */
  readonly buoyancy: number;
  /** Total buoyancy b^3 g' at the source, m^4/s^2 (the conserved B of uniform air, over 4 pi / 3). */
  readonly sourceBuoyancy: number;
  /** Cap density as a share of the air's, 0.05 to 1 (the hot start is light). */
  readonly density: number;
  /** Horizontal radius of the cap: the radius, then the umbrella's once the cap stops at its neutral height, metres. */
  readonly spread: number;
  /** Half height of the cap, metres: the radius, flattened as the umbrella spreads at the same volume. */
  readonly thickness: number;
  /** How far this cap has merged with its neighbours, 0 (apart) to 1 (one cap). */
  readonly merged: number;
  /** Fire inside the cloud, 0 to 1. */
  readonly fire: number;
}

/** What {@link BlastCloud.draw} draws into: a `Clouds` of `@margoengine/vfx/clouds` fits it. */
export interface BlastCloudTarget {
  add(options: object): { readonly options: object; readonly matrix: Float32Array };
  remove(cloud: object): boolean;
}

/** How many puffs {@link BlastCloud.draw} lays out. */
export interface BlastDrawOptions {
  /** Puffs of each cap, 32 to 16,384. Default 2,040. */
  cap?: number;
  /** Puffs of each stem and its base surge, 32 to 16,384. Default 1,020. */
  stem?: number;
  /** Puffs of each fire in the `fire` target, 0 to 1,024. Default 60. */
  fire?: number;
}

interface Track {
  readonly at: number;
  readonly position: readonly [number, number, number];
  readonly b0: number;
  readonly B: number;
  readonly rows: Float64Array;
  /** Seconds after the release the cap first reaches its neutral height (g' <= 0), or Infinity. */
  readonly stopAt: number;
  readonly stopRadius: number;
  readonly stopN: number;
}

const RANGES: Record<string, readonly [number, number]> = {
  altitude: [0, 8000],
  heatShare: [0.01, 1],
  fireTemperature: [400, 5000],
  fireballTemperature: [1000, 5000],
  entrainment: [0.1, 0.5],
  addedMass: [0, 2],
  airTemperature: [220, 320],
  tropopause: [6000, 20000],
  wind: [0, 60],
  windDirection: [-360, 720],
  horizon: [10, 7200],
  stability: [0, 0.01],
  fireDuration: [0, 600],
  fireGlow: [0, 100],
  jets: [0, 64],
  jetLife: [1, 30],
};

const bad = (message: string): never => {
  throw new RangeError(`BlastCloud option out of range; ${message}`);
};
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const colour = (v: unknown, key: string): void => {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.length !== 3 || !v.every((c) => finite(c) && c >= 0 && c <= 1))
    bad(`${key} must be three linear RGB numbers from 0 to 1.`);
};

/** lowbias32 (C. Wellons, "Prospecting for Hash Functions"), as a number in [0, 1). */
const hash = (x: number): number => {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};

/** N^2 of the standard atmosphere at height z above sea level, 1/s^2. */
export function airStability(z: number, seaLevel = 288.15, tropopause = 11000): number {
  const [T] = standardAtmosphere(z, seaLevel, tropopause),
    dT =
      (standardAtmosphere(z + 5, seaLevel, tropopause)[0] -
        standardAtmosphere(Math.max(z - 5, 0), seaLevel, tropopause)[0]) /
      (z >= 5 ? 10 : 5 + z);
  return (G / T) * (dT + G / C_AIR);
}

/**
 * The height a thermal of source buoyancy `B` (b^3 g', m^4/s^2) reaches in still air of constant stability `N2`, by
 * the equations {@link BlastCloud} solves in their Boussinesq limit (a cool start of radius `b0`): the scale
 * B^(1/4) N^(-1/2) of Morton et al. (1956) times a constant that depends on `entrainment` and `addedMass`.
 */
export function thermalTop(B: number, N2: number, entrainment = 0.25, addedMass = 0.5, b0 = 1): number {
  const rows = solve(
    B,
    b0,
    0,
    entrainment,
    addedMass,
    () => N2,
    () => 0,
    7200,
    1,
  );
  let top = 0;
  for (let k = 0; k < rows.length; k += COLS) top = Math.max(top, rows[k]!);
  return top;
}

function solve(
  B: number,
  b0: number,
  w0: number,
  alpha: number,
  k: number,
  N2: (z: number) => number,
  wind: (z: number) => number,
  horizon: number,
  boussinesq = 0,
): Float64Array {
  const steps = Math.ceil(horizon / DT),
    rows = new Float64Array((steps + 1) * COLS),
    // rho / rho_a = 1 - V g' / (g V): a hot cloud is light, and never lighter than LIGHTEST.
    light = (V: number, F: number) => (boussinesq ? 1 : Math.max(1 - F / (G * V), LIGHTEST));
  // State: z, V = b^3, P = (rho / rho_a + k) b^3 w (momentum over the air's density), F = b^3 g', drift s. The volume
  // holds the heat no hotter than the lightest cloud.
  let z = 0,
    V = boussinesq ? b0 * b0 * b0 : Math.max(b0 * b0 * b0, B / (G * (1 - LIGHTEST))),
    F = B,
    P = (light(V, F) + k) * V * w0,
    s = 0;
  const d = (z: number, V: number, P: number, F: number): [number, number, number, number, number] => {
    const r = light(V, F),
      b = Math.cbrt(V),
      w = P / ((r + k) * V),
      dF = -N2(z) * V * w;
    // Mass V r grows by entrainment at (rho / rho_a)^(1/2) of the Boussinesq rate (Ricou and Spalding 1961); with
    // r = 1 - F / (g V) the volume grows by that plus dF / g.
    return [w, 3 * alpha * Math.sqrt(r) * b * b * Math.abs(w) + (boussinesq ? 0 : dF / G), F, dF, wind(z)];
  };
  for (let i = 0; ; i++) {
    const r = light(V, F);
    rows.set([z, Math.cbrt(V), P / ((r + k) * V), F / V, s, r, N2(z)], i * COLS);
    if (i === steps) break;
    // Sub-steps of at most a tenth of the radius travelled or fallen, so a small hot start is resolved.
    for (let left = DT; left > 0; ) {
      const bb = Math.cbrt(V),
        rr = light(V, F),
        ww = Math.abs(P / ((rr + k) * V)),
        gg = Math.abs(F / ((rr + k) * V)),
        h = Math.min(left, (0.1 * bb) / Math.max(ww, 1e-9), Math.sqrt((0.2 * bb) / Math.max(gg, 1e-9)));
      left = left - h < 1e-12 ? 0 : left - h;
      const a1 = d(z, V, P, F),
        a2 = d(z + 0.5 * h * a1[0], V + 0.5 * h * a1[1], P + 0.5 * h * a1[2], F + 0.5 * h * a1[3]),
        a3 = d(z + 0.5 * h * a2[0], V + 0.5 * h * a2[1], P + 0.5 * h * a2[2], F + 0.5 * h * a2[3]),
        a4 = d(z + h * a3[0], V + h * a3[1], P + h * a3[2], F + h * a3[3]);
      z = Math.max(0, z + (h / 6) * (a1[0] + 2 * a2[0] + 2 * a3[0] + a4[0]));
      V += (h / 6) * (a1[1] + 2 * a2[1] + 2 * a3[1] + a4[1]);
      P += (h / 6) * (a1[2] + 2 * a2[2] + 2 * a3[2] + a4[2]);
      F += (h / 6) * (a1[3] + 2 * a2[3] + 2 * a3[3] + a4[3]);
      s += (h / 6) * (a1[4] + 2 * a2[4] + 2 * a3[4] + a4[4]);
      // A thermal that has settled back onto the ground stays there.
      if (z === 0 && P < 0) P = 0;
    }
  }
  return rows;
}

type Vec = [number, number, number];
/** A puff in world units: centre, radius, colour, glow. */
type Puff = [number, number, number, number, number, number, number, number, number, number];
/**
 * Lobes on each lobe, level by level (Bouthors and Neyret 2004): a blob, 5 children and 3 on each child, so one tree is
 * 1 + 5 + 15 = 21 puffs over three sizes, each about half the one before. A fourth level (2 on each grandchild, 51
 * puffs a tree) spent 30 of every 51 puffs on lobes an eighth of the blob, so a cap's budget laid 36 trees instead of
 * 87 and left a quarter of its face open, the filling puffs inside showing as one smooth blur (KB-BLAST-CAPBLUR). The
 * finer billows come from more, smaller trees, not deeper ones.
 */
const LOBES = [5, 3] as const;
/** How far out of its parent a lobe sits, in parent radii, level by level: about half sunk, so the lobes blend. */
const OUT = [0.78, 0.62] as const;
const TREE = 1 + 5 + 5 * 3;
/** Radians the first ring of lobes leans off the blob's normal, before a jitter of plus or minus 15 percent. */
const RING_TILT = (55 * Math.PI) / 180;
/** Two unit vectors at right angles to unit `n` and to each other. */
const tangents = (n: readonly number[]): [Vec, Vec] => {
  const [x, y, z] = n as [number, number, number],
    a: Vec = Math.abs(x) < 0.9 ? [0, z, -y] : [-z, 0, x],
    la = Math.hypot(...a);
  const t: Vec = [a[0] / la, a[1] / la, a[2] / la];
  return [t, [y * t[2] - z * t[1], z * t[0] - x * t[2], x * t[1] - y * t[0]]];
};
/** c2 / 555 nm, kelvin: Planck's second radiation constant over the wavelength of the eye's peak (Wien limit). */
const WIEN = 14387.77 / 0.555;
/** Draper point, kelvin: a body cooler than this gives no visible glow. */
const DRAPER = 798;

/**
 * The mushroom cloud of one or more instantaneous releases over film time (entry `@margoengine/weather/eruption`):
 * each source is a buoyant thermal (Morton, Taylor and Turner 1956) that starts hot and light, rises, spreads as
 * b = alpha z and slows in the stable air until it stops and spreads into an umbrella; neighbouring caps merge. Its
 * cap and stem are cauliflower heaps of puffs at three scales (Bouthors and Neyret 2004), lit from inside by the fire
 * in the first seconds. `seek(t)` and `draw(clouds)` put it into a `Clouds` of `@margoengine/vfx/clouds`; give that
 * Clouds `relief: 1` so each puff shades as a rounded lobe and the cap darkens its own underside and the stem.
 */
export class BlastCloud {
  readonly options: Readonly<BlastCloudOptions>;
  private readonly tracks: Track[];
  private film = 0;
  private readonly drawn = new Map<string, { readonly options: object; readonly matrix: Float32Array }>();
  private target: BlastCloudTarget | null = null;
  private fireTarget: BlastCloudTarget | null = null;

  constructor(options: BlastCloudOptions = {}) {
    if (typeof options !== 'object' || options === null) throw new TypeError('BlastCloud options must be an object.');
    const o = options as Record<string, unknown>;
    for (const [key, [lo, hi]] of Object.entries(RANGES))
      if (o[key] != null && (!finite(o[key]) || (o[key] as number) < lo || (o[key] as number) > hi))
        bad(`${key} must be a number from ${lo} to ${hi}.`);
    colour(o.color, 'color');
    colour(o.stemColor, 'stemColor');
    if (o.fireColor !== null) colour(o.fireColor, 'fireColor');
    if (o.seed !== undefined && !Number.isInteger(o.seed)) bad('seed must be an integer.');
    if (o.jets !== undefined && !Number.isInteger(o.jets)) bad('jets must be a whole number.');
    const sources = options.sources ?? [{}];
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 8) bad('sources must hold 1 to 8 releases.');
    this.options = options;
    const alt = options.altitude ?? 0,
      T0 = options.airTemperature ?? 288.15,
      trop = options.tropopause ?? 11000,
      alpha = options.entrainment ?? 0.25,
      k = options.addedMass ?? 0.5,
      share = options.heatShare ?? 0.4,
      hot = options.fireTemperature ?? 2000,
      u10 = options.wind ?? 0,
      [Ta, Pa] = standardAtmosphere(alt, T0, trop),
      rho = Pa / (287.05287 * Ta),
      fixed = options.stability ?? null,
      N2 = fixed === null ? (z: number) => Math.max(airStability(alt + z, T0, trop), 0) : () => fixed,
      wind = (z: number) => u10 * Math.pow(Math.max(Math.min(alt + z, trop) - alt, 10) / 10, 1 / 7);
    this.tracks = sources.map((s, i) => {
      if (typeof s !== 'object' || s === null) bad(`sources[${i}] must be an object.`);
      const at = s.at ?? 0,
        tnt = s.tnt ?? 1e6,
        position = s.position ?? [0, alt, 0];
      if (!finite(at) || at < 0) bad(`sources[${i}].at must be 0 or more.`);
      if (!finite(tnt) || tnt < 1 || tnt > 1e9) bad(`sources[${i}].tnt must be from 1 to 1e9 kg.`);
      if (!Array.isArray(position) || position.length !== 3 || !position.every(finite))
        bad(`sources[${i}].position must be [x, y, z].`);
      // B = g Q / (rho c_p T), shared over the top-hat's b^3 (the 4 pi / 3 of a sphere's volume divided out).
      const B = (G * share * tnt * TNT) / (rho * C_AIR * Ta) / ((4 * Math.PI) / 3),
        // At fireTemperature the cloud's g' is g (1 - Ta / T), so the heat fills B / g' of top-hat volume.
        b0 = s.radius ?? Math.max(Math.cbrt(tnt), Math.cbrt(B / (G * Math.max(1 - Ta / hot, 1e-3)))),
        w0 = s.speed ?? 0;
      if (!finite(b0) || b0 <= 0) bad(`sources[${i}].radius must be above 0.`);
      if (!finite(w0) || w0 < 0 || w0 > 500) bad(`sources[${i}].speed must be from 0 to 500 m/s.`);
      const rows = solve(B, b0, w0, alpha, k, N2, wind, options.horizon ?? 900);
      let stop = -1;
      for (let r = 1; r < rows.length / COLS; r++)
        if (rows[r * COLS + 3]! <= 0) {
          stop = r;
          break;
        }
      return {
        at,
        position,
        b0: rows[1]!,
        B,
        rows,
        stopAt: stop < 0 ? Infinity : stop * DT,
        stopRadius: stop < 0 ? 0 : rows[stop * COLS + 1]!,
        stopN: stop < 0 ? 0 : Math.sqrt(rows[stop * COLS + 6]!),
      };
    });
  }

  /** Film time now, seconds. */
  get time(): number {
    return this.film;
  }

  /** Sets the film time; the cloud is a function of it alone. */
  seek(t: number): void {
    this.film = filmTime(t, bad, 'seek time');
  }

  /** Moves the film time on by `delta` seconds. */
  update(delta: number): void {
    this.film += filmTime(delta, bad, 'update delta');
  }

  /** Each source's thermal at film time `t` (default now), in source order. */
  thermals(t = this.film): BlastThermal[] {
    const dir = ((this.options.windDirection ?? 0) * Math.PI) / 180,
      wx = Math.sin(dir),
      wz = Math.cos(dir),
      fireFor = this.options.fireDuration ?? 4;
    const each = this.tracks.map((tr) => {
      const age = Math.max(t - tr.at, 0),
        last = tr.rows.length / COLS - 1,
        f = Math.min(age / DT, last),
        i = Math.floor(f),
        j = Math.min(i + 1, last),
        u = f - i,
        r = (c: number) => tr.rows[i * COLS + c]! * (1 - u) + tr.rows[j * COLS + c]! * u,
        z = r(0),
        b = r(1),
        s = r(4),
        // The umbrella: past its neutral height the cap's volume spreads as an intrusion (Benjamin 1968; Ungarish
        // 2009), R^3 = R_s^3 (1 + 4 Fr N (t - t_s)) for the volume (4 pi / 3) R_s^3.
        after = Math.min(age, last * DT) - tr.stopAt,
        umbrella = after > 0 ? tr.stopRadius * Math.cbrt(1 + 4 * FROUDE * tr.stopN * after) : 0,
        // The cap an oblate spheroid of half height 0.75 b at the thermal's volume (a model choice), wider still as the
        // umbrella spreads.
        spread = Math.max(b / Math.sqrt(0.75), umbrella),
        thickness = Math.max((b * b * b) / (spread * spread), 0.3 * b),
        fire = t < tr.at || fireFor === 0 ? 0 : Math.max(0, 1 - age / fireFor) ** 1.5;
      return {
        age,
        // The flattened cap keeps the thermal's top, z + b: it flattens from below, where the stem feeds it.
        centre: [tr.position[0] + wx * s, tr.position[1] + z + b - thickness, tr.position[2] + wz * s] as Vec,
        height: z,
        radius: b,
        speed: r(2),
        buoyancy: r(3),
        sourceBuoyancy: tr.B,
        density: r(5),
        spread,
        thickness,
        merged: 0,
        fire,
        on: t >= tr.at,
      };
    });
    // Merging (Kaye and Linden 2004): caps whose spheres overlap blend toward one cap of their summed volume at their
    // volume-weighted centre, fully one when their centres are half their summed radii apart.
    const out = each.map((x) => ({ ...x, centre: [...x.centre] as Vec }));
    for (let a = 0; a < each.length; a++)
      for (let c = a + 1; c < each.length; c++) {
        const p = each[a]!,
          q = each[c]!;
        if (!p.on || !q.on || p.age === 0 || q.age === 0) continue;
        const gap = Math.hypot(p.centre[0] - q.centre[0], p.centre[1] - q.centre[1], p.centre[2] - q.centre[2]),
          x = Math.min(Math.max((p.radius + q.radius - gap) / (0.5 * (p.radius + q.radius)), 0), 1),
          m = x * x * (3 - 2 * x);
        if (m <= 0) continue;
        const vp = p.spread * p.spread * p.thickness,
          vq = q.spread * q.spread * q.thickness,
          mid = [0, 1, 2].map((n) => (p.centre[n]! * vp + q.centre[n]! * vq) / (vp + vq)) as Vec,
          sum = (a: number, b: number) => Math.cbrt(a * a * a + b * b * b),
          radius = sum(p.radius, q.radius),
          spread = sum(p.spread, q.spread),
          thickness = sum(p.thickness, q.thickness);
        for (const [i, th] of [
          [a, p],
          [c, q],
        ] as const) {
          const o = out[i]!;
          if (m < o.merged) continue;
          for (let n = 0; n < 3; n++) o.centre[n] = th.centre[n]! + (mid[n]! - th.centre[n]!) * m;
          o.radius = th.radius + (radius - th.radius) * m;
          o.spread = th.spread + (spread - th.spread) * m;
          o.thickness = th.thickness + (thickness - th.thickness) * m;
          o.height = th.height + (mid[1] - th.centre[1]) * m;
          o.merged = m;
        }
      }
    return out.map(({ on: _on, ...x }) => x);
  }

  /**
   * Puts every source's cap, stem and base surge into one cloud of `clouds`, so the caps shade each other and the stems
   * under them, each puff coloured and lit from inside by the fire while it burns; and the fires into `fire` (a second
   * `Clouds`, `shading: 'unlit'`, attached before `clouds` so the smoke draws over it; left out, the fire shows only as
   * the glow inside the smoke). The layout is a function of the film time and the seed: call after `seek` or `update`.
   */
  draw(clouds: BlastCloudTarget, fire?: BlastCloudTarget, counts: BlastDrawOptions = {}): void {
    if (this.target && this.target !== clouds) this.clear();
    this.target = clouds;
    if (fire !== undefined) this.fireTarget = fire;
    const capN = counts.cap ?? 2040,
      stemN = counts.stem ?? 1020,
      fireN = counts.fire ?? 60;
    for (const [n, lo, hi, key] of [
      [capN, 32, 16384, 'cap'],
      [stemN, 32, 16384, 'stem'],
      [fireN, 0, 1024, 'fire'],
    ] as const)
      if (!Number.isInteger(n) || n < lo || n > hi)
        bad(`draw counts.${key} must be a whole number from ${lo} to ${hi}.`);
    const o = this.options,
      seed = o.seed ?? 1,
      capColour = o.color ?? [0.16, 0.16, 0.165],
      stemColour = o.stemColor ?? [0.12, 0.117, 0.113],
      fixedFire = o.fireColor ?? null,
      hottest = o.fireballTemperature ?? 3000,
      glowAt = o.fireGlow ?? 6,
      all = this.thermals(),
      lit = all.map((th, i) => ({ th, tr: this.tracks[i]! })).filter((x) => this.film >= x.tr.at);
    const smoke: Puff[] = [],
      fires: Puff[] = [];
    lit.forEach(({ th, tr }, s) => {
      const rnd = (n: number, c: number) => hash((seed * 7919 + s * 104729 + n * 31 + c) >>> 0),
        [cx, cy, cz] = th.centre,
        [gx, gy, gz] = tr.position,
        Rh = th.spread,
        Hv = th.thickness,
        // The fire radiating a share `fire` of its first power is at hottest x fire^(1/4) (Stefan-Boltzmann).
        core = th.fire > 0 ? hottest * th.fire ** 0.25 : 0;
      // The glow of fire at `cool` (0 at the core, 1 at the cloud's edge, 12 percent cooler): the blackbody's colour,
      // as bright as its light at 555 nm against that of `fireballTemperature` (Planck's law in its Wien limit).
      const glow = (cool: number, base = core): Vec => {
        const T = base * (1 - 0.12 * Math.min(Math.max(cool, 0), 1));
        if (T <= DRAPER) return [0, 0, 0];
        const L = glowAt * Math.exp(WIEN * (1 / hottest - 1 / T)),
          c = fixedFire ?? blackbodyColor(Math.min(Math.max(T, 1667), 25000));
        return [c[0]! * L, c[1]! * L, c[2]! * L];
      };
      // A cauliflower tree (Bouthors and Neyret 2004): a blob on the surface, LOBES[0] on its outward side at about
      // half its size, LOBES[1] on each of those and LOBES[2] on each of theirs. `tint` gives a puff's colour and glow
      // from its place.
      let n = 0;
      const tree = (p: Vec, normal: Vec, r0: number, tint: (q: Vec) => [Vec, Vec]): void => {
        const push = (q: Vec, r: number): void => {
          const [c, e] = tint(q);
          smoke.push([q[0], q[1], q[2], r, c[0], c[1], c[2], e[0], e[1], e[2]]);
        };
        const out = (parent: Vec, normal: Vec, r: number, level: number, k: number): void => {
          // The first level stands in an even ring round the blob's normal (stratified, jittered within its sector), so
          // the lobes reach out sideways into the gaps between trees; random directions bunched them and left those
          // gaps open (KB-BLAST-CAPBLUR). Deeper levels stay random, for the irregular billows.
          const lobes = LOBES[level - 1]!,
            [t1, t2] = level === 1 ? tangents(normal) : [normal, normal],
            spin = rnd(n, 23 + k) * 2 * Math.PI;
          for (let i = 0; i < lobes; i++, n++) {
            let d: Vec;
            if (level === 1) {
              const a = spin + ((i + 0.3 + 0.4 * rnd(n, 20 + k)) / lobes) * 2 * Math.PI,
                tilt = RING_TILT * (0.85 + 0.3 * rnd(n, 21 + k)),
                s = Math.sin(tilt),
                c = Math.cos(tilt);
              d = [0, 1, 2].map((j) => normal[j]! * c + s * (t1[j]! * Math.cos(a) + t2[j]! * Math.sin(a))) as Vec;
            } else {
              const a = rnd(n, 20 + k) * 2 * Math.PI,
                cz2 = rnd(n, 21 + k) * 2 - 1,
                sz = Math.sqrt(1 - cz2 * cz2);
              d = [normal[0] + 0.95 * sz * Math.cos(a), normal[1] + 0.95 * cz2, normal[2] + 0.95 * sz * Math.sin(a)];
            }
            const len = Math.hypot(...d) || 1;
            d = [d[0] / len, d[1] / len, d[2] / len];
            const rc = r * (0.42 + 0.16 * rnd(n, 22 + k)),
              out_ = OUT[level - 1]!,
              q: Vec = [parent[0] + d[0] * r * out_, parent[1] + d[1] * r * out_, parent[2] + d[2] * r * out_];
            push(q, rc);
            if (level < LOBES.length) out(q, d, rc, level + 1, k + 3 * level);
          }
        };
        // The blob itself is drawn at 0.65 of the radius its lobes sit on, so it fills the tree from inside and the
        // lobes, not one large soft puff, make the cloud's surface and outline.
        push(p, 0.65 * r0);
        out(p, normal, r0, 1, 0);
      };
      const mottle = (i: number) => 0.82 + 0.36 * rnd(i, 30);
      // Cap: an ellipsoid of horizontal radius Rh and half height Hv; blobs over its top and sides down to 120 degrees
      // from the top, the underside rolled in by the vortex ring (Turner 1957). The fire is hottest at its centre.
      // Merged caps share the cap: each lays out its share, so two fully merged caps draw one cap's puffs.
      const capTrees = Math.max(1, Math.floor((capN * 0.9 * (1 - 0.5 * th.merged)) / TREE)),
        capFill = Math.round(capN * 0.1 * (1 - 0.5 * th.merged));
      // The trees sit on a spiral of even area over the cap's face (R. Swinbank and R. J. Purser, "Fibonacci grids",
      // Q. J. R. Meteorol. Soc. 132, 1769-1793, 2006; A. Gonzalez, "Measurement of areas on a sphere using Fibonacci
      // and latitude-longitude lattices", Math. Geosci. 42, 49-64, 2010), jittered within their band, so no part of the
      // face is left open to the filling puffs inside (random directions left a third of it open: KB-BLAST-CAPBLUR).
      const turn = rnd(0, 1) * 2 * Math.PI;
      for (let i = 0; i < capTrees; i++) {
        const phi = turn + i * 2.399963 + (rnd(i, 1) - 0.5) * 0.4,
          ct = 1 - (1.5 * (i + 0.25 + 0.5 * rnd(i, 2))) / capTrees,
          st = Math.sqrt(1 - ct * ct),
          shade = mottle(i),
          normal = [(st * Math.cos(phi)) / Rh, ct / Hv, (st * Math.sin(phi)) / Rh],
          nl = Math.hypot(...normal),
          r0 = 0.3 * (0.6 * Rh + 0.4 * Hv) * (0.7 + 0.6 * rnd(i, 3));
        // Blobs at 0.78 of the cap's radii, so their first ring of lobes reaches its face (at 0.72 a seed in four left
        // more than 1 percent of the face open).
        tree(
          [cx + 0.78 * Rh * st * Math.cos(phi), cy + 0.78 * Hv * ct, cz + 0.78 * Rh * st * Math.sin(phi)],
          [normal[0]! / nl, normal[1]! / nl, normal[2]! / nl],
          r0,
          (q) => [
            [capColour[0] * shade, capColour[1] * shade, capColour[2] * shade],
            glow(Math.hypot((q[0] - cx) / Rh, (q[1] - cy) / Hv, (q[2] - cz) / Rh)),
          ],
        );
      }
      for (let i = 0; i < capFill; i++, n++) {
        const phi = rnd(n, 4) * 2 * Math.PI,
          ct = rnd(n, 5) * 2 - 1,
          st = Math.sqrt(1 - ct * ct),
          rr = Math.cbrt(rnd(n, 6)) * 0.42,
          g = glow(rr);
        smoke.push([
          cx + rr * Rh * st * Math.cos(phi),
          cy + rr * Hv * ct,
          cz + rr * Rh * st * Math.sin(phi),
          0.22 * Math.min(Rh, 1.6 * Hv),
          capColour[0] * 0.8,
          capColour[1] * 0.8,
          capColour[2] * 0.8,
          g[0],
          g[1],
          g[2],
        ]);
      }
      // Stem: from the ground to under the cap, drawn up by the ring's circulation, broad at the base and narrowing
      // upward; earth-coloured at the foot, the cap's colour at the top. The base surge rolls out along the ground
      // (Glasstone and Dolan 1977, ch. 2), growing with the cap.
      const top = Math.max(th.height - 0.55 * Hv, 0),
        surge = Math.min(tr.b0 * (1 + 0.6 * Math.sqrt(th.age)), 1.2 * th.radius + tr.b0),
        rTop = 0.45 * Math.min(Rh, 2 * th.radius),
        rBase = Math.max(0.55 * th.radius, 0.8 * tr.b0),
        // Jets of thrown earth are stem material: while they show they take a quarter of the stem's puffs from its
        // trees, so a draw stays inside `counts` (they were added on top of it).
        jetN = o.jets ?? 16,
        jetLife = o.jetLife ?? 6,
        jetBudget = jetN > 0 && th.age > 0 && th.age < jetLife ? Math.floor(stemN * 0.25) : 0,
        stemTrees = Math.max(1, Math.floor((stemN * 0.65 - jetBudget) / TREE)),
        stemFill = Math.round(stemN * 0.1),
        surgeTrees = Math.max(1, Math.floor((stemN * 0.25) / TREE)),
        // Thrown earth, the cap's colour toward the top; the fire at the foot, cooler up the stem and out in the surge.
        earth = (shade: number, rise: number): [Vec, Vec] => {
          const f = Math.min(Math.max(rise, 0), 1);
          return [
            [0, 1, 2].map((c) => (stemColour[c]! + (capColour[c]! - stemColour[c]!) * f) * shade) as Vec,
            glow(0.3 + f),
          ];
        };
      if (top > 0) {
        // Trees spread evenly up the stem (stratified heights, golden-angle turns) so it has no gaps of open sky,
        // round a core of filling puffs on its axis.
        for (let i = 0; i < stemFill; i++, n++) {
          const along = (i + rnd(n, 31)) / stemFill,
            w = rTop + (rBase - rTop) * (1 - along) ** 2,
            [c, e] = earth(mottle(n), along);
          smoke.push([
            gx + (cx - gx) * along,
            gy + along * top,
            gz + (cz - gz) * along,
            0.75 * w,
            c[0] * 0.8,
            c[1] * 0.8,
            c[2] * 0.8,
            e[0],
            e[1],
            e[2],
          ]);
        }
        for (let i = 0; i < stemTrees; i++) {
          const along = (i + rnd(i, 7)) / stemTrees,
            phi = (i * 2.399963 + rnd(i, 8)) % (2 * Math.PI),
            w = rTop + (rBase - rTop) * (1 - along) ** 2,
            sx = gx + (cx - gx) * along,
            sz = gz + (cz - gz) * along,
            shade = mottle(i + 977);
          tree(
            [sx + 0.8 * w * Math.cos(phi), gy + along * top, sz + 0.8 * w * Math.sin(phi)],
            [Math.cos(phi), 0.15, Math.sin(phi)],
            0.5 * w * (0.7 + 0.6 * rnd(i, 9)),
            (q) => earth(shade, (q[1] - gy) / Math.max(top, 1)),
          );
        }
      }
      for (let i = 0; i < surgeTrees; i++) {
        const phi = rnd(i, 10) * 2 * Math.PI,
          r = surge * (0.35 + 0.65 * Math.sqrt(rnd(i, 11))),
          size = tr.b0 * (0.5 + 0.4 * rnd(i, 12)) * Math.min(1, th.age / 4),
          shade = mottle(i + 1931);
        if (size <= 0) continue;
        tree(
          [gx + r * Math.cos(phi), gy + 0.5 * size, gz + r * Math.sin(phi)],
          [Math.cos(phi) * 0.6, 0.8, Math.sin(phi) * 0.6],
          size,
          () => earth(shade, 0.4),
        );
      }
      // The fire puffs' own temperature. The fire's outline, its radiating surface (the puffs overlap into one body),
      // already shrinks with it, radius (0.7 + 0.5 fire) / 1.2 of the first, so by Stefan-Boltzmann (power ~ area T^4)
      // the temperature carries only the rest of the power drop; taking it all in the temperature as well (`core`)
      // dimmed the shrinking fire twice and left it peach in its first second (KB-BLAST-PEACH). `core` still sets the
      // glow the fire casts into the smoke, whose lit volume does not shrink.
      const shrink = ((0.7 + 0.5 * th.fire) / 1.2) ** 2,
        fireCore = th.fire > 0 ? hottest * Math.min(1, th.fire / shrink) ** 0.25 : 0;
      if (th.fire > 0 && fireN > 0)
        for (let m = 0; m < fireN; m++) {
          // White-hot at the base: each fire puff carries the glow of its temperature, hottest low in the fire (the
          // Wien-limit brightness of `glow`), far over display white, so a camera exposed for the daylight clips it white.
          // Fire low in the base of the cloud, under the stem: it shrinks and sinks as it burns down.
          const fr = tr.b0 * (0.7 + 0.5 * th.fire),
            hue = fixedFire ?? blackbodyColor(Math.min(Math.max(fireCore, 1667), 25000)),
            phi = rnd(m, 13) * 2 * Math.PI,
            r = fr * Math.sqrt(rnd(m, 14)),
            y = fr * 0.6 * rnd(m, 15) ** 2 * th.fire;
          fires.push([
            gx + r * Math.cos(phi),
            gy + 0.15 * fr + y,
            gz + r * Math.sin(phi),
            fr * (0.12 + 0.12 * rnd(m, 16)) * (0.4 + 0.6 * th.fire),
            hue[0]!,
            hue[1]!,
            hue[2]!,
            ...glow(Math.min(1, y / Math.max(fr, 1e-6)), fireCore),
          ]);
        }
      // Jets: dust trails behind clods thrown out of the fireball, dark against it, gone by `jetLife`. Up to 14 puffs
      // a trail, as many jets as the budget holds two puffs for.
      const jetsDrawn = Math.min(jetN, Math.floor(jetBudget / 2));
      if (jetsDrawn > 0) {
        const TAU = 1.5,
          fade = 1 - th.age / jetLife,
          trail = Math.min(14, Math.floor(jetBudget / jetsDrawn));
        for (let j = 0; j < jetsDrawn; j++) {
          const az = rnd(j, 40) * 2 * Math.PI,
            el = ((30 + 50 * rnd(j, 41)) * Math.PI) / 180,
            v0 = 250 + 200 * rnd(j, 42),
            d: Vec = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
          for (let k = 0; k < trail; k++) {
            // Puff k marks where the clod was a share k / trail of its age ago; older dust has spread wider.
            const back = (k / trail) * th.age,
              a = th.age - back,
              reach = v0 * TAU * (1 - Math.exp(-a / TAU)),
              drop = 0.5 * G * a * a * 0.25,
              r = tr.b0 * (0.035 + 0.05 * back + 0.02 * rnd(j * 31 + k, 43)) * (0.4 + 0.6 * fade),
              shade = 0.55 + 0.15 * rnd(j * 31 + k, 44);
            smoke.push([
              gx + d[0] * reach,
              Math.max(gy + d[1] * reach - drop, gy + r),
              gz + d[2] * reach,
              r,
              stemColour[0] * shade,
              stemColour[1] * shade,
              stemColour[2] * shade,
              0,
              0,
              0,
            ]);
          }
        }
      }
    });
    this.put(clouds, 'smoke', smoke, null, 1);
    const heat = lit.reduce((m, x) => Math.max(m, x.th.fire), 0);
    this.put(this.fireTarget, 'fire', fires, null, Math.min(1, heat * 1.5));
  }

  /** Lays `puffs` (world units) into one cloud `id` of `target`; none removes it. */
  private put(
    target: BlastCloudTarget | null,
    id: string,
    puffs: Puff[],
    color: readonly number[] | null,
    opacity: number,
  ): void {
    if (!target) return;
    let c = this.drawn.get(id);
    if (puffs.length === 0) {
      if (c) {
        target.remove(c);
        this.drawn.delete(id);
      }
      return;
    }
    let x0 = Infinity,
      y0 = Infinity,
      z0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity,
      z1 = -Infinity,
      big = 0;
    for (const [x, y, z, r] of puffs) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
      big = Math.max(big, r);
    }
    const cx = 0.5 * (x0 + x1),
      cy = 0.5 * (y0 + y1),
      cz = 0.5 * (z0 + z1),
      bounds: Vec = [Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3), Math.max(z1 - z0, 1e-3)],
      // A puff quad 2.4 radii wide: the default puff texture's soft edge leaves about 0.8 of its half width opaque.
      volume = 2.4 * big,
      options = {
        seed: (this.options.seed ?? 1) * 131 + id.length,
        segments: puffs.length,
        bounds,
        volume,
        ...(color ? { color: [...color] } : {}),
        opacity,
        concentrate: 'inside',
        distribute: (i: number) => {
          const p = puffs[i]!;
          return {
            point: [((p[0] - cx) * 2) / bounds[0], ((p[1] - cy) * 2) / bounds[1], ((p[2] - cz) * 2) / bounds[2]],
            volume: big > 0 ? p[3] / big : 0,
            ...(color ? {} : { color: [p[4], p[5], p[6]], emission: [p[7], p[8], p[9]] }),
          };
        },
      };
    if (!c) {
      c = target.add(options);
      this.drawn.set(id, c);
    } else Object.assign(c.options, options);
    const m = c.matrix;
    m.fill(0);
    m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = cx;
    m[13] = cy;
    m[14] = cz;
  }

  /** Takes every cloud {@link draw} added out of its `Clouds`. */
  clear(): void {
    for (const [id, c] of this.drawn) (id === 'fire' ? this.fireTarget : this.target)?.remove(c);
    this.drawn.clear();
  }
}
