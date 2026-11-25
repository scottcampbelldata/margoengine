// A hurricane: its wind (the Holland 1980 profile), its rain and the shape of its cloud (the eye, the sloping eyewall,
// the moat, a concentric outer eyewall, the spiral rain bands, the stratiform shield and the cirrus canopy), CPU only.
// `VolumetricClouds` draws the same cloud on the GPU (its `hurricane` option); `@margoengine/weather` takes the wind and
// rain at a place through `WeatherRegions` (its `storms` option), so the weather follows the bands.
//
// Sources (read for the model; no code from anywhere):
// - G. J. Holland, "An analytic model of the wind and pressure profiles in hurricanes", Mon. Wea. Rev. 108, 1212-1218,
//   1980, https://doi.org/10.1175/1520-0493(1980)108<1212:AAMOTW>2.0.CO;2: p(r) = pc + dp exp(-(R/r)^B), the gradient
//   wind V = sqrt(B dp (R/r)^B exp(-(R/r)^B) / rho + (r f / 2)^2) - r f / 2, its peak near R and, without the Coriolis
//   term, V(R) = sqrt(B dp / (rho e)); B from 1 to 2.5.
// - H. E. Willoughby, J. A. Clos and M. G. Shoreibah, "Concentric eye walls, secondary wind maxima, and the evolution of
//   the hurricane vortex", J. Atmos. Sci. 39, 395-411, 1982: an outer eyewall ring with its own wind maximum, a moat of
//   weak echo between it and the inner eyewall.
// - H. E. Willoughby, F. D. Marks and R. J. Feinberg, "Stationary and moving convective bands in hurricanes", J. Atmos.
//   Sci. 41, 3189-3211, 1984: the principal band, which spirals in to join the eyewall, and the stationary band complex
//   that stays nearly fixed to the storm centre while the cloud blows through it (so the band pattern here holds still,
//   `bandDrift` 0, while the cloud texture turns with the wind).
// - H. F. Senn and H. W. Hiser, "On the origin of hurricane spiral rain bands", J. Meteor. 16, 419-426, 1959: radar
//   rain bands fit logarithmic spirals, r = a exp(-theta tan(alpha)), with crossing angles alpha of about 10 to 25
//   degrees (15 here).
// - R. A. Houze Jr., "Clouds in tropical cyclones", Mon. Wea. Rev. 138, 293-344, 2010,
//   https://doi.org/10.1175/2009MWR2989.1: the clear eye with low stratocumulus at its floor, the eyewall leaning out
//   with height (the stadium), cloud tops near the tropopause (about 15 km), the moat, the bands' lower tops, the
//   stratiform shield and the cirrus canopy over the core.
// - A. T. Hazelton and R. E. Hart, "Hurricane eyewall slope as determined from airborne radar reflectivity data:
//   composites and case studies", Wea. Forecasting 28, 368-386, 2013, https://doi.org/10.1175/WAF-D-12-00037.1: the
//   inverse slope of the eye's edge (radius gained per height) peaks between 1 and 1.5; 1.2 here.
// - R. E. Tuleya, M. DeMaria and R. J. Kuligowski, "Evaluation of GFDL and simple statistical model rainfall forecasts
//   for U.S. landfalling tropical storms", Wea. Forecasting 22, 56-70, 2007 (R-CLIPER): the rain rate rises linearly to
//   its peak at radius rm and falls as exp(-(r - rm) / re) outside it.
// - J. A. Zhang and E. W. Uhlhorn, "Hurricane sea surface inflow angle and an observation-based parametric model", Mon.
//   Wea. Rev. 140, 3587-3605, 2012: the surface wind turns in toward the centre by about 22 degrees on average.
// - J. L. Franklin, M. L. Black and K. Valde, "GPS dropwindsonde wind profiles in hurricanes and their operational
//   implications", Wea. Forecasting 18, 32-44, 2003: the surface wind is about 0.9 of the wind above the boundary layer
//   in the eyewall.
// - B. A. Harper, J. D. Kepert and J. D. Ginger, "Guidelines for converting between various wind averaging periods in
//   tropical cyclone conditions", WMO/TD-No. 1555, 2010: the at-sea gust factor of a 3 s gust over the mean, 1.23.
// - J. Molinari, P. Moore and V. Idone, "Convective structure of hurricanes as revealed by lightning locations", Mon.
//   Wea. Rev. 127, 520-534, 1999: lightning is weak in the eyewall, rare in the moat and strongest in the outer bands.
// - A. Vlachos, "Water flow in Portal 2", SIGGRAPH 2010 Advances in Real-Time Rendering: two texture phases advected by a
//   flow field half a period apart and cross-faded, so the cloud turns with the wind without shearing apart.

/** {@link Hurricane} settings, read live. Lengths are metres, speeds metres per second, angles degrees unless named. */
export interface HurricaneOptions {
  /** Storm centre at time 0, world `[x, z]`. Default [0, 0]. */
  center?: readonly [number, number];
  /** Storm motion `[x, z]` in m/s, 0 to 50 each way. Default [0, 0]. */
  velocity?: readonly [number, number];
  /** Central pressure deficit below the 1010 hPa ambient, 5 to 150 hPa. Default 60 (a strong category 3). */
  pressureDrop?: number;
  /** Radius of maximum wind, 5,000 to 200,000 m. Default 30,000. */
  maxWindRadius?: number;
  /** Holland's B, the peakedness of the profile, 1 to 2.5. Default 1.5. */
  holland?: number;
  /** Latitude, 1 to 60 degrees north or -1 to -60 south: the Coriolis term, and the turn (anticlockwise seen from above in the north). Default 20. */
  latitude?: number;
  /** Air density, 1 to 1.3 kg/m3. Default 1.15. */
  airDensity?: number;
  /** Surface wind over the gradient wind, 0.5 to 1. Default 0.9 (Franklin, Black and Valde 2003). */
  surfaceFactor?: number;
  /** Inflow angle of the surface wind toward the centre, 0 to 45 degrees. Default 22 (Zhang and Uhlhorn 2012). */
  inflow?: number;
  /** 3 second gust over the mean wind in the open storm, 1 to 2. Default 1.23 (Harper, Kepert and Ginger 2010, at sea). Convective bands and the eyewall add half again of the excess. */
  gustFactor?: number;
  /** Radius of the clear eye at the cloud base, 1,000 to 100,000 m. Default 0.7 of `maxWindRadius`. */
  eyeRadius?: number;
  /** Radius the eye's edge gains per metre of height (the stadium), 0 to 4. Default 1.2 (Hazelton and Hart 2013). */
  eyeSlope?: number;
  /** Width of the eyewall, 2,000 to 60,000 m. Default 18,000. */
  eyewallWidth?: number;
  /** Cover of the low cloud on the eye's floor, 0 to 1. Default 0.25. */
  eyeCloud?: number;
  /** Radius of a concentric outer eyewall at the base, 0 (none) to 400,000 m. Default 0. */
  outerEyewall?: number;
  /** Strength of the outer eyewall, cloud and wind, 0 to 1. Default 0.8. */
  outerEyewallStrength?: number;
  /** Cover of the moat between the eyewall and the bands, 0 to 1. Default 0.1. */
  moat?: number;
  /** Number of spiral rain bands, a whole number 0 to 8. Default 3. */
  bands?: number;
  /** Crossing angle of the bands with a circle round the centre, 5 to 40 degrees. Default 15 (Senn and Hiser 1959). */
  bandPitch?: number;
  /** Width of a band across it, 2,000 to 80,000 m. Default 14,000. */
  bandWidth?: number;
  /** Radius where the bands start, past the moat, 5,000 to 500,000 m. Default 2.5 times `maxWindRadius`. */
  bandStart?: number;
  /** Top of the bands as a share of the layer, 0.2 to 1. Default 0.6. */
  bandTop?: number;
  /** Turn of the band pattern, radians. Default 0. */
  bandRotation?: number;
  /** Turn rate of the band pattern, -0.01 to 0.01 radians a second. Default 0 (the stationary band complex). */
  bandDrift?: number;
  /** How much wider and stronger the first (principal) band is, and how far in it reaches (to the eyewall at 1), 0 to 1. Default 0.5. */
  principalBand?: number;
  /** Outer radius of the storm's cloud, 20,000 to 1,000,000 m. Default 350,000. */
  extent?: number;
  /** Cover of the stratiform shield between the bands, 0 to 1. Default 0.3. */
  shield?: number;
  /** Cover of the cirrus canopy over the core, near the tops, 0 to 1. Default 0.6. */
  canopy?: number;
  /** Peak rain rate in the eyewall, 0 to 300 mm/h. Default 50. */
  rainMax?: number;
  /** Distance over which the rain falls off by 1/e outside the eyewall, 10,000 to 1,000,000 m. Default 150,000. */
  rainExtent?: number;
  /** Seconds between the two cross-faded phases of the turning cloud, 30 to 7,200. Default 900. */
  flowPeriod?: number;
  /** The cloud's turn over the wind's (gradient wind over radius), 0 to 4. Default 1; 0 holds the cloud still. */
  swirl?: number;
}
/** Where a point lies in the storm. */
export type HurricaneRegion = 'eye' | 'eyewall' | 'moat' | 'outerEyewall' | 'band' | 'shield' | 'outside';
/** The wind at a place: {@link Hurricane.windAt}. */
export interface HurricaneWind {
  /** Mean surface wind, m/s. */
  speed: number;
  /** 3 second gust, m/s. */
  gust: number;
  /** World `[x, z]` velocity, m/s. */
  velocity: [number, number];
  /** Direction the wind blows toward, radians, 0 toward +Z and pi/2 toward +X (the weather's `windDirection`). */
  direction: number;
}
/** The weather a hurricane makes at a place, on the weather's scales: {@link Hurricane.weatherAt}. */
export interface HurricaneWeather {
  /** How much of the storm is here, 0 to 1 (1 inside, 0 past its extent). */
  weight: number;
  /** Mean wind, m/s, at most 60 (the weather's range; {@link Hurricane.windAt} has the true speed). */
  wind: number;
  /** Gustiness 0 to 1: 0 in the calm eye, 1 in the eyewall. */
  gust: number;
  windDirection: number;
  /** Rain 0 to 1 on the weather's scale, `(rate / 80) ^ (1/3)` of the rain rate in mm/h. */
  rain: number;
  /** Cloud cover overhead, 0 to 1. */
  cloud: number;
  /** Lightning, 0 to 1: weak in the eyewall, rare in the moat, strongest in the outer bands (Molinari et al. 1999). */
  lightning: number;
  humidity: number;
}
/** The cover parts at a place: {@link Hurricane.coverAt} with `parts`. */
export interface HurricaneCover {
  eye: number;
  eyewall: number;
  outerEyewall: number;
  moat: number;
  band: number;
  shield: number;
  canopy: number;
  /** The largest of them. */
  cover: number;
}
/** Cloud base and tops of a hurricane layer (`cloudLayerFor(..., 'hurricane')`), metres. */
export const HURRICANE_LAYER = { bottom: 500, top: 15000 } as const;
const OMEGA = 7.2921e-5;
const AMBIENT = 1010;
const DEG = Math.PI / 180;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const inRange = (v: unknown, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
/** The numbers the storm's formulas use, resolved from the options with their defaults (shared with the GPU uniform). */
export interface ResolvedHurricane {
  cx: number;
  cz: number;
  vx: number;
  vz: number;
  dp: number;
  rmax: number;
  b: number;
  rho: number;
  f: number;
  /** +1 north (anticlockwise seen from above), -1 south. */
  spin: number;
  surface: number;
  inflow: number;
  gust: number;
  eye: number;
  slope: number;
  wall: number;
  eyeCloud: number;
  outer: number;
  outerStrength: number;
  moat: number;
  bands: number;
  pitch: number;
  bandWidth: number;
  bandStart: number;
  bandTop: number;
  bandRotation: number;
  bandDrift: number;
  principal: number;
  extent: number;
  shield: number;
  canopy: number;
  rainMax: number;
  rainExtent: number;
  flowPeriod: number;
  swirl: number;
}
/**
 * Checks `o` and returns its numbers with the defaults filled in.
 * @throws TypeError for a bad pair; RangeError for a value outside its range (each named in the message).
 */
export function resolveHurricane(o: HurricaneOptions = {}): ResolvedHurricane {
  if (typeof o !== 'object' || o === null)
    throw new TypeError('Hurricane options must be an object; pass {} for the defaults.');
  const pair = (v: readonly [number, number] | undefined, name: string, limit: number): readonly [number, number] => {
    if (v === undefined) return [0, 0];
    if (!Array.isArray(v) || v.length !== 2 || !inRange(v[0], -limit, limit) || !inRange(v[1], -limit, limit))
      throw new TypeError(`Invalid Hurricane ${name}; pass [x, z], each from ${-limit} to ${limit}.`);
    return v;
  };
  const num = (v: number | undefined, name: string, lo: number, hi: number, fallback: number) => {
    if (v === undefined) return fallback;
    if (!inRange(v, lo, hi)) throw new RangeError(`Invalid Hurricane ${name}; pass a number from ${lo} to ${hi}.`);
    return v;
  };
  const center = pair(o.center, 'center', 1e9),
    velocity = pair(o.velocity, 'velocity', 50),
    rmax = num(o.maxWindRadius, 'maxWindRadius', 5000, 200000, 30000),
    latitude = num(o.latitude, 'latitude', -60, 60, 20);
  if (Math.abs(latitude) < 1)
    throw new RangeError('Invalid Hurricane latitude; pass 1 to 60 north or -1 to -60 south.');
  const bands = num(o.bands, 'bands', 0, 8, 3);
  if (!Number.isInteger(bands)) throw new RangeError('Invalid Hurricane bands; pass a whole number from 0 to 8.');
  const outer = num(o.outerEyewall, 'outerEyewall', 0, 400000, 0);
  const eye = num(o.eyeRadius, 'eyeRadius', 1000, 100000, 0.7 * rmax),
    wall = num(o.eyewallWidth, 'eyewallWidth', 2000, 60000, 18000),
    bandStart = num(o.bandStart, 'bandStart', 5000, 500000, 2.5 * rmax),
    extent = num(o.extent, 'extent', 20000, 1000000, 350000);
  if (!(bandStart > eye)) throw new RangeError('Invalid Hurricane bandStart; it must lie outside the eyeRadius.');
  if (!(extent > bandStart)) throw new RangeError('Invalid Hurricane extent; it must lie outside the bandStart.');
  return {
    cx: center[0],
    cz: center[1],
    vx: velocity[0],
    vz: velocity[1],
    dp: num(o.pressureDrop, 'pressureDrop', 5, 150, 60) * 100,
    rmax,
    b: num(o.holland, 'holland', 1, 2.5, 1.5),
    rho: num(o.airDensity, 'airDensity', 1, 1.3, 1.15),
    f: 2 * OMEGA * Math.sin(Math.abs(latitude) * DEG),
    spin: latitude > 0 ? 1 : -1,
    surface: num(o.surfaceFactor, 'surfaceFactor', 0.5, 1, 0.9),
    inflow: num(o.inflow, 'inflow', 0, 45, 22) * DEG,
    gust: num(o.gustFactor, 'gustFactor', 1, 2, 1.23),
    eye,
    slope: num(o.eyeSlope, 'eyeSlope', 0, 4, 1.2),
    wall,
    eyeCloud: num(o.eyeCloud, 'eyeCloud', 0, 1, 0.25),
    outer,
    outerStrength: num(o.outerEyewallStrength, 'outerEyewallStrength', 0, 1, 0.8),
    moat: num(o.moat, 'moat', 0, 1, 0.1),
    bands,
    pitch: num(o.bandPitch, 'bandPitch', 5, 40, 15) * DEG,
    bandWidth: num(o.bandWidth, 'bandWidth', 2000, 80000, 14000),
    bandStart,
    bandTop: num(o.bandTop, 'bandTop', 0.2, 1, 0.6),
    bandRotation: num(o.bandRotation, 'bandRotation', -1000, 1000, 0),
    bandDrift: num(o.bandDrift, 'bandDrift', -0.01, 0.01, 0),
    principal: num(o.principalBand, 'principalBand', 0, 1, 0.5),
    extent,
    shield: num(o.shield, 'shield', 0, 1, 0.3),
    canopy: num(o.canopy, 'canopy', 0, 1, 0.6),
    rainMax: num(o.rainMax, 'rainMax', 0, 300, 50),
    rainExtent: num(o.rainExtent, 'rainExtent', 10000, 1000000, 150000),
    flowPeriod: num(o.flowPeriod, 'flowPeriod', 30, 7200, 900),
    swirl: num(o.swirl, 'swirl', 0, 4, 1),
  };
}
/**
 * Holland's (1980) gradient wind at radius `r` metres, m/s: sqrt(B dp (R/r)^B exp(-(R/r)^B) / rho + (r f / 2)^2) - r f / 2.
 * 0 at the centre; its peak lies at R without the Coriolis term and just inside it with.
 */
export function hollandWind(r: number, s: ResolvedHurricane = resolveHurricane()): number {
  if (!(r > 0)) return 0;
  const x = Math.min((s.rmax / r) ** s.b, 80),
    half = (r * s.f) / 2;
  return Math.sqrt((s.b * s.dp * x * Math.exp(-x)) / s.rho + half * half) - half;
}
/** Holland's (1980) surface pressure at radius `r`, hPa: pc + dp exp(-(R/r)^B), with the ambient at 1010. */
export function hollandPressure(r: number, s: ResolvedHurricane = resolveHurricane()): number {
  const dp = s.dp / 100,
    x = r > 0 ? (s.rmax / r) ** s.b : Infinity;
  return AMBIENT - dp + dp * Math.exp(-x);
}
/** Holland's (1980) peak gradient wind without the Coriolis term, sqrt(B dp / (rho e)), m/s. */
export function hollandMaxWind(s: ResolvedHurricane = resolveHurricane()): number {
  return Math.sqrt((s.b * s.dp) / (s.rho * Math.E));
}
/** The cover parts of a storm `s` at `r` metres from its centre, polar angle `theta` (anticlockwise seen from above, from +X), `height` metres above the cloud base and `h` the share of the layer's depth (0 to 1). */
export function hurricaneCover(
  s: ResolvedHurricane,
  r: number,
  theta: number,
  height: number,
  h: number,
  time = 0,
  out: HurricaneCover = { eye: 0, eyewall: 0, outerEyewall: 0, moat: 0, band: 0, shield: 0, canopy: 0, cover: 0 },
): HurricaneCover {
  const w = s.wall,
    edge = s.eye + s.slope * height,
    lean = s.slope * height,
    top = (t: number) => 1 - smoothstep(t - 0.1, t, h);
  out.eye = s.eyeCloud * (1 - smoothstep(edge - 0.1 * w, edge, r)) * (1 - smoothstep(800, 2000, height));
  out.eyewall = smoothstep(edge - 0.1 * w, edge + 0.1 * w, r) * (1 - smoothstep(edge + 0.5 * w, edge + 1.1 * w, r));
  out.outerEyewall =
    s.outer > 0 ? s.outerStrength * Math.exp(-(((r - s.outer - lean) / (0.45 * w)) ** 2)) * top(0.85) : 0;
  out.moat =
    s.moat * smoothstep(edge, edge + 0.5 * w, r) * (1 - smoothstep(0.9 * s.bandStart, s.bandStart, r)) * top(0.25);
  out.band = 0;
  if (s.bands > 0 && r > 0) {
    const k = Math.tan(s.pitch),
      phase =
        (s.bands * (s.spin * theta + Math.log(r / s.bandStart) / k + s.bandRotation + s.bandDrift * time)) /
        (2 * Math.PI),
      index = (((Math.floor(phase + 0.5) % s.bands) + s.bands) % s.bands) | 0,
      u = Math.abs(phase + 0.5 - Math.floor(phase + 0.5) - 0.5),
      across = r * (Math.exp((2 * Math.PI * k) / s.bands) - 1) * Math.cos(s.pitch),
      principal = index === 0 ? s.principal : 0,
      width = s.bandWidth * (1 + principal),
      inner = principal > 0 ? s.bandStart + (edge + w * 0.8 - s.bandStart) * principal : s.bandStart;
    out.band =
      Math.exp(-(((u * across) / (0.5 * width)) ** 2)) *
      smoothstep(0.85 * inner, inner, r) *
      (1 - smoothstep(0.75 * s.extent, s.extent, r)) *
      (1 - 0.4 * smoothstep(s.bandStart, s.extent, r)) *
      top(s.bandTop);
  }
  out.shield =
    s.shield *
    smoothstep(0.9 * s.bandStart, s.bandStart, r) *
    (1 - smoothstep(0.7 * s.extent, s.extent, r)) *
    top(0.35);
  out.canopy =
    s.canopy *
    smoothstep(edge, edge + 0.3 * w, r) *
    (1 - smoothstep(0.55 * s.extent, 0.85 * s.extent, r)) *
    smoothstep(0.78, 0.86, h);
  out.cover = Math.max(out.eye, out.eyewall, out.outerEyewall, out.moat, out.band, out.shield, out.canopy);
  return out;
}
/**
 * A hurricane at sea: its wind, rain, region and cloud cover at any place and time, from {@link HurricaneOptions} read
 * live. Give the same `Hurricane` (or its options) to `VolumetricClouds` (`hurricane`) to draw its cloud and to
 * `WeatherRegions` (`storms`) so the wind and rain follow its bands.
 * @throws TypeError / RangeError on invalid options.
 * @example
 * const storm = new Hurricane({ pressureDrop: 70, maxWindRadius: 25000 });
 * storm.windAt(25000, 0).speed; // about 49 m/s at the radius of maximum wind
 * storm.regionAt(0, 0); // 'eye'
 */
export class Hurricane {
  constructor(readonly options: HurricaneOptions = {}) {
    resolveHurricane(options);
  }
  /** The options' numbers with their defaults. */
  get resolved(): ResolvedHurricane {
    return resolveHurricane(this.options);
  }
  /** Storm centre at time `t` seconds, world `[x, z]`. */
  centerAt(t = 0): [number, number] {
    const s = this.resolved;
    return [s.cx + s.vx * t, s.cz + s.vz * t];
  }
  private polar(x: number, z: number, t: number, s: ResolvedHurricane): [number, number, number, number] {
    const dx = x - (s.cx + s.vx * t),
      dz = z - (s.cz + s.vz * t);
    return [Math.hypot(dx, dz), Math.atan2(-dz, dx), dx, dz];
  }
  /** The surface wind at world `(x, z)`: Holland's gradient wind (plus the outer eyewall's maximum) times `surfaceFactor`, turned in by `inflow`. */
  windAt(x: number, z: number, t = 0): HurricaneWind {
    const s = this.resolved,
      [r, theta, dx, dz] = this.polar(x, z, t, s),
      parts = hurricaneCover(s, r, theta, 0, 0, t),
      outer =
        s.outer > 0 ? s.outerStrength * hollandMaxWind(s) * Math.exp(-(((r - s.outer) / (0.6 * s.wall)) ** 2)) : 0,
      speed = s.surface * Math.max(hollandWind(r, s), outer),
      convective = Math.max(parts.eyewall, parts.outerEyewall, parts.band),
      gust = speed * (1 + (s.gust - 1) * (1 + 0.5 * convective));
    let vx = 0,
      vz = 0;
    if (r > 0) {
      const ux = dx / r,
        uz = dz / r,
        tx = s.spin * uz,
        tz = -s.spin * ux,
        c = Math.cos(s.inflow),
        n = Math.sin(s.inflow);
      vx = speed * (c * tx - n * ux);
      vz = speed * (c * tz - n * uz);
    }
    return { speed, gust, velocity: [vx, vz], direction: Math.atan2(vx, vz) };
  }
  /** The rain rate at world `(x, z)`, mm/h: the R-CLIPER radial profile peaking at `rainMax` in the eyewall, times the cloud that rains there. */
  rainAt(x: number, z: number, t = 0): number {
    const s = this.resolved,
      [r, theta] = this.polar(x, z, t, s),
      p = hurricaneCover(s, r, theta, 0, 0, t),
      rm = s.eye + 0.5 * s.wall,
      profile = r < rm ? r / rm : Math.exp(-(r - rm) / s.rainExtent);
    return s.rainMax * profile * Math.max(p.eyewall, p.outerEyewall, 0.9 * p.band, 0.2 * p.shield, 0.05 * p.moat);
  }
  /** The cover parts at world `(x, z)`, `height` metres above the cloud base of a layer `depth` metres deep (the hurricane type's 14,500 by default). */
  coverAt(
    x: number,
    z: number,
    height = 0,
    t = 0,
    depth = HURRICANE_LAYER.top - HURRICANE_LAYER.bottom,
  ): HurricaneCover {
    const s = this.resolved,
      [r, theta] = this.polar(x, z, t, s);
    return hurricaneCover(s, r, theta, height, clamp01(height / depth), t);
  }
  /** Which part of the storm `(x, z)` lies in, at the cloud base. */
  regionAt(x: number, z: number, t = 0): HurricaneRegion {
    const s = this.resolved,
      [r, theta] = this.polar(x, z, t, s),
      p = hurricaneCover(s, r, theta, 0, 0, t);
    if (r >= s.extent) return 'outside';
    if (r < s.eye) return 'eye';
    const list: [HurricaneRegion, number][] = [
      ['eyewall', p.eyewall],
      ['outerEyewall', p.outerEyewall],
      ['band', p.band],
      ['moat', r < s.bandStart ? Math.max(p.moat, 0.2) : 0],
      ['shield', Math.max(p.shield, 0.01)],
    ];
    return list.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  }
  /**
   * The storm's weather at `(x, z)` on the weather's scales, for `WeatherRegions`' `storms`: mean wind (at most 60 m/s),
   * gustiness (0 in the eye, 1 in the eyewall), direction, rain, cloud overhead, lightning and humidity, and the
   * `weight` of the storm there (1 inside, fading to 0 over the last fifth of its extent).
   */
  weatherAt(x: number, z: number, t = 0): HurricaneWeather {
    const s = this.resolved,
      [r, theta] = this.polar(x, z, t, s),
      wind = this.windAt(x, z, t),
      base = hurricaneCover(s, r, theta, 0, 0, t),
      rate = this.rainAt(x, z, t),
      eye = 1 - smoothstep(s.eye - 0.1 * s.wall, s.eye + 0.1 * s.wall, r),
      convective = Math.max(base.eyewall, base.outerEyewall, base.band),
      cloud = Math.max(
        base.cover,
        s.canopy * smoothstep(s.eye, s.eye + s.wall, r) * (1 - smoothstep(0.55 * s.extent, 0.85 * s.extent, r)),
      );
    return {
      weight: 1 - smoothstep(0.8 * s.extent, s.extent, r),
      wind: Math.min(60, wind.speed),
      gust: clamp01((1 - eye) * (0.45 + 0.55 * convective)),
      windDirection: wind.direction,
      rain: Math.min(1, Math.cbrt(rate / 80)),
      cloud: clamp01(cloud),
      lightning: clamp01(0.25 * base.eyewall + 0.6 * base.band * smoothstep(s.bandStart, 2 * s.bandStart, r)),
      humidity: 0.95,
    };
  }
}
