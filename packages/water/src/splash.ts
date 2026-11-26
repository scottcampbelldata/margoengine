/// <reference lib="esnext.disposable" preserve="true" />
// Splashes where round shot hits the sea: a shot at a grazing angle skips (ricochets) and throws a fan of spray at
// each graze; one that goes in throws a crown of spray, then a column (the jet that rises when the air cavity behind
// the shot seals) and a drifting mist, and leaves a ring of foam. Sources (papers, read as text; no code;
// docs/clean-room.md "Shot splashes"):
// - G. Birkhoff, G. D. Birkhoff, W. E. Bleick, E. H. Handler, F. D. Murnaghan and T. L. Smith, "Ricochet off water",
//   AMP Memo 42.4M, Applied Mathematics Panel, 1944, as W. Johnson and S. R. Reid, "Ricochet of spheres off water",
//   J. Mech. Eng. Sci. 17(2), 71-81, 1975, https://doi.org/10.1243/JMES_JOUR_1975_017_011_02, and I. M. Hutchings,
//   "The ricochet of spheres and cylinders from the surface of water", Int. J. Mech. Sci. 18, 243-248, 1976, use it:
//   the water presses on the part of a sphere below the undisturbed surface that moves into it at 1/2 rho (U . n)^2.
//   Integrating that over the wetted cap gives the ricochet; Johnson and Reid's trials give the critical angle
//   18 degrees / sqrt(sigma) for a sphere sigma times as dense as the water (Hutchings' analysis 17.3).
// - A. May, "Water entry and the cavity-running behavior of missiles", NAVSEA Hydroballistics Advisory Committee
//   Technical Report 75-2, 1975: a cavity-running sphere's drag coefficient at zero cavitation number is about 0.3.
//   Logvinovich's principle of independent cavity expansion (G. V. Logvinovich, Hydrodynamics of Free-Boundary Flows,
//   1969, ch. 6) as May describes it: each section of the cavity opens with the radial speed the shot's drag gives it
//   there, U sqrt(C_D / 2) at the start, which is the speed of the splash sheet thrown up at the surface.
// - J. W. Glasheen and T. A. McMahon, "Vertical water entry of disks at low Froude numbers", Phys. Fluids 8(8),
//   2078-2083, 1996, https://doi.org/10.1063/1.869010, and V. Duclaux, F. Caille, C. Duez, C. Ybert, L. Bocquet and C.
//   Clanet, "Dynamics of transient cavities", J. Fluid Mech. 591, 1-19, 2007, https://doi.org/10.1017/S0022112007007343:
//   the cavity seals (deep seal) a time near 2.3 sqrt(R / g) after entry, whatever the speed; J. M. Aristoff and J. W. M.
//   Bush, "Water entry of small hydrophobic spheres", J. Fluid Mech. 619, 45-78, 2009,
//   https://doi.org/10.1017/S0022112008004382: it pinches about halfway between the surface and the shot, and the upper
//   cavity's collapse throws up the Worthington jet (A. M. Worthington, A Study of Splashes, Longmans 1908).
// - R. Gunn and G. D. Kinzer, "The terminal velocity of fall for water droplets in stagnant air", J. Meteorol. 6(4),
//   243-248, 1949, https://doi.org/10.1175/1520-0469(1949)006<0243:TTVOFF>2.0.CO;2: 2 mm drops fall at 6.5 m/s, 5 mm
//   drops at 9.1. A drop thrown up at v0 against quadratic drag rises vt^2 / (2 g) ln(1 + v0^2 / vt^2).
// - S. F. Hoerner, Fluid-Dynamic Drag, 1965, ch. 16: a sphere's drag coefficient is about 0.47 subsonic and climbs
//   through the transonic range to 0.92 to 1.0 supersonic; the ball flies between grazes against that drag on its speed
//   relative to the air, and R. L. McCoy, Modern Exterior Ballistics, Schiffer 1999, ch. 8 gives the check: a crosswind
//   W moves a ball W (T - X / u0) sideways over a flight of T seconds and X metres (the lag-time rule).
// - The splash sheet's speed of Logvinovich and May is relative to the water it leaves, so a wave's surface velocity
//   (a `WaveQuery` sample's particle velocity) is added to the spray it throws, and the splash rises from the surface
//   height at its own time.
// Margo's own choices are named where they are made (particle counts, the oblique factor, the foam ring).
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin, type PassContext } from '@margoengine/core/extension';
import type { Water } from './index.js';
import { addSurfaceEffect, surfaceEffects } from './surface-effects.js';
import type { WaterHeightSource } from './ships.js';
import { fault, rangeError, typeError } from '../../shared/errors.js';

declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
type Vec3 = readonly [number, number, number];
type V3 = [number, number, number];

const G = 9.81;
/** Sea water density, kg/m^3. */
export const SEA_WATER_DENSITY = 1025;
/** Drag coefficient of a cavity-running sphere at zero cavitation number (May 1975). */
export const CAVITY_DRAG = 0.3;
/** Deep-seal time over sqrt(R / g) (Glasheen and McMahon 1996; Duclaux et al. 2007). */
export const SEAL_TIME = 2.3;
/** Terminal velocity of the crown's 2 mm drops, m/s (Gunn and Kinzer 1949). */
export const CROWN_DROP_FALL = 6.5;
/** Terminal velocity of the column's 5 mm drops and sheets, m/s (Gunn and Kinzer 1949). */
export const COLUMN_DROP_FALL = 9.1;
/** Most foam rings one ShotSplash draws on its Water. */
export const MAX_SPLASH_RINGS = 16;

const finite = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi)
    throw rangeError(`Invalid splash ${what}; pass a finite number in ${lo}..${hi}`, 'geometry');
  return v;
};
const vec3 = (v: unknown, what: string): V3 => {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw typeError(`Invalid splash ${what}; pass three finite numbers`, 'geometry');
  return [v[0], v[1], v[2]];
};

/** A shot meeting the water: what `Battery.impacts()` of `@margoengine/vfx/gunfire` lists. */
export interface ShotImpact {
  /** Film time, seconds. */
  time: number;
  /** Where it meets the water, world. */
  position: Vec3;
  /** Velocity there, m/s (y below 0). */
  velocity: Vec3;
  /** Shot radius, metres. */
  radius: number;
  /** Shot density, kg/m^3. */
  density: number;
}

/** Johnson and Reid's critical angle, radians below the horizontal: 18 degrees / sqrt(shot density / water density). */
export function ricochetAngle(density: number, waterDensity = SEA_WATER_DENSITY): number {
  finite(density, 1, 1e5, 'density');
  finite(waterDensity, 500, 2000, 'water density');
  return (18 * Math.PI) / 180 / Math.sqrt(density / waterDensity);
}

/** The result of {@link birkhoffContact}. */
export interface SplashContact {
  /** True when the shot leaves the water again (a skip). */
  ricochet: boolean;
  /** Velocity as it leaves (a skip) or as it goes under (an entry), m/s. */
  velocity: V3;
  /** Seconds in contact. */
  duration: number;
  /** Horizontal distance travelled in contact, metres. */
  travel: number;
  /** Deepest the shot's centre went below the surface, metres. */
  depth: number;
}

const GRID_T = 40,
  GRID_P = 40;
/**
 * A sphere touching flat water at `velocity`: Birkhoff's pressure law (1/2 rho (U . n)^2 on the wetted part of the
 * sphere below the undisturbed surface that moves into the water) and gravity, integrated over the sphere on a 40 by 40
 * grid in steps of a fiftieth of the time to cross its radius, until it leaves the water (a skip) or goes fully under
 * (an entry). The critical angle this gives is Johnson and Reid's 18 / sqrt(sigma) degrees within the trials' scatter.
 */
export function birkhoffContact(
  velocity: Vec3,
  radius: number,
  density: number,
  waterDensity = SEA_WATER_DENSITY,
): SplashContact {
  const v = vec3(velocity, 'velocity');
  const a = finite(radius, 1e-4, 10, 'radius'),
    rs = finite(density, 1, 1e5, 'density'),
    rw = finite(waterDensity, 500, 2000, 'water density'),
    mass = (rs * 4 * Math.PI * a ** 3) / 3;
  if (!(v[1] < 0)) throw rangeError('A splash contact needs a velocity going down into the water', 'geometry');
  // Unit normals and areas of the grid, once.
  const normals: number[] = [];
  for (let i = 0; i < GRID_T; i++)
    for (let j = 0; j < GRID_P; j++) {
      const t = ((i + 0.5) * Math.PI) / GRID_T,
        p = ((j + 0.5) * 2 * Math.PI) / GRID_P,
        area = a * a * Math.sin(t) * (Math.PI / GRID_T) * ((2 * Math.PI) / GRID_P);
      normals.push(Math.sin(t) * Math.cos(p), Math.cos(t), Math.sin(t) * Math.sin(p), area);
    }
  const c = [0, a, 0],
    u = [v[0], v[1], v[2]];
  const speed0 = Math.hypot(u[0]!, u[1]!, u[2]!),
    dt = a / Math.max(1, speed0) / 50;
  let t = 0,
    depth = 0;
  const force = (cy: number, w: number[]): number[] => {
    const f = [0, 0, 0];
    for (let k = 0; k < normals.length; k += 4) {
      const nx = normals[k]!,
        ny = normals[k + 1]!,
        nz = normals[k + 2]!;
      if (cy + a * ny >= 0) continue;
      const un = w[0]! * nx + w[1]! * ny + w[2]! * nz;
      if (un <= 0) continue;
      const p = 0.5 * rw * un * un * normals[k + 3]!;
      f[0] -= p * nx;
      f[1] -= p * ny;
      f[2] -= p * nz;
    }
    return f;
  };
  for (let step = 0; step < 200000; step++) {
    // Midpoint step: the pressure grows fast as the sphere dips.
    const f1 = force(c[1]!, u),
      um = u.map((x, i) => x + 0.5 * dt * (f1[i]! / mass - (i === 1 ? G : 0))),
      cm1 = c[1]! + 0.5 * dt * u[1]!,
      f2 = force(cm1, um);
    for (let i = 0; i < 3; i++) {
      c[i] = c[i]! + dt * um[i]!;
      u[i] = u[i]! + dt * (f2[i]! / mass - (i === 1 ? G : 0));
    }
    t += dt;
    depth = Math.max(depth, -c[1]!);
    if (c[1]! >= a && u[1]! > 0)
      return { ricochet: true, velocity: [u[0]!, u[1]!, u[2]!], duration: t, travel: Math.hypot(c[0]!, c[2]!), depth };
    if (c[1]! <= -a || Math.hypot(u[0]!, u[1]!, u[2]!) < 1e-3 * speed0)
      return { ricochet: false, velocity: [u[0]!, u[1]!, u[2]!], duration: t, travel: Math.hypot(c[0]!, c[2]!), depth };
  }
  return { ricochet: false, velocity: [u[0]!, u[1]!, u[2]!], duration: t, travel: Math.hypot(c[0]!, c[2]!), depth };
}

/** How high a drop thrown straight up at `speed` m/s rises against quadratic drag with terminal velocity `terminal`. */
export function dragLimitedHeight(speed: number, terminal: number): number {
  finite(speed, 0, 1e4, 'speed');
  finite(terminal, 0.01, 100, 'terminal velocity');
  return ((terminal * terminal) / (2 * G)) * Math.log(1 + (speed * speed) / (terminal * terminal));
}
/** Deep-seal time of the cavity behind a sphere of `radius` metres, seconds: 2.3 sqrt(R / g). */
export function cavitySeal(radius: number): number {
  return SEAL_TIME * Math.sqrt(finite(radius, 1e-4, 10, 'radius') / G);
}
/**
 * How far a cavity-running sphere goes in `seconds`, metres, slowed by its drag C_D (default {@link CAVITY_DRAG}):
 * U(t) = U0 / (1 + U0 t / l), l = 8 a rho_s / (3 rho_w C_D), so the path is l ln(1 + U0 t / l).
 */
export function entryDepth(
  speed: number,
  radius: number,
  density: number,
  seconds: number,
  drag = CAVITY_DRAG,
): number {
  const l =
    (8 * finite(radius, 1e-4, 10, 'radius') * finite(density, 1, 1e5, 'density')) /
    (3 * SEA_WATER_DENSITY * finite(drag, 0.01, 2, 'drag'));
  return l * Math.log(1 + (finite(speed, 0, 1e4, 'speed') * finite(seconds, 0, 1e4, 'seconds')) / l);
}

const AIR_DENSITY = 1.225,
  SOUND = 340.3,
  DRAG_KNOTS: readonly (readonly [number, number])[] = [
    [0, 0.47],
    [0.6, 0.5],
    [0.8, 0.6],
    [1, 0.82],
    [1.2, 0.95],
    [2, 0.92],
  ];
/** A sphere's drag coefficient at Mach `mach` (Hoerner 1965 ch. 16): 0.47 subsonic, rising through Mach 0.6 to 1.2, 0.92 beyond 2. */
export function sphereDragCoefficient(mach: number): number {
  const M = Math.max(0, finite(mach, -1e9, 1e9, 'mach'));
  for (let i = 1; i < DRAG_KNOTS.length; i++) {
    const [m1, c1] = DRAG_KNOTS[i]!;
    if (M <= m1) {
      const [m0, c0] = DRAG_KNOTS[i - 1]!;
      return c0 + ((c1 - c0) * (M - m0)) / (m1 - m0);
    }
  }
  return 0.92;
}
/** The air's motion a ball flies through: `[x, z]` m/s, or a field `{sample(x, y, z, t)}` (a VFX wind). */
export type SplashWind =
  | readonly [number, number]
  | { sample(x: number, y: number, z: number, t: number): ArrayLike<number> };
/** Settings of {@link skipFlight}. */
export interface SkipFlightOptions {
  /** The water between grazes. Default the plane through the start. */
  water?: WaterHeightSource;
  /** The wind. Default none. */
  wind?: SplashWind;
  /** Film time at the start, for a wind field. Default 0. */
  time?: number;
  /** Air drag: `true` for Hoerner's sphere (default), `false` for none, or a fixed drag coefficient 0..10. */
  drag?: boolean | number;
}
/** Where a skipping ball comes down again, from {@link skipFlight}. */
export interface SkipLanding {
  /** Seconds in the air. */
  time: number;
  position: V3;
  velocity: V3;
}
/**
 * Flies a ball of `radius` metres and `density` kg/m^3 that leaves the water at `position` with `velocity` through the
 * air (gravity, and the sphere drag of {@link sphereDragCoefficient} on its speed relative to the wind; fourth-order
 * Runge-Kutta in 2 ms steps) until it is back at the water, at most 60 s.
 */
export function skipFlight(
  position: Vec3,
  velocity: Vec3,
  radius: number,
  density: number,
  options: SkipFlightOptions = {},
): SkipLanding {
  const p = vec3(position, 'position'),
    v = vec3(velocity, 'velocity'),
    a = finite(radius, 1e-4, 10, 'radius'),
    mass = (finite(density, 1, 1e5, 'density') * 4 * Math.PI * a ** 3) / 3,
    drag = options.drag ?? true,
    fixed = typeof drag === 'number' ? finite(drag, 0, 10, 'drag coefficient') : undefined,
    k0 = (0.5 * AIR_DENSITY * Math.PI * a * a) / mass,
    start = finite(options.time ?? 0, 0, 1e7, 'time'),
    sea = p[1],
    level = (x: number, z: number) => options.water?.sample(x, z)?.height ?? sea,
    wind = options.wind,
    windAt = (y: readonly number[], t: number): [number, number] => {
      if (!wind) return [0, 0];
      if ('sample' in wind) {
        const w = wind.sample(y[0]!, y[1]!, y[2]!, start + t);
        return [w[0]!, w[2]!];
      }
      return [wind[0], wind[1]];
    };
  const deriv = (y: number[], t: number): number[] => {
    const [wx, wz] = windAt(y, t),
      rx = y[3]! - wx,
      ry = y[4]!,
      rz = y[5]! - wz,
      u = Math.hypot(rx, ry, rz),
      k = drag === false || u === 0 ? 0 : k0 * (fixed ?? sphereDragCoefficient(u / SOUND)) * u;
    return [y[3]!, y[4]!, y[5]!, -k * rx, -G - k * ry, -k * rz];
  };
  const dt = 0.002,
    s = [p[0], p[1], p[2], v[0], v[1], v[2]];
  let t = 0;
  while (t < 60) {
    const k1 = deriv(s, t),
      k2 = deriv(
        s.map((x, i) => x + 0.5 * dt * k1[i]!),
        t + dt / 2,
      ),
      k3 = deriv(
        s.map((x, i) => x + 0.5 * dt * k2[i]!),
        t + dt / 2,
      ),
      k4 = deriv(
        s.map((x, i) => x + dt * k3[i]!),
        t + dt,
      ),
      next = s.map((x, i) => x + (dt / 6) * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!)),
      above0 = s[1]! - level(s[0]!, s[2]!),
      above1 = next[1]! - level(next[0]!, next[2]!);
    if (t > 0 && above1 <= 0 && above0 > 0) {
      const f = above0 / (above0 - above1),
        at = s.map((x, i) => x + (next[i]! - x) * f);
      return {
        time: t + f * dt,
        position: [at[0]!, level(at[0]!, at[2]!), at[2]!],
        velocity: [at[3]!, at[4]!, at[5]!],
      };
    }
    for (let i = 0; i < 6; i++) s[i] = next[i]!;
    t += dt;
  }
  return { time: t, position: [s[0]!, level(s[0]!, s[2]!), s[2]!], velocity: [s[3]!, s[4]!, s[5]!] };
}

/** One splash of a shot's fall, from {@link planSplashes}. */
export interface SplashEvent {
  kind: 'skip' | 'entry';
  /** Film time, seconds. */
  time: number;
  position: V3;
  /** Shot speed as it meets the water, m/s. */
  speed: number;
  /** Angle below the horizontal, radians. */
  angle: number;
  /** Horizontal direction of travel (unit XZ). */
  heading: [number, number];
  /** Speed of the crown sheet, m/s, and the height its drops reach. */
  crownSpeed: number;
  crownHeight: number;
  /** An entry's column: when it starts after the event (the deep seal), how fast it leaves and how high it reaches. */
  columnDelay: number;
  columnSpeed: number;
  columnHeight: number;
  /** Shot radius, metres. */
  radius: number;
}

/**
 * The splashes of one shot's fall: a skip at each graze below the critical angle (Birkhoff's contact, then a flight
 * through the air to the water again, {@link skipFlight}: drag, and the `wind`), then the entry; at most `maxSkips`
 * (default 8) skips. The water is the plane through the first impact, or `water` (a height source) between skips.
 */
export function planSplashes(
  impact: ShotImpact,
  options: { maxSkips?: number; water?: WaterHeightSource; wind?: SplashWind; drag?: boolean | number } = {},
): SplashEvent[] {
  if (!impact || typeof impact !== 'object')
    throw typeError('planSplashes needs a ShotImpact {time, position, velocity, radius, density}', 'geometry');
  const out: SplashEvent[] = [],
    maxSkips = finite(options.maxSkips ?? 8, 0, 64, 'maxSkips'),
    a = finite(impact.radius, 1e-4, 10, 'radius'),
    rs = finite(impact.density, 1, 1e5, 'density');
  let time = finite(impact.time, 0, 1e7, 'time'),
    p = vec3(impact.position, 'position'),
    v = vec3(impact.velocity, 'velocity');
  for (let k = 0; ; k++) {
    if (!(v[1] < 0)) break;
    const h = Math.hypot(v[0], v[2]),
      U = Math.hypot(v[0], v[1], v[2]),
      angle = Math.atan2(-v[1], h),
      heading: [number, number] = h > 0 ? [v[0] / h, v[2] / h] : [1, 0],
      // Margo's oblique factor: the cavity's mouth narrows as the shot grazes, sqrt(sin angle) of the sheet speed.
      crownSpeed = U * Math.sqrt(CAVITY_DRAG / 2) * Math.sqrt(Math.sin(angle)),
      crownHeight = dragLimitedHeight(crownSpeed, CROWN_DROP_FALL);
    const contact = k < maxSkips ? birkhoffContact(v, a, rs) : undefined;
    if (contact?.ricochet) {
      out.push({
        kind: 'skip',
        time,
        position: p,
        speed: U,
        angle,
        heading,
        crownSpeed,
        crownHeight,
        columnDelay: 0,
        columnSpeed: 0,
        columnHeight: 0,
        radius: a,
      });
      // It flies on through the air (gravity, drag, the wind) until it is back at the water.
      const w = contact.velocity,
        start: V3 = [p[0] + heading[0] * contact.travel, p[1], p[2] + heading[1] * contact.travel],
        land = skipFlight(start, w, a, rs, {
          time: time + contact.duration,
          ...(options.water ? { water: options.water } : {}),
          ...(options.wind ? { wind: options.wind } : {}),
          ...(options.drag !== undefined ? { drag: options.drag } : {}),
        });
      time += contact.duration + land.time;
      p = land.position;
      v = land.velocity;
      if (Math.hypot(w[0], w[1], w[2]) < 5) break;
      continue;
    }
    const seal = cavitySeal(a),
      pinch = 0.5 * entryDepth(U, a, rs, seal),
      columnSpeed = Math.sqrt(2 * G * pinch);
    out.push({
      kind: 'entry',
      time,
      position: p,
      speed: U,
      angle,
      heading,
      crownSpeed,
      crownHeight,
      columnDelay: seal,
      columnSpeed,
      columnHeight: dragLimitedHeight(columnSpeed, COLUMN_DROP_FALL),
      radius: a,
    });
    break;
  }
  return out;
}

/** What a ShotSplash drives: a particle emitter whose `options` are read every frame and that can `burst`; a `VFX` fits. */
export interface ShotSplashParticles {
  options: {
    position?: Vec3;
    velocity?: Vec3;
    rate?: number;
    emissionExtent?: Vec3;
    spread?: number;
    size?: number;
    lifetime?: readonly [number, number];
    ground?: number;
    /** The wind the weather writes (`[x, z]` or a field): the skips fly in it unless the splash has its own. */
    wind?: unknown;
  };
  burst(count: number): unknown;
}
/** The three emitters of one splash slot. */
export type SplashKind = 'crown' | 'column' | 'mist';
/** One kind's emitter settings in {@link SPLASH_EMITTERS}: the `VFX.attach` options it sets. */
export interface SplashEmitterOptions {
  capacity: number;
  rate: number;
  gravity: [number, number, number];
  size: number;
  color: [number, number, number, number];
  lifetime: [number, number];
  turbulence: number;
  bounce: number;
}
/**
 * Emitter settings for each kind, as `VFX.attach` options (`@margoengine/vfx`): pass `(kind) => VFX.attach(engine,
 * SPLASH_EMITTERS[kind])`. Spray falls under gravity; the mist hangs and drifts in the wind (the weather's, through
 * its `WeatherDrive`).
 */
export const SPLASH_EMITTERS: Readonly<Record<SplashKind, SplashEmitterOptions>> = Object.freeze({
  crown: {
    capacity: 3000,
    rate: 0,
    gravity: [0, -G, 0],
    size: 0.35,
    color: [0.92, 0.95, 0.97, 0.75],
    lifetime: [1, 2],
    turbulence: 0.3,
    bounce: 0,
  },
  column: {
    capacity: 3000,
    rate: 0,
    gravity: [0, -G, 0],
    size: 0.9,
    color: [0.9, 0.93, 0.95, 0.6],
    lifetime: [1, 2],
    turbulence: 0.5,
    bounce: 0,
  },
  mist: {
    capacity: 1500,
    rate: 0,
    gravity: [0, -0.3, 0],
    size: 3,
    color: [0.88, 0.9, 0.92, 0.18],
    lifetime: [4, 7],
    turbulence: 0.6,
    bounce: 0,
  },
});

/** The look of a {@link ShotSplash}; every value is read each frame. */
export interface ShotSplashLook {
  /** Multiples of the crown's, column's and mist's particle counts. */
  crown: number;
  column: number;
  mist: number;
  /** Multiple of the drawn heights (the laws' heights at 1). */
  height: number;
  /** Foam ring width as a multiple of its law, 0 for none, and its life in seconds. */
  foamWidth: number;
  foamLife: number;
  /** How far a splash follows the `water`: 1 rises from the surface height and throws the surface velocity, 0 the impact at rest. */
  waveLift: number;
}
/** The defaults of {@link ShotSplashLook}: every law at its own size, foam that fades over 25 s, spray that rides the waves. */
export const SHOT_SPLASH_DEFAULTS: Readonly<ShotSplashLook> = Object.freeze({
  crown: 1,
  column: 1,
  mist: 1,
  height: 1,
  foamWidth: 1,
  foamLife: 25,
  waveLift: 1,
});
const LOOK_RANGES: Record<keyof ShotSplashLook, [number, number]> = {
  crown: [0, 10],
  column: [0, 10],
  mist: [0, 10],
  height: [0, 5],
  foamWidth: [0, 10],
  foamLife: [0.5, 600],
  waveLift: [0, 1],
};

/**
 * A splash the physics worked out, as `EntrySolver.splashes()` of `@margoengine/physics/entry` lists them: a body
 * striking the water against its local surface and relative to the waves' motion (`entry`), its cavity's deep seal
 * throwing the jet (`seal`), its breaking out from under (`exit`), a glance off (`skip`).
 */
export interface PhysicsSplash {
  kind: 'entry' | 'seal' | 'exit' | 'skip';
  row: number;
  time: number;
  position: readonly [number, number, number];
  velocity: readonly [number, number, number];
  speed: number;
  /** The sine of its angle to the surface. */
  sine: number;
  radius: number;
  crownSpeed: number;
  crownHeight: number;
  columnSpeed: number;
  columnHeight: number;
}

/** A {@link PhysicsSplash} as ShotSplash draws it: an entry or skip's crown, a seal's jet or an exit's lifted water as a column. */
export function splashOf(e: PhysicsSplash): SplashEvent {
  const h = Math.hypot(e.velocity[0], e.velocity[2]),
    heading: [number, number] = h > 0 ? [e.velocity[0] / h, e.velocity[2] / h] : [1, 0],
    column = e.kind === 'seal' || e.kind === 'exit';
  return {
    // A seal or an exit is drawn as an entry's column, at once.
    kind: e.kind === 'skip' ? 'skip' : 'entry',
    time: e.time,
    position: [e.position[0], e.position[1], e.position[2]],
    speed: e.speed,
    angle: Math.asin(Math.min(1, Math.max(0, e.sine))),
    heading,
    crownSpeed: column ? 0 : e.crownSpeed,
    crownHeight: column ? 0 : e.crownHeight,
    columnDelay: 0,
    columnSpeed: column ? e.columnSpeed : 0,
    columnHeight: column ? e.columnHeight : 0,
    radius: e.radius,
  };
}

/** `ShotSplash` settings. */
export interface ShotSplashOptions {
  /**
   * Splashes the physics works out (an `EntrySolver` of `@margoengine/physics/entry`, its `splashes()` read every frame),
   * drawn as they fall due on the splash clock, which runs on the world's time: each entry against the local surface and
   * relative to the waves, its cavity's seal and jet, exits and skips. Use it for bodies the physics carries; `source`
   * plans a shot's fall on its own, on the plane of each impact.
   */
  splashes?: { splashes(): readonly PhysicsSplash[] };
  /** Where the impacts come from: a `Battery` (its `impacts()`, read every frame) or a list. */
  source?: { impacts(): readonly ShotImpact[] } | readonly ShotImpact[];
  /** Makes each slot's emitters: `(kind, slot) => VFX.attach(engine, SPLASH_EMITTERS[kind])`. Called at attach. */
  particles: (kind: SplashKind, slot: number) => ShotSplashParticles;
  /** Splashes drawn at once (the oldest slot is reused). Read at attach. Default 6, at most 32. */
  slots?: number;
  /** The Water whose surface takes the foam rings (attach the Water first). Default none. */
  surface?: Water;
  /**
   * The water (a `WaveQuery`): its height between skips and, read every frame, the height each splash rises from and
   * the surface velocity its spray carries (`look.waveLift`). Default the plane of each impact, at rest.
   */
  water?: WaterHeightSource;
  /** The wind the skipping shot flies in. Default the one the weather wrote on the spray, else none. */
  wind?: SplashWind;
  /** Most skips a shot makes. Default 8. */
  maxSkips?: number;
  look?: Partial<ShotSplashLook>;
}
/** One splash as drawn now, from {@link ShotSplash.active}. */
export interface ActiveSplash {
  event: SplashEvent;
  slot: number;
  age: number;
}

let sequence = 0;
const RING_FLOATS = 4;
const FOAM_WGSL = /* wgsl */ `
struct ShotFoam {head:vec4f,rings:array<vec4f,${MAX_SPLASH_RINGS}>}
fn shotFoam(p:vec2f)->f32 {
 var foam=0.0;
 for(var k=0u;k<u32(shotFoamData.head.x);k++){
  let r=shotFoamData.rings[k];let d=length(p-r.xy);let radius=r.z;let s=r.w;
  if(radius<=0.0||s<=0.0){continue;}
  // A disc of churned white water, whitest at its spreading rim.
  let disc=1.0-smoothstep(0.55*radius,radius,d);let rim=exp(-pow((d-0.85*radius)/(0.18*radius+0.05),2.0));
  foam=max(foam,s*clamp(0.55*disc+0.6*rim,0.0,1.0));
 }
 return foam;
}
`;
const foamShader = (code: string, binding: number): string => {
  const foamLine = 'var foam=max(fresh,surfFoam);';
  if (!code.includes(foamLine))
    throw fault('state', 'ShotSplash found no place in the Water shader for its foam; update @margoengine/water');
  return `
@group(0) @binding(${binding}) var<uniform> shotFoamData:ShotFoam;
${FOAM_WGSL}${code.replace(foamLine, `${foamLine}foam=max(foam,shotFoam(i.world.xz)*pattern);`)}`;
};
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Splashes for every shot that reaches the water: each impact is planned into skips and an entry
 * ({@link planSplashes}); at each one a slot's emitters throw the crown (a burst launched to the drop-limited height
 * of the sheet speed), an entry's column (the jet, from the deep seal on, launched to its height) and the mist, and the
 * Water shows a ring of foam that spreads and fades. A function of the clock: a film seek replays it.
 */
export class ShotSplash implements EnginePlugin {
  readonly name = 'water:shot-splash-' + sequence++;
  readonly look: ShotSplashLook;
  readonly slots: {
    crown: ShotSplashParticles;
    column: ShotSplashParticles;
    mist: ShotSplashParticles;
    event: SplashEvent | null;
    used: number;
  }[] = [];
  /** Every splash planned so far, in time order. */
  readonly events: SplashEvent[] = [];
  readonly options: ShotSplashOptions;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private remove?: () => void;
  private removeDispose?: () => void;
  private disposed = false;
  private clock = 0;
  private seen = 0;
  private fired = 0;
  /** The last physics splash taken: its time and how many at that time. */
  private physicsTime = -Infinity;
  private physicsAtTime = 0;
  private readonly values = new Float32Array(4 + MAX_SPLASH_RINGS * RING_FLOATS);
  constructor(options: ShotSplashOptions) {
    if (!options || typeof options.particles !== 'function')
      throw typeError('ShotSplash needs particles: (kind, slot) => emitter (a VFX)', 'geometry');
    if (options.splashes !== undefined && typeof options.splashes?.splashes !== 'function')
      throw typeError('ShotSplash splashes come from an EntrySolver (its splashes()); pass one or none', 'geometry');
    this.options = options;
    this.look = { ...SHOT_SPLASH_DEFAULTS };
    this.setLook(options.look ?? {});
    const n = finite(options.slots ?? 6, 1, 32, 'slots');
    if (!Number.isInteger(n)) throw rangeError('ShotSplash slots must be a whole number', 'geometry');
    for (let i = 0; i < n; i++) {
      const make = (kind: SplashKind) => {
        const e = options.particles(kind, i);
        if (!e || typeof e.burst !== 'function' || typeof e.options !== 'object')
          throw typeError(
            'ShotSplash particles must return an emitter with options and burst(count), such as a VFX',
            'geometry',
          );
        e.options.rate = 0;
        return e;
      };
      this.slots.push({ crown: make('crown'), column: make('column'), mist: make('mist'), event: null, used: -1 });
    }
  }
  /** Same as `engine.use(new ShotSplash(options))`. */
  static attach(engine: EngineKernel, options: ShotSplashOptions): ShotSplash {
    const s = new ShotSplash(options);
    engineRuntime(engine).use(s);
    return s;
  }
  setLook(look: Partial<ShotSplashLook>): this {
    for (const [key, value] of Object.entries(look ?? {})) {
      const range = LOOK_RANGES[key as keyof ShotSplashLook];
      if (!range) throw typeError(`Unknown shot splash look ${key}; use a name of SHOT_SPLASH_DEFAULTS`, 'geometry');
      (this.look as unknown as Record<string, number>)[key] = finite(value, range[0], range[1], key);
    }
    return this;
  }
  /** Adds an impact by hand (one the source does not list). */
  add(impact: ShotImpact): this {
    this.plan(impact);
    return this;
  }
  private plan(impact: ShotImpact): void {
    const own = this.options.wind ?? this.slots[0]?.crown.options.wind,
      wind =
        Array.isArray(own) || (own && typeof (own as { sample?: unknown }).sample === 'function')
          ? (own as SplashWind)
          : undefined,
      list = planSplashes(impact, {
        maxSkips: this.options.maxSkips ?? 8,
        ...(this.options.water ? { water: this.options.water } : {}),
        ...(wind ? { wind } : {}),
      });
    for (const e of list) {
      let i = this.events.length;
      while (i > this.fired && this.events[i - 1]!.time > e.time) i--;
      this.events.splice(i, 0, e);
    }
  }
  /** Queues the physics splashes not taken yet (those after the last one taken, in their order). */
  private takePhysics(list: readonly PhysicsSplash[]): void {
    let atTime = 0;
    for (const p of list) {
      if (p.time < this.physicsTime) continue;
      if (p.time === this.physicsTime) {
        if (++atTime <= this.physicsAtTime) continue;
        this.physicsAtTime = atTime;
      } else {
        this.physicsTime = p.time;
        this.physicsAtTime = atTime = 1;
      }
      const e = splashOf(p);
      let i = this.events.length;
      while (i > this.fired && this.events[i - 1]!.time > e.time) i--;
      this.events.splice(i, 0, e);
    }
  }
  /** Seconds on the splash clock. */
  get time(): number {
    return this.clock;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /** The splashes drawn now (their slot and age). */
  active(): ActiveSplash[] {
    return this.slots.flatMap((s, slot) => (s.event ? [{ event: s.event, slot, age: this.clock - s.event.time }] : []));
  }
  /**
   * Puts the splash clock back to 0 with no splash planned or drawn and every emitter's rate at 0, as a fresh one has
   * them; impacts the source lists are planned again as the clock reaches them, and ones added by hand are dropped,
   * so a later `seek` (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh
   * world seeked there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.clock = 0;
    this.seen = 0;
    this.fired = 0;
    this.events.length = 0;
    this.physicsTime = -Infinity;
    this.physicsAtTime = 0;
    for (const slot of this.slots) {
      slot.event = null;
      slot.used = -1;
      slot.crown.options.rate = slot.column.options.rate = slot.mist.options.rate = 0;
    }
  }
  /**
   * Moves the clock by `delta` seconds (CPU only, so a seek replays it): takes new impacts from the source, throws the
   * crown and mist of every splash that falls due and runs each column while its jet rises.
   */
  advanceTime(delta: number): void {
    if (this.disposed) return;
    this.clock += delta > 0 ? delta : 0;
    const src = this.options.source,
      list = src
        ? 'impacts' in src && typeof src.impacts === 'function'
          ? src.impacts()
          : (src as readonly ShotImpact[])
        : [];
    for (; this.seen < list.length; this.seen++) this.plan(list[this.seen]!);
    if (this.options.splashes) this.takePhysics(this.options.splashes.splashes());
    const look = this.look;
    while (this.fired < this.events.length && this.events[this.fired]!.time <= this.clock) {
      const e = this.events[this.fired++]!;
      let slot = this.slots.find((s) => !s.event);
      if (!slot) slot = this.slots.reduce((a, b) => (a.used <= b.used ? a : b));
      slot.event = e;
      slot.used = this.fired;
      const height = e.crownHeight * look.height,
        up = Math.sqrt(2 * G * height),
        side = up * 0.45,
        energy = Math.min(1, (e.radius / 0.08) ** 2 * (e.crownSpeed / 60)),
        [sea, wv] = this.surface(e.position),
        lean = e.kind === 'skip' ? 0.8 : 0.3;
      // No crown to throw (a column alone, or the look's height at 0): its emitters are left as they are, since a
      // drop thrown nowhere has no lifetime an emitter takes.
      if (height > 0) {
        const c = slot.crown.options;
        c.position = [e.position[0], sea + 0.05, e.position[2]];
        // The sheet rises round the shot's hole and leans the way the shot went, in the frame of the water it leaves;
        // drops fall back as soon as they rise.
        c.velocity = [e.heading[0] * side * lean + wv[0], up + wv[1], e.heading[1] * side * lean + wv[2]];
        c.spread = side;
        c.emissionExtent = [e.radius * 6, 0.05, e.radius * 6];
        c.lifetime = [(1.6 * up) / G, (2 * up) / G + 0.05];
        c.ground = -1e9;
        slot.crown.burst(Math.round(Math.min(3000, 600 * energy * look.crown)));
        const m = slot.mist.options;
        m.position = [e.position[0], sea + height * 0.3, e.position[2]];
        m.velocity = [e.heading[0] * 1.5 + wv[0], up * 0.15 + wv[1], e.heading[1] * 1.5 + wv[2]];
        m.spread = Math.max(0.5, side * 0.15);
        m.emissionExtent = [height * 0.3, height * 0.2, height * 0.3];
        slot.mist.burst(Math.round(Math.min(1500, 120 * energy * look.mist)));
      }
    }
    // Columns run from the deep seal while the jet rises, a third of its flight.
    for (const slot of this.slots) {
      const e = slot.event,
        k = slot.column.options;
      if (!e) {
        k.rate = 0;
        continue;
      }
      const age = this.clock - e.time,
        life = Math.max(look.foamLife, e.columnDelay + (2 * e.columnSpeed) / G + 8);
      if (age > life) {
        slot.event = null;
        k.rate = 0;
        continue;
      }
      if (e.kind !== 'entry' || look.column <= 0 || !(e.columnSpeed > 0)) {
        k.rate = 0;
        continue;
      }
      const height = e.columnHeight * look.height,
        up = Math.sqrt(2 * G * height),
        run = Math.max(0.15, up / (3 * G)),
        on = age >= e.columnDelay && age < e.columnDelay + run;
      // The jet rides the wave it rises from, frame by frame.
      const [level, kv] = this.surface(e.position);
      k.position = [e.position[0], level + 0.1, e.position[2]];
      k.velocity = [kv[0], up + kv[1], kv[2]];
      k.spread = up * 0.08;
      k.emissionExtent = [e.radius * 3, 0.1, e.radius * 3];
      k.lifetime = [(1.7 * up) / G, (2 * up) / G + 0.05];
      k.ground = -1e9;
      k.rate = on ? Math.min(20000, (1200 * look.column * Math.min(1, (e.radius / 0.08) ** 2)) / run) : 0;
    }
  }
  /**
   * The water at a splash now, from `water`: the height it rises from and the velocity its spray carries, each by
   * `look.waveLift` between the impact at rest (0) and the surface (1). The impact's own height at rest with no `water`.
   */
  surface(position: Vec3): [number, V3] {
    const s = this.options.water?.sample(position[0], position[2]),
      lift = this.look.waveLift;
    if (!s || !Number.isFinite(s.height)) return [position[1], [0, 0, 0]];
    const u = s.velocity,
      moving = u !== undefined && u.length >= 3 && [0, 1, 2].every((i) => Number.isFinite(u[i]!)),
      velocity: V3 = moving ? [u[0]! * lift + 0, u[1]! * lift + 0, u[2]! * lift + 0] : [0, 0, 0];
    return [position[1] + (s.height - position[1]) * lift, velocity];
  }
  /** The foam rings now: [x, z, radius, strength] each, newest first, at most {@link MAX_SPLASH_RINGS}. */
  rings(): [number, number, number, number][] {
    const out: [number, number, number, number][] = [],
      look = this.look;
    if (look.foamWidth <= 0) return out;
    for (let i = this.fired - 1; i >= 0 && out.length < MAX_SPLASH_RINGS; i--) {
      const e = this.events[i]!,
        age = this.clock - e.time;
      if (age > look.foamLife * 3) break;
      // Margo's ring: as wide as the crown's fall-out (its drops land about their height out) and spreading slowly.
      const radius = look.foamWidth * (Math.max(1, 0.6 * e.crownHeight) + 0.15 * age),
        strength = Math.exp(-age / look.foamLife) * smoothstep(0, 0.15, age);
      if (strength > 0.01) out.push([e.position[0], e.position[2], radius, strength]);
    }
    return out;
  }
  /** Fills the foam uniform from {@link rings}. */
  build(): Float32Array {
    const v = this.values,
      rings = this.rings();
    v.fill(0);
    v[0] = rings.length;
    rings.forEach((r, i) => v.set(r, 4 + i * RING_FLOATS));
    return v;
  }
  /** The foam drawn at world XZ, 0..1, as the GPU draws it (before the Water's foam pattern). */
  sample(x: number, z: number): number {
    let foam = 0;
    for (const [rx, rz, radius, s] of this.rings()) {
      const d = Math.hypot(x - rx, z - rz),
        disc = 1 - smoothstep(0.55 * radius, radius, d),
        rim = Math.exp(-(((d - 0.85 * radius) / (0.18 * radius + 0.05)) ** 2));
      foam = Math.max(foam, s * Math.min(1, Math.max(0, 0.55 * disc + 0.6 * rim)));
    }
    return foam;
  }
  setup(engine: Engine): void {
    if (this.disposed) throw fault('disposed', 'ShotSplash disposed; create another ShotSplash');
    this.engine = engine;
    const surface = this.options.surface;
    if (!surface) return;
    if (!engine.gpu)
      throw fault('unsupported', 'ShotSplash foam needs WebGPU or the full WebGL2 compatibility layer', 'webgpu');
    if (!engine.hasPlugin(surface.name))
      throw fault('state', 'Attach the Water surface to this engine before ShotSplash');
    if (surfaceEffects.get(surface)?.some((e) => e.key === 'shot-splash'))
      throw fault('attached', 'This Water already has a ShotSplash; give it more slots', 'state');
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const resources = [{ buffer: this.uniform }];
    this.remove = addSurfaceEffect(surface, {
      key: 'shot-splash',
      vertex: false,
      count: 1,
      shader: (code, binding) => foamShader(code, binding),
      prepare: (c: Context) => {
        if (c.device !== this.engine?.gpu)
          throw fault('state', 'ShotSplash and Water must use the same engine; attach both to one engine');
        c.device.queue.writeBuffer(this.uniform!, 0, this.build());
        return resources;
      },
    });
    this.removeDispose = surface.onDispose(() => this.dispose());
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.engine = undefined;
    this.setup(engine);
  }
  private release(): void {
    this.remove?.();
    this.removeDispose?.();
    this.remove = this.removeDispose = undefined;
    this.uniform?.destroy();
    this.uniform = undefined;
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
