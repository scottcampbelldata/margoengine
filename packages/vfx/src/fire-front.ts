/// <reference lib="esnext.disposable" preserve="true" />
// A wildfire front from one call: a fire that spreads over a fuel map by wind, slope and fuel moisture in fixed steps,
// leaves a burn texture behind it (arrival time, burn-out time, intensity, state), feeds a pool of smoke columns along
// the whole front, throws embers that start spot fires and burns structures. Sources (papers and reports, read as text;
// no code; docs/clean-room.md "Fire front"):
// - R. C. Rothermel, "A mathematical model for predicting fire spread in wildland fuels", USDA Forest Service Research
//   Paper INT-115, 1972: reaction intensity, propagating flux ratio, wind and slope factors and the heat sink behind
//   the spread rate R = I_R xi (1 + phi_w + phi_s) / (rho_b eps Q_ig).
// - F. A. Albini, "Estimating wildfire behavior and effects", USDA Forest Service General Technical Report INT-30,
//   1976: the way a fuel of several size classes is combined (class and category weights by surface area, the live
//   fuel moisture of extinction) and the characteristic surface-area-to-volume ratio.
// - H. E. Anderson, "Aids to determining fuel models for estimating fire behavior", USDA Forest Service General
//   Technical Report INT-122, 1982: the thirteen fuel models (loads, depths, surface-area-to-volume ratios and
//   moisture of extinction) of which this entry holds the grass, brush and timber ones.
// - P. L. Andrews, "The Rothermel surface fire spread model and associated developments: a comprehensive explanation",
//   USDA Forest Service General Technical Report RMRS-GTR-371, 2018: the model as BehavePlus computes it today (the
//   equations above with Albini's changes), the standard fuel model table (FM7's live surface-area-to-volume ratio is
//   1,500 1/ft, its characteristic ratio 1,552) and the computed values the test pins (tables 8b and 22).
// - H. E. Anderson, "Predicting wind-driven wild land fire size and shape", USDA Forest Service Research Paper
//   INT-305, 1983: the length-to-breadth ratio of a fire from its midflame wind speed.
// - G. D. Richards, "An elliptical growth model of forest fire fronts and its numerical solution", Int. J. Numer.
//   Methods Eng. 30(6), 1163-1179, 1990: each point of a front spreads as the focus of an ellipse, R(t) = R_head
//   (1 - e) / (1 - e cos t).
// - G. M. Byram, "Combustion of forest fuels", in K. P. Davis (ed.), Forest Fire: Control and Use, McGraw-Hill, 1959:
//   fireline intensity I = H w R and the flame length 0.0775 I^0.46.
// - G. Heskestad, "Luminous heights of turbulent diffusion flames", Fire Safety Journal 5(2), 103-108, 1983: the mean
//   flame height of a burning building, 0.235 Q^(2/5) - 1.02 D for a heat release Q (kW) over a vent of diameter D;
//   Byram's flame length draws the flames of the front, Heskestad's those on a building (docs/clean-room.md "Flame volumes").
// - H. E. Anderson, "Forest fuel ignitibility", Fire Technology 5(4), 312-319, 1969: the residence time 384 / sigma
//   minutes of a flame in a fuel of surface-area-to-volume ratio sigma (1 / ft).
// - F. A. Albini and B. J. Baughman, "Estimating windspeeds for predicting wildland fire behavior", USDA Forest Service
//   Research Paper INT-221, 1979: the midflame wind is a fraction of the open wind (0.4 under a canopy).
// - F. Albini, "Spot fire distance from burning trees: a predictive model", INT-56, 1979 and N. Sardoy, J.-L. Consalvi,
//   B. Porterie and A. C. Fernandez-Pello, "Modeling transport and combustion of firebrands from burning trees",
//   Combustion and Flame 150(3), 151-169, 2007: embers loft to a height that follows the flame, fall at a terminal
//   speed and land at a lognormal distance downwind.
// - J. D. Cohen and B. W. Butler, "Modeling potential structure ignitions from flame radiation exposure with
//   implications for wildland/urban interface fire management", 13th Conf. on Fire and Forest Meteorology, 1998 and
//   J. D. Cohen, "Preventing disaster: home ignitability in the wildland-urban interface", J. Forestry 98(3), 15-21,
//   2000: a structure ignites from flame exposure within a few flame lengths and, mainly, from embers on or near it.
// - C. E. Van Wagner, "Conditions for the start and spread of crown fire", Can. J. For. Res. 7(1), 23-34, 1977;
//   R. C. Rothermel, "Predicting behavior and size of crown fires in the Northern Rocky Mountains", INT-438, 1991;
//   Forestry Canada Fire Danger Group, ST-X-3, 1992; J. H. Scott and E. D. Reinhardt, RMRS-RP-29, 2001; P. H. Thomas
//   1963: crown fire initiation, the active criterion, the crown rate, the crown fraction burned and crown flame length
//   (docs/clean-room.md "Crown fire").
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import type { Smoke, SmokeOptions } from '@margoengine/vfx/smoke';
import type { Flame, FlameOptions } from '@margoengine/vfx/flame';
import type { VFX } from '@margoengine/vfx/base';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; COPY_DST: number; COPY_SRC: number };

// ---------------------------------------------------------------------------------------------------------------
// Rothermel's spread model, with Albini's mixing of size classes (imperial inside, SI outside).
// ---------------------------------------------------------------------------------------------------------------

/** One size class of a fuel bed. */
export interface FuelClass {
  /** Fuel load, tons per acre (Anderson 1982's unit). */
  readonly load: number;
  /** Surface-area-to-volume ratio, 1/ft. */
  readonly sav: number;
  /** Which kind of fuel: dead classes dry with the weather, live ones keep their moisture. */
  readonly live?: boolean;
  /** Dead size class (1, 10 or 100 hours), which sets the moisture it holds beside the 1-hour value. */
  readonly hours?: 1 | 10 | 100;
}
/** A fuel bed: its classes, depth and the moisture at which a fire no longer spreads. */
export interface FuelModel {
  /** A name for lookups and tests. */
  readonly name: string;
  /** Size classes, at least one. */
  readonly classes: readonly FuelClass[];
  /** Fuel bed depth, ft. */
  readonly depth: number;
  /** Moisture of extinction of the dead fuel, as a fraction of dry weight (0.12 is 12 percent). */
  readonly extinction: number;
  /** A building: it burns for `structureBurnTime` seconds and ignites from embers and flame exposure. */
  readonly structure?: boolean;
  /** The stand over the bed, for crown fire ({@link crownBehaviour}); none is a bed with no crowns (grass, brush, slash). */
  readonly canopy?: CanopyFuel;
}

const cls = (load: number, sav: number, hours: 1 | 10 | 100 = 1): FuelClass => ({ load, sav, hours });
const live = (load: number, sav = 1500): FuelClass => ({ load, sav, live: true });
// The stands over the timber models, inside the ranges Cruz, Alexander and Wakimoto 2003 measured in crown-fire-prone
// conifer of western North America (canopy base height 0.5 to 9 m, bulk density 0.05 to 0.35 kg/m^3): FM8 a closed
// short-needle stand (Douglas-fir, lodgepole, larch), FM9 an open long-needle pine stand, FM10 a stand with down wood and
// an understory of young trees that ladders flame into the crowns.
const stand = (baseHeight: number, bulkDensity: number, height: number): CanopyFuel => ({
  baseHeight,
  bulkDensity,
  height,
});

/** Anderson 1982's fuel models for grass, brush and timber, by name `FM1` ... `FM13` (loads from table 1 of INT-GTR-122, surface-area-to-volume ratios from table 7 of INT-30 except FM7's live 1,500 1/ft, the standard value of Andrews 2018 table 8a where INT-30 prints 1,550), plus `STRUCTURE`. The timber models FM8, FM9 and FM10 carry a `canopy` for crown fire. */
export const FUEL_MODELS: Readonly<Record<string, FuelModel>> = Object.freeze({
  FM1: { name: 'FM1', classes: [cls(0.74, 3500)], depth: 1, extinction: 0.12 },
  FM2: {
    name: 'FM2',
    classes: [cls(2, 3000), cls(1, 109, 10), cls(0.5, 30, 100), live(0.5)],
    depth: 1,
    extinction: 0.15,
  },
  FM3: { name: 'FM3', classes: [cls(3.01, 1500)], depth: 2.5, extinction: 0.25 },
  FM4: {
    name: 'FM4',
    classes: [cls(5.01, 2000), cls(4.01, 109, 10), cls(2, 30, 100), live(5.01)],
    depth: 6,
    extinction: 0.2,
  },
  FM5: { name: 'FM5', classes: [cls(1, 2000), cls(0.5, 109, 10), live(2)], depth: 2, extinction: 0.2 },
  FM6: { name: 'FM6', classes: [cls(1.5, 1750), cls(2.5, 109, 10), cls(2, 30, 100)], depth: 2.5, extinction: 0.25 },
  FM7: {
    name: 'FM7',
    classes: [cls(1.13, 1750), cls(1.87, 109, 10), cls(1.5, 30, 100), live(0.37)],
    depth: 2.5,
    extinction: 0.4,
  },
  FM8: {
    name: 'FM8',
    classes: [cls(1.5, 2000), cls(1, 109, 10), cls(2.5, 30, 100)],
    depth: 0.2,
    extinction: 0.3,
    canopy: stand(4, 0.12, 20),
  },
  FM9: {
    name: 'FM9',
    classes: [cls(2.92, 2500), cls(0.41, 109, 10), cls(0.15, 30, 100)],
    depth: 0.2,
    extinction: 0.25,
    canopy: stand(6, 0.08, 22),
  },
  FM10: {
    name: 'FM10',
    classes: [cls(3.01, 2000), cls(2, 109, 10), cls(5.01, 30, 100), live(2)],
    depth: 1,
    extinction: 0.25,
    canopy: stand(2, 0.15, 20),
  },
  FM11: { name: 'FM11', classes: [cls(1.5, 1500), cls(4.51, 109, 10), cls(5.51, 30, 100)], depth: 1, extinction: 0.15 },
  FM12: {
    name: 'FM12',
    classes: [cls(4.01, 1500), cls(14.03, 109, 10), cls(16.53, 30, 100)],
    depth: 2.3,
    extinction: 0.2,
  },
  FM13: {
    name: 'FM13',
    classes: [cls(7.01, 1500), cls(23.04, 109, 10), cls(28.05, 30, 100)],
    depth: 3,
    extinction: 0.25,
  },
  // A wood-frame house: about 20 kg of fuel per square metre of floor in a 3 m deep bed (90 tons per acre), thick
  // members (surface-area-to-volume 60 / ft is a 2 x 4 stud wall), dry enough that moisture is not the limit.
  STRUCTURE: { name: 'STRUCTURE', classes: [cls(90, 60)], depth: 10, extinction: 0.3, structure: true },
});

const PARTICLE_DENSITY = 32, // lb/ft^3 (Rothermel 1972)
  HEAT_CONTENT = 8000, // Btu/lb (18,622 kJ/kg)
  TOTAL_MINERAL = 0.0555,
  EFFECTIVE_MINERAL = 0.01,
  TON_ACRE = 2000 / 43560, // lb/ft^2 per ton/acre
  FTMIN_TO_MS = 0.3048 / 60,
  IR_TO_KW = 0.18935; // Btu/ft^2/min to kW/m^2

/** The conditions a spread rate is for. */
export interface FireConditions {
  /** Dead 1-hour fuel moisture, a fraction of dry weight. The 10 and 100 hour classes hold 0.01 and 0.02 more. */
  moisture: number;
  /** Live fuel moisture, a fraction of dry weight (chaparral is 0.6 to 1.2). Default 1. */
  liveMoisture?: number;
  /** Dead 10-hour fuel moisture, a fraction of dry weight. Default `moisture` + 0.01. */
  moisture10?: number;
  /** Dead 100-hour fuel moisture, a fraction of dry weight. Default `moisture` + 0.02. Albini 1976's nomographs hold every dead class at the 1-hour value. */
  moisture100?: number;
  /** Wind at midflame height, m/s. Default 0. */
  wind?: number;
  /** Slope, rise over run along the direction of spread. Default 0. */
  slope?: number;
}

/** What a fuel bed does in given conditions; every number is for the head of a fire that spreads straight upwind. */
export interface FireBehaviour {
  /** Rate of spread of the head, m/s. */
  rate: number;
  /** Rate with no wind and no slope, m/s. */
  rate0: number;
  /** Rothermel's wind factor phi_w. */
  windFactor: number;
  /** Rothermel's slope factor phi_s. */
  slopeFactor: number;
  /** Reaction intensity, kW/m^2. */
  reactionIntensity: number;
  /** Residence time of the flame, seconds (384 / sigma minutes). */
  residence: number;
  /** Byram's fireline intensity at the head, kW/m. */
  firelineIntensity: number;
  /** Byram's flame length at the head, m. */
  flameLength: number;
  /** Head to flank length-to-breadth ratio (Anderson 1983) for the effective wind. */
  lengthToBreadth: number;
}

/** A fuel bed's constants for a moisture state: everything of Rothermel's equations that wind and slope do not touch. */
export interface FuelBed {
  readonly model: FuelModel;
  /** Characteristic surface-area-to-volume ratio, 1/ft. */
  readonly sigma: number;
  /** Packing ratio. */
  readonly beta: number;
  /** Optimum packing ratio. */
  readonly betaOp: number;
  /** Reaction intensity, Btu/ft^2/min. */
  readonly ir: number;
  readonly rate0: number;
  readonly windC: number;
  readonly windB: number;
  readonly windE: number;
  readonly ratio: number;
  readonly residence: number;
  /** Total fuel burned per unit area by the front, kg/m^2 (the mass in the classes that burn). */
  readonly consumed: number;
}

const finiteIn = (v: unknown, name: string, lo: number, hi: number): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw new RangeError(`Invalid fire ${name}; pass a finite number from ${lo} to ${hi}.`);
  return v;
};

/**
 * Precomputes a fuel bed for a moisture state (Rothermel 1972 with Albini 1976's weighting): the characteristic
 * surface-area-to-volume ratio, packing ratio, reaction intensity and the spread rate with no wind and no slope.
 * @throws RangeError for a model with no classes or a non-positive load, depth or surface-area-to-volume ratio, or a
 * moisture outside 0 to 4.
 */
export function fuelBed(
  model: FuelModel,
  moisture: number,
  liveMoisture = 1,
  moisture10 = moisture + 0.01,
  moisture100 = moisture + 0.02,
): FuelBed {
  if (!model.classes.length || !(model.depth > 0) || !(model.extinction > 0))
    throw new RangeError(
      'Invalid fuel model; give at least one class, a depth above 0 and a moisture of extinction above 0.',
    );
  finiteIn(moisture, 'moisture', 0, 4);
  finiteIn(liveMoisture, 'liveMoisture', 0, 4);
  finiteIn(moisture10, 'moisture10', 0, 4);
  finiteIn(moisture100, 'moisture100', 0, 4);
  // Per class: area, moisture, net load, and the weights of Albini 1976.
  const rows = model.classes.map((c) => {
    if (!(c.load > 0) || !(c.sav > 0)) throw new RangeError('Invalid fuel class; load and sav must be above 0.');
    const w = c.load * TON_ACRE,
      m = c.live ? liveMoisture : c.hours === 10 ? moisture10 : c.hours === 100 ? moisture100 : moisture;
    return { c, w, m, area: (c.sav * w) / PARTICLE_DENSITY, live: !!c.live };
  });
  const cat = (isLive: boolean) => rows.filter((r) => r.live === isLive);
  const dead = cat(false),
    alive = cat(true);
  const areaOf = (rs: typeof rows) => rs.reduce((s, r) => s + r.area, 0),
    aDead = areaOf(dead),
    aLive = areaOf(alive),
    aAll = aDead + aLive;
  const sigmaOf = (rs: typeof rows) => {
    const a = areaOf(rs);
    return a > 0 ? rs.reduce((s, r) => s + (r.area / a) * r.c.sav, 0) : 0;
  };
  const fDead = aDead / aAll,
    fLive = aLive / aAll,
    sigma = fDead * sigmaOf(dead) + fLive * sigmaOf(alive);
  const totalLoad = rows.reduce((s, r) => s + r.w, 0),
    rhoB = totalLoad / model.depth,
    beta = rhoB / PARTICLE_DENSITY,
    betaOp = 3.348 * sigma ** -0.8189;
  // Moisture of extinction of live fuel (Albini 1976, from the ratio of fine dead to live loading).
  const fine = (rs: typeof rows, k: number) => rs.reduce((s, r) => s + r.w * Math.exp(-k / r.c.sav), 0),
    wFine = (rs: typeof rows, k: number) => rs.reduce((s, r) => s + r.w * r.m * Math.exp(-k / r.c.sav), 0);
  // Two different moisture averages: the "fine" dead moisture of Frandsen's exp(-138 / sigma) weights sets only the live
  // moisture of extinction (Albini 1976, appendix III, item 3); the moisture that damps a category is Rothermel 1972's
  // surface-area weighted mean (Mf)i = sum f_ij (Mf)ij (the 0.89 / 0.09 / 0.02 Albini quotes for models 6 and 7).
  const mDeadFine = dead.length ? wFine(dead, 138) / fine(dead, 138) : 0,
    areaMoisture = (rs: typeof rows) => {
      const a = areaOf(rs);
      return a > 0 ? rs.reduce((s, r) => s + (r.area / a) * r.m, 0) : 0;
    },
    mDead = areaMoisture(dead),
    mLive = areaMoisture(alive);
  const ratio = alive.length && dead.length ? fine(dead, 138) / fine(alive, 500) : 0,
    mxDead = model.extinction,
    mxLive = alive.length ? Math.max(mxDead, 2.9 * ratio * (1 - mDeadFine / mxDead) - 0.226) : mxDead;
  const damp = (m: number, mx: number) => {
    const r = Math.min(m / mx, 1);
    return 1 - 2.59 * r + 5.11 * r * r - 3.52 * r * r * r;
  };
  const eta = Math.min(0.174 * EFFECTIVE_MINERAL ** -0.19, 1),
    gammaMax = sigma ** 1.5 / (495 + 0.0594 * sigma ** 1.5),
    a = 133 * sigma ** -0.7913,
    gamma = gammaMax * (beta / betaOp) ** a * Math.exp(a * (1 - beta / betaOp)),
    // Net loading of a category: the classes weighted by their share of the category's surface area (Rothermel 1972 eq. 59, Albini 1976).
    netLoad = (rs: typeof rows) => {
      const a = areaOf(rs);
      return a > 0 ? rs.reduce((s, r) => s + (r.area / a) * r.w * (1 - TOTAL_MINERAL), 0) : 0;
    },
    ir =
      gamma *
      HEAT_CONTENT *
      eta *
      (netLoad(dead) * damp(mDead, mxDead) + (alive.length ? netLoad(alive) * damp(mLive, mxLive) : 0));
  const xi = Math.exp((0.792 + 0.681 * Math.sqrt(sigma)) * (beta + 0.1)) / (192 + 0.2595 * sigma);
  // The heat sink: rho_b times the area-weighted heat to ignite each class (Q_ig = 250 + 1116 M Btu/lb).
  const sink = (rs: typeof rows, a: number) =>
    a > 0 ? rs.reduce((s, r) => s + (r.area / a) * Math.exp(-138 / r.c.sav) * (250 + 1116 * r.m), 0) : 0;
  const heatSink = rhoB * (fDead * sink(dead, aDead) + fLive * sink(alive, aLive));
  const rate0 = (ir * xi) / heatSink;
  return {
    model,
    sigma,
    beta,
    betaOp,
    ir,
    rate0: rate0 * FTMIN_TO_MS,
    windC: 7.47 * Math.exp(-0.133 * sigma ** 0.55),
    windB: 0.02526 * sigma ** 0.54,
    windE: 0.715 * Math.exp(-3.59e-4 * sigma),
    ratio: beta / betaOp,
    residence: (384 / sigma) * 60,
    consumed: totalLoad * 4.8824,
  };
}

/** Rothermel's wind factor for a midflame wind of `wind` m/s (with Andrews 1986's limit 0.9 I_R). */
export function windFactor(bed: FuelBed, wind: number): number {
  const u = Math.min(Math.max(wind, 0) / FTMIN_TO_MS, 0.9 * bed.ir);
  return bed.windC * u ** bed.windB * bed.ratio ** -bed.windE;
}
/** Rothermel's slope factor for a slope (rise over run). */
export const slopeFactor = (bed: FuelBed, slope: number): number => 5.275 * bed.beta ** -0.3 * slope * slope;

/**
 * Fire behaviour of a fuel bed at the head of a fire (Rothermel 1972, Albini 1976). Wind and slope are taken to act
 * along the same direction; `FireFront` adds them as vectors.
 * @example fireBehaviour(FUEL_MODELS.FM1, { moisture: 0.08, wind: 2.2352 }).rate * 3600 / 20.1168 // about 79 chains/h
 */
export function fireBehaviour(model: FuelModel, conditions: FireConditions): FireBehaviour {
  const bed = fuelBed(
      model,
      conditions.moisture,
      conditions.liveMoisture ?? 1,
      conditions.moisture10,
      conditions.moisture100,
    ),
    pw = windFactor(bed, finiteIn(conditions.wind ?? 0, 'wind', 0, 200)),
    ps = slopeFactor(bed, finiteIn(conditions.slope ?? 0, 'slope', 0, 10));
  return behaviourOf(bed, pw, ps, pw + ps);
}

const FT_PER_MILE = 5280;
function behaviourOf(bed: FuelBed, pw: number, ps: number, effective: number): FireBehaviour {
  const rate = bed.rate0 * (1 + effective),
    // Byram: I = IR * R * residence (IR in kW/m^2, R in m/s, residence in s gives kJ/m^2 times m/s = kW/m).
    intensity = bed.ir * IR_TO_KW * rate * bed.residence;
  // The wind that gives phi = effective on its own, for Anderson 1983's length-to-breadth ratio (mph, midflame).
  const u = effective > 0 ? ((effective * bed.ratio ** bed.windE) / bed.windC) ** (1 / bed.windB) : 0,
    mph = (u * 60) / FT_PER_MILE;
  return {
    rate,
    rate0: bed.rate0,
    windFactor: pw,
    slopeFactor: ps,
    reactionIntensity: bed.ir * IR_TO_KW,
    residence: bed.residence,
    firelineIntensity: intensity,
    flameLength: 0.0775 * intensity ** 0.46,
    lengthToBreadth: Math.min(8, 0.936 * Math.exp(0.1147 * mph) + 0.461 * Math.exp(-0.0692 * mph) - 0.397),
  };
}

/** Richards 1990: spread rate at `angle` radians from the head, for a fire at the focus of its ellipse. */
export function ellipseRate(head: number, lengthToBreadth: number, angle: number): number {
  const e = Math.sqrt(Math.max(lengthToBreadth * lengthToBreadth - 1, 0)) / lengthToBreadth;
  return (head * (1 - e)) / (1 - e * Math.cos(angle));
}

// ---------------------------------------------------------------------------------------------------------------
// Crown fire: Van Wagner 1977 for when a surface fire climbs into the crowns and when a crown fire runs on its own,
// Rothermel 1991 for how fast it runs, the Canadian Forest Fire Behavior Prediction System for the crown fraction
// burned between the two (sources in docs/clean-room.md "Crown fire").
// ---------------------------------------------------------------------------------------------------------------

/** The canopy over a fuel bed: what a crown fire needs (Van Wagner 1977; Scott and Reinhardt 2001). */
export interface CanopyFuel {
  /** Canopy base height, m: ground to the lowest live crowns and ladder fuel that carry flame upward. */
  readonly baseHeight: number;
  /** Canopy bulk density, kg/m^3: foliage and fine twigs per volume of the crown layer. */
  readonly bulkDensity: number;
  /** Stand height, m (the top of the crown layer). */
  readonly height: number;
}

/** What a stand does over a surface fire: whether it crowns, how fast and how hot. */
export interface CrownBehaviour {
  /** `'surface'` below Van Wagner's critical intensity, `'passive'` torching (crowns burn behind a surface head), `'active'` a running crown fire. */
  type: 'surface' | 'passive' | 'active';
  /** Van Wagner 1977's critical surface intensity for crowning, (0.010 z (460 + 25.9 M))^1.5 kW/m. */
  initiation: number;
  /** Van Wagner 1977's critical spread rate of an active crown fire, 3 / CBD m/min, here m/s. */
  activeRate: number;
  /** Rothermel 1991's crown fire rate, 3.34 times fuel model 10's rate at 0.4 of the 20 ft wind, m/s. */
  crownRate: number;
  /** Crown fraction burned, 0 to 1 (Forestry Canada 1992: 1 - exp(-0.23 (R - R_o)), R in m/min). */
  fraction: number;
  /** Spread rate of the fire, m/s: the surface rate, the passive blend R_s + CFB (R_c - R_s), or the crown rate. */
  rate: number;
  /** Byram's fireline intensity with the crowns burned, kW/m. */
  firelineIntensity: number;
  /** Flame length, m: Thomas 1963's 0.0266 I^(2/3) once crowns burn, else the surface flame. */
  flameLength: number;
  /** Head to flank ratio: Rothermel 1991's 1 + 0.125 U20 (mi/h) for a crown fire, the surface ratio blended by the fraction. */
  lengthToBreadth: number;
}

/** Fuel model 10 (Anderson 1982), whose rate Rothermel 1991 scales to a crown fire's. */
const CROWN_HEAT = 18000, // kJ/kg, Van Wagner 1977's heat of combustion of foliage
  U20_PER_U10 = 1 / 1.15, // Turner and Lawson 1978: the 20 ft wind from the 10 m wind
  MS_TO_MPH = 3600 / 1609.344;

/**
 * Crown fire over a surface fire (Van Wagner 1977; Rothermel 1991; Forestry Canada Fire Danger Group 1992): the stand
 * crowns when the surface fire's intensity reaches Van Wagner's critical value for its canopy base height and foliar
 * moisture; it runs as an active crown fire when Rothermel's crown rate passes 3 / CBD m/min, else it torches
 * (passive) with the crown fraction burned of the Canadian system. A crown fire that runs in from a neighbouring stand
 * (`fed`) goes on as an active crown fire wherever the rate criterion holds, even over a surface fire too weak to start
 * one: Scott and Reinhardt 2001's conditional crown fire.
 * @param surface The surface fire's behaviour at the head ({@link fireBehaviour}).
 * @param canopy The stand.
 * @param foliarMoisture Foliar moisture of the crowns, a fraction of dry weight (1 is 100 percent, Van Wagner's value).
 * @param crownRate Rothermel 1991's crown rate in m/s ({@link crownRate10}).
 * @param wind10 The 10 m open wind, m/s, for the crown fire's shape.
 * @param fed True where an active crown fire runs into this stand from a neighbour. Default false.
 * @example crownBehaviour(fireBehaviour(FUEL_MODELS.FM10, { moisture: 0.05, wind: 7 }), FUEL_MODELS.FM10.canopy!, 1, 1.2, 20).type // 'active'
 */
export function crownBehaviour(
  surface: FireBehaviour,
  canopy: CanopyFuel,
  foliarMoisture: number,
  crownRate: number,
  wind10: number,
  fed = false,
): CrownBehaviour {
  const z = canopy.baseHeight,
    initiation = (0.01 * Math.max(z, 0) * (460 + 2590 * foliarMoisture)) ** 1.5,
    activeRate = 0.05 / canopy.bulkDensity,
    rs = surface.rate,
    is = surface.firelineIntensity,
    lbCrown = Math.min(8, 1 + 0.125 * wind10 * U20_PER_U10 * MS_TO_MPH);
  if (fed && crownRate >= activeRate && rs > 0) {
    const intensity = (is / rs + CROWN_HEAT * canopy.bulkDensity * Math.max(canopy.height - z, 0)) * crownRate;
    return {
      type: 'active',
      initiation,
      activeRate,
      crownRate,
      fraction: 1,
      rate: crownRate,
      firelineIntensity: intensity,
      flameLength: Math.max(surface.flameLength, 0.0266 * intensity ** (2 / 3)),
      lengthToBreadth: Math.max(lbCrown, surface.lengthToBreadth),
    };
  }
  if (!(is >= initiation) || !(rs > 0))
    return {
      type: 'surface',
      initiation,
      activeRate,
      crownRate,
      fraction: 0,
      rate: rs,
      firelineIntensity: is,
      flameLength: surface.flameLength,
      lengthToBreadth: surface.lengthToBreadth,
    };
  // The surface rate at which the intensity reaches the critical value: the surface fire's heat per unit area is I / R.
  const hpa = is / rs,
    r0 = initiation / hpa,
    active = crownRate >= activeRate,
    fraction = active ? 1 : 1 - Math.exp(-0.23 * 60 * (rs - r0)),
    rate = active ? crownRate : rs + fraction * Math.max(crownRate - rs, 0),
    load = canopy.bulkDensity * Math.max(canopy.height - z, 0),
    intensity = (hpa + fraction * CROWN_HEAT * load) * rate;
  return {
    type: active ? 'active' : 'passive',
    initiation,
    activeRate,
    crownRate,
    fraction,
    rate,
    firelineIntensity: intensity,
    flameLength: Math.max(surface.flameLength, 0.0266 * intensity ** (2 / 3)),
    lengthToBreadth: surface.lengthToBreadth + fraction * Math.max(lbCrown - surface.lengthToBreadth, 0),
  };
}

/**
 * Rothermel 1991's crown fire rate, m/s: 3.34 times the rate of fuel model 10 (Anderson 1982) with its midflame wind
 * at 0.4 of the 20 ft wind (the 10 m wind over 1.15, Turner and Lawson 1978), at the given slope factor.
 * @param conditions The dead and live moistures; `wind` is the 10 m open wind, m/s; `slope` rise over run.
 */
export function crownRate10(conditions: FireConditions): number {
  const bed = fuelBed(
    FUEL_MODELS.FM10!,
    conditions.moisture,
    conditions.liveMoisture ?? 1,
    conditions.moisture10,
    conditions.moisture100,
  );
  return crownRateOf(
    bed,
    finiteIn(conditions.wind ?? 0, 'wind', 0, 200),
    slopeFactor(bed, finiteIn(conditions.slope ?? 0, 'slope', 0, 10)),
  );
}
const crownWindFactor = (fm10: FuelBed, wind10: number): number => windFactor(fm10, 0.4 * wind10 * U20_PER_U10);
function crownRateOf(fm10: FuelBed, wind10: number, ps: number): number {
  return 3.34 * fm10.rate0 * (1 + crownWindFactor(fm10, wind10) + ps);
}

// ---------------------------------------------------------------------------------------------------------------
// The front: a fixed-step grid.
// ---------------------------------------------------------------------------------------------------------------

type Vec2 = readonly [number, number];
/** The wind as `[x, z]` m/s at 10 m, or a sampler (a `WindField` fits). */
export type FireWind = Vec2 | { sample(x: number, y: number, z: number, t: number): ArrayLike<number> };

/** Cell states of the burn texture's alpha channel and `FireFront.state`. */
export const UNBURNT = 0,
  BURNING = 1,
  BURNT = 2,
  NO_FUEL = 3;

/** One ignition: where, when (seconds of fire time) and how big. */
export interface FireIgnition {
  /** World `[x, z]`. */
  at: Vec2;
  /** Fire time in seconds. Default 0. */
  time?: number;
  /** Radius of the ignited patch in metres. Default one cell. */
  radius?: number;
}
/** A building: a footprint that burns as the `STRUCTURE` fuel. */
export interface FireStructure {
  /** World `[x, z]` of the centre. */
  at: Vec2;
  /** Half the footprint's side, m. Default 6. */
  radius?: number;
}
/** What a spread over a segment of the front gives smoke. */
export interface FireSegment {
  /** World centre of the burning cells, weighted by heat. */
  x: number;
  z: number;
  /** Ground height at the centre. */
  y: number;
  /** Convective heat release of the segment's cells, watts. */
  heat: number;
  /** Burning cells. */
  cells: number;
  /** Flame length of the segment's front, metres (Byram's, or Thomas's where crowns burn): the column starts at its top. */
  flameLength: number;
}
/** One flame volume to draw: a stretch of the front or a burning building (see {@link FireFront.flames}). */
export interface FireFlame {
  /** `'front'`: cells of the front in one segment, flames by Byram's law; `'structure'`: one building, by Heskestad's. */
  kind: 'front' | 'structure';
  /** World centre of the burning cells, weighted by heat. */
  x: number;
  z: number;
  /** Ground height at the centre. */
  y: number;
  /** Convective heat release, watts. */
  heat: number;
  /** Burning cells. */
  cells: number;
  /** Byram's fireline intensity of the front here (heat-weighted mean), kW/m; 0 for a building. */
  intensity: number;
  /** Flame length, metres: Byram's 0.0775 I^0.46 for the front, Heskestad's for a building. */
  flameLength: number;
  /**
   * Size in metres of the burning cells: for the front, `[along, across]` the stretch of fire line (the heat-weighted
   * spread of its cells along their principal axes, at least one cell each), turned by `yaw`; for a building its
   * `[x, z]` box.
   */
  footprint: [number, number];
  /** Turn of `footprint` about the vertical, radians, as `Flame` `yaw`: the stretch's along axis is (cos yaw, -sin yaw) in x, z. 0 for a building. */
  yaw: number;
  /** The building's index in `options.structures`; -1 for the front. */
  structure: number;
  /** Crown fraction burned here, heat-weighted, 0 (a surface fire) to 1 (an active crown fire); 0 for a building. */
  crown: number;
  /** The ground's slope over the stretch, `[dy/dx, dy/dz]` (a central difference of `ground` across its footprint), as `Flame` `slope`. [0, 0] for a building. */
  slope: [number, number];
  /** A key that stays with the same stretch of front or the same building from step to step. */
  readonly key: number;
}
/** An ember that landed. */
export interface FireSpot {
  from: Vec2;
  to: Vec2;
  /** Fire time, seconds. */
  time: number;
  /** True where it started a fire. */
  ignited: boolean;
}

/** `FireFront` options; the numbers in the second group are read every step. */
export interface FireFrontOptions {
  /** Ground height at world `(x, z)`, metres; sets the slope. Default flat at 0. */
  ground?: (x: number, z: number) => number;
  /** World extent `[x, z]`, m. Default [1024, 1024]. */
  size?: Vec2;
  /** World `[x, z]` of the minimum corner. Default centred on the origin. */
  origin?: Vec2;
  /** Cell side, metres, 1 to 100. The grid holds at most 4,194,304 cells. Default 8. */
  cell?: number;
  /** Fuel at a place: a model, an `FM` name, or null for no fuel (road, water, rock). Default FM1. */
  fuel?: FuelModel | string | ((x: number, z: number) => FuelModel | string | null | undefined);
  /** Buildings, burning as the `STRUCTURE` fuel. */
  structures?: readonly FireStructure[];
  /** Ignitions, each at its time. */
  ignitions?: readonly FireIgnition[];
  /** The step of the fire, seconds, 0.05 to 5. Default 0.5. Read at construction. */
  step?: number;
  /** Seed of the embers' random draws. Default 1. Read at construction. */
  seed?: number;
  /** Segment side for the smoke, metres, at least one cell. Default 120. Read at construction. */
  segment?: number;
  /** Smoke columns along the front (they need an engine). 0 for none. Default 12. Read at attach. */
  columns?: number;
  /**
   * Flame volumes along the front (they need an engine): `Flame` effects of `@margoengine/vfx/flame` placed on the
   * hottest segments, each as long as Byram's flame length of that segment's intensity. 0 for none. A fixed pool: the
   * count of GPU objects does not change as the fire moves. Read at attach. Default 16.
   */
  flames?: number;
  /** Flame volumes on burning buildings (they need an engine), one per building, longest first; 0 for none. Read at attach. Default 8. */
  buildingFlames?: number;
  /** Heat-release share of a burning building's floor that flames leave through, 0.01 to 1: sets the vent Heskestad's height is over (a roof breach and its windows). Default 0.1. */
  structureVent?: number;
  /**
   * Options of every flame volume (the ramp, `peak`, `opacity`, `flicker`, `tongues`, `depth`, `fog`, and `lights`: a
   * `LightGroups` or `Clustered` the volumes light the land, smoke and buildings through); the placement is the front's.
   */
  flame?: Omit<FlameOptions, 'position' | 'length' | 'intensity' | 'heat' | 'footprint' | 'wind' | 'slope'>;
  /**
   * Embers over every flame volume of the front (they need an engine): sparks lofted from the flames and carried ahead
   * of the front by the wind, one particle effect per volume (`VFX` of `@margoengine/vfx/base`, the hearth kit's
   * embers of `snowNight` scaled to a flame of 20 m), born over the flame's footprint a third of its
   * length up, their rate and speed following the flame length of the stretch. The flame volume writes its depth, so
   * an ember behind the flames is hidden and one in front draws over them. Read at attach. Default true.
   */
  flameEmbers?: boolean;
  /**
   * Options handed to every smoke column, over the front's defaults: a 300 s life (the column grows into a pall over
   * the valley), 16 puffs a second, slightly stable air (`stability` 1.5e-4, so it levels off at Briggs' final rise of
   * a few hundred metres and spreads), wood smoke [0.24, 0.22, 0.2] at opacity 0.6, the fire's glow from below, and a
   * source radius of the burning ground of its segment (2 to 60 m) unless `radius` is given.
   */
  smoke?: Omit<SmokeOptions, 'position' | 'heat' | 'fire' | 'wind'>;
  /** Called for each ember that lands. */
  onSpot?: (spot: FireSpot) => void;
  /**
   * The stand at a place, for crown fire: a canopy, or null for none. Default the `canopy` of the place's fuel model
   * (FM8, FM9 and FM10 carry one). Read at construction.
   */
  canopy?: (x: number, z: number) => CanopyFuel | null | undefined;

  /** Dead 1-hour fuel moisture, a fraction. A `WeatherDrive` writes it from the weather's humidity, temperature and rain while it is unset. Default 0.06. */
  moisture?: number;
  /** Dead 10-hour fuel moisture, a fraction. A `WeatherDrive` writes it while unset. Default `moisture` + 0.01. */
  moisture10?: number;
  /** Dead 100-hour fuel moisture, a fraction. A `WeatherDrive` writes it while unset. Default `moisture` + 0.02. */
  moisture100?: number;
  /** Live fuel moisture, a fraction. Default 0.9 (late-season chaparral). */
  liveMoisture?: number;
  /** The wind 10 m up: `[x, z]` m/s, or a sampler. A `WeatherDrive` writes it while it is unset. Default [0, 0]. */
  wind?: FireWind;
  /** Midflame wind as a fraction of the 10 m wind (Albini and Baughman 1979). Default 0.4. */
  windReduction?: number;
  /** Embers per second from each 64 m^2 of burning ground (an 8 m cell) per 1,000 kW/m of fireline intensity above 1,000. Default 0.02. */
  spotting?: number;
  /** Spread of the landing distance (lognormal sigma). Default 0.7. */
  spotSpread?: number;
  /** Chance an ember starts a fire in dry fuel. Default 0.3. */
  emberIgnition?: number;
  /** Seconds of flame exposure within a flame length and a half before a structure ignites. Default 90. */
  structureExposure?: number;
  /** Seconds a structure burns. Default 1,800. */
  structureBurnTime?: number;
  /**
   * Crown fire (Van Wagner 1977, Rothermel 1991): where a cell's stand has a canopy, a surface fire past Van Wagner's
   * critical intensity torches the crowns or runs through them, faster, hotter, with longer flames and embers thrown
   * further. False keeps every fire on the ground. Default true.
   */
  crown?: boolean;
  /** Foliar moisture of the crowns, a fraction of dry weight: 1 (100 percent) is Van Wagner's value, 0.8 late-summer drought, 1.3 new growth. Default 1. */
  foliarMoisture?: number;
  /** Fine smoke (PM2.5) a kilogram of fuel gives, grams: 15 is the extratropical forest value of Akagi et al. 2011 (variation 7.5). Default 15. */
  smokeYield?: number;
}

/** The heat of combustion of the fuel (Rothermel 1972's 8,000 Btu/lb), joules per kilogram. */
const HEAT_OF_COMBUSTION = 18.622e6;
/**
 * The share of a fire's heat release it radiates: `RADIANT_FRACTION` of `@margoengine/vfx/smoke` (Drysdale 2011: 0.2 to
 * 0.4; NISTIR 6546: about 0.3), kept here so the front does not load the smoke entry; a test pins the two equal.
 */
export const RADIANT_SHARE = 0.3;

// The 16 neighbours a cell spreads to: the 8 touching ones and the 8 knight moves, so the grid's own directions do not
// show in the shape of the burn (Richards 1990 uses the continuous front; 16 directions keep its error under 2 percent).
const NEIGHBOURS: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let dz = -2; dz <= 2; dz++)
    for (let dx = -2; dx <= 2; dx++) {
      const a = Math.abs(dx),
        b = Math.abs(dz);
      if ((a || b) && (Math.max(a, b) === 1 || (a + b === 3 && a && b))) out.push([dx, dz]);
    }
  return out;
})();

/** The sums of a stretch of front or a building while a step is added up. */
interface FlameAcc {
  x: number;
  z: number;
  heat: number;
  cells: number;
  /** Fireline intensity times heat, kW/m x W. */
  intensity: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Building index + 1, or 0 for the front. */
  structure: number;
  /** Crown fraction burned times heat. */
  crown: number;
  /** Heat-weighted sums of x^2, z^2 and x z, for the stretch's principal axes. */
  xx: number;
  zz: number;
  xz: number;
}
/** Metres between torching trees a crown fire's flame volumes draw with (a closed conifer stand). */
const CROWN_SPACING = 6;
/** The flame length the front's ember effects are built for, metres; each scales its rate and speed by sqrt(L / this). */
const EMBER_LENGTH = 20;
/** Scattering coefficient of the air around a running fire, per metre: smoke-filled, a visibility of about 1.3 km (the haze of its flame volumes' glow). */
const FRONT_HAZE = 0.003;
/** Buildings have negative flame keys: -(index + 1), or below this for a structure fuel no building listed. */
const BUILDING_NONE = -1e9;

let nextId = 0;
/** Mulberry32 random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A wildfire front on a grid, stepped in fixed steps (`advanceTime`, or each frame once attached; `settle()` runs it
 * until nothing burns). Spread is Rothermel's, direction by direction as Richards' ellipse, so a fire runs fast
 * upwind of the wind and uphill and creeps back downhill. `burnTexture` (rgba32float, one texel per cell, row z) holds
 * per cell: r the fire time it caught, g the time it burns out, b the fireline intensity in MW/m (kept after burn-out), a the state
 * (0 unburnt, 1 burning, 2 burnt, 3 no fuel); terrain and plants read it for char, ash and blackened stems.
 * @throws TypeError / RangeError for invalid options; MargoError `'disposed'` after `dispose()`.
 * @example
 * const fire = FireFront.attach(engine, { ground: world.heightAt, fuel: 'FM4', ignitions: [{ at: [0, 0] }] });
 */
export class FireFront implements EnginePlugin {
  readonly name = 'fire-front:' + nextId++;
  /** Read every step; see {@link FireFrontOptions}. */
  readonly options: FireFrontOptions;
  /** Cells along x and z. */
  readonly width: number;
  readonly height: number;
  /** World `[x, z]` of the minimum corner and the cell side. */
  readonly origin: Vec2;
  readonly cell: number;
  /** The burn texture (needs a WebGPU engine); undefined without one. */
  texture?: GPUTexture;
  /** Fire time, seconds. */
  time = 0;
  /** Embers that landed, and how many of them started a fire. */
  embers = 0;
  spots = 0;

  private engine?: Engine;
  private disposed = false;
  private readonly step: number;
  private readonly seg: number;
  private acc = 0;
  private random: () => number;
  private readonly fuels: FuelModel[] = [];
  private readonly cellFuel: Uint8Array;
  private readonly stateOf: Uint8Array;
  private readonly arrival: Float32Array;
  private readonly burnout: Float32Array;
  private readonly intensity: Float32Array;
  private readonly exposure: Float32Array;
  private readonly slopeX: Float32Array;
  private readonly slopeZ: Float32Array;
  private readonly crownOf: Float32Array;
  /** 1 where an active crown fire ran into the cell from a neighbour (Scott and Reinhardt 2001's conditional crown fire). */
  private readonly fed: Uint8Array;
  /** Per-cell stands from `options.canopy` (base height, bulk density, height), or undefined to read the fuel's. */
  private readonly stands?: Float32Array;
  private fm10?: FuelBed;
  private readonly rows: Float32Array;
  private burning: number[] = [];
  private pending: FireIgnition[] = [];
  private readonly travel = new Map<number, Float32Array>();
  private beds: FuelBed[] = [];
  private bedKey = '';
  private dirty = true;
  private readonly columns: Smoke[] = [];
  private readonly segs: Map<number, { x: number; z: number; heat: number; cells: number }> = new Map();
  private readonly flameAcc: Map<number, FlameAcc> = new Map();
  private readonly structureOf: Uint16Array;
  private readonly frontFlames: Flame[] = [];
  private readonly houseFlames: Flame[] = [];
  private readonly emberPool: VFX[] = [];
  /** Each ember effect's kit values (rate, size, intensity, velocity), as built. */
  private readonly emberBase: { rate: number; size: number; intensity: number; velocity: [number, number, number] }[] =
    [];
  private lightGroups?: { dispose(): void };
  private readonly frontKeys: (number | undefined)[] = [];
  private readonly houseKeys: (number | undefined)[] = [];
  private readonly midflame: [number, number] = [0, 0];
  private born: number[] = [];
  private smokeReady: Promise<void> = Promise.resolve();
  /** True when the columns' radius follows their segments (no `smoke.radius` given). */
  private smokeRadius = false;

  private constructor(options: FireFrontOptions) {
    if (typeof options !== 'object' || options === null) throw new TypeError('FireFront options must be an object');
    this.options = options;
    const size = options.size ?? [1024, 1024],
      cell = finiteIn(options.cell ?? 8, 'cell', 1, 100);
    for (const s of size) finiteIn(s, 'size', cell, 100000);
    this.width = Math.max(1, Math.ceil(size[0] / cell));
    this.height = Math.max(1, Math.ceil(size[1] / cell));
    if (this.width * this.height > 4194304)
      throw new RangeError('FireFront grid is over 4,194,304 cells; raise cell or lower size.');
    this.cell = cell;
    this.origin = options.origin ?? [-size[0] / 2, -size[1] / 2];
    this.step = finiteIn(options.step ?? 0.5, 'step', 0.05, 5);
    this.seg = Math.max(cell, finiteIn(options.segment ?? 120, 'segment', 1, 100000));
    this.random = rng(finiteIn(options.seed ?? 1, 'seed', 0, 4294967295));
    this.checkLive();
    const n = this.width * this.height;
    this.cellFuel = new Uint8Array(n);
    this.structureOf = new Uint16Array(n);
    this.stateOf = new Uint8Array(n);
    this.arrival = new Float32Array(n).fill(-1);
    this.burnout = new Float32Array(n).fill(-1);
    this.intensity = new Float32Array(n);
    this.exposure = new Float32Array(n);
    this.slopeX = new Float32Array(n);
    this.slopeZ = new Float32Array(n);
    this.crownOf = new Float32Array(n);
    this.fed = new Uint8Array(n);
    if (options.canopy) this.stands = new Float32Array(n * 3);
    this.rows = new Float32Array(this.width * 4);
    this.fill();
    for (const ig of options.ignitions ?? []) this.queue(ig);
  }

  /** A fire with no engine: the same model stepped by `advanceTime`, for tests, bakes and tools. */
  static create(options: FireFrontOptions = {}): FireFront {
    return new FireFront(options);
  }
  /** Adds the fire to an engine: it steps with each frame, makes the burn texture and the smoke columns. */
  static attach(engine: EngineKernel, options: FireFrontOptions = {}): FireFront {
    const front = new FireFront(options);
    engineRuntime(engine).use(front);
    return front;
  }

  private checkLive(): void {
    const o = this.options;
    finiteIn(o.moisture ?? 0.06, 'moisture', 0, 1);
    if (o.moisture10 !== undefined) finiteIn(o.moisture10, 'moisture10', 0, 4);
    if (o.moisture100 !== undefined) finiteIn(o.moisture100, 'moisture100', 0, 4);
    finiteIn(o.liveMoisture ?? 0.9, 'liveMoisture', 0, 4);
    finiteIn(o.smokeYield ?? 15, 'smokeYield', 0, 1000);
    finiteIn(o.structureVent ?? 0.1, 'structureVent', 0.01, 1);
    finiteIn(o.flames ?? 16, 'flames', 0, 256);
    finiteIn(o.buildingFlames ?? 8, 'buildingFlames', 0, 256);
    finiteIn(o.windReduction ?? 0.4, 'windReduction', 0, 1);
    finiteIn(o.spotting ?? 0.02, 'spotting', 0, 100);
    finiteIn(o.spotSpread ?? 0.7, 'spotSpread', 0, 3);
    finiteIn(o.emberIgnition ?? 0.3, 'emberIgnition', 0, 1);
    finiteIn(o.structureExposure ?? 90, 'structureExposure', 1, 86400);
    finiteIn(o.structureBurnTime ?? 1800, 'structureBurnTime', 1, 86400);
    finiteIn(o.foliarMoisture ?? 1, 'foliarMoisture', 0.3, 4);
    if (o.crown !== undefined && typeof o.crown !== 'boolean') throw new TypeError('FireFront crown must be a boolean');
    if (Array.isArray(o.wind)) for (const w of o.wind) finiteIn(w, 'wind', -200, 200);
  }

  private register(model: FuelModel): number {
    let i = this.fuels.indexOf(model);
    if (i < 0) {
      if (this.fuels.length >= 250) throw new RangeError('FireFront holds at most 250 different fuel models.');
      this.fuels.push(model);
      i = this.fuels.length - 1;
    }
    return i + 1;
  }
  private resolve(f: FuelModel | string | null | undefined): FuelModel | undefined {
    if (f === null || f === undefined) return undefined;
    if (typeof f === 'string') {
      const m = FUEL_MODELS[f];
      if (!m)
        throw new TypeError(
          `Unknown fuel model ${f}; use one of ${Object.keys(FUEL_MODELS).join(', ')} or a FuelModel.`,
        );
      return m;
    }
    return f;
  }

  private fill(): void {
    const o = this.options,
      { width, height, cell, origin } = this,
      fuel = o.fuel ?? 'FM1',
      ground = o.ground ?? (() => 0),
      h = new Float32Array(width * height);
    for (let z = 0; z < height; z++)
      for (let x = 0; x < width; x++) {
        const wx = origin[0] + (x + 0.5) * cell,
          wz = origin[1] + (z + 0.5) * cell,
          y = ground(wx, wz);
        if (!Number.isFinite(y)) throw new RangeError('FireFront ground must return finite heights');
        h[z * width + x] = y;
        const model = this.resolve(typeof fuel === 'function' ? fuel(wx, wz) : fuel);
        if (model) this.cellFuel[z * width + x] = this.register(model);
        else this.stateOf[z * width + x] = NO_FUEL;
        if (this.stands) {
          const c = o.canopy!(wx, wz);
          if (c) {
            finiteIn(c.baseHeight, 'canopy baseHeight', 0, 100);
            finiteIn(c.bulkDensity, 'canopy bulkDensity', 0.001, 2);
            finiteIn(c.height, 'canopy height', 0, 150);
            this.stands.set([c.baseHeight, c.bulkDensity, c.height], (z * width + x) * 3);
          }
        }
      }
    for (let z = 0; z < height; z++)
      for (let x = 0; x < width; x++) {
        const i = z * width + x,
          xm = Math.max(x - 1, 0),
          xp = Math.min(x + 1, width - 1),
          zm = Math.max(z - 1, 0),
          zp = Math.min(z + 1, height - 1);
        this.slopeX[i] = (h[z * width + xp]! - h[z * width + xm]!) / ((xp - xm || 1) * cell);
        this.slopeZ[i] = (h[zp * width + x]! - h[zm * width + x]!) / ((zp - zm || 1) * cell);
      }
    const structure = this.register(FUEL_MODELS.STRUCTURE!);
    let building = 0;
    for (const s of o.structures ?? []) {
      building++;
      const r = s.radius ?? 6;
      for (let z = 0; z < height; z++)
        for (let x = 0; x < width; x++) {
          const wx = origin[0] + (x + 0.5) * cell,
            wz = origin[1] + (z + 0.5) * cell;
          if (Math.abs(wx - s.at[0]) <= r && Math.abs(wz - s.at[1]) <= r) {
            this.cellFuel[z * width + x] = structure;
            this.structureOf[z * width + x] = building;
            if (this.stateOf[z * width + x] === NO_FUEL) this.stateOf[z * width + x] = UNBURNT;
          }
        }
    }
  }

  private cellAt(x: number, z: number): number {
    const ix = Math.floor((x - this.origin[0]) / this.cell),
      iz = Math.floor((z - this.origin[1]) / this.cell);
    return ix < 0 || iz < 0 || ix >= this.width || iz >= this.height ? -1 : iz * this.width + ix;
  }

  /** The state of the cell at world `(x, z)`: `UNBURNT`, `BURNING`, `BURNT`, `NO_FUEL`, or -1 outside the grid. */
  state(x: number, z: number): number {
    const i = this.cellAt(x, z);
    return i < 0 ? -1 : this.stateOf[i]!;
  }
  /** The fire time the cell at `(x, z)` caught, or -1 where it has not. */
  arrivalTime(x: number, z: number): number {
    const i = this.cellAt(x, z);
    return i < 0 ? -1 : this.arrival[i]!;
  }
  /** The crown fraction burned of the cell at `(x, z)` when it burned (0 a surface fire, 1 an active crown fire), or 0 outside the grid. */
  crownFraction(x: number, z: number): number {
    const i = this.cellAt(x, z);
    return i < 0 ? 0 : this.crownOf[i]!;
  }
  /** The burning cells whose crowns burn now (crown fraction above 0). */
  get crowningCells(): number {
    let n = 0;
    for (const i of this.burning) if (this.stateOf[i] === BURNING && this.crownOf[i]! > 0) n++;
    return n;
  }
  /** The stand over cell `i`, or undefined for none (or crown fire off). */
  private canopyAt(
    i: number,
    model: FuelModel,
    out: { baseHeight: number; bulkDensity: number; height: number },
  ): CanopyFuel | undefined {
    if (this.options.crown === false || model.structure) return undefined;
    if (!this.stands) return model.canopy;
    const k = i * 3;
    if (!(this.stands[k + 1]! > 0)) return undefined;
    out.baseHeight = this.stands[k]!;
    out.bulkDensity = this.stands[k + 1]!;
    out.height = this.stands[k + 2]!;
    return out;
  }

  /** The burning cells now. */
  get burningCells(): number {
    let n = 0;
    for (const i of this.burning) if (this.stateOf[i] === BURNING) n++;
    return n;
  }
  /** The smoke columns along the front, hottest segment first once `ready` has resolved. */
  get smokeColumns(): readonly Smoke[] {
    return this.columns;
  }
  /**
   * The fine smoke (PM2.5) the front gives off now, grams per second: the fuel it burns (the heat it releases over the
   * heat of combustion, 18,622 kJ/kg) times `smokeYield` (15 g/kg, Akagi et al. 2011). `WeatherDrive` raises the
   * weather's `smoke` from it.
   */
  get smokeEmission(): number {
    let watts = 0;
    for (const s of this.segs.values()) watts += s.heat / 0.7;
    return ((this.options.smokeYield ?? 15) * watts) / HEAT_OF_COMBUSTION;
  }
  /**
   * The flames' radiant power now, watts: the share of the front's heat release it radiates, {@link RADIANT_SHARE} (the
   * `RADIANT_FRACTION` of `@margoengine/vfx/smoke` its smoke columns glow with), over the convective 0.7 of the heat it
   * releases. `WeatherDrive` lights the smoke haze from below with it (KB-WEATHER-FIREHAZE1). 0 while nothing burns.
   */
  get radiantPower(): number {
    let convective = 0;
    for (const s of this.segs.values()) convective += s.heat;
    return (RADIANT_SHARE / 0.7) * convective;
  }
  /** True while a cell burns or an ignition waits. */
  get active(): boolean {
    return this.burning.length > 0 || this.pending.length > 0;
  }

  private queue(ig: FireIgnition): void {
    if (!Array.isArray(ig.at) || ig.at.length !== 2) throw new TypeError('FireFront ignition needs at: [x, z]');
    finiteIn(ig.at[0], 'ignition x', -1e7, 1e7);
    finiteIn(ig.at[1], 'ignition z', -1e7, 1e7);
    finiteIn(ig.time ?? 0, 'ignition time', 0, 1e9);
    finiteIn(ig.radius ?? 0, 'ignition radius', 0, 10000);
    this.pending.push(ig);
    this.pending.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  }
  /** Lights a fire at `(x, z)` at `time` seconds of fire time (default now). */
  ignite(x: number, z: number, radius = 0, time = this.time): this {
    this.queue({ at: [x, z], radius, time });
    return this;
  }

  private bedsFor(): FuelBed[] {
    const o = this.options,
      m = o.moisture ?? 0.06,
      lm = o.liveMoisture ?? 0.9,
      m10 = o.moisture10 ?? m + 0.01,
      m100 = o.moisture100 ?? m + 0.02,
      key = m + ',' + lm + ',' + m10 + ',' + m100 + ',' + this.fuels.length;
    if (key !== this.bedKey) {
      this.bedKey = key;
      this.beds = this.fuels.map((f) => fuelBed(f, m, lm, m10, m100));
      this.fm10 = fuelBed(FUEL_MODELS.FM10!, m, lm, m10, m100);
    }
    return this.beds;
  }

  private light(i: number, t: number): boolean {
    if (this.stateOf[i] !== UNBURNT || !this.cellFuel[i]) return false;
    const bed = this.bedsFor()[this.cellFuel[i]! - 1]!,
      model = bed.model;
    this.stateOf[i] = BURNING;
    this.arrival[i] = t;
    this.burnout[i] = t + (model.structure ? (this.options.structureBurnTime ?? 1800) : bed.residence);
    this.born.push(i);
    this.dirty = true;
    return true;
  }

  private lightArea(ig: FireIgnition, t: number): void {
    const { width, height, cell, origin } = this,
      r = ig.radius ?? 0,
      x0 = Math.floor((ig.at[0] - r - origin[0]) / cell),
      x1 = Math.floor((ig.at[0] + r - origin[0]) / cell),
      z0 = Math.floor((ig.at[1] - r - origin[1]) / cell),
      z1 = Math.floor((ig.at[1] + r - origin[1]) / cell);
    for (let z = Math.max(z0, 0); z <= Math.min(z1, height - 1); z++)
      for (let x = Math.max(x0, 0); x <= Math.min(x1, width - 1); x++) {
        const dx = origin[0] + (x + 0.5) * cell - ig.at[0],
          dz = origin[1] + (z + 0.5) * cell - ig.at[1];
        if (dx * dx + dz * dz <= r * r + cell * cell * 0.5) this.light(z * width + x, t);
      }
  }

  /** The 10 m wind `[x, z]` at world `(x, z)` this step. */
  private windAt(x: number, z: number, out: [number, number]): void {
    const w = this.options.wind ?? [0, 0];
    if (Array.isArray(w)) {
      out[0] = w[0] as number;
      out[1] = w[1] as number;
    } else {
      const s = (w as { sample(x: number, y: number, z: number, t: number): ArrayLike<number> }).sample(
        x,
        0,
        z,
        this.time,
      );
      out[0] = s[0]!;
      out[1] = s[s.length - 1]!;
    }
  }

  /** Steps the fire by `delta` seconds in fixed steps of `options.step`; the remainder waits for the next call. */
  advanceTime(delta: number): void {
    if (this.disposed) throw new MargoError('disposed', 'FireFront is disposed; attach a new FireFront');
    finiteIn(delta, 'delta', 0, 86400);
    this.checkLive();
    this.acc += delta;
    while (this.acc >= this.step - 1e-9) {
      this.acc -= this.step;
      this.advance(this.step);
    }
    if (this.dirty) this.publish();
    this.syncFlames();
  }
  /**
   * Back to fire time 0, as a fresh fire with the same options (GAP-FILM-RESET): every cell unburnt again, the
   * `ignitions` of the options queued again (ones added with `ignite` are dropped), the ember and spotting random
   * stream restarted from `seed`, the counters cleared and the burn texture rewritten. Its smoke columns, flame volumes
   * and ember effects go back to idle and to their own start, so the same frames after it draw the same fire.
   */
  resetTime(): void {
    if (this.disposed) return;
    this.time = this.acc = this.embers = this.spots = 0;
    this.random = rng(finiteIn(this.options.seed ?? 1, 'seed', 0, 4294967295));
    const states = this.stateOf;
    for (let i = 0; i < states.length; i++) if (states[i] !== NO_FUEL) states[i] = UNBURNT;
    this.arrival.fill(-1);
    this.burnout.fill(-1);
    for (const a of [this.intensity, this.exposure, this.crownOf, this.fed]) a.fill(0);
    this.burning = [];
    this.born = [];
    this.pending = [];
    for (const ig of this.options.ignitions ?? []) this.queue(ig);
    this.travel.clear();
    this.segs.clear();
    this.flameAcc.clear();
    // The fuel beds are a cache of the options; a fresh fire builds them on its first step.
    this.bedKey = '';
    this.beds = [];
    this.fm10 = undefined;
    this.frontKeys.fill(undefined);
    this.houseKeys.fill(undefined);
    for (const clock of [...this.columns, ...this.frontFlames, ...this.houseFlames, ...this.emberPool])
      clock.resetTime();
    // A fresh fire publishes once it has a texture: rewrite it (and idle the columns), as attaching does.
    this.dirty = true;
    if (this.texture) this.publish();
    this.syncFlames();
  }
  /** Same as {@link advanceTime}, so `seek` can replay a fire. */
  update(delta: number): void {
    this.advanceTime(delta);
  }

  /**
   * Steps the fire until nothing burns and no ignition waits, then resolves with the fire time. Yields to the event
   * loop every 4,096 steps; `signal` aborts it.
   * @param maxSeconds The most fire time to simulate. Default 86,400.
   */
  async settle(maxSeconds = 86400, signal?: AbortSignal): Promise<number> {
    finiteIn(maxSeconds, 'maxSeconds', 0, 1e9);
    const end = this.time + maxSeconds;
    let n = 0;
    while (this.active && this.time < end) {
      signal?.throwIfAborted();
      this.advance(this.step);
      if (++n % 4096 === 0) await Promise.resolve();
    }
    if (this.dirty) this.publish();
    return this.time;
  }

  private advance(dt: number): void {
    const t = this.time + dt,
      o = this.options,
      { width, height, cell } = this,
      beds = this.bedsFor();
    while (this.pending.length && (this.pending[0]!.time ?? 0) <= t) this.lightArea(this.pending.shift()!, t);
    for (const i of this.born) this.burning.push(i);
    this.born.length = 0;
    const reduction = o.windReduction ?? 0.4,
      spot = o.spotting ?? 0.02,
      wind: [number, number] = [0, 0],
      fm10 = this.fm10!,
      foliar = o.foliarMoisture ?? 1,
      standOut = { baseHeight: 0, bulkDensity: 0, height: 0 };
    const next: number[] = [];
    this.segs.clear();
    this.flameAcc.clear();
    // `burning` holds every cell that is flaming or still carrying the front out to its neighbours: a flame lasts its
    // residence time (Anderson 1969) but the front goes on at Rothermel's rate until it has reached each neighbour, so
    // a slow backing fire is not cut short by a short-lived flame.
    for (const i of this.burning) {
      const x = i % width,
        z = (i - x) / width,
        wx = this.origin[0] + (x + 0.5) * cell,
        wz = this.origin[1] + (z + 0.5) * cell,
        bed = beds[this.cellFuel[i]! - 1]!;
      if (this.stateOf[i] === BURNING && t >= this.burnout[i]!) {
        this.stateOf[i] = BURNT;
        // The intensity stays: a burnt cell keeps the fireline intensity it burned at, which plants left standing read
        // for their scorch and char heights (scatter's plant states) after the front has passed.
        this.dirty = true;
      }
      this.windAt(wx, wz, wind);
      // Rothermel adds the wind and slope factors as vectors; the head runs along the sum.
      const speed = Math.hypot(wind[0], wind[1]) * reduction,
        pw = windFactor(bed, speed),
        gx = this.slopeX[i]!,
        gz = this.slopeZ[i]!,
        tan = Math.hypot(gx, gz),
        ps = slopeFactor(bed, tan),
        wux = speed > 1e-9 ? wind[0] / Math.hypot(wind[0], wind[1]) : 0,
        wuz = speed > 1e-9 ? wind[1] / Math.hypot(wind[0], wind[1]) : 0,
        sux = tan > 1e-9 ? gx / tan : 0,
        suz = tan > 1e-9 ? gz / tan : 0,
        vx = pw * wux + ps * sux,
        vz = pw * wuz + ps * suz,
        effective = Math.hypot(vx, vz),
        b = behaviourOf(bed, pw, ps, effective),
        hx = effective > 1e-9 ? vx / effective : 1,
        hz = effective > 1e-9 ? vz / effective : 0,
        ecc = Math.sqrt(Math.max(b.lengthToBreadth ** 2 - 1, 0)) / b.lengthToBreadth;
      // Crown fire over the surface fire where the stand has crowns: its rate is Rothermel 1991's (fuel model 10 at 0.4
      // of the 20 ft wind, wind and slope added as vectors as for the surface), its shape Rothermel 1991's ratio.
      const canopy = this.canopyAt(i, bed.model, standOut);
      let crown: CrownBehaviour | undefined,
        cx = hx,
        cz = hz,
        cecc = ecc;
      if (canopy) {
        const w10 = Math.hypot(wind[0], wind[1]),
          pw10 = crownWindFactor(fm10, w10),
          ps10 = slopeFactor(fm10, tan),
          vx10 = pw10 * wux + ps10 * sux,
          vz10 = pw10 * wuz + ps10 * suz,
          phi10 = Math.hypot(vx10, vz10),
          c = crownBehaviour(b, canopy, foliar, 3.34 * fm10.rate0 * (1 + phi10), w10, this.fed[i] === 1);
        if (c.fraction > 0) {
          crown = c;
          if (phi10 > 1e-9) {
            cx = vx10 / phi10;
            cz = vz10 / phi10;
          }
          cecc = Math.sqrt(Math.max(c.lengthToBreadth ** 2 - 1, 0)) / c.lengthToBreadth;
        }
      }
      const flaming = this.stateOf[i] === BURNING,
        structure = bed.model.structure === true,
        fire = crown ?? b;
      if (flaming) {
        this.intensity[i] = fire.firelineIntensity / 1000;
        if (crown && crown.fraction > this.crownOf[i]!) this.crownOf[i] = crown.fraction;
        const area = cell * cell,
          // The convective part (0.7) of the reaction intensity over the cell; a building releases it more slowly.
          // A building's heat is its fuel over its burn time (a house is a few hundred kW per square metre of floor, not
          // the 1.6 kW/m^2 of Rothermel's flame zone, which is a spreading front's); a front's is the reaction intensity.
          // Burning crowns add their foliage to the heat: the heat per unit area grows by the crown's share of it.
          heat = structure
            ? ((0.7 * bed.consumed * HEAT_OF_COMBUSTION) / (o.structureBurnTime ?? 1800)) * area
            : 0.7 *
              b.reactionIntensity *
              1000 *
              area *
              (crown ? crown.firelineIntensity / crown.rate / (b.firelineIntensity / b.rate) : 1),
          key = Math.floor((wz - this.origin[1]) / this.seg) * 65536 + Math.floor((wx - this.origin[0]) / this.seg),
          s = this.segs.get(key);
        if (s) {
          s.x += wx * heat;
          s.z += wz * heat;
          s.heat += heat;
          s.cells++;
        } else this.segs.set(key, { x: wx * heat, z: wz * heat, heat, cells: 1 });
        const fkey = structure ? (this.structureOf[i] ? -this.structureOf[i]! : BUILDING_NONE - key) : key,
          fa = this.flameAcc.get(fkey);
        if (fa) {
          fa.x += wx * heat;
          fa.z += wz * heat;
          fa.heat += heat;
          fa.cells++;
          fa.intensity += fire.firelineIntensity * heat;
          fa.crown += (crown?.fraction ?? 0) * heat;
          fa.xx += wx * wx * heat;
          fa.zz += wz * wz * heat;
          fa.xz += wx * wz * heat;
          fa.minX = Math.min(fa.minX, wx - cell / 2);
          fa.maxX = Math.max(fa.maxX, wx + cell / 2);
          fa.minZ = Math.min(fa.minZ, wz - cell / 2);
          fa.maxZ = Math.max(fa.maxZ, wz + cell / 2);
        } else
          this.flameAcc.set(fkey, {
            x: wx * heat,
            z: wz * heat,
            heat,
            cells: 1,
            intensity: fire.firelineIntensity * heat,
            crown: (crown?.fraction ?? 0) * heat,
            xx: wx * wx * heat,
            zz: wz * wz * heat,
            xz: wx * wz * heat,
            minX: wx - cell / 2,
            maxX: wx + cell / 2,
            minZ: wz - cell / 2,
            maxZ: wz + cell / 2,
            structure: structure ? this.structureOf[i]! : 0,
          });
        if (fire.firelineIntensity > 1000 && spot > 0) this.throwEmbers(i, fire, wind, t, dt, spot);
        if (!structure) this.exposeStructures(i, fire.flameLength, dt, t);
      }
      // Each neighbour is reached when the front's travel from this cell, rate times time over distance, comes to 1.
      let acc = this.travel.get(i);
      if (!acc) this.travel.set(i, (acc = new Float32Array(NEIGHBOURS.length)));
      let open = false;
      for (let k = 0; k < NEIGHBOURS.length; k++) {
        if (acc[k]! >= 1) continue;
        const [dx, dz] = NEIGHBOURS[k]!,
          nx = x + dx,
          nz = z + dz,
          j = nz * width + nx;
        // Spreading into a structure goes by flame exposure, not the ground fire's rate; no fuel and burnt cells are done.
        if (
          nx < 0 ||
          nz < 0 ||
          nx >= width ||
          nz >= height ||
          !this.cellFuel[j] ||
          this.fuels[this.cellFuel[j]! - 1]!.structure
        ) {
          acc[k] = 2;
          continue;
        }
        if (this.stateOf[j] !== UNBURNT) {
          acc[k] = 2;
          continue;
        }
        // A crown fire runs on only into a cell with crowns; into open ground it goes on as the surface fire.
        const aloft =
            crown !== undefined && this.canopyAt(j, this.fuels[this.cellFuel[j]! - 1]!, standOut) !== undefined,
          head = aloft ? crown!.rate : b.rate,
          e = aloft ? cecc : ecc,
          dist = Math.hypot(dx, dz) * cell,
          cos = (dx * (aloft ? cx : hx) + dz * (aloft ? cz : hz)) / Math.hypot(dx, dz),
          rate = (head * (1 - e)) / (1 - e * cos);
        if (!(rate > 1e-9)) {
          // Damp to its moisture of extinction: this fire does not spread that way.
          acc[k] = 2;
          continue;
        }
        acc[k] = acc[k]! + (rate * dt) / dist;
        if (acc[k]! >= 1 && this.light(j, t) && aloft && crown!.type === 'active') this.fed[j] = 1;
        else open = true;
      }
      if (this.stateOf[i] === BURNING || open) next.push(i);
      else this.travel.delete(i);
    }
    for (const i of this.born) next.push(i);
    this.born.length = 0;
    this.burning = next;
    this.time = t;
  }

  /** Flame exposure of structure cells near a burning cell: within 1.5 flame lengths they heat up and ignite. */
  private exposeStructures(i: number, flame: number, dt: number, t: number): void {
    const { width, height, cell } = this,
      reach = Math.min(8, Math.ceil((1.5 * flame) / cell) + 1),
      x = i % width,
      z = (i - x) / width,
      need = this.options.structureExposure ?? 90;
    for (let dz = -reach; dz <= reach; dz++)
      for (let dx = -reach; dx <= reach; dx++) {
        const nx = x + dx,
          nz = z + dz;
        if ((!dx && !dz) || nx < 0 || nz < 0 || nx >= width || nz >= height) continue;
        const j = nz * width + nx;
        if (this.stateOf[j] !== UNBURNT || !this.cellFuel[j] || !this.fuels[this.cellFuel[j]! - 1]!.structure) continue;
        // The gap between the two cells' edges, not their centres: a flame at the next cell is touching.
        if (Math.max(0, Math.hypot(dx, dz) - 1) * cell > 1.5 * flame) continue;
        this.exposure[j] = this.exposure[j]! + dt;
        if (this.exposure[j]! >= need) this.light(j, t);
      }
  }

  private throwEmbers(
    i: number,
    b: { firelineIntensity: number; flameLength: number },
    wind: readonly [number, number],
    t: number,
    dt: number,
    rate: number,
  ): void {
    // Per 64 m^2 of burning ground (an 8 m cell), so a finer grid throws no more embers over the same fire.
    const mean = ((rate * (b.firelineIntensity - 1000)) / 1000) * dt * ((this.cell * this.cell) / 64);
    let count = Math.floor(mean);
    if (this.random() < mean - count) count++;
    if (!count) return;
    const speed = Math.hypot(wind[0], wind[1]),
      loft = 3 * b.flameLength,
      flight = loft / 4, // fall from the loft height at a terminal speed of 4 m/s
      distance = speed * flight,
      sigma = this.options.spotSpread ?? 0.7,
      { width, cell, origin } = this,
      x = i % width,
      z = (i - x) / width,
      from: Vec2 = [origin[0] + (x + 0.5) * cell, origin[1] + (z + 0.5) * cell];
    for (let k = 0; k < count; k++) {
      const gauss = Math.sqrt(-2 * Math.log(1 - this.random())) * Math.cos(2 * Math.PI * this.random()),
        d = distance * Math.exp(sigma * gauss - 0.5 * sigma * sigma),
        yaw = Math.atan2(wind[0], wind[1]) + 0.12 * (this.random() - 0.5) * 2,
        to: Vec2 = [from[0] + Math.sin(yaw) * d, from[1] + Math.cos(yaw) * d],
        j = this.cellAt(to[0], to[1]);
      this.embers++;
      if (j < 0 || this.stateOf[j] !== UNBURNT || !this.cellFuel[j]) continue;
      const bed = this.bedsFor()[this.cellFuel[j]! - 1]!,
        wet = Math.min(1, (this.options.moisture ?? 0.06) / bed.model.extinction),
        p = (this.options.emberIgnition ?? 0.3) * (1 - wet) * (bed.model.structure ? 1.5 : 1),
        hit = this.random() < p,
        spot: FireSpot = { from, to, time: t, ignited: hit };
      if (hit && this.light(j, t)) this.spots++;
      this.options.onSpot?.(spot);
    }
  }

  /** The burning segments of the front: heat-weighted centre and convective heat in watts, hottest first. */
  segments(): FireSegment[] {
    const ground = this.options.ground ?? (() => 0),
      out: FireSegment[] = [];
    for (const [key, s] of this.segs) {
      const x = s.x / s.heat,
        z = s.z / s.heat,
        f = this.flameAcc.get(key),
        intensity = f && f.heat > 0 ? f.intensity / f.heat : 0,
        flameLength =
          f && f.crown > 0
            ? Math.max(0.0775 * intensity ** 0.46, 0.0266 * intensity ** (2 / 3))
            : 0.0775 * intensity ** 0.46;
      out.push({ x, z, y: ground(x, z), heat: s.heat, cells: s.cells, flameLength });
    }
    return out.sort((a, b) => b.heat - a.heat);
  }

  /**
   * The flames to draw now, hottest first: one per stretch of the front (the cells burning within one `segment`), its
   * length Byram's 0.0775 I^0.46 of the heat-weighted fireline intensity there (Byram 1959), and one per burning
   * building, its length Heskestad's 0.235 Q^(2/5) - 1.02 D of the building's heat release over its vent (Heskestad
   * 1983; the vent is `structureVent` of the floor). The flame volumes of an attached front are placed from this.
   */
  flames(): FireFlame[] {
    const ground = this.options.ground ?? (() => 0),
      vent = this.options.structureVent ?? 0.1,
      out: FireFlame[] = [];
    for (const [key, a] of this.flameAcc) {
      const x = a.x / a.heat,
        z = a.z / a.heat,
        building = key < 0,
        // A stretch of front is a line of burning cells, not its box (KB-FIRE-FLATBOX1: a diagonal or ragged line drawn
        // over its axis-aligned box lay on the slopes as a flat glowing rectangle): its principal axes from the
        // heat-weighted covariance, each extent sqrt(12 var) (a uniform band's width) plus a cell.
        cxx = a.xx / a.heat - x * x,
        czz = a.zz / a.heat - z * z,
        cxz = a.xz / a.heat - x * z,
        mid = 0.5 * (cxx + czz),
        dev = Math.sqrt(Math.max(0.25 * (cxx - czz) ** 2 + cxz * cxz, 0)),
        major = Math.atan2(2 * cxz, cxx - czz) / 2,
        bw = a.maxX - a.minX,
        bh = a.maxZ - a.minZ,
        size: [number, number] = building
          ? [Math.max(this.cell, a.maxX - a.minX), Math.max(this.cell, a.maxZ - a.minZ)]
          : [
              // Never past the cells' box seen along the axis (two clusters at its ends give sqrt(12 var) > their span).
              Math.max(
                this.cell,
                Math.min(
                  Math.sqrt(12 * Math.max(mid + dev, 0)) + this.cell,
                  Math.abs(Math.cos(major)) * bw + Math.abs(Math.sin(major)) * bh,
                ),
              ),
              Math.max(
                this.cell,
                Math.min(
                  Math.sqrt(12 * Math.max(mid - dev, 0)) + this.cell,
                  Math.abs(Math.sin(major)) * bw + Math.abs(Math.cos(major)) * bh,
                ),
              ),
            ],
        intensity = building ? 0 : a.intensity / a.heat,
        // The heat in watts is convective (0.7 of the release): Heskestad's Q is the whole release, kW.
        diameter = Math.sqrt((4 * vent * a.cells * this.cell * this.cell) / Math.PI),
        flameLength = building
          ? Math.max(0.235 * (a.heat / 0.7 / 1000) ** 0.4 - 1.02 * diameter, 0)
          : a.crown > 0
            ? // Thomas 1963's flame length for burning crowns (Rothermel 1991), Byram's for the surface fire.
              Math.max(0.0775 * intensity ** 0.46, 0.0266 * intensity ** (2 / 3))
            : 0.0775 * intensity ** 0.46;
      // The ground's slope across the stretch, so the flame stands on it instead of being cut by it.
      const e = Math.max(this.cell, 0.25 * Math.max(size[0], size[1])),
        slope: [number, number] = building
          ? [0, 0]
          : [(ground(x + e, z) - ground(x - e, z)) / (2 * e), (ground(x, z + e) - ground(x, z - e)) / (2 * e)];
      out.push({
        kind: building ? 'structure' : 'front',
        x,
        z,
        y: ground(x, z),
        heat: a.heat,
        cells: a.cells,
        intensity,
        flameLength,
        footprint: size,
        // Flame yaw turns its footprint's x toward (cos yaw, -sin yaw); the major axis is (cos major, sin major).
        yaw: building ? 0 : -major,
        structure: a.structure > 0 ? a.structure - 1 : -1,
        crown: building ? 0 : a.crown / a.heat,
        slope,
        key,
      });
    }
    return out.sort((a, b) => b.heat - a.heat);
  }
  /** Flame volumes along the front, placed on its hottest stretches (empty until `ready` has resolved). */
  get flameVolumes(): readonly Flame[] {
    return this.frontFlames;
  }
  /** The ember effects over the front's flame volumes, one each in the same order (empty with `flameEmbers: false` or until `ready` has resolved). */
  get flameEmbers(): readonly VFX[] {
    return this.emberPool;
  }
  /** Flame volumes on burning buildings (empty until `ready` has resolved). */
  get buildingFlameVolumes(): readonly Flame[] {
    return this.houseFlames;
  }

  /** Writes the changed cells into the burn texture and moves the smoke columns. */
  private publish(): void {
    this.dirty = false;
    const device = this.engine?.gpu,
      tex = this.texture;
    if (device && tex) {
      const { width, height, rows } = this;
      for (let z = 0; z < height; z++) {
        for (let x = 0; x < width; x++) {
          const i = z * width + x;
          rows[x * 4] = this.arrival[i]!;
          rows[x * 4 + 1] = this.burnout[i]!;
          rows[x * 4 + 2] = this.intensity[i]!;
          rows[x * 4 + 3] = this.stateOf[i]!;
        }
        device.queue.writeTexture({ texture: tex, origin: [0, z] }, rows, { bytesPerRow: width * 16 }, [width, 1]);
      }
    }
    const segs = this.segments();
    for (let k = 0; k < this.columns.length; k++) {
      const col = this.columns[k]!,
        s = segs[k];
      if (!s) col.setHeat(0);
      else {
        const at = col.options.position as [number, number, number],
          // A column taking up a fire after standing idle starts full (its prewarm), not as puffs climbing from the ground.
          idle = !(col.options.heat! > 0);
        // The column leaves the flames' tops, so its puffs do not draw over them (KB-FIRE-SMOKEVEIL1).
        at[0] = s.x;
        at[1] = s.y + Math.max(2, s.flameLength);
        at[2] = s.z;
        if (this.smokeRadius)
          col.options.radius = Math.min(60, Math.max(2, Math.sqrt((s.cells * this.cell * this.cell) / Math.PI)));
        col.setHeat(s.heat);
        if (idle) col.refill();
      }
    }
  }

  /** The cell states read back as a copy of the burn texture's four channels per cell (row z, column x). */
  read(): Float32Array {
    const out = new Float32Array(this.width * this.height * 4);
    for (let i = 0, n = this.width * this.height; i < n; i++) {
      out[i * 4] = this.arrival[i]!;
      out[i * 4 + 1] = this.burnout[i]!;
      out[i * 4 + 2] = this.intensity[i]!;
      out[i * 4 + 3] = this.stateOf[i]!;
    }
    return out;
  }

  /** Sets the 10 m wind `[x, z]` (what a `WeatherDrive` writes); undefined gives it back to the default calm. */
  setWind(wind: Vec2 | undefined): this {
    this.options.wind = wind;
    return this;
  }

  /** Engine plugin hooks. */
  setup(engine: Engine): void {
    if (this.disposed) throw new MargoError('disposed', 'FireFront is disposed; attach a new FireFront');
    this.engine = engine;
    const device = engine.gpu;
    if (device) {
      if (this.width > device.limits.maxTextureDimension2D || this.height > device.limits.maxTextureDimension2D)
        throw new RangeError('FireFront grid exceeds the GPU texture limit; raise cell.');
      this.texture = device.createTexture({
        label: 'fire-front burn',
        size: [this.width, this.height],
        format: 'rgba32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
      this.dirty = true;
      this.publish();
    }
    this.smokeReady = Promise.all([this.makeColumns(engine), this.makeFlames(engine)]).then(() => undefined);
  }
  /** Resolves once the smoke columns exist (`columns` above 0 and an attached engine); never rejects before attach. */
  get ready(): Promise<void> {
    return this.smokeReady;
  }
  private async makeColumns(engine: Engine): Promise<void> {
    const n = finiteIn(this.options.columns ?? 12, 'columns', 0, 256);
    if (!n) return;
    const { Smoke } = await import('@margoengine/vfx/smoke');
    if (this.disposed) return;
    const own = this.options.smoke ?? {};
    this.smokeRadius = own.radius === undefined;
    while (this.columns.length < n)
      this.columns.push(
        Smoke.attach(engine as unknown as EngineKernel, {
          lifetime: 300,
          rate: 16,
          stability: 1.5e-4,
          color: [0.24, 0.22, 0.2],
          opacity: 0.6,
          ...own,
          position: [0, -1e6, 0],
          heat: 0,
        }),
      );
    if (this.smokeLook) for (const c of this.columns) this.smokeLook(c);
    this.dirty = true;
    this.publish();
  }
  private async makeFlames(engine: Engine): Promise<void> {
    const o = this.options,
      front = finiteIn(o.flames ?? 16, 'flames', 0, 256),
      houses = finiteIn(o.buildingFlames ?? 8, 'buildingFlames', 0, 256);
    if (!front && !houses) return;
    const { Flame } = await import('@margoengine/vfx/flame');
    // Every volume lights through a group of its own, so a bare Clustered is shared through LightGroups.
    let lights = o.flame?.lights;
    if (lights && 'maxLights' in lights) {
      const { LightGroups } = await import('@margoengine/clustered/groups');
      lights = this.lightGroups = LightGroups.attach(engine as unknown as EngineKernel, lights);
    }
    if (this.disposed) return;
    const make = (): Flame =>
      Flame.attach(engine as unknown as EngineKernel, {
        haze: FRONT_HAZE,
        ...o.flame,
        ...(lights ? { lights } : {}),
        position: [0, -1e6, 0],
        length: 0,
        footprint: [1, 1],
        wind: [0, 0],
      });
    while (this.frontFlames.length < front) this.frontFlames.push(make());
    while (this.houseFlames.length < houses) this.houseFlames.push(make());
    if (front && o.flameEmbers !== false) await this.makeEmbers(engine, front);
    if (this.disposed) return;
    if (this.flameLook) for (const f of [...this.frontFlames, ...this.houseFlames]) f.setFlameLook(this.flameLook);
    this.syncFlames();
  }
  /** One ember effect per front flame volume: the hearth kit's embers scaled to {@link EMBER_LENGTH}, idle until placed. */
  private async makeEmbers(engine: Engine, count: number): Promise<void> {
    const [
      { VFX },
      { curves },
      { shapes },
      { stretch },
      { schedule },
      { overLife },
      { scaleHearthEmbers },
      { snowNight },
    ] = await Promise.all([
      import('@margoengine/vfx/base'),
      import('@margoengine/vfx/curves'),
      import('@margoengine/vfx/shapes'),
      import('@margoengine/vfx/stretch'),
      import('@margoengine/vfx/schedule'),
      import('@margoengine/vfx/over-life'),
      import('@margoengine/vfx/flame'),
      import('@margoengine/sky/scene-kits'),
    ]);
    if (this.disposed) return;
    const kit = scaleHearthEmbers(snowNight().hearth.embers as never, EMBER_LENGTH, [
      EMBER_LENGTH,
      EMBER_LENGTH,
    ]) as Record<string, unknown> & {
      rate: number;
      size: number;
      intensity: number;
      velocity: [number, number, number];
    };
    while (this.emberPool.length < count) {
      const options = structuredClone(kit) as Record<string, unknown>;
      // No prewarm: an idle effect has no flame under it, and one taking up a stretch starts from its flames.
      delete options.schedule;
      this.emberBase.push({ rate: kit.rate, size: kit.size, intensity: kit.intensity, velocity: [...kit.velocity] });
      this.emberPool.push(
        VFX.attach(
          engine as unknown as EngineKernel,
          { ...(options as object), position: [0, -1e6, 0], rate: 0, wind: [0, 0] } as never,
          {
            curves,
            emitter: shapes,
            stretch,
            schedule,
            overLife,
          },
        ),
      );
    }
  }
  /**
   * Writes the flame rows `applyFlameSettings` resolved (a look family's flames, a shot's keyed radiance) onto every flame
   * volume of the front and its buildings, and onto those the front makes later, so a FireFront is a target of
   * `applyFlameSettings` as a `Flame` is.
   */
  setFlameLook(values: Readonly<Record<string, unknown>>): this {
    this.flameLook = { ...values };
    for (const f of [...this.frontFlames, ...this.houseFlames]) f.setFlameLook(this.flameLook);
    this.placeEmbers();
    return this;
  }
  private flameLook?: Readonly<Record<string, unknown>>;
  /**
   * Keeps the smoke look `applySmokeSettings` resolved (a look family's smoke, a shot's keyed opacity) and writes it onto
   * every smoke column now and onto those the front makes later, so a FireFront is a target of `applySmokeSettings` as a
   * `Smoke` is. `write` leaves each column's heat and radius alone: the front sets them from its segments each step.
   */
  setSmokeLook(write: (column: Smoke) => void): this {
    this.smokeLook = write;
    for (const c of this.columns) write(c);
    return this;
  }
  private smokeLook?: (column: Smoke) => void;
  /** Puts each flame volume on its stretch of the front or its building, keeping a volume with the stretch it had. */
  private syncFlames(): void {
    if (!this.frontFlames.length && !this.houseFlames.length) return;
    const list = this.flames();
    this.place(
      this.frontFlames,
      this.frontKeys,
      list.filter((f) => f.kind === 'front'),
    );
    this.placeEmbers();
    this.place(
      this.houseFlames,
      this.houseKeys,
      list.filter((f) => f.kind === 'structure'),
    );
  }
  private place(pool: Flame[], keys: (number | undefined)[], items: FireFlame[]): void {
    const top = items.slice(0, pool.length);
    for (let i = 0; i < pool.length; i++)
      if (keys[i] !== undefined && !top.some((f) => f.key === keys[i])) keys[i] = undefined;
    for (const f of top)
      if (!keys.includes(f.key)) {
        let slot = -1;
        for (let i = 0; i < pool.length; i++)
          if (keys[i] === undefined) {
            slot = i;
            break;
          }
        keys[slot] = f.key;
      }
    const reduction = this.options.windReduction ?? 0.4;
    for (let i = 0; i < pool.length; i++) {
      const flame = pool[i]!,
        f = keys[i] === undefined ? undefined : top.find((t) => t.key === keys[i]),
        fo = flame.options;
      if (!f) {
        fo.length = 0;
        continue;
      }
      const at = fo.position as [number, number, number],
        fp = fo.footprint as [number, number],
        wind = fo.wind as [number, number],
        // A building's flames come out of its roof and windows, over part of its footprint.
        share = f.kind === 'structure' ? 0.7 : 1;
      at[0] = f.x;
      at[1] = f.y;
      at[2] = f.z;
      fp[0] = f.footprint[0] * share;
      fp[1] = f.footprint[1] * share;
      fo.yaw = f.yaw;
      fo.length = f.flameLength;
      fo.slope = f.slope;
      // Burning crowns draw as torching trees (the flame's `crowns` tree spacing) unless the scene set its own spacing.
      if (f.kind === 'front') fo.crowns = this.options.flame?.crowns ?? (f.crown >= 0.25 ? CROWN_SPACING : 0);
      this.windAt(f.x, f.z, this.midflame);
      wind[0] = this.midflame[0] * reduction;
      wind[1] = this.midflame[1] * reduction;
    }
  }
  /**
   * Puts each ember effect over its flame volume: born over the footprint (its box turned to the world axes) a third of
   * the flame length up, at the kit's rate times sqrt(L / EMBER_LENGTH) times the stretch's length in flame lengths (1
   * to 4), its launch speed times sqrt(L / EMBER_LENGTH) (Sardoy et al. 2007: embers loft with the plume, whose
   * speeds go as sqrt(g L)), carried by the open (10 m) wind above the canopy; none where the volume is out. The ember rows of `applyFlameSettings` scale size, rate and
   * brightness.
   */
  private placeEmbers(): void {
    const look = this.flameLook,
      row = (name: string): number => (look && typeof look[name] === 'number' ? (look[name] as number) : 1);
    for (let i = 0; i < this.emberPool.length; i++) {
      const vfx = this.emberPool[i]!,
        base = this.emberBase[i]!,
        flame = this.frontFlames[i],
        eo = vfx.options as unknown as Record<string, unknown> & { position: number[]; wind: number[] },
        L = flame?.options.length ?? 0;
      if (!flame || !(L > 0)) {
        eo.rate = 0;
        continue;
      }
      const fo = flame.options,
        fp = fo.footprint!,
        c = Math.abs(Math.cos(fo.yaw ?? 0)),
        sn = Math.abs(Math.sin(fo.yaw ?? 0)),
        root = Math.sqrt(L / EMBER_LENGTH),
        lengths = Math.min(4, Math.max(1, Math.max(fp[0], fp[1]) / L));
      eo.position[0] = fo.position[0];
      eo.position[1] = fo.position[1] + L / 3;
      eo.position[2] = fo.position[2];
      eo.emissionExtent = [(c * fp[0] + sn * fp[1]) / 2, L / 6, (sn * fp[0] + c * fp[1]) / 2];
      eo.rate = base.rate * root * lengths * row('embers.count');
      eo.size = base.size * row('embers.size');
      eo.intensity = base.intensity * row('embers.radiance');
      eo.velocity = base.velocity.map((v) => v * root);
      this.windAt(fo.position[0], fo.position[2], this.midflame);
      eo.wind[0] = this.midflame[0];
      eo.wind[1] = this.midflame[1];
    }
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }

  /** Stops the fire and frees the burn texture; the smoke columns stay attached to the engine until it disposes. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.texture?.destroy();
    this.texture = undefined;
    for (const c of this.columns) c.dispose();
    this.columns.length = 0;
    for (const f of [...this.frontFlames, ...this.houseFlames]) f.dispose();
    for (const e of this.emberPool) e.dispose();
    this.emberPool.length = 0;
    this.lightGroups?.dispose();
    this.lightGroups = undefined;
    this.frontFlames.length = 0;
    this.houseFlames.length = 0;
    this.engine = undefined;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }
}
