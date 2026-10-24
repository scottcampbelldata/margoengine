import type { Camera, EngineKernel } from '@margoengine/core';
import { Controls, type ControlElement, type EventTargetLike, type InputEventListener } from './controls.js';
import { EPS, madd, rotateAxis, type V3 } from './math.js';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { basis, intersectPlane, ray, type Basis } from './view.js';
export { Controls };

// ---- tuning (internal) ----
/** Pixels of wheel or vertical dolly drag that double (or halve) the distance at zoomSpeed 1, as in OrbitControls. */
const PIXELS_PER_DOUBLING = 500;
const LINE_PIXELS = 100 / 3;
const PAGE_PIXELS = 800;

/** `MOUSE` values (kept local so this entry does not load the orbit module). */
const ROTATE = 0,
  DOLLY = 1,
  PAN = 2;
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Point on the arcball for a centred screen point `(x, y)` (x right, y up) in units of the ball radius: the front
 * hemisphere of the unit sphere inside `r = 1/sqrt(2)`, and beyond it the hyperbolic sheet `z = 1 / (2 r)`, which meets
 * the sphere there with the same height, so dragging off the ball keeps turning it smoothly (Shoemake, "ARCBALL",
 * Graphics Interface 1992; Bell's virtual trackball sheet). The returned vector is not normalized.
 */
export function arcballPoint(x: number, y: number): V3 {
  const r2 = x * x + y * y;
  return [x, y, r2 <= 0.5 ? Math.sqrt(1 - r2) : 0.5 / Math.sqrt(r2)];
}

/** A projection whose orthographic size the arcball zooms: an @margoengine/cameras `CameraProjection`. */
export interface ArcballProjection {
  /** Divides the orthographic frustum; larger shows less. */
  zoom: number;
}

/** Options of `ArcballControls`. */
export interface ArcballControlsOptions {
  /**
   * The projection zoomed under a fixed-size orthographic camera (`camera.fixedOrthographic`). Default: the engine's
   * `cameras` plugin when there is one, else null (a fixed orthographic camera then dollies without changing size).
   */
  projection?: ArcballProjection | null;
}

type ArcballState = ArcballControls['state'];
interface Tracked {
  x: number;
  y: number;
  touch: boolean;
}

/**
 * Free rotation of the camera around `camera.target` with Shoemake's arcball: the pointer's start and current points
 * are lifted onto a virtual ball (`arcballPoint`) and the view turns by the rotation between them, about any axis, so
 * the camera can roll and pass over the poles (it drives `camera.up`). Left drag rotates, right drag (or Shift, Ctrl or
 * Meta + left) pans with the grabbed point kept under the pointer, middle drag and the wheel zoom toward the cursor.
 * One finger rotates, two fingers pinch to zoom and move to pan. Perspective and orthographic cameras
 * (@margoengine/cameras); a fixed-size orthographic camera zooms by `projection.zoom`. With `enableDamping`, motion
 * eases out after release (a fling keeps spinning and decays). Events: `start`, `change`, `end`.
 */
export class ArcballControls extends Controls {
  /** Drag rotation. Default true. */
  enableRotate = true;
  /** Wheel, middle-drag and pinch zoom. Default true. */
  enableZoom = true;
  /** Panning. Default true. */
  enablePan = true;
  /** Rotation multiplier: 1 turns the view by the angle between the two ball points. Default 1. */
  rotateSpeed = 1;
  /** Zoom speed multiplier. Default 1. */
  zoomSpeed = 1;
  /** Pan multiplier: 1 keeps the grabbed point under the pointer. Default 1. */
  panSpeed = 1;
  /** Ease motion out over several frames after input; rotation keeps spinning after a fling. Default false. */
  enableDamping = false;
  /** Fraction of the remaining motion applied per 1/60 s, frame-rate independent. Default 0.05. */
  dampingFactor = 0.05;
  /** Zoom toward the point under the cursor (it keeps its pixel) instead of the view centre. Default true. */
  zoomToCursor = true;
  /** Closest allowed distance to the target. Default 0. */
  minDistance = 0;
  /** Farthest allowed distance to the target. Default Infinity. */
  maxDistance = Infinity;
  /** Smallest `projection.zoom` under a fixed-size orthographic camera. Default 0. */
  minZoom = 0;
  /** Largest `projection.zoom` under a fixed-size orthographic camera. Default Infinity. */
  maxZoom = Infinity;
  /** Action of each mouse button (a `MOUSE` value or null). Shift, Ctrl or Meta swaps rotate and pan. */
  mouseButtons: { LEFT: number | null; MIDDLE: number | null; RIGHT: number | null } = {
    LEFT: ROTATE,
    MIDDLE: DOLLY,
    RIGHT: PAN,
  };
  /** The active gesture. */
  state: 'none' | 'rotate' | 'pan' | 'dolly' | 'touch-rotate' | 'touch-dolly-pan' = 'none';

  private readonly projectionOption: ArcballProjection | null | undefined;
  // Pending motion, consumed by update(): a camera turn about a world axis through the target, a world shift of
  // camera and target, and a log distance scale about `cursor` (CSS px) or the view centre.
  private spinAxis: V3 = [0, 1, 0];
  private spinAngle = 0;
  private readonly shift: V3 = [0, 0, 0];
  private logScale = 0;
  private cursor: { x: number; y: number } | null = null;
  private readonly tracked = new Map<number, Tracked>();
  private last = { x: 0, y: 0, spread: 0 };
  private savedTouchAction: string | null = null;
  private saved!: { position: V3; target: V3; up: V3; fov: number; zoom: number | null };

  constructor(source: Camera | EngineKernel, element?: ControlElement | null, options: ArcballControlsOptions = {}) {
    super(source, element);
    const projection = options.projection;
    if (projection != null && typeof projection.zoom !== 'number')
      throw new TypeError('ArcballControls projection has no numeric zoom; pass a CameraProjection or null');
    this.projectionOption = projection;
    this.saveState();
    this.init();
  }
  protected override get kind(): string {
    return 'arcball';
  }
  protected override bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) {
      this.savedTouchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    return [
      [element, 'pointerdown', this.onDown as InputEventListener],
      [element, 'pointermove', this.onMove as InputEventListener],
      [element, 'pointerup', this.onUp as InputEventListener],
      [element, 'pointercancel', this.onUp as InputEventListener],
      [element, 'wheel', this.onWheel as InputEventListener, { passive: false }],
      [element, 'contextmenu', this.onMenu],
    ];
  }
  protected override onDisconnect(): void {
    this.releaseAll();
    this.state = 'none';
    const element = this.element;
    if (element?.style && this.savedTouchAction !== null) element.style.touchAction = this.savedTouchAction;
    this.savedTouchAction = null;
  }

  /** The projection zoomed under a fixed-size orthographic camera, or null. */
  get projection(): ArcballProjection | null {
    if (this.projectionOption !== undefined) return this.projectionOption;
    const plugin = (this.engine as { plugins?: ReadonlyMap<string, unknown> } | null)?.plugins?.get('cameras') as
      | ArcballProjection
      | undefined;
    return plugin && typeof plugin.zoom === 'number' ? plugin : null;
  }

  /** Remembers the camera position, target, up, fov and projection zoom for `reset`. */
  saveState(): void {
    const c = this.camera;
    this.saved = {
      position: [...c.position] as V3,
      target: [...c.target] as V3,
      up: [...c.up] as V3,
      fov: c.fov,
      zoom: this.projection?.zoom ?? null,
    };
  }
  /** Restores the saved state, drops pending motion and dispatches `change`. */
  reset(): void {
    const s = this.saved,
      c = this.camera,
      projection = this.projection;
    c.fov = s.fov;
    c.position = [...s.position];
    c.target = [...s.target];
    c.up = [...s.up];
    if (projection && s.zoom !== null) projection.zoom = s.zoom;
    this.clearPending();
    this.state = 'none';
    this.dispatchEvent({ type: 'change' });
  }

  /** Turns the camera about the world `axis` through the target by `angle` radians (right-handed). */
  rotate(axis: readonly number[], angle: number): void {
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (!length || !angle) return;
    // Compose with the pending turn: q = q(axis, angle) * q(spinAxis, spinAngle).
    const a = turnQuaternion(axis, angle / 2, 1 / length),
      b = turnQuaternion(this.spinAxis, this.spinAngle / 2, 1),
      x = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      y = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      z = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      w = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
      s = Math.hypot(x, y, z);
    // Shortest equivalent turn, so damping eases out along the short way.
    this.spinAngle = s ? 2 * Math.atan2(s, Math.abs(w)) : 0;
    if (s) this.spinAxis = (w < 0 ? [-x / s, -y / s, -z / s] : [x / s, y / s, z / s]) as V3;
  }
  /** Pans by a screen delta in CSS pixels; the scene follows the pointer. */
  pan(deltaX: number, deltaY: number): void {
    const b = this.frame(),
      perPixel = (2 * (b.ortho ?? b.distance * b.tanHalf)) / this.size()[1],
      sx = -deltaX * perPixel,
      sy = deltaY * perPixel;
    for (let i = 0; i < 3; i++) this.shift[i] += b.right[i] * sx + b.up[i] * sy;
  }
  /** Multiplies the pending distance (or orthographic size) scale by `factor`, about the view centre (below 1 moves closer). */
  dollyIn(factor: number): void {
    this.cursor = null;
    this.logScale += Math.log(factor);
  }
  /** Divides the pending distance (or orthographic size) scale by `factor`, about the view centre. */
  dollyOut(factor: number): void {
    this.cursor = null;
    this.logScale -= Math.log(factor);
  }
  /** Distance from the camera to the target. */
  getDistance(): number {
    return Math.hypot(...sub(this.camera.position, this.camera.target));
  }

  /** Applies pending motion (all of it, or the damped share for `delta` seconds, default 1/60). Returns true when the camera moved. */
  override update(delta = 1 / 60): boolean {
    const camera = this.camera,
      p0 = camera.position,
      t0 = camera.target,
      u0 = camera.up,
      f = this.enableDamping ? 1 - (1 - clamp(this.dampingFactor, 0, 1)) ** (60 * Math.max(0, delta)) : 1,
      keep = 1 - f,
      // Share of a pending amount to apply now; `reach` turns the amount into world units moved. Once a damped step
      // would move less than the change threshold, the rest is taken at once, so an update that reports no change
      // leaves nothing pending to creep on.
      take = (amount: number, reach: number): number => (Math.abs(amount * f) * reach < EPS ? amount : amount * f);
    let target = [...t0] as V3,
      eye = sub(p0, t0) as V3,
      up = this.screenUp();
    const distance = Math.hypot(...eye),
      turned = !!this.spinAngle;
    if (!distance) return false;

    // 1. Rotation of the eye and up about the target. The eye keeps its length and up is made perpendicular to it
    //    again every update, so long drags compose without drift.
    if (this.spinAngle) {
      const angle = take(this.spinAngle, Math.max(distance, 1));
      eye = rotateAxis(eye, this.spinAxis, angle);
      up = rotateAxis(up, this.spinAxis, angle);
      eye = madd([0, 0, 0], eye, distance / Math.hypot(...eye));
      this.spinAngle -= angle;
    }
    const back = madd([0, 0, 0], eye, 1 / distance);
    up = normalize(madd(up, back, -dot(up, back))) as V3;

    // 2. Pan: camera and target move together.
    const s = this.shift;
    const share = take(1, Math.hypot(s[0], s[1], s[2]));
    target = madd(target, s, share);
    for (let i = 0; i < 3; i++) s[i] *= 1 - share;

    // 3. Zoom: scale the view about the point under the cursor on the plane through the target facing the camera.
    let position = madd(target, eye, 1);
    if (this.logScale) {
      const log = take(this.logScale, Math.max(distance, 1));
      this.logScale -= log;
      const projection = this.projection,
        fixed = !!(camera as { fixedOrthographic?: boolean }).fixedOrthographic;
      let k = Math.exp(log);
      if (fixed && projection) {
        // Orthographic size: zoom divides the frustum, so a scale k is zoom / k.
        const zoom = clamp(projection.zoom / k, this.minZoom, this.maxZoom);
        if (zoom > 0 && Number.isFinite(zoom) && zoom !== projection.zoom) {
          k = projection.zoom / zoom;
          // The cursor point lies on the plane through the target, so moving both by (1 - k) of its offset keeps it
          // on its pixel while the frustum shrinks by k about the view centre.
          const hit = this.hit(position, target, up);
          if (hit) {
            const offset = sub(hit, target);
            target = madd(target, offset, 1 - k);
            position = madd(position, offset, 1 - k);
          }
          projection.zoom = zoom;
        }
      } else {
        k = clamp(distance * k, Math.max(this.minDistance, EPS), this.maxDistance) / distance;
        const hit = fixed ? null : this.hit(position, target, up);
        if (hit) {
          position = madd(hit, sub(position, hit), k);
          target = madd(hit, sub(target, hit), k);
        } else position = madd(target, eye, k);
      }
    } else {
      // Keep the distance inside the limits even without input (limits changed, or set below the current distance).
      const clamped = clamp(distance, Math.max(this.minDistance, EPS), this.maxDistance);
      if (clamped !== distance) position = madd(target, eye, clamped / distance);
    }
    if (!this.logScale && this.state === 'none') this.cursor = null;

    // Only a turn writes `camera.up`, so an idle camera keeps the up it was given.
    const moved =
      Math.hypot(...sub(position, p0)) > EPS ||
      Math.hypot(...sub(target, t0)) > EPS ||
      (turned && Math.hypot(...sub(up, u0)) > EPS);
    if (moved || turned) {
      camera.position = position;
      camera.target = target;
      if (turned) camera.up = up;
    }
    if (moved) this.dispatchEvent({ type: 'change' });
    return moved;
  }

  // ---- geometry helpers ----
  private size(): [number, number] {
    return [Math.max(1, this.element?.clientWidth ?? 1), Math.max(1, this.element?.clientHeight ?? 1)];
  }
  /** `camera.up` made perpendicular to the view, or the world-up frame's up when it is parallel to the view. */
  private screenUp(): V3 {
    const c = this.camera,
      back = normalize(sub(c.position, c.target)),
      up = madd(c.up, back, -dot(c.up, back)),
      length = Math.hypot(...up);
    return length > EPS ? (madd([0, 0, 0], up, 1 / length) as V3) : basis(c).up;
  }
  /** The view frame for a camera at `position` looking at `target` with screen `up` (orthographic size from `camera.matrix`). */
  private frame(position: V3 = [...this.camera.position] as V3, target?: V3, up?: V3): Basis {
    const c = this.camera,
      b = basis(c),
      t = target ?? ([...c.target] as V3),
      offset = sub(t, position),
      distance = Math.hypot(...offset),
      forward = distance ? normalize(offset) : b.forward,
      right = normalize(cross(forward, up ?? this.screenUp()));
    return {
      position: b.ortho ? madd(position, forward, -(c.far ?? distance)) : position,
      forward,
      right,
      up: cross(right, forward),
      distance,
      tanHalf: b.tanHalf,
      ortho: b.ortho,
    };
  }
  /** Where the cursor's ray meets the plane through `target` facing the camera, or null without a cursor. */
  private hit(position: V3, target: V3, up: V3): V3 | null {
    const c = this.cursor;
    if (!c || !this.zoomToCursor) return null;
    const b = this.frame(position, target, up),
      [width, height] = this.size();
    return intersectPlane(ray(b, c.x, c.y, width, height), target, b.forward);
  }
  /** Queues the turn between two pointer positions (CSS px) on the arcball. */
  private drag(x0: number, y0: number, x1: number, y1: number): void {
    const [width, height] = this.size(),
      radius = Math.min(width, height) / 2,
      p = arcballPoint((x0 - width / 2) / radius, (height / 2 - y0) / radius),
      q = arcballPoint((x1 - width / 2) / radius, (height / 2 - y1) / radius),
      axis = cross(p, q),
      length = Math.hypot(...axis);
    if (length < 1e-15) return;
    // The scene turns from p to q about `axis` (camera frame: x right, y up, z toward the viewer); the camera turns
    // the opposite way about the same world axis.
    const b = this.frame(),
      world = madd(madd(madd([0, 0, 0], b.right, axis[0]), b.up, axis[1]), b.forward, -axis[2]),
      angle = Math.atan2(length, dot(p, q)) * this.rotateSpeed;
    this.rotate(world, -angle);
  }
  private clearPending(): void {
    this.spinAngle = 0;
    this.shift.fill(0);
    this.logScale = 0;
    this.cursor = null;
  }
  private applyNow(): void {
    if (!this.enableDamping) this.update(0);
  }

  // ---- pointer gestures ----
  private begin(state: ArcballState): void {
    this.state = state;
    if (state !== 'none') this.dispatchEvent({ type: 'start' });
  }
  private releaseAll(): void {
    for (const id of this.tracked.keys()) this.release(id);
    this.tracked.clear();
  }
  private cancel(): void {
    const active = this.state !== 'none';
    this.releaseAll();
    this.state = 'none';
    if (active) this.dispatchEvent({ type: 'end' });
  }
  private mouseGesture(event: PointerEvent): ArcballState {
    const m = this.mouseButtons;
    let value = event.button === 0 ? m.LEFT : event.button === 1 ? m.MIDDLE : event.button === 2 ? m.RIGHT : null;
    if (event.ctrlKey || event.metaKey || event.shiftKey)
      value = value === ROTATE ? PAN : value === PAN ? ROTATE : value;
    if (value === ROTATE && this.enableRotate) return 'rotate';
    if (value === DOLLY && this.enableZoom) return 'dolly';
    if (value === PAN && this.enablePan) return 'pan';
    return 'none';
  }
  private pair(): { x: number; y: number; spread: number } {
    const [a, b] = [...this.tracked.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  /** Re-chooses the touch gesture after the number of touches changed. */
  private retouch(): void {
    if (this.state !== 'none') this.dispatchEvent({ type: 'end' });
    this.state = 'none';
    const count = this.tracked.size;
    let next: ArcballState = 'none';
    if (count === 1) {
      const [p] = this.tracked.values();
      this.last = { x: p.x, y: p.y, spread: 0 };
      if (this.enableRotate) next = 'touch-rotate';
    } else if (count === 2) {
      this.last = this.pair();
      if (this.enableZoom || this.enablePan) next = 'touch-dolly-pan';
    }
    this.begin(next);
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const at = this.local(event);
    if (event.pointerType === 'touch') {
      for (const p of this.tracked.values()) if (!p.touch) return;
      if (this.tracked.size >= 2 || (!this.enableRotate && !this.enableZoom && !this.enablePan)) return;
      this.capture(event.pointerId);
      this.tracked.set(event.pointerId, { x: at.x, y: at.y, touch: true });
      this.retouch();
      return;
    }
    if (this.tracked.size) return;
    const gesture = this.mouseGesture(event);
    if (gesture === 'none') return;
    this.capture(event.pointerId);
    this.tracked.set(event.pointerId, { x: at.x, y: at.y, touch: false });
    this.last = { x: at.x, y: at.y, spread: 0 };
    this.cursor = { x: at.x, y: at.y };
    // Taking hold stops a coasting spin.
    if (gesture === 'rotate') this.spinAngle = 0;
    this.begin(gesture);
  };

  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled) {
      if (this.state !== 'none' || this.tracked.size) this.cancel();
      return;
    }
    const p = this.tracked.get(event.pointerId);
    if (!p) return;
    const at = this.local(event);
    p.x = at.x;
    p.y = at.y;
    const state = this.state,
      last = this.last;
    if (state === 'rotate' || state === 'touch-rotate') {
      this.drag(last.x, last.y, at.x, at.y);
      this.last = { x: at.x, y: at.y, spread: 0 };
    } else if (state === 'pan') {
      this.pan((at.x - last.x) * this.panSpeed, (at.y - last.y) * this.panSpeed);
      this.last = { x: at.x, y: at.y, spread: 0 };
    } else if (state === 'dolly') {
      this.logScale += ((at.y - last.y) * Math.LN2 * this.zoomSpeed) / PIXELS_PER_DOUBLING;
      this.last = { x: at.x, y: at.y, spread: 0 };
    } else if (state === 'touch-dolly-pan' && this.tracked.size === 2) {
      const now = this.pair();
      if (this.enablePan) this.pan((now.x - last.x) * this.panSpeed, (now.y - last.y) * this.panSpeed);
      if (this.enableZoom && last.spread > 0 && now.spread > 0) {
        this.cursor = { x: now.x, y: now.y };
        this.logScale += Math.log(last.spread / now.spread) * this.zoomSpeed;
      }
      this.last = now;
    } else return;
    this.applyNow();
  };

  private readonly onUp = (event: PointerEvent): void => {
    const p = this.tracked.get(event.pointerId);
    if (!p) return;
    this.release(event.pointerId);
    this.tracked.delete(event.pointerId);
    if (!this.tracked.size) {
      if (this.state !== 'none') this.dispatchEvent({ type: 'end' });
      this.state = 'none';
    } else if (p.touch) this.retouch();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.enableZoom || this.state !== 'none') return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? PAGE_PIXELS : 1),
      at = this.local(event);
    this.cursor = { x: at.x, y: at.y };
    this.dispatchEvent({ type: 'start' });
    this.logScale += (pixels * Math.LN2 * this.zoomSpeed) / PIXELS_PER_DOUBLING;
    this.applyNow();
    this.dispatchEvent({ type: 'end' });
  };

  private readonly onMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
}

/** Quaternion `[x, y, z, w]` for half-angle `half` about `axis` scaled by `inverseLength`. */
function turnQuaternion(
  axis: readonly number[],
  half: number,
  inverseLength: number,
): [number, number, number, number] {
  const s = Math.sin(half) * inverseLength;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(half)];
}
