/// <reference lib="esnext.disposable" preserve="true" />
// Ships riding the sea: a Floater that rides any water height query (pitch and roll from the surface, no forces), and
// ShipWakes, a Water surface effect drawing each ship's Kelvin wake, bow wave, waterline and turbulent foam and the
// glints of lamps on a night sea, on the ocean Water and on a Flood's surface alike. ShipSplash drives a particle
// emitter (a `VFX` of @margoengine/vfx fits) with bow spray and slam bursts. Sinking stays a Blender bake.
//
// Sources (clean room, from the papers):
// - Kelvin wake by stationary phase: Lord Kelvin, "On ship waves", Proc. Inst. Mech. Eng. 38 (1887); Lighthill, Waves
//   in Fluids (Cambridge 1978), section 3.10. A wave of direction theta to the track is steady in the ship's frame when
//   U cos(theta) = sqrt(g / k), so k = k_g sec^2(theta) with k_g = g / U^2; with x measured aft and y to the side,
//   the phase k_g x sec(theta) (1 - tan(theta) y / x) is stationary where y / x = T / (1 + 2 T^2), T = tan(theta).
//   This has two roots (transverse and diverging)
//   inside the cusp y / x = 1 / sqrt(8), the Kelvin half-angle 19.47 degrees, and none outside.
// - The hull as a filter of wavenumbers: Rabaud and Moisy, "Ship wakes: Kelvin or Mach angle?", Phys. Rev. Lett. 110,
//   214503 (2013), https://doi.org/10.1103/PhysRevLett.110.214503 (arXiv:1304.2653): a hull of length L excites no
//   wavenumber below k_L = 2 pi / L, so above Fr = U / sqrt(g L) = sqrt(3 / (4 pi)) the brightest ray is at
//   alpha = atan(sqrt(2 pi Fr^2 - 1) / (4 pi Fr^2 - 1)), about 1 / (2 sqrt(2 pi) Fr). Darmon, Benzaquen and Raphael,
//   "Kelvin wake pattern at large Froude numbers", J. Fluid Mech. 738, R3 (2014), https://doi.org/10.1017/jfm.2013.607:
//   it is the angle of maximum amplitude that narrows, the outer edge stays at Kelvin's.
// - Depth of the disturbance: Havelock, "The wave resistance of a spheroid", Proc. R. Soc. A 131 (1931): a source at
//   depth d sends a wave of wavenumber k with amplitude in exp(-k d), so short diverging waves near the track fade.
// - The cusp: the stationary-phase amplitude grows as (1 - 8 tan^2 alpha)^-1/4 and an Airy function smooths it over a
//   band of width (k_g r)^-2/3 (Ursell, "On Kelvin's ship-wave pattern", J. Fluid Mech. 8 (1960)).
// - Bow wave: Noblesse, Delhommeau, Guilbaud, Hendrix and Yang, "Simple analytical relations for ship bow waves",
//   J. Fluid Mech. 600 (2008), https://doi.org/10.1017/S0022112008000372: g Zb / U^2 = 2.2 (tan(aE) / cos(aE)) / (1 + F_D)
//   with F_D = U / sqrt(g D), the bow wave rising along a parabola z = tau (1 - tau / 2) in g / U^2 units, so its crest
//   is at tau_b = 1 - sqrt(1 - 2 z_b) behind the stem; it cannot pass the stagnation head U^2 / (2 g) (Bernoulli).
// - Wave particles and surface wavelets (Yuksel, House and Keyser, "Wave particles", ACM TOG 26(3) 2007,
//   https://doi.org/10.1145/1276377.1276501; Jeschke and Wojtan, "Water surface wavelets", ACM TOG 37(4) 2018,
//   https://doi.org/10.1145/3197517.3201336): an object's wake is the sum of waves it left along its past path. Here
//   the path is the ship's trail, so a turning ship's wake bends with it; each point of the sea reads the pattern in the
//   frame of the nearest point of the trail, emitted at that point's speed and faded by its age.
// - Ship motion periods: IMO Intact Stability Code (2008), roll period T = 2 C B / sqrt(GM), C = 0.373 + 0.023 B / d
//   - 0.043 L / 100; damping ratios from Lloyd, Seakeeping: Ship Behaviour in Rough Weather (1989).
// - Slamming: Ochi, "Prediction of occurrence and severity of ship slamming at sea", 5th Symp. Naval Hydrodynamics
//   (1964): a slam needs the bow to leave the water and re-enter faster than 0.093 sqrt(g L).
// - Lamp glints: Cox and Munk, "Measurement of the roughness of the sea surface from photographs of the sun's glitter",
//   J. Opt. Soc. Am. 44 (1954); GGX D (Walter et al. 2007); Schlick's Fresnel with F0 = 0.02.
// Margo's own choices are named where they are made: the bow ridge's shape past its crest, the foam widths and the
// splash rates.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import type { Water } from './index.js';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; STORAGE: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Vec3 = readonly [number, number, number];

const G = 9.81;
/** Kelvin's half-angle, atan(1 / sqrt(8)) = 19.47 degrees, in radians. */
export const KELVIN_ANGLE = Math.atan(1 / Math.sqrt(8));
/** The hull Froude number above which the wake narrows, sqrt(3 / (4 pi)) = 0.4886 (Rabaud and Moisy 2013). */
export const KELVIN_MACH_FROUDE = Math.sqrt(3 / (4 * Math.PI));
/** Most ships at once in one {@link ShipWakes}. */
export const MAX_SHIPS = 8;
/** Most lamps at once in one {@link ShipWakes}, ships' and fixed ones together. */
export const MAX_LAMPS = 16;
/** Points of each ship's trail. */
export const TRAIL_POINTS = 64;

const finite = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw rangeError(`Invalid ship ${what}; pass a finite number in ${lo}..${hi}`, 'geometry');
  return v;
};
const vec3 = (v: unknown, what: string): [number, number, number] => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw typeError(`Ship ${what} must be three finite numbers`, 'geometry');
  return [v[0], v[1], v[2]];
};
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A hull's waterplane, metres; the origin of a ship is its waterline amidships. */
export interface Hull {
  /** Waterline length, 0.5..2000. */
  length: number;
  /** Waterline beam, 0.1..1000. */
  beam: number;
  /** Draft, 0.05..600 (an iceberg's keel). */
  draft: number;
  /** Half-angle of the waterline at the stem in degrees, 2..60 (a fine yacht 10, a cargo ship 20 to 30). Default 20. */
  entrance?: number;
}
function checkHull(h: Hull): Required<Hull> {
  if (!h || typeof h !== 'object') throw typeError('Ship hull must be { length, beam, draft }', 'geometry');
  return {
    length: finite(h.length, 0.5, 2000, 'hull length'),
    beam: finite(h.beam, 0.1, 1000, 'hull beam'),
    draft: finite(h.draft, 0.05, 600, 'hull draft'),
    entrance: finite(h.entrance ?? 20, 2, 60, 'hull entrance'),
  };
}

/** The hull Froude number U / sqrt(g L). */
export function hullFroude(speed: number, length: number): number {
  return speed / Math.sqrt(G * length);
}
/**
 * The angle of the brightest ray of the wake in radians for a hull Froude number (Rabaud and Moisy 2013, eq. 3): Kelvin's
 * 19.47 degrees up to Fr = 0.49, then atan(sqrt(2 pi Fr^2 - 1) / (4 pi Fr^2 - 1)), about 1 / (2 sqrt(2 pi) Fr).
 */
export function wakeAngle(froude: number): number {
  finite(froude, 0, 100, 'Froude number');
  if (froude <= KELVIN_MACH_FROUDE) return KELVIN_ANGLE;
  const f2 = 2 * Math.PI * froude * froude;
  return Math.atan(Math.sqrt(f2 - 1) / (2 * f2 - 1));
}
/**
 * The bow wave of a hull at a speed (Noblesse et al. 2008): its height `height` above the still sea in metres, g Zb / U^2
 * = 2.2 (tan aE / cos aE) / (1 + U / sqrt(g D)) and never over the stagnation head U^2 / (2 g), and the distance
 * `crest` from the stem back to its crest, tau_b U^2 / g with tau_b = 1 - sqrt(1 - 2 g Zb / U^2).
 */
export function bowWave(speed: number, hull: Hull): { height: number; crest: number } {
  const h = checkHull(hull);
  finite(speed, 0, 100, 'speed');
  if (speed === 0) return { height: 0, crest: 0 };
  const e = (h.entrance * Math.PI) / 180,
    head = (speed * speed) / G;
  const z = Math.min(0.5, (2.2 * (Math.tan(e) / Math.cos(e))) / (1 + speed / Math.sqrt(G * h.draft)));
  return { height: z * head, crest: (1 - Math.sqrt(1 - 2 * z)) * head };
}

// --- The wake law, in doubles here and in f32 in WAKE_WGSL below; the GPU check holds the two to the same numbers. ---
// One wave system from a source `x` metres ahead of the point along the track and `y` to its side, for a ship of speed
// u, length l, draft d: the sum of the transverse and diverging waves per unit amplitude.
function hullWeight(k: number, k0: number, kl: number, d: number): number {
  return smoothstep(0.85 * kl, kl, k) * Math.exp(-(k - k0) * d * 0.5);
}
function waveAt(x: number, y: number, u: number, l: number, d: number): number {
  if (x <= 0 || u <= 0.05) return 0;
  const kg = G / (u * u),
    kl = (2 * Math.PI) / l,
    k0 = Math.max(kg, kl);
  const ay = Math.abs(y),
    tau = ay / x,
    r = Math.hypot(x, ay);
  const eps = Math.pow(Math.max(kg * r, 1), -2 / 3);
  const spread = Math.sqrt(l / Math.max(r, l));
  const disc = 1 - 8 * tau * tau;
  const wave = (t: number) =>
    hullWeight(kg * (1 + t * t), k0, kl, d) * Math.cos(kg * x * Math.sqrt(1 + t * t) * (1 - tau * t));
  if (disc >= 0) {
    const q = Math.sqrt(disc),
      c = Math.pow(Math.max(disc, eps), -0.25);
    const transverse = wave((2 * tau) / (1 + q)),
      diverging = tau > 1e-6 ? wave((1 + q) / (4 * tau)) : 0;
    return c * spread * (transverse + diverging);
  }
  return 2 * Math.pow(eps, -0.25) * spread * wave(Math.SQRT1_2) * Math.exp(disc / eps);
}
/** The crest follows the bow shoulder. Its outboard phase sweeps aft as the near-field wave dies away. */
function ridge(s: number, outside: number, crest: number, beam: number): number {
  if (crest <= 0) return 0;
  // Resolve the pressure rise around the stem even when the nominal crest distance is sub-metre.
  const span = Math.max(crest, Math.min(0.75, 0.065 * beam));
  const width = Math.max(crest, Math.min(0.35 * beam, Math.sqrt(beam * span)));
  const off = Math.max(0, outside);
  if (off >= width) return 0;
  const sigma = 1 + (s - crest - (2 * off * off) / width) / span;
  // Rising along the stem's parabola to the crest, then Margo's falling shape into a shallow trough.
  const along =
    sigma < 0
      ? 0
      : sigma <= 1
        ? sigma * (2 - sigma)
        : Math.exp(-(sigma - 1) * (sigma - 1)) * Math.cos(1.2 * (sigma - 1));
  return along * (1 - smoothstep(0, width, off));
}
/** A compact lift and drawdown alongside the hull, per unit bow height. */
function sideWash(s: number, outside: number, crest: number, length: number, beam: number): number {
  const station = s / length;
  const fromCrest = (s - crest) / length;
  if (crest <= 0 || fromCrest <= 0.02 || station >= 0.97) return 0;
  const beamFraction = 0.17 + 0.13 * (1 - smoothstep(0.12, 0.64, crest));
  const width = Math.min(0.3 * beam, Math.max(beamFraction * beam, 2 * crest));
  const q = Math.max(0, outside) / width;
  if (q >= 1) return 0;
  // The section's positive shoulder and negative drawdown have equal area over q = 0..1.
  const section = (1 - q) * (1 - q) * (1 - 4 * q);
  return 0.45 * smoothstep(0.02, 0.14, fromCrest) * (1 - smoothstep(0.22, 0.97, station)) * section;
}
/** Signed distance from the waterline of a hull (positive outside), s behind the stem and y to the side. */
function hullDistance(s: number, y: number, l: number, b: number, tanE: number): number {
  const half = b / 2,
    ay = Math.abs(y);
  if (s < 0) return Math.hypot(s, ay);
  if (s > l) return Math.hypot(s - l, Math.max(ay - half, 0));
  const reach = Math.min(1, (s * tanE) / b);
  return ay - half * reach * (2 - reach);
}

/** Wake settings every ship of a {@link ShipWakes} shares; all are read every frame (rows in `SHIP_SETTINGS`). */
export interface ShipWakeLook {
  /** Kelvin wave height multiplier, 0..5. Default 1. */
  wakeHeight: number;
  /** Stern wave system's height against the bow's, 0..1 (opposite in sign). Default 0.5. */
  sternWaves: number;
  /** Seconds a wave left on the trail takes to fade to 1 / e, 1..3,600. Default 120. */
  wakeLife: number;
  /** Bow wave height multiplier, 0..3. Default 1. */
  bowWave: number;
  /** Width of the foam band along the waterline at Fr 0.5, metres, 0..10. Default 0.8. */
  waterlineFoam: number;
  /** Seconds the turbulent wake's foam takes to fade to 1 / e, 1..600. Default 40. */
  foamLife: number;
  /** Strength of the turbulent (propeller) wake's foam, 0..3. Default 1. */
  turbulentWake: number;
  /** Roughness of lamp glints, 0.02..1; null follows the Water's glitter, which follows the wind. Default null. */
  lampRoughness: number | null;
  /** Multiplier of every lamp's intensity, 0..100. Default 1. */
  lampIntensity: number;
}
/** The look a ShipWakes starts with: the defaults of the rows in `SHIP_SETTINGS`. */
export const SHIP_LOOK_DEFAULTS: Readonly<ShipWakeLook> = Object.freeze({
  wakeHeight: 1,
  sternWaves: 0.5,
  wakeLife: 120,
  bowWave: 1,
  waterlineFoam: 0.8,
  foamLife: 40,
  turbulentWake: 1,
  lampRoughness: null,
  lampIntensity: 1,
});
const LOOK_RANGES: Record<keyof ShipWakeLook, [number, number]> = {
  wakeHeight: [0, 5],
  sternWaves: [0, 1],
  wakeLife: [1, 3600],
  bowWave: [0, 3],
  waterlineFoam: [0, 10],
  foamLife: [1, 600],
  turbulentWake: [0, 3],
  lampRoughness: [0.02, 1],
  lampIntensity: [0, 100],
};

/** A light on a ship or on the shore whose glints the sea shows. */
export interface ShipLamp {
  /** On a ship: metres to port (+X), up and forward of the ship's origin, the frame of `Floater.matrix`. Fixed: the world position. */
  position: Vec3;
  /** Linear RGB, each 0..1. Default warm [1, 0.78, 0.5]. */
  color?: Vec3;
  /** Luminous intensity in candela-like units (W/sr), 0..1e6; a mast-head lamp is about 50. Default 50. */
  intensity?: number;
}
/** Where a ship is, which way it heads and how fast. */
export interface ShipPose {
  /** World position of the waterline amidships. */
  position: Vec3;
  /** Compass heading in degrees of travel: 0 is +Z, 90 is +X (as Water's windDirection). */
  heading: number;
  /** Speed through the water, 0..100 m/s. */
  speed: number;
  /** Bow-up pitch in radians, for the lamps; default 0. */
  pitch?: number;
  /** Starboard-down roll in radians, for the lamps; default 0. */
  roll?: number;
}
/** One ship of a {@link ShipWakes}. */
export interface ShipOptions {
  hull: Hull;
  /**
   * The ship's track over the wake clock: world [x, z] at a time in seconds. With a path the trail is read from it
   * every frame, so a seek draws the same wake as playing to that time. Without one, `setPose` places the ship and the
   * trail is what it left behind since.
   */
  path?: (time: number) => readonly [number, number];
  /** Starting pose when there is no path. Default at the origin, heading 0, stopped. */
  pose?: ShipPose;
  /** Up to 16 lamps on the ship. */
  lamps?: readonly ShipLamp[];
  /** Height multiplier of this ship's wake and bow wave, 0..5. Default 1. */
  wake?: number;
  /**
   * Linear RGB of discoloured water in this ship's turbulent stern trail, 0..1 per channel. Default null. An art override:
   * for water discoloured by what the ship leaks, release it as a tracer (`TracerSolver` of `@margoengine/physics/tracers`).
   * @deprecated as the source of discoloured water; kept as an override of the trail's look.
   */
  wakeTint?: Vec3 | null;
}
/** Settings of {@link ShipWakes}. */
export interface ShipWakesOptions {
  /** Live Water attached to the same engine: the open sea, or the Water a Flood runs on. */
  surface: Water;
  /** Up to 8 ships. */
  ships?: readonly ShipOptions[];
  /** Fixed lamps (a harbour, a lighthouse) in world positions; ships' lamps and these together up to 16. */
  lamps?: readonly ShipLamp[];
  /** Length of each trail behind the bow, in hull lengths, 2..200. Default 30. */
  trail?: number;
  /** The look; read every frame. */
  look?: Partial<ShipWakeLook>;
}
/** What the wake adds to the sea at a point: the height in metres and the foam 0..1. */
export interface ShipWakeSample {
  height: number;
  foam: number;
}

interface TrailPoint {
  x: number;
  z: number;
  sternX: number;
  sternZ: number;
  t: number;
  u: number;
}

/** A ship of a {@link ShipWakes}. */
export class WakeShip {
  readonly hull: Readonly<Required<Hull>>;
  readonly path?: (time: number) => readonly [number, number];
  lamps: readonly ShipLamp[];
  /** Wake height multiplier, 0..5; read every frame. */
  wake: number;
  private tint: Vec3 | null = null;
  private state: Required<ShipPose>;
  /** Recorded trail, newest first (bow positions). */
  private recorded: TrailPoint[] = [];
  /** @internal */
  constructor(options: ShipOptions) {
    if (!options || typeof options !== 'object') throw typeError('Each ship needs options { hull }', 'geometry');
    this.hull = Object.freeze(checkHull(options.hull));
    if (options.path !== undefined && typeof options.path !== 'function')
      throw typeError('Ship path must be a function (time) => [x, z]', 'geometry');
    this.path = options.path;
    this.lamps = checkLamps(options.lamps ?? [], 'ship lamps');
    this.wake = finite(options.wake ?? 1, 0, 5, 'wake');
    this.wakeTint = options.wakeTint ?? null;
    this.state = { position: [0, 0, 0], heading: 0, speed: 0, pitch: 0, roll: 0 };
    if (options.pose) this.setPose(options.pose);
  }
  /** The ship's pose as last set or read from its path. */
  get pose(): Readonly<Required<ShipPose>> {
    return this.state;
  }
  /** Linear RGB of the turbulent water, or null for the default clear trail. Read each frame, including paused frames. */
  get wakeTint(): Vec3 | null {
    return this.tint;
  }
  set wakeTint(value: Vec3 | null) {
    if (value === null) this.tint = null;
    else {
      const [r, g, b] = vec3(value, 'wake tint');
      this.tint = Object.freeze([
        finite(r, 0, 1, 'wake tint red'),
        finite(g, 0, 1, 'wake tint green'),
        finite(b, 0, 1, 'wake tint blue'),
      ]);
    }
  }
  /** Places the ship (no path): the trail keeps what it passed through. */
  setPose(pose: ShipPose): this {
    if (!pose || typeof pose !== 'object')
      throw typeError('Ship pose must be { position, heading, speed }', 'geometry');
    this.state = {
      position: vec3(pose.position, 'position'),
      heading: finite(pose.heading, -1e6, 1e6, 'heading'),
      speed: finite(pose.speed, 0, 100, 'speed'),
      pitch: finite(pose.pitch ?? 0, -Math.PI, Math.PI, 'pitch'),
      roll: finite(pose.roll ?? 0, -Math.PI, Math.PI, 'roll'),
    };
    return this;
  }
  /** Takes the pose of a {@link Floater} (position, heading, pitch, roll) at a speed. */
  follow(floater: Floater, speed: number): this {
    return this.setPose({
      position: floater.position,
      heading: floater.heading,
      speed,
      pitch: floater.pitch,
      roll: floater.roll,
    });
  }
  /** Forgets the recorded trail (a cut or a seek without a path). */
  clearTrail(): this {
    this.recorded = [];
    return this;
  }
  /**
   * Forgets the recorded trail and puts the pose back to a fresh ship's (at the origin, still): what
   * {@link ShipWakes.resetTime} does to each ship. A ship with a path takes its pose from it at the next build, one
   * without from the next `setPose` or `follow` (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.recorded = [];
    this.state = { position: [0, 0, 0], heading: 0, speed: 0, pitch: 0, roll: 0 };
  }
  /** @internal The trail at `time`, newest (the bow now) first, at most TRAIL_POINTS points over `span` metres. */
  trail(time: number, span: number): TrailPoint[] {
    const l = this.hull.length;
    if (this.path) {
      const at = (t: number) => {
        const p = this.path!(t);
        if (!Array.isArray(p) || p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
          throw typeError('Ship path must return a finite [x, z]', 'geometry');
        return p;
      };
      const h = 1 / 30,
        a = at(time - h),
        b = at(time + h);
      const vx = (b[0] - a[0]) / (2 * h),
        vz = (b[1] - a[1]) / (2 * h),
        u = Math.hypot(vx, vz),
        here = at(time);
      const heading = u > 1e-6 ? (Math.atan2(vx, vz) * 180) / Math.PI : this.state.heading;
      this.state = {
        ...this.state,
        position: [here[0], this.state.position[1], here[1]],
        heading,
        speed: Math.min(100, u),
      };
      // Equal time steps back over the span at the present speed; a stopped ship has no trail.
      const out: TrailPoint[] = [];
      const step = u > 0.05 ? span / u / (TRAIL_POINTS - 1) : 0;
      // Retain the direction through stationary samples so the hull does not rotate at the berth.
      let direction = heading;
      for (let i = 0; i < TRAIL_POINTS && (i === 0 || step > 0); i++) {
        const t = time - i * step,
          p = i === 0 ? here : at(t),
          q = at(t - h),
          r = at(t + h);
        const speed = Math.hypot(r[0] - q[0], r[1] - q[1]) / (2 * h);
        if (speed > 1e-6) direction = (Math.atan2(r[0] - q[0], r[1] - q[1]) * 180) / Math.PI;
        const f = this.forward(direction);
        const dx = (f[0] * l) / 2;
        const dz = (f[1] * l) / 2;
        out.push({ x: p[0] + dx, z: p[1] + dz, sternX: p[0] - dx, sternZ: p[1] - dz, t, u: Math.min(100, speed) });
      }
      return out;
    }
    const f = this.forward(this.state.heading),
      p = this.state.position;
    const dx = (f[0] * l) / 2;
    const dz = (f[1] * l) / 2;
    const bow: TrailPoint = {
      x: p[0] + dx,
      z: p[2] + dz,
      sternX: p[0] - dx,
      sternZ: p[2] - dz,
      t: time,
      u: this.state.speed,
    };
    const last = this.recorded[0];
    if (last && time < last.t) this.recorded = [];
    const spacing = span / (TRAIL_POINTS - 1);
    if (!this.recorded.length || Math.hypot(bow.x - this.recorded[0].x, bow.z - this.recorded[0].z) >= spacing)
      this.recorded.unshift(bow);
    // The bow now, then the recorded points (newest first) out to the span; the rest are forgotten.
    let s = 0,
      used = 0;
    const kept: TrailPoint[] = [bow];
    for (const q of this.recorded) {
      if (kept.length >= TRAIL_POINTS || s > span) break;
      used++;
      const prev = kept[kept.length - 1],
        d = Math.hypot(q.x - prev.x, q.z - prev.z);
      if (d < 1e-9) continue;
      s += d;
      kept.push(q);
    }
    this.recorded.length = used;
    return kept;
  }
  /** @internal */
  forward(heading: number): [number, number] {
    const a = (heading * Math.PI) / 180;
    return [Math.sin(a), Math.cos(a)];
  }
}
function checkLamps(lamps: readonly ShipLamp[], what: string): readonly ShipLamp[] {
  if (!Array.isArray(lamps) || lamps.length > MAX_LAMPS)
    throw rangeError(`Invalid ${what}; pass up to ${MAX_LAMPS}`, 'geometry');
  return Object.freeze(
    lamps.map((l) =>
      Object.freeze({
        position: vec3(l?.position, 'lamp position'),
        color: vec3(l.color ?? [1, 0.78, 0.5], 'lamp color').map((c) =>
          finite(c, 0, 1, 'lamp color'),
        ) as unknown as Vec3,
        intensity: finite(l.intensity ?? 50, 0, 1e6, 'lamp intensity'),
      }),
    ),
  );
}

// Uniform: head (ships, lamps, roughness, 0), look (wake height, stern waves, wake life, bow wave), foam (waterline foam,
// foam life, turbulent wake, lamp intensity), then 8 ships of 5 vec4 and 16 lamps of 2 vec4.
const SHIP_FLOATS = 20,
  UNIFORM_FLOATS = 12 + MAX_SHIPS * SHIP_FLOATS + MAX_LAMPS * 8;
const TRAIL_FLOATS = MAX_SHIPS * TRAIL_POINTS * 8;

/** WGSL of the wake law; the same numbers as the TypeScript above, which the GPU check compares. */
const WAKE_WGSL = /* wgsl */ `
struct ShipRecord {a:vec4f,b:vec4f,c:vec4f,d:vec4f,tint:vec4f}
struct ShipData {head:vec4f,look:vec4f,foam:vec4f,ships:array<ShipRecord,${MAX_SHIPS}>,lamps:array<vec4f,${MAX_LAMPS * 2}>}
struct ShipSurface {height:f32,foam:f32,tint:vec4f}
fn shipSmooth(a:f32,b:f32,x:f32)->f32 {return smoothstep(a,b,x);}
fn shipHullWeight(k:f32,k0:f32,kl:f32,d:f32)->f32 {return shipSmooth(0.85*kl,kl,k)*exp(-(k-k0)*d*0.5);}
fn shipWaveTerm(t:f32,kg:f32,k0:f32,kl:f32,d:f32,x:f32,tau:f32)->f32 {
 return shipHullWeight(kg*(1.0+t*t),k0,kl,d)*cos(kg*x*sqrt(1.0+t*t)*(1.0-tau*t));
}
fn shipWaveAt(x:f32,y:f32,u:f32,l:f32,d:f32)->f32 {
 if(x<=0.0||u<=0.05){return 0.0;}
 let kg=9.81/(u*u);let kl=6.28318531/l;let k0=max(kg,kl);
 let ay=abs(y);let tau=ay/x;let r=length(vec2f(x,ay));
 let eps=pow(max(kg*r,1.0),-0.66666667);let spread=sqrt(l/max(r,l));let disc=1.0-8.0*tau*tau;
 if(disc>=0.0){
  let q=sqrt(disc);let c=pow(max(disc,eps),-0.25);
  var diverging=0.0;if(tau>1e-6){diverging=shipWaveTerm((1.0+q)/(4.0*tau),kg,k0,kl,d,x,tau);}
  return c*spread*(shipWaveTerm(2.0*tau/(1.0+q),kg,k0,kl,d,x,tau)+diverging);
 }
 return 2.0*pow(eps,-0.25)*spread*shipWaveTerm(0.70710678,kg,k0,kl,d,x,tau)*exp(disc/eps);
}
fn shipRidge(s:f32,outside:f32,crest:f32,beam:f32)->f32 {
 if(crest<=0.0){return 0.0;}
 let span=max(crest,min(0.75,0.065*beam));
 let width=max(crest,min(0.35*beam,sqrt(beam*span)));let off=max(0.0,outside);
 if(off>=width){return 0.0;}
 let sigma=1.0+(s-crest-2.0*off*off/width)/span;var along=0.0;
 if(sigma>=0.0&&sigma<=1.0){along=sigma*(2.0-sigma);}else if(sigma>1.0){along=exp(-(sigma-1.0)*(sigma-1.0))*cos(1.2*(sigma-1.0));}
 return along*(1.0-shipSmooth(0.0,width,off));
}
fn shipSideWash(s:f32,outside:f32,crest:f32,l:f32,b:f32)->f32 {
 let station=s/l;let fromCrest=(s-crest)/l;
 if(crest<=0.0||fromCrest<=0.02||station>=0.97){return 0.0;}
 let beamFraction=0.17+0.13*(1.0-shipSmooth(0.12,0.64,crest));
 let width=min(0.3*b,max(beamFraction*b,2.0*crest));let q=max(0.0,outside)/width;
 if(q>=1.0){return 0.0;}
 let section=(1.0-q)*(1.0-q)*(1.0-4.0*q);
 return 0.45*shipSmooth(0.02,0.14,fromCrest)*(1.0-shipSmooth(0.22,0.97,station))*section;
}
fn shipHullDistance(s:f32,y:f32,l:f32,b:f32,tanE:f32)->f32 {
 let half=b*0.5;let ay=abs(y);
 if(s<0.0){return length(vec2f(s,ay));}
 if(s>l){return length(vec2f(s-l,max(ay-half,0.0)));}
 let reach=min(1.0,s*tanE/b);return ay-half*reach*(2.0-reach);
}
// Project onto the bow track for Kelvin waves, or the stern track for newly churned water.
fn shipStation(index:u32,stern:bool)->vec3f {
 return select(shipTrail[index*2u].xyz,shipTrail[index*2u+1u].yzw,stern);
}
fn shipLocal(i:u32,p:vec2f,stern:bool)->vec4f {
 let ship=shipData.ships[i];let first=u32(ship.d.x);let count=u32(ship.d.y);let f=ship.a.zw;
 let rel=p-shipStation(first,stern).xy;
 let current=vec4f(-dot(rel,f),f.y*rel.x-f.x*rel.y,ship.b.x,0.0);
 let noTrack=vec4f(1e30,0.0,0.0,0.0);
 if(count<2u){return select(current,noTrack,stern);}
 var best=1e30;var out=noTrack;
 for(var j=0u;j+1u<count;j++){
  let a=shipStation(first+j,stern);let b=shipStation(first+j+1u,stern);
  let d=b.xy-a.xy;let w=p-a.xy;let len2=dot(d,d);
  if(stern&&len2<1e-9){continue;}
  let along=dot(w,d)/max(len2,1e-9);let t=clamp(along,0.0,1.0);
  let e=w-d*t;let dist2=dot(e,e);
  if(dist2<best){
   best=dist2;let side=select(-1.0,1.0,d.x*w.y-d.y*w.x<0.0);
   let ua=shipTrail[(first+j)*2u+1u].x;let ub=shipTrail[(first+j+1u)*2u+1u].x;
   let aa=shipTrail[(first+j)*2u].w;let ab=shipTrail[(first+j+1u)*2u].w;
   out=vec4f(mix(a.z,b.z,t),side*sqrt(dist2),mix(ua,ub,t),mix(aa,ab,t));
   if(j==0u&&along<=0.0){out=current;}
   if(stern&&along>1.0&&j+2u==count){out=noTrack;}
  }
 }
 return out;
}
// The strongest tinted turbulent trail supplies the colour. The foam mask and height keep their existing values.
fn shipWake(p:vec2f,sampleFoam:bool)->ShipSurface {
 var height=0.0;var foam=0.0;var tint=vec4f(0);
 for(var i=0u;i<u32(shipData.head.x);i++){
  let ship=shipData.ships[i];let local=shipLocal(i,p,false);
  let l=ship.b.y;let b=ship.b.z;let d=ship.b.w;let span=ship.d.z;
  if(local.x>span){continue;}
  let s=local.x;let y=local.y;let u=local.z;let age=local.w;
  let fade=(1.0-shipSmooth(0.8*span,span,s))*exp(-age/shipData.look.z);
  let rel=p-ship.a.xy;let f=ship.a.zw;
  let bowS=-dot(rel,f);let bowY=f.y*rel.x-f.x*rel.y;
  let hull=shipHullDistance(bowS,bowY,l,b,ship.c.z);let mask=shipSmooth(-0.25*b,0.0,hull);
  let a0=0.25*ship.c.x*ship.c.w*shipData.look.x;
  let waves=a0*(shipWaveAt(s,y,u,l,d)-shipData.look.y*shipWaveAt(s-l,y,u,l,d))*fade;
  let crestRidge=shipRidge(bowS,hull,ship.c.y,b);
  let side=shipSideWash(bowS,hull,ship.c.y,l,b);
  let nearHull=ship.c.x*ship.c.w*shipData.look.w*(crestRidge+side);
  height+=(waves+nearHull)*mask;
  if(!sampleFoam){continue;}
  let speed=ship.b.x;let fr=speed/sqrt(9.81*l);
  let band=shipData.foam.x*(0.5+min(fr,1.0));
  var wl=0.0;if(band>0.0&&bowS<=l+band){wl=(1.0-shipSmooth(0.0,band,hull))*shipSmooth(-0.1*b,0.0,hull)*shipSmooth(0.3,2.0,speed);}
  var turbulent=0.0;
  if(shipData.foam.z>0.0){
   let stern=shipLocal(i,p,true);
   if(stern.x>=0.0&&stern.x<span){
    let half=b*0.5*(1.0+0.6*sqrt(stern.x/l));
    turbulent=shipData.foam.z*exp(-stern.w/shipData.foam.y)*(1.0-shipSmooth(0.5*half,half,abs(stern.y)))
      *shipSmooth(0.5,2.2,stern.z)*(1.0-shipSmooth(0.8*span,span,stern.x));
   }
  }
  let tintStrength=turbulent*ship.tint.w;
  if(tintStrength>tint.w){tint=vec4f(ship.tint.rgb,tintStrength);}
  var breaking=0.0;if(speed>0.05){breaking=shipSmooth(0.3,0.48,9.81*ship.c.x/(speed*speed))*shipSmooth(0.5,2.0,speed)*max(crestRidge,0.0)*mask*min(shipData.look.w,1.0);}
  foam=max(foam,max(max(wl,turbulent),breaking));
 }
 return ShipSurface(height,clamp(foam,0.0,1.0),vec4f(tint.rgb,clamp(tint.w,0.0,1.0)));
}
// Lamp glints: GGX reflection of each point lamp off the sea's normal n, seen along v, at roughness rough.
fn shipLamps(world:vec3f,n:vec3f,v:vec3f,waterRough:f32)->vec3f {
 var rough=waterRough;if(shipData.head.z>0.0){rough=shipData.head.z;}
 let a2=max(rough*rough,1e-4);var sum=vec3f(0);
 for(var i=0u;i<u32(shipData.head.y);i++){
  let lamp=shipData.lamps[i*2u];let color=shipData.lamps[i*2u+1u].rgb;
  let toLamp=lamp.xyz-world;let dist2=max(dot(toLamp,toLamp),0.01);let l=toLamp*inverseSqrt(dist2);
  let nl=dot(n,l);if(nl<=0.0){continue;}
  let h=normalize(l+v);let nh=max(dot(n,h),0.0);let q=nh*nh*(a2-1.0)+1.0;let dd=a2/(3.14159265*q*q);
  let fresnel=0.02+0.98*pow(1.0-max(dot(v,h),0.0),5.0);
  sum+=color*lamp.w*shipData.foam.w*dd*fresnel/(4.0*max(dot(n,v),0.05)*dist2)*nl;
 }
 return sum;
}
`;

/**
 * Ships' wakes on a Water: the Kelvin wake (bow and stern wave systems, narrowing with the hull Froude number as Rabaud
 * and Moisy measured), the bow wave of Noblesse et al., foam along the waterline, in the turbulent wake and where the bow
 * wave breaks, and the glints of ships' and shore lamps on the sea. The wake moves the surface the Water draws and that
 * `WaveQuery` reads, so a Floater rides the wakes of other ships; on a Water a Flood runs on, it rides on the flood.
 */
export class ShipWakes implements EnginePlugin {
  readonly name = 'water:ships-' + sequence++;
  readonly surface: Water;
  readonly ships: WakeShip[] = [];
  /** The look, read every frame (see {@link ShipWakeLook}). */
  readonly look: ShipWakeLook;
  /** Trail length in hull lengths. */
  readonly trailLengths: number;
  lamps: readonly ShipLamp[];
  private seconds = 0;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private trailBuffer?: GPUBuffer;
  private resources: GPUBindingResource[] = [];
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;
  private readonly values = new Float32Array(UNIFORM_FLOATS);
  private readonly trails = new Float32Array(TRAIL_FLOATS);
  private builtAt = NaN;

  constructor(options: ShipWakesOptions) {
    if (!options?.surface || typeof options.surface.onDispose !== 'function')
      throw fault('state', 'ShipWakes need a Water surface; pass options.surface');
    this.surface = options.surface;
    this.trailLengths = finite(options.trail ?? 30, 2, 200, 'trail');
    this.look = { ...SHIP_LOOK_DEFAULTS };
    this.setLook(options.look ?? {});
    this.lamps = checkLamps(options.lamps ?? [], 'fixed lamps');
    for (const ship of options.ships ?? []) this.add(ship);
  }
  /** Same as `engine.use(new ShipWakes(options))`; attach after the Water. */
  static attach(engine: EngineKernel, options: ShipWakesOptions): ShipWakes {
    const wakes = new ShipWakes(options);
    engineRuntime(engine).use(wakes);
    return wakes;
  }
  /** Adds a ship; returns it. */
  add(options: ShipOptions): WakeShip {
    this.live();
    if (this.ships.length >= MAX_SHIPS) throw rangeError(`ShipWakes holds up to ${MAX_SHIPS} ships`, 'geometry');
    const ship = new WakeShip(options);
    this.ships.push(ship);
    this.builtAt = NaN;
    return ship;
  }
  /** Removes a ship; true when it was there. */
  delete(ship: WakeShip): boolean {
    const i = this.ships.indexOf(ship);
    if (i < 0) return false;
    this.ships.splice(i, 1);
    this.builtAt = NaN;
    return true;
  }
  /** Changes look values (a name left out keeps its value). */
  setLook(look: Partial<ShipWakeLook>): this {
    for (const [key, value] of Object.entries(look)) {
      const range = LOOK_RANGES[key as keyof ShipWakeLook];
      if (!range) throw typeError(`Unknown ship look ${key}; use a name of SHIP_LOOK_DEFAULTS`, 'geometry');
      if (key === 'lampRoughness' && value === null) this.look.lampRoughness = null;
      else (this.look as unknown as Record<string, number>)[key] = finite(value, range[0], range[1], key);
    }
    this.builtAt = NaN;
    return this;
  }
  /** Seconds on the wake clock (frame deltas and `setTime`). */
  get time(): number {
    return this.seconds;
  }
  /** Seeks the wake clock; ships with a path draw the wake they have at that time. */
  setTime(seconds: number): this {
    this.seconds = finite(seconds, -1e9, 1e9, 'time');
    this.builtAt = NaN;
    return this;
  }
  /**
   * Puts the wake clock back to 0, forgets every ship's recorded trail and pose and clears the built wakes, as fresh wakes have them, so a later
   * `seek` (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh world seeked
   * there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.seconds = 0;
    this.builtAt = NaN;
    this.trails.fill(0);
    this.values.fill(0);
    for (const ship of this.ships) ship.resetTime();
  }
  /**
   * Moves the wake clock by `delta` seconds, the CPU part of the frame update: a film seek (`@margoengine/cutscene`
   * `seek`) replays it, so a seek lands on the wakes a played film shows.
   */
  advanceTime(delta: number): void {
    if (delta > 0 && Number.isFinite(delta)) {
      this.seconds += delta;
      this.builtAt = NaN;
    }
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /** Fills the uniform and the trails for the current clock (the frame does it; call it to read `sample` between frames). */
  build(): void {
    this.live();
    if (this.builtAt === this.seconds) return;
    const v = this.values,
      look = this.look;
    v.fill(0);
    this.trails.fill(0);
    const lamps: { p: Vec3; c: Vec3; i: number }[] = [];
    this.ships.forEach((ship, i) => {
      const h = ship.hull,
        span = this.trailLengths * h.length;
      const trail = ship.trail(this.seconds, span);
      const pose = ship.pose,
        f = ship.forward(pose.heading),
        bw = bowWave(pose.speed, h),
        o = 12 + i * SHIP_FLOATS;
      v.set([trail[0].x, trail[0].z, f[0], f[1]], o);
      v.set([pose.speed, h.length, h.beam, h.draft], o + 4);
      v.set([bw.height, bw.crest, Math.tan((h.entrance * Math.PI) / 180), ship.wake], o + 8);
      v.set([i * TRAIL_POINTS, trail.length, span, 0], o + 12);
      let s = 0;
      let sternDistance = 0;
      trail.forEach((p, j) => {
        if (j) {
          const previous = trail[j - 1];
          s += Math.hypot(p.x - previous.x, p.z - previous.z);
          sternDistance += Math.hypot(p.sternX - previous.sternX, p.sternZ - previous.sternZ);
        }
        this.trails.set(
          [p.x, p.z, s, Math.max(0, this.seconds - p.t), p.u, p.sternX, p.sternZ, sternDistance],
          (i * TRAIL_POINTS + j) * 8,
        );
      });
      // Lamps ride the ship: port, up and forward rotated by the heading, pitch and roll.
      const cp = Math.cos(pose.pitch),
        sp = Math.sin(pose.pitch),
        cr = Math.cos(pose.roll),
        sr = Math.sin(pose.roll);
      for (const lamp of ship.lamps) {
        const [rx, ry, rz] = lamp.position;
        // Roll about the forward axis (port up), then pitch about the side axis (bow up).
        const y1 = ry * cr + rx * sr,
          x1 = rx * cr - ry * sr;
        const z2 = rz * cp - y1 * sp,
          y2 = y1 * cp + rz * sp;
        lamps.push({
          p: [
            pose.position[0] + x1 * f[1] + z2 * f[0],
            pose.position[1] + y2,
            pose.position[2] - x1 * f[0] + z2 * f[1],
          ],
          c: lamp.color!,
          i: lamp.intensity!,
        });
      }
    });
    for (const l of this.lamps) lamps.push({ p: l.position, c: l.color!, i: l.intensity! });
    if (lamps.length > MAX_LAMPS)
      throw rangeError(`ShipWakes draws up to ${MAX_LAMPS} lamps, ships' and fixed ones together`, 'geometry');
    v.set([this.ships.length, lamps.length, look.lampRoughness ?? -1, 0], 0);
    v.set([look.wakeHeight, look.sternWaves, look.wakeLife, look.bowWave], 4);
    v.set([look.waterlineFoam, look.foamLife, look.turbulentWake, look.lampIntensity], 8);
    lamps.forEach((l, i) => v.set([...l.p, l.i, ...l.c, 0], 12 + MAX_SHIPS * SHIP_FLOATS + i * 8));
    this.builtAt = this.seconds;
  }
  /** World positions of every lamp as drawn this frame, ships' first then fixed ones' after them. */
  lampPositions(): [number, number, number][] {
    this.build();
    const n = this.values[1],
      out: [number, number, number][] = [];
    for (let i = 0; i < n; i++) {
      const o = 12 + MAX_SHIPS * SHIP_FLOATS + i * 8;
      out.push([this.values[o], this.values[o + 1], this.values[o + 2]]);
    }
    return out;
  }
  private trailAt(x: number, z: number, ship: number, stern: boolean): [number, number, number, number] {
    const t = this.trails;
    const o = 12 + ship * SHIP_FLOATS;
    const first = this.values[o + 12];
    const count = this.values[o + 13];
    const offset = stern ? 5 : 0;
    const dx = x - t[first * 8 + offset];
    const dz = z - t[first * 8 + offset + 1];
    const fx = this.values[o + 2];
    const fz = this.values[o + 3];
    const current: [number, number, number, number] = [-dx * fx - dz * fz, fz * dx - fx * dz, this.values[o + 4], 0];
    const noTrack: [number, number, number, number] = [Infinity, 0, 0, 0];
    if (count < 2) return stern ? noTrack : current;
    let best = Infinity;
    let local = noTrack;
    for (let j = 0; j + 1 < count; j++) {
      const a = (first + j) * 8;
      const b = a + 8;
      const vx = t[b + offset] - t[a + offset];
      const vz = t[b + offset + 1] - t[a + offset + 1];
      const wx = x - t[a + offset];
      const wz = z - t[a + offset + 1];
      const length2 = vx * vx + vz * vz;
      if (stern && length2 < 1e-9) continue;
      const along = (wx * vx + wz * vz) / Math.max(length2, 1e-9);
      const u = Math.min(1, Math.max(0, along));
      const ex = wx - vx * u;
      const ez = wz - vz * u;
      const distance2 = ex * ex + ez * ez;
      if (distance2 >= best) continue;
      best = distance2;
      if (j === 0 && along <= 0) local = current;
      else if (stern && along > 1 && j + 2 === count) local = noTrack;
      else {
        const side = vx * wz - vz * wx < 0 ? 1 : -1;
        local = [
          t[a + offset + 2] + (t[b + offset + 2] - t[a + offset + 2]) * u,
          side * Math.sqrt(distance2),
          t[a + 4] + (t[b + 4] - t[a + 4]) * u,
          t[a + 3] + (t[b + 3] - t[a + 3]) * u,
        ];
      }
    }
    return local;
  }
  /** What the ships add to the sea at world XZ, the same numbers the GPU draws (in doubles). */
  sample(x: number, z: number): ShipWakeSample {
    finite(x, -1e7, 1e7, 'x');
    finite(z, -1e7, 1e7, 'z');
    this.build();
    const v = this.values;
    let height = 0;
    let foam = 0;
    for (let i = 0; i < v[0]; i++) {
      const o = 12 + i * SHIP_FLOATS;
      const span = v[o + 14];
      const l = v[o + 5];
      const b = v[o + 6];
      const d = v[o + 7];
      const [s, y, u, age] = this.trailAt(x, z, i, false);
      if (s > span) continue;
      const fade = (1 - smoothstep(0.8 * span, span, s)) * Math.exp(-age / v[6]);
      const dx = x - v[o];
      const dz = z - v[o + 1];
      const bowS = -dx * v[o + 2] - dz * v[o + 3];
      const bowY = v[o + 3] * dx - v[o + 2] * dz;
      const hull = hullDistance(bowS, bowY, l, b, v[o + 10]),
        mask = smoothstep(-0.25 * b, 0, hull);
      const a0 = 0.25 * v[o + 8] * v[o + 11] * v[4];
      const waves = a0 * (waveAt(s, y, u, l, d) - v[5] * waveAt(s - l, y, u, l, d)) * fade;
      const crestRidge = ridge(bowS, hull, v[o + 9], b);
      const side = sideWash(bowS, hull, v[o + 9], l, b);
      const nearHull = v[o + 8] * v[o + 11] * v[7] * (crestRidge + side);
      height += (waves + nearHull) * mask;
      const speed = v[o + 4],
        fr = speed / Math.sqrt(G * l),
        band = v[8] * (0.5 + Math.min(fr, 1));
      const wl =
        band > 0 && bowS <= l + band
          ? (1 - smoothstep(0, band, hull)) * smoothstep(-0.1 * b, 0, hull) * smoothstep(0.3, 2, speed)
          : 0;
      let turbulent = 0;
      if (v[10] > 0) {
        const [distance, side, sourceSpeed, sternAge] = this.trailAt(x, z, i, true);
        if (distance >= 0 && distance < span) {
          const half = b * 0.5 * (1 + 0.6 * Math.sqrt(distance / l));
          turbulent =
            v[10] *
            Math.exp(-sternAge / v[9]) *
            (1 - smoothstep(0.5 * half, half, Math.abs(side))) *
            smoothstep(0.5, 2.2, sourceSpeed) *
            (1 - smoothstep(0.8 * span, span, distance));
        }
      }
      const breaking =
        speed > 0.05
          ? smoothstep(0.3, 0.48, (G * v[o + 8]) / (speed * speed)) *
            smoothstep(0.5, 2, speed) *
            Math.max(crestRidge, 0) *
            mask *
            Math.min(v[7], 1)
          : 0;
      foam = Math.max(foam, wl, turbulent, breaking);
    }
    return { height, foam: Math.min(1, Math.max(0, foam)) };
  }
  setup(engine: Engine): void {
    this.live();
    if (this.engine) throw fault('attached', 'ShipWakes already attached; create another ShipWakes', 'state');
    if (!engine.gpu)
      throw fault('unsupported', 'ShipWakes need WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(this.surface.name))
      throw fault('state', 'Attach the Water surface to this engine before ShipWakes');
    if (surfaceEffects.get(this.surface)?.some((e) => e.key === 'ships'))
      throw fault('attached', 'This Water already has ship wakes; add ships to the attached ShipWakes', 'state');
    this.engine = engine;
    const device = engine.gpu;
    this.uniform = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.trailBuffer = device.createBuffer({
      size: TRAIL_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.resources = [{ buffer: this.uniform }, { buffer: this.trailBuffer }];
    this.remove = addSurfaceEffect(this.surface, {
      key: 'ships',
      vertex: true,
      count: 2,
      shader: (code, binding) => shipShader(code, binding),
      prepare: (c) => this.prepare(c),
    });
    this.removeDispose = this.surface.onDispose(() => this.dispose());
  }
  private prepare(c: Context): readonly GPUBindingResource[] {
    if (c.device !== this.engine?.gpu)
      throw fault('state', 'ShipWakes and Water must use the same engine; attach both to one engine');
    this.build();
    // Tint is live even when the trail clock is paused.
    for (let i = 0; i < this.ships.length; i++) {
      const offset = 12 + i * SHIP_FLOATS + 16;
      const tint = this.ships[i].wakeTint;
      if (tint) this.values.set(tint, offset);
      this.values[offset + 3] = tint ? 1 : 0;
    }
    c.device.queue.writeBuffer(this.uniform!, 0, this.values);
    c.device.queue.writeBuffer(this.trailBuffer!, 0, this.trails);
    return this.resources;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private live(): void {
    if (this.disposed) throw fault('disposed', 'ShipWakes disposed; create another ShipWakes');
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.trailBuffer?.destroy();
    this.uniform = this.trailBuffer = undefined;
    this.resources = [];
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
let sequence = 0;
function shipShader(code: string, binding: number): string {
  const surfaceReturn = 'return Surface(p,normalize(cross(binormal,tangent)),crest);';
  const foamLine = 'var foam=max(fresh,surfFoam);';
  const colorLine = 'var color=mix(body,skyColor(reflect(-v,n),rough),reflection)+glint*shade;';
  const bodyStart = 'let body=bottom*transmission+';
  const foamAlbedo = 'vec3f(0.72,0.77,0.74)';
  for (const needle of [surfaceReturn, foamLine, bodyStart, colorLine, foamAlbedo])
    if (!code.includes(needle))
      throw fault('state', 'ShipWakes found no place in the Water shader for the wake; update @margoengine/water');
  const head = `
@group(0) @binding(${binding}) var<uniform> shipData:ShipData;
@group(0) @binding(${binding + 1}) var<storage,read> shipTrail:array<vec4f>;
${WAKE_WGSL}`;
  return (
    head +
    code
      .replace(
        surfaceReturn,
        // The wake's height and its slope by central differences one tenth of the shortest Kelvin wave apart.
        `{let sw=shipWake(xz,false);p.y+=sw.height;
 if(u32(shipData.head.x)>0u){let e=0.25;
  tangent.y+=(shipWake(xz+vec2f(e,0),false).height-shipWake(xz-vec2f(e,0),false).height)/(2.0*e);
  binormal.y+=(shipWake(xz+vec2f(0,e),false).height-shipWake(xz-vec2f(0,e),false).height)/(2.0*e);}}
 ${surfaceReturn}`,
      )
      .replace(
        foamLine,
        `${foamLine}
 let shipSurface=shipWake(i.world.xz,true);
 let wash=shipSurface.foam;
 if(wash>0.001){
  let patternValue=noise(i.world.xz*0.38+vec2f(frame.settings.x*0.035,-frame.settings.x*0.021)).x;
  let root=sqrt(wash);
  let threshold=0.37-root;
  let flecks=smoothstep(threshold,threshold+0.16,patternValue);
  let islands=(1.0-smoothstep(0.08,0.30,wash))*0.32*root;
  foam=max(foam,clamp(pattern*(wash*mix(0.40,1.45,flecks)+islands*flecks),0.0,1.0));
 }`,
      )
      .replace(bodyStart, 'var body=bottom*transmission+')
      .replace(
        colorLine,
        `body=mix(body,shipSurface.tint.rgb*bodyLight,shipSurface.tint.w);
 ${colorLine}color+=shipLamps(i.world,n,v,rough);`,
      )
      .replace(foamAlbedo, `mix(${foamAlbedo},shipSurface.tint.rgb,0.75*shipSurface.tint.w)`)
  );
}

// --- Riding the sea ---

/** Anything that gives the water's height (and, if it can, its velocity) at world XZ: a `WaveQuery`, `floodSurface(...)`. */
export interface WaterHeightSource {
  sample(x: number, z: number): { height: number; velocity?: ArrayLike<number> } | undefined;
}
/** A heave, pitch or roll response: natural period in seconds (0 follows the water at once) and damping ratio. */
export interface FloaterResponse {
  /** Natural period, 0..120 s. */
  period?: number;
  /** Damping ratio, 0.01..4. */
  damping?: number;
}
/** Settings of a {@link Floater}. */
export interface FloaterOptions {
  hull: Hull;
  /** Sample points along and across the waterplane, integers 2..32 and 1..16. Default [7, 3]. */
  points?: readonly [number, number];
  /** Metacentric height, 0.01..20 m, for the roll period. Default 0.05 x beam. */
  metacentricHeight?: number;
  /** Heave response. Default the heave period 2 pi sqrt(1.5 draft / g), damping 0.3. */
  heave?: FloaterResponse;
  /** Pitch response. Default the heave period, damping 0.3. */
  pitch?: FloaterResponse;
  /** Roll response. Default the IMO roll period, damping 0.08. */
  roll?: FloaterResponse;
  /** Share of the surface's horizontal velocity the hull drifts with, 0..1 (a derelict 1). Default 0. */
  drift?: number;
  /** Starting pose; default at the origin, heading 0. */
  position?: Vec3;
  heading?: number;
}
interface Axis {
  value: number;
  rate: number;
  period: number;
  damping: number;
}
/** The default roll period of the IMO Intact Stability Code (2008): 2 C B / sqrt(GM). */
export function rollPeriod(hull: Hull, metacentricHeight = hull.beam * 0.05): number {
  const h = checkHull(hull);
  finite(metacentricHeight, 0.01, 20, 'metacentric height');
  const c = 0.373 + (0.023 * h.beam) / h.draft - (0.043 * h.length) / 100;
  return (2 * Math.max(0.2, c) * h.beam) / Math.sqrt(metacentricHeight);
}

/**
 * A hull that rides the water: each `update` samples the surface at a grid of points over the waterplane, fits a plane
 * through them by least squares, and lets heave, pitch and roll follow that plane through a damped second-order
 * response with the ship's natural periods. No forces are computed: the hull goes where the water puts it, as a film
 * needs it, and a wave much shorter than the hull averages out of its pitch the way it does on a real ship.
 */
export class Floater {
  readonly hull: Readonly<Required<Hull>>;
  readonly points: readonly [number, number];
  /** Share of the surface velocity the hull drifts with; read every update. */
  drift: number;
  /** Waterline amidships, world metres. */
  position: [number, number, number];
  /** Compass heading in degrees (0 is +Z, 90 is +X). */
  heading: number;
  /** True when fewer than three sample points found water (on dry ground, or off the surface). */
  aground = false;
  private readonly axes: { heave: Axis; pitch: Axis; roll: Axis };
  // Where the floater was built (position and heading): resetTime puts it back there.
  private readonly start: { position: Vec3; heading: number };
  private started = false;
  private source?: WaterHeightSource;
  private lastBow = 0;
  private bowRate = 0;
  private bowWater = 0;
  private bowWaterRate = 0;

  constructor(options: FloaterOptions) {
    if (!options || typeof options !== 'object') throw typeError('Floater needs options { hull }', 'geometry');
    this.hull = Object.freeze(checkHull(options.hull));
    const pts = options.points ?? [7, 3];
    if (
      !Array.isArray(pts) ||
      !Number.isInteger(pts[0]) ||
      !Number.isInteger(pts[1]) ||
      pts[0] < 2 ||
      pts[0] > 32 ||
      pts[1] < 1 ||
      pts[1] > 16
    )
      throw rangeError('Floater points must be [2..32, 1..16] whole numbers', 'geometry');
    this.points = [pts[0], pts[1]];
    this.drift = finite(options.drift ?? 0, 0, 1, 'drift');
    this.position = options.position ? vec3(options.position, 'position') : [0, 0, 0];
    this.heading = finite(options.heading ?? 0, -1e6, 1e6, 'heading');
    this.start = { position: [...this.position], heading: this.heading };
    const h = this.hull,
      heave = 2 * Math.PI * Math.sqrt((1.5 * h.draft) / G);
    const axis = (r: FloaterResponse | undefined, period: number, damping: number): Axis => ({
      value: 0,
      rate: 0,
      period: finite(r?.period ?? period, 0, 120, 'response period'),
      damping: finite(r?.damping ?? damping, 0.01, 4, 'response damping'),
    });
    this.axes = {
      heave: axis(options.heave, heave, 0.3),
      pitch: axis(options.pitch, heave, 0.3),
      roll: axis(options.roll, rollPeriod(h, options.metacentricHeight ?? h.beam * 0.05), 0.08),
    };
  }
  /** Bow-up pitch, radians. */
  get pitch(): number {
    return this.axes.pitch.value;
  }
  /** Starboard-down roll, radians. */
  get roll(): number {
    return this.axes.roll.value;
  }
  /** Heave rate, m/s. */
  get heaveRate(): number {
    return this.axes.heave.rate;
  }
  /** The bow's height above the water there (negative when buried) and its vertical speed relative to the water, m/s. */
  get bow(): { clearance: number; relativeVelocity: number } {
    return { clearance: this.lastBow - this.bowWater, relativeVelocity: this.bowRate - this.bowWaterRate };
  }
  /** Fits the water plane under the hull now: its height at the centre, slope along (bow up) and across (starboard down). */
  fit(
    source: WaterHeightSource,
  ): { height: number; pitch: number; roll: number; velocity: [number, number]; hits: number } | undefined {
    if (!source || typeof source.sample !== 'function')
      throw typeError('Floater needs a water source with sample(x, z)', 'geometry');
    const [nx, ny] = this.points,
      h = this.hull,
      a = (this.heading * Math.PI) / 180,
      f = [Math.sin(a), Math.cos(a)],
      right = [f[1], -f[0]]; // to port
    let n = 0,
      sx = 0,
      sy = 0,
      sh = 0,
      sxx = 0,
      syy = 0,
      sxy = 0,
      sxh = 0,
      syh = 0,
      vx = 0,
      vz = 0;
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        // Points over 90% of the waterline length and 80% of the beam.
        const along = (i / (nx - 1) - 0.5) * 0.9 * h.length,
          across = ny > 1 ? (j / (ny - 1) - 0.5) * 0.8 * h.beam : 0;
        const x = this.position[0] + f[0] * along + right[0] * across,
          z = this.position[2] + f[1] * along + right[1] * across;
        const hit = source.sample(x, z);
        if (!hit || !Number.isFinite(hit.height)) continue;
        n++;
        sx += along;
        sy += across;
        sh += hit.height;
        sxx += along * along;
        syy += across * across;
        sxy += along * across;
        sxh += along * hit.height;
        syh += across * hit.height;
        if (hit.velocity) {
          vx += hit.velocity[0];
          vz += hit.velocity[2];
        }
      }
    if (n < 3) return undefined;
    // Least squares h = c + a along + b across: the 3 x 3 normal equations, solved by Cramer's rule.
    const m = [
      [n, sx, sy],
      [sx, sxx, sxy],
      [sy, sxy, syy],
    ];
    const rhs = [sh, sxh, syh];
    const det3 = (q: number[][]) =>
      q[0][0] * (q[1][1] * q[2][2] - q[1][2] * q[2][1]) -
      q[0][1] * (q[1][0] * q[2][2] - q[1][2] * q[2][0]) +
      q[0][2] * (q[1][0] * q[2][1] - q[1][1] * q[2][0]);
    const d = det3(m);
    const solve = (k: number) => det3(m.map((row, r) => row.map((x, c) => (c === k ? rhs[r] : x)))) / d;
    let c0 = sh / n,
      slopeA = 0,
      slopeB = 0;
    if (Math.abs(d) > 1e-12) {
      c0 = solve(0);
      slopeA = solve(1);
      slopeB = solve(2);
    } else if (sxx > 0) {
      // One row of points (ny 1): no roll from the water.
      slopeA = (sxh - (sx * sh) / n) / (sxx - (sx * sx) / n);
      c0 = (sh - slopeA * sx) / n;
    }
    // Across runs to port (+X of the hull), so water higher to port lifts port: starboard-down roll.
    return { height: c0, pitch: Math.atan(slopeA), roll: Math.atan(slopeB), velocity: [vx / n, vz / n], hits: n };
  }
  /**
   * Rides the water for `dt` seconds (0..10): the response steps toward the plane fitted now, in substeps of a
   * twentieth of the shortest period. Give the new position (its x and z; the height is the ride's) and heading when
   * the ship is driven along a path.
   */
  update(source: WaterHeightSource, dt: number, drive: { position?: Vec3; heading?: number } = {}): this {
    finite(dt, 0, 10, 'time step');
    this.source = source;
    // The drive sets x and z; the height is the ride's.
    if (drive.position) {
      const p = vec3(drive.position, 'position');
      this.position = [p[0], this.position[1], p[2]];
    }
    if (drive.heading !== undefined) this.heading = finite(drive.heading, -1e6, 1e6, 'heading');
    const plane = this.fit(source);
    this.aground = !plane;
    if (!plane) return this;
    if (this.drift > 0 && dt > 0) {
      this.position[0] += plane.velocity[0] * this.drift * dt;
      this.position[2] += plane.velocity[1] * this.drift * dt;
    }
    const targets = { heave: plane.height, pitch: plane.pitch, roll: plane.roll };
    if (!this.started) {
      for (const k of ['heave', 'pitch', 'roll'] as const) this.axes[k].value = targets[k];
      this.started = true;
    } else
      for (const k of ['heave', 'pitch', 'roll'] as const) {
        const axis = this.axes[k];
        if (axis.period === 0) {
          axis.rate = dt > 0 ? (targets[k] - axis.value) / dt : axis.rate;
          axis.value = targets[k];
          continue;
        }
        const w = (2 * Math.PI) / axis.period,
          steps = Math.max(1, Math.ceil((dt * 20) / axis.period)),
          h = dt / steps;
        // Semi-implicit Euler on x'' = w^2 (target - x) - 2 zeta w x'.
        for (let s = 0; s < steps; s++) {
          axis.rate += h * (w * w * (targets[k] - axis.value) - 2 * axis.damping * w * axis.rate);
          axis.value += h * axis.rate;
        }
      }
    this.position[1] = this.axes.heave.value;
    // The bow's height and its rate, against the water under it.
    const a = (this.heading * Math.PI) / 180,
      half = this.hull.length / 2;
    const bowX = this.position[0] + Math.sin(a) * half,
      bowZ = this.position[2] + Math.cos(a) * half;
    const bow = this.position[1] + Math.sin(this.pitch) * half,
      water = source.sample(bowX, bowZ);
    if (dt > 0) {
      this.bowRate = (bow - this.lastBow) / dt;
      if (water) {
        this.bowWaterRate = water.velocity ? water.velocity[1] : (water.height - this.bowWater) / dt;
      }
    }
    this.lastBow = bow;
    if (water) this.bowWater = water.height;
    return this;
  }
  /**
   * Puts the floater back where it was built, at rest and with no water given, as a fresh one is (the next `update`
   * sets it on the water, as the first one does), so a later `seek` (`resetClocks` from `@margoengine/cutscene/seek`
   * calls it on every clock) gives what a fresh world seeked there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.position = [...this.start.position];
    this.heading = this.start.heading;
    this.aground = false;
    this.started = false;
    this.source = undefined;
    this.lastBow = this.bowRate = this.bowWater = this.bowWaterRate = 0;
    for (const axis of Object.values(this.axes)) axis.value = axis.rate = 0;
  }
  /**
   * Rides `delta` seconds more on the water last given to {@link update}, with no new drive: the clock a film seek
   * (`@margoengine/cutscene` `seek`, the floater in its `extra`) replays, so the drift and the ride land where a
   * played film has them. Does nothing before the first `update`.
   */
  advanceTime(delta: number): void {
    if (this.source && delta > 0 && Number.isFinite(delta)) this.update(this.source, delta);
  }
  /** The hull's rotation as a unit quaternion [x, y, z, w], for `setQuaternion` (same axes as {@link matrix}). */
  quaternion(): [number, number, number, number] {
    const m = this.matrix(new Array(16)) as number[];
    // Shepperd's method on the rotation part (column-major m[col * 4 + row]).
    const r = (row: number, col: number) => m[col * 4 + row];
    const trace = r(0, 0) + r(1, 1) + r(2, 2);
    let q: [number, number, number, number];
    if (trace > 0) {
      const t = Math.sqrt(trace + 1) * 2;
      q = [(r(2, 1) - r(1, 2)) / t, (r(0, 2) - r(2, 0)) / t, (r(1, 0) - r(0, 1)) / t, t / 4];
    } else if (r(0, 0) > r(1, 1) && r(0, 0) > r(2, 2)) {
      const t = Math.sqrt(1 + r(0, 0) - r(1, 1) - r(2, 2)) * 2;
      q = [t / 4, (r(0, 1) + r(1, 0)) / t, (r(0, 2) + r(2, 0)) / t, (r(2, 1) - r(1, 2)) / t];
    } else if (r(1, 1) > r(2, 2)) {
      const t = Math.sqrt(1 + r(1, 1) - r(0, 0) - r(2, 2)) * 2;
      q = [(r(0, 1) + r(1, 0)) / t, t / 4, (r(1, 2) + r(2, 1)) / t, (r(0, 2) - r(2, 0)) / t];
    } else {
      const t = Math.sqrt(1 + r(2, 2) - r(0, 0) - r(1, 1)) * 2;
      q = [(r(0, 2) + r(2, 0)) / t, (r(1, 2) + r(2, 1)) / t, t / 4, (r(1, 0) - r(0, 1)) / t];
    }
    return q;
  }
  /** The hull's world matrix, column-major: heading, then pitch (bow up) and roll (starboard down), at the position. */
  matrix(out: Float32Array | number[] = new Float32Array(16)): Float32Array | number[] {
    const a = (this.heading * Math.PI) / 180,
      p = this.pitch,
      r = this.roll;
    const f = [Math.sin(a) * Math.cos(p), Math.sin(p), Math.cos(a) * Math.cos(p)];
    // The port axis before roll is (cos a, 0, -sin a); roll turns it and up about forward.
    const right0 = [Math.cos(a), 0, -Math.sin(a)];
    const up0 = [
      f[1] * right0[2] - f[2] * right0[1],
      f[2] * right0[0] - f[0] * right0[2],
      f[0] * right0[1] - f[1] * right0[0],
    ];
    const cr = Math.cos(r),
      sr = Math.sin(r);
    const right = right0.map((x, i) => x * cr + up0[i] * sr),
      up = up0.map((x, i) => x * cr - right0[i] * sr);
    // Local axes as glTF models face: +X to port, +Y up, +Z forward.
    const m = [...right, 0, ...up, 0, ...f, 0, ...this.position, 1];
    for (let i = 0; i < 16; i++) out[i] = m[i];
    return out;
  }
}

/** The world square a Flood's map covers: the terrain's `origin` and `size` of its Water. */
export interface FloodExtent {
  origin: readonly [number, number];
  size: readonly [number, number];
}
/** What `floodSurface` reads of a `FloodReading` (`Flood.read()`). */
export interface FloodSurfaceReading {
  width: number;
  height: number;
  depth: Float32Array;
  bed: Float32Array;
  velocity: Float32Array;
}
/**
 * A height source over a Flood's water as last read: the bed plus the depth, bilinear between cell centres, with the
 * flow's velocity; undefined where the water is under 1 mm deep or off the map. A Floater rides a flood with it.
 */
export function floodSurface(reading: FloodSurfaceReading, extent: FloodExtent): WaterHeightSource {
  const { width, height, depth, bed, velocity } = reading ?? ({} as FloodSurfaceReading);
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    depth?.length !== width * height ||
    bed?.length !== width * height ||
    velocity?.length !== width * height * 2
  )
    throw typeError('floodSurface needs a FloodReading (width, height, depth, bed, velocity)', 'geometry');
  const [ox, oz] = extent.origin,
    [sx, sz] = extent.size;
  return {
    sample(x: number, z: number) {
      const u = ((x - ox) / sx) * width - 0.5,
        v = ((z - oz) / sz) * height - 0.5;
      if (u < -0.5 || v < -0.5 || u > width - 0.5 || v > height - 0.5) return undefined;
      const cu = Math.max(0, Math.min(width - 1, u)),
        cv = Math.max(0, Math.min(height - 1, v));
      const i = Math.min(width - 2, Math.floor(cu)),
        j = Math.min(height - 2, Math.floor(cv)),
        tx = cu - i,
        tz = cv - j;
      let level = 0,
        wet = 0,
        vx = 0,
        vz = 0,
        weight = 0;
      for (let b = 0; b < 2; b++)
        for (let a = 0; a < 2; a++) {
          const k = (j + b) * width + i + a,
            w = (a ? tx : 1 - tx) * (b ? tz : 1 - tz);
          wet += depth[k] * w;
          if (depth[k] < 0.001) continue;
          level += (bed[k] + depth[k]) * w;
          vx += velocity[k * 2] * w;
          vz += velocity[k * 2 + 1] * w;
          weight += w;
        }
      if (wet < 0.001 || weight <= 0) return undefined;
      return { height: level / weight, velocity: [vx / weight, 0, vz / weight] };
    },
  };
}

// --- Splash ---

/** What ShipSplash drives: a particle emitter whose `options` are read every frame and that can `burst`; a `VFX` fits. */
export interface SplashParticles {
  options: { position?: Vec3; velocity?: Vec3; rate?: number; emissionExtent?: Vec3; spread?: number };
  burst(count: number): unknown;
}
/** Settings of a {@link ShipSplash}; the numbers are read every update. */
export interface ShipSplashOptions {
  floater: Floater;
  particles: SplashParticles;
  /** Bow spray particles per second at full breaking, 0..1e6. Default 2,000. */
  sprayRate?: number;
  /** Particles a slam throws at its threshold, growing with the square of the excess, 0..1e6. Default 400. */
  slamBurst?: number;
  /** Slam threshold as a multiple of Ochi's 0.093 sqrt(g L), 0.1..10. Default 1. */
  slamThreshold?: number;
}
/** What the last ShipSplash update did. */
export interface SplashState {
  rate: number;
  slam: boolean;
  burst: number;
  relativeVelocity: number;
}
/**
 * Bow spray and slamming spray for a floating hull: the spray sheet thrown where the bow wave breaks (its rate rising as
 * g Zb / U^2 nears the stagnation limit, from 1 to 3 m/s up), launched off the bow at the speed that reaches the bow wave's height, and a
 * burst when the bow re-enters the water faster than Ochi's threshold 0.093 sqrt(g L) after leaving it.
 */
export class ShipSplash {
  readonly floater: Floater;
  readonly particles: SplashParticles;
  sprayRate: number;
  slamBurst: number;
  slamThreshold: number;
  private emerged = false;
  last: SplashState = { rate: 0, slam: false, burst: 0, relativeVelocity: 0 };
  constructor(options: ShipSplashOptions) {
    if (!(options?.floater instanceof Floater)) throw typeError('ShipSplash needs a Floater', 'geometry');
    if (
      !options.particles ||
      typeof options.particles.burst !== 'function' ||
      typeof options.particles.options !== 'object'
    )
      throw typeError('ShipSplash needs particles with options and burst(count), such as a VFX', 'geometry');
    this.floater = options.floater;
    this.particles = options.particles;
    this.sprayRate = finite(options.sprayRate ?? 2000, 0, 1e6, 'spray rate');
    this.slamBurst = finite(options.slamBurst ?? 400, 0, 1e6, 'slam burst');
    this.slamThreshold = finite(options.slamThreshold ?? 1, 0.1, 10, 'slam threshold');
  }
  /** Ochi's slam threshold for this hull, m/s, times `slamThreshold`. */
  get threshold(): number {
    return 0.093 * Math.sqrt(G * this.floater.hull.length) * this.slamThreshold;
  }
  /** Sets the emitter at the bow for a ship at `speed` m/s; call after the Floater's update each frame. */
  update(speed: number): SplashState {
    finite(speed, 0, 100, 'speed');
    const f = this.floater,
      h = f.hull,
      a = (f.heading * Math.PI) / 180,
      fwd = [Math.sin(a), Math.cos(a)];
    const bw = bowWave(speed, h),
      z = speed > 0 ? (G * bw.height) / (speed * speed) : 0;
    const half = h.length / 2,
      bowY = f.position[1] + Math.sin(f.pitch) * half;
    const o = this.particles.options;
    o.position = [f.position[0] + fwd[0] * half, bowY + bw.height * 0.5, f.position[2] + fwd[1] * half];
    // Thrown outward and up off the stem at the speed that lifts water to the bow wave's height, sqrt(2 g Zb).
    const up = Math.sqrt(2 * G * Math.max(bw.height, 0));
    o.velocity = [fwd[0] * speed * 0.5, up, fwd[1] * speed * 0.5];
    o.spread = Math.max(0.2, speed * Math.sin((h.entrance * Math.PI) / 180));
    o.emissionExtent = [h.beam * 0.3, 0.1, 0.2];
    // A crawling bow has no sheet fast enough to break into drops: Margo's gate from 1 to 3 m/s.
    const rate = this.sprayRate * smoothstep(0.3, 0.48, z) * smoothstep(1, 3, speed);
    o.rate = rate;
    const { clearance, relativeVelocity } = f.bow;
    if (clearance > 0) this.emerged = true;
    let slam = false,
      burst = 0;
    const th = this.threshold;
    if (this.emerged && clearance <= 0 && -relativeVelocity > th) {
      slam = true;
      burst = Math.round(this.slamBurst * ((relativeVelocity * relativeVelocity) / (th * th)));
      this.particles.burst(burst);
      this.emerged = false;
    } else if (clearance <= 0) this.emerged = false;
    this.last = { rate, slam, burst, relativeVelocity };
    return this.last;
  }
}
