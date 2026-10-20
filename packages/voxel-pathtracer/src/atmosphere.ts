// MagicaVoxel's atmosphere sky, reproduced: single scattering through a spherical atmosphere (Nishita et al. 1993)
// with Rayleigh scattering, Mie scattering with the Cornette-Shanks phase function (1992) and an ozone-like absorber,
// all with exponential height profiles. The constants, and how MagicaVoxel's `_atm` settings scale them, were fitted to
// MagicaVoxel's own panoramas of our scenes (black-box; 16 panoramas). The fit wants a thin atmosphere (top 8 km) over
// a flatter planet than Earth's (radius 25 000 km): 0.6-1% RMS per panorama for the default settings, for each density
// setting changed alone, and for g and colour changes; 3% with the ozone at 1 or Rayleigh density 0.8-1. The result is
// baked into an equirectangular map the tracer importance-samples.
import type { TraceEnvironmentMap, TraceVec3 } from './types.js';

/** MagicaVoxel `_atm` settings (densities as stored, colours as 0-1 fractions of 255). */
export interface AtmosphereSettings {
  /** `_ray_d`: Rayleigh density. */
  rayleigh: number;
  /** `_ray_k`: Rayleigh colour / 255 (the scattering ratio per channel; Earth's is 45, 104, 255). */
  rayleighColor: TraceVec3;
  /** `_mie_d`: Mie density. */
  mie: number;
  /** `_mie_k`: Mie colour / 255. */
  mieColor: TraceVec3;
  /** `_mie_g`: Mie anisotropy (Cornette-Shanks g). */
  mieG: number;
  /** `_o3_d`: ozone density. */
  ozone: number;
  /** `_o3_k`: ozone absorption colour / 255. */
  ozoneColor: TraceVec3;
}

const PLANET = 25000,
  TOP = PLANET + 8,
  HR = 3.1537, // km, fitted
  HM = 3.4329,
  RAYLEIGH = 0.047073, // per km at _ray_d 0.4, blue channel
  MIE = 0.0029483, // per km at _mie_d 0.4
  SKY = 10.891, // in-scatter source per unit of the sun's `_i`
  OZONE = 0.4768; // per km at _o3_d 1 (Rayleigh-shaped profile)

/** Scattering scale of a density slider relative to its default 0.4: (e^(3.3 d) - 1) / (e^1.32 - 1) (fitted). */
const densityScale = (d: number) => (d > 0 ? (Math.exp(3.3 * d) - 1) / (Math.exp(1.32) - 1) : 0);
/** Mie extinction over Mie scattering (fitted: 1.25 at 0.2, 1.21 at 0.4, 1.12 at 0.7, 1.10 at 1). */
const mieExtinction = (d: number) => Math.max(0.05, 1.29 - 0.2 * d);

/** Coefficients per channel. */
function coefficients(s: AtmosphereSettings) {
  const r = RAYLEIGH * densityScale(s.rayleigh),
    m = MIE * densityScale(s.mie),
    e = mieExtinction(s.mie);
  return {
    rayleigh: s.rayleighColor.map((k) => k * r),
    mie: s.mieColor.map((k) => k * m),
    mieExt: s.mieColor.map((k) => k * m * e),
    ozone: s.ozoneColor.map((k) => k * OZONE * s.ozone),
  };
}

/** Distance from p (km, planet centre at the origin) along unit d to the sphere of radius r; -1 when missed. */
function sphere(p: number[], d: number[], r: number): number {
  const b = p[0] * d[0] + p[1] * d[1] + p[2] * d[2],
    c = p[0] * p[0] + p[1] * p[1] + p[2] * p[2] - r * r,
    disc = b * b - c;
  if (disc < 0) return -1;
  const q = Math.sqrt(disc);
  return -b - q > 1e-6 ? -b - q : -b + q > 1e-6 ? -b + q : -1;
}

/** Optical depths (Rayleigh-profile, Mie-profile) from p toward d to the top; Infinity when the planet blocks it. */
function depths(p: number[], d: number[], steps: number): [number, number] {
  if (sphere(p, d, PLANET) > 0) return [Infinity, Infinity];
  const t = sphere(p, d, TOP),
    dt = t / steps;
  let r = 0,
    m = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt,
      h = Math.hypot(p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s) - PLANET;
    r += Math.exp(-h / HR) * dt;
    m += Math.exp(-h / HM) * dt;
  }
  return [r, m];
}

/** Rayleigh and Mie in-scatter along `path` from the ground to the top (per unit of the sun), before the phase. */
function inScatter(path: number[], sun: number[], s: AtmosphereSettings): { r: number[]; m: number[] } {
  const o = [0, 0, PLANET + 0.001],
    c = coefficients(s),
    t = sphere(o, path, TOP),
    N = 32,
    ds = t / N,
    r = [0, 0, 0],
    m = [0, 0, 0];
  let tr = 0,
    tm = 0;
  for (let i = 0; i < N; i++) {
    const x = (i + 0.5) * ds,
      p = [o[0] + path[0] * x, o[1] + path[1] * x, o[2] + path[2] * x],
      h = Math.hypot(p[0], p[1], p[2]) - PLANET,
      dr = Math.exp(-h / HR) * ds,
      dm = Math.exp(-h / HM) * ds,
      [lr, lm] = depths(p, sun, 16);
    tr += dr;
    tm += dm;
    if (lr === Infinity) continue;
    for (let k = 0; k < 3; k++) {
      const tau = (c.rayleigh[k] + c.ozone[k]) * (tr - dr / 2 + lr) + c.mieExt[k] * (tm - dm / 2 + lm),
        a = Math.exp(-tau) * SKY;
      r[k] += a * c.rayleigh[k] * dr;
      m[k] += a * c.mie[k] * dm;
    }
  }
  return { r, m };
}

/** Rayleigh and Cornette-Shanks phase values for the cosine `mu` between the view and the sun. */
function phases(mu: number, g: number): [number, number] {
  return [
    (3 / (16 * Math.PI)) * (1 + mu * mu),
    ((3 / (8 * Math.PI)) * (1 - g * g) * (1 + mu * mu)) / ((2 + g * g) * (1 + g * g - 2 * g * mu) ** 1.5),
  ];
}

/**
 * The path a view direction's light comes along: the view itself, held at the horizon when it points lower (the sky
 * keeps reddening right down to the horizon: MagicaVoxel's view into a low sun, 0.03-0.4 degrees up).
 */
function pathOf(view: number[]): number[] {
  if (view[2] >= 0) return view;
  const n = Math.hypot(view[0], view[1]) || 1;
  return [view[0] / n, view[1] / n, 0];
}

/**
 * Sky radiance toward z-up direction `view` (MagicaVoxel axes) for a sun toward `sun`, per unit of the sun's
 * intensity and colour. Below the horizon, as in MagicaVoxel (measured), the light comes along the horizon's path while
 * the phase follows the view, so the sun's forward glow fades as the view drops below it.
 */
export function atmosphereRadiance(view: number[], sun: number[], s: AtmosphereSettings): TraceVec3 {
  const { r, m } = inScatter(pathOf(view), sun, s),
    [pR, pM] = phases(view[0] * sun[0] + view[1] * sun[1] + view[2] * sun[2], s.mieG);
  return [r[0] * pR + m[0] * pM, r[1] * pR + m[1] * pM, r[2] * pR + m[2] * pM];
}

/** Transmittance of sunlight from direction `sun` (z up) to the ground, per channel. */
export function atmosphereTransmittance(sun: number[], s: AtmosphereSettings): TraceVec3 {
  const c = coefficients(s),
    [r, m] = depths([0, 0, PLANET + 0.001], sun, 64);
  if (r === Infinity) return [0, 0, 0];
  return [0, 1, 2].map((k) => Math.exp(-((c.rayleigh[k] + c.ozone[k]) * r + c.mieExt[k] * m))) as unknown as TraceVec3;
}

/**
 * What a baked atmosphere map holds below the horizon: 'horizon', the horizon's light in each azimuth with the view's
 * phase (what the far ground fades into: MagicaVoxel with its ground on), or 'surface', that light fading with depth
 * into a dim surface lit by the sun and sky (MagicaVoxel with its ground off).
 */
export type AtmosphereBelow = 'horizon' | 'surface';

// 'surface' (fitted to 10 of MagicaVoxel's panoramas with its ground off, sun 5 to 90 degrees, default and singly
// changed air: 1.4-4.5 levels RMS on 2-degree blocks): at depression d the horizon's light keeps the share
// w = exp(-(sin d / (BELOW_SCALE sin(sun)^BELOW_SUN))^BELOW_POWER), the rest is BELOW_ALBEDO / pi times the sun and
// sky light on level ground.
const BELOW_SCALE = 1.08,
  BELOW_SUN = 0.81,
  BELOW_POWER = 0.68,
  BELOW_ALBEDO = 0.035;

/**
 * The sky baked into an equirectangular map in tracer axes (y up; MagicaVoxel (x, y, z) = tracer (x, -z, y)). `scale`
 * multiplies each channel (the sun's `_i` times its colour). Above the horizon every row within 3 degrees of it is
 * integrated and, higher up, every `height / 256`-th, the rows between interpolated (a tall map resolves the band just
 * above the horizon at about the cost of a 256-row one). Below the horizon each column's horizon path is integrated
 * once and shown as `below` says.
 */
export function bakeAtmosphere(
  sunMagicaVoxel: number[],
  s: AtmosphereSettings,
  scale: TraceVec3,
  width = 256,
  height = 128,
  below: AtmosphereBelow = 'horizon',
): TraceEnvironmentMap {
  const data = new Float32Array(width * height * 3),
    sun = sunMagicaVoxel,
    above = Math.ceil(height / 2),
    step = Math.max(1, Math.round(height / 256)),
    elevation = (y: number) => Math.PI / 2 - ((y + 0.5) / height) * Math.PI,
    // Rows integrated: the top one, every step-th, all within 3 degrees of the horizon and the last above it.
    exact = (y: number) => y === 0 || y % step === 0 || y === above - 1 || elevation(y) < (3 * Math.PI) / 180,
    rows = Array.from({ length: above }, (_, y) => y).filter(exact),
    lows: { r: number[]; m: number[] }[] = [];
  // The map's centre column faces -Z and its three-quarter column +X (TraceEnvironmentMap): tracer direction
  // (sin phi, 0, -cos phi) at the horizon, which is MagicaVoxel (sin phi, cos phi, 0).
  const view = (x: number, y: number) => {
    const phi = ((x + 0.5) / width - 0.5) * 2 * Math.PI,
      theta = ((y + 0.5) / height) * Math.PI;
    return [Math.sin(theta) * Math.sin(phi), Math.sin(theta) * Math.cos(phi), Math.cos(theta)];
  };
  for (let x = 0; x < width; x++) {
    let prev = -1;
    for (const y of rows) {
      const L = atmosphereRadiance(view(x, y), sun, s);
      data.set([L[0] * scale[0], L[1] * scale[1], L[2] * scale[2]], 3 * (y * width + x));
      // Rows skipped since the last integrated one: linear in elevation between the two.
      for (let k = prev + 1; prev >= 0 && k < y; k++) {
        const t = (elevation(prev) - elevation(k)) / (elevation(prev) - elevation(y));
        for (let c = 0; c < 3; c++)
          data[3 * (k * width + x) + c] =
            data[3 * (prev * width + x) + c] * (1 - t) + data[3 * (y * width + x) + c] * t;
      }
      prev = y;
    }
    lows.push(inScatter(pathOf(view(x, height - 1)), sun, s));
  }
  // The dim surface of 'surface': the sun through the air and the sky above on level ground.
  const ground = [0, 0, 0];
  if (below === 'surface') {
    const t = atmosphereTransmittance(sun, s),
      dOmega = (Math.PI / height) * ((2 * Math.PI) / width);
    for (let y = 0; y < above; y++) {
      const theta = ((y + 0.5) / height) * Math.PI,
        w = Math.max(0, Math.cos(theta)) * Math.sin(theta) * dOmega;
      for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) ground[c] += data[3 * (y * width + x) + c] * w;
    }
    for (let c = 0; c < 3; c++)
      ground[c] = (BELOW_ALBEDO / Math.PI) * (ground[c] + 10 * scale[c] * t[c] * Math.max(0, sun[2]));
  }
  const depth = BELOW_SCALE * Math.max(1e-3, sun[2]) ** BELOW_SUN;
  for (let x = 0; x < width; x++) {
    const low = lows[x];
    for (let y = above; y < height; y++) {
      const v = view(x, y),
        [pR, pM] = phases(v[0] * sun[0] + v[1] * sun[1] + v[2] * sun[2], s.mieG),
        w = below === 'surface' ? Math.exp(-((-v[2] / depth) ** BELOW_POWER)) : 1;
      for (let c = 0; c < 3; c++)
        data[3 * (y * width + x) + c] = w * (low.r[c] * pR + low.m[c] * pM) * scale[c] + (1 - w) * ground[c];
    }
  }
  return { width, height, data };
}
