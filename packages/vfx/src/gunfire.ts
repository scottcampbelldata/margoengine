/// <reference lib="esnext.disposable" preserve="true" />
// Cannon fire for historic sea battles: the muzzle flash and its light, the white powder-smoke bank that hangs and drifts
// with the wind, the round shot's flight to the water, and burning wooden hulls with fire and dark smoke. Sources (papers
// and books, read as text; no code; docs/clean-room.md "Gunfire"):
// - A. Noble and F. A. Abel, "Researches on explosives. Fired gunpowder", Phil. Trans. R. Soc. Lond. 165, 49-155, 1875,
//   https://doi.org/10.1098/rstl.1875.0002 (as T. L. Davis, The Chemistry of Powder and Explosives, Wiley 1941, ch. II,
//   quotes them): service powder (75 saltpetre, 15 charcoal, 10 sulphur) burns to 42.98% of its mass in permanent
//   gases, 55.91% solids (potassium carbonate, sulphate and sulphide: the white smoke) and 1.11% water; a gram gives
//   718.1 cal and 271.3 cm^3 of permanent gas at 0 C and 760 mm, at an explosion temperature near 2,200 C.
// - G. Klingenberg and J. M. Heimerl, Gun Muzzle Blast and Flash, AIAA Progress in Astronautics and Aeronautics 139,
//   1992, https://doi.org/10.2514/4.866166: the flash of a gun is the hot, fuel-rich propellant gas (CO, H2) burning
//   again where it mixes with air past the Mach disc (the secondary flash), lasting milliseconds to tens of
//   milliseconds for large guns, far shorter than a film frame.
// - J. M. Richards, "Puff motions in unstratified surroundings", J. Fluid Mech. 21(1), 97-106, 1965,
//   https://doi.org/10.1017/S0022112065000071, and R. S. Scorer, "Experiments on convection of isolated masses of buoyant
//   fluid", J. Fluid Mech. 2(6), 583-594, 1957, https://doi.org/10.1017/S0022112057000397: an isolated turbulent puff or
//   thermal grows self-similarly, its radius a fixed fraction (about 0.25) of the distance it has travelled through the
//   air; a momentum puff then keeps its momentum (so x^4 grows as t) and a thermal gains momentum at its buoyancy (so x^4
//   grows as t^2). B. R. Morton, G. I. Taylor and J. S. Turner 1956 (see smoke.ts): in stable air the buoyancy of a
//   rising parcel falls as N^2 times its volume flux, so a thermal levels off at a height that scales as (B / N^2)^(1/4).
// - G. K. Batchelor, "Diffusion in a field of homogeneous turbulence II. The relative motion of particles", Proc. Camb.
//   Phil. Soc. 48(2), 345-362, 1952, https://doi.org/10.1017/S0305004100027705, and J. P. L. C. Salazar and L. R.
//   Collins, "Two-particle dispersion in isotropic turbulent flows", Annu. Rev. Fluid Mech. 41, 405-432, 2009,
//   https://doi.org/10.1146/annurev.fluid.40.111406.102224: once a cloud has no motion of its own, the air's turbulence
//   spreads it at Richardson's law, sigma^2 = g_R eps t^3 with g_R about 0.5. W. G. Large and S. Pond, "Open ocean
//   momentum flux measurements in moderate to strong winds", J. Phys. Oceanogr. 11, 324-336, 1981,
//   https://doi.org/10.1175/1520-0485(1981)011<0324:OOMFMI>2.0.CO;2: drag coefficient 1.2e-3 over the sea (4 to 11 m/s),
//   so the friction velocity is sqrt(1.2e-3) U and the surface layer's dissipation u*^3 / (kappa z).
// - S. F. Hoerner, Fluid-Dynamic Drag, 1965, ch. 16 ("Drag at transonic and supersonic speeds"): a sphere's drag
//   coefficient is about 0.47 at subsonic speeds, climbs through the transonic range and stays near 0.92 to 1.0
//   supersonic. A round shot leaves a 32-pounder at about Mach 1.4.
// - K. Kawagoe, "Fire behaviour in rooms", Building Research Institute Report 27, Tokyo, 1958, and D. Drysdale, An
//   Introduction to Fire Dynamics, 3rd ed., Wiley 2011, ch. 10: a ventilation-limited compartment burns wood at
//   0.09 A sqrt(H) kg/s through an opening of area A and height H (5.5 kg/min per m^(5/2)); M. Law, "Fire safety of
//   external building elements", AISC Engineering Journal 15(2), 59-74, 1978: the flame out of the opening stands
//   12.8 (R / w)^(2/3) - H above its top for a burning rate R kg/s through an opening w wide. A burning gun deck is such
//   a compartment and each open gun port is its opening.
// - G. W. Mulholland and C. Croarkin, "Specific extinction coefficient of flame generated smoke", Fire and Materials 24,
//   227-230, 2000, https://doi.org/10.1002/1099-1018(200009/10)24:5<227::AID-FAM742>3.0.CO;2-9: soot extinguishes
//   8.7 m^2/g, nearly independent of fuel; its single-scattering albedo is low (about 0.25), so a little soot turns a
//   pale smoke dark. Tewarson, SFPE Handbook ch. 3-4: wood yields 0.015 g of soot a gram burnt, tars and pitch far more.
// - R. L. McCoy, Modern Exterior Ballistics, Schiffer 1999, ch. 8: drag acts on the velocity relative to the air, so a
//   crosswind W moves a flat-fired ball W (T - X / u0) sideways (the lag-time rule) over a flight of T seconds and X m.
// - J. A. Conkling and C. J. Mocella, Chemistry of Pyrotechnics, 3rd ed., CRC 2019, ch. 4 and 7: black powder burns
//   from its surface at a linear rate of the order of 1 cm/s at one atmosphere (Piobert's law: layer by layer), pressed
//   grains are 1.7 to 1.8 g/cm^3; so a grain of diameter d that leaves the bore alight burns out in d / (2 r), and its
//   quadratic drag stops it within (4/3) d rho_grain / (rho_air C_D) metres (its stopping length).
// - J.-V. Poncelet's resistance law (as W. Johnson, Impact Strength of Materials, Arnold 1972, ch. 9, and M. J.
//   Forrestal and D. Y. Tzou, "A spherical cavity-expansion penetration model for concrete targets", Int. J. Solids
//   Struct. 34(31), 4127-4146, 1997, https://doi.org/10.1016/S0020-7683(97)00017-6, write it): a projectile of
//   cross-section A in a solid meets A (R + B v^2), a strength term and an inertial term rho_t v^2 / 2, so it stops in
//   (m / (2 B A)) ln(1 + B v^2 / R) and leaves a plate of thickness t at v^2 = (R / B + v0^2) e^(-2 B A t / m) - R / B.
//   Forest Products Laboratory, Wood Handbook, FPL-GTR-190, 2010, table 5-3a: white oak (12% moisture) has a specific
//   gravity of 0.68 and a compressive strength across the grain of 7.4 MPa (the side of a hull is struck across it).
// - EN 1995-1-2:2004 (Eurocode 5, Design of timber structures, Structural fire design), 3.4.2 and table 3.1: wood under
//   a standard fire chars at a one-dimensional rate beta_0 of 0.65 mm/min (softwood) and 0.50 mm/min (hardwood such as
//   oak); the char line is the 300 C isotherm. A hull's planks char at that rate while the fire over them burns.
// - G. Varieschi and K. Kamiya, "Toy models for the falling chimney", Am. J. Phys. 71(10), 1025-1031, 2003,
//   https://doi.org/10.1119/1.1576401: a tall uniform rod pivoting on its foot topples as theta'' = (3 g / 2 L) sin theta,
//   so at angle theta it turns at sqrt(3 g (cos theta_0 - cos theta) / L). A mast whose stays have burnt falls so.
// Margo's own choices are named where they are made (puff counts, the flash's time curve, the hull's sections).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { finiteVector } from '@margoengine/math/validate';
import type { Clustered, PointLight } from '@margoengine/clustered';
import type { LightGroup, LightGroups } from '@margoengine/clustered/groups';
import { VFX, type VFXOptions, type VFXWind } from '@margoengine/vfx/base';
import { curves } from '@margoengine/vfx/curves';
import { overLife } from '@margoengine/vfx/over-life';
import { stretch } from '@margoengine/vfx/stretch';
import { Clouds, type Cloud, type CloudsOptions } from '@margoengine/vfx/clouds';
import { Flame } from '@margoengine/vfx/flame';
import { Smoke } from '@margoengine/vfx/smoke';
import { blackbodyColor } from './flame-ramp.js';

type Vec3 = readonly [number, number, number];
type V3 = [number, number, number];

const G = 9.81,
  AIR_DENSITY = 1.225,
  AIR_HEAT = 1005,
  AIR_TEMPERATURE = 288.15,
  SOUND = 340.3;

/** Service black powder (Noble and Abel 1875): what a kilogram burns to. */
export const BLACK_POWDER = Object.freeze({
  /** Mass fractions of the mix: saltpetre, charcoal, sulphur. */
  saltpetre: 0.75,
  charcoal: 0.15,
  sulphur: 0.1,
  /** Share of the mass that leaves as permanent gas (CO2, CO, N2, H2S, H2, CH4). */
  gasFraction: 0.4298,
  /** Share left as solids: K2CO3, K2SO4, K2S. In the air they are the white smoke. */
  solidFraction: 0.5591,
  /** Share left as water vapour. */
  waterFraction: 0.0111,
  /** Permanent gas, cubic metres a kilogram at 0 C and 1 atm (271.3 cm^3/g). */
  gasVolume: 0.2713,
  /** Heat of explosion, joules a kilogram (718.1 cal/g). */
  heat: 718.1 * 4184,
  /** Explosion temperature, kelvin (about 2,200 C). */
  flameTemperature: 2473,
});

/** What a charge of black powder burns to, from {@link powderProducts}. */
export interface PowderProducts {
  /** Permanent gas, kg. */
  gas: number;
  /** Solids, kg: the smoke. */
  smoke: number;
  /** Water vapour, kg. */
  water: number;
  /** Permanent gas at 0 C and 1 atm, m^3. */
  gasVolume: number;
  /** Heat of explosion, joules. */
  heat: number;
}

const check = (v: number, label: string, min: number, max: number, open = false): number => {
  if (!(typeof v === 'number' && Number.isFinite(v) && (open ? v > min : v >= min) && v <= max))
    throw new RangeError(
      `Gunfire ${label} is ${v}; pass a finite number ${open ? 'above' : 'from'} ${min} ${open ? 'and at most' : 'to'} ${max}`,
    );
  return v;
};

/**
 * The products of `charge` kilograms of service black powder (Noble and Abel 1875): gas, smoke solids, water, the gas
 * volume at 0 C and the heat. A 32-pounder's 4.5 kg (10 lb) charge leaves 2.5 kg of smoke.
 */
export function powderProducts(charge: number): PowderProducts {
  check(charge, 'charge', 0, 10000);
  const p = BLACK_POWDER;
  return {
    gas: charge * p.gasFraction,
    smoke: charge * p.solidFraction,
    water: charge * p.waterFraction,
    gasVolume: charge * p.gasVolume,
    heat: charge * p.heat,
  };
}

/** A gun's muzzle flash, from {@link muzzleFlash}. */
export interface MuzzleFlash {
  /** Radius of the fireball, metres. */
  radius: number;
  /** Time constant of its fade, seconds. */
  duration: number;
  /** Its colour: the blackbody of the explosion temperature (linear RGB, brightest channel 1). */
  color: [number, number, number];
}

/** Default fade of a large gun's secondary flash, seconds (tens of milliseconds, Klingenberg and Heimerl 1992). */
export const FLASH_DURATION = 0.04;

/** Alpha of a flash billboard: its radiance rides in the intensity divided by this, so it adds light (the flash is
 * glowing gas, not a surface) and a dimmed particle covers only this share of the scene behind it. */
export const FLASH_ALPHA = 0.05;

/**
 * The flash of `charge` kg of powder: a ball of the charge's gas at its explosion temperature and 1 atm (its permanent
 * gas and water at 0 C times T / 273.15), so a 4.5 kg charge flashes about 1.4 m across in radius; it fades with a time
 * constant of `duration` (default {@link FLASH_DURATION}) in the blackbody colour of 2,473 K.
 */
export function muzzleFlash(charge: number, duration = FLASH_DURATION): MuzzleFlash {
  const p = powderProducts(charge),
    // Water vapour: 22.4 L a mole at 0 C, 18 g a mole.
    volume = ((p.gasVolume + (p.water * 22.414) / 18.015) * BLACK_POWDER.flameTemperature) / 273.15;
  check(duration, 'flash duration', 0, 10, true);
  return {
    radius: Math.cbrt((3 * volume) / (4 * Math.PI)),
    duration,
    color: blackbodyColor(BLACK_POWDER.flameTemperature),
  };
}

/**
 * The share of a flash's peak brightness a frame records: the flash e^(-t / duration) averaged over the shutter, open
 * for `shutter` seconds up to the frame `age` seconds after the shot. A flash shorter than a frame is still on the frame
 * that holds it, and the frames of a 360 degree shutter add up to the same light at any frame rate (duration times the
 * peak), as a film camera records it.
 */
export function flashExposure(age: number, shutter: number, duration = FLASH_DURATION): number {
  if (!(Number.isFinite(age) && Number.isFinite(shutter) && shutter >= 0 && duration > 0))
    throw new RangeError('Gunfire flashExposure needs finite numbers, shutter 0 or more, duration above 0');
  if (age < 0) return 0;
  if (shutter < 1e-9) return Math.exp(-age / duration);
  const open = Math.max(0, age - shutter);
  return (duration / shutter) * (Math.exp(-open / duration) - Math.exp(-age / duration));
}

/** The settings of a {@link powderPuff}. */
export interface PuffSettings {
  /** Powder charge, kg. */
  charge: number;
  /** Muzzle velocity of the shot, m/s. */
  muzzleVelocity: number;
  /** The barrel's elevation above the horizontal, radians. Default 0. */
  elevation?: number;
  /**
   * The gas's momentum as a multiple of charge x muzzle velocity: the powder gas leaves behind the shot faster than it
   * (the recoil "after-effect", 1.5 for black powder in the gunnery manuals that follow Corner's Theory of the Interior
   * Ballistics of Guns, 1950). Default 1.5.
   */
  momentum?: number;
  /** Share of the heat of explosion still in the gas as it leaves the muzzle, 0 to 1. Default 0.4. */
  heatFraction?: number;
  /** Radius over distance travelled through the air (Richards 1965, Scorer 1957: about 0.25). Default 0.25. */
  entrainment?: number;
  /** Air stability N^2 = (g / T) dtheta/dz, 1/s^2, 0 or more. Default 0. */
  stability?: number;
  /** Air temperature, kelvin. Default 288.15. */
  airTemperature?: number;
  /** Seconds the table covers. Default 600. */
  duration?: number;
}

/** The bank `t` seconds after the shot, relative to the air, from {@link PowderPuff.at}. */
export interface PuffPoint {
  /** Distance travelled along the barrel's bearing, metres (horizontal). */
  along: number;
  /** Height gained, metres. */
  rise: number;
  /** Radius of the puff, metres. */
  radius: number;
  /** Speed relative to the air, m/s. */
  speed: number;
}

/** Samples of a puff's table. */
const PUFF_SAMPLES = 160;

/**
 * A powder-smoke puff as the integral model of an isolated turbulent puff and thermal (Richards 1965; Scorer 1957; MTT
 * 1956): its volume V = 4/3 pi (alpha s)^3 grows with the distance s it has moved through the air, its momentum (per
 * unit air density) keeps the gas's momentum along the barrel and gains its buoyancy B upward, and in stable air its
 * buoyancy falls at N^2 V w. So the bank shoots out of the gun, stops within tens of metres, rises slowly as a warm
 * thermal, levels off in stable air and hangs; the wind carries it as a whole (add the wind's drift). Integrated once
 * with fourth-order Runge-Kutta in time steps that grow from 1 ms, tabulated, so `at(t)` is the same at any frame rate.
 */
export class PowderPuff {
  /** Puff radius at the muzzle, metres: the flash's ball of gas. */
  readonly startRadius: number;
  /** Momentum at the muzzle per unit air density, m^4/s. */
  readonly momentum: number;
  /** Buoyancy at the muzzle, g' V, m^4/s^2. */
  readonly buoyancy: number;
  /** Seconds the table covers. */
  readonly duration: number;
  private readonly times = new Float64Array(PUFF_SAMPLES);
  private readonly table = new Float64Array(PUFF_SAMPLES * 4);
  constructor(settings: PuffSettings) {
    if (!settings || typeof settings !== 'object') throw new TypeError('PowderPuff needs {charge, muzzleVelocity}');
    const charge = check(settings.charge, 'charge', 0, 10000, true),
      v0 = check(settings.muzzleVelocity, 'muzzleVelocity', 0, 3000, true),
      elevation = check(settings.elevation ?? 0, 'elevation', -Math.PI / 2, Math.PI / 2),
      beta = check(settings.momentum ?? 1.5, 'momentum', 0, 10),
      heatFraction = check(settings.heatFraction ?? 0.4, 'heatFraction', 0, 1),
      alpha = check(settings.entrainment ?? 0.25, 'entrainment', 0.05, 1),
      n2 = check(settings.stability ?? 0, 'stability', 0, 1),
      airT = check(settings.airTemperature ?? AIR_TEMPERATURE, 'airTemperature', 150, 350),
      duration = check(settings.duration ?? 600, 'duration', 1, 7200);
    this.duration = duration;
    const r0 = muzzleFlash(charge).radius,
      p = powderProducts(charge);
    this.startRadius = r0;
    this.momentum = (beta * charge * v0) / AIR_DENSITY;
    this.buoyancy = (G * heatFraction * p.heat) / (AIR_HEAT * AIR_DENSITY * airT);
    // State: s (path through the air), ph and py (momentum per unit density, along the bearing and up), b (buoyancy),
    // x and z (distance along and height).
    const k3 = (4 / 3) * Math.PI * alpha ** 3;
    const deriv = (y: Float64Array, out: Float64Array): void => {
      const V = k3 * y[0]! ** 3,
        uh = y[1]! / V,
        uy = y[2]! / V;
      out[0] = Math.hypot(uh, uy);
      out[1] = 0;
      out[2] = y[3]!;
      out[3] = -n2 * V * uy;
      out[4] = uh;
      out[5] = uy;
    };
    const y = new Float64Array([
      r0 / alpha,
      this.momentum * Math.cos(elevation),
      this.momentum * Math.sin(elevation),
      this.buoyancy,
      0,
      0,
    ]);
    const k1 = new Float64Array(6),
      k2 = new Float64Array(6),
      kk3 = new Float64Array(6),
      k4 = new Float64Array(6),
      tmp = new Float64Array(6);
    const step = (dt: number): void => {
      deriv(y, k1);
      for (let i = 0; i < 6; i++) tmp[i] = y[i]! + 0.5 * dt * k1[i]!;
      deriv(tmp, k2);
      for (let i = 0; i < 6; i++) tmp[i] = y[i]! + 0.5 * dt * k2[i]!;
      deriv(tmp, kk3);
      for (let i = 0; i < 6; i++) tmp[i] = y[i]! + dt * kk3[i]!;
      deriv(tmp, k4);
      for (let i = 0; i < 6; i++) y[i] = y[i]! + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * kk3[i]! + k4[i]!);
    };
    // Samples at t = 0 and log-spaced from 1 ms; steps of at most a fiftieth of the gap to the next sample.
    const first = 1e-3,
      ratio = Math.pow(duration / first, 1 / (PUFF_SAMPLES - 2));
    let t = 0;
    const record = (i: number): void => {
      const V = k3 * y[0]! ** 3;
      this.times[i] = t;
      this.table[i * 4] = y[4]!;
      this.table[i * 4 + 1] = y[5]!;
      this.table[i * 4 + 2] = alpha * y[0]!;
      this.table[i * 4 + 3] = Math.hypot(y[1]!, y[2]!) / V;
    };
    record(0);
    for (let i = 1; i < PUFF_SAMPLES; i++) {
      const target = first * ratio ** (i - 1),
        n = Math.max(1, Math.ceil(50 * Math.min(1, (target - t) / Math.max(target, 1e-9)) * 4));
      const dt = (target - t) / n;
      for (let j = 0; j < n; j++) step(dt);
      t = target;
      record(i);
    }
  }
  /** The puff `seconds` after the shot, relative to the air (clamped to the table). */
  at(seconds: number, out?: PuffPoint): PuffPoint {
    const p = out ?? { along: 0, rise: 0, radius: 0, speed: 0 },
      times = this.times,
      t = Math.max(0, Math.min(this.duration, seconds));
    let lo = 0,
      hi = PUFF_SAMPLES - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= t) lo = mid;
      else hi = mid;
    }
    const f = times[hi]! > times[lo]! ? (t - times[lo]!) / (times[hi]! - times[lo]!) : 0,
      a = lo * 4,
      b = hi * 4,
      T = this.table;
    p.along = T[a]! + (T[b]! - T[a]!) * f;
    p.rise = T[a + 1]! + (T[b + 1]! - T[a + 1]!) * f;
    p.radius = T[a + 2]! + (T[b + 2]! - T[a + 2]!) * f;
    p.speed = T[a + 3]! + (T[b + 3]! - T[a + 3]!) * f;
    return p;
  }
}

/**
 * Richardson's relative dispersion of a cloud `seconds` after it stopped moving of itself, metres (sigma, one axis):
 * sigma^2 = g_R eps t^3 (Batchelor 1952; g_R 0.5, Salazar and Collins 2009), with the sea surface layer's dissipation
 * eps = u*^3 / (0.4 z), u* = sqrt(1.2e-3) U (Large and Pond 1981), at height `height` (default 10 m) in a wind of `wind`
 * m/s. 0 in calm air (the bank then thins by its own growth only).
 */
export function smokeDispersion(seconds: number, wind: number, height = 10, constant = 0.5): number {
  if (!(seconds >= 0 && wind >= 0 && height > 0 && constant >= 0))
    throw new RangeError('Gunfire smokeDispersion needs seconds, wind and constant 0 or more and a height above 0');
  const ustar = Math.sqrt(1.2e-3) * wind,
    eps = ustar ** 3 / (0.4 * height);
  return Math.sqrt(constant * eps * seconds ** 3);
}

/** A sphere's drag coefficient at Mach `mach` (Hoerner 1965 ch. 16): 0.47 subsonic, rising through Mach 0.6 to 1.2, 0.95 to 0.92 beyond. */
export function sphereDrag(mach: number): number {
  const M = Math.max(0, mach);
  const knots: readonly [number, number][] = [
    [0, 0.47],
    [0.6, 0.5],
    [0.8, 0.6],
    [1, 0.82],
    [1.2, 0.95],
    [2, 0.92],
    [5, 0.92],
  ];
  for (let i = 1; i < knots.length; i++) {
    const [m1, c1] = knots[i]!;
    if (M <= m1) {
      const [m0, c0] = knots[i - 1]!;
      return c0 + ((c1 - c0) * (M - m0)) / (m1 - m0);
    }
  }
  return 0.92;
}

/** A round shot: iron by default. */
export interface RoundShot {
  /** Mass, kg. Default 14.5 (a 32-pounder). */
  mass?: number;
  /** Density, kg/m^3. Default 7,200 (cast iron). */
  density?: number;
}
/** Where a shot meets the water, from {@link shotFlight}. */
export interface ShotImpact {
  /** Film time of the impact, seconds (fire time plus the flight). */
  time: number;
  /** Where it meets the water, world units. */
  position: V3;
  /** Velocity there, m/s. */
  velocity: V3;
  /** Shot radius, metres. */
  radius: number;
  /** Shot density, kg/m^3. */
  density: number;
}
/** Anything that gives the water's height at world XZ (a `WaveQuery` of `@margoengine/water/query`). */
export interface WaterLevel {
  sample(x: number, z: number): { height: number } | undefined;
}

const shotRadius = (mass: number, density: number): number => Math.cbrt((3 * mass) / (4 * Math.PI * density));

/** White oak across the grain (Wood Handbook 2010, table 5-3a): density kg/m^3 and compressive strength Pa. */
export const OAK = Object.freeze({ density: 680, strength: 7.4e6 });
/** The wood a shot meets: density, kg/m^3, and strength, Pa. Default {@link OAK}. */
export interface Wood {
  density?: number;
  strength?: number;
}
const woodOf = (wood: Wood = {}): { density: number; strength: number } => ({
  density: check(wood.density ?? OAK.density, 'wood density', 100, 2000),
  strength: check(wood.strength ?? OAK.strength, 'wood strength', 1e5, 1e9),
});
/**
 * How deep a ball of `radius` m and `mass` kg striking wood at `speed` m/s (the part of its velocity into the
 * surface) goes, metres, by Poncelet's law: (m / (2 B A)) ln(1 + B v^2 / R), B = rho_wood / 2 (an inertial coefficient
 * of 1, Margo's) and R the wood's strength.
 */
export function woodPenetration(speed: number, radius: number, mass: number, wood?: Wood): number {
  const w = woodOf(wood),
    v = check(speed, 'strike speed', 0, 3000),
    A = Math.PI * check(radius, 'shot radius', 1e-4, 10) ** 2,
    m = check(mass, 'shot mass', 0, 2000, true),
    B = 0.5 * w.density;
  return (m / (2 * B * A)) * Math.log(1 + (B * v * v) / w.strength);
}
/** The speed a ball keeps after going through `thickness` m of wood it struck at `speed` (Poncelet's law), 0 if it stops in it. */
export function woodExitSpeed(speed: number, radius: number, mass: number, thickness: number, wood?: Wood): number {
  const w = woodOf(wood),
    v = check(speed, 'strike speed', 0, 3000),
    A = Math.PI * check(radius, 'shot radius', 1e-4, 10) ** 2,
    m = check(mass, 'shot mass', 0, 2000, true),
    t = check(thickness, 'thickness', 0, 100),
    q = w.strength / (0.5 * w.density),
    v2 = (q + v * v) * Math.exp((-2 * 0.5 * w.density * A * t) / m) - q;
  return v2 > 0 ? Math.sqrt(v2) : 0;
}

/** A ship a shot can hit: its hull as an elliptic cylinder in its frame (+X port, +Y up, +Z forward). */
export interface ShotTarget {
  /** The ship (a `Floater`, its `matrix()` read at the shot) or a fixed world matrix (16 numbers). */
  ship: Carrier | ArrayLike<number>;
  /** Length and beam at the waterline, metres. Default 50 by 13. */
  length?: number;
  beam?: number;
  /** Top of the side above the hull origin (the waterline), and the keel below it, metres. Default 6 and 5. */
  height?: number;
  draft?: number;
  /** The side's timber, metres. Default 0.5 (a ship of the line's side at the gun decks). */
  thickness?: number;
  /** The timber. Default {@link OAK}. */
  wood?: Wood;
  /** A hull mask (see {@link hullMaskImage}) the holes are drawn into, its blue channel. Default none. */
  mask?: HullMask;
}
/** A shot's strike on a ship, from {@link shotPath} and `Battery.hits()`. */
export interface HullHit {
  /** Index into the targets. */
  target: number;
  /** `ricochet`: it glanced off; `through`: it holed the side and went in; `exit`: it left through the far side; `lodged`: it stopped in the timber. */
  kind: 'ricochet' | 'through' | 'exit' | 'lodged';
  /** Film time, seconds. */
  time: number;
  /** World point of the strike, and the hull-local one. */
  position: V3;
  local: V3;
  /** World normal of the side, out of the hull. */
  normal: V3;
  /** The shot's velocity before and after, m/s. */
  velocity: V3;
  after: V3;
  /** How deep the strike would go into the timber, metres (Poncelet). */
  depth: number;
  /** Radius of the hole (0 for a ricochet's gouge), metres. */
  hole: number;
  /** Splinters it throws (before the battery's `splinters` multiple). */
  splinters: number;
}
/** What {@link shotPath} returns: the strikes on ships, in order, and where the shot meets the water, if it does. */
export interface ShotPath {
  hits: HullHit[];
  impact?: ShotImpact;
}
/** A ball's speed kept along the side and its rebound off it when it glances (Margo's: 0.8 and 0.3). */
const RICOCHET_TANGENT = 0.8,
  RICOCHET_REBOUND = 0.3;
/** Volume of one splinter, m^3: a hand-sized piece 15 by 2 by 2 cm (Margo's). */
const SPLINTER_VOLUME = 0.15 * 0.02 * 0.02;

const matrixOf = (s: Carrier | ArrayLike<number>): ArrayLike<number> =>
  typeof (s as Carrier).matrix === 'function' ? (s as Carrier).matrix() : (s as ArrayLike<number>);
/** World to the frame of a rigid (rotation, translation, uniform or axis scale) matrix. */
const inverseRigid = (m: ArrayLike<number>, p: Vec3): V3 => {
  const d = [p[0] - m[12]!, p[1] - m[13]!, p[2] - m[14]!],
    out: V3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const x = m[c * 4]!,
      y = m[c * 4 + 1]!,
      z = m[c * 4 + 2]!;
    out[c] = (d[0]! * x + d[1]! * y + d[2]! * z) / (x * x + y * y + z * z || 1);
  }
  return out;
};
interface Hull {
  m: ArrayLike<number>;
  a: number;
  b: number;
  top: number;
  keel: number;
  thickness: number;
  wood: { density: number; strength: number };
}
const hullOf = (t: ShotTarget): Hull => {
  if (!t || typeof t !== 'object' || !t.ship)
    throw new TypeError('Gunfire target needs {ship}: a Floater or a world matrix');
  const m = matrixOf(t.ship);
  if (!m || m.length < 16) throw new TypeError('Gunfire target ship must have matrix() or be 16 numbers');
  return {
    m,
    a: check(t.beam ?? 13, 'target beam', 0.5, 100) / 2,
    b: check(t.length ?? 50, 'target length', 1, 500) / 2,
    top: check(t.height ?? 6, 'target height', 0, 50),
    keel: -check(t.draft ?? 5, 'target draft', 0, 50),
    thickness: check(t.thickness ?? 0.5, 'target thickness', 0.01, 10),
    wood: woodOf(t.wood),
  };
};
const insideHull = (h: Hull, l: Vec3): boolean =>
  l[1] >= h.keel && l[1] <= h.top && (l[0] / h.a) ** 2 + (l[2] / h.b) ** 2 <= 1;
/** The outward world normal of the hull at a local point on it: the deck (up) when it is at the top, else the side. */
const hullNormal = (h: Hull, l: Vec3): V3 => {
  const side = (l[0] / h.a) ** 2 + (l[2] / h.b) ** 2,
    n: V3 = side < 0.98 && l[1] > h.top - 0.05 ? [0, 1, 0] : [l[0] / (h.a * h.a), 0, l[2] / (h.b * h.b)],
    w = transformDir(h.m, n),
    k = Math.hypot(w[0], w[1], w[2]) || 1;
  return [w[0] / k, w[1] / k, w[2] / k];
};

/** The flight of {@link shotPath}: the water, the wind, ships and the drag. */
export interface ShotPathOptions {
  /** Film time of the shot. Default 0. */
  fireTime?: number;
  /** Sea level when there is no `water`. Default 0. */
  seaLevel?: number;
  /** The water's height. Default the plane `seaLevel`. */
  water?: WaterLevel;
  /** The wind, `[x, z]` m/s or a field `{sample(x, y, z, t)}`: the drag acts on the velocity relative to it. Default calm. */
  wind?: VFXWind;
  /** Ships the shot can strike. Default none. */
  targets?: readonly ShotTarget[];
  /** Seconds of flight at most. Default 30. */
  maxTime?: number;
  /** Air drag on (Hoerner's sphere). Default true. */
  drag?: boolean;
}
/**
 * Flies a round shot from `from` along `direction` at `speed` m/s under gravity and the sphere drag of
 * {@link sphereDrag} on its velocity relative to the `wind` (fourth-order Runge-Kutta, 2 ms steps), through any
 * `targets`: at a ship's side it glances off when Poncelet's law cannot sink it a radius into the timber, holes it and
 * goes on at Poncelet's exit speed when the side is thinner than its reach, and else lodges; inside, it meets the far
 * side the same way. It ends at the water (`water`, or the plane `seaLevel`), lodged, or after `maxTime` seconds.
 * The ships are where their `matrix()` puts them at the shot.
 */
export function shotPath(
  from: Vec3,
  direction: Vec3,
  speed: number,
  shot: RoundShot = {},
  options: ShotPathOptions = {},
): ShotPath {
  finiteVector(from, 3, 'Gunfire shot position');
  finiteVector(direction, 3, 'Gunfire shot direction');
  check(speed, 'shot speed', 0, 3000);
  const mass = check(shot.mass ?? 14.5, 'shot mass', 0, 2000, true),
    density = check(shot.density ?? 7200, 'shot density', 500, 25000),
    radius = shotRadius(mass, density),
    area = Math.PI * radius * radius,
    len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) throw new RangeError('Gunfire shot direction must not be zero');
  const sea = options.seaLevel ?? 0,
    maxTime = check(options.maxTime ?? 30, 'maxTime', 0, 600),
    drag = options.drag ?? true,
    fireTime = options.fireTime ?? 0,
    wind = options.wind,
    hulls = (options.targets ?? []).map(hullOf),
    inside = hulls.map((h) => insideHull(h, inverseRigid(h.m, from))),
    hits: HullHit[] = [],
    height = (x: number, z: number): number => options.water?.sample(x, z)?.height ?? sea;
  const s = [
    from[0],
    from[1],
    from[2],
    (direction[0] / len) * speed,
    (direction[1] / len) * speed,
    (direction[2] / len) * speed,
  ];
  const deriv = (y: number[], t: number): number[] => {
    const [wx, wz] = windAt(wind, [y[0]!, y[1]!, y[2]!], fireTime + t),
      rx = y[3]! - wx,
      ry = y[4]!,
      rz = y[5]! - wz,
      u = Math.hypot(rx, ry, rz),
      k = drag && u > 0 ? (0.5 * AIR_DENSITY * sphereDrag(u / SOUND) * area * u) / mass : 0;
    return [y[3]!, y[4]!, y[5]!, -k * rx, -G - k * ry, -k * rz];
  };
  const dt = 0.002;
  let t = 0;
  const strike = (h: number, a: number[], b: number[], leaving: boolean): 'on' | 'lodged' => {
    // Bisect the step to the side, then strike it with the part of the velocity into (or out through) the timber.
    const hull = hulls[h]!;
    let lo = 0,
      hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2,
        p: V3 = [a[0]! + (b[0]! - a[0]!) * mid, a[1]! + (b[1]! - a[1]!) * mid, a[2]! + (b[2]! - a[2]!) * mid];
      if (insideHull(hull, inverseRigid(hull.m, p)) !== leaving) hi = mid;
      else lo = mid;
    }
    const at = a.map((x, i) => x + (b[i]! - x) * hi),
      p: V3 = [at[0]!, at[1]!, at[2]!],
      v: V3 = [at[3]!, at[4]!, at[5]!],
      local = inverseRigid(hull.m, p),
      n = hullNormal(hull, local),
      vn = Math.abs(v[0] * n[0] + v[1] * n[1] + v[2] * n[2]),
      depth = woodPenetration(Math.min(3000, vn), radius, mass, hull.wood),
      time = fireTime + t + hi * dt,
      hit: HullHit = {
        target: h,
        kind: 'lodged',
        time,
        position: p,
        local,
        normal: n,
        velocity: v,
        after: [0, 0, 0],
        depth,
        hole: radius * 1.1,
        splinters: 0,
      };
    hits.push(hit);
    if (!leaving && depth < radius) {
      // A glance: the ball keeps most of its run along the side and rebounds off it.
      const tangent: V3 = [v[0] + vn * n[0], v[1] + vn * n[1], v[2] + vn * n[2]];
      hit.kind = 'ricochet';
      hit.hole = 0;
      hit.after = [
        RICOCHET_TANGENT * tangent[0] + RICOCHET_REBOUND * vn * n[0],
        RICOCHET_TANGENT * tangent[1] + RICOCHET_REBOUND * vn * n[1],
        RICOCHET_TANGENT * tangent[2] + RICOCHET_REBOUND * vn * n[2],
      ];
      hit.splinters = Math.round((area * depth) / SPLINTER_VOLUME);
      for (let i = 0; i < 3; i++) {
        s[i] = p[i]! + n[i]! * radius * 0.01;
        s[i + 3] = hit.after[i]!;
      }
      return 'on';
    }
    const exit = woodExitSpeed(Math.min(3000, vn), radius, mass, hull.thickness, hull.wood);
    hit.splinters = Math.round((area * Math.min(depth, hull.thickness)) / SPLINTER_VOLUME);
    if (exit <= 0) return 'lodged';
    hit.kind = leaving ? 'exit' : 'through';
    const k = exit / vn;
    hit.after = [v[0] * k, v[1] * k, v[2] * k];
    const u = Math.hypot(v[0], v[1], v[2]) || 1;
    for (let i = 0; i < 3; i++) {
      // Through the timber along its path: just inside the side (or just out of it).
      s[i] = p[i]! + (v[i]! / u) * (leaving ? radius * 0.01 : hull.thickness + radius * 0.01);
      s[i + 3] = hit.after[i]!;
    }
    inside[h] = !leaving;
    return 'on';
  };
  while (t < maxTime) {
    const k1 = deriv(s, t),
      k2 = deriv(
        s.map((v, i) => v + 0.5 * dt * k1[i]!),
        t + dt / 2,
      ),
      k3 = deriv(
        s.map((v, i) => v + 0.5 * dt * k2[i]!),
        t + dt / 2,
      ),
      k4 = deriv(
        s.map((v, i) => v + dt * k3[i]!),
        t + dt,
      ),
      next = s.map((v, i) => v + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!));
    let struck = false;
    for (let h = 0; h < hulls.length && !struck; h++) {
      const now = insideHull(hulls[h]!, inverseRigid(hulls[h]!.m, [next[0]!, next[1]!, next[2]!]));
      if (now === inside[h]) continue;
      if (strike(h, s, next, inside[h]!) === 'lodged') return { hits };
      struck = true;
    }
    if (struck) {
      t += dt;
      continue;
    }
    const inHull = inside.some(Boolean),
      above0 = s[1]! - height(s[0]!, s[2]!),
      above1 = next[1]! - height(next[0]!, next[2]!);
    if (!inHull && above1 <= 0 && above0 > 0) {
      // Linear in the step to where the height above the water crosses 0.
      const f = above0 / (above0 - above1),
        at = s.map((v, i) => v + (next[i]! - v) * f);
      return {
        hits,
        impact: {
          time: fireTime + t + f * dt,
          position: [at[0]!, height(at[0]!, at[2]!), at[2]!],
          velocity: [at[3]!, at[4]!, at[5]!],
          radius,
          density,
        },
      };
    }
    for (let i = 0; i < 6; i++) s[i] = next[i]!;
    t += dt;
  }
  return { hits };
}

/**
 * Flies a round shot from `from` along `direction` at `speed` m/s under gravity and the sphere drag of
 * {@link sphereDrag} on its velocity relative to the wind until it meets the water: {@link shotPath}'s impact.
 * Returns the impact, or undefined for a shot still in the air or stopped in a ship.
 */
export function shotFlight(
  from: Vec3,
  direction: Vec3,
  speed: number,
  shot: RoundShot = {},
  options: ShotPathOptions = {},
): ShotImpact | undefined {
  return shotPath(from, direction, speed, shot, options).impact;
}

// ---- Burning powder grains and sparks ----

/** Black powder's linear burning rate in the open, m/s: of the order of 1 cm/s at one atmosphere (Conkling and Mocella 2019). */
export const POWDER_BURN_RATE = 0.01;
/** Density of a pressed powder grain, kg/m^3 (1.7 to 1.8 g/cm^3, Conkling and Mocella 2019). */
export const GRAIN_DENSITY = 1750;
/** Share of a charge that leaves the muzzle as burning grains (Margo's: a few percent of a black-powder charge burns outside the bore). */
export const UNBURNT_FRACTION = 0.02;
/** The burning grains a shot throws, from {@link powderGrains}. */
export interface PowderGrains {
  /** Grains, before the battery's `sparks` multiple. */
  count: number;
  /** Seconds a grain burns: d / (2 r). */
  burnTime: number;
  /** Stopping length of a grain's quadratic drag, metres: (4/3) d rho_grain / (rho_air 0.47). */
  stopping: number;
  /** How far one goes before it burns out, metres (the drag of {@link sphereDrag} on its way). */
  reach: number;
  /** Its speed 0, 1/31 ... 1 of the way through its burn, over its start speed: 32 samples (a `VFX` overLife speed curve). */
  speeds: number[];
}
/**
 * The burning grains of `charge` kg of powder of grains `grain` metres across leaving the muzzle at `speed` m/s
 * (default the shot's 490): {@link UNBURNT_FRACTION} of the charge in grains of {@link GRAIN_DENSITY} that burn at
 * {@link POWDER_BURN_RATE} and slow under the sphere drag of {@link sphereDrag} (RK4, 1 ms steps).
 */
export function powderGrains(charge: number, grain = 0.003, speed = 490): PowderGrains {
  check(charge, 'charge', 0, 10000);
  const d = check(grain, 'grain', 5e-4, 0.02),
    v0 = check(speed, 'grain speed', 0, 3000),
    m1 = (Math.PI / 6) * d ** 3 * GRAIN_DENSITY,
    burnTime = d / (2 * POWDER_BURN_RATE),
    k = (0.5 * AIR_DENSITY * Math.PI * (d / 2) ** 2) / m1,
    speeds: number[] = [1];
  let v = v0,
    x = 0,
    t = 0;
  const h = 1e-3,
    a = (u: number) => -k * sphereDrag(u / SOUND) * u * u;
  for (let i = 1; i < 32; i++) {
    const until = (burnTime * i) / 31;
    while (t < until - 1e-12) {
      const dt = Math.min(h, until - t),
        k1 = a(v),
        k2 = a(v + 0.5 * dt * k1),
        k3 = a(v + 0.5 * dt * k2),
        k4 = a(v + dt * k3);
      x += (dt / 6) * (v + 2 * (v + 0.5 * dt * k1) + 2 * (v + 0.5 * dt * k2) + (v + dt * k3));
      v += (dt / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
      t += dt;
    }
    speeds.push(v0 > 0 ? Math.max(0, v / v0) : 0);
  }
  return {
    count: (charge * UNBURNT_FRACTION) / m1,
    burnTime,
    stopping: ((4 / 3) * d * GRAIN_DENSITY) / (AIR_DENSITY * 0.47),
    reach: x,
    speeds,
  };
}

/**
 * The colour (linear single-scattering albedo, grey) of a smoke whose particulate is `soot` (0..1) soot by mass and the
 * rest white matter (powder salts, tar mist, steam): soot extinguishes 8.7 m^2/g at albedo 0.25 (Mulholland and Croarkin
 * 2000), white particulate about 3 m^2/g at 0.97. So 0 is white powder smoke, 0.1 already a mid grey, 0.5 nearly black.
 */
export function smokeColor(soot: number): [number, number, number] {
  check(soot, 'soot', 0, 1);
  const es = 8.7 * soot,
    ew = 3 * (1 - soot),
    albedo = (0.25 * es + 0.97 * ew) / Math.max(1e-9, es + ew);
  // The albedo is reached by many scatterings in a thick cloud: draw it as a lit colour (a touch of warmth from tar).
  return [albedo, albedo * 0.985, albedo * 0.96];
}

// ---- Guns and the battery ----

/** Anything that carries guns or a fire: a `Floater` of `@margoengine/water/ships` (`matrix()` is its world transform). */
export interface Carrier {
  matrix(out?: Float32Array | number[]): ArrayLike<number>;
}

/** One gun of a {@link Battery}. */
export interface Gun {
  /** The muzzle, world units, or ship-local (+X port, +Y up, +Z forward) when the battery has a `ship`. */
  position: Vec3;
  /** Where the barrel points (world, or ship-local with a `ship`), not zero. */
  direction: Vec3;
  /** Powder charge, kg. Default 4.5 (a 32-pounder's 10 lb). */
  charge?: number;
  /** Muzzle velocity, m/s. Default 490. */
  muzzleVelocity?: number;
  /** The shot. Default a 14.5 kg iron ball. */
  shot?: RoundShot;
}
/** When a gun fires. */
export interface GunShot {
  /** Index into `guns`. */
  gun: number;
  /** Film time, seconds. */
  time: number;
}

/** `Battery.attach` settings. Numbers are read every frame unless marked. */
export interface BatteryOptions {
  /** The guns. Read at attach (their count). Up to 128. */
  guns: readonly Gun[];
  /** When they fire, any order (sorted at attach). More can be added with `fire`. Default none. */
  shots?: readonly GunShot[];
  /** The ship the guns stand on: their positions and directions are in its frame, read at each shot. Default none (world). */
  ship?: Carrier;
  /** The wind, `[x, z]` m/s or `{sample(x, y, z, t)}`. Default none: a `WeatherDrive` writes the weather's wind. */
  wind?: VFXWind;
  /** Where the water is, for the shots' fall: a water height source or a plane. Default the plane y = 0. */
  water?: WaterLevel;
  /** Sea level for the shots when there is no `water`. Default 0. */
  seaLevel?: number;
  /** Air stability N^2, 1/s^2, 0 or more: the banks level off. Read at a shot. Default 1e-4 (a slightly stable marine layer). */
  stability?: number;
  /** Share of the heat of explosion in the gas at the muzzle, 0..1. Read at a shot. Default 0.4. */
  heatFraction?: number;
  /** Puff radius over distance travelled through the air, 0.05..1. Read at a shot. Default 0.25. */
  entrainment?: number;
  /** Flash fade, seconds. Default {@link FLASH_DURATION}. */
  flashDuration?: number;
  /** Flash size as a multiple of the fireball radius. Default 1. */
  flashSize?: number;
  /** Peak radiance of the flash billboards (their HDR intensity). Default 40. */
  flashRadiance?: number;
  /** The light's intensity as a multiple of the flash's own (a sphere of the flash radius at its radiance). Default 1. */
  flashLight?: number;
  /** Shutter open time as a share of the frame (0.5 is a 180 degree shutter), 0..1. Default 0.5. */
  shutter?: number;
  /** Smoke mass extinction, m^2/g (white hygroscopic salt smoke). Default 3. */
  extinction?: number;
  /** Smoke colour, linear RGB. Default `smokeColor(0)`. */
  smokeColor?: Vec3;
  /** Richardson's constant g_R of the air's spreading of a bank, 0..5. Default 0.5. */
  dispersion?: number;
  /** Seconds a bank lives at most. Default 600. */
  smokeLife?: number;
  /** Most banks at once (the oldest is reused). Read at attach. Default 48, at most 512. */
  banks?: number;
  /** Puffs a bank is drawn with. Read at attach. Default 24. */
  puffs?: number;
  /** Lights on the scene: each gun's flash lights it through a group of its own. Read at attach. Default none. */
  lights?: Clustered | LightGroups;
  /** Settings of the banks' `Clouds` (light direction, colour, ambient, texture, depth...). Read every frame. */
  clouds?: Omit<CloudsOptions, 'limit' | 'density'>;
  /** Burning powder grains thrown out with the flash, a multiple of {@link powderGrains}' count, 0..10. Default 1. */
  sparks?: number;
  /** Radiance of a burning grain (its HDR intensity), 0..3,000. Default 30. */
  sparkRadiance?: number;
  /** Drawn width of a burning grain's streak, metres, 0.01..2: its flame and the film's halation round it, far wider than the grain (Margo's). Default 0.3. */
  sparkSize?: number;
  /** Grain size of the powder, metres, 0.0005..0.02. Read at a shot. Default 0.003 (cannon powder). */
  grain?: number;
  /** Ships the shots can strike (their poses read at each shot; not the battery's own ship). Read at a shot. Default none. */
  targets?: readonly ShotTarget[];
  /** Splinters a strike throws, a multiple of the hole's timber in hand-sized pieces, 0..10. Default 1. */
  splinters?: number;
}

/** One fired shot, as the battery tracks it. */
export interface FiredShot {
  gun: number;
  time: number;
  /** World muzzle and barrel direction at the shot. */
  muzzle: V3;
  direction: V3;
  /** The bank's wind drift at the shot, metres (the drift since is the bank's). */
  drift: [number, number];
  /** Where it meets the water, if it does within 30 s. */
  impact?: ShotImpact;
  /** Its strikes on the `targets`, in time order. */
  hits: HullHit[];
}

let nextId = 0;
const transformPoint = (m: ArrayLike<number>, p: Vec3): V3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];
const transformDir = (m: ArrayLike<number>, p: Vec3): V3 => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2],
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2],
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2],
];
const windAt = (wind: VFXWind | undefined, at: Vec3, t: number): [number, number] => {
  if (!wind) return [0, 0];
  if ('sample' in wind) {
    const v = wind.sample(at[0], at[1], at[2], t);
    return [v[0], v[2]];
  }
  return [wind[0], wind[1]];
};

/** A cloud's matrix before it is placed. */
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/**
 * A battery of muzzle-loading guns: each shot flashes (fireball billboards whose brightness is the flash averaged over
 * the camera's shutter, and a point light of the same radiance), throws out a bank of white powder smoke that grows,
 * stops, rises as a warm thermal, levels off and drifts with the wind, thinning by Richardson's law and the optical
 * depth of its 56% of solids, and flies its round shot to the water (`impacts`, for `ShotSplash` of
 * `@margoengine/water/splash`). Everything is a function of the battery's clock, so a film seek lands it.
 * A plugin of its scene: disposing the scene disposes it.
 */
export class Battery implements EnginePlugin {
  readonly name = 'vfx-gunfire:' + nextId++;
  /** Read every frame (see {@link BatteryOptions}). */
  readonly options: BatteryOptions;
  /** The banks of smoke (`clouds.puffs()` lists them). */
  readonly clouds: Clouds;
  /** Each gun's fireball billboards. */
  readonly flashes: VFX[] = [];
  /** Each gun's light (in the battery's light group), when `lights` was given. */
  readonly lights: PointLight[] = [];
  /** The shots fired so far, in time order. */
  readonly fired: FiredShot[] = [];
  /** Each gun's burning powder grains. */
  readonly sparks: VFX[] = [];
  /** The splinters of strikes on ships. */
  readonly splinters: VFX;
  private readonly pendingHits: HullHit[] = [];
  private hitCursor = 0;
  private engine?: Engine;
  private disposed = false;
  private clock = 0;
  private cursor = 0;
  private readonly queue: GunShot[];
  private readonly banks: { cloud: Cloud; shot: FiredShot | null; puff: PowderPuff | null }[] = [];
  private readonly drift: [number, number] = [0, 0];
  private readonly group?: LightGroup;
  private readonly target?: { setLights(l: readonly PointLight[]): unknown };
  private readonly puffs = new Map<string, PowderPuff>();
  private readonly point: PuffPoint = { along: 0, rise: 0, radius: 0, speed: 0 };
  private lastDelta = 1 / 30;
  private constructor(engine: EngineKernel, options: BatteryOptions) {
    this.options = options;
    if (!Array.isArray(options.guns) || options.guns.length < 1 || options.guns.length > 128)
      throw new TypeError('Battery needs 1 to 128 guns; pass {guns: [{position, direction}]}');
    for (const g of options.guns) this.checkGun(g);
    this.queue = [...(options.shots ?? [])];
    for (const s of this.queue) this.checkShot(s);
    this.queue.sort((a, b) => a.time - b.time || a.gun - b.gun);
    if (options.ship && typeof options.ship.matrix !== 'function')
      throw new TypeError('Battery ship needs matrix(), such as a Floater');
    this.checkLive();
    const banks = check(options.banks ?? 48, 'banks', 1, 512),
      puffs = check(options.puffs ?? 24, 'puffs', 4, 128);
    if (!Number.isInteger(banks) || !Number.isInteger(puffs))
      throw new RangeError('Battery banks and puffs must be whole numbers');
    const lights = options.lights,
      groups = lights && 'names' in lights && 'clustered' in lights ? lights : undefined,
      clustered = groups ? groups.clustered : lights && 'maxLights' in lights ? lights : undefined;
    if (lights && !clustered)
      throw new TypeError('Invalid Battery lights; pass a Clustered from @margoengine/clustered or its LightGroups');
    if (groups) {
      let name = 'gunfire';
      for (let n = 2; groups.names.includes(name); n++) name = `gunfire ${n}`;
      this.target = this.group = groups.group(name);
    } else if (clustered) this.target = clustered;
    // The battery goes in first, so a shot's burst and light belong to the frame that fires it.
    engineRuntime(engine).use(this);
    this.clouds = Clouds.attach(engine, { ...(options.clouds ?? {}), limit: banks * puffs });
    const placed = (i: number, random: () => number): { point: V3; volume: number } => {
      // Margo's layout: puffs in a ball (the bank), the larger ones nearer its centre.
      const u = random(),
        v = random(),
        w = Math.cbrt(random()),
        th = 2 * Math.PI * u,
        ph = Math.acos(2 * v - 1);
      return {
        point: [w * Math.sin(ph) * Math.cos(th), w * Math.sin(ph) * Math.sin(th) * 0.8, w * Math.cos(ph)],
        volume: 0.75 + 0.25 * (1 - w) + 0 * i,
      };
    };
    for (let b = 0; b < banks; b++)
      this.banks.push({
        cloud: this.clouds.add({
          seed: 1 + b * 7,
          segments: puffs,
          bounds: [1.6, 1.6, 1.6],
          volume: 1.2,
          distribute: placed,
          opacity: 0,
          speed: 0.15,
        }),
        shot: null,
        puff: null,
      });
    for (const [i, g] of options.guns.entries()) {
      const flash = muzzleFlash(g.charge ?? 4.5),
        fade = options.flashDuration ?? FLASH_DURATION;
      const fx: VFXOptions = {
        capacity: 64,
        rate: 0,
        position: [0, -1e6, 0],
        velocity: [0, 0, 0],
        spread: 0,
        gravity: [0, 0, 0],
        size: flash.radius,
        lifetime: [Math.max(0.05, 3 * fade), Math.max(0.08, 4 * fade)],
        ground: -1e9,
        turbulence: 0,
        intensity: 0,
        // A near-zero alpha with the radiance in the intensity: the billboards add their light and hardly cover what is
        // behind them, so a fireball fading out never darkens the scene (FLASH_ALPHA).
        color: [flash.color[0], flash.color[1], flash.color[2], FLASH_ALPHA],
        curves: { size: [0.5, 1, 1, 0.8], alpha: [1, 1, 0.6, 0] },
      };
      this.flashes.push(VFX.attach(engine, fx, { curves }));
      // Burning grains: glowing points at the powder's flame colour, thrown with the gas and slowed by their drag
      // (the overLife speed curve of powderGrains, set at each shot) until they burn out, drawn as the streaks the
      // camera's shutter records (stretched by the shutter time).
      this.sparks.push(
        VFX.attach(
          engine,
          {
            capacity: 2048,
            rate: 0,
            position: [0, -1e6, 0],
            velocity: [0, 0, 0],
            spread: 0,
            gravity: [0, -G, 0],
            size: options.sparkSize ?? 0.3,
            lifetime: [0.1, 0.2],
            ground: -1e9,
            turbulence: 0,
            intensity: 0,
            color: [flash.color[0], flash.color[1], flash.color[2], 1],
            curves: { alpha: [1, 1, 0.8, 0] },
            overLife: { speed: [1, 1] },
            stretch: { factor: 1 / 60 },
          },
          { curves, overLife, stretch },
        ),
      );
      if (this.target)
        this.lights.push({ position: [0, -1e6, 0], range: 1, intensity: 0, color: flash.color, radius: flash.radius });
      void i;
    }
    // Splinters: oak heartwood, falling under gravity and tumbling.
    this.splinters = VFX.attach(engine, {
      capacity: 2048,
      rate: 0,
      position: [0, -1e6, 0],
      velocity: [0, 0, 0],
      spread: 0,
      gravity: [0, -G, 0],
      size: 0.12,
      lifetime: [1.5, 3],
      ground: options.seaLevel ?? 0,
      turbulence: 0.2,
      angularVelocity: 8,
      intensity: 1,
      color: [0.42, 0.3, 0.18, 1],
    });
    this.target?.setLights(this.lights);
  }
  private checkGun(g: Gun): void {
    if (!g || typeof g !== 'object') throw new TypeError('Battery gun needs {position, direction}');
    finiteVector(g.position, 3, 'Battery gun position');
    finiteVector(g.direction, 3, 'Battery gun direction');
    if (!(Math.hypot(g.direction[0], g.direction[1], g.direction[2]) > 0))
      throw new RangeError('Battery gun direction must not be zero');
    check(g.charge ?? 4.5, 'charge', 0, 10000, true);
    check(g.muzzleVelocity ?? 490, 'muzzleVelocity', 0, 3000, true);
  }
  private checkShot(s: GunShot): void {
    if (!s || !Number.isInteger(s.gun) || s.gun < 0 || s.gun >= this.options.guns.length)
      throw new RangeError('Battery shot gun must be a gun index');
    check(s.time, 'shot time', 0, 1e7);
  }
  private checkLive(): void {
    const o = this.options;
    check(o.flashDuration ?? FLASH_DURATION, 'flashDuration', 0.001, 1);
    check(o.flashSize ?? 1, 'flashSize', 0, 10);
    check(o.flashRadiance ?? 40, 'flashRadiance', 0, 3000);
    check(o.flashLight ?? 1, 'flashLight', 0, 100);
    check(o.shutter ?? 0.5, 'shutter', 0, 1);
    check(o.extinction ?? 3, 'extinction', 0, 100);
    check(o.dispersion ?? 0.5, 'dispersion', 0, 5);
    check(o.smokeLife ?? 600, 'smokeLife', 1, 7200);
    check(o.stability ?? 1e-4, 'stability', 0, 1);
    check(o.heatFraction ?? 0.4, 'heatFraction', 0, 1);
    check(o.entrainment ?? 0.25, 'entrainment', 0.05, 1);
    check(o.sparks ?? 1, 'sparks', 0, 10);
    check(o.sparkRadiance ?? 30, 'sparkRadiance', 0, 3000);
    check(o.sparkSize ?? 0.3, 'sparkSize', 0.01, 2);
    check(o.grain ?? 0.003, 'grain', 5e-4, 0.02);
    check(o.splinters ?? 1, 'splinters', 0, 10);
    if (o.targets !== undefined && !Array.isArray(o.targets))
      throw new TypeError('Battery targets must be a list of {ship, length, beam}');
    if (o.smokeColor) {
      finiteVector(o.smokeColor, 3, 'Battery smokeColor');
      for (const c of o.smokeColor) check(c, 'smokeColor channel', 0, 1);
    }
  }
  /**
   * Back to time 0, as a fresh battery with the same options (GAP-FILM-RESET): the `shots` of the options queued again
   * (ones added with `fire` or `broadside` are dropped), no shot fired, every bank, flash, spark, splinter and light
   * idle, and the holes it drew into the targets' masks (their blue channel) cleared, so the same frames after it draw
   * what a fresh battery draws.
   */
  resetTime(): void {
    if (this.disposed) return;
    this.clock = this.cursor = this.hitCursor = 0;
    this.lastDelta = 1 / 30;
    this.drift[0] = this.drift[1] = 0;
    this.queue.length = 0;
    this.queue.push(...(this.options.shots ?? []));
    this.queue.sort((a, b) => a.time - b.time || a.gun - b.gun);
    this.fired.length = 0;
    this.pendingHits.length = 0;
    this.puffs.clear();
    this.point.along = this.point.rise = this.point.radius = this.point.speed = 0;
    for (const bank of this.banks) {
      bank.shot = bank.puff = null;
      bank.cloud.options.opacity = 0;
      bank.cloud.matrix.set(IDENTITY);
    }
    this.clouds.resetTime();
    for (const effect of [...this.flashes, ...this.sparks, this.splinters]) effect.resetTime();
    for (const light of this.lights) {
      (light.position as unknown as number[]).splice(0, 3, 0, -1e6, 0);
      light.intensity = 0;
    }
    this.target?.setLights(this.lights);
    const cleared = new Set<HullMask>();
    for (const t of this.options.targets ?? []) {
      if (!t.mask || cleared.has(t.mask)) continue;
      cleared.add(t.mask);
      const data = maskImage(t.mask).data;
      for (let i = 2; i < data.length; i += 4) data[i] = 0;
      t.mask.update();
    }
  }
  /** Queues gun `gun` to fire at film time `time` (default now). */
  fire(gun: number, time = this.clock): this {
    const s = { gun, time };
    this.checkShot(s);
    let i = this.queue.length;
    while (i > this.cursor && this.queue[i - 1]!.time > time) i--;
    this.queue.splice(Math.max(i, this.cursor), 0, s);
    return this;
  }
  /** A broadside: every gun (or the listed ones) fires from `time`, one every `interval` seconds in order. */
  broadside(time: number, interval = 0.25, guns?: readonly number[]): this {
    check(interval, 'broadside interval', 0, 60);
    (guns ?? this.options.guns.map((_, i) => i)).forEach((g, k) => this.fire(g, time + k * interval));
    return this;
  }
  /** The puff law of a gun for the battery's air now. */
  puffOf(gun: number): PowderPuff {
    const o = this.options,
      g = o.guns[gun]!,
      dir = this.worldDirection(g),
      elevation = Math.asin(Math.max(-1, Math.min(1, dir[1]))),
      key = [
        g.charge ?? 4.5,
        g.muzzleVelocity ?? 490,
        elevation.toFixed(4),
        o.stability ?? 1e-4,
        o.heatFraction ?? 0.4,
        o.entrainment ?? 0.25,
        o.smokeLife ?? 600,
      ].join('|');
    let puff = this.puffs.get(key);
    if (!puff) {
      puff = new PowderPuff({
        charge: g.charge ?? 4.5,
        muzzleVelocity: g.muzzleVelocity ?? 490,
        elevation,
        stability: o.stability ?? 1e-4,
        heatFraction: o.heatFraction ?? 0.4,
        entrainment: o.entrainment ?? 0.25,
        duration: o.smokeLife ?? 600,
      });
      if (this.puffs.size > 64) this.puffs.clear();
      this.puffs.set(key, puff);
    }
    return puff;
  }
  private worldDirection(g: Gun): V3 {
    const d = this.options.ship
        ? transformDir(this.options.ship.matrix(), g.direction)
        : [g.direction[0], g.direction[1], g.direction[2]],
      l = Math.hypot(d[0]!, d[1]!, d[2]!);
    return [d[0]! / l, d[1]! / l, d[2]! / l];
  }
  /** The wind the banks drift in now: the battery's own, else the one the weather wrote on its flashes. */
  wind(): [number, number] {
    const own = this.options.wind ?? this.flashes[0]?.options.wind,
      g = this.options.guns[0]!.position;
    return windAt(own, this.options.ship ? transformPoint(this.options.ship.matrix(), g) : g, this.clock);
  }
  /** Every shot's impact on the water so far, in time order (a `ShotSplash` takes them). */
  impacts(): ShotImpact[] {
    return this.fired.flatMap((s) => (s.impact ? [s.impact] : []));
  }
  /** Seconds on the battery's clock. */
  get time(): number {
    return this.clock;
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /**
   * Moves the clock by `delta` seconds and fires every shot due by then (CPU only: a seek replays it): the wind drift
   * adds up here, each due gun's bank is placed and its shot flown, and every flash, light and bank is set for the new
   * time.
   */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    const dt = delta > 0 ? delta : 0;
    if (dt > 0) this.lastDelta = dt;
    const w = this.wind();
    this.drift[0] += w[0] * dt;
    this.drift[1] += w[1] * dt;
    this.clock += dt;
    this.checkLive();
    const o = this.options;
    while (this.cursor < this.queue.length && this.queue[this.cursor]!.time <= this.clock) {
      const s = this.queue[this.cursor++]!,
        g = o.guns[s.gun]!,
        m = o.ship?.matrix(),
        muzzle = m ? transformPoint(m, g.position) : ([g.position[0], g.position[1], g.position[2]] as V3),
        direction = this.worldDirection(g),
        // The drift at the shot's own time (it fired up to a frame ago): the wind's motion over that part of the frame.
        back = this.clock - s.time,
        shot: FiredShot = {
          gun: s.gun,
          time: s.time,
          muzzle,
          direction,
          drift: [this.drift[0] - w[0] * back, this.drift[1] - w[1] * back],
          hits: [],
        };
      // The flight through the wind the banks drift in, at the ships' poses now.
      const air = o.wind ?? this.flashes[0]?.options.wind,
        path = shotPath(muzzle, direction, g.muzzleVelocity ?? 490, g.shot ?? {}, {
          fireTime: s.time,
          seaLevel: o.seaLevel ?? 0,
          ...(o.water ? { water: o.water } : {}),
          ...(air ? { wind: air } : {}),
          ...(o.targets?.length ? { targets: o.targets } : {}),
        });
      if (path.impact) shot.impact = path.impact;
      shot.hits = path.hits;
      for (const h of path.hits) {
        let k = this.pendingHits.length;
        while (k > this.hitCursor && this.pendingHits[k - 1]!.time > h.time) k--;
        this.pendingHits.splice(k, 0, h);
      }
      this.fired.push(shot);
      // A bank for it: a free one, else the oldest.
      let bank = this.banks.find((b) => !b.shot);
      if (!bank) bank = this.banks.reduce((a, b) => (a.shot!.time <= b.shot!.time ? a : b));
      bank.shot = shot;
      bank.puff = this.puffOf(s.gun);
      const flash = this.flashes[s.gun]!,
        fo = flash.options,
        f = muzzleFlash(g.charge ?? 4.5, o.flashDuration ?? FLASH_DURATION),
        size = f.radius * (o.flashSize ?? 1);
      fo.position = [
        muzzle[0] + direction[0] * size * 0.8,
        muzzle[1] + direction[1] * size * 0.8,
        muzzle[2] + direction[2] * size * 0.8,
      ];
      // Billboards 1.6 radii across over the ball, thrown on along the barrel: together they fill the fireball.
      fo.emissionExtent = [size * 0.45, size * 0.45, size * 0.45];
      fo.velocity = [direction[0] * size * 4, direction[1] * size * 4, direction[2] * size * 4];
      fo.spread = size * 1.5;
      fo.size = size * 1.6;
      flash.burst(24);
      // The grains leave with the gas at the shot's speed in a narrow cone (Margo's: a tenth of the speed sideways).
      const v0 = g.muzzleVelocity ?? 490,
        grains = powderGrains(g.charge ?? 4.5, o.grain ?? 0.003, v0),
        sp = this.sparks[s.gun]!,
        so = sp.options;
      so.position = [
        muzzle[0] + direction[0] * size * 0.5,
        muzzle[1] + direction[1] * size * 0.5,
        muzzle[2] + direction[2] * size * 0.5,
      ];
      so.velocity = [direction[0] * v0, direction[1] * v0, direction[2] * v0];
      so.spread = 0.1 * v0;
      so.emissionExtent = [size * 0.3, size * 0.3, size * 0.3];
      so.lifetime = [0.7 * grains.burnTime, 1.3 * grains.burnTime];
      so.overLife = { speed: grains.speeds };
      const n = Math.round(Math.min(2048, grains.count * (o.sparks ?? 1)));
      if (n > 0) sp.burst(n);
    }
    // Strikes on ships fall due on the clock: splinters and a hole in the target's mask.
    while (this.hitCursor < this.pendingHits.length && this.pendingHits[this.hitCursor]!.time <= this.clock)
      this.strike(this.pendingHits[this.hitCursor++]!);
    this.place();
  }
  /** Every strike on the `targets` so far, in time order (the ones whose time has come). */
  hits(): HullHit[] {
    return this.pendingHits.slice(0, this.hitCursor);
  }
  private strike(h: HullHit): void {
    const o = this.options,
      n = h.normal,
      speed = Math.hypot(h.velocity[0], h.velocity[1], h.velocity[2]),
      // Each strike's splinters are born at its own place and speed, not at those of the strike that came last in the frame.
      spawn: { position: V3; emissionExtent: V3; velocity: V3; spread: number } = {
        position: [...h.position],
        emissionExtent: [h.hole + 0.05, h.hole + 0.05, h.hole + 0.05],
        velocity: [0, 0, 0],
        spread: 0,
      };
    if (h.kind === 'through' || h.kind === 'exit') {
      // The wood ahead of the ball is driven out of the far face of the timber with it (Margo's: at up to half its speed).
      const k = Math.min(150, 0.5 * speed) / (speed || 1);
      spawn.velocity = [h.velocity[0] * k, h.velocity[1] * k, h.velocity[2] * k];
      spawn.spread = 0.6 * Math.min(150, 0.5 * speed);
    } else {
      // A glance or a lodged ball spalls the face it struck outward.
      spawn.velocity = [n[0] * 15, n[1] * 15 + 3, n[2] * 15];
      spawn.spread = 10;
    }
    const count = Math.round(Math.min(2048, h.splinters * (o.splinters ?? 1)));
    if (count > 0) this.splinters.burst(count, spawn);
    const target = o.targets?.[h.target];
    if (target?.mask && h.hole > 0) stampHole(target.mask, h.local, h.hole, target);
  }
  /** Sets every flash, light and bank for the clock now. */
  private place(): void {
    const o = this.options,
      t = this.clock,
      shutter = (o.shutter ?? 0.5) * this.lastDelta,
      duration = o.flashDuration ?? FLASH_DURATION,
      radiance = o.flashRadiance ?? 40;
    // Flashes and lights: the newest shot of each gun.
    const latest = new Map<number, FiredShot>();
    for (let i = this.fired.length - 1; i >= 0 && latest.size < o.guns.length; i--) {
      const s = this.fired[i]!;
      if (!latest.has(s.gun)) latest.set(s.gun, s);
      if (t - s.time > 1) break;
    }
    for (let gun = 0; gun < o.guns.length; gun++) {
      const s = latest.get(gun),
        exposure = s ? flashExposure(t - s.time, shutter, duration) : 0,
        g = o.guns[gun]!,
        f = muzzleFlash(g.charge ?? 4.5, duration),
        size = f.radius * (o.flashSize ?? 1);
      this.flashes[gun]!.options.intensity = Math.min(65504, (radiance * exposure) / FLASH_ALPHA);
      const so = this.sparks[gun]!.options;
      so.intensity = o.sparkRadiance ?? 30;
      so.size = o.sparkSize ?? 0.3;
      so.stretch = { factor: Math.min(10, shutter) };
      const light = this.lights[gun];
      if (light && s) {
        const p = light.position as unknown as number[];
        p[0] = s.muzzle[0] + s.direction[0] * size;
        p[1] = s.muzzle[1] + s.direction[1] * size;
        p[2] = s.muzzle[2] + s.direction[2] * size;
        light.radius = size;
        light.range = 60 * Math.max(size, 0.5);
        // A sphere light as bright as the flash it stands in (radiance = intensity / (pi r^2)), the rule of Fire.
        light.intensity = exposure > 1e-4 ? Math.PI * size * size * radiance * exposure * (o.flashLight ?? 1) : 0;
      }
    }
    if (this.target) this.target.setLights(this.lights);
    // Banks.
    const extinction = (o.extinction ?? 3) * 1000, // m^2/kg
      life = o.smokeLife ?? 600,
      wind = Math.hypot(...this.wind()),
      color = o.smokeColor ?? smokeColor(0),
      p = this.point;
    let densitySum = 0,
      live = 0;
    for (const bank of this.banks) {
      const s = bank.shot,
        c = bank.cloud;
      if (!s || !bank.puff) {
        c.options.opacity = 0;
        continue;
      }
      const age = t - s.time;
      if (age < 0) {
        c.options.opacity = 0;
        continue;
      }
      if (age > life) {
        bank.shot = null;
        c.options.opacity = 0;
        continue;
      }
      bank.puff.at(age, p);
      // The air spreads the bank once its own motion is slower than the turbulence that spreads it.
      const sigma = smokeDispersion(age, wind, Math.max(2, s.muzzle[1] + p.rise), o.dispersion ?? 0.5),
        R = Math.sqrt(p.radius * p.radius + 2 * sigma * sigma),
        g = o.guns[s.gun]!,
        mass = powderProducts(g.charge ?? 4.5).smoke,
        tau = (extinction * mass) / (Math.PI * R * R);
      const h = Math.hypot(s.direction[0], s.direction[2]) || 1,
        bx = s.direction[0] / h,
        bz = s.direction[2] / h,
        cx = s.muzzle[0] + bx * p.along + (this.drift[0] - s.drift[0]),
        cy = s.muzzle[1] + p.rise,
        cz = s.muzzle[2] + bz * p.along + (this.drift[1] - s.drift[1]);
      // Early on the bank is drawn out along the barrel (its path is longer than it is wide); it rounds as it slows.
      const stretch = 1 + Math.min(1.5, p.along / Math.max(1e-3, 4 * R)),
        m = c.matrix;
      m.set([bx * R * stretch, 0, bz * R * stretch, 0, 0, R, 0, 0, -bz * R, 0, bx * R, 0, cx, cy, cz, 1]);
      // N puffs of diameter 1.2 R in a 1.6 R box: a line of sight through the bank meets about k of them.
      const k = Math.max(1, (c.options.segments! * Math.PI * 0.36) / (1.6 * 1.6)),
        perPuff = tau / k;
      c.options.opacity = Math.min(1, 1 - Math.exp(-perPuff));
      c.options.color = [color[0], color[1], color[2]];
      if (tau < 0.01) {
        bank.shot = null;
        c.options.opacity = 0;
        continue;
      }
      densitySum += Math.min(8, perPuff);
      live++;
    }
    this.clouds.options.density = live > 0 ? densitySum / live : 1;
    const co = o.clouds ?? {};
    for (const key of Object.keys(co) as (keyof typeof co)[])
      (this.clouds.options as Record<string, unknown>)[key] = co[key];
  }
  /** A battery of guns; see {@link BatteryOptions}. */
  static attach(engine: EngineKernel, options: BatteryOptions): Battery {
    if (!options || typeof options !== 'object')
      throw new TypeError('Invalid Battery options; pass {guns: [{position, direction}]}');
    return new Battery(engine, options);
  }
  /** Removes the flashes, banks and lights. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    for (const f of this.flashes) f.dispose();
    for (const f of this.sparks) f.dispose();
    this.splinters.dispose();
    this.clouds.dispose();
    // A group goes with the battery (its dispose never throws); a Clustered it owned is emptied.
    if (this.group) this.group.dispose();
    else if (this.target) this.target.setLights([]);
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}

// ---- Burning hulls ----

/** Wood burnt through a ventilation-limited opening, kg/s: 0.09 A sqrt(H) (Kawagoe 1958; Drysdale 2011 ch. 10). */
export function ventBurningRate(area: number, height: number): number {
  check(area, 'vent area', 0, 1e4);
  check(height, 'vent height', 0, 100);
  return 0.09 * area * Math.sqrt(height);
}
/** The flame's height above an opening's top, metres: 12.8 (R / w)^(2/3) - H (Law 1978), 0 when that is negative. */
export function ventFlameHeight(rate: number, width: number, height: number): number {
  check(rate, 'burning rate', 0, 1e5);
  check(width, 'vent width', 0, 100, true);
  check(height, 'vent height', 0, 100);
  return Math.max(0, 12.8 * Math.cbrt((rate / width) ** 2) - height);
}
/** Heat of combustion of the wood and tar of a hull, J/kg (dry wood about 16 MJ/kg effective; Drysdale 2011 table 1.13). */
export const HULL_FUEL_HEAT = 16e6;

/** A gun port or other opening into a burning hull, in the hull's frame (+X port, +Y up, +Z forward). */
export interface HullPort {
  /** Centre of the opening on the hull side, hull-local metres. */
  position: Vec3;
  /** Width and height of the opening, metres. Default 0.8 by 0.7 (a lower-deck gun port). */
  size?: readonly [number, number];
  /** Outward normal, hull-local (default from `position`'s side: +X or -X). */
  normal?: Vec3;
}
/** `HullFire.attach` settings. Numbers are read every frame unless marked. */
export interface HullFireOptions {
  /** The burning ship (a `Floater` of `@margoengine/water/ships`) or a fixed world matrix (16 numbers). */
  ship: Carrier | ArrayLike<number>;
  /** The hull: length, beam, the deck's height above the hull origin and the keel's depth below it, metres. Default 50 by 13, deck 6, draft 5. */
  hull?: { length?: number; beam?: number; deck?: number; draft?: number };
  /** Char rate of the hull's timber while fire is over it, mm/min, 0..5. Default 0.5 (hardwood, EN 1995-1-2 table 3.1). */
  charRate?: number;
  /** A hull mask (see {@link hullMaskImage}) the char (red) and the live glow (green) are painted into each frame. Default none. */
  mask?: HullMask;
  /** Masts that fall when the fire has burnt their stays. Read at attach (their count). Default none. */
  masts?: readonly HullMast[];
  /** Seconds after the fire reaches a mast that it falls (its stays and shrouds of tarred hemp gone; Margo's). Default 600. */
  mastFall?: number;
  /** Where the fire starts, hull-local metres, and when (film seconds). Default the waist, at time 0. */
  ignition?: { at?: Vec3; time?: number };
  /** Spread of the fire along the hull, m/s. Default 0.03 (a ship of the line fully alight within half an hour). */
  spread?: number;
  /** Seconds a stretch of hull burns at full before it dies down to embers. Default 2,400. */
  burnTime?: number;
  /** Heat release of the burning deck, W/m^2. Default 250,000 (planks, tar and rigging; Babrauskas' 100 to 300 kW/m^2 for structural wood). */
  deckHeat?: number;
  /** The openings that flame (gun ports). Default none. */
  ports?: readonly HullPort[];
  /** Soot share of the smoke's particulate, 0..1: wood and tar. Default 0.35. */
  soot?: number;
  /** The wind, `[x, z]` m/s or a field. Default none: a `WeatherDrive` writes it (through the smoke). */
  wind?: VFXWind;
  /** Flame volumes over the deck and the ports. Read at attach. Default 10. */
  flames?: number;
  /** Smoke columns along the hull. Read at attach. Default 2. */
  columns?: number;
  /** Lights the flames light the scene with. Read at attach. Default none. */
  lights?: Clustered | LightGroups;
  /** Smoke puff opacity, 0..1. Default 0.7. */
  opacity?: number;
}
/** A flame the hull shows now, from {@link HullFire.flames}. */
export interface HullFlame {
  kind: 'deck' | 'port';
  /** World position of the flame's base. */
  position: V3;
  /** Flame length, metres. */
  length: number;
  /** Footprint [along, across], metres. */
  footprint: [number, number];
  /** Heat release, watts. */
  heat: number;
}

/** Sections of hull the fire's progress is tracked in (Margo's resolution). */
const HULL_SECTIONS = 24;
/** How far below the deck edge the deck's flames char the side, metres (they lap over the rail; Margo's). */
const DECK_LAP = 1.5;
/** Char depth that reads fully black, mm (Margo's: the 300 C char line blackens the face within a millimetre). */
const CHAR_BLACK = 0.5;

/**
 * A hull mask: an RGBA8 image over the hull's sides (red the char, green the glow of the fire on it now, blue the shot
 * holes) and the texture drawn from it, re-uploaded when it changes. A materials `Texture` made from
 * {@link hullMaskImage} fits: `new Texture(hullMaskImage(), {colorSpace: 'linear'})`. Its layout is
 * {@link hullMaskUVs}': the left half of the image the starboard side (-X), the right half the port side (+X), stern
 * to bow across each half, keel (row 0) to deck (the top row).
 */
export interface HullMask {
  readonly source: { data: Uint8Array | Uint8ClampedArray; width: number; height: number } | object;
  update(): void;
}
const maskImage = (mask: HullMask): { data: Uint8Array | Uint8ClampedArray; width: number; height: number } => {
  const s = mask?.source as { data?: unknown; width?: number; height?: number } | undefined;
  if (
    !s ||
    !(s.data instanceof Uint8Array || s.data instanceof Uint8ClampedArray) ||
    !Number.isInteger(s.width) ||
    !Number.isInteger(s.height) ||
    s.data.length !== s.width! * s.height! * 4 ||
    typeof mask.update !== 'function'
  )
    throw new TypeError(
      'Gunfire hull mask needs a Texture of raw RGBA8 data: new Texture(hullMaskImage(), {colorSpace: "linear"})',
    );
  return s as { data: Uint8Array; width: number; height: number };
};
/** A blank hull mask image, `width` by `height` texels (RGBA8, alpha 255), for a `Texture`. Default 256 by 64. */
export function hullMaskImage(width = 256, height = 64): { data: Uint8Array; width: number; height: number } {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 4 ||
    height < 2 ||
    width > 4096 ||
    height > 4096 ||
    width % 2
  )
    throw new RangeError('hullMaskImage needs an even whole width 4..4096 and a whole height 2..4096');
  const data = new Uint8Array(width * height * 4);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { data, width, height };
}
/**
 * The UV set a hull mesh reads its {@link HullMask} with, from its hull-local vertex positions (x, y, z per vertex;
 * +X port, +Y up, +Z forward) and the hull's size (as `HullFire`'s `hull`): u = 0.5 (z / L + 0.5) on the starboard side
 * and 0.5 more on the port side, v = (y + draft) / (deck + draft). Give it to the mesh as its second UV set and the
 * mask to a `layered()` layer with `texCoord: 1`.
 */
export function hullMaskUVs(
  positions: ArrayLike<number>,
  hull: { length?: number; deck?: number; draft?: number } = {},
): Float32Array {
  if (!positions || positions.length % 3) throw new TypeError('hullMaskUVs needs x, y, z for each vertex');
  const L = check(hull.length ?? 50, 'hull length', 1, 500),
    deck = check(hull.deck ?? 6, 'hull deck', 0, 50),
    draft = check(hull.draft ?? 5, 'hull draft', 0, 50),
    out = new Float32Array((positions.length / 3) * 2);
  for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
    const x = positions[i]!,
      y = positions[i + 1]!,
      z = positions[i + 2]!,
      along = Math.min(1, Math.max(0, z / L + 0.5));
    out[j] = 0.5 * along * 0.999 + (x >= 0 ? 0.5 : 0);
    out[j + 1] = Math.min(1, Math.max(0, (y + draft) / (deck + draft || 1)));
  }
  return out;
}
const maskTexel = (
  img: { width: number; height: number },
  local: Vec3,
  L: number,
  deck: number,
  draft: number,
): [number, number] => {
  const half = img.width / 2,
    along = Math.min(1, Math.max(0, local[2] / L + 0.5));
  return [along * half + (local[0] >= 0 ? half : 0), ((local[1] + draft) / (deck + draft || 1)) * img.height];
};
/** Draws a shot hole (blue 255) of `hole` metres radius at hull-local `local` into a target's mask. */
function stampHole(mask: HullMask, local: Vec3, hole: number, target: ShotTarget): void {
  const img = maskImage(mask),
    L = target.length ?? 50,
    deck = target.height ?? 6,
    draft = target.draft ?? 5,
    [cx, cy] = maskTexel(img, local, L, deck, draft),
    perU = img.width / 2 / L,
    perV = img.height / (deck + draft || 1),
    side = local[0] >= 0 ? img.width / 2 : 0;
  for (let y = Math.floor(cy - hole * perV - 1); y <= Math.ceil(cy + hole * perV + 1); y++)
    for (let x = Math.floor(cx - hole * perU - 1); x <= Math.ceil(cx + hole * perU + 1); x++) {
      if (y < 0 || y >= img.height || x < side || x >= side + img.width / 2) continue;
      if (((x + 0.5 - cx) / perU) ** 2 + ((y + 0.5 - cy) / perV) ** 2 > hole * hole) continue;
      img.data[(y * img.width + x) * 4 + 2] = 255;
    }
  // A hole smaller than a texel still marks the texel it is in.
  const tx = Math.min(side + img.width / 2 - 1, Math.max(side, Math.floor(cx))),
    ty = Math.min(img.height - 1, Math.max(0, Math.floor(cy)));
  img.data[(ty * img.width + tx) * 4 + 2] = 255;
  mask.update();
}

/** A mast on a burning hull, hull-local. */
export interface HullMast {
  /** Its foot on the deck, hull-local metres. */
  position: Vec3;
  /** Its height above the foot, metres, 1..120. */
  height: number;
  /** Its yards: height up the mast and length, metres. Default none. */
  yards?: readonly { at: number; length: number }[];
  /** Which way it falls, hull-local and horizontal. Default [1, 0, 0] (to port). */
  falls?: Vec3;
  /** Film time it starts to fall. Default the fire's reach to it plus `mastFall`. */
  fallAt?: number;
}
/** A piece of falling rigging, from {@link HullFire.rigging}: a mast (its +Y from the foot) or a yard (its +X along it, centred). */
export interface RiggingPiece {
  kind: 'mast' | 'yard';
  /** Index into `masts`. */
  mast: number;
  /** World transform of the piece (column-major), for the scene's mast or yard mesh. */
  matrix: Float32Array;
  /** Length, metres. */
  length: number;
  /** Radians the mast has turned from upright. */
  angle: number;
}
/** The lean at which a mast whose stays have burnt starts to go, radians (Margo's). */
const MAST_LEAN = 0.02;
/** A toppling mast, from {@link mastTopple}. */
export interface MastTopple {
  /** Radians from upright. */
  angle: number;
  /** Radians a second. */
  rate: number;
  /** True once its top is in the water (it then lies there). */
  down: boolean;
}
/**
 * A uniform mast `height` metres tall toppling on its foot `deck` metres above the water (Varieschi and Kamiya 2003):
 * theta'' = (3 g / 2 L) sin theta from a lean of 0.02 rad, `seconds` after it starts to go (RK4, 1 ms steps), until its
 * top meets the water at cos theta = -deck / L.
 */
export function mastTopple(height: number, seconds: number, deck = 6): MastTopple {
  const L = check(height, 'mast height', 1, 120),
    T = check(seconds, 'seconds', 0, 1e7),
    D = check(deck, 'deck', 0, 50),
    end = Math.acos(Math.max(-1, Math.min(1, -D / L))),
    k = (3 * G) / (2 * L),
    h = 1e-3;
  let th = MAST_LEAN,
    w = 0,
    t = 0;
  while (t < T) {
    const dt = Math.min(h, T - t),
      a1 = k * Math.sin(th),
      a2 = k * Math.sin(th + 0.5 * dt * w),
      a3 = k * Math.sin(th + 0.5 * dt * (w + 0.5 * dt * a1)),
      a4 = k * Math.sin(th + dt * (w + 0.5 * dt * a2));
    th += dt * w + ((dt * dt) / 6) * (a1 + a2 + a3);
    w += (dt / 6) * (a1 + 2 * a2 + 2 * a3 + a4);
    t += dt;
    if (th >= end) return { angle: end, rate: 0, down: true };
  }
  return { angle: th, rate: w, down: false };
}

/**
 * A burning wooden hull: the fire spreads from its ignition along the deck at `spread` m/s; each stretch burns for
 * `burnTime` and dies down. The open deck releases `deckHeat` per square metre, drawn as `Flame` volumes as tall as
 * Heskestad's flame of that heat; each gun port in a burning stretch is the opening of a ventilation-limited
 * compartment (Kawagoe's 0.09 A sqrt(H) kg/s of wood) and throws a flame Law's 12.8 (R / w)^(2/3) - H above its top; the
 * whole fire feeds `Smoke` columns (0.7 of its heat convected) dark with soot. Every piece rides the ship's
 * `matrix()` each frame, so the fire moves and rolls with a `Floater`. A plugin of its scene.
 */
export class HullFire implements EnginePlugin {
  readonly name = 'vfx-hull-fire:' + nextId++;
  /** Read every frame (see {@link HullFireOptions}). */
  readonly options: HullFireOptions;
  /** The flame volumes (a fixed pool). */
  readonly flameVolumes: Flame[] = [];
  /** The smoke columns. */
  readonly smokeColumns: Smoke[] = [];
  private engine?: Engine;
  private disposed = false;
  private clock = 0;
  private constructor(engine: EngineKernel, options: HullFireOptions) {
    this.options = options;
    this.checkLive();
    const nf = check(options.flames ?? 10, 'flames', 0, 64),
      nc = check(options.columns ?? 2, 'columns', 0, 16);
    if (!Number.isInteger(nf) || !Number.isInteger(nc))
      throw new RangeError('HullFire flames and columns must be whole numbers');
    engineRuntime(engine).use(this);
    const at = this.toWorld([0, -1e6, 0]),
      lights = options.lights,
      smokeLights = (lights && 'clustered' in lights ? lights.clustered : lights) as unknown as
        | import('@margoengine/vfx/base').VFXLightSource
        | undefined;
    for (let i = 0; i < nc; i++)
      this.smokeColumns.push(
        Smoke.attach(engine, {
          position: at,
          heat: 0,
          radius: 3,
          color: smokeColor(options.soot ?? 0.35),
          opacity: options.opacity ?? 0.7,
          rate: 18,
          lifetime: 240,
          stability: 1e-4,
          ...(options.wind ? { wind: options.wind } : {}),
          ...(smokeLights ? { lights: smokeLights } : {}),
        }),
      );
    for (let i = 0; i < nf; i++)
      this.flameVolumes.push(
        Flame.attach(engine, {
          position: at,
          length: 0,
          footprint: [1, 1],
          ...(options.lights ? { lights: options.lights } : {}),
        }),
      );
    this.place();
  }
  private checkLive(): void {
    const o = this.options;
    if (!o || typeof o !== 'object' || !o.ship)
      throw new TypeError('HullFire needs {ship}: a Floater or a world matrix');
    if (typeof (o.ship as Carrier).matrix !== 'function' && (o.ship as ArrayLike<number>).length !== 16)
      throw new TypeError('HullFire ship must have matrix() (a Floater) or be 16 numbers');
    const h = o.hull ?? {};
    check(h.length ?? 50, 'hull length', 1, 500);
    check(h.beam ?? 13, 'hull beam', 0.5, 100);
    check(h.deck ?? 6, 'hull deck', 0, 50);
    check(o.spread ?? 0.03, 'spread', 0, 10);
    check(o.burnTime ?? 2400, 'burnTime', 1, 1e6);
    check(o.deckHeat ?? 250000, 'deckHeat', 0, 5e6);
    check(o.soot ?? 0.35, 'soot', 0, 1);
    check(o.opacity ?? 0.7, 'opacity', 0, 1);
    check(o.ignition?.time ?? 0, 'ignition time', 0, 1e7);
    check(h.draft ?? 5, 'hull draft', 0, 50);
    check(o.charRate ?? 0.5, 'charRate', 0, 5);
    check(o.mastFall ?? 600, 'mastFall', 0, 1e6);
    if (o.mask) maskImage(o.mask);
    for (const m of o.masts ?? []) {
      finiteVector(m.position, 3, 'HullFire mast position');
      check(m.height, 'mast height', 1, 120);
      if (m.falls) finiteVector(m.falls, 3, 'HullFire mast falls');
      if (m.fallAt !== undefined) check(m.fallAt, 'mast fallAt', 0, 1e7);
      for (const y of m.yards ?? []) {
        check(y.at, 'yard at', 0, m.height);
        check(y.length, 'yard length', 0.1, 100);
      }
    }
    if (o.ignition?.at) finiteVector(o.ignition.at, 3, 'HullFire ignition');
    for (const p of o.ports ?? []) {
      finiteVector(p.position, 3, 'HullFire port position');
      if (p.size) for (const s of p.size) check(s, 'port size', 0.05, 20);
    }
  }
  private matrix(): ArrayLike<number> {
    const s = this.options.ship;
    return typeof (s as Carrier).matrix === 'function' ? (s as Carrier).matrix() : (s as ArrayLike<number>);
  }
  private toWorld(p: Vec3): V3 {
    return transformPoint(this.matrix(), p);
  }
  /** How much of hull section `i` (0 at the stern) burns now, 0..1 (0 before the fire reaches it and after it dies). */
  private burning(z: number): number {
    const o = this.options,
      start = o.ignition?.time ?? 0,
      from = o.ignition?.at?.[2] ?? 0,
      spread = o.spread ?? 0.03,
      reach = spread > 0 ? Math.abs(z - from) / spread : Math.abs(z - from) < 1e-9 ? 0 : Infinity,
      age = this.clock - start - reach;
    if (age <= 0) return 0;
    const burn = o.burnTime ?? 2400,
      // Margo's growth: a stretch takes a twentieth of its burn time to come to full, then dies down over the last third.
      grow = Math.min(1, age / (0.05 * burn)),
      fade = age > burn ? Math.max(0, 1 - (age - burn) / (0.33 * burn)) : 1;
    return grow * fade;
  }
  /** Seconds the fire reaches hull-local z after its ignition (Infinity where it never does). */
  private reach(z: number): number {
    const o = this.options,
      from = o.ignition?.at?.[2] ?? 0,
      spread = o.spread ?? 0.03;
    return spread > 0 ? Math.abs(z - from) / spread : Math.abs(z - from) < 1e-9 ? 0 : Infinity;
  }
  /**
   * Seconds of full burning hull-local z has had by now: the time integral of the growth, full burn and dying down of
   * {@link burning}, in closed form (so a seek lands it).
   */
  exposure(z: number): number {
    const o = this.options,
      a = this.clock - (o.ignition?.time ?? 0) - this.reach(z);
    if (!(a > 0)) return 0;
    const B = o.burnTime ?? 2400,
      g = 0.05 * B,
      f = 0.33 * B;
    if (a <= g) return (a * a) / (2 * g);
    if (a <= B) return g / 2 + (a - g);
    const late = Math.min(a - B, f);
    return g / 2 + (B - g) + late - (late * late) / (2 * f);
  }
  /**
   * How deep the hull's side or deck is charred at hull-local `point`, mm: the char rate (EN 1995-1-2) times the
   * exposure of the flames over it. The deck burns where its section does and chars the side to 1.5 m below the deck
   * edge; a flaming port chars the side over its opening up to Law's flame height, widening as the plume does
   * (MTT 1956's 0.12 per metre).
   */
  charDepth(point: Vec3): number {
    finiteVector(point, 3, 'HullFire char point');
    const o = this.options,
      rate = (o.charRate ?? 0.5) / 60,
      deck = o.hull?.deck ?? 6;
    let seconds = point[1] >= deck - DECK_LAP ? this.exposure(point[2]) : 0;
    for (const port of o.ports ?? []) {
      if (Math.sign(port.position[0] || 1) !== Math.sign(point[0] || 1)) continue;
      const [w, ph] = port.size ?? [0.8, 0.7],
        bottom = port.position[1] - ph / 2,
        top = port.position[1] + ph / 2 + ventFlameHeight(ventBurningRate(w * ph, ph), w, ph),
        rise = Math.max(0, point[1] - bottom);
      if (point[1] < bottom || point[1] > top || Math.abs(point[2] - port.position[2]) > w / 2 + 0.12 * rise) continue;
      seconds = Math.max(seconds, this.exposure(port.position[2]));
    }
    return rate * seconds;
  }
  /** Paints the char and the glow into the mask: every texel's char from {@link charDepth}, and how hard the fire over it burns now. */
  private paint(): void {
    const mask = this.options.mask;
    if (!mask) return;
    const img = maskImage(mask),
      h = this.options.hull ?? {},
      L = h.length ?? 50,
      deck = h.deck ?? 6,
      draft = h.draft ?? 5,
      half = img.width / 2,
      p: V3 = [0, 0, 0],
      data = img.data;
    let changed = false;
    for (let x = 0; x < img.width; x++) {
      const side = x < half ? -1 : 1;
      p[0] = side * 0.5 * (h.beam ?? 13);
      p[2] = (((x % half) + 0.5) / half - 0.5) * L;
      const now = this.burning(p[2]);
      for (let y = 0; y < img.height; y++) {
        p[1] = ((y + 0.5) / img.height) * (deck + draft) - draft;
        const d = this.charDepth(p),
          char = Math.round(255 * (1 - Math.exp(-d / CHAR_BLACK))),
          glow = d > 0 ? Math.round(255 * now) : 0,
          i = (y * img.width + x) * 4;
        if (data[i] !== char || data[i + 1] !== glow) {
          data[i] = char;
          data[i + 1] = glow;
          changed = true;
        }
      }
    }
    if (changed) mask.update();
  }
  /** When mast `i` starts to fall, film seconds (Infinity if the fire never reaches it). */
  mastFallTime(i: number): number {
    const o = this.options,
      m = o.masts?.[i];
    if (!m) throw new RangeError('HullFire mast index is out of range; pass an index into masts');
    return m.fallAt ?? (o.ignition?.time ?? 0) + this.reach(m.position[2]) + (o.mastFall ?? 600);
  }
  /**
   * The masts and their yards now, as pieces with world transforms: upright until they fall, then toppling on their feet
   * by {@link mastTopple} the way `falls` points until their tops are in the water, where they lie. A function of the
   * clock and the ship's pose, so a seek lands it.
   */
  rigging(): RiggingPiece[] {
    const o = this.options,
      ship = this.matrix(),
      out: RiggingPiece[] = [];
    (o.masts ?? []).forEach((m, i) => {
      const start = this.mastFallTime(i),
        angle =
          this.clock > start
            ? mastTopple(m.height, this.clock - start, Math.min(50, Math.max(0, m.position[1]))).angle
            : 0,
        f = m.falls ?? [1, 0, 0],
        fl = Math.hypot(f[0], f[2]) || 1,
        dx = f[0] / fl,
        dz = f[2] / fl,
        c = Math.cos(angle),
        s = Math.sin(angle);
      // The mast's up turns toward the fall direction: up' = c up + s fall; across stays horizontal (fall x up).
      const up: V3 = [s * dx, c, s * dz],
        fall: V3 = [c * dx, -s, c * dz],
        across: V3 = [-dz, 0, dx];
      const place = (axisX: V3, axisY: V3, axisZ: V3, origin: V3): Float32Array => {
        const local = [
            axisX[0],
            axisX[1],
            axisX[2],
            0,
            axisY[0],
            axisY[1],
            axisY[2],
            0,
            axisZ[0],
            axisZ[1],
            axisZ[2],
            0,
            origin[0],
            origin[1],
            origin[2],
            1,
          ],
          w = new Float32Array(16);
        for (let col = 0; col < 4; col++)
          for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) sum += ship[k * 4 + row]! * local[col * 4 + k]!;
            w[col * 4 + row] = sum;
          }
        return w;
      };
      const foot: V3 = [m.position[0], m.position[1], m.position[2]];
      out.push({ kind: 'mast', mast: i, matrix: place(fall, up, across, foot), length: m.height, angle });
      for (const y of m.yards ?? []) {
        const centre: V3 = [foot[0] + up[0] * y.at, foot[1] + up[1] * y.at, foot[2] + up[2] * y.at];
        // A yard crosses the mast athwart its fall: its +X along `across`.
        out.push({
          kind: 'yard',
          mast: i,
          matrix: place(across, up, [-fall[0], -fall[1], -fall[2]], centre),
          length: y.length,
          angle,
        });
      }
    });
    return out;
  }
  /** Heat release now, watts: the deck plus every flaming port. */
  get heat(): number {
    return this.flames().reduce((s, f) => s + f.heat, 0);
  }
  /** The flames the hull shows now: one a burning deck section (merged into the pool's count) and one per flaming port. */
  flames(): HullFlame[] {
    const o = this.options,
      h = o.hull ?? {},
      L = h.length ?? 50,
      B = h.beam ?? 13,
      deck = h.deck ?? 6,
      q = o.deckHeat ?? 250000,
      out: HullFlame[] = [],
      ds = L / HULL_SECTIONS;
    for (let i = 0; i < HULL_SECTIONS; i++) {
      const z = -L / 2 + (i + 0.5) * ds,
        b = this.burning(z);
      if (b <= 0) continue;
      const heat = q * ds * B * 0.8 * b,
        D = Math.sqrt((4 * ds * B * 0.8) / Math.PI),
        length = Math.max(0, 0.235 * Math.pow(heat / 1000, 0.4) - 1.02 * D);
      out.push({ kind: 'deck', position: this.toWorld([0, deck, z]), length, footprint: [ds, B * 0.8], heat });
    }
    for (const port of o.ports ?? []) {
      const b = this.burning(port.position[2]);
      if (b <= 0) continue;
      const [w, ph] = port.size ?? [0.8, 0.7],
        rate = ventBurningRate(w * ph, ph) * b,
        length = ventFlameHeight(rate, w, ph),
        side = port.normal ?? [Math.sign(port.position[0]) || 1, 0, 0];
      // The flame leaves the opening's top a little out from the hull side and climbs the side.
      const base: Vec3 = [
        port.position[0] + side[0] * 0.4,
        port.position[1] + ph / 2,
        port.position[2] + side[2] * 0.4,
      ];
      out.push({
        kind: 'port',
        position: this.toWorld(base),
        length: length + ph,
        footprint: [w, 0.6 * w],
        heat: rate * HULL_FUEL_HEAT,
      });
    }
    return out;
  }
  /** Seconds on the fire's clock. */
  get time(): number {
    return this.clock;
  }
  setup(engine: Engine): void {
    this.engine = engine;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /**
   * Back to time 0, as a fresh fire with the same options (GAP-FILM-RESET): its flames and smoke columns go back to their
   * own start and are placed for time 0, and the mask's char and glow are painted for time 0 (none), so the same frames
   * after it draw what a fresh fire draws.
   */
  resetTime(): void {
    if (this.disposed) return;
    this.clock = 0;
    this.place();
    for (const clock of [...this.flameVolumes, ...this.smokeColumns]) clock.resetTime();
    this.paint();
  }
  /** Moves the fire's clock by `delta` seconds and sets its flames and smoke for that time and the ship's pose (CPU only). */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    this.clock += delta > 0 ? delta : 0;
    this.checkLive();
    this.place();
    this.paint();
  }
  /** The wind at the fire: its own, else the one the weather wrote on its smoke. */
  private windNow(): VFXWind | undefined {
    return this.options.wind ?? this.smokeColumns[0]?.effect.options.wind;
  }
  private place(): void {
    const o = this.options,
      all = this.flames().sort((a, b) => b.heat - a.heat),
      wind = this.windNow(),
      pool = this.flameVolumes;
    // The pool goes to the hottest flames; the rest of the deck's heat goes to the volumes beside it (their footprint widens).
    for (let i = 0; i < pool.length; i++) {
      const f = all[i],
        fo = pool[i]!.options as {
          position: Vec3;
          length?: number;
          footprint?: readonly [number, number];
          wind?: VFXWind;
          yaw?: number;
        };
      if (!f) {
        fo.length = 0;
        continue;
      }
      fo.position = f.position;
      fo.length = Math.min(1000, f.length);
      fo.footprint = f.footprint;
      // The footprint's x side runs along the hull: [cos yaw, 0, -sin yaw] is the hull's forward axis.
      const m = this.matrix();
      fo.yaw = Math.atan2(-m[10]!, m[8]!);
      if (wind) fo.wind = wind;
      else delete fo.wind;
    }
    const cols = this.smokeColumns;
    if (cols.length === 0) return;
    const total = all.reduce((s, f) => s + f.heat, 0),
      L = o.hull?.length ?? 50,
      deck = o.hull?.deck ?? 6,
      color = smokeColor(o.soot ?? 0.35);
    cols.forEach((c, i) => {
      const z = -L / 2 + ((i + 0.5) * L) / cols.length,
        lo = -L / 2 + (i * L) / cols.length,
        hi = i === cols.length - 1 ? Infinity : lo + L / cols.length,
        // Each flame feeds the one column over its stretch of hull (half-open stretches, the ends open).
        share = all
          .filter((f) => {
            const fz = this.localZ(f.position);
            return (i === 0 || fz >= lo) && fz < hi;
          })
          .reduce((s, f) => s + f.heat, 0);
      const so = c.options;
      so.position = this.toWorld([0, deck + 4, z]);
      // 0.7 of the release is convected (Drysdale 2011 ch. 4); a column with no fire under it stops feeding.
      so.heat = Math.max(0, 0.7 * share);
      so.rate = share > 0 ? 18 : 1e-3;
      so.radius = Math.max(1, Math.min(30, (o.hull?.beam ?? 13) * 0.5));
      so.color = color;
      so.opacity = share > 0 ? (o.opacity ?? 0.7) : 0;
      if (o.wind !== undefined && so.wind !== o.wind) c.setWind(o.wind);
      void total;
    });
  }
  private localZ(world: Vec3): number {
    // The hull's forward axis and origin from the matrix: z = (p - origin) . forward / |forward|^2.
    const m = this.matrix(),
      fx = m[8]!,
      fy = m[9]!,
      fz = m[10]!,
      n = fx * fx + fy * fy + fz * fz;
    return ((world[0] - m[12]!) * fx + (world[1] - m[13]!) * fy + (world[2] - m[14]!) * fz) / (n || 1);
  }
  /** A burning hull; see {@link HullFireOptions}. */
  static attach(engine: EngineKernel, options: HullFireOptions): HullFire {
    if (!options || typeof options !== 'object') throw new TypeError('Invalid HullFire options; pass {ship}');
    return new HullFire(engine, options);
  }
  /** Removes the flames and smoke. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    for (const f of this.flameVolumes) f.dispose();
    for (const s of this.smokeColumns) s.dispose();
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
