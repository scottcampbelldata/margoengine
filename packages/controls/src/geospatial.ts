// Geospatial camera: heading / pitch / range orbit about a geodetic point on the WGS84 globe, with surface-true cursor
// zoom, anchored pan and pivot, flights and a terrain-clearance floor. The geodesy is @margoengine/math/geo (NIMA
// TR8350.2, Karney 2013); surface picks use the bvh Raycaster, your own ray query or a march over `heightAt`.
import type { Camera, EngineKernel, Mesh } from '@margoengine/core';
import { Raycaster, type ModelLike } from '@margoengine/bvh';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { MargoError } from '@margoengine/math/errors';
import {
  WGS84_A,
  WGS84_B,
  cartographicToEcef,
  ecefToCartographic,
  enuBasis,
  geodeticNormal,
  geodesicDirect,
  geodesicInverse,
  orbitPose,
} from '@margoengine/math/geo';
import { rollFrame, ray } from './view.js';
import { rangeError } from '../../shared/errors.js';

/** Terrain height above the WGS84 ellipsoid, metres, at longitude and latitude in RADIANS; undefined or NaN when unknown. */
export type HeightQuery = (longitude: number, latitude: number) => number | undefined;

/**
 * Your own surface ray query in WORLD coordinates (the camera's frame): the distance along the unit `direction` to the
 * first hit within `far`, or undefined / NaN on a miss. A `TerrainQuery.raycast`, a tiles query or a height grid fit.
 */
export type SurfaceRaycast = (
  origin: readonly [number, number, number],
  direction: readonly [number, number, number],
  far: number,
) => number | undefined;

/** What a {@link GeospatialControls.pick} hit: the engine scene (bvh), your `raycast`, the `heightAt` terrain, or the ellipsoid fallback. */
export type GeospatialPickSource = 'scene' | 'raycast' | 'terrain' | 'ellipsoid';

/** A picked surface point: geodetic position (radians, metres above the ellipsoid), distance along the ray and what was hit. */
export interface GeospatialPick {
  longitude: number;
  latitude: number;
  height: number;
  /** Metres from the ray origin (the eye) to the hit. */
  distance: number;
  source: GeospatialPickSource;
}

/**
 * How {@link GeospatialControls} navigates. `globe`: drag pans the surface, right drag turns and tilts. `local`: the
 * same orbit about a site (a city, a valley) with the buttons swapped, left drag turns about the centre. `map`: top-down
 * at `maxPitch`, right drag turns the heading only. `fly`: first person, drag looks, W/A/S/D or the arrows move along
 * the view, E/Q rise and sink, at a speed scaled by the height above the ground. `walk`: first person on the ground,
 * the eye `eyeHeight` above the surface under it (walk, or drive with a higher `walkSpeed`).
 */
export type GeospatialMode = 'globe' | 'local' | 'map' | 'fly' | 'walk';

/**
 * A feel preset for {@link GeospatialControls}: `globe` (the default: left drag pans the surface, right or modified drag
 * turns and tilts, a short glide after a fling, double click zooms in), `map` (the same buttons with a longer glide, as
 * web maps do) or `dcc` (as in digital content creation tools: middle drag orbits, Shift + middle pans, Ctrl + middle
 * zooms, the left button is left free for picking, no glide or double click).
 */
export type GeospatialPreset = 'globe' | 'map' | 'dcc';

/** Glide after a fling, per axis: the time constant of the decay in seconds; 0 stops at once. */
export interface GeospatialInertia {
  /** Pan glide, seconds. Default 0.3 (`map` 0.45, `dcc` 0). */
  pan: number;
  /** Heading and tilt glide, seconds. Default 0.25 (`dcc` 0). */
  rotate: number;
  /** Zoom glide (pinch and zoom drags), seconds. Default 0.2 (`dcc` 0). */
  zoom: number;
}

/** Geoid height (mean sea level) above the WGS84 ellipsoid, metres, at longitude and latitude in RADIANS. */
export type GeoidQuery = (longitude: number, latitude: number) => number | undefined;

/** Heights of the eye, metres: above the ellipsoid, above the ground below it, and above mean sea level. */
export interface GeospatialHeights {
  /** Above the WGS84 ellipsoid. */
  ellipsoid: number;
  /** Above the highest of `heightAt`, the scene and `raycast` directly below the eye (the ellipsoid without them). */
  terrain: number;
  /** Above the geoid your `geoid` option gives (mean sea level); null without one. */
  seaLevel: number | null;
}

/** A saved view: everything {@link GeospatialControls.restoreView} needs, as plain JSON. Radians and metres. */
export interface GeospatialViewState extends Required<GeospatialView> {
  mode: GeospatialMode;
}

/** Options for {@link GeospatialControls.setMode}. */
export interface ModeSwitchOptions {
  /** Seconds of the move into the new mode when the pose must change (walk lands, map tilts). Default 0.75. */
  duration?: number;
  /** Progress to eased progress, both in [0, 1]. Default smootherstep. */
  easing?: (t: number) => number;
  /** Cancels the move where it is; the mode still changes. */
  signal?: AbortSignal;
}

/** A geodetic view of the globe. Angles are radians, lengths metres. */
export interface GeospatialView {
  /** Orbit centre longitude, radians. */
  longitude: number;
  /** Orbit centre latitude, radians, in [-PI/2, PI/2]. */
  latitude: number;
  /** Orbit centre height above the ellipsoid, metres. Default 0. */
  height?: number;
  /** Compass direction the camera looks toward, radians clockwise from north. Default keeps the current one. */
  heading?: number;
  /** Angle below the local horizon the camera looks, radians; 0 horizontal, PI/2 straight down. Default keeps it. */
  pitch?: number;
  /** Distance from the centre to the camera, metres. Default keeps it. */
  range?: number;
}

/** Options of {@link GeospatialControls}; every field is optional. Angles are radians, lengths metres. */
export interface GeospatialOptions {
  /** Initial view. Default: longitude 0, latitude 0, height 0, heading 0, pitch PI/2 (straight down), range 2e7 m. */
  view?: GeospatialView;
  /** Terrain height under a point; the eye is kept `clearance` above it. Default none (the ellipsoid is the floor). */
  heightAt?: HeightQuery;
  /** Minimum eye height above the terrain, or above the ellipsoid without `heightAt`, metres. Default 2. */
  clearance?: number;
  /** Smallest pitch (nearest the horizon), radians. Default 0. */
  minPitch?: number;
  /** Largest pitch (straight down is PI/2), radians. Default PI/2. */
  maxPitch?: number;
  /** Smallest range, metres. Default 1. */
  minRange?: number;
  /** Largest range, metres. Default 4 x the equatorial radius (25,512,548 m). */
  maxRange?: number;
  /** Adapt near/far to the eye height and horizon. Default true. */
  clipPlanes?: boolean;
  /** World is ECEF (Z up) when true; the engine's Y-up world (x, z, -y of ECEF) when false. Default false. */
  zUp?: boolean;
  /**
   * Pick against the engine's visible meshes and models (terrain meshes, 3D Tiles, glTF) with the bvh `Raycaster`, so
   * zoom, rotate and pan grab the real surface. Needs the controls attached to an engine. Default true.
   */
  scene?: boolean;
  /** Limit scene queries to these meshes and models. Default null: every visible mesh and model. */
  colliders?: readonly (Mesh | ModelLike)[] | null;
  /** Your own surface ray query, in world coordinates, tried alongside the scene; the nearest hit wins. Default none. */
  raycast?: SurfaceRaycast;
  /** Raycaster for scene queries (layers, side, filter). Default a new one. */
  raycaster?: Raycaster;
  /**
   * Let the eye go below the terrain and through meshes: no clearance floor and no collision sweeps, for subsurface
   * and underwater views. Default false.
   */
  underground?: boolean;
  /** Navigation mode to start in. Default `'globe'`. */
  mode?: GeospatialMode;
  /** Eye height above the ground in `walk` mode, metres. Default 1.7. */
  eyeHeight?: number;
  /** Ground speed in `walk` mode, metres per second (Shift: 4 x). Default 1.4; about 15 drives a car. */
  walkSpeed?: number;
  /** `fly` speed in heights above the ground per second (at least 2 m/s; Shift: 4 x). Default 1. */
  flySpeed?: number;
  /** Where movement keys are read. Default the element's document. */
  keyTarget?: EventTargetLike | null;
  /** Button mapping, glide and double click: see {@link GeospatialPreset}. Default `'globe'`. */
  preset?: GeospatialPreset;
  /** Glide per axis, overriding the preset's. */
  inertia?: Partial<GeospatialInertia>;
  /** Geoid height above the ellipsoid (an EGM grid), for the sea-level readout. Default none. */
  geoid?: GeoidQuery;
  /**
   * Keep the page's URL hash in step with the view (`#geo=lat,lon,height,range,heading,pitch,mode`, degrees and metres)
   * and start from it when present: links and reloads return to the same view. Default false.
   */
  hash?: boolean;
  /**
   * Read the first connected gamepad each update: left stick pans (or moves in first person), right stick turns and
   * tilts (or looks), the right trigger zooms in (or rises), the left trigger out (or sinks). Default false.
   */
  gamepad?: boolean;
  /**
   * No glide, and flights, paths and mode switches without an explicit `duration` jump straight to the end. Default
   * the user's `prefers-reduced-motion: reduce` setting (false where it cannot be read).
   */
  reducedMotion?: boolean;
}

/** Options for {@link GeospatialControls.flyTo}. */
export interface FlightOptions {
  /** Seconds; 0 applies at once. Default from the path length: `pathLength / speed`, within 1 s and `maxDuration`. */
  duration?: number;
  /** Path length per second when `duration` is not given, in screen heights (van Wijk and Nuij's units). Default 1.2. */
  speed?: number;
  /** Longest automatic duration, seconds. Default 10. */
  maxDuration?: number;
  /**
   * The zoom-out of the path (van Wijk and Nuij's rho): larger climbs higher sooner, near 0 is a straight pan. Default
   * 1.42, their measured optimum (about the square root of 2).
   */
  curve?: number;
  /** Progress to eased progress, both in [0, 1]. Default smootherstep. */
  easing?: (t: number) => number;
  /** Cancels the flight where it is; an already aborted signal does nothing. */
  signal?: AbortSignal;
  /** Follow the optimal zoom-and-pan path (climb, cross, descend). False pans along the surface with a log zoom. Default true. */
  arc?: boolean;
  /** A pointer press or the wheel on the element cancels the flight. Default true. */
  cancelOnInput?: boolean;
}

/** Fly to a bounding sphere: {@link GeospatialControls.flyToBoundingSphere}. */
export interface BoundingSphereFlight extends FlightOptions {
  /** Compass direction to look toward, radians. Default keeps the current heading. */
  heading?: number;
  /** Angle below the horizon, radians. Default keeps the current pitch. */
  pitch?: number;
  /** Extra room around the sphere: 1 just fits, 1.2 leaves a fifth more. Default 1.1. */
  padding?: number;
}

/** Options for {@link GeospatialControls.followPath}. */
export interface PathOptions {
  /** Seconds for the whole path. Default from its length: `length / speed`, at least 1 s. */
  duration?: number;
  /** Path length per second when `duration` is not given, in screen heights. Default 0.6 (a slow cinematic move). */
  speed?: number;
  /** Progress to eased progress, both in [0, 1]. Default smootherstep (eases in at the first view, out at the last). */
  easing?: (t: number) => number;
  /** Cancels the move where it is. */
  signal?: AbortSignal;
  /** A pointer press or the wheel cancels the move. Default true. */
  cancelOnInput?: boolean;
}

interface Flight {
  /** A path's view at eased progress e, in place of the zoom-and-pan flight. */
  at?: (e: number) => Required<GeospatialView>;
  from: Required<GeospatialView>;
  to: Required<GeospatialView>;
  distance: number;
  bearing: number;
  elapsed: number;
  duration: number;
  easing: (t: number) => number;
  path: ZoomPanPath | null;
  /** Range per unit of path width w (w = range * 2 tan(fov / 2)). */
  scale: number;
  cancelOnInput: boolean;
  finish: (done: boolean) => void;
  off: () => void;
}

/** The van Wijk and Nuij path: its length S (in widths) and the pan u and width w at path parameter s in [0, S]. */
export interface ZoomPanPath {
  S: number;
  at(s: number): { u: number; w: number };
}

/**
 * The optimal zoom-and-pan path of van Wijk and Nuij, "Smooth and efficient zooming and panning", IEEE InfoVis 2003
 * (https://doi.org/10.1109/INFVIS.2003.1249004), section 4: from width `w0` to `w1` over a pan of `u1` (same units)
 * with curvature `rho`. Our own code from the paper's equations.
 */
export function zoomPanPath(w0: number, w1: number, u1: number, rho = 1.42): ZoomPanPath {
  num('zoomPanPath', w0, w1, u1, rho);
  if (!(w0 > 0 && w1 > 0 && u1 >= 0 && rho > 0))
    throw rangeError('zoomPanPath needs widths above 0, a pan of 0 or more and rho above 0', 'controls-arguments');
  const r2 = rho * rho;
  // No pan to speak of: a pure zoom, w = w0 exp(+-rho s) (the paper's u1 = 0 case).
  if (u1 < 1e-9 * Math.max(w0, w1)) {
    const k = w1 < w0 ? -1 : 1,
      S = Math.abs(Math.log(w1 / w0)) / rho;
    return { S, at: (t) => ({ u: S ? (u1 * t) / S : u1, w: w0 * Math.exp(k * rho * t) }) };
  }
  const b = (wi: number, sign: number) => (w1 * w1 - w0 * w0 + sign * r2 * r2 * u1 * u1) / (2 * wi * r2 * u1),
    // ln(sqrt(b^2 + 1) - b) is -asinh(b), without the cancellation at large b (a city hop at street level).
    r = (bi: number) => -Math.asinh(bi),
    r0 = r(b(w0, 1)),
    r1 = r(b(w1, -1)),
    S = (r1 - r0) / rho,
    c0 = Math.cosh(r0),
    s0 = Math.sinh(r0);
  return {
    S,
    at: (t) => ({ u: (w0 / r2) * (c0 * Math.tanh(rho * t + r0) - s0), w: (w0 * c0) / Math.cosh(rho * t + r0) }),
  };
}

type V = [number, number, number];
type Pose = { position: V; target: V; up: V };

/** Steps of the `heightAt` ray march before a pick gives up (the ellipsoid then stands in). */
const MARCH_STEPS = 512;
/** Steepest look up or down in the first-person modes, radians (just short of straight, where heading is undefined). */
const LOOK = Math.PI / 2 - 0.01;
/** Orbit centre heights a view may hold, metres above the ellipsoid: 1000 km below to four equatorial radii above. */
const MIN_HEIGHT = -1e6;
const MAX_HEIGHT = 4 * WGS84_A;
const MODES: readonly GeospatialMode[] = ['globe', 'local', 'map', 'fly', 'walk'];
const INERTIA: Record<GeospatialPreset, GeospatialInertia> = {
  globe: { pan: 0.3, rotate: 0.25, zoom: 0.2 },
  map: { pan: 0.45, rotate: 0.25, zoom: 0.2 },
  dcc: { pan: 0, rotate: 0, zoom: 0 },
};
/** A drag older than this before release is a stop, not a fling (seconds). */
const FLING_GAP = 0.08;
const prefersReducedMotion = (): boolean => {
  try {
    return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};
/** Stick values inside this are rest. */
const DEADZONE = 0.15;
const dead = (x: number | undefined) => (typeof x === 'number' && Math.abs(x) > DEADZONE ? x : 0);
const held = (keys: ReadonlySet<string>, ...codes: string[]) => +codes.some((c) => keys.has(c));
const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const num = (what: string, ...v: number[]) => {
  if (!v.every(Number.isFinite))
    throw rangeError(`${what} needs finite numbers (radians and metres)`, 'controls-arguments');
};
const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const along = (o: readonly number[], d: readonly number[], t: number): V => [
  o[0]! + d[0]! * t,
  o[1]! + d[1]! * t,
  o[2]! + d[2]! * t,
];

/** Distance along a unit ECEF ray to the ellipsoid raised by `h` metres (first hit in front), or null on a miss. */
function rayEllipsoid(o: readonly number[], d: readonly number[], h: number): number | null {
  const ax = WGS84_A + h,
    bz = WGS84_B + h;
  if (!(ax > 0 && bz > 0)) return null;
  const po = [o[0]! / ax, o[1]! / ax, o[2]! / bz],
    pd = [d[0]! / ax, d[1]! / ax, d[2]! / bz],
    a = dot3(pd, pd),
    b = dot3(po, pd),
    c = dot3(po, po) - 1,
    disc = b * b - a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / a;
  return t >= 0 ? t : null;
}

/**
 * Orbit, pan, zoom and fly about the WGS84 globe. Drag grabs the surface under the cursor and keeps it there, right or
 * modified drag turns and tilts about the surface in the middle of the screen, the wheel zooms toward the surface under
 * the cursor. Surfaces are the engine's meshes and models (bvh), your `raycast` and the `heightAt` terrain, else the
 * ellipsoid. The eye never goes below `clearance` metres above the terrain `heightAt` reports (a hill under the eye
 * lifts the view; it settles back when the hill is gone).
 */
export class GeospatialControls extends Controls {
  /** Enable left-drag panning. Default true. */
  enablePan = true;
  /** Enable wheel and pinch zoom. Default true. */
  enableZoom = true;
  /** Enable heading and pitch drags. Default true. */
  enableRotate = true;
  /** Wheel multiplier; 500 CSS pixels doubles the range. Default 1. */
  zoomSpeed = 1;
  /** Heading and pitch radians per viewport height of drag. Default PI. */
  rotateSpeed = Math.PI;
  /** Terrain height query; assign to change it. Default none. */
  heightAt: HeightQuery | undefined;
  /** Minimum eye height over the terrain, metres. */
  clearance: number;
  readonly minPitch: number;
  readonly maxPitch: number;
  readonly minRange: number;
  readonly maxRange: number;
  clipPlanes: boolean;
  readonly zUp: boolean;
  /** Pick against the engine scene with the bvh Raycaster. Default true. */
  scene: boolean;
  /** Scene meshes and models picks consider; null is everything visible. */
  colliders: readonly (Mesh | ModelLike)[] | null;
  /** Your own world-space surface ray query. Default none. */
  raycast: SurfaceRaycast | undefined;
  readonly raycaster: Raycaster;
  /** No clearance floor and no collision: the eye may go below the terrain and through meshes. Default false. */
  underground: boolean;
  /** Eye height above the ground in `walk` mode, metres. */
  eyeHeight: number;
  /** Ground speed in `walk` mode, metres per second. */
  walkSpeed: number;
  /** `fly` speed in heights above the ground per second. */
  flySpeed: number;
  /** Key pan speed in the orbit modes, heights above the ground per second. Default 1. */
  keyPanSpeed = 1;
  /** Glide per axis, seconds; see {@link GeospatialInertia}. */
  inertia: GeospatialInertia;
  /** No glide and instant automatic flights; see the option. */
  reducedMotion: boolean;
  /** Read the first connected gamepad each update; see the option. */
  gamepad: boolean;
  /** Geoid height query for {@link GeospatialControls.heights}; assign to change it. */
  geoid: GeoidQuery | undefined;
  /** Mirror the view in the URL hash; see the option. */
  readonly hash: boolean;
  /** Heading at the last compass event, and whether the view moved since the last `moveend`. */
  private lastHeading = Number.NaN;
  private moving = false;
  /** Touches down now, by pointer id, and the two-finger gesture's last midpoint, spread and angle. */
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinch: { x: number; y: number; spread: number; angle: number } | null = null;
  private p: GeospatialPreset = 'globe';
  /** Glide velocities: pan east and north (m/s), heading and pitch (rad/s), log range (1/s). */
  private glide = { east: 0, north: 0, heading: 0, pitch: 0, zoom: 0 };
  /** Last drag sample for fling velocities: time (s) and the view then. */
  private sample: { t: number; v: Required<GeospatialView> } | null = null;
  private m: GeospatialMode;
  /** True while a mode switch moves the camera: pitch may cross both modes' limits. */
  private loose = false;
  private readonly keys = new Set<string>();
  private readonly keyTarget: EventTargetLike | null;
  private v: Required<GeospatialView>;
  private lifted = 0;
  private reachRange = 0;
  private flight: Flight | null = null;
  private dragging: {
    id: number;
    x: number;
    y: number;
    act: 'pan' | 'rotate' | 'zoom';
    grab: V | null;
    grabHeight: number;
  } | null = null;
  private dead = false;
  private changed = false;
  protected override get kind(): string {
    return 'geospatial';
  }

  constructor(source: Camera | EngineKernel, element?: ControlElement | null, options: GeospatialOptions = {}) {
    const minPitch = options.minPitch ?? 0,
      maxPitch = options.maxPitch ?? Math.PI / 2,
      minRange = options.minRange ?? 1,
      maxRange = options.maxRange ?? 4 * WGS84_A,
      clearance = options.clearance ?? 2,
      eyeHeight = options.eyeHeight ?? 1.7,
      walkSpeed = options.walkSpeed ?? 1.4,
      flySpeed = options.flySpeed ?? 1,
      mode = options.mode ?? 'globe';
    if (!MODES.includes(mode))
      throw rangeError(`Geospatial mode is one of ${MODES.join(', ')}; got ${String(mode)}`, 'controls-arguments');
    if (![eyeHeight, walkSpeed, flySpeed].every((x) => x > 0 && Number.isFinite(x)))
      throw rangeError('Use a finite eyeHeight, walkSpeed and flySpeed above 0', 'controls-arguments');
    if (
      !(minPitch >= 0 && maxPitch <= Math.PI / 2 && minPitch <= maxPitch) ||
      !(minRange > 0 && maxRange >= minRange) ||
      !(clearance >= 0) ||
      !Number.isFinite(clearance)
    )
      throw rangeError(
        'Use 0 <= minPitch <= maxPitch <= PI/2, 0 < minRange <= maxRange and a finite clearance >= 0',
        'controls-arguments',
      );
    super(source, element);
    this.minPitch = minPitch;
    this.maxPitch = maxPitch;
    this.minRange = minRange;
    this.maxRange = maxRange;
    this.clearance = clearance;
    this.heightAt = options.heightAt;
    this.clipPlanes = options.clipPlanes ?? true;
    this.zUp = options.zUp ?? false;
    this.scene = options.scene ?? true;
    this.colliders = options.colliders ?? null;
    this.raycast = options.raycast;
    this.raycaster = options.raycaster ?? new Raycaster();
    this.underground = options.underground ?? false;
    this.eyeHeight = eyeHeight;
    this.walkSpeed = walkSpeed;
    this.flySpeed = flySpeed;
    this.m = mode;
    this.keyTarget = options.keyTarget ?? null;
    this.inertia = { ...INERTIA.globe };
    this.gamepad = options.gamepad ?? false;
    this.geoid = options.geoid;
    this.hash = options.hash ?? false;
    this.reducedMotion = options.reducedMotion ?? prefersReducedMotion();
    this.applyPreset(options.preset ?? 'globe');
    if (options.inertia) this.setInertia(options.inertia);
    this.v = this.sanitize({
      ...{ height: 0, heading: 0, pitch: Math.PI / 2, range: 2e7 },
      longitude: 0,
      latitude: 0,
      ...options.view,
      ...(this.hash ? GeospatialControls.parseHash(globalThis.location?.hash ?? '') : null),
    } as Required<GeospatialView>);
    if (this.hash) {
      const m = GeospatialControls.parseHash(globalThis.location?.hash ?? '')?.mode;
      if (m) this.m = m;
    }
    this.commit();
    this.init();
  }

  /** The requested orbit centre and angles (before the terrain lift). */
  get view(): Readonly<Required<GeospatialView>> {
    return { ...this.v };
  }
  /** Metres the terrain floor currently lifts the view above the requested one. */
  get terrainLift(): number {
    return this.lifted;
  }
  /** The range in use now: the requested one, or shorter while a mesh between the centre and the eye pulls the eye in. */
  get collisionRange(): number {
    return this.reachRange;
  }
  /** Eye position as geodetic longitude, latitude (radians) and height (metres). */
  get eye(): { longitude: number; latitude: number; height: number } {
    const p = this.toEcef(this.camera.position);
    return ecefToCartographic(p[0], p[1], p[2]);
  }

  private sanitize(v: Required<GeospatialView>): Required<GeospatialView> {
    num('Geospatial view', v.longitude, v.latitude, v.height, v.heading, v.pitch, v.range);
    if (Math.abs(v.latitude) > Math.PI / 2 + 1e-12)
      throw rangeError(
        'Geospatial latitude is in radians within [-PI/2, PI/2]; convert degrees with degToRad',
        'controls-arguments',
      );
    if (!(v.height >= MIN_HEIGHT && v.height <= MAX_HEIGHT))
      throw rangeError(
        `Geospatial height ${v.height} m is outside [${MIN_HEIGHT}, ${MAX_HEIGHT}] m above the ellipsoid; pass a height in that range`,
        'controls-arguments',
      );
    return {
      longitude: wrap(v.longitude),
      latitude: clamp(v.latitude, -Math.PI / 2, Math.PI / 2),
      height: v.height,
      heading: wrap(v.heading),
      pitch: clamp(v.pitch, ...this.pitchLimits()),
      range: clamp(v.range, this.minRange, this.maxRange),
    };
  }
  /** Pitch range of the mode: the options' in globe and local, `maxPitch` in map, near +-PI/2 in fly and walk. */
  private pitchLimits(): [number, number] {
    if (this.loose) return [Math.min(-LOOK, this.minPitch), Math.max(LOOK, this.maxPitch)];
    if (this.m === 'map') return [this.maxPitch, this.maxPitch];
    return this.m === 'fly' || this.m === 'walk' ? [-LOOK, LOOK] : [this.minPitch, this.maxPitch];
  }
  private alive(): void {
    if (this.dead) throw new MargoError('disposed', 'Geospatial controls are disposed; create new GeospatialControls');
  }
  /** ECEF position (or direction when `dir`) to world. */
  private toWorld(p: readonly number[], dir = false): V {
    void dir;
    return this.zUp ? [p[0]!, p[1]!, p[2]!] : [p[0]!, p[2]!, -p[1]!];
  }
  /** World position (or direction when `dir`) to ECEF. */
  private toEcef(p: readonly number[], dir = false): V {
    void dir;
    return this.zUp ? [p[0]!, p[1]!, p[2]!] : [p[0]!, -p[2]!, p[1]!];
  }
  /** Collision clearance in use: in walk at most half the eye height, so it never lifts a walker off the ground. */
  private get gap(): number {
    return this.m === 'walk' ? Math.min(this.clearance, this.eyeHeight / 2) : this.clearance;
  }
  private floor(longitude: number, latitude: number): number {
    const h = this.heightAt?.(longitude, latitude);
    return (typeof h === 'number' && Number.isFinite(h) ? h : 0) + this.gap;
  }
  /**
   * The eye and the four near-plane corners of a pose, ECEF: what collision keeps clear, so the near plane never cuts
   * into the ground or a wall.
   */
  private probes(pose: Pose): V[] {
    const e = pose.position,
      f = [pose.target[0] - e[0], pose.target[1] - e[1], pose.target[2] - e[2]],
      l = Math.hypot(...f) || 1,
      fw: V = [f[0] / l, f[1] / l, f[2] / l],
      u = pose.up,
      r: V = [fw[1] * u[2] - fw[2] * u[1], fw[2] * u[0] - fw[0] * u[2], fw[0] * u[1] - fw[1] * u[0]],
      el = this.element,
      aspect = el && el.clientWidth > 0 && el.clientHeight > 0 ? el.clientWidth / el.clientHeight : 16 / 9,
      near = Math.max(0, this.camera.near),
      h = near * Math.tan(((this.camera.fov ?? 60) * Math.PI) / 360),
      w = h * aspect,
      out: V[] = [e];
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        out.push([0, 1, 2].map((i) => e[i]! + fw[i]! * near + r[i]! * sx * w + u[i]! * sy * h) as V);
    return out;
  }
  /**
   * The ECEF pose of a view with collision: the arm from the centre to each probe is swept against the scene and your
   * raycast (a mesh in between pulls the eye in front of it), then the centre is lifted until every probe clears the
   * terrain floor and the surface just below it by `clearance`. Returns the pose, the lift and the range used.
   */
  private poseOf(v: Required<GeospatialView>, refresh = true): { pose: Pose; lift: number; range: number } {
    let lift = 0,
      range = v.range,
      pose: Pose = orbitPose(v, v.heading, v.pitch, range);
    if (this.underground) return { pose, lift, range };
    const surfaces = !!(this.raycast || (this.scene && this.engine)),
      k = this.gap,
      cast = (o: V, d: V, far: number) => {
        const hit = this.castSurface(o, d, far, false, refresh);
        refresh = false;
        return hit;
      };
    if (surfaces) {
      const t = pose.target;
      for (const p of this.probes(pose)) {
        const d = [p[0] - t[0], p[1] - t[1], p[2] - t[2]],
          l = Math.hypot(...d);
        if (!(l > 0)) continue;
        // Start a little out from the centre, which often lies on the very surface it was picked from.
        const dir = d.map((x) => x / l) as V,
          skip = Math.min(k, l / 2),
          hit = cast(along(t, dir, skip), dir, l - skip + k);
        if (hit) range = Math.min(range, Math.max(1e-3, (range * (hit.t + skip - k)) / l));
      }
      if (range < v.range) pose = orbitPose(v, v.heading, v.pitch, range);
    }
    for (let i = 0; i < 6; i++) {
      let deficit = -Infinity;
      for (const p of this.probes(pose)) {
        const e = ecefToCartographic(p[0], p[1], p[2]);
        deficit = Math.max(deficit, this.floor(e.longitude, e.latitude) - e.height);
        if (surfaces) {
          // A roof or tile surface within the clearance below (or just above, when a move went into it).
          const up = geodeticNormal(p[0], p[1], p[2]),
            hit = cast(along(p, up, k), [-up[0], -up[1], -up[2]], 2 * k);
          if (hit) deficit = Math.max(deficit, 2 * k - hit.t);
        }
      }
      if (deficit <= 1e-6) break;
      lift += deficit;
      pose = orbitPose({ ...v, height: v.height + lift }, v.heading, v.pitch, range);
    }
    // The ground can fall away as the lift grows; a lift is only the terrain's demand at the final eye.
    return { pose, lift, range };
  }
  /** Write the camera from the view. */
  private commit(): void {
    const { pose, lift, range } = this.poseOf(this.v);
    this.lifted = lift;
    this.reachRange = range;
    this.camera.position = this.toWorld(pose.position);
    this.camera.target = this.toWorld(pose.target);
    this.camera.up = this.toWorld(pose.up, true);
    if (this.clipPlanes) {
      const eye = ecefToCartographic(pose.position[0], pose.position[1], pose.position[2]),
        h = Math.max(1, eye.height);
      this.camera.near = h * 0.01;
      this.camera.far = Math.max(this.camera.near * 2, 2 * Math.sqrt(h * (h + 2 * WGS84_A)) + h);
    }
    this.changed = true;
    this.moving = true;
    this.dispatchEvent({ type: 'change' });
    // The view heading, not the eye frame's: a zoom or pan moves the eye frame a little but turns no compass.
    const heading = this.v.heading;
    if (!(Math.abs(wrap(heading - this.lastHeading)) < 1e-9)) {
      this.lastHeading = heading;
      this.dispatchEvent({ type: 'compass', heading });
    }
  }

  /** Set the view (missing fields keep their value); cancels a flight in progress. Radians and metres. */
  setView(view: Partial<GeospatialView>): void {
    this.alive();
    this.cancel();
    this.v = this.sanitize({ ...this.v, ...view } as Required<GeospatialView>);
    this.commit();
  }
  /** Move the centre along the surface by metres east and north (screen-independent), keeping its height. */
  pan(east: number, north: number): void {
    this.alive();
    num('Geospatial pan', east, north);
    const d = Math.hypot(east, north);
    if (!d) return;
    const g = geodesicDirect(this.v.longitude, this.v.latitude, Math.atan2(east, north), d);
    this.setView({ longitude: g.longitude, latitude: g.latitude });
  }
  /** Change heading and pitch by radians. */
  rotate(heading: number, pitch: number): void {
    this.alive();
    num('Geospatial rotate', heading, pitch);
    this.setView({ heading: this.v.heading + heading, pitch: this.v.pitch + pitch });
  }
  /** Multiply the range by `factor` (below 1 zooms in) about the centre. */
  zoom(factor: number): void {
    this.alive();
    if (!(factor > 0) || !Number.isFinite(factor))
      throw rangeError('Geospatial zoom needs a positive finite factor', 'controls-arguments');
    this.setView({ range: this.v.range * factor });
  }

  /** The ECEF ray through CSS pixel (x, y) of a pose (default the camera now), or null without a sized element. */
  private screenRay(x: number, y: number, pose?: Pose): { o: V; d: V } | null {
    const e = this.element;
    if (!e || !(e.clientWidth > 0 && e.clientHeight > 0)) return null;
    const c = this.camera,
      p = pose ?? { position: this.toEcef(c.position), target: this.toEcef(c.target), up: this.toEcef(c.up, true) },
      r = ray(rollFrame({ ...p, fov: c.fov ?? 60 }), x, y, e.clientWidth, e.clientHeight);
    return { o: r.origin, d: r.direction };
  }
  /** How far along a ray from ECEF `o` a surface can be seen: the eye's horizon plus 400 km for the highest mountains. */
  private reach(o: readonly number[]): number {
    const h = Math.max(1, ecefToCartographic(o[0]!, o[1]!, o[2]!).height);
    return Math.sqrt(h * (h + 2 * WGS84_A)) + 4e5;
  }
  /** The nearest surface along a unit ECEF ray within `far`: scene meshes, your raycast and the heightAt terrain. */
  private castSurface(
    o: V,
    d: V,
    far: number,
    terrain = true,
    refresh = true,
  ): { t: number; source: GeospatialPickSource } | null {
    let best = far,
      source: GeospatialPickSource | null = null;
    const wo = this.toWorld(o),
      wd = this.toWorld(d, true);
    if (this.scene && this.engine) {
      const r = this.raycaster;
      r.set(wo, wd);
      r.near = 0;
      r.far = best;
      r.firstHitOnly = true;
      const options = { refresh },
        side = r.side;
      // Collision counts only faces turned toward the ray: from inside a building (a centre under its roof) the arm
      // passes out through the back of the roof instead of pulling the eye in.
      if (!terrain) r.side = 'front';
      let hit;
      try {
        [hit] = this.colliders
          ? r.intersectObjects(this.engine, this.colliders, options)
          : r.intersectEngine(this.engine, options);
      } finally {
        r.side = side;
      }
      if (hit && hit.distance < best) (best = hit.distance), (source = 'scene');
    }
    if (this.raycast) {
      const t = this.raycast(wo, wd, best);
      if (typeof t === 'number' && t >= 0 && t < best) (best = t), (source = 'raycast');
    }
    if (terrain && this.heightAt) {
      const t = this.march(o, d, best);
      if (t !== null && t < best) (best = t), (source = 'terrain');
    }
    return source ? { t: best, source } : null;
  }
  /** First crossing of a unit ECEF ray below the `heightAt` terrain within `far`, refined by bisection; null when clear. */
  private march(o: V, d: V, far: number): number | null {
    const gap = (t: number) => {
      const p = along(o, d, t),
        c = ecefToCartographic(p[0], p[1], p[2]),
        g = this.heightAt!(c.longitude, c.latitude);
      return c.height - (typeof g === 'number' && Number.isFinite(g) ? g : 0);
    };
    let t = 0,
      a = gap(0);
    if (a <= 0) return 0;
    // ponytail: steps by half the height above the ground, so a slope steeper than about 63 degrees across one step can
    // be crossed unseen; terrain/query's min-max tree passed as `raycast` is the exact path.
    for (let i = 0; i < MARCH_STEPS && t < far; i++) {
      const next = Math.min(far, t + Math.max(a * 0.5, 0.05, t * 1e-4)),
        b = gap(next);
      if (b <= 0) {
        let lo = t,
          hi = next;
        for (let k = 0; k < 40; k++) {
          const mid = (lo + hi) / 2;
          if (gap(mid) > 0) lo = mid;
          else hi = mid;
        }
        return hi;
      }
      t = next;
      a = b;
    }
    return null;
  }
  /** The surface hit along a unit ECEF ray, else the ellipsoid raised to the centre height; null on sky. */
  private hitAlong(o: V, d: V): (GeospatialPick & { point: V }) | null {
    const s = this.castSurface(o, d, this.reach(o));
    if (s) {
      const point = along(o, d, s.t);
      return { ...ecefToCartographic(point[0], point[1], point[2]), distance: s.t, source: s.source, point };
    }
    const t = rayEllipsoid(o, d, this.v.height);
    if (t === null) return null;
    const point = along(o, d, t);
    return {
      ...ecefToCartographic(point[0], point[1], point[2]),
      height: this.v.height,
      distance: t,
      source: 'ellipsoid',
      point,
    };
  }
  /**
   * The surface under CSS pixel (x, y): the nearest hit of the engine scene (bvh), your `raycast` and the `heightAt`
   * terrain, else the ellipsoid raised to the centre height; null on sky.
   */
  pick(x: number, y: number): GeospatialPick | null {
    num('Geospatial pick', x, y);
    const r = this.screenRay(x, y),
      hit = r && this.hitAlong(r.o, r.d);
    if (!hit) return null;
    return {
      longitude: hit.longitude,
      latitude: hit.latitude,
      height: hit.height,
      distance: hit.distance,
      source: hit.source,
    };
  }
  /** The camera now in ECEF: eye, unit forward and screen-up. */
  private eyeFrame(): { eye: V; forward: V; up: V } {
    const c = this.camera,
      eye = this.toEcef(c.position),
      t = this.toEcef(c.target),
      d = [t[0] - eye[0], t[1] - eye[1], t[2] - eye[2]],
      l = Math.hypot(...d);
    return { eye, forward: d.map((x) => x / l) as V, up: this.toEcef(c.up, true) };
  }
  /** Re-centre the orbit on ECEF `centre` seen from ECEF `eye`, taking the heading from screen-up `up` at any pitch. */
  private aimAt(eye: V, centre: V, up: V): void {
    const v = this.viewFrom(eye, centre, up);
    this.cancel();
    this.v = this.sanitize(v);
    this.commit();
  }
  /** The view that puts the eye at ECEF `eye` looking at `centre`, heading from screen-up `up` at any pitch. */
  private viewFrom(eye: V, centre: V, up: V): Required<GeospatialView> {
    const c = ecefToCartographic(centre[0], centre[1], centre[2]),
      b = enuBasis(c.longitude, c.latitude),
      d: V = [centre[0] - eye[0], centre[1] - eye[1], centre[2] - eye[2]],
      range = Math.hypot(...d),
      f = d.map((x) => x / range),
      cp = Math.hypot(dot3(f, b.east), dot3(f, b.north)),
      sp = -dot3(f, b.up),
      // orbitPose: view_en * cos(pitch) + up_en * sin(pitch) is (sin, cos) of the heading at every pitch.
      he = dot3(f, b.east) * cp + dot3(up, b.east) * sp,
      hn = dot3(f, b.north) * cp + dot3(up, b.north) * sp;
    return {
      ...c,
      heading: Math.hypot(he, hn) > 1e-12 ? Math.atan2(he, hn) : this.v.heading,
      pitch: Math.asin(clamp(sp, -1, 1)),
      range,
    };
  }
  /** The camera's eye (ECEF) and its view's heading and pitch in the ENU frame at the eye. */
  private eyeAngles(): { eye: V; heading: number; pitch: number } {
    const { eye, forward } = this.eyeFrame(),
      c = ecefToCartographic(eye[0], eye[1], eye[2]),
      b = enuBasis(c.longitude, c.latitude);
    return {
      eye,
      heading: Math.atan2(dot3(forward, b.east), dot3(forward, b.north)),
      pitch: Math.asin(clamp(-dot3(forward, b.up), -1, 1)),
    };
  }
  /** The view with the eye at ECEF `eye` looking along heading and pitch of the eye's ENU frame, centre `range` ahead. */
  private eyeView(eye: V, heading: number, pitch: number, range: number): Required<GeospatialView> {
    const c = ecefToCartographic(eye[0], eye[1], eye[2]),
      b = enuBasis(c.longitude, c.latitude),
      sh = Math.sin(heading),
      ch = Math.cos(heading),
      sp = Math.sin(pitch),
      cp = Math.cos(pitch),
      mix = (e: number, n: number, u: number) =>
        [0, 1, 2].map((i) => b.east[i]! * e + b.north[i]! * n + b.up[i]! * u) as V;
    return this.viewFrom(eye, along(eye, mix(sh * cp, ch * cp, -sp), range), mix(sh * sp, ch * sp, cp));
  }
  /** The orbit range of the first-person modes: the centre sits just ahead of the eye. */
  private get lookRange(): number {
    return clamp(1, this.minRange, this.maxRange);
  }
  /**
   * Ground height (metres above the ellipsoid) at a point: the higher of `heightAt` and the first scene or `raycast`
   * surface below `from` metres, so a walk climbs steps up to `eyeHeight` and onto roofs and tiles.
   */
  private groundAt(longitude: number, latitude: number, from: number): number {
    const h = this.heightAt?.(longitude, latitude);
    let g = typeof h === 'number' && Number.isFinite(h) ? h : 0;
    if (this.raycast || (this.scene && this.engine)) {
      const o = cartographicToEcef(longitude, latitude, from),
        n = geodeticNormal(o[0], o[1], o[2]),
        hit = this.castSurface(o, [-n[0], -n[1], -n[2]], Math.max(0, from - g) + 1, false);
      if (hit) g = Math.max(g, from - hit.t);
    }
    return g;
  }

  /** The feel preset in use; change it with {@link GeospatialControls.applyPreset}. */
  get preset(): GeospatialPreset {
    return this.p;
  }
  /** Use a preset's button mapping, glide and double click (see {@link GeospatialPreset}). */
  applyPreset(preset: GeospatialPreset): void {
    if (!(preset in INERTIA))
      throw rangeError(
        `Geospatial preset is one of ${Object.keys(INERTIA).join(', ')}; got ${String(preset)}`,
        'controls-arguments',
      );
    this.p = preset;
    this.inertia = { ...INERTIA[preset] };
    this.stopGlide();
  }
  /** Change the glide of some axes (seconds, 0 for none). */
  setInertia(inertia: Partial<GeospatialInertia>): void {
    const next = { ...this.inertia, ...inertia };
    if (![next.pan, next.rotate, next.zoom].every((x) => x >= 0 && Number.isFinite(x)))
      throw rangeError(
        'Geospatial inertia is finite seconds >= 0 per axis; pass 0 to stop an axis at once',
        'controls-arguments',
      );
    this.inertia = next;
  }
  /** Stop any glide at once. */
  stopGlide(): void {
    this.glide = { east: 0, north: 0, heading: 0, pitch: 0, zoom: 0 };
  }
  /** Seconds of an automatic duration, or 0 under reduced motion. */
  private auto(seconds: number): number {
    return this.reducedMotion ? 0 : seconds;
  }
  /** Record the view after a drag step, for the fling velocity at release. */
  private track(at: number, before: Required<GeospatialView>): void {
    const s = this.sample,
      v = this.v;
    this.sample = { t: at, v: { ...v } };
    if (!s) return void (this.sample = { t: at, v: { ...before } });
    const dt = at - s.t;
    if (!(dt > 1e-4)) return;
    const g = geodesicInverse(s.v.longitude, s.v.latitude, v.longitude, v.latitude),
      k = 1 / dt;
    // Blend with the previous estimate so one jittery event does not decide the fling.
    const mix = (a: number, b: number) => a * 0.3 + b * 0.7;
    this.glide = {
      east: mix(this.glide.east, g.distance * Math.sin(g.initialBearing) * k),
      north: mix(this.glide.north, g.distance * Math.cos(g.initialBearing) * k),
      heading: mix(this.glide.heading, wrap(v.heading - s.v.heading) * k),
      pitch: mix(this.glide.pitch, (v.pitch - s.v.pitch) * k),
      zoom: mix(this.glide.zoom, Math.log(v.range / s.v.range) * k),
    };
  }
  /** Carry the fling on, each axis decaying by its own time constant. */
  private coast(delta: number): void {
    const g = this.glide,
      i = this.inertia;
    if (!(delta > 0) || this.reducedMotion) return this.stopGlide();
    const decay = (tau: number) => (tau > 0 ? Math.exp(-delta / tau) : 0),
      // The distance a decaying velocity covers in delta: v tau (1 - e^(-delta / tau)).
      reach = (v: number, tau: number) => (tau > 0 ? v * tau * (1 - Math.exp(-delta / tau)) : 0),
      e = reach(g.east, i.pan),
      n = reach(g.north, i.pan),
      h = reach(g.heading, i.rotate),
      p = reach(g.pitch, i.rotate),
      z = reach(g.zoom, i.zoom);
    g.east *= decay(i.pan);
    g.north *= decay(i.pan);
    g.heading *= decay(i.rotate);
    g.pitch *= decay(i.rotate);
    g.zoom *= decay(i.zoom);
    const slow =
      Math.hypot(g.east, g.north) < 1e-3 * Math.max(1, this.v.range) &&
      Math.abs(g.heading) + Math.abs(g.pitch) + Math.abs(g.zoom) < 1e-3;
    if (slow) this.stopGlide();
    if (!e && !n && !h && !p && !z) return;
    const v = this.v,
      at = Math.hypot(e, n) > 0 ? geodesicDirect(v.longitude, v.latitude, Math.atan2(e, n), Math.hypot(e, n)) : v;
    this.v = this.sanitize({
      ...v,
      longitude: at.longitude,
      latitude: at.latitude,
      heading: v.heading + h,
      pitch: v.pitch + p,
      range: v.range * Math.exp(z),
    });
    this.commit();
  }

  /** The navigation mode; change it with {@link GeospatialControls.setMode}. */
  get mode(): GeospatialMode {
    return this.m;
  }
  /**
   * Switch the navigation mode. Where the pose can stay (fly from anywhere; globe, local from first person looking at
   * the ground) the camera does not move; otherwise it moves there over `duration`: walk lands at the surface in the
   * middle of the screen with a level view, map turns straight down, globe and local tilt into their pitch range.
   * Resolves true when the camera is in place, false when the move was cancelled (the mode has changed either way).
   * Emits a `mode` event.
   */
  setMode(mode: GeospatialMode, options: ModeSwitchOptions = {}): Promise<boolean> {
    this.alive();
    if (!MODES.includes(mode))
      throw rangeError(`Geospatial mode is one of ${MODES.join(', ')}; got ${String(mode)}`, 'controls-arguments');
    const duration = options.duration ?? this.auto(0.75);
    if (!(duration >= 0) || !Number.isFinite(duration))
      throw rangeError('A mode switch duration is finite seconds >= 0', 'controls-arguments');
    this.cancel();
    const a = this.eyeAngles(),
      { eye, forward, up } = this.eyeFrame(),
      first = mode === 'fly' || mode === 'walk',
      hit = first ? null : this.hitAlong(eye, forward);
    let to: Required<GeospatialView>;
    if (mode === 'fly') to = this.eyeView(eye, a.heading, a.pitch, this.lookRange);
    else if (mode === 'walk') {
      // Land where the view is centred: the surface on the view axis, else the orbit centre.
      const h = this.hitAlong(eye, forward),
        q = h?.point ?? cartographicToEcef(this.v.longitude, this.v.latitude, this.v.height),
        g = ecefToCartographic(q[0], q[1], q[2]),
        ground = this.groundAt(g.longitude, g.latitude, g.height + this.eyeHeight);
      to = this.eyeView(
        cartographicToEcef(g.longitude, g.latitude, ground + this.eyeHeight),
        a.heading,
        0,
        this.lookRange,
      );
    } else if (hit) to = this.viewFrom(eye, hit.point, up);
    else to = this.eyeView(eye, a.heading, a.pitch, Math.max(100, 2 * Math.max(0, this.eye.height)));
    this.m = mode;
    if (mode === 'map') to = { ...to, pitch: this.maxPitch };
    this.dispatchEvent({ type: 'mode', mode });
    const target = this.sanitize(to),
      pose = orbitPose(target, target.heading, target.pitch, target.range),
      now = orbitPose(this.v, this.v.heading, this.v.pitch, this.v.range),
      still =
        Math.hypot(...pose.position.map((x, i) => x - now.position[i]!)) <
          1e-6 * (1 + target.range) + 1e-9 * Math.hypot(...now.position) && // ECEF rounding at planet radius
        dot3(pose.up, now.up) > 1 - 1e-9 &&
        Math.abs(target.pitch - to.pitch) < 1e-12;
    if (still || duration === 0) {
      this.v = target;
      this.commit();
      return Promise.resolve(true);
    }
    this.loose = true;
    const settle = (done: boolean) => {
      this.loose = false;
      if (!this.dead) {
        this.v = this.sanitize(this.v);
        this.commit();
      }
      return done;
    };
    return this.flyTo(target, {
      duration,
      arc: false,
      cancelOnInput: false,
      ...(options.easing ? { easing: options.easing } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }).then(settle);
  }
  /** Turn the view about the eye by radians of heading and pitch (the first-person look; any mode). */
  look(heading: number, pitch: number): void {
    this.alive();
    num('Geospatial look', heading, pitch);
    const a = this.eyeAngles(),
      [lo, hi] = this.pitchLimits();
    this.cancel();
    this.v = this.sanitize(
      this.eyeView(
        a.eye,
        a.heading + heading,
        clamp(a.pitch + pitch, Math.max(lo, -LOOK), Math.min(hi, LOOK)),
        this.v.range,
      ),
    );
    this.commit();
  }
  /**
   * Move the eye by metres forward, right and up: along the view in `fly` (and every orbit mode), along the ground at
   * `eyeHeight` above it in `walk` (where `up` is ignored). Heading and pitch are kept in the local frame.
   */
  moveEye(forward: number, right: number, up = 0): void {
    this.alive();
    num('Geospatial moveEye', forward, right, up);
    const a = this.eyeAngles(),
      c = ecefToCartographic(a.eye[0], a.eye[1], a.eye[2]),
      b = enuBasis(c.longitude, c.latitude),
      sh = Math.sin(a.heading),
      ch = Math.cos(a.heading),
      walk = this.m === 'walk',
      cp = walk ? 1 : Math.cos(a.pitch),
      sp = walk ? 0 : Math.sin(a.pitch),
      lift = walk ? 0 : up;
    let eye = [0, 1, 2].map(
      (i) =>
        a.eye[i]! +
        (b.north[i]! * ch + b.east[i]! * sh) * cp * forward -
        b.up[i]! * sp * forward +
        (b.east[i]! * ch - b.north[i]! * sh) * right +
        b.up[i]! * lift,
    ) as V;
    if (walk) {
      const g = ecefToCartographic(eye[0], eye[1], eye[2]);
      eye = cartographicToEcef(
        g.longitude,
        g.latitude,
        this.groundAt(g.longitude, g.latitude, c.height) + this.eyeHeight,
      );
    }
    this.cancel();
    this.v = this.sanitize(this.eyeView(eye, a.heading, a.pitch, this.v.range));
    this.commit();
  }
  /** Metres per second the keys move the eye now: `walkSpeed` in walk, `flySpeed` x the height above the ground in fly. */
  get moveSpeed(): number {
    if (this.m === 'walk') return this.walkSpeed;
    const e = this.eye;
    return this.flySpeed * Math.max(2, e.height - this.groundAt(e.longitude, e.latitude, e.height));
  }
  /** Held movement keys move the eye in fly and walk. */
  private steer(delta: number): void {
    if (!(delta > 0)) return;
    const a = this.axes();
    if (!a) return;
    if (this.m !== 'fly' && this.m !== 'walk') return this.keyOrbit(delta, a);
    if (a.turn || a.tilt) this.look(a.turn * a.boost * delta * 1.5, a.tilt * a.boost * delta * 1.5);
    const u = this.m === 'fly' ? a.up : 0;
    if (!a.f && !a.r && !u) return;
    const step = this.moveSpeed * delta * a.boost;
    this.moveEye(a.f * step, a.r * step, u * step);
  }
  /**
   * The held keys and the gamepad as axes in [-1, 1]: forward, right, turn, tilt, zoom (positive zooms out), up
   * (first person), and the boost; null when nothing is pressed.
   */
  private axes(): { f: number; r: number; turn: number; tilt: number; zoom: number; up: number; boost: number } | null {
    const k = this.keys,
      first = this.m === 'fly' || this.m === 'walk';
    let pad: Gamepad | null = null;
    if (this.gamepad)
      for (const g of (globalThis.navigator as Navigator | undefined)?.getGamepads?.() ?? [])
        if (g && g.connected !== false && g.axes.length >= 4) {
          pad = g;
          break;
        }
    const ax = (i: number) => dead(pad?.axes[i]),
      trigger = (i: number) => {
        const b = pad?.buttons[i];
        return b ? (typeof b.value === 'number' ? b.value : +b.pressed) : 0;
      },
      clamp1 = (x: number) => clamp(x, -1, 1),
      f = clamp1(held(k, 'KeyW', 'ArrowUp') - held(k, 'KeyS', 'ArrowDown') - ax(1)),
      r = clamp1(held(k, 'KeyD', 'ArrowRight') - held(k, 'KeyA', 'ArrowLeft') + ax(0)),
      // First person turns with the right stick only; Q/E are its sink and rise keys.
      turn = clamp1((first ? 0 : held(k, 'KeyE') - held(k, 'KeyQ')) + ax(2)),
      tilt = clamp1((first ? 0 : held(k, 'KeyR') - held(k, 'KeyF')) + ax(3)),
      zoom = clamp1(
        held(k, 'Minus', 'NumpadSubtract', 'PageDown') -
          held(k, 'Equal', 'NumpadAdd', 'PageUp') +
          trigger(6) -
          trigger(7),
      ),
      up = clamp1(held(k, 'KeyE', 'PageUp') - held(k, 'KeyQ', 'PageDown') + trigger(7) - trigger(6));
    if (!f && !r && !turn && !tilt && !zoom && !up) return null;
    return {
      f,
      r,
      turn,
      tilt,
      zoom,
      up,
      boost: held(k, 'ShiftLeft', 'ShiftRight') || pad?.buttons[10]?.pressed ? 4 : 1,
    };
  }
  /**
   * Keys in the orbit modes: W/A/S/D or the arrows pan along the heading at `keyPanSpeed` heights above the ground per
   * second, Q/E turn, R/F tilt (not in map), + and - (or PageUp/PageDown) zoom, Shift 4 x.
   */
  private keyOrbit(
    delta: number,
    a: { f: number; r: number; turn: number; tilt: number; zoom: number; boost: number },
  ): void {
    const { f, r, turn, zoom, boost } = a,
      tilt = this.m === 'map' ? 0 : a.tilt;
    if (!f && !r && !turn && !tilt && !zoom) return;
    const e = this.eye,
      // Height above what is below the eye, so a pan crosses a valley as fast at street level as at orbit, per height.
      above = Math.max(2, e.height - this.groundAt(e.longitude, e.latitude, e.height)),
      step = this.keyPanSpeed * above * delta * boost,
      h = this.v.heading,
      v = this.v,
      g =
        f || r
          ? geodesicDirect(
              v.longitude,
              v.latitude,
              Math.atan2(r * Math.cos(h) + f * Math.sin(h), f * Math.cos(h) - r * Math.sin(h)),
              step * Math.hypot(f, r),
            )
          : v;
    this.setView({
      longitude: g.longitude,
      latitude: g.latitude,
      heading: v.heading + (turn * Math.PI * delta * boost) / 2,
      pitch: v.pitch + (tilt * Math.PI * delta * boost) / 4,
      range: v.range * 2 ** (zoom * delta * boost),
    });
  }
  /** Zoom by `factor` keeping the surface point under CSS pixel (x, y) under the cursor (sky: about the centre). */
  zoomAt(x: number, y: number, factor: number): void {
    this.alive();
    if (!(factor > 0) || !Number.isFinite(factor))
      throw rangeError('Geospatial zoom needs a positive finite factor', 'controls-arguments');
    const r = this.screenRay(x, y),
      hit = r && this.hitAlong(r.o, r.d),
      range = clamp(this.v.range * factor, this.minRange, this.maxRange);
    if (!hit) return this.setView({ range });
    // The eye slides along the cursor ray toward the hit with the view direction kept, so the hit stays put on screen.
    const k = range / this.v.range,
      { eye, forward, up } = this.eyeFrame(),
      p = hit.point,
      next: V = [p[0] + (eye[0] - p[0]) * k, p[1] + (eye[1] - p[1]) * k, p[2] + (eye[2] - p[2]) * k];
    this.aimAt(next, along(next, forward, range), up);
  }
  /** Re-centre the orbit on the surface on the view axis, so a turn pivots about what is in the middle of the screen. */
  private pivotOnAxis(): void {
    const { eye, forward, up } = this.eyeFrame(),
      hit = this.hitAlong(eye, forward);
    if (hit && hit.source !== 'ellipsoid') this.aimAt(eye, hit.point, up);
  }
  /**
   * Move the centre so the ray through CSS pixel (x, y) meets ECEF `grab` on the ellipsoid raised to its height: Newton
   * steps on the centre's longitude and latitude with heading, pitch and range kept. False when the cursor is on sky.
   */
  private dragTo(grab: V, grabHeight: number, x: number, y: number): boolean {
    const g = ecefToCartographic(grab[0], grab[1], grab[2]),
      b = enuBasis(g.longitude, g.latitude),
      miss = (lon: number, lat: number): [number, number] | null => {
        const { pose } = this.poseOf({ ...this.v, longitude: lon, latitude: lat }, false),
          r = this.screenRay(x, y, pose),
          t = r && rayEllipsoid(r.o, r.d, grabHeight);
        if (t === null || !r) return null;
        const q = along(r.o, r.d, t),
          off = [q[0] - grab[0], q[1] - grab[1], q[2] - grab[2]];
        return [dot3(off, b.east), dot3(off, b.north)];
      };
    let lon = this.v.longitude,
      lat = this.v.latitude,
      r0 = miss(lon, lat);
    if (!r0) return false;
    const eps = Math.max(1e-11, (this.v.range / WGS84_A) * 1e-4);
    for (let i = 0; i < 10 && Math.hypot(...r0) > 1e-4; i++) {
      const ep = lat + eps <= Math.PI / 2 ? eps : -eps,
        rl = miss(lon + eps, lat),
        rp = miss(lon, lat + ep);
      if (!rl || !rp) break;
      const a = (rl[0] - r0[0]) / eps,
        c = (rl[1] - r0[1]) / eps,
        bb = (rp[0] - r0[0]) / ep,
        dd = (rp[1] - r0[1]) / ep,
        det = a * dd - bb * c;
      if (!(Math.abs(det) > 0)) break;
      const nl = lon - (dd * r0[0] - bb * r0[1]) / det,
        np = clamp(lat - (a * r0[1] - c * r0[0]) / det, -Math.PI / 2, Math.PI / 2),
        rn = miss(nl, np);
      if (!rn || Math.hypot(...rn) >= Math.hypot(...r0)) break;
      lon = nl;
      lat = np;
      r0 = rn;
    }
    this.setView({ longitude: lon, latitude: lat });
    return true;
  }

  /**
   * Fly to a view on the optimal zoom-and-pan path of van Wijk and Nuij (2003): it climbs, crosses along the shortest
   * geodesic and descends so the apparent speed stays even, and its length sets the duration unless you give one.
   * Height, heading and pitch ease along. Resolves true on arrival, false when cancelled (signal, a pointer press or
   * the wheel, another flight, setView, dispose). Advance it with `update(delta)` (done for you on an engine).
   */
  flyTo(destination: GeospatialView, options: FlightOptions = {}): Promise<boolean> {
    this.alive();
    const speed = options.speed ?? 1.2,
      maxDuration = options.maxDuration ?? 10,
      curve = options.curve ?? 1.42;
    if (options.duration !== undefined && (!(options.duration >= 0) || !Number.isFinite(options.duration)))
      throw rangeError('Flight duration is finite seconds >= 0', 'controls-arguments');
    if (
      !(speed > 0 && Number.isFinite(speed)) ||
      !(maxDuration >= 0 && Number.isFinite(maxDuration)) ||
      !(curve > 0 && Number.isFinite(curve))
    )
      throw rangeError(
        'Flight speed and curve are finite and above 0, maxDuration finite and 0 or more',
        'controls-arguments',
      );
    this.cancel();
    const to = this.sanitize({ ...this.v, height: 0, ...destination } as Required<GeospatialView>);
    if (options.signal?.aborted) return Promise.resolve(false);
    const g = geodesicInverse(this.v.longitude, this.v.latitude, to.longitude, to.latitude),
      scale = 1 / (2 * Math.tan(((this.camera.fov ?? 60) * Math.PI) / 180 / 2)),
      path = options.arc === false ? null : zoomPanPath(this.v.range / scale, to.range / scale, g.distance, curve),
      length = path
        ? path.S
        : Math.abs(Math.log(to.range / this.v.range)) + (g.distance * scale) / Math.max(this.v.range, to.range),
      turn = Math.abs(wrap(to.heading - this.v.heading)) + Math.abs(to.pitch - this.v.pitch),
      duration =
        options.duration ??
        this.auto(length > 1e-9 || turn > 1e-9 ? Math.min(maxDuration, Math.max(1, length / speed)) : 0);
    if (duration === 0) {
      this.v = to;
      this.commit();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const abort = () => this.cancel();
      options.signal?.addEventListener('abort', abort, { once: true });
      this.flight = {
        from: { ...this.v },
        to,
        distance: g.distance,
        bearing: g.initialBearing,
        elapsed: 0,
        duration,
        easing: options.easing ?? smoother,
        path,
        scale,
        cancelOnInput: options.cancelOnInput ?? true,
        finish: resolve,
        off: () => options.signal?.removeEventListener('abort', abort),
      };
    });
  }
  /** Seconds flown and the flight's duration, or null when not flying. */
  get flightTime(): { elapsed: number; duration: number } | null {
    const f = this.flight;
    return f ? { elapsed: f.elapsed, duration: f.duration } : null;
  }
  /**
   * Fly so a sphere (geodetic centre, radius in metres) fills the view with `padding` room, looking at its centre from
   * `heading` and `pitch`: for framing a model, a site or a tile.
   */
  flyToBoundingSphere(
    centre: { longitude: number; latitude: number; height?: number },
    radius: number,
    options: BoundingSphereFlight = {},
  ): Promise<boolean> {
    this.alive();
    num('Bounding sphere', centre.longitude, centre.latitude, centre.height ?? 0, radius);
    const padding = options.padding ?? 1.1;
    if (!(radius >= 0) || !(padding > 0 && Number.isFinite(padding)))
      throw rangeError('A bounding sphere needs a radius of 0 or more and a padding above 0', 'controls-arguments');
    const e = this.element,
      aspect = e && e.clientWidth > 0 && e.clientHeight > 0 ? e.clientWidth / e.clientHeight : 16 / 9,
      half = ((this.camera.fov ?? 60) * Math.PI) / 180 / 2,
      // The narrower of the vertical and horizontal half angles bounds the sphere.
      fit = Math.min(half, Math.atan(Math.tan(half) * aspect)),
      range = Math.max(this.minRange, (radius * padding) / Math.sin(fit));
    return this.flyTo(
      {
        ...centre,
        height: centre.height ?? 0,
        heading: options.heading ?? this.v.heading,
        pitch: options.pitch ?? this.v.pitch,
        range,
      },
      options,
    );
  }
  /**
   * Fly so a longitude/latitude box (radians, west to east may cross the antimeridian) fits the view, from straight
   * above unless `pitch` says otherwise. `height` is the box's ground height, metres (default 0).
   */
  fitBounds(
    bounds: { west: number; south: number; east: number; north: number; height?: number },
    options: BoundingSphereFlight = {},
  ): Promise<boolean> {
    this.alive();
    const { west, south, north } = bounds,
      height = bounds.height ?? 0;
    num('Bounds', west, south, bounds.east, north, height);
    if (!(south <= north) || Math.abs(south) > Math.PI / 2 || Math.abs(north) > Math.PI / 2)
      throw rangeError('Bounds need south <= north within [-PI/2, PI/2], in radians', 'controls-arguments');
    let east = bounds.east;
    while (east < west) east += 2 * Math.PI;
    const lons = [west, (west + east) / 2, east],
      lats = [south, (south + north) / 2, north],
      points = lons.flatMap((lon) => lats.map((lat) => cartographicToEcef(lon, lat, height))),
      mid = cartographicToEcef(lons[1]!, lats[1]!, height),
      radius = Math.max(...points.map((q) => Math.hypot(q[0] - mid[0], q[1] - mid[1], q[2] - mid[2])));
    return this.flyToBoundingSphere({ longitude: wrap(lons[1]!), latitude: lats[1]!, height }, radius, {
      pitch: Math.PI / 2,
      ...options,
    });
  }
  /**
   * Move through `views` in order on a smooth curve: a centripetal Catmull-Rom spline (Yuksel, Schaefer and Keyser
   * 2011) through the orbit centres in ECEF, with heading, pitch and log range on the same knots, so it passes every
   * view exactly and never overshoots into loops at uneven spacing. It starts from the current view when the first
   * view is not it. Resolves true at the last view, false when cancelled (signal, input, another flight, `setView`).
   */
  followPath(views: readonly GeospatialView[], options: PathOptions = {}): Promise<boolean> {
    this.alive();
    if (!Array.isArray(views) || views.length < 1)
      throw rangeError('followPath needs an array of one or more views; pass [view, ...]', 'controls-arguments');
    const speed = options.speed ?? 0.6;
    if (options.duration !== undefined && (!(options.duration >= 0) || !Number.isFinite(options.duration)))
      throw rangeError(
        'A path duration is finite seconds >= 0; omit it to take one from the length',
        'controls-arguments',
      );
    if (!(speed > 0 && Number.isFinite(speed)))
      throw rangeError('A path speed is finite and above 0; omit it for the default 0.6', 'controls-arguments');
    this.cancel();
    let prev: Required<GeospatialView> = { ...this.v };
    const stops = [prev];
    for (const view of views) stops.push((prev = this.sanitize({ ...prev, ...view } as Required<GeospatialView>)));
    if (options.signal?.aborted) return Promise.resolve(false);
    // Channels: centre ECEF, unwrapped heading, pitch, log range.
    let heading = stops[0]!.heading;
    const rows = stops.map((v, i) => {
      if (i) heading += wrap(v.heading - heading);
      return [...cartographicToEcef(v.longitude, v.latitude, v.height), heading, v.pitch, Math.log(v.range)];
    });
    // Centripetal knots on the centre distance in screen widths (the range sets the scale), so a move at street level
    // and one across a continent are both even.
    const scale = 1 / (2 * Math.tan(((this.camera.fov ?? 60) * Math.PI) / 360)),
      knots = [0];
    let length = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!,
        b = rows[i]!,
        w = Math.exp(Math.min(a[5]!, b[5]!)) / scale,
        d =
          Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!) / w +
          Math.abs(b[5]! - a[5]!) +
          Math.abs(b[3]! - a[3]!) +
          Math.abs(b[4]! - a[4]!);
      length += d;
      knots.push(knots[i - 1]! + Math.sqrt(d) + 1e-9);
    }
    const duration = options.duration ?? this.auto(length > 1e-9 ? Math.max(1, length / speed) : 0),
      n = rows.length,
      end = (i: number) => (i < 0 ? 2 * knots[0]! - knots[1]! : i >= n ? 2 * knots[n - 1]! - knots[n - 2]! : knots[i]!),
      row = (i: number) =>
        i < 0
          ? rows[0]!.map((x, k) => 2 * x - rows[1]![k]!)
          : i >= n
            ? rows[n - 1]!.map((x, k) => 2 * x - rows[n - 2]![k]!)
            : rows[i]!,
      at = (e: number): Required<GeospatialView> => {
        const u = clamp(e, 0, 1) * knots[n - 1]!;
        let i = 0;
        while (i < n - 2 && u > knots[i + 1]!) i++;
        const t0 = end(i - 1),
          t1 = end(i),
          t2 = end(i + 1),
          t3 = end(i + 2),
          [p0, p1, p2, p3] = [row(i - 1), row(i), row(i + 1), row(i + 2)],
          // Barry and Goldman's pyramid for the Catmull-Rom point at u.
          lerp = (a: number[], b: number[], ta: number, tb: number) =>
            a.map((x, k) => (tb - ta > 0 ? ((tb - u) * x + (u - ta) * b[k]!) / (tb - ta) : x)),
          a1 = lerp(p0, p1, t0, t1),
          a2 = lerp(p1, p2, t1, t2),
          a3 = lerp(p2, p3, t2, t3),
          q = lerp(lerp(a1, a2, t0, t2), lerp(a2, a3, t1, t3), t1, t2),
          c = ecefToCartographic(q[0]!, q[1]!, q[2]!);
        return { ...c, heading: q[3]!, pitch: q[4]!, range: Math.exp(q[5]!) };
      };
    if (n < 2 || duration === 0) {
      this.v = stops[n - 1]!;
      this.commit();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const abort = () => this.cancel();
      options.signal?.addEventListener('abort', abort, { once: true });
      this.flight = {
        from: stops[0]!,
        to: stops[n - 1]!,
        distance: 0,
        bearing: 0,
        elapsed: 0,
        duration,
        easing: options.easing ?? smoother,
        path: null,
        scale,
        at: (e) => (e >= 1 ? stops[n - 1]! : at(e)),
        cancelOnInput: options.cancelOnInput ?? true,
        finish: resolve,
        off: () => options.signal?.removeEventListener('abort', abort),
      };
    });
  }
  /** Stop a flight where it is; its promise resolves false. */
  cancel(): void {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    f.off();
    f.finish(false);
  }
  override update(delta = 0): boolean {
    if (!this.flight && !this.dead && this.enabled) {
      this.steer(delta);
      if (!this.dragging) this.coast(delta);
    }
    const f = this.flight;
    if (f && !this.dead) {
      f.elapsed += Math.max(0, delta);
      const t = Math.min(1, f.elapsed / f.duration),
        e = f.easing(t);
      if (!Number.isFinite(e)) {
        this.cancel();
        throw rangeError('A flight easing must return a finite number', 'controls-arguments');
      }
      // On the van Wijk path the eased progress runs the path parameter; without it, pan and log zoom ease together.
      const p = f.path?.at(f.path.S * e),
        u = p ? clamp(p.u, 0, f.distance) : f.distance * e,
        mid = geodesicDirect(f.from.longitude, f.from.latitude, f.bearing, u),
        range = p ? p.w * f.scale : Math.exp(Math.log(f.from.range) * (1 - e) + Math.log(f.to.range) * e);
      const last = t >= 1;
      if (f.at) this.v = this.sanitize(f.at(e));
      else
        this.v = this.sanitize({
          longitude: last ? f.to.longitude : mid.longitude,
          latitude: last ? f.to.latitude : mid.latitude,
          height: f.from.height + (f.to.height - f.from.height) * e,
          heading: f.from.heading + wrap(f.to.heading - f.from.heading) * e,
          pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * e,
          range: last ? f.to.range : range,
        });
      this.commit();
      if (last) {
        this.flight = null;
        f.off();
        f.finish(true);
      }
    }
    const changed = this.changed;
    this.changed = false;
    const g = this.glide;
    if (
      this.moving &&
      !changed &&
      !this.flight &&
      !this.dragging &&
      !this.pinch &&
      !(g.east || g.north || g.heading || g.pitch || g.zoom)
    ) {
      this.moving = false;
      if (this.hash) this.writeHash();
      this.dispatchEvent({ type: 'moveend', view: this.saveView() });
    }
    return changed;
  }
  /** The view as plain JSON, mode included, for {@link GeospatialControls.restoreView}. */
  saveView(): GeospatialViewState {
    return { ...this.v, mode: this.m };
  }
  /**
   * Go back to a saved view (from {@link GeospatialControls.saveView} or {@link GeospatialControls.parseHash}): its mode
   * at once, then a flight there (`duration` 0 jumps). Resolves like {@link GeospatialControls.flyTo}.
   */
  restoreView(state: Partial<GeospatialViewState>, options: FlightOptions = {}): Promise<boolean> {
    this.alive();
    if (state.mode !== undefined && !MODES.includes(state.mode))
      throw rangeError(
        `Geospatial mode is one of ${MODES.join(', ')}; got ${String(state.mode)}`,
        'controls-arguments',
      );
    this.cancel();
    if (state.mode && state.mode !== this.m) {
      this.m = state.mode;
      this.dispatchEvent({ type: 'mode', mode: state.mode });
    }
    const { mode, ...view } = state;
    void mode;
    return this.flyTo({ ...this.v, ...view }, options);
  }
  /** The view as a URL hash, `#geo=lat,lon,height,range,heading,pitch,mode` (degrees to 7 places, metres to 0.01). */
  toHash(): string {
    const v = this.v,
      d = (r: number, n: number) => String(+((r * 180) / Math.PI).toFixed(n)),
      m = (x: number) => String(+x.toFixed(2));
    return `#geo=${d(v.latitude, 7)},${d(v.longitude, 7)},${m(v.height)},${m(v.range)},${d(v.heading, 2)},${d(v.pitch, 2)},${this.m}`;
  }
  /**
   * Read a `#geo=` hash (from {@link GeospatialControls.toHash}; other hash parameters joined with `&` are ignored) as
   * a saved view in radians and metres; null when there is none or it is malformed: a field that is not a finite
   * number, latitude past +-90, longitude or heading past +-360, pitch past +-90 degrees, height outside -1000 km to
   * four equatorial radii, range not above 0 or past ten equatorial radii, or an unknown mode. The controls then clamp
   * range and pitch to their own limits.
   */
  static parseHash(hash: string): GeospatialViewState | null {
    const part = String(hash)
      .replace(/^#/, '')
      .split('&')
      .find((x) => x.startsWith('geo='));
    if (!part) return null;
    const f = part.slice(4).split(','),
      n = f.slice(0, 6).map(Number),
      mode = (f[6] ?? 'globe') as GeospatialMode;
    // Untrusted input (a link): every field finite and in range, else no view at all.
    const [lat, lon, height, range, heading, pitch] = n as [number, number, number, number, number, number];
    if (
      f.length > 7 ||
      n.length < 6 ||
      !n.every(Number.isFinite) ||
      !MODES.includes(mode) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 360 ||
      !(height >= MIN_HEIGHT && height <= MAX_HEIGHT) ||
      !(range > 0 && range <= 10 * WGS84_A) ||
      Math.abs(heading) > 360 ||
      Math.abs(pitch) > 90
    )
      return null;
    const r = (x: number) => (x * Math.PI) / 180;
    return {
      latitude: r(n[0]!),
      longitude: r(n[1]!),
      height: n[2]!,
      range: n[3]!,
      heading: r(n[4]!),
      pitch: r(n[5]!),
      mode,
    };
  }
  /** Write the view into the page's hash without adding a history entry, keeping other `&` parameters. */
  private writeHash(): void {
    const loc = globalThis.location,
      history = globalThis.history;
    if (!loc || !history?.replaceState) return;
    const rest = loc.hash
      .replace(/^#/, '')
      .split('&')
      .filter((x) => x && !x.startsWith('geo='));
    const next = [this.toHash().slice(1), ...rest].join('&');
    history.replaceState(history.state, '', `${loc.pathname}${loc.search}#${next}`);
  }
  /** Eye heights now: above the ellipsoid, the ground below and mean sea level (with a `geoid`). */
  get heights(): GeospatialHeights {
    const e = this.eye,
      g = this.geoid?.(e.longitude, e.latitude);
    return {
      ellipsoid: e.height,
      terrain: e.height - this.groundAt(e.longitude, e.latitude, e.height),
      seaLevel: typeof g === 'number' && Number.isFinite(g) ? e.height - g : null,
    };
  }
  /**
   * The camera's heading (clockwise from north), pitch (below the horizon, positive down) and roll (clockwise seen
   * from behind) in the ENU frame at the eye, radians: what a compass and an attitude indicator show.
   */
  get orientation(): { heading: number; pitch: number; roll: number } {
    const a = this.eyeAngles(),
      { up } = this.eyeFrame(),
      c = ecefToCartographic(a.eye[0], a.eye[1], a.eye[2]),
      b = enuBasis(c.longitude, c.latitude),
      sh = Math.sin(a.heading),
      ch = Math.cos(a.heading),
      sp = Math.sin(a.pitch),
      cp = Math.cos(a.pitch),
      // The level screen-up and screen-right for this heading and pitch; roll is up's turn between them.
      levelUp = [0, 1, 2].map((i) => (b.east[i]! * sh + b.north[i]! * ch) * sp + b.up[i]! * cp),
      right = [0, 1, 2].map((i) => b.east[i]! * ch - b.north[i]! * sh);
    return { heading: a.heading, pitch: a.pitch, roll: Math.atan2(dot3(up, right), dot3(up, levelUp)) };
  }
  /** Turn to face north (heading 0) about the centre, smoothly (`duration` default 0.5 s, 0 under reduced motion). */
  resetNorth(options: FlightOptions = {}): Promise<boolean> {
    this.alive();
    return this.flyTo({ ...this.v, heading: 0 }, { duration: this.auto(0.5), ...options });
  }
  override dispose(): void {
    this.cancel();
    this.dead = true;
    super.dispose();
  }

  protected bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) element.style.touchAction = 'none';
    return [
      [element, 'pointerdown', this.down],
      [element, 'pointermove', this.move],
      [element, 'pointerup', this.end],
      [element, 'pointercancel', this.end],
      [element, 'wheel', this.wheel, { passive: false }],
      [element, 'contextmenu', this.menu],
      [element, 'dblclick', this.double as InputEventListener],
      [this.keyTarget ?? documentOf(element), 'keydown', this.keyDown as InputEventListener],
      [this.keyTarget ?? documentOf(element), 'keyup', this.keyUp as InputEventListener],
    ];
  }
  protected override onDisconnect(): void {
    this.dragging = null;
    this.touches.clear();
    this.pinch = null;
    this.keys.clear();
  }
  private keyDown = (event: KeyboardEvent): void => {
    if (this.enabled && typeof event.code === 'string') this.keys.add(event.code);
  };
  private keyUp = (event: KeyboardEvent): void => {
    this.keys.delete(event.code);
  };
  /** A press or the wheel takes the camera back from a flight that allows it. */
  private interrupt(): void {
    if (this.flight?.cancelOnInput) this.cancel();
  }
  private down = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.interrupt();
    if (event.pointerType === 'touch') {
      this.touches.set(event.pointerId, this.local(event));
      if (this.touches.size === 2) {
        // A second finger turns the one-finger drag into pinch, twist and two-finger tilt.
        if (this.dragging) this.element?.releasePointerCapture?.(this.dragging.id);
        this.dragging = null;
        this.stopGlide();
        this.sample = null;
        this.pinch = this.spread();
        this.element?.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        return;
      }
      if (this.touches.size > 2) return;
    }
    if (this.dragging || event.button > 2) return;
    const first = this.m === 'fly' || this.m === 'walk',
      act = this.action(event, first);
    if (!act) return;
    if (
      (act === 'rotate' && !this.enableRotate) ||
      (act === 'pan' && !this.enablePan) ||
      (act === 'zoom' && !this.enableZoom)
    )
      return;
    const p = this.local(event),
      r = act === 'pan' ? this.screenRay(p.x, p.y) : null,
      hit = r && this.hitAlong(r.o, r.d);
    if (act === 'rotate' && !first) this.pivotOnAxis();
    this.stopGlide();
    this.sample = null;
    this.dragging = { id: event.pointerId, ...p, act, grab: hit?.point ?? null, grabHeight: hit?.height ?? 0 };
    this.element?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    this.dispatchEvent({ type: 'start' });
  };
  /** What a press does under the preset and mode; null leaves it to the page (dcc's left button). */
  private action(event: PointerEvent, first: boolean): 'pan' | 'rotate' | 'zoom' | null {
    if (first) return 'rotate';
    if (this.p === 'dcc') {
      if (event.button !== 1) return null;
      return event.shiftKey ? 'pan' : event.ctrlKey || event.metaKey ? 'zoom' : 'rotate';
    }
    const alt = event.button !== 0 || event.ctrlKey || event.shiftKey || event.metaKey;
    // Local orbit swaps the buttons (left turns about the site).
    return (this.m === 'local' ? !alt : alt) ? 'rotate' : 'pan';
  }
  /** Event time in seconds. */
  private static time(event: Event): number {
    const t = (event as { timeStamp?: number }).timeStamp;
    return (typeof t === 'number' && t > 0 ? t : (globalThis.performance?.now() ?? Date.now())) / 1000;
  }
  /** Midpoint, spread and angle of the first two touches. */
  private spread(): { x: number; y: number; spread: number; angle: number } {
    const [a, b] = [...this.touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      spread: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }
  /** Two fingers: the spread zooms about the midpoint, a twist turns the heading, moving both up or down tilts. */
  private gesture(event: PointerEvent): void {
    const g = this.pinch,
      el = this.element;
    if (!g || !el) return;
    const before = { ...this.v },
      n = this.spread(),
      height = Math.max(1, el.clientHeight);
    this.pinch = n;
    if (this.enableZoom && n.spread !== g.spread) this.zoomAt(n.x, n.y, (g.spread / n.spread) ** this.zoomSpeed);
    if (this.enableRotate) {
      const twist = wrap(n.angle - g.angle),
        tilt = this.m === 'map' ? 0 : ((n.y - g.y) * this.rotateSpeed) / height;
      if (twist || tilt) this.rotate(-twist, tilt);
    }
    this.track(GeospatialControls.time(event), before);
    event.preventDefault();
  }
  private move = (event: PointerEvent): void => {
    if (this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, this.local(event));
      if (this.pinch && this.enabled) return this.gesture(event);
    }
    const d = this.dragging;
    if (!d || d.id !== event.pointerId || !this.enabled || !this.element) return;
    const before = { ...this.v };
    const p = this.local(event),
      dx = p.x - d.x,
      dy = p.y - d.y,
      height = this.element.clientHeight;
    d.x = p.x;
    d.y = p.y;
    if (d.act === 'zoom') this.zoom(2 ** clamp((dy * this.zoomSpeed) / 200, -32, 32));
    else if (d.act === 'rotate' && (this.m === 'fly' || this.m === 'walk')) {
      // Grab the world: a field of view per viewport height, so the point under the cursor stays near it.
      const k = ((this.camera.fov ?? 60) * Math.PI) / 180 / height;
      this.look(-dx * k, -dy * k);
    } else if (d.act === 'rotate')
      this.rotate((dx * this.rotateSpeed) / height, this.m === 'map' ? 0 : (dy * this.rotateSpeed) / height);
    else if (!d.grab || !this.dragTo(d.grab, d.grabHeight, p.x, p.y)) {
      // Sky under the cursor: ground metres per pixel at the centre; a tilted view stretches vertical drags by 1 / sin(pitch).
      const fov = ((this.camera.fov ?? 60) * Math.PI) / 180,
        m = (2 * this.v.range * Math.tan(fov / 2)) / height,
        h = this.v.heading,
        up = (dy * m) / Math.max(0.2, Math.sin(this.v.pitch)),
        right = -dx * m;
      this.pan(right * Math.cos(h) + up * Math.sin(h), -right * Math.sin(h) + up * Math.cos(h));
    }
    this.track(GeospatialControls.time(event), before);
    event.preventDefault();
  };
  private end = (event: PointerEvent): void => {
    if (this.touches.delete(event.pointerId) && this.pinch) {
      // Lifting a finger ends the gesture; a quick release glides on (zoom and turn), a pause stops.
      if (this.touches.size < 2) {
        const s = this.sample;
        if (
          !s ||
          event.type === 'pointercancel' ||
          GeospatialControls.time(event) - s.t > FLING_GAP ||
          this.reducedMotion
        )
          this.stopGlide();
        this.pinch = null;
        this.sample = null;
        this.dispatchEvent({ type: 'end' });
      }
      this.element?.releasePointerCapture?.(event.pointerId);
      return;
    }
    if (this.dragging?.id !== event.pointerId) return;
    // A pause before release is a stop; a cancel never flings.
    const s = this.sample;
    if (!s || event.type === 'pointercancel' || GeospatialControls.time(event) - s.t > FLING_GAP || this.reducedMotion)
      this.stopGlide();
    if (this.m === 'fly' || this.m === 'walk') this.stopGlide();
    this.sample = null;
    this.dragging = null;
    this.element?.releasePointerCapture?.(event.pointerId);
    this.dispatchEvent({ type: 'end' });
  };
  private wheel = (event: WheelEvent): void => {
    if (!this.enabled) return;
    this.interrupt();
    if (!this.enableZoom) return;
    const p = this.local(event),
      px = event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 800 : 1);
    // First person: a 100 px notch moves one second of walking, or a fifth of the height above the ground in fly.
    if (this.m === 'walk') this.moveEye((-px * this.zoomSpeed * this.walkSpeed) / 100, 0);
    else if (this.m === 'fly') this.moveEye((-px * this.zoomSpeed * this.moveSpeed) / 500, 0);
    else this.zoomAt(p.x, p.y, 2 ** clamp((px * this.zoomSpeed) / 500, -32, 32));
    event.preventDefault();
  };
  /** Double click zooms in two times toward the point (Shift: out), except in the dcc preset and first person. */
  private double = (event: MouseEvent): void => {
    if (!this.enabled || !this.enableZoom || this.p === 'dcc' || this.m === 'fly' || this.m === 'walk') return;
    const p = this.local(event as PointerEvent);
    this.zoomAt(p.x, p.y, event.shiftKey ? 2 : 0.5);
    event.preventDefault();
  };
  private menu = (event: Event): void => {
    if (this.enabled && this.enableRotate) event.preventDefault();
  };
}
