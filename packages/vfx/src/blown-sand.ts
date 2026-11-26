/// <reference lib="esnext.disposable" preserve="true" />
// Wind-blown sand: saltation streamers drifting low over the sand, spindrift streaming off dune crests, and the thin
// haze sheet of moving sand near the ground, where the wind over a terrain is above the threshold of motion.
//
// Sources (papers and books, read as text; no code; docs/clean-room.md "Wind-blown sand"):
// - R. A. Bagnold, "The Physics of Blown Sand and Desert Dunes", Methuen, London, 1941: the fluid threshold shear
//   velocity u*t = A sqrt(((rho_s - rho_a) / rho_a) g d) with A = 0.1, the logarithmic wind profile above the bed, and
//   the flow separating at a dune brink so grains blown over it fly out over the slip face instead of following it.
// - J. F. Kok, E. J. R. Parteli, T. I. Michaels and D. B. Karam, "The physics of wind-blown sand and dust", Reports on
//   Progress in Physics 75(10), 106901, 2012, https://doi.org/10.1088/0034-4885/75/10/106901: the flux law
//   q ~ u*^3 (1 - u*t^2 / u*^2) (Owen 1964, Kawamura 1951), saltation confined to the lowest decimetres with the flux
//   falling about exponentially with height, grain speeds of a few metres a second nearly independent of u*, and
//   turbulence making transport intermittent near the threshold.
// - R. S. Anderson and P. K. Haff, "Simulation of eolian saltation", Science 241(4867), 820-823, 1988,
//   https://doi.org/10.1126/science.241.4867.820: saltation responds to wind changes within about a second, so each
//   streak follows the wind of the moment it was born.
// - G. Sauermann, K. Kroy and H. J. Herrmann, "Continuum saltation model for sand dunes", Phys. Rev. E 64, 031305,
//   2001, https://doi.org/10.1103/PhysRevE.64.031305, and K. Kroy, G. Sauermann and H. J. Herrmann, "Minimal model for
//   sand dunes", Phys. Rev. Lett. 88, 054301, 2002: the shear stress over a dune is the flat value times
//   1 + A (H[h'] + B h'), H the Hilbert transform of the slope along the wind (from P. S. Jackson and J. C. R. Hunt,
//   "Turbulent wind flow over a low hill", QJRMS 101, 929-955, 1975), largest just upwind of the crest and zero in the
//   separation bubble behind the brink.
// - O. Duran and H. J. Herrmann, "Modelling of saturated sand flux", J. Stat. Mech. P07011, 2006,
//   https://doi.org/10.1088/1742-5468/2006/07/P07011: the flux saturates over a length of metres, so a streak of
//   moving sand is metres long, not a point.
// - A. C. W. Baas and D. J. Sherman, "Formation and behavior of aeolian streamers", J. Geophys. Res. 110, F03011, 2005,
//   https://doi.org/10.1029/2004JF000270: streamers about 0.2 m wide and about 1 m apart, carried by gusts descending
//   from large eddies and swept downwind with them (here a gust and streamer field frozen in the mean flow, G. I.
//   Taylor's hypothesis).
// - N. Lancaster, "Variations in wind velocity and sand transport on the windward flanks of desert sand dunes",
//   Sedimentology 32, 581-593, 1985: crest wind speed-up of about 1.1 to 2 over the upwind flat.
// - D. J. Sherman and E. J. Farrell, "Aerodynamic roughness lengths over movable beds", J. Geophys. Res. 113, F02S08,
//   2008: a rippled sand bed at rest has a roughness length of order 0.1 mm (Bagnold's d / 30 is for a flat bed).
// - Rendering: W. T. Reeves, "Particle systems", ACM TOG 2(2), 1983 (particles as functions of their age); N.
//   Tatarchuk, "Artist-directable real-time rain rendering in city environments", SIGGRAPH 2006 course (streaks whose
//   place is a pure function of time and a per-particle seed, cycled in a region that follows the camera); T. Lorach,
//   "Soft Particles", NVIDIA 2007 (the depth fade); the large-grain phase function as half diffraction peak (a
//   Henyey-Greenstein lobe, L. G. Henyey and J. L. Greenstein, ApJ 93, 70-83, 1941) and half Lambert sphere (H. N.
//   Russell, ApJ 43, 173-196, 1916).
import type { EngineKernel } from '@margoengine/core';
import type { Engine, EnginePlugin, FrameGraph, PassContext } from '@margoengine/core/extension';
import { parseColor, type ColorInput } from '@margoengine/math/color';
import { viewMatrix } from '../../shared/view.js';
import { applyView, viewRect } from '../../shared/view-rect.js';
import { soft, softDepthWgsl } from './soft.js';
import { requireWebGPU } from '../../shared/require-webgpu.js';
import { unitLight } from '../../shared/unit-light.js';

export type { ColorInput } from '@margoengine/math/color';
type Vec3 = readonly [number, number, number];
type Context = Extract<PassContext, { backend: 'webgpu' }>;
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number; VERTEX: number };

/** Ground heights on a grid, metres, row by row along x. */
export interface BlownSandHeights {
  readonly samples: ArrayLike<number>;
  readonly width: number;
  readonly depth: number;
  /** Metres between samples. Default 1. */
  readonly cellSize?: number;
  /** World x and z of the first sample. Default [0, 0]. */
  readonly origin?: readonly [number, number];
}
/** The ground: a height function of world (x, z) or a grid of heights. */
export type BlownSandGround = ((x: number, z: number) => number) | BlownSandHeights;

/** The wind the sand sees, as `@margoengine/weather`'s `WindOptions` (a `WindField` can be passed as it is). */
export interface BlownSandWind {
  /** Mean speed at `windHeight` (10 m by default), m/s, 0 to 60. */
  readonly speed: number;
  /** Direction the wind blows toward, radians: 0 is +z, pi/2 is +x. Default 0. */
  readonly direction?: number;
  /** Gustiness 0..1, used when `gustiness` is not set. Default 0.35. */
  readonly gust?: number;
  /** Seconds between gusts, 0.5 to 600. Default 8. */
  readonly gustPeriod?: number;
}

/**
 * A sky that lights the scene, as `Sky` from `@margoengine/sky` with `lighting.ambient` or `environment` is: its native
 * PBR hook (WGSL declaring `skyIrradiance(n)` and the sky light map, and their bind group entries).
 */
export interface BlownSandSkyLight {
  pbr(group: number): { readonly declarations: string } | undefined;
  bindings(): GPUBindGroupEntry[];
}

/** Local saltation sampled from a resolved bed, such as `AeolianTransport` from `@margoengine/physics/aeolian`. */
export interface BlownSandTransport {
  /** Changes when the solver updates its field. */
  readonly revision: number;
  /** Horizontal limits in metres, [minX, minZ, maxX, maxZ]. */
  readonly bounds: readonly [number, number, number, number];
  /** Areal moving mass (kg/m²) and horizontal velocity (m/s). */
  sample(x: number, z: number): { readonly mass: number; readonly velocity: readonly [number, number] } | undefined;
}

/** Options of {@link BlownSand}. Read every frame when drawing the particles. */
export interface BlownSandOptions {
  /** The terrain, as a height function or a height grid. Required. */
  ground: BlownSandGround;
  /** Prescribed `{speed, direction, gust, gustPeriod}` or a `WindField`. Required unless `transport` is supplied. */
  wind?: BlownSandWind | { readonly options: BlownSandWind };
  /** Live saltation for blowing sand or snow. When set, the renderer uses the solver's mass and velocity. */
  transport?: BlownSandTransport;
  /** Moving mass for half-strength opacity with live transport, kg/m². Default 0.02. */
  referenceMass?: number;
  /** Share of the ground that can lose sand, 0..1 at world (x, z): 0 where it is wet, grassed or paved. Default all 1. */
  mask?: ((x: number, z: number) => number) | null;
  /** Density of the blowing sand, 0 (none) to 1. Default 1. */
  amount?: number;
  /** Wind speed at `windHeight` at which dry sand starts to move, m/s. Default {@link sandThreshold} of `grainSize` (6.6 m/s for 0.25 mm sand). */
  threshold?: number;
  /** Grain diameter for the default threshold, metres, 0.00006 to 0.002. Default 0.00025 (medium sand). */
  grainSize?: number;
  /** Height the wind speed is given at, metres, 0.5 to 100. Default 10 (the standard anemometer height). */
  windHeight?: number;
  /** Grain colour (albedo): hex is sRGB, an [r, g, b] array linear. Default [0.5, 0.42, 0.29], terrain's dry sand. */
  color?: ColorInput;
  /** Length of a streak of moving sand, metres, 0.05 to 5. Default 0.6. */
  streak?: number;
  /** Height under which most moving sand travels, metres, 0.02 to 3. Default 0.3; crest plumes rise to about 4 times it. */
  height?: number;
  /** Opacity, 0..1. Default 0.6. */
  opacity?: number;
  /** How far gusts swing the wind, 0..1. Default the wind's `gust`, else 0.35. */
  gustiness?: number;
  /** Seed: the same seed and time draw the same sand. Default 1. */
  seed?: number;
  /** Most particles drawn, 1 to 1,048,576. Default 32,768. */
  limit?: number;
  /** Radius around the camera with blowing sand, metres, 10 to 2,000. Default 250. */
  range?: number;
  /** Exponential fog density the sand fades by with distance, per metre, 0 to 1. Default 0. */
  fog?: number;
  /** World units over which the sand fades in front of the surface behind it (needs `depth`); 0 is off. Default 0. */
  softness?: number;
  /** The scene depth for `softness`: `() => depthTexture.texture` with `DepthTexture` from `@margoengine/post/depth`. */
  depth?: () => GPUTexture | undefined;
  /**
   * The sky that lights the scene (a `Sky` with `lighting.ambient` or `environment`): the grains take its diffuse light
   * (the mean of its irradiance over all directions) and, through their forward diffraction, the sky behind them, as
   * the ground does. Default none: the engine's ambient term (`lighting.radiance[3]` times `lighting.ambient`).
   */
  sky?: BlownSandSkyLight | null;
}

/** One setting of {@link BLOWN_SAND_SETTINGS}: its default, range or values, unit and meaning. */
export interface BlownSandSetting {
  readonly default: unknown;
  readonly range?: readonly [number, number];
  readonly unit?: string;
  readonly about: string;
}

/** Earth's gravity, quartz and sea-level air (ISA, 15 C): the default threshold's constants. */
const G = 9.81,
  QUARTZ = 2650,
  AIR = 1.225,
  KARMAN = 0.4;

/**
 * Wind speed at `height` metres (default 10) at which dry sand of `grainSize` metres (default 0.25 mm) starts to move:
 * Bagnold's fluid threshold u*t = 0.1 sqrt(((rho_s - rho_a) / rho_a) g d) carried up the logarithmic profile
 * u(z) = (u*t / 0.4) ln(z / z0), over a rippled bed of roughness `roughness` (default 0.1 mm).
 */
export function sandThreshold(grainSize = 0.00025, height = 10, roughness = 0.0001): number {
  if (!(grainSize >= 0.00006 && grainSize <= 0.002))
    throw new RangeError(`sandThreshold grainSize is ${grainSize}; pass 0.00006 to 0.002 m`);
  if (!(height >= 0.5 && height <= 100)) throw new RangeError(`sandThreshold height is ${height}; pass 0.5 to 100 m`);
  if (!(roughness > 0 && roughness < height))
    throw new RangeError(`sandThreshold roughness is ${roughness}; pass above 0 and below the height`);
  const shear = 0.1 * Math.sqrt(((QUARTZ - AIR) / AIR) * G * grainSize);
  return (shear / KARMAN) * Math.log(height / roughness);
}

/** The settings of {@link BlownSand}, as data: default, range, unit and meaning of each (for tools and scene settings). */
export const BLOWN_SAND_SETTINGS: Readonly<Record<string, BlownSandSetting>> = Object.freeze({
  referenceMass: { default: 0.02, unit: 'kg/m²', about: 'moving mass at half-strength opacity with live transport' },
  amount: { default: 1, range: [0, 1], about: 'density of the blowing sand (0 none)' },
  threshold: {
    default: 'sandThreshold(grainSize)',
    range: [0, 60],
    unit: 'm/s',
    about: 'wind speed at windHeight at which sand starts to move',
  },
  grainSize: {
    default: 0.00025,
    range: [0.00006, 0.002],
    unit: 'm',
    about: 'grain diameter for the default threshold',
  },
  windHeight: { default: 10, range: [0.5, 100], unit: 'm', about: 'height the wind speed is given at' },
  color: { default: [0.5, 0.42, 0.29], about: 'grain albedo, linear RGB (terrain dry sand)' },
  streak: { default: 0.6, range: [0.05, 5], unit: 'm', about: 'length of a streak of moving sand' },
  height: {
    default: 0.3,
    range: [0.02, 3],
    unit: 'm',
    about: 'height under which most sand moves; crest plumes rise about 4 times it',
  },
  opacity: { default: 0.6, range: [0, 1], about: 'opacity' },
  gustiness: { default: 0.35, range: [0, 1], about: 'how far gusts swing the wind (default the wind gust)' },
  seed: { default: 1, about: 'the same seed and time draw the same sand' },
  limit: { default: 32768, range: [1, 1048576], about: 'most particles drawn' },
  range: { default: 250, range: [10, 2000], unit: 'm', about: 'radius around the camera with blowing sand' },
  fog: { default: 0, range: [0, 1], unit: '1/m', about: 'fog density the sand fades by with distance' },
  softness: { default: 0, range: [0, 100], unit: 'm', about: 'fade in front of the surface behind (needs depth)' },
});

// ---- Shared CPU maths: the GPU shader below repeats every line of `particle` (test/blown-sand.test.js pins them). ----

/** PCG hash (M. E. O'Neill, "PCG: A family of simple fast space-efficient statistically good algorithms", 2014). */
function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0,
    w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}
const rand = (a: number, b: number) => pcg((a ^ pcg(b)) >>> 0) / 4294967296;
const lattice = (i: number, j: number, k: number, s: number) =>
  (pcg((Math.imul(i | 0, 73856093) ^ Math.imul(j | 0, 19349663) ^ Math.imul(k | 0, 83492791) ^ s) >>> 0) / 4294967296) *
    2 -
  1;
const fade = (t: number) => t * t * (3 - 2 * t);
/** Value noise in [-1, 1] over (x, y, t). */
function noise(x: number, y: number, t: number, s: number): number {
  const i = Math.floor(x),
    j = Math.floor(y),
    k = Math.floor(t),
    fx = fade(x - i),
    fy = fade(y - j),
    ft = fade(t - k);
  const at = (a: number, b: number, c: number) => lattice(i + a, j + b, k + c, s);
  const plane = (c: number) =>
    (at(0, 0, c) + (at(1, 0, c) - at(0, 0, c)) * fx) * (1 - fy) + (at(0, 1, c) + (at(1, 1, c) - at(0, 1, c)) * fx) * fy;
  return plane(0) + (plane(1) - plane(0)) * ft;
}
const smoothstep = (a: number, b: number, x: number) => fade(Math.min(1, Math.max(0, (x - a) / (b - a))));
/** Owen's flux law over the threshold, saturating: 1 - exp(-1.5 (r^3 - r) / 6), r = u* / u*t; 0 at or below r = 1. */
export function sandFlux(ratio: number): number {
  return ratio > 1 ? 1 - Math.exp((-1.5 * (ratio * ratio * ratio - ratio)) / 6) : 0;
}

/** Metres between the downwind profile samples; a streak travels at most `4 * STEP` along it before it is reborn. */
const STEP = 2;
const TRAVEL = 6;
/** Floats per particle: base xyz + phase, the profile, speed-up + kind + id + lod scale, gradient + 2 spare. */
const FLOATS = 16;
const TILE = 8;
const TEMPLATES = 96;

/** What the frame gives every particle (the shader's uniform). */
interface FrameValues {
  time: number;
  dx: number;
  dz: number;
  speed: number;
  ratio: number;
  gust: number;
  period: number;
  seed: number;
  height: number;
  streak: number;
  physical: boolean;
}

/** Gust factor of the wind at world (x, z) and time t: a field frozen in the mean flow (Taylor), two scales. */
function gustAt(f: FrameValues, x: number, z: number, t: number): number {
  const along = x * f.dx + z * f.dz - f.speed * t,
    across = z * f.dx - x * f.dz,
    scale = Math.max(4, 0.6 * f.speed * f.period);
  return (
    1 +
    f.gust *
      (0.7 * noise(along / scale, across / (scale * 0.5), t / f.period, f.seed) +
        0.3 * noise(along / (scale * 0.3), across / (scale * 0.2), (3.1 * t) / f.period, f.seed ^ 0x5bd1))
  );
}

/** Ground height along the wind `s` metres downwind of a particle's base, from its four profile samples. */
function profileAt(d: ArrayLike<number>, o: number, s: number): number {
  const p = [0, d[o + 4], d[o + 5], d[o + 6], d[o + 7]],
    u = Math.max(0, s) / STEP,
    i = Math.min(3, Math.floor(u));
  return p[i] + (p[i + 1] - p[i]) * (u - i);
}

/** One particle as the shader draws it: centre, axis, half length and width, opacity. */
export interface BlownSandGrain {
  position: [number, number, number];
  /** 0 a streak of saltating sand, 1 spindrift off a crest, 2 a haze sheet. */
  kind: number;
  /** Half length along the wind and half width (metres), before the pixel floor. */
  size: [number, number];
  /** Opacity before the view terms (pixel floor, fog, range fade and soft depth); 0 when no sand moves there. */
  alpha: number;
}

/** The particle `o / FLOATS` of `d` at time `f.time` (the vertex shader's `particle`, in the same order). */
function particle(d: ArrayLike<number>, o: number, f: FrameValues, opacity: number): BlownSandGrain {
  if (f.physical) {
    const vx = d[o + 14],
      vz = d[o + 15],
      speed = Math.hypot(vx, vz);
    f = { ...f, dx: vx / speed, dz: vz / speed, speed };
  }
  const kind = d[o + 9],
    id = d[o + 10] >>> 0,
    lod = d[o + 11],
    r1 = rand(id, 1),
    r2 = rand(id, 2),
    v0 = f.physical ? f.speed : (kind === 1 ? 0.6 : kind === 2 ? 0.45 : 0.5) * f.speed * (0.8 + 0.4 * r2),
    life = Math.min(6, Math.max(0.4, (TRAVEL * (0.6 + 0.4 * r1)) / Math.max(v0, 0.5))),
    c = f.time / life + d[o + 3],
    n = Math.floor(c),
    age = (c - n) * life,
    born = f.time - age,
    cycle = (n + 0x9e37) >>> 0,
    j1 = rand(id ^ cycle, 3),
    j2 = rand(id ^ cycle, 4),
    h1 = rand(id ^ cycle, 5),
    jx = j1 * 0.8,
    jz = (j2 - 0.5) * 0.8,
    bx = d[o] + f.dx * jx - f.dz * jz,
    bz = d[o + 2] + f.dz * jx + f.dx * jz,
    g = f.physical ? 1 : gustAt(f, bx, bz, born),
    v = v0 * Math.max(g, 0),
    s = v * age,
    t01 = age / life,
    wander = 0.12 * Math.sin(age * 2.7 + r2 * 6.283) * Math.min(1, s),
    x = bx + f.dx * s - f.dz * wander,
    z = bz + f.dz * s + f.dx * wander,
    // The ground under the particle: the base profile at the distance travelled, tilted by the jitter across it.
    ground = d[o + 1] + profileAt(d, o, s + jx) + (d[o + 12] * -f.dz + d[o + 13] * f.dx) * jz;
  // Shear velocity over its threshold where it was born: the site's speed-up times the gust, over the threshold ratio.
  const flux = f.physical ? d[o + 8] : sandFlux(f.ratio * d[o + 8] * g);
  let y: number, alpha: number, half: [number, number];
  if (kind === 1) {
    // Spindrift: blown off the brink, the flow separates and the sand flies out over the slip face, spreading.
    const rise = f.height * (0.25 + 3.2 * Math.sqrt(Math.min(s, 8) / 8)) * (0.5 + h1);
    y = Math.max(d[o + 1] + rise, ground + f.height * 0.3);
    half = [f.streak * (0.6 + s / 6) * lod, (0.08 + 0.18 * s) * lod];
    alpha = (flux * smoothstep(0, 0.12, t01) * (1 - smoothstep(0.45, 1, t01)) * 0.55) / (1 + s / 3);
  } else if (kind === 2) {
    // The haze sheet: the saltation curtain seen as a whole, standing on the ground, lifted by each gust front.
    const top = f.height * 1.4 * (0.7 + 0.6 * h1),
      here = f.physical ? flux : sandFlux(f.ratio * d[o + 8] * gustAt(f, x, z, f.time));
    y = ground + top * 0.4;
    half = [(1.4 + 1.4 * r2) * lod, top * 0.6];
    alpha = here * smoothstep(0, 0.25, t01) * (1 - smoothstep(0.7, 1, t01)) * 0.22;
  } else {
    // A streak of saltating sand riding the ground at an exponentially distributed height, inside a streamer.
    const hop = f.height * 0.33 * -Math.log(1 - 0.95 * h1),
      width = 0.05 + 0.2 * r1,
      along = x * f.dx + z * f.dz - 0.5 * f.speed * f.time,
      across = z * f.dx - x * f.dz,
      streamer = f.physical
        ? 1
        : smoothstep(-0.15, 0.45, noise(along / 2.5, across / 0.45, f.time / 1.3, f.seed ^ 0x2c1b));
    half = [f.streak * (0.35 + 0.3 * r2) * lod, width * 0.5 * lod];
    y = ground + Math.max(hop * smoothstep(0, 0.15, t01), half[1] * 0.8);
    alpha = flux * streamer * smoothstep(0, 0.1, t01) * (1 - smoothstep(0.75, 1, t01)) * 0.5;
  }
  return { position: [x, y, z], kind, size: half, alpha: alpha * opacity };
}

/** Speed-up of the shear velocity over flat ground at one place, and the ground's profile along the wind. */
interface Site {
  /** sqrt of the shear stress ratio (0 in the lee bubble or where `mask` is 0). */
  speedUp: number;
  /** Heights 2, 4, 6 and 8 m downwind, relative to the place. */
  profile: [number, number, number, number];
  /** Height gradient (dh/dx, dh/dz). */
  gradient: [number, number];
  /** True on a brink the sand blows off: the ground falls away more than 1 m within 8 m downwind. */
  brink: boolean;
  height: number;
}

/**
 * The shear velocity speed-up at world (x, z) for a wind blowing toward (dx, dz) (a unit vector): the square root of
 * 1 + A (H[h'] + B h'), with the Hilbert transform of the slope along the wind summed over 3, 9 and 27 m either side
 * (Jackson and Hunt 1975; Kroy et al. 2002, A = 3, B = 0.3 here), clamped to 0..3, times a shelter factor that is 0 on
 * a slip face and in its separation bubble (the ground falling faster than 1 in 3 downwind) and the `mask`.
 */
function site(
  height: (x: number, z: number) => number,
  mask: ((x: number, z: number) => number) | null,
  x: number,
  z: number,
  dx: number,
  dz: number,
  physical = false,
): Site {
  const at = (s: number) => height(x + dx * s, z + dz * s),
    h0 = height(x, z),
    slope = (at(1) - at(-1)) / 2;
  let hilbert = 0;
  // (1 / pi) integral of h'(xi) / (x - xi): slopes upwind minus downwind at geometric distances, weight ln 3 each.
  if (!physical)
    for (const L of [3, 9, 27]) {
      const up = (at(-L + 1) - at(-L - 1)) / 2,
        down = (at(L + 1) - at(L - 1)) / 2;
      hilbert += (Math.log(3) * (up - down)) / Math.PI;
    }
  const stress = Math.min(3, Math.max(0, 1 + 3 * (hilbert + 0.3 * slope))),
    shelter = smoothstep(-0.36, -0.2, slope),
    profile = [at(2) - h0, at(4) - h0, at(6) - h0, at(8) - h0] as [number, number, number, number],
    gx = (height(x + 0.5, z) - height(x - 0.5, z)) / 1,
    gz = (height(x, z + 0.5) - height(x, z - 0.5)) / 1,
    m = mask ? Math.min(1, Math.max(0, mask(x, z))) : 1;
  return {
    speedUp: physical ? m : Math.sqrt(stress) * shelter * m,
    profile,
    gradient: [gx, gz],
    brink: profile[3] < -1 && Math.max(...profile) < 0.3 && shelter > 0.5,
    height: h0,
  };
}

/** A height function of the ground option. */
function heightOf(ground: BlownSandGround): (x: number, z: number) => number {
  if (typeof ground === 'function') return ground;
  if (!ground || typeof ground !== 'object')
    throw new TypeError(
      'BlownSand ground must be a height function (x, z) => y or {samples, width, depth, cellSize, origin}',
    );
  const { samples, width, depth } = ground,
    cell = ground.cellSize ?? 1,
    [ox, oz] = ground.origin ?? [0, 0];
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(depth) ||
    width < 2 ||
    depth < 2 ||
    samples.length !== width * depth
  )
    throw new RangeError('BlownSand ground grid needs width and depth of 2 or more and width * depth samples');
  if (!(cell > 0)) throw new RangeError('BlownSand ground cellSize must be above 0');
  return (x, z) => {
    const fx = Math.min(width - 1, Math.max(0, (x - ox) / cell)),
      fz = Math.min(depth - 1, Math.max(0, (z - oz) / cell)),
      i = Math.min(width - 2, Math.floor(fx)),
      j = Math.min(depth - 2, Math.floor(fz)),
      tx = fx - i,
      tz = fz - j,
      a = samples[j * width + i],
      b = samples[j * width + i + 1],
      c = samples[(j + 1) * width + i],
      e = samples[(j + 1) * width + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (e - c) * tx) * tz;
  };
}

/**
 * How much sand the mean wind moves at world (x, z), with no engine: `speedUp` is the shear velocity over that of
 * flat open ground (crests above 1, troughs below, 0 on a slip face, in its lee and where `mask` is 0), `flux` the
 * saturating flux 0..1 of {@link sandFlux} for the mean wind, and `brink` whether spindrift blows off there. The same
 * rule {@link BlownSand} emits by.
 */
export function sandEmission(
  options: Pick<
    BlownSandOptions,
    'ground' | 'wind' | 'mask' | 'threshold' | 'grainSize' | 'windHeight' | 'transport' | 'referenceMass'
  >,
  x: number,
  z: number,
): { speedUp: number; flux: number; brink: boolean } {
  if (options.transport) {
    const motion = options.transport.sample(x, z);
    if (!motion) return { speedUp: 1, flux: 0, brink: false };
    const [vx, vz] = motion.velocity;
    const speed = Math.hypot(vx, vz);
    if (!(motion.mass > 0 && speed >= 1e-10 && Number.isFinite(speed))) return { speedUp: 1, flux: 0, brink: false };
    const here = site(heightOf(options.ground), options.mask ?? null, x, z, vx / speed, vz / speed, true);
    const reference = finite(options.referenceMass, 0.02, 'referenceMass', Number.MIN_VALUE, Number.MAX_VALUE);
    return { speedUp: 1, flux: here.speedUp / (1 + reference / motion.mass), brink: here.brink };
  }
  const w = windOf(options.wind),
    threshold = thresholdOf(options),
    here = site(heightOf(options.ground), options.mask ?? null, x, z, Math.sin(w.direction), Math.cos(w.direction));
  return { speedUp: here.speedUp, flux: sandFlux((w.speed / threshold) * here.speedUp), brink: here.brink };
}

const finite = (value: unknown, fallback: number, label: string, min: number, max: number): number => {
  const v = value === undefined ? fallback : value;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    throw new RangeError(`BlownSand ${label} is ${String(v)}; pass a finite number from ${min} to ${max}`);
  return v;
};
function windOf(input: BlownSandOptions['wind']): Required<BlownSandWind> {
  const w = input && typeof input === 'object' && 'options' in input ? input.options : (input as BlownSandWind);
  if (!w || typeof w !== 'object') throw new TypeError('BlownSand wind must be {speed, direction} or a WindField');
  return {
    speed: finite(w.speed, NaN, 'wind speed', 0, 60),
    direction: finite(w.direction, 0, 'wind direction', -1000, 1000),
    gust: finite(w.gust, 0.35, 'wind gust', 0, 1),
    gustPeriod: finite(w.gustPeriod, 8, 'wind gustPeriod', 0.5, 600),
  };
}
function thresholdOf(o: Pick<BlownSandOptions, 'threshold' | 'grainSize' | 'windHeight'>): number {
  const grain = finite(o.grainSize, 0.00025, 'grainSize', 0.00006, 0.002),
    height = finite(o.windHeight, 10, 'windHeight', 0.5, 100);
  return o.threshold === undefined ? sandThreshold(grain, height) : finite(o.threshold, 0, 'threshold', 1e-6, 60);
}

const shader = (samples: number, encode: boolean, sky: string) => /* wgsl */ `
struct Frame {camera:mat4x4f,eye:vec4f,wind:vec4f,gust:vec4f,shape:vec4f,color:vec4f,light:vec4f,radiance:vec4f,ambient:vec4f,extra:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
${samples ? softDepthWgsl(samples) : ''}${sky}
struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f,@location(1) color:vec4f,@location(2) viewDepth:f32,@location(3) kind:f32}
fn pcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn rnd(a:u32,b:u32)->f32 {return f32(pcg(a^pcg(b)))/4294967296.0;}
fn lattice(i:i32,j:i32,k:i32,s:u32)->f32 {return f32(pcg((bitcast<u32>(i)*73856093u)^(bitcast<u32>(j)*19349663u)^(bitcast<u32>(k)*83492791u)^s))/4294967296.0*2.0-1.0;}
fn fade3(t:vec3f)->vec3f {return t*t*(3.0-2.0*t);}
fn noise(p:vec3f,s:u32)->f32 {
  let c=floor(p);let f=fade3(p-c);let i=vec3i(c);
  let a=mix(mix(lattice(i.x,i.y,i.z,s),lattice(i.x+1,i.y,i.z,s),f.x),mix(lattice(i.x,i.y+1,i.z,s),lattice(i.x+1,i.y+1,i.z,s),f.x),f.y);
  let b=mix(mix(lattice(i.x,i.y,i.z+1,s),lattice(i.x+1,i.y,i.z+1,s),f.x),mix(lattice(i.x,i.y+1,i.z+1,s),lattice(i.x+1,i.y+1,i.z+1,s),f.x),f.y);
  return mix(a,b,f.z);
}
fn flux(r:f32)->f32 {return select(0.0,1.0-exp(-1.5*(r*r*r-r)/6.0),r>1.0);}
fn gustAt(x:f32,z:f32,t:f32)->f32 {
  let d=frame.wind.xy;let along=x*d.x+z*d.y-frame.wind.z*t;let across=z*d.x-x*d.y;let scale=max(4.0,0.6*frame.wind.z*frame.gust.y);let s=u32(frame.gust.w);
  return 1.0+frame.gust.x*(0.7*noise(vec3f(along/scale,across/(scale*0.5),t/frame.gust.y),s)+0.3*noise(vec3f(along/(scale*0.3),across/(scale*0.2),3.1*t/frame.gust.y),s^0x5bd1u));
}
fn profileAt(p:vec4f,s:f32)->f32 {
  let u=max(s,0.0)/${STEP.toFixed(1)};let i=min(3.0,floor(u));let f=u-i;
  let a=select(select(select(p.z,p.y,i<2.5),p.x,i<1.5),0.0,i<0.5);
  let b=select(select(select(p.w,p.z,i<2.5),p.y,i<1.5),p.x,i<0.5);
  return a+(b-a)*f;
}
@vertex fn vertex(@builtin(vertex_index) vi:u32,@location(0) a0:vec4f,@location(1) a1:vec4f,@location(2) a2:vec4f,@location(3) a3:vec4f)->Out {
  var o:Out;o.clip=vec4f(2.0,2.0,2.0,1.0);o.uv=vec2f(0.0);o.color=vec4f(0.0);o.viewDepth=0.0;o.kind=a2.y;
  let physical=frame.extra.z>0.0;let localSpeed=length(a3.zw);
  let d=select(frame.wind.xy,a3.zw/max(localSpeed,1e-10),physical);
  let t=frame.eye.w;let kind=a2.y;let id=u32(a2.z);let lod=a2.w;
  let r1=rnd(id,1u);let r2=rnd(id,2u);
  let v0=select(select(select(0.5,0.45,kind==2.0),0.6,kind==1.0)*frame.wind.z*(0.8+0.4*r2),localSpeed,physical);
  let life=min(6.0,max(0.4,${TRAVEL.toFixed(1)}*(0.6+0.4*r1)/max(v0,0.5)));
  let c=t/life+a0.w;let n=floor(c);let age=(c-n)*life;let born=t-age;
  let cycle=u32(i32(n)+0x9e37);
  let j1=rnd(id^cycle,3u);let j2=rnd(id^cycle,4u);let h1=rnd(id^cycle,5u);
  let jx=j1*0.8;let jz=(j2-0.5)*0.8;
  let bx=a0.x+d.x*jx-d.y*jz;let bz=a0.z+d.y*jx+d.x*jz;
  let g=select(gustAt(bx,bz,born),1.0,physical);let v=v0*max(g,0.0);let s=v*age;let t01=age/life;
  let wander=0.12*sin(age*2.7+r2*6.283)*min(1.0,s);
  let x=bx+d.x*s-d.y*wander;let z=bz+d.y*s+d.x*wander;
  let ground=a0.y+profileAt(a1,s+jx)+(a3.x*-d.y+a3.y*d.x)*jz;
  let fl=select(flux(frame.wind.w*a2.x*g),a2.x,physical);
  let H=frame.shape.y;let streak=frame.shape.x;
  var y:f32;var alpha:f32;var half:vec2f;
  if(kind==1.0){
    let rise=H*(0.25+3.2*sqrt(min(s,8.0)/8.0))*(0.5+h1);
    y=max(a0.y+rise,ground+H*0.3);
    half=vec2f(streak*(0.6+s/6.0)*lod,(0.08+0.18*s)*lod);
    alpha=fl*smoothstep(0.0,0.12,t01)*(1.0-smoothstep(0.45,1.0,t01))*0.55/(1.0+s/3.0);
  }else if(kind==2.0){
    let top=H*1.4*(0.7+0.6*h1);let here=gustAt(x,z,t);
    y=ground+top*0.4;
    half=vec2f((1.4+1.4*r2)*lod,top*0.6);
    alpha=select(flux(frame.wind.w*a2.x*here),fl,physical)*smoothstep(0.0,0.25,t01)*(1.0-smoothstep(0.7,1.0,t01))*0.22;
  }else{
    let hop=-(H*0.33)*log(1.0-0.95*h1);let width=0.05+0.2*r1;
    let along=x*d.x+z*d.y-0.5*frame.wind.z*t;let across=z*d.x-x*d.y;
    let streamer=select(smoothstep(-0.15,0.45,noise(vec3f(along/2.5,across/0.45,t/1.3),u32(frame.gust.w)^0x2c1bu)),1.0,physical);
    half=vec2f(streak*(0.35+0.3*r2)*lod,width*0.5*lod);
    y=ground+max(hop*smoothstep(0.0,0.15,t01),half.y*0.8);
    alpha=fl*streamer*smoothstep(0.0,0.1,t01)*(1.0-smoothstep(0.75,1.0,t01))*0.5;
  }
  alpha*=frame.gust.z;
  let centre=vec3f(x,y,z);let toEye=frame.eye.xyz-centre;let dist=length(toEye);
  alpha*=exp(-frame.extra.y*dist)*(1.0-smoothstep(0.8*frame.extra.x,frame.extra.x,dist));
  if(alpha<=0.0005){return o;}
  // Axes: streaks lie along the wind on the ground's slope with their width turned to the eye; a haze sheet stands up.
  let slope=(profileAt(a1,s+jx+0.5)-profileAt(a1,s+jx-0.5));
  var axis=normalize(vec3f(d.x,select(slope,0.0,kind==1.0),d.y));
  var side=cross(axis,toEye/max(dist,1e-4));
  if(kind==2.0){let r=vec3f(frame.shape.w,0.0,frame.color.w);axis=select(vec3f(1.0,0.0,0.0),normalize(r),length(r)>1e-4);side=vec3f(0.0,1.0,0.0);}
  side=select(vec3f(0.0,1.0,0.0),normalize(side),length(side)>1e-4);
  // A streak thinner than 1.5 px is drawn 1.5 px wide with its opacity scaled by its true width, so it keeps its light.
  let pixels=2.0*half.y*frame.shape.z/max(dist,1e-4);
  if(pixels<1.5){let k=1.5/max(pixels,1e-6);half.y*=k;alpha/=k;}
  let corner=vec2f(f32(vi&1u),f32(vi>>1u))*2.0-1.0;
  let world=centre+axis*corner.x*half.x+side*corner.y*half.y;
  o.clip=frame.camera*vec4f(world,1.0);
  o.uv=corner;
  ${samples ? 'o.viewDepth=dot(soft.plane.xyz,world)+soft.plane.w;' : ''}
  // Light: a grain far larger than the wavelength removes twice its cross-section from a beam; half is diffracted
  // forward whatever its colour (a Henyey-Greenstein lobe, g 0.8), half is reflected by the grain (its albedo, a
  // Lambert sphere). Sun and sky both, the sky as core lights its meshes or from the sky's own light.
  let L=frame.light.xyz;let view=-toEye/max(dist,1e-4);let ct=dot(view,L);
  let hg=(1.0-0.64)/(12.566*pow(1.0+0.64-1.6*ct,1.5));
  let ph=acos(clamp(-ct,-1.0,1.0));let lambert=(2.0/(3.0*9.8696))*(sin(ph)+(3.14159-ph)*cos(ph));
  let beam=frame.radiance.rgb*frame.light.w;
  ${
    sky
      ? `// The sky's light: half the grains' scatter is near isotropic (the mean radiance around them, the mean of the
  // irradiance over six axes) and half is diffraction straight on (the sky behind them along the view), the map taken
  // into the engine light's units by skyLight[9].w as skyIrradiance takes it (KB-SKY-SUNUNITS1).
  let mean=(skyIrradiance(vec3f(1.0,0.0,0.0))+skyIrradiance(vec3f(-1.0,0.0,0.0))+skyIrradiance(vec3f(0.0,1.0,0.0))+skyIrradiance(vec3f(0.0,-1.0,0.0))+skyIrradiance(vec3f(0.0,0.0,1.0))+skyIrradiance(vec3f(0.0,0.0,-1.0)))/6.0;
  let back=textureSampleLevel(skyLightMap,skyLightSampler,vec2f(atan2(view.z,view.x)/6.2831853+0.5,acos(clamp(view.y,-1.0,1.0))/3.14159265),2.0).rgb*skyLight[9].w;
  let ambient=mean;`
      : 'let ambient=frame.radiance.w*frame.ambient.rgb;let back=ambient;'
  }
  // The colour is the sand bed's; one grain alone reflects more than the bed it makes, whose light is the grains'
  // after many bounces: Hapke's (1981) bed reflectance r = (1-g)/(1+g), g = sqrt(1-w), turned round for the grain's w.
  let gamma=(1.0-frame.color.rgb)/(1.0+frame.color.rgb);let albedo=1.0-gamma*gamma;
  o.color=vec4f(0.5*albedo*(beam*lambert+ambient)+0.5*(beam*hg+back),min(alpha,1.0));
  return o;
}
fn encodeSrgb(c:vec3f)->vec3f {return select(1.055*pow(c,vec3f(1.0/2.4))-0.055,c*12.92,c<=vec3f(0.0031308));}
@fragment fn fragment(i:Out)->@location(0) vec4f {
  let u=i.uv;
  // Streaks: soft across, tapered at both ends. Haze: soft at its sides, densest low and thinning upward.
  let streak=pow(max(1.0-u.x*u.x,0.0),1.5)*exp(-4.0*u.y*u.y)*(1.0-smoothstep(0.7,1.0,abs(u.y)));
  let up=u.y*0.5+0.5;
  let haze=pow(max(1.0-u.x*u.x,0.0),2.0)*smoothstep(0.0,0.2,up)*pow(1.0-up,2.0)*1.6;
  var a=i.color.a*select(streak,haze,i.kind==2.0);
  ${samples ? 'a*=clamp(softGap(i.clip,i.viewDepth),0.0,1.0);' : ''}
  var rgb=i.color.rgb;
  ${encode ? 'rgb=encodeSrgb(max(rgb,vec3f(0.0)));' : ''}
  return vec4f(rgb*a,a);
}
`;

const UNIFORM_FLOATS = 56;
let nextId = 0;

/** A tile of particles, cached by its place and level of detail. */
interface Tile {
  data: Float32Array;
  count: number;
}

/**
 * Wind-blown sand over a terrain: streaks of saltating sand drifting low over the ground in streamers, spindrift
 * blowing off dune brinks out over their slip faces, and the haze sheet of moving sand near the ground, wherever the
 * wind (with its gusts and the speed-up over crests and windward slopes) is above the threshold of motion. Particles
 * live in 8 m tiles around the camera, each a pure function of its tile, the seed and the clock, so the same seed and
 * time draw the same sand from any camera path. One instanced draw at frame-graph order 6. WebGPU and the WebGL2
 * compatibility layer.
 */
export class BlownSand implements EnginePlugin {
  readonly name = 'blown-sand:' + nextId++;
  /** Read every frame. */
  readonly options: BlownSandOptions;
  /** Counts of the last drawn frame: tiles and particles drawn, particles past `limit`. */
  readonly stats = { tiles: 0, particles: 0, dropped: 0 };
  private seconds = 0;
  private engine?: Engine;
  private instances?: GPUBuffer;
  private capacity = 0;
  private uniform?: GPUBuffer;
  private owned: { destroy(): void }[] = [];
  private softRuntime?: ReturnType<NonNullable<typeof soft>['create']>;
  private readonly pipelines = new Map<string, GPURenderPipeline>();
  private readonly groups = new Map<GPURenderPipeline, GPUBindGroup>();
  private readonly values = new Float32Array(UNIFORM_FLOATS);
  private readonly view = new Float32Array(16);
  private data = new Float32Array(0);
  private count = 0;
  private uploaded = '';
  private layoutKey = '';
  private readonly tiles = new Map<string, Tile>();
  private height: (x: number, z: number) => number = () => 0;
  private groundSource: unknown = null;
  private maskSource: unknown = null;
  private transportSource?: BlownSandTransport;
  private disposed = false;
  private skyEntries?: GPUBindGroupEntry[];
  private skyPipeline?: GPURenderPipeline;
  private skyGroup?: GPUBindGroup;
  private readonly attachment: GPURenderPassColorAttachment = { view: undefined!, loadOp: 'load', storeOp: 'store' };
  private readonly depthAttachment: GPURenderPassDepthStencilAttachment = { view: undefined!, depthReadOnly: true };

  constructor(options: BlownSandOptions) {
    this.options = options;
    this.validate();
  }
  /** Same as `engine.use(new BlownSand(options))`; returns it. */
  static attach(engine: EngineKernel, options: BlownSandOptions): BlownSand {
    const sand = new BlownSand(options);
    engine.use(sand);
    return sand;
  }
  /** Seconds on the sand's clock: the sum of frame deltas and `advanceTime` calls. Set it to seek a shot. */
  get time(): number {
    return this.seconds;
  }
  set time(seconds: number) {
    this.seconds = finite(seconds, 0, 'time', 0, Number.MAX_VALUE);
  }
  /** Moves the clock by `delta` seconds; the same deltas give the same sand. */
  advanceTime(delta: number): void {
    if (delta > 0) this.seconds += delta;
  }
  onPreUpdate(delta: number): void {
    this.advanceTime(delta);
  }
  /** Back to time 0, as a fresh one with the same options, for several cuts in one process (GAP-FILM-RESET): the sand at the start. */
  resetTime(): void {
    this.seconds = 0;
  }
  private validate() {
    const o = this.options;
    if (!o || typeof o !== 'object') throw new TypeError('BlownSand needs options {ground, wind}');
    heightOf(o.ground);
    if (o.mask != null && typeof o.mask !== 'function')
      throw new TypeError('BlownSand mask must be a function (x, z) => 0..1 or null');
    if (o.sky != null && (typeof o.sky.pbr !== 'function' || typeof o.sky.bindings !== 'function'))
      throw new TypeError('BlownSand sky must have pbr(group) and bindings(), as a Sky from @margoengine/sky does');
    const transport = o.transport;
    if (transport && typeof transport.sample !== 'function')
      throw new TypeError(
        'BlownSand transport needs a sampler; pass an attached AeolianTransport or provide sample(x, z).',
      );
    const wind = windOf(o.wind ?? (transport ? { speed: 0 } : undefined)),
      threshold = thresholdOf(o),
      softness = finite(o.softness, 0, 'softness', 0, 100);
    if (softness > 0 && typeof o.depth !== 'function')
      throw new TypeError(
        'BlownSand softness needs the scene depth; pass depth: () => depthTexture.texture (DepthTexture from @margoengine/post/depth)',
      );
    const limit = finite(o.limit, 32768, 'limit', 1, 1 << 20);
    if (!Number.isInteger(limit)) throw new RangeError(`BlownSand limit is ${limit}; pass a whole number`);
    return {
      wind,
      transport,
      referenceMass: finite(o.referenceMass, 0.02, 'referenceMass', Number.MIN_VALUE, Number.MAX_VALUE),
      threshold,
      softness,
      limit,
      amount: finite(o.amount, 1, 'amount', 0, 1),
      streak: finite(o.streak, 0.6, 'streak', 0.05, 5),
      height: finite(o.height, 0.3, 'height', 0.02, 3),
      opacity: finite(o.opacity, 0.6, 'opacity', 0, 1),
      gustiness: finite(o.gustiness, wind.gust, 'gustiness', 0, 1),
      seed: finite(o.seed, 1, 'seed', -2147483648, 4294967295),
      range: finite(o.range, 250, 'range', 10, 2000),
      fog: finite(o.fog, 0, 'fog', 0, 1),
      color: parseColor(o.color ?? [0.5, 0.42, 0.29]) as number[],
    };
  }
  private frameValues(s: ReturnType<BlownSand['validate']>): FrameValues {
    return {
      time: this.seconds,
      dx: Math.sin(s.wind.direction),
      dz: Math.cos(s.wind.direction),
      speed: s.wind.speed,
      ratio: s.wind.speed / s.threshold,
      gust: s.gustiness,
      period: s.wind.gustPeriod,
      seed: (s.seed >>> 0) & 0xffffff,
      height: s.height,
      streak: s.streak,
      physical: !!s.transport,
    };
  }
  /** Particles of tile (tx, tz) at detail level `level` (2^-level of the templates), built once and cached. */
  private tile(tx: number, tz: number, level: number, s: ReturnType<BlownSand['validate']>, f: FrameValues): Tile {
    const key = `${tx},${tz},${level}`,
      cached = this.tiles.get(key);
    if (cached) return cached;
    const total = Math.round(TEMPLATES * s.amount),
      keep = Math.max(total ? 1 : 0, Math.ceil(total / 2 ** level)),
      lod = Math.min(8, Math.sqrt(total / Math.max(keep, 1))),
      data = new Float32Array(keep * FLOATS),
      seed = pcg((pcg(Math.imul(tx, 0x27d4eb2d) ^ Math.imul(tz, 0x165667b1) ^ 0x51ed) ^ f.seed) >>> 0);
    let count = 0;
    for (let j = 0; j < keep; j++) {
      const id = pcg((seed ^ Math.imul(j + 1, 0x9e3779b1)) >>> 0) & 0xffffff,
        x = (tx + rand(id, 11)) * TILE,
        z = (tz + rand(id, 12)) * TILE;
      const motion = s.transport?.sample(x, z);
      const [vx, vz] = motion?.velocity ?? [0, 0];
      const speed = Math.hypot(vx, vz);
      if (s.transport && !(motion && motion.mass > 0 && speed >= 1e-10 && Number.isFinite(speed))) continue;
      const mask = this.options.mask ?? null;
      const here = site(this.height, mask, x, z, motion ? vx / speed : f.dx, motion ? vz / speed : f.dz, f.physical);
      const weight = motion ? here.speedUp / (1 + s.referenceMass / motion.mass) : here.speedUp;
      if (!(weight > 0)) continue;
      const kind = j % 24 === 0 ? 2 : here.brink && rand(id, 13) < 0.7 ? 1 : 0;
      data.set(
        [x, here.height, z, rand(id, 14), ...here.profile, weight, kind, id, lod, ...here.gradient, vx, vz],
        count++ * FLOATS,
      );
    }
    const tile = { data, count };
    if (this.tiles.size > 20000) this.tiles.clear();
    this.tiles.set(key, tile);
    return tile;
  }
  /**
   * Lays out the particles around `eye` (culled by `planes` when given) in `this.data`, nearest tiles first up to the
   * limit, then far to near for the blend; returns a key of the layout.
   */
  private collect(
    eye: ArrayLike<number>,
    planes: number[][] | null,
    s: ReturnType<BlownSand['validate']>,
    f: FrameValues,
  ): string {
    const o = this.options,
      key = [s.seed, s.amount, f.dx.toFixed(4), f.dz.toFixed(4), s.transport?.revision, s.referenceMass].join('|');
    if (
      key !== this.layoutKey ||
      o.ground !== this.groundSource ||
      (o.mask ?? null) !== this.maskSource ||
      s.transport !== this.transportSource
    ) {
      this.tiles.clear();
      this.uploaded = '';
    }
    this.layoutKey = key;
    this.groundSource = o.ground;
    this.maskSource = o.mask ?? null;
    this.transportSource = s.transport;
    const r = s.range,
      cx = Math.floor(eye[0] / TILE),
      cz = Math.floor(eye[2] / TILE),
      n = Math.ceil(r / TILE) + 1,
      found: { tx: number; tz: number; distance: number; level: number }[] = [],
      bounds = s.transport?.bounds;
    for (let tz = cz - n; tz <= cz + n; tz++)
      for (let tx = cx - n; tx <= cx + n; tx++) {
        if (
          bounds &&
          ((tx + 1) * TILE < bounds[0] || (tz + 1) * TILE < bounds[1] || tx * TILE > bounds[2] || tz * TILE > bounds[3])
        )
          continue;
        const mx = (tx + 0.5) * TILE,
          mz = (tz + 0.5) * TILE,
          horizontal = Math.hypot(mx - eye[0], mz - eye[2]);
        if (horizontal > r + TILE) continue;
        const y = this.height(mx, mz);
        if (planes) {
          // The tile's box: 8 m square, from 6 m under its centre height to 8 m over it (slopes and plumes).
          const lo = [tx * TILE, y - 6, tz * TILE],
            hi = [(tx + 1) * TILE, y + 8, (tz + 1) * TILE];
          if (
            planes.some(
              (p) =>
                p[0] * (p[0] > 0 ? hi[0] : lo[0]) +
                  p[1] * (p[1] > 0 ? hi[1] : lo[1]) +
                  p[2] * (p[2] > 0 ? hi[2] : lo[2]) +
                  p[3] <
                0,
            )
          )
            continue;
        }
        const distance = Math.hypot(horizontal, y - eye[1]),
          // Full detail within 30 m, then a quarter of the particles for each doubling of the distance (constant
          // particles per pixel), the rest drawn larger.
          level = Math.max(0, Math.min(10, Math.round(2 * Math.log2(Math.max(distance, 1) / 30))));
        found.push({ tx, tz, distance, level });
      }
    found.sort((a, b) => a.distance - b.distance || a.tz - b.tz || a.tx - b.tx);
    const chosen: Tile[] = [],
      names: string[] = [];
    let particles = 0,
      dropped = 0;
    for (const t of found) {
      const tile = this.tile(t.tx, t.tz, t.level, s, f);
      if (particles + tile.count > s.limit) {
        dropped += tile.count;
        continue;
      }
      particles += tile.count;
      chosen.push(tile);
      names.push(`${t.tx},${t.tz},${t.level}`);
    }
    this.stats.tiles = chosen.length;
    this.stats.particles = particles;
    this.stats.dropped = dropped;
    if (this.data.length < particles * FLOATS) this.data = new Float32Array(Math.max(particles, 1024) * FLOATS);
    let at = 0;
    for (let i = chosen.length - 1; i >= 0; i--) {
      this.data.set(chosen[i].data.subarray(0, chosen[i].count * FLOATS), at);
      at += chosen[i].count * FLOATS;
    }
    this.count = particles;
    return key + ':' + names.join(';');
  }
  /**
   * Every particle around world point `eye` at the current time, as the GPU draws it (no view culling, no pixel
   * floor): the CPU twin of the vertex shader, for tests and tools. Particles where no sand moves have alpha 0.
   */
  grains(eye: Vec3): BlownSandGrain[] {
    const s = this.validate();
    this.height = heightOf(this.options.ground);
    const f = this.frameValues(s);
    this.collect(eye, null, s, f);
    const out: BlownSandGrain[] = [];
    for (let i = 0; i < this.count; i++) out.push(particle(this.data, i * FLOATS, f, s.opacity));
    return out;
  }
  setup(engine: Engine): void {
    requireWebGPU(engine, 'BlownSand');
    this.engine = engine;
  }
  registerPasses(graph: FrameGraph): void {
    graph.add({
      name: this.name + ':draw',
      order: 6,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c as Context);
      },
    });
  }
  private draw(c: Context): void {
    if (this.disposed) return;
    const s = this.validate();
    this.height = heightOf(this.options.ground);
    const f = this.frameValues(s),
      m = c.camera.matrix,
      planes: number[][] = [];
    // Side and near planes of the view-projection (Gribb and Hartmann 2001); reversed Z puts the near plane at z <= w.
    for (const [sign, row] of [
      [1, 0],
      [-1, 0],
      [1, 1],
      [-1, 1],
      [-1, 2],
    ]) {
      const p = [0, 1, 2, 3].map((col) => m[col * 4 + 3] + sign * m[col * 4 + row]),
        length = Math.hypot(p[0], p[1], p[2]);
      if (length > 0) planes.push(p.map((x) => x / length));
    }
    const layout = this.collect(c.camera.position, planes, s, f),
      count = this.count;
    if (!count || !(s.amount > 0)) return;
    const device = c.device;
    if (!this.instances || this.capacity < count) {
      this.instances?.destroy();
      this.capacity = Math.max(count, Math.min(s.limit, 4096));
      this.instances = device.createBuffer({
        size: this.capacity * FLOATS * 4,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.uploaded = '';
    }
    if (layout !== this.uploaded) {
      device.queue.writeBuffer(this.instances, 0, this.data as Float32Array<ArrayBuffer>, 0, count * FLOATS);
      this.uploaded = layout;
    }
    const v = viewMatrix(this.view, c.camera),
      u = this.values,
      lighting = this.engine?.lighting,
      rect = viewRect(c),
      // Row 1 of the view-projection is the projection's y scale times the camera's (unit) up axis.
      pixelScale = ((rect?.[3] ?? c.height) * Math.hypot(m[1], m[5], m[9])) / 2;
    u.set(m);
    u.set([c.camera.position[0], c.camera.position[1], c.camera.position[2], f.time], 16);
    u.set([f.dx, f.dz, f.speed, f.ratio], 20);
    u.set([f.gust, f.period, s.opacity, f.seed], 24);
    // Pixels per metre at distance 1: half the target height times the projection's y scale.
    // Pixels per metre at distance 1, and the camera's right axis (x, z) for the haze sheets.
    u.set([f.streak, f.height, pixelScale, v[0]], 28);
    u.set([s.color[0], s.color[1], s.color[2], v[8]], 32);
    if (lighting) {
      unitLight(u, 36, lighting.direction);
      u.set(lighting.radiance, 40);
      u.set([lighting.ambient[0], lighting.ambient[1], lighting.ambient[2], 0], 44);
    } else {
      u.set([3, 5, 4, 3], 36);
      u.set([1, 1, 1, 0.15], 40);
      u.set([1, 1, 1, 0], 44);
    }
    u.set([s.range, s.fog, f.physical ? 1 : 0, 0], 48);
    this.uniform ??= device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.uniform, 0, u as Float32Array<ArrayBuffer>);
    const encode = !c.format.includes('float') && !c.format.endsWith('-srgb');
    let samples = 0;
    if (s.softness > 0) {
      this.softRuntime ??= soft.create(device, this.owned);
      samples = this.softRuntime.write(c as never, this.options.depth!(), v, s.softness);
      if (this.softRuntime.changed) this.groups.clear();
    }
    const multisample = c.descriptor.multisample?.count ?? 1,
      depthFormat = c.descriptor.depthStencil!.format,
      hook = this.options.sky?.pbr(1),
      skyEntries = hook ? this.options.sky!.bindings() : [],
      key = [c.format, depthFormat, multisample, samples, encode, hook?.declarations ?? ''].join(':');
    let pipeline = this.pipelines.get(key);
    if (!pipeline) {
      const module = device.createShaderModule({ code: shader(samples, encode, hook?.declarations ?? '') });
      pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module,
          entryPoint: 'vertex',
          buffers: [
            {
              arrayStride: FLOATS * 4,
              stepMode: 'instance',
              attributes: [0, 1, 2, 3].map((shaderLocation) => ({
                shaderLocation,
                offset: shaderLocation * 16,
                format: 'float32x4' as const,
              })),
            },
          ],
        },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              // Premultiplied over (Porter and Duff 1984).
              blend: {
                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
              },
            },
          ],
        },
        primitive: { topology: 'triangle-strip' },
        multisample: c.descriptor.multisample,
        depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'greater-equal' },
      });
      this.pipelines.set(key, pipeline);
    }
    let group = this.groups.get(pipeline);
    if (!group) {
      group = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.uniform } }, ...(samples ? this.softRuntime!.entries : [])],
      });
      this.groups.set(pipeline, group);
    }
    let skyGroup: GPUBindGroup | undefined;
    if (hook) {
      // The sky's entries are borrowed until a device restore: one group per entries list it hands out.
      if (this.skyEntries !== skyEntries || this.skyPipeline !== pipeline) {
        this.skyEntries = skyEntries;
        this.skyPipeline = pipeline;
        this.skyGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(1), entries: skyEntries });
      }
      skyGroup = this.skyGroup;
    }
    this.attachment.view = c.color;
    this.depthAttachment.view = c.depth;
    this.depthAttachment.stencilReadOnly = depthFormat.includes('stencil') ? true : undefined;
    const pass = c.encoder.beginRenderPass({
      colorAttachments: [this.attachment],
      depthStencilAttachment: this.depthAttachment,
    });
    applyView(pass, c);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    if (skyGroup) pass.setBindGroup(1, skyGroup);
    pass.setVertexBuffer(0, this.instances);
    pass.draw(4, count);
    pass.end();
    if (this.engine) this.engine.stats.drawCalls++;
  }
  private release(): void {
    for (const resource of [this.instances, this.uniform, ...this.owned]) resource?.destroy();
    this.instances = this.uniform = this.softRuntime = undefined;
    this.capacity = 0;
    this.uploaded = '';
    this.owned = [];
    this.pipelines.clear();
    this.groups.clear();
    this.skyEntries = this.skyPipeline = this.skyGroup = undefined;
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Releases the GPU objects and leaves the engine. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.sceneOf(this)?.removePlugin(this.name);
    this.release();
    this.tiles.clear();
    this.engine = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
