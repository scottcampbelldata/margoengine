// Geospatial camera: heading / pitch / range orbit about a geodetic point on the WGS84 globe, with surface-true cursor
// zoom, anchored pan and pivot, flights and a terrain-clearance floor. The geodesy is @margoengine/math/geo (NIMA
// TR8350.2, Karney 2013); surface picks use the bvh Raycaster, your own ray query or a march over `heightAt`.
import type { Camera, EngineKernel, Mesh } from '@margoengine/core';
import { Raycaster, type ModelLike } from '@margoengine/bvh';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
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
}

/** Options for {@link GeospatialControls.flyTo}. */
export interface FlightOptions {
  /** Seconds. Default 3; 0 applies at once. */
  duration?: number;
  /** Progress to eased progress, both in [0, 1]. Default smootherstep. */
  easing?: (t: number) => number;
  /** Cancels the flight where it is; an already aborted signal does nothing. */
  signal?: AbortSignal;
  /** Raise the range mid-flight so the path is an arc over long hops. Default true. */
  arc?: boolean;
}

interface Flight {
  from: Required<GeospatialView>;
  to: Required<GeospatialView>;
  distance: number;
  bearing: number;
  elapsed: number;
  duration: number;
  easing: (t: number) => number;
  arc: boolean;
  finish: (done: boolean) => void;
  off: () => void;
}

type V = [number, number, number];
type Pose = { position: V; target: V; up: V };

/** Steps of the `heightAt` ray march before a pick gives up (the ellipsoid then stands in). */
const MARCH_STEPS = 512;
const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const num = (what: string, ...v: number[]) => {
  if (!v.every(Number.isFinite)) throw rangeError(`${what} needs finite numbers (radians and metres)`, 'controls-arguments');
};
const dot3 = (a: readonly number[], b: readonly number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const along = (o: readonly number[], d: readonly number[], t: number): V => [o[0]! + d[0]! * t, o[1]! + d[1]! * t, o[2]! + d[2]! * t];

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
  private v: Required<GeospatialView>;
  private lifted = 0;
  private reachRange = 0;
  private flight: Flight | null = null;
  private dragging: { id: number; x: number; y: number; rotate: boolean; grab: V | null; grabHeight: number } | null = null;
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
      clearance = options.clearance ?? 2;
    if (!(minPitch >= 0 && maxPitch <= Math.PI / 2 && minPitch <= maxPitch) || !(minRange > 0 && maxRange >= minRange) || !(clearance >= 0) || !Number.isFinite(clearance))
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
    this.v = this.sanitize({ ...{ height: 0, heading: 0, pitch: Math.PI / 2, range: 2e7 }, longitude: 0, latitude: 0, ...options.view } as Required<GeospatialView>);
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
      throw rangeError('Geospatial latitude is in radians within [-PI/2, PI/2]; convert degrees with degToRad', 'controls-arguments');
    return {
      longitude: wrap(v.longitude),
      latitude: clamp(v.latitude, -Math.PI / 2, Math.PI / 2),
      height: v.height,
      heading: wrap(v.heading),
      pitch: clamp(v.pitch, this.minPitch, this.maxPitch),
      range: clamp(v.range, this.minRange, this.maxRange),
    };
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
  private floor(longitude: number, latitude: number): number {
    const h = this.heightAt?.(longitude, latitude);
    return (typeof h === 'number' && Number.isFinite(h) ? h : 0) + this.clearance;
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
      for (const sy of [-1, 1]) out.push([0, 1, 2].map((i) => e[i]! + fw[i]! * near + r[i]! * sx * w + u[i]! * sy * h) as V);
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
      k = this.clearance,
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
    this.dispatchEvent({ type: 'change' });
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
    if (!(factor > 0) || !Number.isFinite(factor)) throw rangeError('Geospatial zoom needs a positive finite factor', 'controls-arguments');
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
  private castSurface(o: V, d: V, far: number, terrain = true, refresh = true): { t: number; source: GeospatialPickSource } | null {
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
        [hit] = this.colliders ? r.intersectObjects(this.engine, this.colliders, options) : r.intersectEngine(this.engine, options);
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
    return { ...ecefToCartographic(point[0], point[1], point[2]), height: this.v.height, distance: t, source: 'ellipsoid', point };
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
    return { longitude: hit.longitude, latitude: hit.latitude, height: hit.height, distance: hit.distance, source: hit.source };
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
    this.cancel();
    this.v = this.sanitize({
      ...c,
      heading: Math.hypot(he, hn) > 1e-12 ? Math.atan2(he, hn) : this.v.heading,
      pitch: Math.asin(clamp(sp, -1, 1)),
      range,
    });
    this.commit();
  }
  /** Zoom by `factor` keeping the surface point under CSS pixel (x, y) under the cursor (sky: about the centre). */
  zoomAt(x: number, y: number, factor: number): void {
    this.alive();
    if (!(factor > 0) || !Number.isFinite(factor)) throw rangeError('Geospatial zoom needs a positive finite factor', 'controls-arguments');
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
   * Fly to a view along the shortest geodesic, easing height, heading and range, with a range arc over long hops.
   * Resolves true on arrival, false when cancelled (signal, another flight, setView, dispose). Advance it with
   * `update(delta)` (done for you when attached to an engine).
   */
  flyTo(destination: GeospatialView, options: FlightOptions = {}): Promise<boolean> {
    this.alive();
    const duration = options.duration ?? 3;
    if (!(duration >= 0) || !Number.isFinite(duration)) throw rangeError('Flight duration is finite seconds >= 0', 'controls-arguments');
    this.cancel();
    const to = this.sanitize({ ...this.v, height: 0, ...destination } as Required<GeospatialView>);
    if (options.signal?.aborted) return Promise.resolve(false);
    if (duration === 0) {
      this.v = to;
      this.commit();
      return Promise.resolve(true);
    }
    const g = geodesicInverse(this.v.longitude, this.v.latitude, to.longitude, to.latitude);
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
        arc: options.arc ?? true,
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
    const f = this.flight;
    if (f && !this.dead) {
      f.elapsed += Math.max(0, delta);
      const t = Math.min(1, f.elapsed / f.duration),
        e = f.easing(t);
      if (!Number.isFinite(e)) {
        this.cancel();
        throw rangeError('A flight easing must return a finite number', 'controls-arguments');
      }
      const mid = geodesicDirect(f.from.longitude, f.from.latitude, f.bearing, f.distance * e),
        lr = Math.log(f.from.range) * (1 - e) + Math.log(f.to.range) * e,
        hop = f.arc ? Math.sin(Math.PI * e) * f.distance * 0.5 : 0;
      const last = t >= 1;
      this.v = this.sanitize({
        longitude: last ? f.to.longitude : mid.longitude,
        latitude: last ? f.to.latitude : mid.latitude,
        height: f.from.height + (f.to.height - f.from.height) * e,
        heading: f.from.heading + wrap(f.to.heading - f.from.heading) * e,
        pitch: f.from.pitch + (f.to.pitch - f.from.pitch) * e,
        range: Math.exp(lr) + hop,
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
    return changed;
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
    ];
  }
  protected override onDisconnect(): void {
    this.dragging = null;
  }
  private down = (event: PointerEvent): void => {
    if (!this.enabled || this.dragging || event.button > 2) return;
    const rotate = event.button !== 0 || event.ctrlKey || event.shiftKey || event.metaKey;
    if ((rotate && !this.enableRotate) || (!rotate && !this.enablePan)) return;
    const p = this.local(event),
      r = rotate ? null : this.screenRay(p.x, p.y),
      hit = r && this.hitAlong(r.o, r.d);
    if (rotate) this.pivotOnAxis();
    this.dragging = { id: event.pointerId, ...p, rotate, grab: hit?.point ?? null, grabHeight: hit?.height ?? 0 };
    this.element?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    this.dispatchEvent({ type: 'start' });
  };
  private move = (event: PointerEvent): void => {
    const d = this.dragging;
    if (!d || d.id !== event.pointerId || !this.enabled || !this.element) return;
    const p = this.local(event),
      dx = p.x - d.x,
      dy = p.y - d.y,
      height = this.element.clientHeight;
    d.x = p.x;
    d.y = p.y;
    if (d.rotate) this.rotate((dx * this.rotateSpeed) / height, (dy * this.rotateSpeed) / height);
    else if (!d.grab || !this.dragTo(d.grab, d.grabHeight, p.x, p.y)) {
      // Sky under the cursor: ground metres per pixel at the centre; a tilted view stretches vertical drags by 1 / sin(pitch).
      const fov = ((this.camera.fov ?? 60) * Math.PI) / 180,
        m = (2 * this.v.range * Math.tan(fov / 2)) / height,
        h = this.v.heading,
        up = (dy * m) / Math.max(0.2, Math.sin(this.v.pitch)),
        right = -dx * m;
      this.pan(right * Math.cos(h) + up * Math.sin(h), -right * Math.sin(h) + up * Math.cos(h));
    }
    event.preventDefault();
  };
  private end = (event: PointerEvent): void => {
    if (this.dragging?.id !== event.pointerId) return;
    this.dragging = null;
    this.element?.releasePointerCapture?.(event.pointerId);
    this.dispatchEvent({ type: 'end' });
  };
  private wheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.enableZoom) return;
    const p = this.local(event),
      px = event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 800 : 1);
    this.zoomAt(p.x, p.y, 2 ** clamp((px * this.zoomSpeed) / 500, -32, 32));
    event.preventDefault();
  };
  private menu = (event: Event): void => {
    if (this.enabled && this.enableRotate) event.preventDefault();
  };
}
