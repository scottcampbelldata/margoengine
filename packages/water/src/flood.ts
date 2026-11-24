/// <reference lib="esnext.disposable" preserve="true" />
// Floods, dam breaks and bores on a Water's terrain (`@margoengine/water/flood`, disaster water push 3): a finite-volume
// shallow-water solver on the GPU that runs in place of Water's coastal flow, so the surface, spray and queries draw
// it unchanged. The scheme, its papers and its measured bounds are in flood-shaders.ts, test/flood-reference.js and
// test/flood-bounds.test.js; walls raise the bed along a segment, buildings stand on the ground as obstacles (the
// building-block treatment of Schubert and Sanders 2012, https://doi.org/10.1016/j.advwatres.2012.02.012), and inflows
// add volume. The time step is fixed: 1 / (120 m) s with m the least whole number that keeps the Courant number at or
// under 0.25 for `maxDepth` and `maxSpeed`, so frames at 24, 30 and 60 fps are whole ticks of 1 / 120 s.
//
// The film clock (push 4): the flood runs in ticks of 1 / 120 s, m steps each. Every input is a function of the tick: the
// settings in force are a log of snapshots stamped with the tick they began at (a setter called at flood time t takes
// effect at the next tick, ceil(120 t)), and breaches, surges and tsunamis are functions of tick time. A tick writes its
// own uniform (a slice of a ring, bound by offset, written only when it differs from the last) and runs its m steps, so
// 30 fps and 60 fps frames, a seek that replays `advanceTime` on a fresh flood then `settle()`, and a device restore that
// replays from tick 0 all reach the same state bit for bit. The sea: a side marked 'sea' is a Flather open boundary fed
// with the sea level, a surge and tsunami N-waves (Tadepalli and Synolakis 1994, https://doi.org/10.1098/rspa.1994.0050),
// the wind drags the water with the stress of Garratt (1977) and Powell et al. (2003) and rain falls as depth.
//
// Waves (push 7): the Water's swell trains come in through the 'sea' sides on the Flather boundary, and wave makers inside
// the map send trains of a set amplitude and period one way from a line (a source function after Wei, Kirby and Sinha
// 1999, https://doi.org/10.1016/S0378-3839(99)00009-5; flood-shaders.ts has the derivation, test/flood-waves.browser.mjs
// the bounds).
import type { Engine, EnginePlugin } from '@margoengine/core';
import type { Water } from './index.js';
import { waterSolvers, type WaterSolver, type WaterSolverInput } from './query-state.js';
import {
  FLOOD_MAKER_FLOAT,
  FLOOD_SOURCE_FLOAT,
  FLOOD_SWELL_FLOAT,
  FLOOD_UNIFORM_BYTES,
  FLOOD_UNIFORM_STRIDE,
  MAX_FLOOD_SOURCES,
  MAX_FLOOD_SWELLS,
  MAX_FLOOD_WALLS,
  MAX_FLOOD_WAVE_MAKERS,
  floodInitialize,
  floodRecord,
  floodStage,
  type FloodSedimentText,
} from './flood-shaders.js';
import { addSurfaceEffect } from './surface-effects.js';
export { FLOOD_SEDIMENT_MAX } from './flood-shaders.js';
import { siltShader } from './flood-silt.js';
import { compute, group } from '../../shared/gpu.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUTextureUsage: { TEXTURE_BINDING: number; STORAGE_BINDING: number; COPY_SRC: number; COPY_DST: number };
declare const GPUBufferUsage: {
  STORAGE: number;
  UNIFORM: number;
  COPY_DST: number;
  COPY_SRC: number;
  MAP_READ: number;
};
declare const GPUMapMode: { READ: number };

const G = 9.81;
// Samples of the far field's profile (Water's WATER_FAR_SAMPLES).
const FAR_SAMPLES = 64;
/** Courant number the step keeps under at `maxDepth` and `maxSpeed`. */
const COURANT = 0.25;
/** Ticks a second: the whole film clock (a step is a tick at m = 1). */
const RATE = 120;
/** At most this many ticks run in one frame (2 s of flood time); `settle()` runs the rest. */
const TICKS_PER_FRAME = 240;
/** Slices of the uniform ring a frame can use: a pair (stage 0 and 1) per tick at most, plus the one kept from before. */
const RING_PAIRS = 256;
/** Water and air densities (kg/m^3). */
const RHO_WATER = 1000;
const RHO_AIR = 1.225;
/** The N-wave's window, in the wave's own time units (see `tsunamiElevation`). */
const N_HALF = 4.5;
/** Largest of tau sech^2(tau) (at tau = 0.7717; 0.447743), so a tsunami's `height` is its crest and its trough. */
const N_PEAK = 0.447743;
const MAX_TSUNAMIS = 8;
/** Depth below which a cell counts as dry (m), as in the reference. */
const DRY = 1e-6;

/** An inflow: `discharge` m^3/s spread over the cells whose centres lie within `radius` m (per axis) of `position`. */
export interface FloodSource {
  /** World [x, z] in metres, finite. */
  position: readonly [number, number];
  /** Volume rate, 0..1,000,000 m^3/s. */
  discharge: number;
  /** Half side of the footprint, 0..10,000 m. Default 0: the one cell under `position`. */
  radius?: number;
}
/** A wall, dam or levee along the segment `from`-`to`, raising the bed to `top` (world y) in every cell it touches. */
export interface FloodWall {
  /** World [x, z] in metres. */
  from: readonly [number, number];
  /** World [x, z] in metres; the same as `from` for a single post. */
  to: readonly [number, number];
  /** Crest height, world y in metres. */
  top: number;
  /** Thickness in metres, 0..10,000. Default 0: one line of cells. */
  width?: number;
  /** How far it is breached: 0 standing (default) to 1 down to the ground. */
  open?: number;
}
/**
 * A wave maker: a line inside the map that sends a train of waves of `amplitude` and `period` one way, along
 * `direction`, with nothing sent out the back; waves crossing the line pass through it (see {@link Flood.waveMaker}).
 */
export interface FloodWaveMaker {
  /** World [x, z] in metres of the line's middle. */
  position: readonly [number, number];
  /** The way the waves travel in XZ, nonzero; the line runs across it. */
  direction: readonly [number, number];
  /** Amplitude (crest height above the still water) in metres of the train leaving the band, 0..50. Default 0.5. */
  amplitude?: number;
  /** Seconds between crests, 0.5..3,600. Default 10. */
  period?: number;
  /** Phase of the signal at `at` in radians, finite. Default 0: the surface starts rising. */
  phase?: number;
  /** Length of the line in metres, 0..1e6. Default 0: across the whole map. */
  length?: number;
  /** E-folding half width of the band in metres, 0..1e5. Default 0: Wei et al.'s, about an 18th of the wavelength, at least 1.5 cells. */
  width?: number;
  /** Flood time it starts, seconds. Default now. */
  at?: number;
  /** Seconds it runs, then eases out over `ramp`; null (default) runs on. */
  duration?: number | null;
  /** Seconds it eases in (and out), 0..86,400. Default two periods, so it starts with no jolt. */
  ramp?: number;
}
/**
 * Per side of the map: 'wall' reflects the flow (default), 'open' lets it out (zero gradient), 'sea' is an open boundary
 * (Flather 1976) held at the sea level, with the surge and the tsunamis arriving through it and waves leaving freely.
 */
export type FloodBoundary = 'wall' | 'open' | 'sea';
/** A tsunami N-wave arriving through the 'sea' sides, see {@link Flood.tsunami}. */
export interface FloodTsunami {
  /** Crest height and trough depth in metres at the edge of the map, 0..100. Default 3. */
  height?: number;
  /** Seconds the whole wave takes to pass the edge, 1..86,400. Default 300. */
  period?: number;
  /** 'trough' (default): the sea draws back first and the crest follows; 'crest': the crest first. */
  leading?: 'trough' | 'crest';
  /** Flood time the front reaches the edge, seconds. Default now. */
  at?: number;
  /** 'n-wave' (default): the trough and the crest; 'solitary': one crest, H sech^2 of time (Synolakis 1987), `leading` ignored. */
  shape?: 'n-wave' | 'solitary';
}
/** Settings of a {@link Flood}. */
export interface FloodOptions {
  /** The Water whose terrain the flood runs on (its `terrain` option is required); attach it to the engine first. */
  surface: Water;
  /** Up to 16 inflows. Default none. */
  sources?: readonly FloodSource[];
  /** Up to 16 walls. Default none. */
  walls?: readonly FloodWall[];
  /**
   * Buildings and other solid blocks: the height in metres a block stands above the ground at world (x, z), or 0 or
   * undefined for none; read once per cell centre when the flow starts. Water flows round a block and never into it.
   */
  obstacles?: (x: number, z: number) => number | undefined;
  /** Manning roughness n (s m^-1/3), 0..0.2. Default 0.03 (earth channel, Chow 1959); read every frame. */
  roughness?: number;
  /**
   * Mud and debris flow in place of water: the quadratic rheology of O'Brien, Julien and Fullerton (1993), a yield
   * stress, a viscous term and a turbulent-dispersive Manning term, for a named sediment at a volume concentration.
   * Mud stops where its yield stress holds its slope, in heaps and lobes. Read every frame. Default null (water).
   */
  mud?: FloodMud | null;
  /**
   * Suspended sediment (FG-13): flood water picks up soil where its bed shear passes the soil's critical shear, carries it
   * with the current and lets it settle, and the Water surface turns brown-grey with the load (the absorption and
   * back-scatter of `BreakingWaveMaterial`'s `sediment`). Read when the flow starts. Default null: clear water, the
   * record's fourth channel stays 0 and the solver runs the text it ran before.
   */
  sediment?: FloodSediment | null;
  /** Live multiplier of every inflow's discharge, 0..100: 0 turns the sources off, 2 doubles them. Default 1; read every frame. */
  inflow?: number;
  /** Rain on the whole map, mm/h, 0..2,000. Default null: follows `setRainRate` (the weather's), 0 until it is called. */
  rain?: number | null;
  /**
   * The storm surge at the 'sea' sides in metres, -50..50. Default null: the wind's set-up, stress x shelf length / (rho g
   * shelf depth), 0.2 m at 18 m/s and 1.2 m at 40 m/s on the default shelf (Resio and Westerink 2008). Changes ramp in over `surgeRise`.
   */
  surge?: number | null;
  /**
   * Multiplier of the Water's swell trains coming in through the 'sea' sides, 0..10: 0 keeps the swell out, 1 is the
   * Water's own sea. Default 1; read every frame.
   */
  swell?: number;
  /** Live multiplier of every wave maker's amplitude, 0..10. Default 1; read every frame. */
  waveMaker?: number;
  /** Seconds a change of the surge takes to arrive, 0..86,400. Default 600. */
  surgeRise?: number;
  /** The continental shelf the wind sets the sea up over: length 1..1e7 m and depth 0.1..1e4 m. Default 50 km x 20 m. */
  shelf?: { length?: number; depth?: number };
  /**
   * The open sea the Water draws past the 'sea' sides (FG-05, FG-06): the surge and the tsunamis travel on to the map at
   * the long-wave speed sqrt(g `depth`) over `range` metres of it, so a crest stands out at sea before it reaches the
   * edge, and the open sea starts from the sim's own edge level. `depth` 0.1..1e4 m, default the shelf's depth; `range`
   * 1..1e7 m, default 20,000. Null: one flat sea level everywhere, as before. Read every frame.
   */
  farField?: { depth?: number; range?: number } | null;
  /** Map edges. Default 'wall' on every side. */
  boundary?: { west?: FloodBoundary; east?: FloodBoundary; south?: FloodBoundary; north?: FloodBoundary };
  /** The deepest water expected (m), 0.01..1,000; sets the time step with `maxSpeed`. Default 20. */
  maxDepth?: number;
  /** The fastest flow expected (m/s), 0..200; sets the time step with `maxDepth`. Default 15. */
  maxSpeed?: number;
}
/** Suspended sediment of a flood ({@link FloodOptions.sediment}); every field has a default. */
export interface FloodSediment {
  /**
   * Erosion rate M of the soil, kg m^-2 s^-1, 0..0.1: what a square metre of bed gives up each second at twice its
   * critical shear. Default 5e-5 (the middle of the cohesive-soil range of Winterwerp and van Kesteren 2004).
   */
  erosion?: number;
  /** Bed shear stress the soil holds, Pa, 0.01..100. Default 0.2 (soft silt and clay loam). */
  criticalShear?: number;
  /** Settling velocity of the load, m/s, 0..0.1. Default 0.001 (medium silt, Stokes' law at about 35 micrometres). */
  settling?: number;
  /**
   * How erodible the ground is at world (x, z), 0..1: 0 for paving, rock and buildings, 1 for loose soil; read once per
   * cell centre when the flow starts. Default 1 everywhere.
   */
  soil?: (x: number, z: number) => number | undefined;
  /** Tint the Water surface by the load. Default true. */
  tint?: boolean;
}
const SEDIMENT_DEFAULTS = { erosion: 5e-5, criticalShear: 0.2, settling: 0.001 };
function sedimentText(sediment: FloodSediment): FloodSedimentText {
  if (typeof sediment !== 'object')
    throw typeError(
      'Flood sediment must be an object { erosion, criticalShear, settling, soil, tint } or null',
      'geometry',
    );
  if (sediment.soil != null && typeof sediment.soil !== 'function')
    throw typeError('Flood sediment.soil must be a function (x, z) => erodibility 0..1', 'geometry');
  if (sediment.tint != null && typeof sediment.tint !== 'boolean')
    throw typeError('Flood sediment.tint must be true or false', 'geometry');
  return {
    erosion: finite(sediment.erosion, SEDIMENT_DEFAULTS.erosion, 'sediment.erosion', 0, 0.1),
    criticalShear: finite(sediment.criticalShear, SEDIMENT_DEFAULTS.criticalShear, 'sediment.criticalShear', 0.01, 100),
    settling: finite(sediment.settling, SEDIMENT_DEFAULTS.settling, 'sediment.settling', 0, 0.1),
  };
}

/** What {@link Flood.read} measures, summed in doubles over the map. */
export interface FloodReading {
  /** Seconds simulated (whole ticks). */
  time: number;
  /** Steps run (m per tick). */
  steps: number;
  /** Ticks of 1 / 120 s run. */
  ticks: number;
  /** Water volume, m^3. */
  volume: number;
  /** Area with water deeper than 1 mm, m^2. */
  wetArea: number;
  /** The deepest water, m. */
  maxDepth: number;
  /** The fastest flow where deeper than 1 mm, m/s. */
  maxSpeed: number;
  /** The largest Courant number (|u| + sqrt(g h)) dt / cell over the map; the solver is stable at or under 0.25. */
  courant: number;
  /** Cells deeper than `maxDepth` or faster than `maxSpeed`, where the step's Courant bound no longer holds. */
  capped: number;
  /** Width and height of the map in cells; the arrays below are rows of increasing z. */
  width: number;
  height: number;
  /** Depth per cell (m). */
  depth: Float32Array;
  /** Bed per cell (m): terrain, obstacles and walls. */
  bed: Float32Array;
  /** Velocity per cell (m/s), x and z interleaved; 0 where dry. */
  velocity: Float32Array;
  /** Foam per cell, 0..1: carried with the water, lasting about 3 s, never under the white water breaking there. */
  foam: Float32Array;
  /** White water breaking per cell, 0..1 (fronts, Froude above 1, fast flow); what Water's spray takes off from. */
  breaker: Float32Array;
  /** Area with foam above 0.05, m^2. */
  foamArea: number;
  /**
   * Suspended sediment per cell, kg/m^3 (FG-13); all 0 without `sediment`. `read()` always sets it; optional so readings
   * made by hand (for `flood-bake`) need not.
   */
  sediment?: Float32Array;
  /** Suspended sediment in the water, kg: concentration x depth x cell area, summed; `read()` always sets it. */
  sedimentMass?: number;
}

let nextId = 0;
const finite = (value: unknown, fallback: number, what: string, lo: number, hi: number): number => {
  const v = value ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw rangeError(`Flood ${what} must be a finite number in ${lo}..${hi}`, 'geometry');
  return v;
};
const point = (p: unknown, what: string): readonly [number, number] => {
  if (!Array.isArray(p) || p.length !== 2 || !p.every((v) => typeof v === 'number' && Number.isFinite(v)))
    throw typeError(`Flood ${what} must be a finite [x, z]`, 'geometry');
  return p as unknown as readonly [number, number];
};
const BOUNDARY = { wall: 0, open: 1, sea: 2 } as const;

/**
 * The surface a tsunami lifts at the edge, in metres, at flood time `t`: the N-wave of Tadepalli and Synolakis (1994),
 * eta = H tau sech^2(tau) / 0.447743 with tau = 9 (t - at) / period - 4.5, so the trough and the crest are both `height`, it
 * is zero outside `at .. at + period`, and `leading: 'crest'` runs it backwards. `shape: 'solitary'` is one crest of `height`,
 * height sech^2(1.5 tau) (Synolakis 1987, https://doi.org/10.1017/S002211208700329X), centred in the window.
 */
export function tsunamiElevation(
  t: number,
  tsunami: { height: number; period: number; at: number; leading: 'trough' | 'crest'; shape?: 'n-wave' | 'solitary' },
): number {
  let tau = (N_HALF * 2 * (t - tsunami.at)) / tsunami.period - N_HALF;
  if (tau < -N_HALF || tau > N_HALF) return 0;
  if (tsunami.shape === 'solitary') {
    const c = Math.cosh(1.5 * tau);
    return tsunami.height / (c * c);
  }
  if (tsunami.leading === 'crest') tau = -tau;
  const c = Math.cosh(tau);
  return (tsunami.height * tau) / (c * c) / N_PEAK;
}
/** Wind stress over the water in Pa at 10 m wind `speed`: rho_air Cd U^2 with Garratt's (1977) Cd, held above 26 m/s (Powell et al. 2003). */
export function windStress(speed: number): number {
  return RHO_AIR * (0.75 + 0.067 * Math.min(speed, 26)) * 1e-3 * speed * speed;
}

interface Wall {
  from: readonly [number, number];
  to: readonly [number, number];
  top: number;
  width: number;
  open: number;
  breach?: { at: number; over: number; from: number };
}
interface Surge {
  from: number;
  to: number;
  at: number;
  rise: number;
}
interface Maker {
  position: readonly [number, number];
  direction: readonly [number, number];
  amplitude: number;
  period: number;
  phase: number;
  length: number;
  width: number;
  at: number;
  duration: number | null;
  ramp: number;
}
interface Tsunami {
  height: number;
  period: number;
  at: number;
  leading: 'trough' | 'crest';
  shape: 'n-wave' | 'solitary';
}
/**
 * Sediments of O'Brien and Julien (1988), J. Hydraul. Eng. 114(8), 877-887, as the FLO-2D Pro Reference Manual (2021,
 * table 13) and Simulating Mudflow Guidelines (2021, table 3) tabulate them: yield stress tau_y = a2 exp(b2 Cv) in
 * dyne/cm^2 and viscosity eta = a1 exp(b1 Cv) in poise, as [a2, b2, a1, b1], measured for Cv about 0.1 to 0.45.
 */
export const MUD_SEDIMENTS = {
  'aspen-pit-1': [0.181, 25.7, 0.036, 22.1],
  'aspen-pit-2': [2.72, 10.4, 0.0538, 14.5],
  'aspen-natural-soil': [0.152, 18.7, 0.00136, 28.4],
  'aspen-mine-fill': [0.0473, 21.1, 0.128, 12.0],
  'aspen-watershed': [0.0383, 19.7, 0.000495, 27.1],
  'aspen-mine-source': [0.291, 14.3, 0.000201, 33.1],
  'glenwood-1': [0.0345, 20.1, 0.00283, 23.0],
  'glenwood-2': [0.0765, 16.9, 0.648, 8.2],
  'glenwood-3': [0.000707, 29.8, 0.00632, 19.9],
  'glenwood-4': [0.00172, 29.5, 0.000602, 33.1],
} as const satisfies Record<string, readonly [number, number, number, number]>;
/** A sediment of {@link MUD_SEDIMENTS}. */
export type MudSediment = keyof typeof MUD_SEDIMENTS;
/** Mud mode of {@link FloodOptions.mud}. Every field has a default. */
export interface FloodMud {
  /** Sediment whose measured rheology the mud takes. Default 'aspen-natural-soil' (a mud flood, FLO-2D's suggestion). */
  sediment?: MudSediment;
  /** Sediment volume concentration Cv, 0.05..0.6. Default 0.4. */
  concentration?: number;
  /** Laminar resistance K, 24..50,000: 24 smooth, 2,285 a built-up area (FLO-2D's Rudd Creek calibration). Default 2,285. */
  resistance?: number;
  /** Density of the sediment grains, kg/m^3, 1,500..3,500. Default 2,650 (quartz). */
  grainDensity?: number;
}
/** The rheology of a {@link FloodMud}: SI values the flood steps with. */
export interface MudRheology {
  /** Yield stress tau_y, Pa. */
  yieldStress: number;
  /** Viscosity eta, Pa s. */
  viscosity: number;
  /** Mixture density rho_m, kg/m^3. */
  density: number;
  /** Turbulent-dispersive Manning n_td over the water's n: 0.0538 exp(6.0896 Cv) (FLO-2D, after O'Brien et al. 1993). */
  turbulence: number;
}
/** The rheology of `mud` (O'Brien and Julien 1988; O'Brien, Julien and Fullerton 1993), checked. */
export function mudRheology(mud: FloodMud = {}): MudRheology {
  if (typeof mud !== 'object' || mud === null)
    throw typeError('Flood mud must be an object or null; pass { concentration }', 'geometry');
  const sediment = mud.sediment ?? 'aspen-natural-soil',
    row = MUD_SEDIMENTS[sediment];
  if (!row)
    throw rangeError(
      `Flood mud sediment ${String(sediment)} is unknown; pass one of ${Object.keys(MUD_SEDIMENTS).join(', ')}`,
      'geometry',
    );
  const cv = finite(mud.concentration, 0.4, 'mud.concentration', 0.05, 0.6),
    grain = finite(mud.grainDensity, 2650, 'mud.grainDensity', 1500, 3500);
  finite(mud.resistance, 2285, 'mud.resistance', 24, 50000);
  // dyne/cm^2 to Pa and poise to Pa s are both a tenth.
  return {
    yieldStress: 0.1 * row[0] * Math.exp(row[1] * cv),
    viscosity: 0.1 * row[2] * Math.exp(row[3] * cv),
    density: RHO_WATER + cv * (grain - RHO_WATER),
    turbulence: 0.0538 * Math.exp(6.0896 * cv),
  };
}
/** The three friction terms of the flood uniform: Manning n (n_td in mud), tau_y / rho_m and K eta / (8 rho_m). */
function frictionTerms(roughness: number, mud: FloodMud | null | undefined): [number, number, number] {
  if (mud == null) return [roughness, 0, 0];
  const r = mudRheology(mud);
  return [
    roughness * r.turbulence,
    r.yieldStress / r.density,
    ((mud.resistance ?? 2285) * r.viscosity) / (8 * r.density),
  ];
}

/** Everything the flood reads, as it stands from `tick` on. */
interface Inputs {
  tick: number;
  base: number;
  roughness: number;
  /** Manning n in force (n_td in mud), the yield term tau_y / rho_m (m^2/s^2) and the viscous K eta / (8 rho_m) (m^2/s). */
  friction: readonly [number, number, number];
  /** Wind stress over the water's density, m^2/s^2 along x and z. */
  stress: readonly [number, number];
  rain: number;
  inflow: number;
  surge: Surge;
  sources: Required<FloodSource>[];
  walls: Wall[];
  tsunamis: Tsunami[];
  /** The swell trains as Water holds them, 8 floats each, amplitudes times `swell`; empty when there is none to feed. */
  swell: number[];
  makers: Maker[];
  waveMaker: number;
}
const smooth = (x: number) => x * x * (3 - 2 * x);
/**
 * A wave maker's signal in metres at flood time `t`: amplitude x sin(2 pi (t - at) / period + phase), eased in over `ramp`
 * from `at` and out over `ramp` at the end of `duration` (smoothstep), 0 outside.
 */
export function waveMakerSignal(
  t: number,
  maker: { amplitude: number; period: number; phase: number; at: number; duration: number | null; ramp: number },
): number {
  const since = t - maker.at;
  if (since < 0) return 0;
  const left = maker.duration === null ? Infinity : maker.duration - since;
  if (left <= 0) return 0;
  const ease = maker.ramp > 0 ? smooth(Math.min(1, since / maker.ramp, left / maker.ramp)) : 1;
  return maker.amplitude * ease * Math.sin((2 * Math.PI * since) / maker.period + maker.phase);
}
const surgeAt = (s: Surge, t: number) =>
  s.rise > 0
    ? s.from + (s.to - s.from) * smooth(Math.min(1, Math.max(0, (t - s.at) / s.rise)))
    : t >= s.at
      ? s.to
      : s.from;

/**
 * A flood on a Water's terrain: dam breaks, bores, hydraulic jumps, run-up and wetting and drying from the shallow-water
 * equations, with walls, breaches, buildings and inflows, and at its 'sea' sides a surge, tsunamis, wind and rain. Runs on
 * WebGPU and the full WebGL2 compatibility layer.
 *
 * ```ts
 * const flood = Flood.attach(engine, { surface: water, walls: [{ from: [0, 40], to: [80, 40], top: 12 }], boundary: { west: 'sea' } });
 * flood.breach(0, { at: 5, over: 3 });
 * flood.tsunami({ height: 4, period: 240, at: 60 });
 * const { volume, maxSpeed } = await flood.read();
 * ```
 */
export class Flood implements EnginePlugin {
  readonly name = 'water:flood-' + nextId++;
  /** The settings; `roughness`, `rain`, `inflow`, `surge`, `surgeRise` and `shelf` are read every frame, the rest through the methods below. */
  readonly options: FloodOptions;
  private engine?: Engine;
  private solver?: FloodSolver;
  private readonly factory = (input: WaterSolverInput): WaterSolver => {
    const solver = new FloodSolver(input, this);
    this.solver = solver;
    return solver;
  };
  private walls: Wall[] = [];
  private sources: Required<FloodSource>[] = [];
  private tsunamis: Tsunami[] = [];
  private makers: Maker[] = [];
  /** The Water's swell trains as last read, 8 floats each. */
  private trains: number[] = [];
  /** The Water's wave clock when the flood began: the swell enters at Water time = this + flood time. */
  private readonly swellStart: number;
  private seconds = 0;
  private wind = { speed: 0, direction: [1, 0] as readonly [number, number] };
  private driven = 0;
  private base: number;
  private written: number;
  private surge: Surge = { from: 0, to: 0, at: 0, rise: 0 };
  private surfaceGone = false;
  private farDrawn = false;
  /** The inputs by the tick they begin at, in order; the first is tick 0. */
  private readonly log: Inputs[] = [];
  private disposed = false;

  constructor(options: FloodOptions) {
    if (!options || typeof options !== 'object') throw typeError('Flood needs options { surface }', 'geometry');
    const surface = options.surface as unknown as { options?: { terrain?: unknown }; setWaveHeight?: unknown };
    if (!surface || typeof surface.setWaveHeight !== 'function')
      throw fault('state', 'Flood needs a Water as surface; pass the Water whose terrain the flood runs on');
    if (!surface.options?.terrain)
      throw fault('state', 'Flood needs a Water with a terrain option (its heightmap is the bed)');
    if (options.obstacles != null && typeof options.obstacles !== 'function')
      throw typeError('Flood obstacles must be a function (x, z) => height above the ground in metres', 'geometry');
    this.options = { ...options };
    finite(options.roughness, 0.03, 'roughness', 0, 0.2);
    if (options.mud != null) mudRheology(options.mud);
    if (options.sediment != null) sedimentText(options.sediment);
    finite(options.maxDepth, 20, 'maxDepth', 0.01, 1000);
    finite(options.maxSpeed, 15, 'maxSpeed', 0, 200);
    finite(options.rain, 0, 'rain', 0, 2000);
    finite(options.inflow, 1, 'inflow', 0, 100);
    finite(options.surge, 0, 'surge', -50, 50);
    finite(options.surgeRise, 600, 'surgeRise', 0, 86400);
    finite(options.swell, 1, 'swell', 0, 10);
    finite(options.waveMaker, 1, 'waveMaker', 0, 10);
    this.shelf();
    for (const side of ['west', 'east', 'south', 'north'] as const) {
      const kind = options.boundary?.[side] ?? 'wall';
      if (!(kind in BOUNDARY)) throw rangeError(`Flood boundary.${side} must be 'wall', 'open' or 'sea'`, 'geometry');
    }
    const level = (surface as unknown as { seaLevel?: number }).seaLevel ?? 0;
    this.base = this.written = level;
    const clock = (surface as unknown as { time?: number }).time;
    this.swellStart = typeof clock === 'number' && Number.isFinite(clock) ? clock : 0;
    this.sources = this.checkSources(options.sources ?? []);
    for (const wall of options.walls ?? []) this.wall(wall, false);
    this.surge = { from: 0, to: this.surgeTarget(), at: 0, rise: 0 };
    this.commit();
    const gone = (surface as unknown as { onDispose?: (f: () => void) => unknown }).onDispose;
    if (typeof gone === 'function') gone.call(surface, () => (this.surfaceGone = true));
  }
  /** Same as `engine.use(new Flood(options))`; returns it. */
  static attach(engine: Engine, options: FloodOptions): Flood {
    const flood = new Flood(options);
    engine.use(flood);
    return flood;
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'Flood already attached; create another Flood', 'state');
    if (!engine.gpu) throw fault('unsupported', 'Flood needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    const surface = this.options.surface;
    if (!engine.hasPlugin(surface.name)) throw fault('state', 'Attach the Water surface to this engine before Flood');
    if (waterSolvers.has(surface))
      throw fault(
        'attached',
        'This Water already has a flood solver; dispose it before attaching another Flood',
        'state',
      );
    this.engine = engine;
    waterSolvers.set(surface, this.factory);
    if (this.options.sediment != null && this.options.sediment.tint !== false) this.tint(engine.gpu);
  }
  private removeTint?: () => void;
  private readonly tintOwned: { destroy(): void }[] = [];
  /** The surface effect that browns the Water with the sediment the last tick recorded (flood-silt.ts). */
  private tint(device: GPUDevice): void {
    const place = this.options.surface.options.terrain!,
      uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
      fallback = device.createTexture({ size: [1, 1], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.tintOwned.push(uniform, fallback);
    device.queue.writeBuffer(uniform, 0, new Float32Array([...place.origin, ...place.size]));
    const resources: GPUBindingResource[] = [{ buffer: uniform }, fallback.createView()];
    this.removeTint = addSurfaceEffect(this.options.surface, {
      key: 'flood-sediment',
      vertex: false,
      count: 2,
      shader: siltShader,
      prepare: () => {
        const view = this.solver && !this.solver.disposed ? this.solver.shownView : undefined;
        if (view && resources[1] !== view) resources[1] = view;
        return resources;
      },
    });
  }
  /** Seconds on the flood's clock: the sum of frame deltas and `advanceTime` calls. */
  get time(): number {
    return this.seconds;
  }
  /** Seconds per step: 1 / (120 m), known once the flow has started (0 before). */
  get dt(): number {
    return this.solver?.dt ?? 0;
  }
  /** Steps run so far. */
  get steps(): number {
    return this.solver?.steps ?? 0;
  }
  /** Ticks of 1 / 120 s run so far. */
  /**
   * The current after the last tick, m/s: rgba32float, one texel a cell, (u along x, v along z, speed, depth), 0 on dry
   * cells; undefined before the flow starts. Give it to `WaterFlow` (`map: () => flood.velocityTexture, signed: true`,
   * with the terrain's origin and size) so ripples run with the water. Changes texture between ticks: read it each frame.
   */
  get velocityTexture(): GPUTexture | undefined {
    const s = this.solver;
    return s && !s.disposed ? s.velocities[s.ticks % 2] : undefined;
  }
  /**
   * The wetting record after the last tick: rgba32float, one texel a cell, (deepest depth so far in m, seconds since the
   * cell was last wet above 1 cm, 1 once it has been wet, 0). For wet ground, debris lines and drying sand after the
   * water goes back; undefined before the flow starts. Changes texture between ticks: read it each frame.
   */
  get wetTexture(): GPUTexture | undefined {
    const s = this.solver;
    return s && !s.disposed ? s.records[s.ticks % 2] : undefined;
  }
  get ticks(): number {
    return this.solver?.ticks ?? 0;
  }
  /**
   * Moves the clock by `delta` seconds; the ticks it owes run in the next frame (at most 240 a frame) or in `settle()`. It
   * makes no GPU call. Settings changed since the last call take effect from the tick the clock is at, and the Water's
   * sea level follows the flood's.
   */
  advanceTime(delta: number): void {
    this.live();
    this.commit();
    if (delta > 0) this.seconds += delta;
    this.driveSurface();
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /** Adds a wall (at most 16) and returns its index; it stands from the next tick. */
  wall(wall: FloodWall, log = true): number {
    this.live();
    if (this.walls.length >= MAX_FLOOD_WALLS)
      throw rangeError(`Flood takes at most ${MAX_FLOOD_WALLS} walls`, 'geometry');
    if (!wall || typeof wall !== 'object') throw typeError('Flood wall must be { from, to, top }', 'geometry');
    this.walls.push({
      from: point(wall.from, 'wall from'),
      to: point(wall.to, 'wall to'),
      top: finite(wall.top, NaN, 'wall top', -1e6, 1e6),
      width: finite(wall.width, 0, 'wall width', 0, 10000),
      open: finite(wall.open, 0, 'wall open', 0, 1),
    });
    if (log) this.commit();
    return this.walls.length - 1;
  }
  /**
   * Breaches wall `index`: its crest falls to the ground, linearly from flood time `at` (default now) over `over`
   * seconds (default 2; 0 at once), from how open it was then.
   */
  breach(index: number, { at = this.seconds, over = 2 }: { at?: number; over?: number } = {}): void {
    this.live();
    if (!Number.isInteger(index) || index < 0 || index >= this.walls.length)
      throw rangeError(`Flood has no wall ${index}; walls are 0..${this.walls.length - 1}`, 'geometry');
    finite(at, 0, 'breach at', 0, Number.MAX_VALUE);
    finite(over, 2, 'breach over', 0, 1e6);
    this.walls[index].breach = { at, over, from: this.walls[index].open };
    this.commit();
  }
  /** Replaces the inflows; read from the next tick. */
  setSources(sources: readonly FloodSource[]): void {
    this.live();
    this.sources = this.checkSources(sources);
    this.commit();
  }
  private checkSources(sources: readonly FloodSource[]): Required<FloodSource>[] {
    if (!Array.isArray(sources) || sources.length > MAX_FLOOD_SOURCES)
      throw rangeError(`Flood takes at most ${MAX_FLOOD_SOURCES} sources in an array`, 'geometry');
    return sources.map((s) => {
      if (!s || typeof s !== 'object') throw typeError('Flood source must be { position, discharge }', 'geometry');
      return {
        position: point(s.position, 'source position'),
        discharge: finite(s.discharge, NaN, 'source discharge', 0, 1e6),
        radius: finite(s.radius, 0, 'source radius', 0, 10000),
      };
    });
  }
  /**
   * Sends a tsunami N-wave in through the 'sea' sides (at most 8): the sea draws back first by default, then the crest
   * arrives (Tadepalli and Synolakis 1994). It lifts the sea level of the Water as well, so the open sea beyond the map
   * rides on it.
   */
  tsunami({
    height = 3,
    period = 300,
    leading = 'trough',
    at = this.seconds,
    shape = 'n-wave',
  }: FloodTsunami = {}): void {
    this.live();
    const b = this.options.boundary;
    if (![b?.west, b?.east, b?.south, b?.north].includes('sea'))
      throw fault(
        'state',
        "A tsunami arrives through a 'sea' side: set boundary { west: 'sea' } (or another side) first",
        'state',
      );
    if (this.tsunamis.length >= MAX_TSUNAMIS)
      throw rangeError(`Flood takes at most ${MAX_TSUNAMIS} tsunamis`, 'geometry');
    if (leading !== 'trough' && leading !== 'crest')
      throw rangeError("Flood tsunami leading must be 'trough' or 'crest'", 'geometry');
    if (shape !== 'n-wave' && shape !== 'solitary')
      throw rangeError("Flood tsunami shape must be 'n-wave' or 'solitary'", 'geometry');
    this.tsunamis.push({
      shape,
      height: finite(height, 3, 'tsunami height', 0, 100),
      period: finite(period, 300, 'tsunami period', 1, 86400),
      at: finite(at, 0, 'tsunami at', 0, Number.MAX_VALUE),
      leading,
    });
    this.commit();
  }
  /**
   * Adds a wave maker (at most 4) and returns its index: from flood time `at` the line sends waves of `amplitude` and
   * `period` along `direction` and none out the back, and waves crossing it pass through. A source function after Wei,
   * Kirby and Sinha (1999), made one-way by a matching momentum source; it needs water at the line.
   */
  waveMaker(maker: FloodWaveMaker): number {
    this.live();
    if (this.makers.length >= MAX_FLOOD_WAVE_MAKERS)
      throw rangeError(`Flood takes at most ${MAX_FLOOD_WAVE_MAKERS} wave makers`, 'geometry');
    this.makers.push(this.checkMaker(maker));
    this.commit();
    return this.makers.length - 1;
  }
  /** Replaces the wave makers (at most 4); read from the next tick. */
  setWaveMakers(makers: readonly FloodWaveMaker[]): void {
    this.live();
    if (!Array.isArray(makers) || makers.length > MAX_FLOOD_WAVE_MAKERS)
      throw rangeError(`Flood takes at most ${MAX_FLOOD_WAVE_MAKERS} wave makers in an array`, 'geometry');
    this.makers = makers.map((m) => this.checkMaker(m));
    this.commit();
  }
  private checkMaker(m: FloodWaveMaker): Maker {
    if (!m || typeof m !== 'object') throw typeError('Flood wave maker must be { position, direction }', 'geometry');
    const direction = point(m.direction, 'wave maker direction'),
      length = Math.hypot(direction[0], direction[1]);
    if (length === 0) throw rangeError('Flood wave maker direction must not be [0, 0]', 'geometry');
    const period = finite(m.period, 10, 'wave maker period', 0.5, 3600);
    return {
      position: point(m.position, 'wave maker position'),
      direction: [direction[0] / length, direction[1] / length],
      amplitude: finite(m.amplitude, 0.5, 'wave maker amplitude', 0, 50),
      period,
      phase: finite(m.phase, 0, 'wave maker phase', -1e6, 1e6),
      length: finite(m.length, 0, 'wave maker length', 0, 1e6),
      width: finite(m.width, 0, 'wave maker width', 0, 1e5),
      at: finite(m.at, this.seconds, 'wave maker at', 0, Number.MAX_VALUE),
      duration:
        m.duration === null || m.duration === undefined
          ? null
          : finite(m.duration, 0, 'wave maker duration', 0, Number.MAX_VALUE),
      ramp: finite(m.ramp, 2 * period, 'wave maker ramp', 0, 86400),
    };
  }
  /**
   * The wind over the water (the weather drive calls this with its mean wind): `speed` m/s at 10 m, 0..100, `direction`
   * the way it blows in XZ (default as held). It drags the water with stress rho_air Cd U^2 and, while `options.surge`
   * is null, sets the sea up at the 'sea' sides.
   */
  setWind(wind: { speed: number; direction?: readonly [number, number] }): this {
    this.live();
    if (!wind || typeof wind !== 'object') throw typeError('Flood setWind needs { speed, direction }', 'geometry');
    const speed = finite(wind.speed, NaN, 'wind speed', 0, 100);
    let direction = this.wind.direction;
    if (wind.direction !== undefined) {
      direction = point(wind.direction, 'wind direction');
      if (Math.hypot(direction[0], direction[1]) === 0)
        throw rangeError('Flood wind direction must not be [0, 0]', 'geometry');
    }
    this.wind = { speed, direction };
    this.commit();
    return this;
  }
  /** Rain on the whole map in mm/h, 0..2,000, while `options.rain` is null (the weather drive calls this). */
  setRainRate(rate: number): this {
    this.live();
    this.driven = finite(rate, NaN, 'rain rate', 0, 2000);
    this.commit();
    return this;
  }
  /** The surge in metres at flood time `t` (default now): `options.surge`, or the wind's set-up, eased in over `surgeRise`. */
  surgeAt(t = this.seconds): number {
    return surgeAt(this.surge, t);
  }
  /** The sea level at the 'sea' sides at flood time `t` (default now), world y: the Water's own level, the surge and the tsunamis. */
  seaLevelAt(t = this.seconds): number {
    const s = this.at(Math.floor(t * RATE + 1e-6));
    return s.base + surgeAt(s.surge, t) + this.waveAt(s, t);
  }
  private shelf(): { length: number; depth: number } {
    return {
      length: finite(this.options.shelf?.length, 50000, 'shelf length', 1, 1e7),
      depth: finite(this.options.shelf?.depth, 20, 'shelf depth', 0.1, 1e4),
    };
  }
  private surgeTarget(): number {
    const o = this.options.surge;
    if (o !== undefined && o !== null) return finite(o, 0, 'surge', -50, 50);
    const shelf = this.shelf();
    return (windStress(this.wind.speed) * shelf.length) / (RHO_WATER * G * shelf.depth);
  }
  private waveAt(s: Inputs, t: number): number {
    let eta = 0;
    for (const w of s.tsunamis) eta += tsunamiElevation(t, w);
    return eta;
  }
  /** The tick a setting changed now takes effect from. */
  private effective(): number {
    return Math.max(0, Math.ceil(this.seconds * RATE - 1e-6));
  }
  /** Notes the live settings in the log, from the next tick, when they differ from the last entry's. */
  private commit(): void {
    const o = this.options,
      tick = this.effective(),
      surface = o.surface as unknown as { seaLevel?: number },
      now = surface.seaLevel;
    if (now !== undefined && now !== this.written) this.base = this.written = now;
    const rain = finite(o.rain ?? this.driven, 0, 'rain', 0, 2000),
      rise = finite(o.surgeRise, 600, 'surgeRise', 0, 86400),
      target = this.surgeTarget();
    if (target !== this.surge.to || rise !== this.surge.rise)
      this.surge = { from: surgeAt(this.surge, this.seconds), to: target, at: this.seconds, rise };
    const speed = this.wind.speed > 0 ? windStress(this.wind.speed) / RHO_WATER : 0,
      length = Math.hypot(this.wind.direction[0], this.wind.direction[1]),
      next: Inputs = {
        tick,
        base: this.base,
        roughness: finite(o.roughness, 0.03, 'roughness', 0, 0.2),
        friction: frictionTerms(finite(o.roughness, 0.03, 'roughness', 0, 0.2), o.mud),
        stress: [(speed * this.wind.direction[0]) / length, (speed * this.wind.direction[1]) / length],
        rain: rain / 3.6e6,
        inflow: finite(o.inflow, 1, 'inflow', 0, 100),
        surge: { ...this.surge },
        sources: this.sources.map((s) => ({ ...s })),
        walls: this.walls.map((w) => ({ ...w, breach: w.breach && { ...w.breach } })),
        tsunamis: this.tsunamis.map((w) => ({ ...w })),
        swell: this.swellTrains(finite(o.swell, 1, 'swell', 0, 10)),
        makers: this.makers.map((m) => ({ ...m })),
        waveMaker: finite(o.waveMaker, 1, 'waveMaker', 0, 10),
      },
      last = this.log[this.log.length - 1],
      key = (i: Inputs) => JSON.stringify({ ...i, tick: 0 });
    if (last && key(last) === key(next)) return;
    if (last && last.tick === tick) this.log[this.log.length - 1] = next;
    else this.log.push(next);
  }
  /**
   * The Water's swell trains as its uniform holds them (8 floats each: direction x, z, amplitude, wavenumber, steepness,
   * angular frequency, phase, mesh fade), amplitudes times `scale`; none when no side is 'sea' or no train has height.
   */
  private swellTrains(scale: number): number[] {
    const b = this.options.boundary,
      values = (this.options.surface as unknown as { values?: Float32Array }).values;
    // A disposed Water keeps the trains it last had.
    if (!this.surfaceGone && values)
      this.trains = Array.from(values.subarray(32, 32 + Math.min(MAX_FLOOD_SWELLS, values[23] | 0) * 8));
    if (scale === 0 || ![b?.west, b?.east, b?.south, b?.north].includes('sea')) return [];
    const out = this.trains.map((v, i) => (i % 8 === 2 ? v * scale : v));
    return out.some((v, i) => i % 8 === 2 && v > 0) ? out : [];
  }
  /** The inputs in force at tick `k`. */
  private at(k: number): Inputs {
    let lo = 0,
      hi = this.log.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.log[mid].tick <= k) lo = mid;
      else hi = mid - 1;
    }
    return this.log[lo];
  }
  /** The Water's own level follows the flood's, so the open sea beyond the map rides on the surge and the tsunamis. */
  private driveSurface(): void {
    const surface = this.options.surface as unknown as { setSeaLevel?: (y: number) => unknown };
    if (this.surfaceGone || typeof surface.setSeaLevel !== 'function') return;
    this.driveFarField();
    const level = Math.fround(this.seaLevelAt());
    if (level === this.written) return;
    surface.setSeaLevel(level);
    this.written = level;
  }
  /**
   * The far field the Water draws now: the sea sides, and the sea level `r` metres out less the edge's, where the wave
   * now there reaches the edge r / c seconds later (c = sqrt(g depth)); null without a 'sea' side or with `farField` null.
   */
  farFieldAt(
    t = this.seconds,
  ): { sides: Record<'west' | 'east' | 'south' | 'north', boolean>; profile: Float32Array; range: number } | null {
    const b = this.options.boundary ?? {},
      o = this.options.farField,
      sides = { west: b.west === 'sea', east: b.east === 'sea', south: b.south === 'sea', north: b.north === 'sea' };
    if (o === null || !(sides.west || sides.east || sides.south || sides.north)) return null;
    const depth = finite(o?.depth, this.shelf().depth, 'farField depth', 0.1, 1e4),
      range = finite(o?.range, 20000, 'farField range', 1, 1e7),
      c = Math.sqrt(G * depth),
      edge = this.seaLevelAt(t),
      profile = new Float32Array(FAR_SAMPLES);
    for (let i = 0; i < FAR_SAMPLES; i++) profile[i] = this.seaLevelAt(t + (range * i) / (FAR_SAMPLES - 1) / c) - edge;
    return { sides, profile, range };
  }
  private driveFarField(): void {
    const surface = this.options.surface as unknown as { setFarField?: (field: unknown) => unknown };
    if (typeof surface.setFarField !== 'function') return;
    const field = this.farFieldAt();
    if (!field && !this.farDrawn) return;
    surface.setFarField(field);
    this.farDrawn = !!field;
  }
  /**
   * Fills the per-tick part of the uniform for tick `k`: settings, sea, wind and rain, sources and walls with their breach
   * applied at the tick's time. The fixed part (step, cell, sides, origin) is the caller's. Returns whether a wall moves.
   */
  writeUniform(data: Float32Array, k: number): boolean {
    const s = this.at(k),
      t = k / RATE;
    let moving = false;
    const eta = this.waveAt(s, t);
    data[8] = s.friction[0];
    data[14] = s.friction[1];
    data[15] = s.friction[2];
    data[10] = s.sources.length;
    data[11] = s.walls.length;
    data[16] = s.base + surgeAt(s.surge, t) + eta;
    data[17] = eta;
    data[18] = this.log[0].base;
    data[20] = s.stress[0];
    data[21] = s.stress[1];
    data[22] = s.rain;
    s.sources.forEach((c, i) =>
      data.set([c.position[0], c.position[1], c.discharge * s.inflow, c.radius], FLOOD_SOURCE_FLOAT + i * 4),
    );
    const trains = s.swell.length / 8;
    data[FLOOD_SWELL_FLOAT] = trains > 0 ? this.swellStart + t : 0;
    data[FLOOD_SWELL_FLOAT + 1] = trains;
    data[FLOOD_SWELL_FLOAT + 2] = s.makers.length;
    data.fill(0, FLOOD_SWELL_FLOAT + 4, FLOOD_SWELL_FLOAT + 4 + MAX_FLOOD_SWELLS * 8);
    data.set(s.swell, FLOOD_SWELL_FLOAT + 4);
    // A maker's signal is taken at the tick's middle, so the depth it adds over the tick is right to second order.
    const middle = (k + 0.5) / RATE;
    s.makers.forEach((m, i) =>
      data.set(
        [
          m.position[0],
          m.position[1],
          m.direction[0],
          m.direction[1],
          waveMakerSignal(middle, m) * s.waveMaker,
          (2 * Math.PI) / m.period,
          m.width,
          m.length / 2,
        ],
        FLOOD_MAKER_FLOAT + i * 8,
      ),
    );
    s.walls.forEach((w, i) => {
      const b = w.breach;
      let open = w.open;
      if (b) {
        const f = b.over > 0 ? Math.min(1, Math.max(0, (t - b.at) / b.over)) : t >= b.at ? 1 : 0;
        open = b.from + (1 - b.from) * f;
        if (f < 1) moving = true;
      }
      data.set(
        [w.from[0], w.from[1], w.to[0], w.to[1], w.top, w.width / 2, open, 0],
        FLOOD_SOURCE_FLOAT + MAX_FLOOD_SOURCES * 4 + i * 8,
      );
    });
    return moving;
  }
  /** Ticks owed by the clock after `done`, at most `limit`. */
  owedTicks(done: number, limit = TICKS_PER_FRAME): number {
    return Math.max(0, Math.min(limit, Math.floor(this.seconds * RATE + 1e-6) - done));
  }
  /**
   * Runs every owed tick now, in chunks of 240, and resolves when the GPU has finished them: after a seek (a fresh flood
   * given the same `advanceTime` calls as a continuous run, then one frame so Water starts it) the state equals the
   * continuous run's, bit for bit.
   */
  async settle(): Promise<void> {
    this.live();
    const solver = this.solver;
    if (!solver || solver.disposed)
      throw fault('state', 'The flood has not started; render a frame with its Water first');
    await solver.settle();
  }
  /** Reads the water back: volume, wet area, depths, speeds and the Courant number, plus every cell. */
  async read(): Promise<FloodReading> {
    this.live();
    const solver = this.solver;
    if (!solver || solver.disposed)
      throw fault('state', 'The flood has not started; render a frame with its Water first');
    return solver.read(this.options);
  }
  private live() {
    if (this.disposed) throw fault('disposed', 'Flood is disposed; create another Flood');
  }
  /** Water's coastal flow returns to its own solver on the next frame, at the level it had; the plugin leaves the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const surface = this.options.surface as unknown as { setSeaLevel?: (y: number) => unknown };
    if (waterSolvers.get(this.options.surface) === this.factory) waterSolvers.delete(this.options.surface);
    this.removeTint?.();
    this.removeTint = undefined;
    for (const object of this.tintOwned) object.destroy();
    this.tintOwned.length = 0;
    if (!this.surfaceGone && typeof surface.setSeaLevel === 'function' && this.written !== this.base)
      surface.setSeaLevel(this.base);
    if (!this.surfaceGone && this.farDrawn)
      (surface as unknown as { setFarField: (field: null) => unknown }).setFarField(null);
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.engine = undefined;
    this.solver = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}

/** The GPU side, made by Water through the solver bridge and disposed by it. */
class FloodSolver implements WaterSolver {
  readonly terrain: GPUTexture;
  readonly states: GPUTexture[] = [];
  readonly views: GPUTextureView[] = [];
  readonly fluxes: GPUTexture[] = [];
  readonly connected: GPUBuffer;
  /** The current (u, v, speed, depth) and the wetting record after the tick before the last, and after the last (by tick parity). */
  readonly velocities: GPUTexture[] = [];
  readonly records: GPUTexture[] = [];
  current = 0;
  ticks = 0;
  /** Steps a tick. */
  readonly m: number;
  readonly dt: number;
  disposed = false;
  private readonly device: GPUDevice;
  private readonly owned: { destroy(): void }[] = [];
  private readonly ring: GPUBuffer;
  private readonly work = new Float32Array(FLOOD_UNIFORM_BYTES / 4);
  private readonly last = new Float32Array(FLOOD_UNIFORM_BYTES / 4);
  private readonly stage: GPUComputePipeline;
  private readonly first: GPUComputePipeline;
  private readonly recorder: GPUComputePipeline;
  /** With sediment: the soil's erodibility per cell, and the record of the last tick copied where Water's surface reads it. */
  private readonly soil?: GPUTexture;
  private readonly shown?: GPUTexture;
  readonly shownView?: GPUTextureView;
  private readonly recordGroups = new Map<number, GPUBindGroup>();
  private readonly firstGroup: GPUBindGroup;
  private readonly groups = new Map<number, GPUBindGroup>();
  private readonly resources: GPUTextureView[];
  private readonly descriptor: GPUComputePassDescriptor = {};
  private started = false;
  /** The pair of ring slices holding the uniform of the last tick that differed, -1 before any. */
  private pair = -1;
  readonly width: number;
  readonly height: number;
  readonly cell: readonly [number, number];
  constructor(
    input: WaterSolverInput,
    private readonly flood: Flood,
  ) {
    const { device, terrain } = input,
      place = flood.options.surface.options.terrain!,
      width = terrain.width,
      height = terrain.height,
      dx = place.size[0] / width, // float division: metres
      dz = place.size[1] / height; // float division: metres
    this.device = device;
    this.terrain = terrain;
    this.width = width;
    this.height = height;
    this.cell = [dx, dz];
    const o = flood.options,
      speed = (o.maxSpeed ?? 15) + Math.sqrt(G * (o.maxDepth ?? 20)),
      limit = (COURANT * Math.min(dx, dz)) / speed,
      m = Math.ceil(1 / (RATE * limit) - 1e-9);
    if (m > 16)
      throw rangeError(
        `Flood needs ${m} steps per 1/120 s for cells of ${Math.min(dx, dz)} m at maxDepth ${o.maxDepth ?? 20} m and maxSpeed ${o.maxSpeed ?? 15} m/s (at most 16); use larger cells or lower maxDepth or maxSpeed`,
        'geometry',
      );
    this.m = Math.max(1, m);
    this.dt = 1 / (RATE * this.m);
    try {
      const own = <T extends { destroy(): void }>(object: T): T => (this.owned.push(object), object);
      const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
        texture = (format: GPUTextureFormat, use = usage) =>
          own(device.createTexture({ size: [width, height], format, usage: use }));
      // 0 and 1 hold the state between steps (Water reads states[current]); 2 holds U1 between the stages.
      for (let i = 0; i < 3; i++) {
        this.states.push(texture('rgba32float'));
        this.fluxes.push(texture('rgba32float'));
      }
      this.views.push(...this.states.slice(0, 2).map((t) => t.createView()));
      for (let i = 0; i < 2; i++) {
        this.velocities.push(texture('rgba32float'));
        this.records.push(texture('rgba32float'));
      }
      this.connected = own(
        device.createBuffer({
          size: (width * height + 1) * 4,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          mappedAtCreation: true,
        }),
      );
      // No cell is open sea: the swell's surf and wall spray stay off over a flood.
      new Uint32Array(this.connected.getMappedRange()).fill(1);
      this.connected.unmap();
      const upload = (data: Float32Array) => {
        const t = texture('r32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
        device.queue.writeTexture(
          { texture: t },
          data as Float32Array<ArrayBuffer>,
          { bytesPerRow: width * 4, rowsPerImage: height },
          [width, height],
        );
        return t;
      };
      const blocks = new Float32Array(width * height);
      if (o.obstacles)
        for (let j = 0; j < height; j++)
          for (let i = 0; i < width; i++) {
            const v = o.obstacles(place.origin[0] + (i + 0.5) * dx, place.origin[1] + (j + 0.5) * dz);
            if (v !== undefined && v !== null && (!Number.isFinite(v) || v < 0))
              throw rangeError(
                'Flood obstacles must return a finite height of 0 or more metres, or undefined',
                'geometry',
              );
            blocks[j * width + i] = v ?? 0;
          }
      const obstacles = upload(blocks),
        fill = upload(input.fill ?? new Float32Array(width * height).fill(-1e30));
      this.ring = own(
        device.createBuffer({
          size: RING_PAIRS * 2 * FLOOD_UNIFORM_STRIDE,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        }),
      );
      const sides = o.boundary ?? {},
        start = own(
          device.createBuffer({ size: FLOOD_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        );
      this.work.set([
        this.dt,
        0,
        dx,
        dz,
        BOUNDARY[sides.west ?? 'wall'],
        BOUNDARY[sides.east ?? 'wall'],
        BOUNDARY[sides.south ?? 'wall'],
        BOUNDARY[sides.north ?? 'wall'],
        0,
        DRY,
        0,
        0,
        place.origin[0],
        place.origin[1],
      ]);
      flood.writeUniform(this.work, 0);
      device.queue.writeBuffer(start, 0, this.work as Float32Array<ArrayBuffer>);
      const view = (t: GPUTexture) => t.createView();
      this.first = compute(device, floodInitialize);
      this.firstGroup = group(device, this.first, [
        { buffer: start },
        view(terrain),
        view(obstacles),
        view(fill),
        view(this.states[0]),
        view(this.fluxes[0]),
      ]);
      this.stage = compute(device, floodStage);
      const sediment = o.sediment != null ? sedimentText(o.sediment) : undefined;
      this.recorder = compute(device, floodRecord(1 / RATE, DRY, sediment));
      if (sediment) {
        const soil = new Float32Array(width * height).fill(1),
          read = o.sediment!.soil;
        if (read)
          for (let j = 0; j < height; j++)
            for (let i = 0; i < width; i++) {
              const v = read(place.origin[0] + (i + 0.5) * dx, place.origin[1] + (j + 0.5) * dz);
              if (v !== undefined && v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))
                throw rangeError('Flood sediment.soil must return a number in 0..1, or undefined', 'geometry');
              soil[j * width + i] = v ?? 1;
            }
        this.soil = upload(soil);
        this.shown = texture('rgba32float', GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST);
        this.shownView = this.shown.createView();
      }
      this.resources = [view(terrain), view(obstacles), ...this.states.map(view), ...this.fluxes.map(view)];
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  get steps(): number {
    return this.ticks * this.m;
  }
  /** The bind group of ring slice `slice` (even: stage 0, odd: stage 1) with the state in `c`. */
  private bound(slice: number, c: number): GPUBindGroup {
    const key = slice * 2 + c;
    let g = this.groups.get(key);
    if (!g) {
      const [terrain, obstacles, S0, S1, S2, M0, M1, M2] = this.resources,
        S = [S0, S1, S2],
        M = [M0, M1, M2],
        uniform = { buffer: this.ring, offset: slice * FLOOD_UNIFORM_STRIDE, size: FLOOD_UNIFORM_BYTES };
      g =
        slice % 2 === 0
          ? group(this.device, this.stage, [uniform, terrain, obstacles, S[c], M[c], S[c], M[c], S[2], M[2]])
          : group(this.device, this.stage, [uniform, terrain, obstacles, S[c], M[c], S[2], M[2], S[1 - c], M[1 - c]]);
      this.groups.set(key, g);
    }
    return g;
  }
  /** The bind group that records the tick ending with state `c`: it reads the record of parity `k` and writes the other. */
  private recordGroup(c: number, k: number): GPUBindGroup {
    // With sediment the group also binds the tick's uniform slice (its roughness), so it is kept per ring pair.
    const key = c * 2 + k + (this.soil ? 4 * this.pair : 0);
    let g = this.recordGroups.get(key);
    if (!g) {
      const view = (t: GPUTexture) => t.createView();
      g = group(this.device, this.recorder, [
        view(this.states[c]),
        view(this.fluxes[c]),
        view(this.records[k]),
        view(this.velocities[1 - k]),
        view(this.records[1 - k]),
        ...(this.soil
          ? [
              { buffer: this.ring, offset: this.pair * 2 * FLOOD_UNIFORM_STRIDE, size: FLOOD_UNIFORM_BYTES },
              view(this.soil),
            ]
          : []),
      ]);
      this.recordGroups.set(key, g);
    }
    return g;
  }
  /** Makes the ring hold tick `k`'s uniform: a new pair of slices when it differs from the last tick's. */
  private prepare(k: number): void {
    const work = this.work;
    work[1] = 0;
    this.flood.writeUniform(work, k);
    if (this.pair >= 0 && work.every((v, i) => v === this.last[i])) return;
    this.pair = (this.pair + 1) % RING_PAIRS;
    this.last.set(work);
    for (let s = 0; s < 2; s++) {
      work[1] = s;
      this.device.queue.writeBuffer(
        this.ring,
        (this.pair * 2 + s) * FLOOD_UNIFORM_STRIDE,
        work as Float32Array<ArrayBuffer>,
      );
    }
  }
  /** Records up to `limit` owed ticks into `encoder`; returns how many. */
  record(encoder: GPUCommandEncoder, limit = TICKS_PER_FRAME): number {
    if (this.disposed) return 0;
    const x = Math.ceil(this.width / 8),
      y = Math.ceil(this.height / 8),
      count = this.flood.owedTicks(this.ticks, limit);
    if (this.started && count === 0) return 0;
    const pass = encoder.beginComputePass(this.descriptor);
    if (!this.started) {
      pass.setPipeline(this.first);
      pass.setBindGroup(0, this.firstGroup);
      pass.dispatchWorkgroups(x, y);
      this.started = true;
    }
    pass.setPipeline(this.stage);
    for (let i = 0; i < count; i++) {
      this.prepare(this.ticks + i);
      for (let s = 0; s < this.m; s++) {
        pass.setBindGroup(0, this.bound(this.pair * 2, this.current));
        pass.dispatchWorkgroups(x, y);
        pass.setBindGroup(0, this.bound(this.pair * 2 + 1, this.current));
        pass.dispatchWorkgroups(x, y);
        this.current = 1 - this.current;
      }
      // The tick's current and wetting record, so the deepest water and the drying clock see every tick, not only frames.
      pass.setPipeline(this.recorder);
      pass.setBindGroup(0, this.recordGroup(this.current, (this.ticks + i) % 2));
      pass.dispatchWorkgroups(x, y);
      pass.setPipeline(this.stage);
    }
    pass.end();
    this.ticks += count;
    if (this.shown && count > 0)
      encoder.copyTextureToTexture({ texture: this.records[this.ticks % 2] }, { texture: this.shown }, [
        this.width,
        this.height,
      ]);
    return count;
  }
  step(encoder: GPUCommandEncoder): void {
    this.record(encoder);
  }
  async settle(): Promise<void> {
    while (!this.disposed && (!this.started || this.flood.owedTicks(this.ticks) > 0)) {
      const encoder = this.device.createCommandEncoder();
      this.record(encoder);
      this.device.queue.submit([encoder.finish()]);
    }
    await this.device.queue.onSubmittedWorkDone();
  }
  async read(o: FloodOptions): Promise<FloodReading> {
    const { device, width, height } = this,
      row = Math.ceil((width * 16) / 256) * 256,
      size = row * height,
      silty = !!this.soil && this.ticks > 0,
      buffer = device.createBuffer({
        size: size * (silty ? 3 : 2),
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      }),
      encoder = device.createCommandEncoder(),
      steps = this.steps;
    try {
      encoder.copyTextureToBuffer({ texture: this.states[this.current] }, { buffer, bytesPerRow: row }, [
        width,
        height,
      ]);
      encoder.copyTextureToBuffer({ texture: this.fluxes[this.current] }, { buffer, offset: size, bytesPerRow: row }, [
        width,
        height,
      ]);
      if (silty)
        encoder.copyTextureToBuffer(
          { texture: this.records[this.ticks % 2] },
          { buffer, offset: size * 2, bytesPerRow: row },
          [width, height],
        );
      device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(buffer.getMappedRange().slice(0)),
        cells = width * height,
        depth = new Float32Array(cells),
        bed = new Float32Array(cells),
        velocity = new Float32Array(cells * 2),
        foam = new Float32Array(cells),
        breaker = new Float32Array(cells),
        sediment = new Float32Array(cells),
        [dx, dz] = this.cell,
        maxDepth = o.maxDepth ?? 20,
        maxSpeed = o.maxSpeed ?? 15;
      let volume = 0,
        load = 0,
        foamy = 0,
        wet = 0,
        deepest = 0,
        fastest = 0,
        courant = 0,
        capped = 0;
      for (let j = 0; j < height; j++)
        for (let i = 0; i < width; i++) {
          const k = j * width + i,
            s = (j * row) / 4 + i * 4,
            m = (size + j * row) / 4 + i * 4,
            h = data[s];
          depth[k] = h;
          bed[k] = data[s + 1];
          foam[k] = data[s + 2];
          breaker[k] = data[s + 3];
          if (silty) {
            const c = data[(size * 2 + j * row) / 4 + i * 4 + 3];
            sediment[k] = c;
            load += c * h;
          }
          if (data[s + 2] > 0.05) foamy++;
          volume += h;
          if (h > deepest) deepest = h;
          if (h > DRY) {
            const u = data[m + 1] / h,
              v = data[m + 3] / h,
              speed = Math.hypot(u, v);
            velocity[k * 2] = u;
            velocity[k * 2 + 1] = v;
            courant = Math.max(
              courant,
              ((Math.abs(u) + Math.sqrt(G * h)) * this.dt) / dx,
              ((Math.abs(v) + Math.sqrt(G * h)) * this.dt) / dz,
            );
            if (h > 1e-3) {
              wet++;
              if (speed > fastest) fastest = speed;
            }
            if (h > maxDepth || speed > maxSpeed) capped++;
          }
        }
      return {
        time: steps * this.dt,
        steps,
        ticks: this.ticks,
        volume: volume * dx * dz,
        wetArea: wet * dx * dz,
        maxDepth: deepest,
        maxSpeed: fastest,
        courant,
        capped,
        width,
        height,
        depth,
        bed,
        velocity,
        foam,
        breaker,
        foamArea: foamy * dx * dz,
        sediment,
        sedimentMass: load * dx * dz,
      };
    } finally {
      buffer.destroy();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const object of this.owned) object.destroy();
    this.owned.length = 0;
  }
}
