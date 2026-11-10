import type { Camera, EngineKernel } from '@margoengine/core';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { madd, rotateAxis, type V3 } from './math.js';
import { rollFrame, ray } from './view.js';
import { MargoError } from '@margoengine/math/errors';

/** Structural interface of cameras/origin's FloatingOrigin; no camera package is loaded. */
export interface GlobeOrigin {
  /** Convert global coordinates to the engine's current local frame. */
  toLocal(world: ArrayLike<number>): readonly [number, number, number];
  /** Subscribe to local-frame shifts; returns an unsubscribe function. */
  onRebase(
    listener: (shift: readonly [number, number, number], origin: readonly [number, number, number]) => void,
  ): () => void;
}
/** Axis-aligned reference ellipsoid in the same world units as the camera. */
export interface GlobeOptions {
  /** Equatorial X, polar Y, equatorial Z radii. Default WGS84 metres [6378137, 6356752.314245, 6378137]. */
  radii?: readonly [number, number, number];
  /** World centre. Default [0, 0, 0]. */
  centre?: readonly [number, number, number];
  /** Minimum radial altitude, measured along the centre-to-eye ray. Default 1 world unit. */
  minAltitude?: number;
  /** Maximum radial altitude. Default Infinity. */
  maxAltitude?: number;
  /** Maximum eye angle from the outward surface normal in radians. Default 89 degrees. */
  maxTilt?: number;
  /** Adapt near/far to radial altitude and the ellipsoid horizon. Default true; false leaves clipping to the app. */
  clipPlanes?: boolean;
  /** Floating origin for street-level precision. With it, centre is global and pick/grab points are local. Default none. */
  origin?: GlobeOrigin;
}
type Point = { x: number; y: number; tilt: boolean };
const finite = (v: readonly number[]): V3 => {
  if (v.length !== 3 || !v.every(Number.isFinite)) throw new RangeError('Globe coordinates need three finite numbers');
  return [...v] as V3;
};

/** Grab an ellipsoid, wheel/pinch toward a surface hit, and tilt about it at any altitude. */
export class GlobeControls extends Controls {
  /** Enable left-drag and one-touch surface grabbing. Default true. */
  enablePan = true;
  /** Enable wheel and two-touch zoom toward the cursor. Default true. */
  enableZoom = true;
  /** Enable right/middle/modified-left drag and two-touch tilt. Default true. */
  enableTilt = true;
  /** Wheel multiplier; 500 CSS pixels doubles the eye-to-hit distance. Default 1. */
  zoomSpeed = 1;
  /** Drag rotation multiplier in radians per viewport height. Default PI. */
  rotateSpeed = Math.PI;
  /** Reference radii, copied at construction; Y is the polar axis. */
  readonly radii: readonly [number, number, number];
  /** Reference world centre, copied at construction. */
  get centre(): readonly [number, number, number] {
    return this.origin?.toLocal(this.referenceCentre) ?? this.referenceCentre;
  }
  private readonly referenceCentre: readonly [number, number, number];
  private readonly origin?: GlobeOrigin;
  private unsubscribe: (() => void) | null = null;
  /** Radial altitude lower limit, copied from options. */
  readonly minAltitude: number;
  /** Radial altitude upper limit, copied from options. */
  readonly maxAltitude: number;
  /** Tilt upper limit in radians, copied from options. */
  readonly maxTilt: number;
  /** Update near/far from altitude when moving. Default true. */
  clipPlanes: boolean;
  private pointers = new Map<number, Point>();
  private touchAction = '';
  private anchor: V3 | null = null;
  private changed = false;
  private dead = false;
  protected override get kind(): string {
    return 'globe';
  }
  constructor(source: Camera | EngineKernel, element?: ControlElement | null, options: GlobeOptions = {}) {
    const radii = Object.freeze(finite(options.radii ?? [6378137, 6356752.314245, 6378137])),
      centre = Object.freeze(finite(options.centre ?? [0, 0, 0])),
      minAltitude = options.minAltitude ?? 1,
      maxAltitude = options.maxAltitude ?? Infinity,
      maxTilt = options.maxTilt ?? (89 * Math.PI) / 180;
    if (
      radii.some((v) => !(v > 0)) ||
      !(minAltitude > 0) ||
      !Number.isFinite(minAltitude) ||
      !(maxAltitude >= minAltitude) ||
      !(maxTilt > 0 && maxTilt < Math.PI / 2)
    ) {
      throw new RangeError(
        'Use positive ellipsoid radii and minimum altitude, maxAltitude >= minAltitude and maxTilt in (0, PI/2)',
      );
    }
    super(source, element);
    this.radii = radii;
    this.referenceCentre = centre;
    this.origin = options.origin;
    this.minAltitude = minAltitude;
    this.maxAltitude = maxAltitude;
    this.maxTilt = maxTilt;
    this.clipPlanes = options.clipPlanes ?? true;
    this.unsubscribe =
      this.origin?.onRebase((shift) => {
        if (this.anchor) this.anchor = sub(this.anchor, shift);
      }) ?? null;
    this.init();
  }
  override dispose(): void {
    this.dead = true;
    this.changed = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    super.dispose();
  }
  private alive(): void {
    if (this.dead) throw new MargoError('disposed', 'Globe controls are disposed; create new GlobeControls');
  }
  /** Current radial distance above the ellipsoid, in world units. */
  get altitude(): number {
    const p = sub(this.camera.position, this.centre),
      length = Math.hypot(...p);
    return length ? length - length / Math.hypot(...p.map((v, i) => v / this.radii[i])) : -Math.min(...this.radii);
  }
  /** Outward geodetic unit normal of a world surface point. */
  normal(point: readonly [number, number, number]): V3 {
    const p = sub(finite(point), this.centre);
    if (!Math.hypot(...p)) throw new RangeError('A surface normal needs a point different from the ellipsoid centre');
    return normalize(p.map((v, i) => v / this.radii[i] ** 2));
  }
  /** Nearest forward ellipsoid hit at element CSS pixels; null on sky. */
  pick(x: number, y: number): V3 | null {
    if (![x, y].every(Number.isFinite)) throw new RangeError('Globe pick needs finite CSS coordinates');
    const e = this.element;
    if (!e || !(e.clientWidth > 0 && e.clientHeight > 0)) return null;
    const r = ray(rollFrame(this.camera), x, y, e.clientWidth, e.clientHeight);
    const o = sub(r.origin, this.centre).map((v, i) => v / this.radii[i]),
      d = r.direction.map((v, i) => v / this.radii[i]);
    const a = dot(d, d),
      b = dot(o, d),
      c = dot(o, o) - 1,
      discriminant = b * b - a * c;
    if (discriminant < 0) return null;
    const q = -b - (b < 0 ? -1 : 1) * Math.sqrt(discriminant);
    const roots = q ? [q / a, c / q] : [-b / a];
    const t = Math.min(...roots.filter((v) => v >= 0));
    return Number.isFinite(t) ? madd(r.origin, r.direction, t) : null;
  }
  private commit(position: V3, target: V3, up: V3): void {
    // Preserve the complete camera frame when applying altitude correction.
    const p = sub(position, this.centre),
      length = Math.hypot(...p);
    if (!length) return;
    const radius = length / Math.hypot(...p.map((v, i) => v / this.radii[i]));
    const altitude = Math.max(this.minAltitude, Math.min(this.maxAltitude, length - radius));
    const corrected = madd(this.centre, p, (radius + altitude) / length),
      shift = sub(corrected, position);
    this.camera.position = corrected;
    this.camera.target = madd(target, shift, 1);
    this.camera.up = normalize(up);
    if (this.clipPlanes) {
      this.camera.near = altitude * 0.01;
      this.camera.far = Math.max(
        this.camera.near * 2,
        2 * Math.sqrt(altitude * (altitude + 2 * Math.max(...this.radii))) + altitude,
      );
    }
    this.changed = true;
    this.dispatchEvent({ type: 'change' });
  }
  /** Drag a previously picked surface point to CSS pixel (x,y); returns false when either ray misses. */
  grab(point: readonly [number, number, number], x: number, y: number): boolean {
    this.alive();
    const anchor = finite(point),
      hit = this.pick(x, y);
    if (!hit) return false;
    const a = this.normal(hit),
      b = this.normal(anchor),
      axis = cross(a, b),
      s = Math.hypot(...axis);
    let angle = Math.atan2(s, dot(a, b));
    if (s) for (let i = 0; i < 3; i++) axis[i] /= s;
    else if (dot(a, b) < 0) {
      axis.splice(0, 3, ...normalize(cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])));
      angle = Math.PI;
    } else return false;
    const rotate = (v: readonly number[]): V3 => rotateAxis(v, axis, angle);
    this.commit(
      madd(anchor, rotate(sub(this.camera.position, hit)), 1),
      madd(anchor, rotate(sub(this.camera.target, hit)), 1),
      rotate(this.camera.up),
    );
    return true;
  }
  /** Orbit about a picked point: yaw and tilt deltas in radians, clamped above its local horizon. */
  tilt(point: readonly [number, number, number], yaw: number, pitch: number): void {
    this.alive();
    const anchor = finite(point);
    if (![yaw, pitch].every(Number.isFinite)) throw new RangeError('Globe tilt needs finite angular deltas');
    const normal = this.normal(anchor),
      eye = sub(this.camera.position, anchor);
    if (!(Math.hypot(...eye) > 0)) return;
    const tilted = rotateAxis(eye, normal, yaw),
      target = rotateAxis(sub(this.camera.target, anchor), normal, yaw),
      up = rotateAxis(this.camera.up, normal, yaw);
    const right = normalize(cross(sub(target, tilted), up));
    const current = Math.acos(Math.max(-1, Math.min(1, dot(normalize(tilted), normal))));
    // A positive rotation around screen right reduces the angle from the normal.
    const amount = current - Math.max(0, Math.min(this.maxTilt, current + pitch));
    this.commit(
      madd(anchor, rotateAxis(tilted, right, amount), 1),
      madd(anchor, rotateAxis(target, right, amount), 1),
      rotateAxis(up, right, amount),
    );
  }
  /** Zoom toward an ellipsoid hit. Positive pixels zoom out; sky uses the view centre. */
  zoomAt(x: number, y: number, pixels: number): void {
    this.alive();
    if (![x, y, pixels, this.zoomSpeed].every(Number.isFinite))
      throw new RangeError('Globe zoom needs finite coordinates, delta and speed');
    const anchor = this.pick(x, y) ?? this.camera.target;
    const factor = 2 ** Math.max(-32, Math.min(32, (pixels * this.zoomSpeed) / 500));
    this.commit(
      madd(anchor, sub(this.camera.position, anchor), factor),
      madd(anchor, sub(this.camera.target, anchor), factor),
      [...this.camera.up] as V3,
    );
  }
  override update(): boolean {
    const changed = this.changed;
    this.changed = false;
    return changed;
  }
  protected bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    this.touchAction = element.style?.touchAction ?? '';
    if (element.style) element.style.touchAction = 'none';
    return [
      [element, 'pointerdown', this.down],
      [element, 'pointermove', this.move],
      [element, 'pointerup', this.end],
      [element, 'pointercancel', this.end],
      [element, 'lostpointercapture', this.end],
      [element, 'wheel', this.wheel, { passive: false }],
      [element, 'contextmenu', this.menu],
    ];
  }
  protected override onDisconnect(): void {
    for (const id of this.pointers.keys()) this.release(id);
    this.pointers.clear();
    this.anchor = null;
    if (this.element?.style) this.element.style.touchAction = this.touchAction;
  }
  private down = (event: PointerEvent): void => {
    if (!this.enabled || this.pointers.has(event.pointerId) || this.pointers.size >= 2) return;
    const tilt = event.button === 1 || event.button === 2 || event.ctrlKey || event.shiftKey || event.metaKey;
    if ((tilt && !this.enableTilt) || (!tilt && !this.enablePan) || event.button > 2) return;
    const p = this.local(event);
    this.pointers.set(event.pointerId, { ...p, tilt });
    this.capture(event.pointerId);
    this.anchor = this.pick(p.x, p.y);
    event.preventDefault();
    if (this.pointers.size === 1) this.dispatchEvent({ type: 'start' });
  };
  private move = (event: PointerEvent): void => {
    const previous = this.pointers.get(event.pointerId);
    if (!previous || !this.enabled) return;
    const p = this.local(event),
      points = [...this.pointers.values()],
      width = this.element!.clientWidth,
      height = this.element!.clientHeight;
    if (points.length === 2) {
      const other = this.pointers.get([...this.pointers.keys()].find((id) => id !== event.pointerId)!)!;
      const before = Math.hypot(previous.x - other.x, previous.y - other.y),
        after = Math.hypot(p.x - other.x, p.y - other.y);
      if (this.enableZoom && before > 0 && after > 0)
        this.zoomAt((p.x + other.x) / 2, (p.y + other.y) / 2, 500 * Math.log2(before / after));
      const hit = this.pick((p.x + other.x) / 2, (p.y + other.y) / 2);
      if (hit && this.enableTilt) this.tilt(hit, 0, ((p.y - previous.y) * this.rotateSpeed) / height);
      this.anchor = hit;
    } else if (previous.tilt && this.enableTilt) {
      const anchor = this.anchor ?? this.pick(width / 2, height / 2);
      if (anchor)
        this.tilt(
          anchor,
          (-(p.x - previous.x) * this.rotateSpeed) / height,
          ((p.y - previous.y) * this.rotateSpeed) / height,
        );
    } else if (this.enablePan && this.anchor) this.grab(this.anchor, p.x, p.y);
    this.pointers.set(event.pointerId, { ...p, tilt: previous.tilt });
    event.preventDefault();
  };
  private end = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    this.release(event.pointerId);
    const p = [...this.pointers.values()][0];
    this.anchor = p ? this.pick(p.x, p.y) : null;
    if (!p) this.dispatchEvent({ type: 'end' });
  };
  private wheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.enableZoom) return;
    const p = this.local(event);
    this.dispatchEvent({ type: 'start' });
    this.zoomAt(p.x, p.y, event.deltaY * (event.deltaMode === 1 ? 100 / 3 : event.deltaMode === 2 ? 800 : 1));
    event.preventDefault();
    this.dispatchEvent({ type: 'end' });
  };
  private menu = (event: Event): void => {
    if (this.enabled && this.enableTilt) event.preventDefault();
  };
}
