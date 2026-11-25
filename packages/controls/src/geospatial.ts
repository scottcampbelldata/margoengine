// Geospatial camera: heading / pitch / range orbit about a geodetic point on the WGS84 globe, with cursor zoom, flights
// and a terrain-clearance floor. The geodesy is @margoengine/math/geo (NIMA TR8350.2, Karney 2013).
import type { Camera, EngineKernel } from '@margoengine/core';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { MargoError } from '@margoengine/math/errors';
import {
  WGS84_A,
  WGS84_B,
  cartographicToEcef,
  ecefToCartographic,
  geodesicDirect,
  geodesicInverse,
  orbitPose,
} from '@margoengine/math/geo';
import { rollFrame, ray } from './view.js';
import { rangeError } from '../../shared/errors.js';

/** Terrain height above the WGS84 ellipsoid, metres, at longitude and latitude in RADIANS; undefined or NaN when unknown. */
export type HeightQuery = (longitude: number, latitude: number) => number | undefined;

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

const smoother = (t: number) => t * t * t * (t * (6 * t - 15) + 10);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const wrap = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
const num = (what: string, ...v: number[]) => {
  if (!v.every(Number.isFinite)) throw rangeError(`${what} needs finite numbers (radians and metres)`, 'controls-arguments');
};

/**
 * Orbit, pan, zoom and fly about the WGS84 globe. Drag pans over the surface, right/modified drag changes heading and
 * pitch, the wheel zooms toward the cursor. The eye never goes below `clearance` metres above the terrain `heightAt`
 * reports (a hill under the eye lifts the view; it settles back when the hill is gone).
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
  private v: Required<GeospatialView>;
  private lifted = 0;
  private flight: Flight | null = null;
  private dragging: { id: number; x: number; y: number; rotate: boolean } | null = null;
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
  private toWorld(p: readonly number[]): [number, number, number] {
    return this.zUp ? [p[0]!, p[1]!, p[2]!] : [p[0]!, p[2]!, -p[1]!];
  }
  private toEcef(p: readonly number[]): [number, number, number] {
    return this.zUp ? [p[0]!, p[1]!, p[2]!] : [p[0]!, -p[2]!, p[1]!];
  }
  private floor(longitude: number, latitude: number): number {
    const h = this.heightAt?.(longitude, latitude);
    return (typeof h === 'number' && Number.isFinite(h) ? h : 0) + this.clearance;
  }
  /** Write the camera from the view, lifting the centre until the eye clears the terrain below it. */
  private commit(): void {
    const v = this.v;
    let lift = 0;
    let pose = orbitPose(v, v.heading, v.pitch, v.range);
    for (let i = 0; i < 6; i++) {
      const e = ecefToCartographic(pose.position[0], pose.position[1], pose.position[2]),
        deficit = this.floor(e.longitude, e.latitude) - e.height;
      if (deficit <= 1e-6) break;
      lift += deficit;
      pose = orbitPose({ ...v, height: v.height + lift }, v.heading, v.pitch, v.range);
    }
    // The ground can fall away as the lift grows; a lift is only the terrain's demand at the final eye.
    this.lifted = lift;
    this.camera.position = this.toWorld(pose.position);
    this.camera.target = this.toWorld(pose.target);
    this.camera.up = this.toWorld(pose.up);
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
  /** Nearest hit of the screen ray with the ellipsoid raised to the centre height, as geodetic; null on sky. */
  pick(x: number, y: number): { longitude: number; latitude: number; height: number } | null {
    num('Geospatial pick', x, y);
    const e = this.element;
    if (!e || !(e.clientWidth > 0 && e.clientHeight > 0)) return null;
    const r = ray(rollFrame(this.camera), x, y, e.clientWidth, e.clientHeight),
      o = this.toEcef(r.origin),
      d = this.toEcef(r.direction),
      h = this.v.height,
      ax = WGS84_A + h,
      by = WGS84_B + h,
      s = [1 / ax, 1 / ax, 1 / by],
      po = o.map((c, i) => c * s[i]!),
      pd = d.map((c, i) => c * s[i]!),
      a = pd[0]! ** 2 + pd[1]! ** 2 + pd[2]! ** 2,
      b = po[0]! * pd[0]! + po[1]! * pd[1]! + po[2]! * pd[2]!,
      c = po[0]! ** 2 + po[1]! ** 2 + po[2]! ** 2 - 1,
      disc = b * b - a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / a;
    if (!(t >= 0)) return null;
    const hit = ecefToCartographic(o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t);
    return { ...hit, height: h };
  }
  /** Zoom by `factor` keeping the surface point under CSS pixel (x, y) in place (sky: about the centre). */
  zoomAt(x: number, y: number, factor: number): void {
    this.alive();
    if (!(factor > 0) || !Number.isFinite(factor)) throw rangeError('Geospatial zoom needs a positive finite factor', 'controls-arguments');
    const hit = this.pick(x, y);
    const range = clamp(this.v.range * factor, this.minRange, this.maxRange);
    if (!hit) return this.setView({ range });
    const k = 1 - range / this.v.range,
      c = cartographicToEcef(this.v.longitude, this.v.latitude, this.v.height),
      t = cartographicToEcef(hit.longitude, hit.latitude, hit.height),
      m = ecefToCartographic(c[0] + (t[0] - c[0]) * k, c[1] + (t[1] - c[1]) * k, c[2] + (t[2] - c[2]) * k);
    this.setView({ longitude: m.longitude, latitude: m.latitude, height: this.v.height, range });
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
    const p = this.local(event);
    this.dragging = { id: event.pointerId, ...p, rotate };
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
    else {
      // Ground metres per pixel at the centre; a tilted view stretches the vertical drag by 1 / sin(pitch).
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
