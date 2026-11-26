/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import {
  engineRuntime,
  type Engine,
  type EnginePlugin,
  type FrameGraph,
  type PassContext,
} from '@margoengine/core/extension';
import { invertMatrixStable } from '@margoengine/math/mat4';
import { MargoError } from '@margoengine/math/errors';
import { finiteVector } from '@margoengine/math/validate';
import { fullscreen } from '../../shared/gpu.js';
import { displayShader } from '../../shared/display.js';
import { applyView, viewRect } from '../../shared/view-rect.js';
import { linearHdr } from '../../shared/hdr-format.js';
import { compactDeficit, compactPeakWind, compactTangential } from '../../shared/vortex-balance.js';
import { sunlight } from './atmosphere.js';
import { depthWGSL, sceneDepth } from './depth.js';
// A tornado under a supercell: the vortex's wind and pressure (the Rankine combined vortex with the decay outside the
// core that Doppler radar measures, or the Burgers-Rott vortex), the condensation funnel the pressure deficit draws
// (from a thin rope to a wide wedge), the wall cloud and the turning mesocyclone base above it, the debris cloud at the
// ground, the rain of the rear flank, and its path over film time. CPU only: `TornadoCloud` (this entry) draws the same
// funnel, wall cloud, base and debris on the GPU, its shader loaded by import() at its first frame, and
// `@margoengine/weather` takes the wind and rain at a place through `WeatherRegions` (`storms`).
//
// Sources (read for the model; no code from anywhere):
// - W. J. M. Rankine, "A Manual of Applied Mechanics", Griffin, London, 1858: the combined vortex, solid rotation inside
//   the core and a potential vortex v = Vm rc / r outside it.
// - J. M. Burgers, "A mathematical model illustrating the theory of turbulence", Adv. Appl. Mech. 1, 171-199, 1948,
//   https://doi.org/10.1016/S0065-2156(08)70100-5, and N. Rott, "On the viscous core of a line vortex", Z. Angew. Math.
//   Phys. 9, 543-553, 1958, https://doi.org/10.1007/BF02424773: the steady vortex in an axial strain,
//   v(r) = (G / 2 pi r)(1 - exp(-r^2 / r0^2)), its wind peaking at r = 1.12091 r0 at 0.638173 G / (2 pi r0).
// - R. Davies-Jones, "Tornado dynamics", in E. Kessler (ed.), Thunderstorm Morphology and Dynamics, Univ. of Oklahoma
//   Press, 197-236, 1986; and R. Davies-Jones, R. J. Trapp and H. B. Bluestein, "Tornadoes and tornadic storms",
//   Meteor. Monogr. 28(50), 167-221, 2001, https://doi.org/10.1175/0065-9401-28.50.167: the core in cyclostrophic
//   balance, dp/dr = rho v^2 / r, and the condensation funnel as the surface of the pressure deficit that cools the
//   inflow air to its condensation level, so the funnel's edge at height z sits where the deficit equals the fall of
//   pressure between z and the cloud base, rho g (zb - z).
// - J. Wurman and S. Gill, "Finescale radar observations of the Dimmitt, Texas (2 June 1995), tornado", Mon. Wea. Rev.
//   128, 2135-2164, 2000, https://doi.org/10.1175/1520-0493(2000)128<2135:FROOTD>2.0.CO;2; J. Wurman and C. R.
//   Alexander, "The 30 May 1998 Spencer, South Dakota, storm. Part II", Mon. Wea. Rev. 133, 97-119, 2005; K. Kosiba and
//   J. Wurman, "The three-dimensional axisymmetric wind field structure of the Spencer, South Dakota, 1998 tornado",
//   J. Atmos. Sci. 67, 3074-3083, 2010: the wind outside the core falls off as r^-a with a from about 0.5 to 0.7
//   (0.6 here) rather than Rankine's r^-1, and cores from tens of metres to about a kilometre across.
// - J. Wurman, K. Kosiba and P. Robinson, "In situ, Doppler radar, and video observations of the interior structure of
//   a tornado and the wind-damage relationship", Bull. Amer. Meteor. Soc. 94, 835-846, 2013: the strong updraft and
//   the debris lofted in the core.
// - J. J. Lee, T. P. Samaras and C. R. Young, "Pressure measurements at the ground in an F-4 tornado", 22nd Conf. on
//   Severe Local Storms, AMS, 2004: a 100 hPa deficit measured at the ground (the top of the range here).
// - D. C. Lewellen, W. S. Lewellen and J. Xia, "The influence of a local swirl ratio on tornado intensification near
//   the surface", J. Atmos. Sci. 57, 527-544, 2000: the inflow turned strongly in toward the core in the lowest tens of
//   metres (the corner flow), fading with height.
// - A. R. Moller, C. A. Doswell III, M. P. Foster and G. R. Woodall, "The operational recognition of supercell
//   thunderstorm environments and storm structures", Wea. Forecasting 9, 327-347, 1994: the wall cloud, a lowered,
//   turning cloud a few kilometres across under the rain-free base; the mesocyclone a few kilometres across.
// - L. R. Lemon and C. A. Doswell III, "Severe thunderstorm evolution and mesocyclone structure as related to
//   tornadogenesis", Mon. Wea. Rev. 107, 1184-1197, 1979: the rear-flank downdraft and its rain wrapping round the
//   tornado on the storm's rear side (the hook echo), with the rain-free base over the inflow.
// - E. N. Rasmussen and D. O. Blanchard, "A baseline climatology of sounding-derived supercell and tornado forecast
//   parameters", Wea. Forecasting 13, 1148-1164, 1998: tornadic supercells have cloud bases (lifting condensation
//   levels) mostly under about 1,000 m.
// - Wind Science and Engineering Center, "A recommendation for an enhanced Fujita scale (EF-scale)", Texas Tech
//   University, 2006: EF0 begins at a 3 s gust of 29 m/s (65 mph), the damage path's edge here.

/** {@link Tornado} settings, read live. Lengths are metres, speeds metres per second, angles degrees unless named. */
export interface TornadoOptions {
  /** Where the tornado stands at time 0, world `[x, z]`, when no `path` is given. Default [0, 0]. */
  center?: readonly [number, number];
  /** Its motion `[x, z]`, m/s, -40 to 40 each way, when no `path` is given. Default [0, 0]. */
  velocity?: readonly [number, number];
  /**
   * Its track over film time: two or more `[seconds, x, z]` keys in rising time, passed through smoothly (a
   * Catmull-Rom curve); before the first and after the last it stands still. Replaces `center` and `velocity`.
   */
  path?: readonly (readonly [number, number, number])[];
  /** The wind profile: `'burgers-rott'` (Burgers 1948, Rott 1958) or `'rankine'` (Rankine 1858, with `decay`). Default `'burgers-rott'`. */
  profile?: 'burgers-rott' | 'rankine';
  /** Central pressure deficit at full strength, 1 to 150 hPa. Default 80. */
  pressureDrop?: number;
  /** Radius of maximum wind, 10 to 2,000 m. Default 150. */
  coreRadius?: number;
  /** The `'rankine'` wind outside the core falls as r^-decay, 0.5 to 1. Default 0.6 (Wurman and Gill 2000); 1 is Rankine's own. */
  decay?: number;
  /** Air density, 1 to 1.3 kg/m3. Default 1.15. */
  airDensity?: number;
  /** Height of the supercell's base (the condensation level of the air round it), 200 to 3,000 m. Default 1,000. */
  cloudBase?: number;
  /** How far the wall cloud hangs below the base, 0 to 1,500 m (less than `cloudBase`). Default 400. */
  wallCloudDrop?: number;
  /** Radius of the wall cloud, 200 to 8,000 m. Default 1,500. */
  wallCloudRadius?: number;
  /** Radius of the mesocyclone, the turning base round the wall cloud, 1,000 to 10,000 m. Default 3,000. */
  mesocycloneRadius?: number;
  /** Wind of the mesocyclone at its radius, 0 to 60 m/s: the base's turn. Default 25. */
  mesocycloneWind?: number;
  /** `'cyclonic'` turns anticlockwise seen from above (most in the north), `'anticyclonic'` clockwise. Default `'cyclonic'`. */
  rotation?: 'cyclonic' | 'anticyclonic';
  /** Where the funnel's foot sits from under its top, world `[x, z]`, -3,000 to 3,000 m each. Default [0, 0]. */
  tilt?: readonly [number, number];
  /** Sideways weave of the funnel along its height (a rope's contortion), 0 to 600 m. Default 0. */
  meander?: number;
  /** Surface wind that lofts debris, 10 to 80 m/s. Default 35. */
  debrisWind?: number;
  /** Height of the debris cloud, 0 to 1,000 m; null is 2 core radii plus 50 m. Default null. */
  debrisHeight?: number | null;
  /** Opacity of the debris cloud, 0 to 1. Default 0.6. */
  debrisDensity?: number;
  /** Colour of the debris (soil, dust, plant matter), linear RGB 0 to 1. Default [0.34, 0.27, 0.2]. */
  debrisColor?: readonly [number, number, number];
  /** Extinction of the funnel cloud, 0.002 to 1 per metre. Default 0.05. */
  funnelDensity?: number;
  /** Extinction of the wall cloud and base, 0.0005 to 0.2 per metre. Default 0.01. */
  wallCloudDensity?: number;
  /** Inflow angle of the surface wind toward the core, 0 to 80 degrees, fading with height. Default 40 (Lewellen et al. 2000). */
  inflow?: number;
  /** Updraft in the core, 0 to 120 m/s; null is 0.6 of the peak wind. Default null. */
  updraft?: number | null;
  /** 3 s gust over the mean wind, 1 to 2. Default 1.3. */
  gustFactor?: number;
  /** Peak rain rate of the rear flank's curtain, 0 to 300 mm/h. Default 60. */
  rainMax?: number;
  /** Film seconds the tornado starts to form; null is already formed when the film starts. Default null. */
  touchdown?: number | null;
  /** Film seconds it starts to die; null never. Default null. */
  liftoff?: number | null;
  /** Seconds the vortex takes to spin up (and down), 1 to 900: the deficit ramps in, so the funnel lowers. Default 60. */
  spinUp?: number;
  /** Raggedness of the funnel's and the debris cloud's edges, 0 to 1. Default 0.5. */
  turbulence?: number;
  /** Seconds between the two cross-faded phases of the turning cloud texture, 2 to 600. Default 20. */
  flowPeriod?: number;
}
/** The numbers the formulas use, from the options with their defaults (shared with the GPU uniform). */
export interface ResolvedTornado {
  cx: number;
  cz: number;
  vx: number;
  vz: number;
  path: readonly (readonly [number, number, number])[] | undefined;
  burgers: boolean;
  /** Full-strength central deficit, Pa. */
  dp: number;
  rc: number;
  decay: number;
  rho: number;
  cloudBase: number;
  /** The wall cloud's base: where the funnel's air condenses. */
  wallBase: number;
  wallRadius: number;
  mesoRadius: number;
  mesoWind: number;
  /** +1 anticlockwise seen from above, -1 clockwise. */
  spin: number;
  tiltX: number;
  tiltZ: number;
  meander: number;
  debrisWind: number;
  debrisHeight: number;
  debrisDensity: number;
  debrisColor: readonly [number, number, number];
  funnelDensity: number;
  wallDensity: number;
  inflow: number;
  updraft: number | undefined;
  gust: number;
  rainMax: number;
  touchdown: number;
  liftoff: number;
  spinUp: number;
  turbulence: number;
  flowPeriod: number;
}
/** Where a point lies in the tornado's storm. */
export type TornadoRegion = 'funnel' | 'core' | 'debris' | 'wallCloud' | 'rearFlank' | 'inflow' | 'outside';
/** The wind at a place: {@link Tornado.windAt}. */
export interface TornadoWind {
  /** Mean wind near the ground (10 m), m/s, the storm's motion included. */
  speed: number;
  /** 3 second gust, m/s. */
  gust: number;
  /** World `[x, z]` velocity, m/s. */
  velocity: [number, number];
  /** Direction the wind blows toward, radians, 0 toward +Z and pi/2 toward +X (the weather's `windDirection`). */
  direction: number;
}
/** The weather a tornado's storm makes at a place, on the weather's scales: {@link Tornado.weatherAt}. */
export interface TornadoWeather {
  /** How much of the storm is here, 0 to 1 (1 inside, 0 past four mesocyclone radii). */
  weight: number;
  /** Mean 10 m wind in m/s. */
  wind: number;
  /** Gustiness 0 to 1. */
  gust: number;
  windDirection: number;
  /** Rain 0 to 1 on the weather's scale, `(rate / 80) ^ (1/3)` of the rain rate in mm/h. */
  rain: number;
  /** Cloud cover overhead, 0 to 1. */
  cloud: number;
  /** Lightning, 0 to 1: strongest in the rear flank's rain. */
  lightning: number;
  humidity: number;
}
/** One step of the damage path: {@link Tornado.damagePath}. */
export interface TornadoTrackPoint {
  /** Film seconds. */
  t: number;
  x: number;
  z: number;
  /** Width of ground where the 3 s gust reaches EF0 (29 m/s), metres; 0 when it does not. */
  width: number;
  /** Peak 3 s gust at the ground, m/s. */
  gust: number;
}
/** A scar along the track for `GroundChange.add` (`@margoengine/terrain/ground-change`): a shallow `'u'` gully. */
export interface TornadoGroundScar {
  kind: 'gully';
  path: [number, number][];
  width: number;
  depth: number;
  shape: 'u';
  deposit: number;
  start: number;
  duration: number;
  roughness: number;
  seed: number;
}
const G = 9.80665;
const AMBIENT = 1013.25;
export { BURGERS_PEAK_RADIUS, BURGERS_PEAK_WIND, expIntegral } from '../../shared/vortex-balance.js';
/** EF0's lowest 3 s gust, m/s (WSEC 2006). */
export const EF0_GUST = 29;
const DEG = Math.PI / 180;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const inRange = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/**
 * Checks `o` and returns its numbers with the defaults filled in.
 * @throws TypeError for a bad pair, path or colour; RangeError for a value outside its range (each named in the message).
 */
export function resolveTornado(o: TornadoOptions = {}): ResolvedTornado {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('Tornado options must be an object; pass {} for the defaults.');
  const pair = (v: readonly [number, number] | undefined, name: string, limit: number): readonly [number, number] => {
    if (v === undefined) return [0, 0];
    if (!Array.isArray(v) || v.length !== 2 || !inRange(v[0], -limit, limit) || !inRange(v[1], -limit, limit))
      throw new TypeError(`Invalid Tornado ${name}; pass [x, z], each from ${-limit} to ${limit}.`);
    return v;
  };
  const num = (v: number | null | undefined, name: string, lo: number, hi: number, fallback: number) => {
    if (v === undefined || v === null) return fallback;
    if (!inRange(v, lo, hi)) throw new RangeError(`Invalid Tornado ${name}; pass a number from ${lo} to ${hi}.`);
    return v;
  };
  const center = pair(o.center, 'center', 1e9),
    velocity = pair(o.velocity, 'velocity', 40),
    tilt = pair(o.tilt, 'tilt', 3000);
  let path: ResolvedTornado['path'];
  if (o.path !== undefined) {
    const p = o.path;
    if (!Array.isArray(p) || p.length < 2)
      throw new TypeError('Invalid Tornado path; pass two or more [seconds, x, z] keys in rising time.');
    for (let i = 0; i < p.length; i++) {
      const k = p[i];
      if (
        !Array.isArray(k) ||
        k.length !== 3 ||
        !k.every((n) => Number.isFinite(n)) ||
        (i > 0 && !(k[0] > p[i - 1][0]))
      )
        throw new TypeError('Invalid Tornado path; pass two or more [seconds, x, z] keys in rising time.');
    }
    path = p;
  }
  if (o.profile !== undefined && o.profile !== 'burgers-rott' && o.profile !== 'rankine')
    throw new RangeError("Invalid Tornado profile; pass 'burgers-rott' or 'rankine'.");
  if (o.rotation !== undefined && o.rotation !== 'cyclonic' && o.rotation !== 'anticyclonic')
    throw new RangeError("Invalid Tornado rotation; pass 'cyclonic' or 'anticyclonic'.");
  const color = o.debrisColor ?? [0.34, 0.27, 0.2];
  if (!Array.isArray(color) || color.length !== 3 || !color.every((c) => inRange(c, 0, 1)))
    throw new TypeError('Invalid Tornado debrisColor; pass [r, g, b], each from 0 to 1.');
  const cloudBase = num(o.cloudBase, 'cloudBase', 200, 3000, 1000),
    drop = num(o.wallCloudDrop, 'wallCloudDrop', 0, 1500, 400);
  if (!(drop < cloudBase)) throw new RangeError('Invalid Tornado wallCloudDrop; it must be less than the cloudBase.');
  const rc = num(o.coreRadius, 'coreRadius', 10, 2000, 150),
    touchdown = num(o.touchdown, 'touchdown', -1e9, 1e9, -Infinity),
    liftoff = num(o.liftoff, 'liftoff', -1e9, 1e9, Infinity);
  if (!(liftoff > touchdown)) throw new RangeError('Invalid Tornado liftoff; it must come after the touchdown.');
  return {
    cx: center[0],
    cz: center[1],
    vx: velocity[0],
    vz: velocity[1],
    path,
    burgers: (o.profile ?? 'burgers-rott') === 'burgers-rott',
    dp: num(o.pressureDrop, 'pressureDrop', 1, 150, 80) * 100,
    rc,
    decay: num(o.decay, 'decay', 0.5, 1, 0.6),
    rho: num(o.airDensity, 'airDensity', 1, 1.3, 1.15),
    cloudBase,
    wallBase: cloudBase - drop,
    wallRadius: num(o.wallCloudRadius, 'wallCloudRadius', 200, 8000, 1500),
    mesoRadius: num(o.mesocycloneRadius, 'mesocycloneRadius', 1000, 10000, 3000),
    mesoWind: num(o.mesocycloneWind, 'mesocycloneWind', 0, 60, 25),
    spin: (o.rotation ?? 'cyclonic') === 'cyclonic' ? 1 : -1,
    tiltX: tilt[0],
    tiltZ: tilt[1],
    meander: num(o.meander, 'meander', 0, 600, 0),
    debrisWind: num(o.debrisWind, 'debrisWind', 10, 80, 35),
    debrisHeight: num(o.debrisHeight, 'debrisHeight', 0, 1000, 2 * rc + 50),
    debrisDensity: num(o.debrisDensity, 'debrisDensity', 0, 1, 0.6),
    debrisColor: color as unknown as readonly [number, number, number],
    funnelDensity: num(o.funnelDensity, 'funnelDensity', 0.002, 1, 0.05),
    wallDensity: num(o.wallCloudDensity, 'wallCloudDensity', 0.0005, 0.2, 0.01),
    inflow: num(o.inflow, 'inflow', 0, 80, 40) * DEG,
    updraft: o.updraft === null || o.updraft === undefined ? undefined : num(o.updraft, 'updraft', 0, 120, 0),
    gust: num(o.gustFactor, 'gustFactor', 1, 2, 1.3),
    rainMax: num(o.rainMax, 'rainMax', 0, 300, 60),
    touchdown,
    liftoff,
    spinUp: num(o.spinUp, 'spinUp', 1, 900, 60),
    turbulence: num(o.turbulence, 'turbulence', 0, 1, 0.5),
    flowPeriod: num(o.flowPeriod, 'flowPeriod', 2, 600, 20),
  };
}
/** The share of full strength at film time `t`, 0 to 1: smooth over `spinUp` after `touchdown`, and down after `liftoff`. */
export function tornadoStrength(s: ResolvedTornado, t: number): number {
  const rise = s.touchdown === -Infinity ? 1 : smoothstep(s.touchdown, s.touchdown + s.spinUp, t);
  return s.liftoff === Infinity ? rise : rise * (1 - smoothstep(s.liftoff, s.liftoff + s.spinUp, t));
}
/** The peak tangential wind of `s` at strength `k` (0 to 1 of its deficit), m/s, from the central deficit. */
export function tornadoPeakWind(s: ResolvedTornado, k = 1): number {
  return compactPeakWind(s.dp * k, s.rho, s.decay, s.burgers);
}
/** The tangential wind at radius `r` metres, m/s, at strength `k`. */
export function tornadoWind(r: number, s: ResolvedTornado, k = 1): number {
  return k > 0 ? compactTangential(r / s.rc, tornadoPeakWind(s, k), s.decay, s.burgers) : 0;
}
/** The pressure deficit at radius `r` below the air round the tornado, Pa, at strength `k`. */
export function tornadoDeficit(r: number, s: ResolvedTornado, k = 1): number {
  return k > 0 ? compactDeficit(r / s.rc, s.dp * k, s.decay, s.burgers) : 0;
}
/**
 * The radius of the condensation funnel at `height` metres, at strength `k`: where the deficit cools the air to its
 * condensation level, `tornadoDeficit(r) = rho g (wallBase - height)` (Davies-Jones 1986); 0 where the core's deficit
 * falls short, so the funnel does not reach that low. Above the wall cloud's base it holds the base's width.
 */
export function funnelRadius(height: number, s: ResolvedTornado, k = 1): number {
  const need = s.rho * G * Math.max(0, s.wallBase - height);
  if (!(k > 0) || tornadoDeficit(0, s, k) <= need) return 0;
  if (need <= 0) return funnelRadius(s.wallBase - 0.5, s, k);
  // The deficit falls monotonically with radius: bisect between the axis and far outside the core.
  let lo = 0,
    hi = s.rc;
  while (tornadoDeficit(hi, s, k) > need) hi *= 2;
  for (let i = 0; i < 60; i++) {
    const mid = 0.5 * (lo + hi);
    if (tornadoDeficit(mid, s, k) > need) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}
/** The lowest height the funnel reaches at strength `k`, metres: 0 when it touches the ground, the wall base when none. */
export function funnelBottom(s: ResolvedTornado, k = 1): number {
  return Math.max(0, s.wallBase - tornadoDeficit(0, s, k) / (s.rho * G));
}
/** Heights in the funnel table the GPU reads ({@link funnelProfile}). */
export const FUNNEL_SAMPLES = 32;
/** The funnel's radius at `FUNNEL_SAMPLES` heights from the ground to the wall cloud's base, into `out`. */
export function funnelProfile(s: ResolvedTornado, k: number, out = new Float32Array(FUNNEL_SAMPLES)): Float32Array {
  for (let i = 0; i < FUNNEL_SAMPLES; i++) out[i] = funnelRadius((s.wallBase * i) / (FUNNEL_SAMPLES - 1), s, k);
  return out;
}
/** The radius of the debris cloud at the ground, metres: out to where the surface wind lofts debris; 0 when none. */
export function debrisRadius(s: ResolvedTornado, k = 1): number {
  const v = (r: number) => tornadoWind(r, s, k);
  if (v(s.rc) < s.debrisWind) return 0;
  let lo = s.rc,
    hi = s.rc * 2;
  while (v(hi) >= s.debrisWind && hi < 1e6) hi *= 2;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (v(mid) >= s.debrisWind) lo = mid;
    else hi = mid;
  }
  return lo;
}
function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return (
    0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u)
  );
}
/** Where the tornado of `s` stands at film time `t`, world `[x, z]`, into `out`. */
export function tornadoCenter(s: ResolvedTornado, t: number, out: [number, number] = [0, 0]): [number, number] {
  const p = s.path;
  if (!p) {
    out[0] = s.cx + s.vx * t;
    out[1] = s.cz + s.vz * t;
    return out;
  }
  const n = p.length;
  if (t <= p[0][0]) {
    out[0] = p[0][1];
    out[1] = p[0][2];
    return out;
  }
  if (t >= p[n - 1][0]) {
    out[0] = p[n - 1][1];
    out[1] = p[n - 1][2];
    return out;
  }
  let i = 0;
  while (t > p[i + 1][0]) i++;
  const a = p[Math.max(0, i - 1)],
    b = p[i],
    c = p[i + 1],
    d = p[Math.min(n - 1, i + 2)],
    u = (t - b[0]) / (c[0] - b[0]);
  out[0] = catmull(a[1], b[1], c[1], d[1], u);
  out[1] = catmull(a[2], b[2], c[2], d[2], u);
  return out;
}
const scratchCenter: [number, number] = [0, 0];
/**
 * A tornado under its supercell: its wind (3D, near the ground and aloft), pressure, rain, region and the funnel's
 * shape at any place and film time, from {@link TornadoOptions} read live. Give the same `Tornado` to `TornadoCloud`
 * (this entry) to draw it, and to `WeatherRegions` (`storms`) so the wind and rain follow it.
 * @throws TypeError / RangeError on invalid options.
 * @example
 * const twister = new Tornado({ pressureDrop: 80, coreRadius: 150, velocity: [12, 4] });
 * twister.peakWind(); // about 64 m/s (Burgers-Rott)
 * twister.funnelRadiusAt(0); // the funnel's width at the ground, metres
 */
export class Tornado {
  constructor(readonly options: TornadoOptions = {}) {
    resolveTornado(options);
  }
  /** The options' numbers with their defaults. */
  get resolved(): ResolvedTornado {
    return resolveTornado(this.options);
  }
  /** Share of full strength at film time `t`, 0 to 1 (spin-up after `touchdown`, spin-down after `liftoff`). */
  strengthAt(t = 0): number {
    return tornadoStrength(this.resolved, t);
  }
  /** Where it stands at film time `t`, world `[x, z]`. */
  centerAt(t = 0): [number, number] {
    return tornadoCenter(this.resolved, t, [0, 0]);
  }
  /** The ground speed of its motion at `t`, world `[x, z]` m/s (a central difference over the path). */
  motionAt(t = 0): [number, number] {
    const s = this.resolved;
    if (!s.path) return [s.vx, s.vz];
    const a = tornadoCenter(s, t - 0.5, [0, 0]),
      b = tornadoCenter(s, t + 0.5, [0, 0]);
    return [b[0] - a[0], b[1] - a[1]];
  }
  /** Peak tangential wind at `t`, m/s. */
  peakWind(t = Infinity): number {
    const s = this.resolved;
    return tornadoPeakWind(s, t === Infinity ? 1 : tornadoStrength(s, t));
  }
  /** Pressure at the ground at world `(x, z)`, hPa, with 1013.25 round the storm. */
  pressureAt(x: number, z: number, t = 0): number {
    const s = this.resolved,
      c = tornadoCenter(s, t, scratchCenter);
    return AMBIENT - tornadoDeficit(Math.hypot(x - c[0], z - c[1]), s, tornadoStrength(s, t)) / 100;
  }
  /** The funnel's radius at `height` at `t` (full strength without `t`), metres; 0 where it does not reach. */
  funnelRadiusAt(height: number, t?: number): number {
    const s = this.resolved;
    return funnelRadius(height, s, t === undefined ? 1 : tornadoStrength(s, t));
  }
  /** The lowest height the funnel reaches at `t` (full strength without `t`): 0 on the ground. */
  funnelBottomAt(t?: number): number {
    const s = this.resolved;
    return funnelBottom(s, t === undefined ? 1 : tornadoStrength(s, t));
  }
  /**
   * The air's velocity at world `(x, y, z)` at `t`, `[vx, vy, vz]` m/s: the vortex's turn, the inflow turned in near
   * the ground (fading over a core radius of height), the core's updraft, plus the storm's motion. For debris.
   */
  velocityAt(
    x: number,
    y: number,
    z: number,
    t = 0,
    out: [number, number, number] = [0, 0, 0],
  ): [number, number, number] {
    const s = this.resolved,
      k = tornadoStrength(s, t),
      c = tornadoCenter(s, t, scratchCenter),
      dx = x - c[0],
      dz = z - c[1],
      r = Math.hypot(dx, dz),
      motion = this.motionAt(t),
      v = tornadoWind(r, s, k),
      beta = s.inflow * Math.exp(-Math.max(0, y) / s.rc),
      w =
        (s.updraft ?? 0.6 * tornadoPeakWind(s, 1)) *
        k *
        Math.exp(-((r / s.rc) ** 2)) *
        -Math.expm1(-Math.max(0, y) / s.rc);
    out[0] = motion[0];
    out[1] = w;
    out[2] = motion[1];
    if (r > 0) {
      const ux = dx / r,
        uz = dz / r,
        // Turning anticlockwise seen from above (+Y up) for spin +1, as the hurricane's wind.
        tx = s.spin * uz,
        tz = -s.spin * ux,
        cos = Math.cos(beta),
        sin = Math.sin(beta);
      out[0] += v * (cos * tx - sin * ux);
      out[2] += v * (cos * tz - sin * uz);
    }
    return out;
  }
  /** The wind 10 m above the ground at world `(x, z)` and `t`. */
  windAt(x: number, z: number, t = 0): TornadoWind {
    const v = this.velocityAt(x, 10, z, t),
      speed = Math.hypot(v[0], v[2]);
    return { speed, gust: speed * this.resolved.gust, velocity: [v[0], v[2]], direction: Math.atan2(v[0], v[2]) };
  }
  /**
   * The rain rate at world `(x, z)`, mm/h: the rear flank's curtain wrapping round the core on the storm's rear side
   * (Lemon and Doswell 1979), a ring two wall-cloud radii out, heaviest behind the motion, light ahead under the
   * rain-free base.
   */
  rainAt(x: number, z: number, t = 0): number {
    const s = this.resolved,
      c = tornadoCenter(s, t, scratchCenter),
      dx = x - c[0],
      dz = z - c[1],
      r = Math.hypot(dx, dz),
      m = this.motionAt(t),
      speed = Math.hypot(m[0], m[1]),
      // The rear: against the motion, turned a quarter round with the spin (the hook wraps that way); north-east
      // motion is assumed when the tornado stands still.
      bx = speed > 0 ? -m[0] / speed : -Math.SQRT1_2,
      bz = speed > 0 ? -m[1] / speed : -Math.SQRT1_2,
      side = r > 0 ? (dx * bx + dz * bz) / r : 0,
      q = (r - 2 * s.wallRadius) / s.wallRadius;
    return (
      s.rainMax * Math.exp(-q * q) * (0.15 + 0.85 * clamp01(0.5 + 0.5 * side)) * Math.max(0.15, tornadoStrength(s, t))
    );
  }
  /** Which part of the storm `(x, z)` lies in at `t`. */
  regionAt(x: number, z: number, t = 0): TornadoRegion {
    const s = this.resolved,
      k = tornadoStrength(s, t),
      c = tornadoCenter(s, t, scratchCenter),
      r = Math.hypot(x - c[0], z - c[1]);
    if (r >= 4 * s.mesoRadius) return 'outside';
    if (k > 0 && funnelBottom(s, k) <= 0 && r < funnelRadius(0, s, k)) return 'funnel';
    if (k > 0 && r < s.rc) return 'core';
    if (k > 0 && r < debrisRadius(s, k)) return 'debris';
    if (this.rainAt(x, z, t) > 0.25 * s.rainMax) return 'rearFlank';
    if (r < s.wallRadius) return 'wallCloud';
    return 'inflow';
  }
  /**
   * The storm's weather at `(x, z)` on the weather's scales, for `WeatherRegions`' `storms`: mean wind in m/s, gustiness, direction, rain, cloud overhead (the base out to the mesocyclone, the deck past it), lightning and
   * humidity, and the storm's `weight` there (1 inside, fading to 0 from three to four mesocyclone radii).
   */
  weatherAt(x: number, z: number, t = 0): TornadoWeather {
    const s = this.resolved,
      c = tornadoCenter(s, t, scratchCenter),
      r = Math.hypot(x - c[0], z - c[1]),
      wind = this.windAt(x, z, t),
      rate = this.rainAt(x, z, t);
    return {
      weight: 1 - smoothstep(3 * s.mesoRadius, 4 * s.mesoRadius, r),
      wind: wind.speed,
      gust: clamp01(0.4 + 0.6 * Math.min(1, wind.speed / 30)),
      windDirection: wind.direction,
      rain: Math.min(1, Math.cbrt(rate / 80)),
      cloud: 1,
      lightning: clamp01((0.8 * rate) / Math.max(1, s.rainMax)),
      humidity: 0.9,
    };
  }
  /**
   * The damage path from `t0` to `t1` in steps of `step` seconds: where it stood and how wide the ground saw an EF0
   * gust (29 m/s) or more, from the wind at the ground with the storm's motion (the right side, in the north, takes the
   * motion's speed on top of the turn).
   */
  damagePath(t0: number, t1: number, step = 1): TornadoTrackPoint[] {
    if (!(Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0) || !(step > 0))
      throw new RangeError('Invalid Tornado damagePath; pass t0 < t1 and a step above 0 seconds.');
    const s = this.resolved,
      out: TornadoTrackPoint[] = [];
    for (let t = t0; t <= t1 + 1e-9; t += step) {
      const k = tornadoStrength(s, t),
        c = tornadoCenter(s, t, [0, 0]),
        m = this.motionAt(t),
        speed = Math.hypot(m[0], m[1]),
        reach = (sign: number) => {
          // Across the track, on one side: the turn adds to the motion on the right of a cyclonic tornado.
          const g = (r: number) => (tornadoWind(r, s, k) + sign * s.spin * speed) * s.gust;
          if (!(g(s.rc) >= EF0_GUST)) return 0;
          let lo = s.rc,
            hi = s.rc * 2;
          while (g(hi) >= EF0_GUST && hi < 1e6) hi *= 2;
          for (let i = 0; i < 50; i++) {
            const mid = 0.5 * (lo + hi);
            if (g(mid) >= EF0_GUST) lo = mid;
            else hi = mid;
          }
          return lo;
        };
      out.push({
        t,
        x: c[0],
        z: c[1],
        width: reach(1) + reach(-1),
        gust: (tornadoPeakWind(s, k) + speed) * s.gust * (k > 0 ? 1 : 0),
      });
    }
    return out;
  }
  /**
   * A shallow scoured strip along the damage path from `t0` to `t1`, cut as the tornado passes, for
   * `GroundChange.add` (`@margoengine/terrain/ground-change`); `depth` metres deep (default 0.15), as wide as the
   * widest stretch of the path. Null when the path saw no damage.
   */
  groundScar(t0: number, t1: number, depth = 0.15): TornadoGroundScar | null {
    if (!(depth > 0 && depth <= 5)) throw new RangeError('Invalid Tornado groundScar depth; pass 0 to 5 metres.');
    const track = this.damagePath(t0, t1, Math.max((t1 - t0) / 64, 1e-3)).filter((p) => p.width > 0);
    if (track.length < 2) return null;
    return {
      kind: 'gully',
      path: track.map((p) => [p.x, p.z]),
      width: Math.max(...track.map((p) => p.width)),
      depth,
      shape: 'u',
      deposit: 0,
      start: Math.max(0, track[0].t),
      duration: Math.max(1e-3, track[track.length - 1].t - track[0].t),
      roughness: 0.6,
      seed: 7,
    };
  }
}
declare const GPUBufferUsage: { UNIFORM: number; COPY_DST: number };
type Context = Extract<PassContext, { backend: 'webgpu' }>;
/** The sky whose sun lights the tornado: `Sky` from `@margoengine/sky`. */
export interface TornadoSky {
  readonly sun: ArrayLike<number>;
  readonly options: { readonly turbidity?: number; readonly exposure?: number; readonly model?: string };
  readonly sunIlluminance?: number;
  readonly sunTransmittance?: ArrayLike<number>;
}
/** {@link TornadoCloud} settings, read every frame from `cloud.options`. */
export interface TornadoCloudOptions {
  /** The tornado to draw: a {@link Tornado} or its options. Required. */
  tornado: Tornado | TornadoOptions;
  /** The sky whose sun lights it; else `sunDirection`. */
  sky?: TornadoSky;
  /** Unit direction to the sun without a sky. Default [0.3, 0.6, 0.4]. */
  sunDirection?: readonly [number, number, number];
  /** Sun illuminance in the sky's units. Default the sky's own, 10 with the Preetham sky, else 20 (as the light shafts). */
  sunIlluminance?: number;
  /** Share of the sun reaching the storm under its deck, 0 to 1. Default 0.35 (a supercell's base is in shade). */
  sunShare?: number;
  /** Light of the sky round the storm, linear RGB over the sun's illuminance, 0 to 1 each. Default [0.05, 0.06, 0.075]. */
  ambient?: readonly [number, number, number];
  /** The scene depth, so hills and buildings hide the storm behind them; omitted, it draws over the scene. */
  depth?: () => GPUTexture | undefined;
  /** Steps along each view ray, 16 to 512. Default 160. */
  steps?: number;
  /** The plugin's name, so several tornadoes can share a scene. Default `'sky:tornado'`. */
  name?: string;
}
let loaded: typeof import('./tornado-shader.js') | undefined,
  loading: Promise<typeof import('./tornado-shader.js')> | undefined,
  loadError: unknown;
/** Loads the tornado's WGSL (kept out of pages that only read a `Tornado`'s weather). `TornadoCloud` starts it itself. */
export function loadTornadoShader(): Promise<void> {
  loading ??= import('./tornado-shader.js').then((m) => (loaded = m));
  return loading.then(() => undefined);
}
/** Whether the tornado's shader has loaded (`TornadoCloud.ready`). */
export const tornadoShaderLoaded = (): boolean => loaded !== undefined;
const toTornado = (t: Tornado | TornadoOptions): Tornado =>
  t instanceof Tornado || 'weatherAt' in t ? (t as Tornado) : new Tornado(t as TornadoOptions);
/**
 * Draws a {@link Tornado}: the condensation funnel its pressure deficit makes (rope to wedge), the wall cloud under the
 * base, the turning mesocyclone base and the debris cloud at the ground, moving along its path and spinning up and down
 * on the plugin's clock (`time`, moved by each frame update). Put it under a storm deck (`VolumetricClouds` with
 * `type: 'storm'` and `bottom` at the tornado's `cloudBase`). Its shader loads by import() at its first frame; until
 * it has (`ready`) it draws nothing. `TornadoCloud.attach(engine, {tornado, sky, depth})`.
 * @throws TypeError / RangeError on invalid options; MargoError `'unsupported'` on a WebGL engine, `'disposed'` after
 * `dispose()`, `'state'` when the camera matrix is not invertible.
 */
export class TornadoCloud implements EnginePlugin {
  readonly name: string;
  /** The tornado drawn (the one given, or one made from the options given). */
  readonly tornado: Tornado;
  private engine?: Engine;
  private uniform?: GPUBuffer;
  private pipeline?: GPURenderPipeline;
  private group?: GPUBindGroup;
  private key = '';
  private bound?: GPUTexture | GPUTextureView | null;
  private disposed = false;
  private seconds = 0;
  private readonly values = new Float32Array(96);
  private readonly scratch = new Float64Array(52);
  private readonly color = new Float32Array(3);
  private readonly profile = new Float32Array(FUNNEL_SAMPLES);
  constructor(readonly options: TornadoCloudOptions) {
    if (
      typeof options !== 'object' ||
      options === null ||
      typeof options.tornado !== 'object' ||
      options.tornado === null
    )
      throw new TypeError('TornadoCloud needs a tornado; pass {tornado: new Tornado({...})}');
    this.tornado = toTornado(options.tornado);
    this.name = options.name ?? 'sky:tornado';
    if (typeof this.name !== 'string' || !this.name)
      throw new TypeError('TornadoCloud name must be a non-empty string');
    this.validate();
  }
  static attach(engine: EngineKernel, options: TornadoCloudOptions): TornadoCloud {
    const cloud = new TornadoCloud(options);
    engineRuntime(engine).use(cloud);
    return cloud;
  }
  /** Resolves once the shader has loaded (the first frame starts it; so does reading this). */
  get ready(): Promise<void> {
    return loadTornadoShader();
  }
  /** Seconds on this plugin's clock: where the tornado is on its path and how far it has spun up. */
  get time(): number {
    return this.seconds;
  }
  /** Sets the clock (a seek). */
  setTime(seconds: number): this {
    if (!Number.isFinite(seconds)) throw new RangeError('Invalid TornadoCloud time; pass finite seconds.');
    this.seconds = seconds;
    return this;
  }
  /**
   * Puts the clock back to 0 (the tornado at the start of its path, not spun up), as a fresh one has it, so a later
   * `seek` (`resetClocks` from `@margoengine/cutscene/seek` calls it on every clock) gives what a fresh world seeked
   * there gives (GAP-FILM-RESET).
   */
  resetTime(): void {
    this.seconds = 0;
  }
  /** Moves the clock by `delta` seconds: the CPU part of the frame update, which a seek replays. */
  advanceTime(delta: number): void {
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('Invalid TornadoCloud delta; pass finite seconds >= 0.');
    this.seconds += delta;
  }
  onPreUpdate(delta: number): void {
    this.validate();
    this.advanceTime(delta);
  }
  private validate(): void {
    const o = this.options;
    resolveTornado(this.tornado.options);
    if (o.sky !== undefined && (typeof o.sky !== 'object' || o.sky === null || !(o.sky.sun?.length >= 3)))
      throw new TypeError(
        'TornadoCloud sky must be a Sky (with a sun direction); pass the sky whose sun lights the storm',
      );
    if (o.sunDirection) finiteVector(o.sunDirection, 3, 'TornadoCloud sunDirection');
    if (o.sunDirection && !(Math.hypot(...o.sunDirection) > 0))
      throw new RangeError('TornadoCloud sunDirection needs a nonzero length');
    if (o.depth !== undefined && typeof o.depth !== 'function')
      throw new TypeError('TornadoCloud depth must be a function returning the scene depth texture');
    const steps = o.steps ?? 160;
    if (!Number.isInteger(steps) || steps < 16 || steps > 512)
      throw new RangeError('Invalid TornadoCloud steps; pass a whole number from 16 to 512.');
    if (o.sunIlluminance !== undefined && !inRange(o.sunIlluminance, 0, 1e6))
      throw new RangeError('Invalid TornadoCloud sunIlluminance; pass 0 or more.');
    if (o.sunShare !== undefined && !inRange(o.sunShare, 0, 1))
      throw new RangeError('Invalid TornadoCloud sunShare; pass a number from 0 to 1.');
    if (
      o.ambient !== undefined &&
      (!Array.isArray(o.ambient) || o.ambient.length !== 3 || !o.ambient.every((c) => inRange(c, 0, 1)))
    )
      throw new TypeError('Invalid TornadoCloud ambient; pass [r, g, b], each from 0 to 1.');
  }
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'TornadoCloud requires WebGPU; attach a new TornadoCloud to a WebGPU engine; see https://margoengine.com/errors#webgpu',
      );
    this.engine = engine;
    this.uniform = engine.gpu.createBuffer({
      size: this.values.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }
  registerPasses(graph: FrameGraph): void {
    // After the clouds (3), before the aerial perspective (4): the storm sits under the deck, in the air the haze dims.
    graph.add({
      name: this.name,
      order: 3.5,
      execute: (c) => {
        if (c.backend === 'webgpu') this.draw(c as Context);
      },
    });
  }
  // The uniform for the frame: the camera, the light, the storm at the clock's time and the funnel's table.
  private write(c: Context): void {
    const o = this.options,
      v = this.values,
      s = resolveTornado(this.tornado.options),
      t = this.seconds,
      k = tornadoStrength(s, t),
      sky = o.sky,
      sun = sky?.sun ?? o.sunDirection ?? [0.3, 0.6, 0.4],
      length = Math.hypot(sun[0], sun[1], sun[2]) || 1;
    if (!invertMatrixStable(c.camera.matrix, v.subarray(0, 16), this.scratch))
      throw new MargoError('state', 'Invalid TornadoCloud camera; give the camera a finite, invertible projection');
    v.set(c.camera.position, 16);
    v[19] = t;
    const up = sun[1] / length;
    for (let i = 0; i < 3; i++) v[20 + i] = sun[i] / length;
    if (sky?.sunTransmittance) for (let i = 0; i < 3; i++) this.color[i] = sky.sunTransmittance[i];
    else sunlight(up, 0.001, sky?.options.turbidity ?? 2, this.color);
    const illuminance =
        o.sunIlluminance ?? sky?.sunIlluminance ?? (sky && (sky.options.model ?? 'preetham') === 'preetham' ? 10 : 20),
      scale = illuminance * 2 ** (sky?.options.exposure ?? 0);
    v[23] = scale * (o.sunShare ?? 0.35);
    for (let i = 0; i < 3; i++) v[24 + i] = this.color[i];
    v[27] = +!linearHdr(c.format);
    const ambient = o.ambient ?? [0.05, 0.06, 0.075],
      daylight = 0.15 + 0.85 * clamp01(up * 4 + 0.2);
    for (let i = 0; i < 3; i++) v[28 + i] = ambient[i] * scale * daylight;
    v[31] = s.wallDensity;
    const centre = tornadoCenter(s, t, [0, 0]);
    v[32] = centre[0];
    v[33] = centre[1];
    v[34] = s.wallBase;
    v[35] = s.cloudBase;
    v[36] = s.rc;
    v[37] = s.wallRadius;
    v[38] = s.mesoRadius;
    v[39] = Math.max(1.1 * s.mesoRadius, 1.2 * s.wallRadius) + Math.hypot(s.tiltX, s.tiltZ) + s.meander;
    v[40] = s.spin;
    v[41] = tornadoPeakWind(s, k) / s.rc;
    v[42] = s.mesoWind / s.mesoRadius;
    v[43] = s.burgers ? 1 : s.decay;
    v[44] = s.tiltX;
    v[45] = s.tiltZ;
    v[46] = s.meander;
    v[47] = (t * 0.05) % (2 * Math.PI);
    v[48] = debrisRadius(s, k);
    v[49] = s.debrisHeight * k;
    v[50] = s.debrisDensity;
    v[51] = s.funnelDensity;
    v.set(s.debrisColor, 52);
    v[55] = s.turbulence;
    v[56] = o.steps ?? 160;
    v[57] = (((t / s.flowPeriod) % 1) + 1) % 1;
    v[58] = s.flowPeriod;
    v[59] = funnelBottom(s, k);
    const rect = viewRect(c);
    if (rect) v.set([rect[0] / c.width, rect[1] / c.height, rect[2] / c.width, rect[3] / c.height], 60);
    else v.set([0, 0, 1, 1], 60);
    v.set(funnelProfile(s, k, this.profile), 64);
    c.device.queue.writeBuffer(this.uniform!, 0, v as Float32Array<ArrayBuffer>);
  }
  private draw(c: Context): void {
    if (!this.uniform) return;
    if (loadError !== undefined) throw loadError;
    if (!loaded) {
      // The shader loads on first use; until it has, the storm draws nothing (`ready`).
      loadTornadoShader().catch((e: unknown) => (loadError = e ?? new Error('tornado shader failed to load')));
      return;
    }
    const depth = this.options.depth ? sceneDepth(c, this.options.depth, 'TornadoCloud') : undefined;
    if (this.options.depth && !depth) return;
    this.write(c);
    const d = c.device,
      key = `${c.format}:${c.descriptor.multisample?.count ?? 1}:${depth?.samples ?? 0}`;
    if (this.key !== key) {
      const module = d.createShaderModule({
        code: loaded.tornadoShader(fullscreen, displayShader, depth ? depthWGSL(1, depth.samples) : ''),
      });
      this.pipeline = d.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: {
          module,
          entryPoint: 'fragment',
          targets: [
            {
              format: c.format,
              // Premultiplied: the scene times the storm's transmittance (alpha), plus its light.
              blend: {
                color: { srcFactor: 'one', dstFactor: 'src-alpha', operation: 'add' },
                alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
              },
            },
          ],
        },
        multisample: c.descriptor.multisample,
      });
      this.key = key;
      this.group = undefined;
    }
    const texture = depth?.texture ?? null;
    if (this.bound !== texture || !this.group) {
      this.group = d.createBindGroup({
        layout: this.pipeline!.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.uniform } },
          ...(depth ? [{ binding: 1, resource: depth.resource }] : []),
        ],
      });
      this.bound = texture;
    }
    const pass = c.encoder.beginRenderPass({ colorAttachments: [{ view: c.color, loadOp: 'load', storeOp: 'store' }] });
    applyView(pass, c);
    pass.setPipeline(this.pipeline!);
    pass.setBindGroup(0, this.group);
    pass.draw(3);
    pass.end();
  }
  private release(): void {
    this.uniform?.destroy();
    this.uniform = this.pipeline = this.group = this.bound = undefined;
    this.key = '';
  }
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
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
