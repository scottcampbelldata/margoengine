// The CPU model of `@margoengine/terrain/ground-change`: ground that changes over film time. Every event (a gully
// cutting back, a river bank retreating, a scour hole, a slide scar and its runout lobe, a flood's mud, falling ash, a
// lava flow, a burn scar) is a closed form of film time, so the ground at time t is the base plus the sum of the events
// at t: the same numbers whether a film is rendered in order, seeked to t, or rendered again. Each law is from the
// literature, our own code from the papers' descriptions:
// - Gully: a headcut that keeps its step while it migrates upstream at a steady rate, the channel behind it deepening
//   and widening toward its full section (Bennett, Alonso, Prasad and Romkens 2000, "Experiments on headcut growth and
//   migration in concentrated flows typical of upland areas", Water Resources Research 36(7)); the eroded volume is
//   left as an alluvial fan at the mouth, where the transport capacity drops (the capacity rule of Mei, Decaudin and Hu
//   2007, "Fast Hydraulic Erosion Simulation and Visualization on GPU", Pacific Graphics, and the stream-power and
//   deposition review of Galin, Guerin, Peytavie, Cordonnier, Cani, Benes and Gain 2019, "A Review of Digital Terrain
//   Modeling", Computer Graphics Forum 38(2)).
// - Cut bank: the outer bank retreats at a steady rate for a steady flow (bank erosion proportional to the excess
//   near-bank velocity, Ikeda, Parker and Sawai 1981, "Bend theory of river meanders. Part 1", J. Fluid Mech. 112), its
//   face standing at a fixed angle down to the channel bed.
// - Scour: depth grows as S(t) = S(1 - exp(-t / T)) toward its equilibrium (Sumer, Fredsoe and Christiansen 1992, "Scour
//   around vertical pile in waves", J. Waterway, Port, Coastal and Ocean Eng. 118(1)); part of the scoured sand forms a
//   mound downstream.
// - Slide: the scar fails early and the mass runs out as a block under constant friction, s(t) = L(1 - (1 - t)^2), the
//   runout set by the travel angle (Heim 1932, "Bergsturz und Menschenleben"; Scheidegger 1973, "On the prediction of
//   the reach and velocity of catastrophic landslides", Rock Mechanics 5); the lobe holds the scar's volume times its
//   bulking.
// - Mud: a flood front slowing inland; the deposit thins landward exponentially (Goto et al. 2011, "New insights of
//   tsunami hazard from the 2011 Tohoku-oki event", Marine Geology 290; Abe, Goto and Sugawara 2012, "Relationship
//   between the maximum extent of tsunami sand and the inundation limit of the 2011 Tohoku-oki tsunami on the Sendai
//   Plain", Sedimentary Geology 282) and dries exponentially after the water leaves.
// - Ash: tephra thickness falls exponentially with the square root of the isopach area, T = T0 exp(-k sqrt(A)) (Pyle
//   1989, "The thickness, volume and grainsize of tephra fall deposits", Bulletin of Volcanology 51), on isopach
//   ellipses stretched downwind.
// - Lava: a flow front advancing and slowing, its sheet flat-topped between levees (Hulme 1974, "The interpretation of
//   lava flow morphology", Geophys. J. R. Astr. Soc. 39); the crust thickens as C = 0.0779 sqrt(t) metres, t in hours
//   (Hon, Kauahikaua, Denlinger and Mackay 1994, "Emplacement and inflation of pahoehoe sheet flows", GSA Bulletin
//   106), and its glow fades as the crust closes over the hot core. A tube's roof grows in from the levees (Peterson,
//   Holcomb, Tilling and Christiansen 1994, Bull. Volcanol. 56) with skylights showing the stream (Kauahikaua et al.
//   1998, "Observations on basaltic lava streams in tubes from Kilauea Volcano", J. Geophys. Res. 103).
// - Burn: a wind-driven fire spreads as an ellipse from its ignition point (Anderson 1983, "Predicting wind-driven wild
//   land fire size and shape", USDA Forest Service INT-305) with length to breadth LB = 1 + 8.729 (1 - exp(-0.030 U))
//   ^2.155, U the 10 m wind in km/h (Alexander 1985, "Estimating the length-to-breadth ratio of elliptical forest fire
//   patterns", 8th Conf. Fire and Forest Meteorology); fresh char whitens to ash as it ages (the burn severity classes of
//   Key and Benson 2006, "Landscape Assessment: ground measure of severity, the Composite Burn Index; and remote sensing
//   of severity, the Normalized Burn Ratio", USDA RMRS-GTR-164-CD).
// Edges carry deterministic value noise (an integer lattice hashed with lowbias32, C. Wellons, "Prospecting for Hash
// Functions") so no event draws a perfect geometric outline.

/** A world XZ point. */
export type GroundPoint = readonly [number, number];
/** How a gully's section is shaped: 'v' a young incision, 'u' a flat bed between steep walls. */
export type GullyShape = 'v' | 'u';
/** The side of a line's travel direction (from its first point to its last). */
export type GroundSide = 'left' | 'right';

interface Timed {
  /** Film seconds the event starts, 0 or more. Default 0. */
  start?: number;
  /** Film seconds the event takes, above 0. Default per kind. */
  duration?: number;
  /** Edge roughness, 0 (geometric) to 1. Default 0.3. */
  roughness?: number;
  /** Noise seed, an integer. Default 1. */
  seed?: number;
}
/** A gully cutting back from its mouth (`path[0]`) to its head (the last point). */
export interface GullyEvent extends Timed {
  kind: 'gully';
  /** 2 or more points, mouth first. */
  path: readonly GroundPoint[];
  /** Full top width, metres above 0. Default 4. */
  width?: number;
  /** Full depth, metres above 0. Default 1.5. */
  depth?: number;
  /** Section shape. Default 'v'. */
  shape?: GullyShape;
  /** Share of the eroded volume left as a fan at the mouth, 0 to 1. Default 0.6. */
  deposit?: number;
  /** Fan radius, metres above 0. Default 3 times the width. */
  fan?: number;
}
/** A cut bank: the ground beside a river line retreats from it. */
export interface BankEvent extends Timed {
  kind: 'bank';
  /** 2 or more points along the bank's first edge. */
  path: readonly GroundPoint[];
  /** The side of the path the river is on; the ground on the other side retreats. Default 'left'. */
  river?: GroundSide;
  /** Metres the bank retreats, above 0. Default 6. */
  retreat?: number;
  /** World Y of the channel bed the cut reaches. Required. */
  bed: number;
  /** Angle of the cut face from horizontal, degrees 10 to 89. Default 60. */
  face?: number;
}
/** A scour hole, with a mound downstream when the flow is given. */
export interface ScourEvent extends Timed {
  kind: 'scour';
  center: GroundPoint;
  /** Final radius, metres above 0. Default 5. */
  radius?: number;
  /** Equilibrium depth, metres above 0. Default 2. */
  depth?: number;
  /** Flow direction [x, z]; the mound forms downstream. Default none (the sand is carried away). */
  flow?: GroundPoint;
  /** Share of the scoured volume in the mound, 0 to 1. Default 0.5. */
  deposit?: number;
}
/** A slide: a scar below its crown and a lobe that runs out to its toe. */
export interface SlideEvent extends Timed {
  kind: 'slide';
  /** The crown, the top of the head scarp. */
  from: GroundPoint;
  /** Where the lobe's front stops. */
  to: GroundPoint;
  /** Scar width, metres above 0. Default 20. */
  width?: number;
  /** Scar depth, metres above 0. Default 3. */
  depth?: number;
  /** Scar length along the slide, metres above 0. Default 40 percent of the distance from `from` to `to`. */
  length?: number;
  /** Volume of the lobe over the scar's, 1 to 2 (loosened debris). Default 1.15. */
  bulking?: number;
}
/** A flood's mud: a front moving inland from a shore line, leaving a deposit that thins and dries. */
export interface MudEvent extends Timed {
  kind: 'mud';
  /** 2 or more points along the shore. */
  shore: readonly GroundPoint[];
  /** The side of the shore line the land is on. Default 'left'. */
  land?: GroundSide;
  /** Metres the water reaches inland, above 0. Default 400. */
  reach?: number;
  /** Deposit at the shore, metres 0 or more. Default 0.25. */
  thickness?: number;
  /** Metres inland over which the deposit thins by e, above 0. Default a third of `reach`. */
  decay?: number;
  /** Film seconds for the wet mud to dry by e after the water passes, above 0. Default 1,800. */
  drying?: number;
}
/** Ash falling from a vent, thickest near it, stretched downwind. */
export interface AshEvent extends Timed {
  kind: 'ash';
  vent: GroundPoint;
  /** Thickness at the vent when the fall ends, metres above 0. Default 0.1. */
  thickness?: number;
  /** Crosswind metres over which the deposit halves, above 0. Default 400. */
  half?: number;
  /** Wind [x, z] m/s carrying the plume; it stretches the isopachs downwind. Default [0, 0]. */
  wind?: GroundPoint;
  /** Downwind over crosswind length of each isopach, 1 to 12. Default from the wind: 1 + 0.25 |wind| (at most 12). */
  elongation?: number;
}
/** A lava flow advancing down a path from its vent. */
export interface LavaEvent extends Timed {
  kind: 'lava';
  /** 2 or more points, vent first. */
  path: readonly GroundPoint[];
  /** Flow width, metres above 0. Default 12. */
  width?: number;
  /** Sheet thickness, metres above 0. Default 2. */
  thickness?: number;
  /** Levee height over the sheet, as a share of the thickness, 0 to 1. Default 0.35. */
  levee?: number;
  /** Real seconds of cooling per film second (a film that shows hours in a minute), above 0. Default 1. */
  cooling?: number;
  /** Crust thickness at which the glow has faded by e, metres above 0. Default 0.03. */
  glowCrust?: number;
  /**
   * Film seconds the front reaches each point of `path` (one per point, never decreasing), as a flow model that follows
   * the slope gives them (`LavaFlow.lavaEvent()` of `@margoengine/weather/lava`): the front then stops where the times
   * do, and `start` and `duration` are taken from the first and last. Unset: the front law of `duration`.
   */
  arrival?: readonly number[];
  /** Flow width at each point of `path`, metres above 0, in place of `width`. */
  widths?: readonly number[];
  /** Sheet thickness at each point of `path`, metres above 0, in place of `thickness`. */
  thicknesses?: readonly number[];
  /** Glow of the core at each point of `path`, 0 to 1 (1 at the vent's temperature), multiplying the heat. Default 1. */
  glows?: readonly number[];
  /**
   * Levee height over the sheet at each point of `path`, as a share of the thickness, 0 to 1, in place of `levee`
   * (`LavaFlow.lavaEvent()` gives the levees as they stand at its film time: set the event again to grow them).
   */
  levees?: readonly number[];
  /**
   * Film second the channel from each point of `path` to the next roofs over into a lava tube, 0 to 1e9 (1e9: never;
   * `LavaFlow.lavaEvent()` gives its `roofTime`s). From the front's arrival to then a crust grows in from the levees
   * over the channel (Peterson et al. 1994) until it closes level with their crests: under it the lava shows no glow.
   */
  roofs?: readonly number[];
  /**
   * Mean spacing of skylights along a roofed tube, metres, 0 (none) to 1e5. Default 200. A skylight is a hole where the
   * roof fell in or never closed (Kauahikaua et al. 1998; Greeley 1987): one in most stretches of this length, at a
   * seeded place, 0.8 widths long and half a width across, showing the stream below the roof, which glows fresh until
   * the tube drains (`drains`) and then crusts over like open lava.
   */
  skylights?: number;
  /**
   * Film second the tube from each point of `path` stops carrying lava, 0 to 1e9 (1e9: never; `LavaFlow.lavaEvent()`
   * gives them as the vent's supply runs out past each point). Its skylights glow fresh until then.
   */
  drains?: readonly number[];
  /**
   * A pond the flow fills where it can run no further (`LavaFlow.lavaEvent()` gives it when the flow ponds): an
   * axisymmetric viscous gravity current (Huppert 1982) of radius R = 0.715 (g Q^3 / (3 nu))^(1/8) t^(1/2), nu the
   * kinematic viscosity, fed at `flux` from `start` to `end` and held after, whose thickness is
   * H (1 - (r / R)^2)^(1/3) with H = V / (0.75 pi R^2), so its volume is the V = Q t fed into it. Its surface glows by
   * the age since the edge passed (the crust of `glowCrust` and `cooling`), times the last point's `glows`.
   */
  pond?: LavaPond;
}
/** A lava pond: see {@link LavaEvent.pond}. */
export interface LavaPond {
  /** Centre [x, z], metres. */
  center: GroundPoint;
  /** Film second the pond starts to fill. */
  start: number;
  /** Film second its feed stops (it holds its size after), above `start`. */
  end: number;
  /** Lava fed into it, m^3/s, above 0. */
  flux: number;
  /** Dynamic viscosity, Pa s, above 0. */
  viscosity: number;
  /** Lava density, kg/m^3, above 0. Default 2,600. */
  density?: number;
}
/** A burn scar spreading from an ignition point as a wind-driven ellipse. */
export interface BurnEvent extends Timed {
  kind: 'burn';
  ignition: GroundPoint;
  /** Wind [x, z] m/s at 10 m; it sets the ellipse's heading and length to breadth. Default [0, 0]. */
  wind?: GroundPoint;
  /** Head fire rate of spread, m/s above 0. Default 0.3. */
  rate?: number;
  /** Burn severity, 0 to 1: how black the char and how much litter burns off. Default 1. */
  severity?: number;
  /** Film seconds for the char to whiten to ash by e, above 0. Default 900. */
  ashing?: number;
  /** Litter and duff burned off at full severity, metres 0 to 1. Default 0.03. */
  consume?: number;
}
/** Every event the ground can take. */
export type GroundEvent =
  | GullyEvent
  | BankEvent
  | ScourEvent
  | SlideEvent
  | MudEvent
  | AshEvent
  | LavaEvent
  | BurnEvent;
/** The kinds of {@link GroundEvent}. */
export type GroundEventKind = GroundEvent['kind'];

/** Default seconds per kind. */
export const GROUND_DURATIONS: Readonly<Record<GroundEventKind, number>> = {
  gully: 60,
  bank: 60,
  scour: 30,
  slide: 12,
  mud: 90,
  ash: 120,
  lava: 120,
  burn: 600,
};

/** The surface a point shows: shares 0 to 1. */
export interface GroundCover {
  /** Fresh mud. */
  mud: number;
  /** Fallen ash. */
  ash: number;
  /** Burned ground. */
  char: number;
  /** Lava rock. */
  lava: number;
  /** Lava glow, 1 at the front, falling as the crust closes. */
  heat: number;
  /** Wetness of the mud. */
  wet: number;
  /** Freshly cut soil (gully, bank, scour, slide). */
  soil: number;
  /** How far the char has whitened to ash. */
  ashen: number;
}
/** Channels of {@link GroundCover}, in the order the cover textures hold them. */
export const COVER_CHANNELS = ['mud', 'ash', 'char', 'lava', 'heat', 'wet', 'soil', 'ashen'] as const;

/** Lengths along a polyline and its points, for distances along and across it. */
interface Line {
  points: Float64Array;
  /** Cumulative length at each point. */
  at: Float64Array;
  length: number;
}
/** A resolved event: every option filled in, plus what evaluation needs. */
export interface ResolvedEvent {
  readonly kind: GroundEventKind;
  readonly start: number;
  readonly duration: number;
  /** Film time after which the event no longer changes (Infinity never). */
  readonly settle: number;
  /** World bounds [x0, z0, x1, z1] it can touch. */
  readonly bounds: readonly [number, number, number, number];
  readonly order: number;
  readonly source: GroundEvent;
  readonly o: Record<string, number>;
  readonly line?: Line;
  readonly dir?: readonly [number, number];
  /** A lava event's per-point arrival, width, thickness and glow (each one value per path point). */
  readonly profile?: LavaProfile;
}
/** Per-point values of a lava event along its path. */
export interface LavaProfile {
  readonly arrival?: Float64Array;
  readonly width?: Float64Array;
  readonly thickness?: Float64Array;
  readonly glow?: Float64Array;
  readonly levee?: Float64Array;
  readonly roof?: Float64Array;
  readonly drain?: Float64Array;
}
/** The value of `values` (one per point of `l`) at length `s` along it, linear between points. */
function alongValues(l: Line, values: Float64Array, s: number): number {
  const at = l.at,
    n = at.length;
  if (s <= 0) return values[0];
  if (s >= l.length) return values[n - 1];
  let lo = 0,
    hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= s) lo = mid;
    else hi = mid;
  }
  const span = at[hi] - at[lo],
    f = span > 0 ? (s - at[lo]) / span : 0;
  return values[lo] + (values[hi] - values[lo]) * f;
}
/**
 * True where a tube roof has a skylight at length `s` along the path and `u` across (a share of the half width `w`):
 * one hole in three of four stretches `spacing` long, at a seeded place in the stretch, 1.6 w long and w across.
 */
function skylight(spacing: number, seed: number, s: number, u: number, w: number): boolean {
  if (!(spacing > 0)) return false;
  const k = Math.floor(s / spacing),
    key = (Math.imul(k, 2) + Math.imul(seed, 0x9e3779b1)) >>> 0,
    place = (hash(key) >>> 8) / 16777216,
    keep = (hash((key + 1) >>> 0) >>> 8) / 16777216;
  if (keep >= 0.75) return false;
  const c = (k + 0.15 + 0.7 * place) * spacing;
  return ((s - c) / (0.8 * w)) ** 2 + (u / 0.5) ** 2 < 1;
}
/** Index of the point of `l` that starts the segment holding length `s` (the last segment past the end). */
function segmentAt(l: Line, s: number): number {
  const at = l.at;
  let lo = 0,
    hi = at.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}
/** Length along `l` the front has reached at film time `t` by never-decreasing `arrival` times. */
function frontByArrival(l: Line, arrival: Float64Array, t: number): number {
  const n = arrival.length;
  if (t >= arrival[n - 1]) return l.length;
  if (t <= arrival[0]) return 0;
  let i = 1;
  while (arrival[i] <= t) i++;
  const span = arrival[i] - arrival[i - 1];
  return l.at[i - 1] + (span > 0 ? (t - arrival[i - 1]) / span : 1) * (l.at[i] - l.at[i - 1]);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const point = (p: unknown): p is GroundPoint => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
function bad(kind: string, message: string): never {
  throw new RangeError(`Invalid ground ${kind} event; ${message}`);
}
function number(
  e: Record<string, unknown>,
  key: string,
  fallback: number,
  lo: number,
  hi: number,
  open = false,
): number {
  const v = e[key] ?? fallback;
  if (!finite(v) || v < lo || v > hi || (open && v === lo))
    bad(String(e.kind), `${key} must be a number ${open ? 'above' : 'from'} ${lo}${hi < Infinity ? ` to ${hi}` : ''}.`);
  return v;
}
function line(kind: string, key: string, pts: unknown): Line {
  if (!Array.isArray(pts) || pts.length < 2 || !pts.every(point)) bad(kind, `${key} must be 2 or more [x, z] points.`);
  const points = new Float64Array(pts.length * 2),
    at = new Float64Array(pts.length);
  pts.forEach((p, i) => {
    points[i * 2] = p[0];
    points[i * 2 + 1] = p[1];
    if (i) at[i] = at[i - 1] + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
  });
  if (!(at[at.length - 1] > 0)) bad(kind, `${key} must have some length.`);
  return { points, at, length: at[at.length - 1] };
}
/** Bounds of a line grown by `pad`. */
function lineBounds(l: Line, pad: number): [number, number, number, number] {
  let x0 = Infinity,
    z0 = Infinity,
    x1 = -Infinity,
    z1 = -Infinity;
  for (let i = 0; i < l.points.length; i += 2) {
    x0 = Math.min(x0, l.points[i]);
    x1 = Math.max(x1, l.points[i]);
    z0 = Math.min(z0, l.points[i + 1]);
    z1 = Math.max(z1, l.points[i + 1]);
  }
  return [x0 - pad, z0 - pad, x1 + pad, z1 + pad];
}
const scratch = { s: 0, d: 0, side: 0, end: 0 };
/**
 * The nearest point of a polyline to (x, z): `s` its length along the line, `d` the distance, `side` +1 left of the
 * travel direction or -1 right (y up, so left of +x is -z), `end` -1 before the first point, +1 past the last, else 0.
 */
function project(l: Line, x: number, z: number, out = scratch): typeof scratch {
  const p = l.points;
  let best = Infinity;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i],
      az = p[i + 1],
      bx = p[i + 2] - ax,
      bz = p[i + 3] - az,
      len2 = bx * bx + bz * bz,
      raw = len2 > 0 ? ((x - ax) * bx + (z - az) * bz) / len2 : 0,
      t = raw < 0 ? 0 : raw > 1 ? 1 : raw,
      dx = x - ax - bx * t,
      dz = z - az - bz * t,
      d2 = dx * dx + dz * dz;
    if (d2 < best) {
      best = d2;
      out.s = l.at[i / 2] + t * Math.sqrt(len2);
      // Cross of the segment with the offset: y-up, the left of travel along +x is -z.
      out.side = bx * dz - bz * dx < 0 ? 1 : -1;
      out.end = raw < 0 && i === 0 ? -1 : raw > 1 && i + 4 === p.length ? 1 : 0;
    }
  }
  out.d = Math.sqrt(best);
  return out;
}
/** The point and unit direction of a polyline at length `s`. */
function along(l: Line, s: number): [number, number, number, number] {
  const p = l.points;
  let i = 0;
  while (i + 2 < l.at.length && l.at[i + 1] < s) i++;
  const ax = p[i * 2],
    az = p[i * 2 + 1],
    bx = p[i * 2 + 2] - ax,
    bz = p[i * 2 + 3] - az,
    len = Math.hypot(bx, bz) || 1,
    t = (s - l.at[i]) / len;
  return [ax + bx * t, az + bz * t, bx / len, bz / len];
}

const hash = (seed: number): number => {
  let h = seed >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
};
/** Value noise 0 to 1 at (x, z) in lattice units, seeded. */
export function groundNoise(x: number, z: number, seed: number): number {
  const fx = Math.floor(x),
    fz = Math.floor(z),
    tx = x - fx,
    tz = z - fz,
    sx = tx * tx * (3 - 2 * tx),
    sz = tz * tz * (3 - 2 * tz),
    r0 = hash((fz + Math.imul(seed, 0x9e3779b1)) >>> 0),
    r1 = hash((fz + 1 + Math.imul(seed, 0x9e3779b1)) >>> 0),
    v = (cx: number, row: number) => (hash((cx + row) >>> 0) >>> 8) / 16777216;
  const a = v(fx, r0) + (v(fx + 1, r0) - v(fx, r0)) * sx,
    b = v(fx, r1) + (v(fx + 1, r1) - v(fx, r1)) * sx;
  return a + (b - a) * sz;
}
/** Two octaves of noise centred on 0, about -0.5 to 0.5. */
const wobble = (x: number, z: number, scale: number, seed: number) =>
  groundNoise(x / scale, z / scale, seed) * 0.67 +
  groundNoise((x * 2.1) / scale, (z * 2.1) / scale, seed + 7) * 0.33 -
  0.5;

/** Progress of a steady event at film time t: 0 before it starts, 1 once done. */
const progress = (e: ResolvedEvent, t: number) => clamp01((t - e.start) / e.duration);
/** The Sumer et al. scour law normalised to reach 1 at the end: (1 - e^(-5 p)) / (1 - e^(-5)). */
export const scourProgress = (p: number): number => (1 - Math.exp(-5 * p)) / (1 - Math.exp(-5));
/** Front of a block sliding under constant friction: 1 - (1 - p)^2. */
export const runoutProgress = (p: number): number => 1 - (1 - p) * (1 - p);
/** Alexander's (1985) length to breadth of a wind-driven fire ellipse, wind in m/s at 10 m. */
export function lengthToBreadth(wind: number): number {
  const u = wind * 3.6;
  return 1 + 8.729 * Math.pow(1 - Math.exp(-0.03 * u), 2.155);
}
/** Hon et al.'s (1994) crust thickness in metres after `seconds` of cooling: 0.0779 sqrt(hours). */
export const crustThickness = (seconds: number): number => 0.0779 * Math.sqrt(Math.max(seconds, 0) / 3600);
/** A gully's section area over width times depth: 1/2 for 'v', 4/5 for 'u'. */
const SECTION = { v: 0.5, u: 0.8 };
const sectionDepth = (u: number, shape: number) => (u >= 1 ? 0 : shape ? 1 - u * u * u * u : 1 - u);

/** The fire ellipse at unit head distance: semi-axes a and b and its centre's offset downwind of the ignition. */
function fireShape(lb: number): { a: number; b: number; c: number } {
  const r = Math.sqrt(Math.max(lb * lb - 1, 0)),
    // Head over back fire distance (Anderson 1983, an ellipse with the ignition at its rear focus).
    back = lb > 1 ? (lb - r) / (lb + r) : 1,
    a = (1 + back) / 2;
  return { a, b: a / lb, c: a - back };
}

/** Checks and fills in one event; `order` keeps ties stable. `top` is the highest base height (for a bank's face). */
export function resolveEvent(event: GroundEvent, order: number, top: number): ResolvedEvent {
  if (typeof event !== 'object' || event === null || !(event.kind in GROUND_DURATIONS))
    throw new TypeError(`Invalid ground event; kind must be one of ${Object.keys(GROUND_DURATIONS).join(', ')}.`);
  const e = event as unknown as Record<string, unknown>,
    kind = event.kind,
    start = number(e, 'start', 0, 0, 1e9),
    duration = number(e, 'duration', GROUND_DURATIONS[kind], 0, 1e9, true),
    roughness = number(e, 'roughness', 0.3, 0, 1),
    seed = e.seed ?? 1;
  if (!Number.isInteger(seed)) bad(kind, 'seed must be an integer.');
  const o: Record<string, number> = { roughness, seed: seed as number },
    end = start + duration;
  const make = (bounds: [number, number, number, number], settle: number, more: Partial<ResolvedEvent> = {}) =>
    ({ kind, start, duration, settle, bounds, order, source: event, o, ...more }) as ResolvedEvent;
  const side = (key: string, fallback: GroundSide) => {
    const v = e[key] ?? fallback;
    if (v !== 'left' && v !== 'right') bad(kind, `${key} must be 'left' or 'right'.`);
    return v === 'left' ? 1 : -1;
  };
  switch (kind) {
    case 'gully': {
      const l = line(kind, 'path', e.path);
      o.width = number(e, 'width', 4, 0, 1e5, true);
      o.depth = number(e, 'depth', 1.5, 0, 1e4, true);
      const shape = e.shape ?? 'v';
      if (shape !== 'v' && shape !== 'u') bad(kind, "shape must be 'v' or 'u'.");
      o.shape = shape === 'u' ? 1 : 0;
      o.deposit = number(e, 'deposit', 0.6, 0, 1);
      o.fan = number(e, 'fan', 3 * o.width, 0, 1e5, true);
      // Flow leaves the mouth along the first segment, reversed (the path runs mouth to head).
      const d = along(l, 0);
      return make(lineBounds(l, Math.max(o.width, o.fan) * 1.6), end, { line: l, dir: [-d[2], -d[3]] });
    }
    case 'bank': {
      const l = line(kind, 'path', e.path);
      o.river = side('river', 'left');
      o.retreat = number(e, 'retreat', 6, 0, 1e5, true);
      if (!finite(e.bed)) bad(kind, 'bed (world Y of the channel bed) is required.');
      o.bed = e.bed as number;
      o.face = (number(e, 'face', 60, 10, 89) * Math.PI) / 180;
      const reach = o.retreat + Math.max(top - o.bed, 0) / Math.tan(o.face);
      return make(lineBounds(l, reach * 1.3 + 1), end, { line: l });
    }
    case 'scour': {
      if (!point(e.center)) bad(kind, 'center must be an [x, z] point.');
      o.radius = number(e, 'radius', 5, 0, 1e5, true);
      o.depth = number(e, 'depth', 2, 0, 1e4, true);
      o.deposit = number(e, 'deposit', 0.5, 0, 1);
      const c = e.center as GroundPoint;
      let dir: [number, number] | undefined;
      if (e.flow !== undefined) {
        if (!point(e.flow) || !(Math.hypot(e.flow[0], e.flow[1]) > 0)) bad(kind, 'flow must be a non-zero [x, z].');
        const f = e.flow as GroundPoint,
          len = Math.hypot(f[0], f[1]);
        dir = [f[0] / len, f[1] / len];
      }
      const pad = o.radius * (dir ? 3.4 : 1.4);
      return make([c[0] - pad, c[1] - pad, c[0] + pad, c[1] + pad], end, { dir });
    }
    case 'slide': {
      if (!point(e.from) || !point(e.to)) bad(kind, 'from and to must be [x, z] points.');
      const a = e.from as GroundPoint,
        b = e.to as GroundPoint,
        dist = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (!(dist > 0)) bad(kind, 'from and to must differ.');
      o.width = number(e, 'width', 20, 0, 1e5, true);
      o.depth = number(e, 'depth', 3, 0, 1e4, true);
      o.length = number(e, 'length', dist * 0.4, 0, dist, true);
      o.bulking = number(e, 'bulking', 1.15, 1, 2);
      o.distance = dist;
      const pad = o.width;
      return make(
        [
          Math.min(a[0], b[0]) - pad,
          Math.min(a[1], b[1]) - pad,
          Math.max(a[0], b[0]) + pad,
          Math.max(a[1], b[1]) + pad,
        ],
        end,
        { dir: [(b[0] - a[0]) / dist, (b[1] - a[1]) / dist] },
      );
    }
    case 'mud': {
      const l = line(kind, 'shore', e.shore);
      o.land = side('land', 'left');
      o.reach = number(e, 'reach', 400, 0, 1e6, true);
      o.thickness = number(e, 'thickness', 0.25, 0, 100);
      o.decay = number(e, 'decay', o.reach / 3, 0, 1e6, true);
      o.drying = number(e, 'drying', 1800, 0, 1e9, true);
      // Wetness below 1/255 after 5.6 e-foldings.
      return make(lineBounds(l, o.reach * 1.1), end + o.drying * 5.6, { line: l });
    }
    case 'ash': {
      if (!point(e.vent)) bad(kind, 'vent must be an [x, z] point.');
      o.thickness = number(e, 'thickness', 0.1, 0, 100, true);
      o.half = number(e, 'half', 400, 0, 1e6, true);
      const w = (e.wind ?? [0, 0]) as GroundPoint;
      if (!point(w)) bad(kind, 'wind must be an [x, z] m/s vector.');
      const speed = Math.hypot(w[0], w[1]);
      o.elongation = number(e, 'elongation', Math.min(12, 1 + 0.25 * speed), 1, 12);
      const v = e.vent as GroundPoint,
        // Out to the isopach of 0.2 mm.
        b = o.half * Math.max(Math.log2(o.thickness / 0.0002), 1),
        reach = b * (2 * o.elongation - 1) + b;
      return make([v[0] - reach, v[1] - reach, v[0] + reach, v[1] + reach], end, {
        dir: speed > 0 ? [w[0] / speed, w[1] / speed] : [1, 0],
      });
    }
    case 'lava': {
      const l = line(kind, 'path', e.path);
      o.width = number(e, 'width', 12, 0, 1e5, true);
      o.thickness = number(e, 'thickness', 2, 0, 1e3, true);
      o.levee = number(e, 'levee', 0.35, 0, 1);
      o.cooling = number(e, 'cooling', 1, 0, 1e6, true);
      o.glowCrust = number(e, 'glowCrust', 0.03, 0, 10, true);
      o.skylights = number(e, 'skylights', 200, 0, 1e5);
      const n = l.at.length,
        list = (key: string, lo: number, hi: number, open: boolean): Float64Array | undefined => {
          const v = e[key];
          if (v === undefined) return undefined;
          if (
            !Array.isArray(v) ||
            v.length !== n ||
            !v.every((x) => finite(x) && x >= lo && x <= hi && !(open && x === lo))
          )
            bad(kind, `${key} must hold one number ${open ? 'above' : 'from'} ${lo} to ${hi} per path point.`);
          return Float64Array.from(v as number[]);
        },
        profile: LavaProfile = {
          arrival: list('arrival', 0, 1e9, false),
          width: list('widths', 0, 1e5, true),
          thickness: list('thicknesses', 0, 1e3, true),
          glow: list('glows', 0, 1, false),
          levee: list('levees', 0, 1, false),
          roof: list('roofs', 0, 1e9, false),
          drain: list('drains', 0, 1e9, false),
        };
      const a = profile.arrival;
      if (a) for (let i = 1; i < n; i++) if (a[i] < a[i - 1]) bad(kind, 'arrival must never decrease along the path.');
      // The glow is below 1/255 once the crust is 5.6 glowCrust thick: t = (5.6 C / 0.0779)^2 hours.
      const cool = (Math.pow((5.6 * o.glowCrust) / 0.0779, 2) * 3600) / o.cooling,
        widest = profile.width ? Math.max(...profile.width) : o.width;
      let box = lineBounds(l, widest),
        pondEnd = -Infinity;
      if (e.pond !== undefined) {
        const pd = e.pond as Record<string, unknown>;
        if (typeof pd !== 'object' || pd === null || !point(pd.center))
          bad(kind, 'pond.center must be an [x, z] point.');
        const c = pd.center as GroundPoint,
          ps = number({ ...pd, kind } as Record<string, unknown>, 'start', 0, 0, 1e9),
          pe = number({ ...pd, kind } as Record<string, unknown>, 'end', ps + 1, ps, 1e10, true),
          flux = number({ ...pd, kind } as Record<string, unknown>, 'flux', 1, 0, 1e5, true),
          visc = number({ ...pd, kind } as Record<string, unknown>, 'viscosity', 300, 0, 1e12, true),
          dens = number({ ...pd, kind } as Record<string, unknown>, 'density', 2600, 0, 1e4, true);
        o.pondX = c[0];
        o.pondZ = c[1];
        o.pondStart = ps;
        o.pondEnd = pe;
        o.pondFlux = flux;
        // Huppert's (1982) radius coefficient: R = K t^(1/2).
        o.pondK = 0.715 * Math.pow((9.80665 * flux ** 3) / (3 * (visc / dens)), 1 / 8);
        const R = o.pondK * Math.sqrt(pe - ps);
        box = [
          Math.min(box[0], c[0] - R),
          Math.min(box[1], c[1] - R),
          Math.max(box[2], c[0] + R),
          Math.max(box[3], c[1] + R),
        ];
        pondEnd = pe;
      }
      if (!a) return make(box, Math.max(end, pondEnd) + cool, { line: l, profile });
      // The arrival times decide when the flow starts and stops.
      return {
        ...make(box, Math.max(a[n - 1], pondEnd) + cool, { line: l, profile }),
        start: a[0],
        duration: Math.max(a[n - 1] - a[0], 1e-6),
      } as ResolvedEvent;
    }
    case 'burn': {
      if (!point(e.ignition)) bad(kind, 'ignition must be an [x, z] point.');
      const w = (e.wind ?? [0, 0]) as GroundPoint;
      if (!point(w)) bad(kind, 'wind must be an [x, z] m/s vector.');
      o.rate = number(e, 'rate', 0.3, 0, 1e3, true);
      o.severity = number(e, 'severity', 1, 0, 1);
      o.ashing = number(e, 'ashing', 900, 0, 1e9, true);
      o.consume = number(e, 'consume', 0.03, 0, 1);
      const speed = Math.hypot(w[0], w[1]),
        shape = fireShape(lengthToBreadth(speed));
      o.a = shape.a;
      o.b = shape.b;
      o.c = shape.c;
      const g = e.ignition as GroundPoint,
        reach = o.rate * duration + 2;
      return make([g[0] - reach, g[1] - reach, g[0] + reach, g[1] + reach], end + o.ashing * 5.6, {
        dir: speed > 0 ? [w[0] / speed, w[1] / speed] : [1, 0],
      });
    }
  }
}

/** Volume a gully has eroded at progress p: the integral of its section along the opened length. */
export function gullyVolume(e: ResolvedEvent, p: number): number {
  const L = e.line!.length,
    head = L * p,
    steps = 256;
  let sum = 0;
  for (let k = 0; k < steps; k++) {
    const s = ((k + 0.5) / steps) * head,
      g = gullyGrowth(e, s, p);
    sum += g.width * g.depth * SECTION[e.o.shape ? 'u' : 'v'];
  }
  return (sum * head) / steps;
}
/** Width and depth of a gully at length s from its mouth at progress p. */
function gullyGrowth(e: ResolvedEvent, s: number, p: number): { width: number; depth: number } {
  const L = e.line!.length,
    head = L * p;
  if (s > head) return { width: 0, depth: 0 };
  // Seconds since the headcut passed, as a share of the event; the channel deepens toward its full section.
  const age = (head - s) / L,
    grow = (1 - Math.exp(-4 * age)) / (1 - Math.exp(-4)),
    // The headcut's step, rounded over half a width, keeps 60 percent of the full depth at first.
    step = smooth(0, e.o.width * 0.5, head - s);
  return { width: e.o.width * (0.55 + 0.45 * grow), depth: e.o.depth * step * (0.6 + 0.4 * grow) };
}
/** Volume a slide's scar has lost at progress p: an ellipsoid cap, 2/3 pi a b D. */
export function slideVolume(e: ResolvedEvent, p: number): number {
  return (2 / 3) * Math.PI * (e.o.length / 2) * (e.o.width / 2) * e.o.depth * slideFailure(p);
}
/** The scar fails over the first third of a slide. */
const slideFailure = (p: number) => smooth(0, 1 / 3, p);
/** A slide lobe's along-profile x^0.5 (1 - x)^0.35 (0 to 1), and its integral over 0..1. */
const lobeAlong = (x: number) => (x <= 0 || x >= 1 ? 0 : Math.sqrt(x) * Math.pow(1 - x, 0.35));
let lobeArea = 0;
for (let k = 0; k < 4096; k++) lobeArea += lobeAlong((k + 0.5) / 4096) / 4096;

/** Adds one event's change at world (x, z) and film time t into `out` (height delta at 0, cover shares after). */
export function sampleEvent(e: ResolvedEvent, x: number, z: number, t: number, base: number, out: Float64Array): void {
  if (t <= e.start) return;
  const p = progress(e, t),
    o = e.o,
    rough = o.roughness;
  switch (e.kind) {
    case 'gully': {
      const q = project(e.line!, x, z);
      let dh = 0,
        soil = 0;
      if (q.end <= 0) {
        const g = gullyGrowth(e, q.s, p);
        if (g.depth > 0) {
          const w = g.width * (1 + rough * 0.5 * wobble(x, z, o.width * 2, o.seed)),
            u = q.d / (w / 2),
            cut = g.depth * sectionDepth(u, o.shape);
          if (cut > 0) {
            dh -= cut;
            soil = smooth(0, 0.15, cut);
          }
        }
      }
      // The fan: a paraboloid over the half disc below the mouth, holding `deposit` of the eroded volume.
      const fan = o.fan,
        mx = e.line!.points[0],
        mz = e.line!.points[1],
        rx = x - mx,
        rz = z - mz,
        r2 = (rx * rx + rz * rz) / (fan * fan);
      if (r2 < 1 && rx * e.dir![0] + rz * e.dir![1] >= 0 && o.deposit > 0) {
        const H = (o.deposit * gullyVolumeCached(e, p)) / ((Math.PI * fan * fan) / 4),
          lift = H * (1 - r2);
        dh += lift;
        soil = Math.max(soil, smooth(0, 0.05, lift));
      }
      out[0] += dh;
      cover(out, 'soil', soil);
      return;
    }
    case 'bank': {
      const q = project(e.line!, x, z);
      if (q.side === o.river && q.end === 0) return;
      // Metres into the land from the original bank line, and the cut surface there now.
      const into = q.side === o.river ? -q.d : q.d,
        edge = o.retreat * p * (1 + rough * 0.6 * wobble(x, z, o.retreat * 3, o.seed)),
        surface = o.bed + Math.tan(o.face) * Math.max(into - edge, 0),
        dh = Math.min(surface - base, 0);
      if (dh < 0 && p > 0) {
        out[0] += dh;
        cover(out, 'soil', smooth(0, 0.15, -dh));
      }
      return;
    }
    case 'scour': {
      const sp = scourProgress(p),
        R = o.radius * (0.5 + 0.5 * sp),
        c = (e.source as ScourEvent).center,
        dx = x - c[0],
        dz = z - c[1],
        rho = Math.hypot(dx, dz) / (R * (1 + rough * 0.4 * wobble(x, z, o.radius, o.seed)));
      let dh = 0,
        soil = 0;
      if (rho < 1) {
        dh -= o.depth * sp * Math.pow(1 - rho * rho, 1.5);
        soil = smooth(0, 0.1, -dh);
      }
      if (e.dir && o.deposit > 0) {
        // Bowl volume pi R^2 D / 2.5; the mound a paraboloid pi Rm^2 H / 2 centred 1.6 R downstream.
        const Rm = R,
          mx = c[0] + e.dir[0] * R * 1.6,
          mz = c[1] + e.dir[1] * R * 1.6,
          m2 = ((x - mx) ** 2 + (z - mz) ** 2) / (Rm * Rm);
        if (m2 < 1) {
          const H = (o.deposit * ((Math.PI * R * R * o.depth * sp) / 2.5)) / ((Math.PI * Rm * Rm) / 2),
            lift = H * (1 - m2);
          dh += lift;
          soil = Math.max(soil, smooth(0, 0.05, lift));
        }
      }
      out[0] += dh;
      cover(out, 'soil', soil);
      return;
    }
    case 'slide': {
      const s0 = (e.source as SlideEvent).from,
        [dx, dz] = e.dir!,
        rx = x - s0[0],
        rz = z - s0[1],
        a = rx * dx + rz * dz,
        c = rz * dx - rx * dz;
      let dh = 0,
        soil = 0;
      // The scar: an ellipsoid cap from the crown down `length`, steep at the head scarp.
      const u = (a - o.length / 2) / (o.length / 2),
        v = (c / (o.width / 2)) * (1 + rough * 0.5 * wobble(x, z, o.width, o.seed)),
        k = 1 - u * u - v * v,
        fail = slideFailure(p);
      if (k > 0 && fail > 0) {
        dh -= o.depth * Math.sqrt(k) * fail;
        soil = smooth(0, 0.1, o.depth * Math.sqrt(k) * fail);
      }
      // The lobe: from the scar's lower end to the front, wider than the scar, holding bulking times the scar volume.
      const s1 = o.length * 0.85,
        front = s1 + (o.distance - s1) * runoutProgress(p),
        span = front - s1;
      if (span > 0) {
        const lw = o.width * 0.65,
          ax = (a - s1) / span,
          cv = (c / lw) * (1 + rough * 0.4 * wobble(x + 31, z, o.width, o.seed)),
          across = 1 - cv * cv;
        if (ax > 0 && ax < 1 && across > 0) {
          const H = (o.bulking * slideVolume(e, p)) / (span * lobeArea * lw * (4 / 3)),
            lift = H * lobeAlong(ax) * across;
          dh += lift;
          soil = Math.max(soil, smooth(0, 0.05, lift));
        }
      }
      out[0] += dh;
      cover(out, 'soil', soil);
      return;
    }
    case 'mud': {
      const q = project(e.line!, x, z);
      if (q.side !== o.land || q.end !== 0) return;
      const front = o.reach * runoutProgress(p) * (1 + rough * 0.25 * wobble(x, z, o.reach * 0.3, o.seed));
      if (q.d > front) return;
      const thick = o.thickness * Math.exp(-q.d / o.decay) * (1 - smooth(front * 0.9, front, q.d)),
        // When the front passed this point: invert d = reach (1 - (1 - p)^2).
        passed = e.start + e.duration * (1 - Math.sqrt(Math.max(1 - q.d / o.reach, 0))),
        wet = p < 1 ? 1 : Math.exp(-(t - Math.max(passed, e.start + e.duration)) / o.drying);
      out[0] += thick;
      cover(out, 'mud', smooth(0, 0.02, thick) + 0.6 * (1 - smooth(0, 0.02, thick)) * wet);
      out[6] = Math.max(out[6], wet * smooth(0, 0.005, thick + 0.004));
      return;
    }
    case 'ash': {
      const v = (e.source as AshEvent).vent,
        [wx, wz] = e.dir!,
        rx = x - v[0],
        rz = z - v[1],
        s = rx * wx + rz * wz,
        c = rz * wx - rx * wz,
        g = o.elongation,
        // The isopach through the point: semi-axes g b along and b across, centred (g - 1) b downwind.
        b =
          g === 1
            ? Math.hypot(s, c)
            : (-2 * s * (g - 1) + Math.sqrt(4 * s * s * (g - 1) ** 2 + 4 * (2 * g - 1) * (s * s + g * g * c * c))) /
              (2 * (2 * g - 1)),
        thick = o.thickness * p * Math.pow(2, -(b * (1 + rough * 0.3 * wobble(x, z, o.half * 0.5, o.seed))) / o.half);
      if (thick < 1e-5) return;
      out[0] += thick;
      cover(out, 'ash', smooth(0, 0.004, thick));
      return;
    }
    case 'lava': {
      if (o.pondK) samplePond(e, x, z, t, out);
      const q = project(e.line!, x, z);
      if (q.end > 0) return;
      const l = e.line!,
        L = l.length,
        pr = e.profile!,
        arrival = pr.arrival,
        front = arrival ? frontByArrival(l, arrival, t) : L * (1 - Math.pow(1 - p, 1.5)),
        width = pr.width ? alongValues(l, pr.width, q.s) : o.width,
        w = (width / 2) * (1 + rough * 0.35 * wobble(x, z, width * 1.5, o.seed)),
        u = q.d / w;
      if (u >= 1 || q.s > front + w * 0.5) return;
      // Seconds since the front reached this point: the arrival times, or invert s = L (1 - (1 - p)^1.5).
      const reached = arrival
          ? alongValues(l, arrival, q.s)
          : e.start + e.duration * (1 - Math.pow(Math.max(1 - Math.min(q.s, L) / L, 0), 1 / 1.5)),
        // A tube's roof: crust grown in from the levees over the share `roofed` of the channel by now (the segment's own
        // roof time, never one blended with a segment that never roofs), level with the levee crests.
        closes = pr.roof ? pr.roof[segmentAt(l, q.s)] : Infinity,
        roofed = closes < 1e9 ? smooth(reached, Math.max(closes, reached + 1e-6), t) : 0,
        sky = roofed >= 1 && skylight(o.skylights, o.seed, q.s, u, w),
        covered = !sky && roofed > 0 && u >= 0.82 * (1 - roofed),
        crest = pr.levee ? alongValues(l, pr.levee, q.s) : o.levee,
        // Flat-topped sheet with levees at its edges; the front lobe rounds over half a width. Through a skylight the
        // stream shows half a sheet below the surface.
        sheet = (1 - Math.pow(u, 16)) * (sky ? 0.5 : 1),
        levee = covered && u < 0.82 ? crest : crest * Math.exp(-(((u - 0.82) / 0.1) ** 2)),
        nose = 1 - smooth(front - w * 0.5, front + w * 0.5, q.s),
        thick = (pr.thickness ? alongValues(l, pr.thickness, q.s) : o.thickness) * (sheet + levee) * nose;
      if (thick <= 0) return;
      // Under a skylight the tube's stream is fresh lava until the tube drains, then it crusts from that second.
      const drained = sky ? (pr.drain ? pr.drain[segmentAt(l, q.s)] : 1e9) : 0,
        age = Math.max(t - (sky ? (drained < 1e9 ? drained : t) : reached), 0) * o.cooling,
        heat = covered
          ? 0
          : Math.exp(-crustThickness(age) / o.glowCrust) *
            smooth(0, 0.1, thick) *
            (pr.glow ? alongValues(l, pr.glow, q.s) : 1);
      out[0] += thick;
      cover(out, 'lava', smooth(0, 0.08, thick));
      out[5] = Math.max(out[5] * (1 - smooth(0, 0.08, thick)), heat);
      return;
    }
    case 'burn': {
      const g = (e.source as BurnEvent).ignition,
        [wx, wz] = e.dir!,
        rx = x - g[0],
        rz = z - g[1],
        s = rx * wx + rz * wz,
        c = rz * wx - rx * wz,
        // The head distance D at which the growing ellipse reaches the point (all sizes scale with D).
        A = o.b * o.b * (o.a * o.a - o.c * o.c),
        B = 2 * s * o.c * o.b * o.b,
        C = -(s * s * o.b * o.b + c * c * o.a * o.a),
        D = (-B + Math.sqrt(Math.max(B * B - 4 * A * C, 0))) / (2 * A),
        head = o.rate * Math.min(t - e.start, e.duration),
        edge = D * (1 + rough * 0.25 * wobble(x, z, 12, o.seed));
      if (edge > head) return;
      const burned = smooth(0, 0.6, head - edge) * o.severity,
        age = t - (e.start + edge / o.rate);
      out[0] -= o.consume * burned;
      cover(out, 'char', burned);
      out[8] = Math.max(out[8], 1 - Math.exp(-Math.max(age, 0) / o.ashing));
      return;
    }
  }
}
/** Huppert's (1982) pond of a lava event at (x, z), film time t: its thickness and glow added into `out`. */
function samplePond(e: ResolvedEvent, x: number, z: number, t: number, out: Float64Array): void {
  const o = e.o,
    fed = Math.min(t, o.pondEnd) - o.pondStart;
  if (!(fed > 0)) return;
  const R = o.pondK * Math.sqrt(fed),
    r = Math.hypot(x - o.pondX, z - o.pondZ);
  if (r >= R) return;
  // Volume Q t over the cap (1 - (r/R)^2)^(1/3), whose integral over the disc is 3/4 pi R^2 H.
  const H = (o.pondFlux * fed) / (0.75 * Math.PI * R * R),
    thick = H * Math.cbrt(1 - (r / R) ** 2);
  if (thick <= 0) return;
  const pr = e.profile!,
    passed = o.pondStart + (r / o.pondK) ** 2,
    age = Math.max(t - passed, 0) * o.cooling,
    glow = pr.glow ? pr.glow[pr.glow.length - 1] : 1,
    heat = Math.exp(-crustThickness(age) / o.glowCrust) * smooth(0, 0.1, thick) * glow;
  out[0] += thick;
  cover(out, 'lava', smooth(0, 0.08, thick));
  out[5] = Math.max(out[5] * (1 - smooth(0, 0.08, thick)), heat);
}
// Index in `out` after the height: mud 1, ash 2, char 3, lava 4, heat 5, wet 6, soil 7, ashen 8.
const SLOT = { mud: 1, ash: 2, char: 3, lava: 4, soil: 7 } as const;
/** Lays a surface of `share` over what is there: the other surfaces show through only where it is thin. */
function cover(out: Float64Array, kind: keyof typeof SLOT, share: number): void {
  const s = clamp01(share);
  if (s <= 0) return;
  for (const k of [1, 2, 3, 4, 7]) out[k] *= 1 - s;
  out[SLOT[kind]] += s;
  if (kind !== 'lava') out[5] *= 1 - s;
}
const volumes = new WeakMap<ResolvedEvent, { p: number; v: number }>();
function gullyVolumeCached(e: ResolvedEvent, p: number): number {
  const hit = volumes.get(e);
  if (hit && hit.p === p) return hit.v;
  const v = gullyVolume(e, p);
  volumes.set(e, { p, v });
  return v;
}
