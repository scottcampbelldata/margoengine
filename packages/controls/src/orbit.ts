import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { EPS, type V3 } from './math.js';
import { basis, intersectPlane, ray } from './view.js';
import type { KeyAction, NavigationProfile } from './profiles.js';
export { Controls };

/** Mouse button actions, for `mouseButtons` and profiles. */
export const MOUSE = { ROTATE: 0, DOLLY: 1, PAN: 2 } as const;
/** Touch gesture actions, for `touches` and profiles. */
export const TOUCH = { ROTATE: 0, PAN: 1, DOLLY_PAN: 2, DOLLY_ROTATE: 3 } as const;

// ---- tuning (internal) ----
/** Radians turned by a drag across the full element height: half a turn, so one sweep flips the view over. */
const TURN_PER_HEIGHT = Math.PI;
/** Pixels of wheel or vertical dolly drag that double (or halve) the distance at zoomSpeed 1: one 100 px notch is 2^0.2. */
const PIXELS_PER_DOUBLING = 500;
/** Pixel equivalents of one wheel line and one wheel page (a line-mode notch is usually 3 lines, close to a 100 px notch). */
const LINE_PIXELS = 100 / 3;
const PAGE_PIXELS = 800;
/** Ctrl + wheel is a trackpad pinch, whose deltas are a few pixels per event; this brings it close to wheel speed. */
const PINCH_BOOST = 8;
/** Pending rotation (radians) and pan (fraction of the distance) below which damping stops. */
const ANGLE_SETTLE = 1e-8;
const PAN_SETTLE = 1e-8;
/** Double click for a profile's `fitClick`: the second press within this time (ms) and radius (CSS px). */
const FIT_CLICK_MS = 400;
const FIT_CLICK_PX = 6;
const TAU = Math.PI * 2;

type OrbitState = OrbitControls['state'];
type Drag = 'rotate' | 'pan' | 'dolly';
interface Tracked {
  x: number;
  y: number;
  touch: boolean;
}

/** Directions from the target toward the camera for the profile view keys. */
const VIEWS: Partial<Record<KeyAction, V3>> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  iso: [1, 1, 1],
};

/** Modifier prefix of a profile chord: ctrl (or Meta), shift, alt, in that order. */
const chord = (event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }): string =>
  (event.ctrlKey || event.metaKey ? 'ctrl+' : '') + (event.shiftKey ? 'shift+' : '') + (event.altKey ? 'alt+' : '');

/** Wraps an angle into (-PI, PI]. */
const wrap = (angle: number): number => {
  const a = angle - TAU * Math.floor((angle + Math.PI) / TAU);
  return a === -Math.PI ? Math.PI : a;
};
/** One +/-2PI shift into [-PI, PI]. */
const shift = (angle: number): number => (angle < -Math.PI ? angle + TAU : angle > Math.PI ? angle - TAU : angle);
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Orbits the camera around `camera.target`. Left drag rotates, middle drag or the wheel dollies, right drag (or
 * Ctrl/Meta/Shift + left) pans; one finger rotates, two fingers dolly and pan. Pass the engine to update every frame,
 * or a `Camera` plus an element and call `update(delta)` yourself. Events: `start`, `change`, `end`, `fit`.
 */
export class OrbitControls extends Controls {
  /** Ease motion out over several frames. Default false. */
  enableDamping = false;
  /** Fraction of the remaining motion applied per 1/60 s, frame-rate independent. Default 0.05. */
  dampingFactor = 0.05;
  /** Wheel, middle-drag and pinch dolly. Default true. */
  enableZoom = true;
  /** Dolly speed multiplier. Default 1. */
  zoomSpeed = 1;
  /** Drag rotation. Default true. */
  enableRotate = true;
  /** Rotation speed multiplier. Default 1. */
  rotateSpeed = 1;
  /** Panning. Default true. */
  enablePan = true;
  /** Pan speed multiplier. Default 1. */
  panSpeed = 1;
  /** Pan in the screen plane (true, default) or on the ground plane (false). */
  screenSpacePanning = true;
  /** CSS pixels panned per arrow-key press. Default 7. */
  keyPanSpeed = 7;
  /** Dolly toward the point under the cursor instead of the view centre. Default false. */
  zoomToCursor = false;
  /** Turn around the target while idle. Default false. */
  autoRotate = false;
  /** Auto-rotation speed: 2 is one full turn every 30 s (counterclockwise seen from above). Default 2. */
  autoRotateSpeed = 2;
  /** Closest allowed distance to the target. Default 0. */
  minDistance = 0;
  /** Farthest allowed distance to the target. Default Infinity. */
  maxDistance = Infinity;
  /** Smallest polar angle (radians from +Y). Default 0. */
  minPolarAngle = 0;
  /** Largest polar angle (radians from +Y). Default PI. */
  maxPolarAngle = Math.PI;
  /** Azimuth limits in radians; both must be finite to apply. Defaults -Infinity and Infinity. */
  minAzimuthAngle = -Infinity;
  maxAzimuthAngle = Infinity;
  /** `KeyboardEvent.code` of the four arrow keys. */
  keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };
  /** Action of each mouse button (a `MOUSE` value or null). Not used by profiles with a `drag` table. */
  mouseButtons: { LEFT: number | null; MIDDLE: number | null; RIGHT: number | null } = {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  };
  /** Action of one and two fingers (a `TOUCH` value or null). */
  touches: { ONE: number | null; TWO: number | null } = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
  /** The active gesture. */
  state: 'none' | 'rotate' | 'dolly' | 'pan' | 'touch-rotate' | 'touch-pan' | 'touch-dolly-pan' | 'touch-dolly-rotate' =
    'none';

  // Pending motion, consumed by update().
  private turnAzimuth = 0;
  private turnPolar = 0;
  private readonly shiftTarget: V3 = [0, 0, 0];
  private dollyScale = 1;
  private cursor: { x: number; y: number } | null = null;
  // Pointers owned by these controls, and the last gesture sample.
  private readonly tracked = new Map<number, Tracked>();
  private last = { x: 0, y: 0, spread: 0 };
  private lastPress: { button: number; time: number; x: number; y: number } | null = null;
  private keyTarget: EventTargetLike | null = null;
  private altTarget: EventTargetLike | null = null;
  private savedTouchAction: string | null = null;
  private activeProfile: NavigationProfile | null = null;
  private saved: { position: V3; target: V3; fov: number } = { position: [0, 0, 1], target: [0, 0, 0], fov: 60 };
  // The camera vectors these controls write (never the caller's arrays).
  private readonly ownPosition: V3 = [0, 0, 0];
  private readonly ownTarget: V3 = [0, 0, 0];

  constructor(source: Camera | EngineKernel, element?: ControlElement | null) {
    super(source, element);
    this.saveState();
    this.init();
  }
  protected override get kind(): string {
    return 'orbit';
  }

  protected override bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) {
      this.savedTouchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    return [
      [element, 'pointerdown', this.onDown],
      [element, 'pointermove', this.onMove],
      [element, 'pointerup', this.onUp],
      [element, 'pointercancel', this.onUp],
      [element, 'wheel', this.onWheel, { passive: false }],
      [element, 'contextmenu', this.onMenu],
      [element, 'mousedown', this.onMouseDown],
    ];
  }
  protected override onDisconnect(): void {
    this.stopListenToKeyEvents();
    this.disarmAlt();
    this.releaseAll();
    this.state = 'none';
    const element = this.element;
    if (element?.style && this.savedTouchAction !== null) element.style.touchAction = this.savedTouchAction;
    this.savedTouchAction = null;
  }

  /** Arrow keys pan (or rotate with Ctrl, Meta or Shift), plus the profile's keys. Pass `window` or a focusable element. */
  listenToKeyEvents(target: EventTargetLike): void {
    this.stopListenToKeyEvents();
    target.addEventListener('keydown', this.onKey);
    this.keyTarget = target;
  }
  /** Stops listening for keys. */
  stopListenToKeyEvents(): void {
    this.keyTarget?.removeEventListener('keydown', this.onKey);
    this.keyTarget = null;
  }

  /** The navigation profile last set, or null. */
  get profile(): NavigationProfile | null {
    return this.activeProfile;
  }
  /** Applies a CAD tool's bindings (`MARGO` restores the defaults). Returns the controls. */
  setProfile(profile: NavigationProfile): this {
    this.activeProfile = profile;
    if (profile.mouseButtons) this.mouseButtons = { ...profile.mouseButtons };
    this.touches = { ...profile.touches };
    this.zoomToCursor = profile.zoomToCursor;
    return this;
  }

  /** Polar angle in radians from +Y, in [0, PI]. */
  getPolarAngle(): number {
    const o = this.offset(),
      d = Math.hypot(o[0], o[1], o[2]);
    return d ? Math.acos(clamp(o[1] / d, -1, 1)) : Math.PI / 2;
  }
  /** Azimuth in radians, atan2(x, z) of position minus target, in (-PI, PI]. */
  getAzimuthalAngle(): number {
    const a = this.heading(this.offset());
    return a === -Math.PI ? Math.PI : a;
  }
  /** Distance from the camera to the target. */
  getDistance(): number {
    const o = this.offset();
    return Math.hypot(o[0], o[1], o[2]);
  }
  /** A copy of `camera.target`; assigning writes `camera.target`. */
  get target(): V3 {
    const t = this.camera.target;
    return [t[0], t[1], t[2]];
  }
  set target(value: readonly number[]) {
    this.camera.target = [value[0], value[1], value[2]];
  }

  /** Remembers the camera position, target and fov for `reset`. */
  saveState(): void {
    const c = this.camera;
    this.saved = { position: [...c.position] as V3, target: [...c.target] as V3, fov: c.fov };
  }
  /** Restores the saved state, drops pending motion and dispatches `change`. */
  reset(): void {
    const s = this.saved;
    this.camera.fov = s.fov;
    this.write(s.position, s.target);
    this.clearPending();
    this.state = 'none';
    this.dispatchEvent({ type: 'change' });
  }

  /** Turns around the target; a positive angle moves the camera clockwise seen from above (azimuth decreases). */
  rotateLeft(angle: number): void {
    this.turnAzimuth -= angle;
  }
  /** Tilts around the target; a positive angle raises the camera toward +Y (polar angle decreases). */
  rotateUp(angle: number): void {
    this.turnPolar -= angle;
  }
  /** Pans by a screen delta in CSS pixels; the scene follows the pointer. */
  pan(deltaX: number, deltaY: number): void {
    const b = basis(this.camera),
      half = b.ortho ?? b.distance * b.tanHalf,
      perPixel = (2 * half) / Math.max(1, this.element?.clientHeight ?? 1);
    const along = this.screenSpacePanning ? b.up : this.groundForward(b.right),
      sx = -deltaX * perPixel,
      sy = deltaY * perPixel,
      t = this.shiftTarget;
    for (let i = 0; i < 3; i++) t[i] += b.right[i] * sx + along[i] * sy;
  }
  /** Multiplies the pending distance scale by `factor` (below 1 moves closer). */
  dollyIn(factor: number): void {
    this.dollyScale *= factor;
  }
  /** Divides the pending distance scale by `factor` (below 1 moves farther). */
  dollyOut(factor: number): void {
    this.dollyScale /= factor;
  }

  /** Advances damping and auto-rotation by `delta` seconds (default 1/60). Returns true when the camera moved. */
  override update(delta = 1 / 60): boolean {
    const cam = this.camera,
      p0 = cam.position,
      t0 = cam.target;
    const px = p0[0],
      py = p0[1],
      pz = p0[2],
      tx = t0[0],
      ty = t0[1],
      tz = t0[2];
    // Share of the pending motion applied now: dampingFactor per 1/60 s, compounded for other step lengths.
    const f = this.enableDamping ? 1 - (1 - clamp(this.dampingFactor, 0, 1)) ** (60 * Math.max(0, delta)) : 1;
    const spin = this.autoRotate && this.state === 'none' ? ((TAU * this.autoRotateSpeed) / 60) * delta : 0;
    const dAzimuth = this.turnAzimuth * f,
      dPolar = this.turnPolar * f;

    // Spherical angles, read fresh from the camera. Position equal to the target falls back to the +Z side.
    let ox = px - tx,
      oy = py - ty,
      oz = pz - tz;
    const distance = Math.hypot(ox, oy, oz);
    if (!distance) [ox, oy, oz] = [0, 0, 1];
    const radius = distance || 1;
    let theta = this.heading([ox, oy, oz]) + dAzimuth + spin,
      phi = Math.acos(clamp(oy / radius, -1, 1)) + dPolar;
    const startPhi = phi;

    let azimuthClamped = false;
    const lo = this.minAzimuthAngle,
      hi = this.maxAzimuthAngle;
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      const min = shift(lo),
        max = shift(hi),
        wrapped = shift(theta);
      let limited = wrapped;
      if (min <= max) limited = clamp(wrapped, min, max);
      else if (wrapped > max && wrapped < min) limited = wrapped < (max + min) / 2 ? max : min;
      azimuthClamped = limited !== wrapped;
      theta = limited;
    }

    const up = cam.up ?? [0, 1, 0],
      vertical = ox === 0 && oz === 0 && oy !== 0,
      polePhi = oy > 0 ? 0 : Math.PI;
    const keepPole =
      vertical &&
      dAzimuth === 0 &&
      dPolar === 0 &&
      spin === 0 &&
      !azimuthClamped &&
      (up[0] !== 0 || up[2] !== 0) &&
      polePhi >= this.minPolarAngle &&
      polePhi <= this.maxPolarAngle;
    if (!keepPole) phi = clamp(clamp(phi, this.minPolarAngle, this.maxPolarAngle), EPS, Math.PI - EPS);

    const s = this.shiftTarget;
    let nx = tx + s[0] * f,
      ny = ty + s[1] * f,
      nz = tz + s[2] * f;
    const scale = this.dollyScale,
      newDistance = clamp(distance * scale, Math.max(this.minDistance, EPS), this.maxDistance);

    // Unit direction from the new target toward the camera.
    let dx: number, dy: number, dz: number;
    let qx: number, qy: number, qz: number;
    const unturned =
      distance > 0 && dAzimuth === 0 && dPolar === 0 && spin === 0 && !azimuthClamped && phi === startPhi;
    if (keepPole || unturned) {
      // No rotation: keep the exact offset direction (exact poles, and no rounding drift while idle).
      const k = newDistance / distance;
      [dx, dy, dz] = [ox / distance, oy / distance, oz / distance];
      [qx, qy, qz] = [nx + ox * k, ny + oy * k, nz + oz * k];
    } else {
      const sp = Math.sin(phi);
      [dx, dy, dz] = [sp * Math.sin(theta), Math.cos(phi), sp * Math.cos(theta)];
      [qx, qy, qz] = [nx + dx * newDistance, ny + dy * newDistance, nz + dz * newDistance];
    }

    if (
      this.zoomToCursor &&
      this.cursor &&
      scale !== 1 &&
      !(cam as { fixedOrthographic?: boolean }).fixedOrthographic &&
      distance > 0
    ) {
      const hit = this.cursorHit([nx, ny, nz], [nx + dx * distance, ny + dy * distance, nz + dz * distance]);
      if (hit) {
        // Scale the view about the hit point: same direction, new distance, the hit keeps its pixel.
        const k = newDistance / distance,
          old: V3 = [nx + dx * distance, ny + dy * distance, nz + dz * distance];
        qx = hit[0] + (old[0] - hit[0]) * k;
        qy = hit[1] + (old[1] - hit[1]) * k;
        qz = hit[2] + (old[2] - hit[2]) * k;
        nx = hit[0] + (nx - hit[0]) * k;
        ny = hit[1] + (ny - hit[1]) * k;
        nz = hit[2] + (nz - hit[2]) * k;
      }
    }

    this.write([qx, qy, qz], [nx, ny, nz]);

    // Remaining motion.
    if (this.enableDamping) {
      const keep = 1 - f,
        settle = PAN_SETTLE * Math.max(newDistance, 1);
      this.turnAzimuth = Math.abs(this.turnAzimuth * keep) < ANGLE_SETTLE ? 0 : this.turnAzimuth * keep;
      this.turnPolar = Math.abs(this.turnPolar * keep) < ANGLE_SETTLE ? 0 : this.turnPolar * keep;
      for (let i = 0; i < 3; i++) s[i] *= keep;
      if (Math.hypot(s[0], s[1], s[2]) < settle) s.fill(0);
    } else {
      this.turnAzimuth = this.turnPolar = 0;
      s.fill(0);
    }
    this.dollyScale = 1;

    const moved = Math.hypot(qx - px, qy - py, qz - pz) > EPS || Math.hypot(nx - tx, ny - ty, nz - tz) > EPS;
    if (moved) this.dispatchEvent({ type: 'change' });
    return moved;
  }

  // ---- geometry helpers ----
  private offset(): V3 {
    const p = this.camera.position,
      t = this.camera.target;
    return [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
  }
  /** Azimuth of an offset; at an exact pole it comes from camera.up (top: opposite its horizontal part, bottom: along it). */
  private heading(o: readonly number[]): number {
    if (o[0] !== 0 || o[2] !== 0) return Math.atan2(o[0], o[2]);
    const up = this.camera.up ?? [0, 1, 0];
    if (up[0] === 0 && up[2] === 0) return 0;
    return o[1] > 0 ? Math.atan2(-up[0], -up[2]) : Math.atan2(up[0], up[2]);
  }
  /** Horizontal direction perpendicular to +Y and to the screen right (away from the camera). */
  private groundForward(right: readonly number[]): V3 {
    const x = right[2],
      z = -right[0],
      l = Math.hypot(x, z) || 1;
    return [x / l, 0, z / l];
  }
  /** Where the cursor's perspective ray meets the plane through `target` facing a camera at `eye`, or null. */
  private cursorHit(target: V3, eye: V3): V3 | null {
    const cam = this.camera,
      b = basis({ position: eye, target, fov: cam.fov, up: cam.up }),
      width = Math.max(1, this.element?.clientWidth ?? 1),
      height = Math.max(1, this.element?.clientHeight ?? 1),
      c = this.cursor as { x: number; y: number };
    return intersectPlane(ray(b, c.x, c.y, width, height), target, b.forward);
  }
  /** Writes the camera through its setters into vectors these controls own. */
  private write(position: readonly number[], target: readonly number[]): void {
    const p = this.ownPosition,
      t = this.ownTarget;
    for (let i = 0; i < 3; i++) {
      p[i] = position[i];
      t[i] = target[i];
    }
    this.camera.position = p;
    this.camera.target = t;
  }
  private clearPending(): void {
    this.turnAzimuth = this.turnPolar = 0;
    this.shiftTarget.fill(0);
    this.dollyScale = 1;
  }
  /** Radians for a drag of `pixels` CSS pixels. */
  private turn(pixels: number): number {
    return (TURN_PER_HEIGHT * this.rotateSpeed * pixels) / Math.max(1, this.element?.clientHeight ?? 1);
  }
  /** Distance scale for `pixels` of wheel or dolly drag (positive moves away); equal and opposite deltas cancel. */
  private zoomScale(pixels: number): number {
    return 2 ** ((this.zoomSpeed * pixels) / PIXELS_PER_DOUBLING);
  }
  private applyNow(): void {
    this.update(0);
  }

  // ---- pointer gestures ----
  private begin(state: OrbitState): void {
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
  /** The gesture a mouse or pen press starts, or none. */
  private mouseGesture(event: PointerEvent): Drag | null {
    const table = this.activeProfile?.drag;
    let action: Drag | null = null;
    if (table) {
      const bound = table[chord(event) + event.button];
      if (bound === 'rotate-or-pan') action = basis(this.camera).ortho !== undefined ? 'pan' : 'rotate';
      else action = bound ?? null;
    } else {
      const m = this.mouseButtons;
      let value = event.button === 0 ? m.LEFT : event.button === 1 ? m.MIDDLE : event.button === 2 ? m.RIGHT : null;
      if (event.ctrlKey || event.metaKey || event.shiftKey)
        value = value === MOUSE.ROTATE ? MOUSE.PAN : value === MOUSE.PAN ? MOUSE.ROTATE : value;
      action = value === MOUSE.ROTATE ? 'rotate' : value === MOUSE.DOLLY ? 'dolly' : value === MOUSE.PAN ? 'pan' : null;
    }
    if (action === 'rotate' && !this.enableRotate) return null;
    if (action === 'dolly' && !this.enableZoom) return null;
    if (action === 'pan' && !this.enablePan) return null;
    return action;
  }
  private oneTouch(): OrbitState {
    const one = this.touches.ONE;
    if (one === TOUCH.ROTATE && this.enableRotate) return 'touch-rotate';
    if (one === TOUCH.PAN && this.enablePan) return 'touch-pan';
    return 'none';
  }
  private twoTouch(): OrbitState {
    const two = this.touches.TWO;
    if (two === TOUCH.DOLLY_PAN && (this.enableZoom || this.enablePan)) return 'touch-dolly-pan';
    if (two === TOUCH.DOLLY_ROTATE && (this.enableZoom || this.enableRotate)) return 'touch-dolly-rotate';
    return 'none';
  }
  /** Midpoint and spread of the first two tracked touches. */
  private pair(): { x: number; y: number; spread: number } {
    const [a, b] = [...this.tracked.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
  }
  /** Re-chooses the touch gesture after the number of touches changed. */
  private retouch(): void {
    if (this.state !== 'none') this.dispatchEvent({ type: 'end' });
    this.state = 'none';
    const count = this.tracked.size;
    let next: OrbitState = 'none';
    if (count === 1) {
      const [p] = this.tracked.values();
      this.last = { x: p.x, y: p.y, spread: 0 };
      next = this.oneTouch();
    } else if (count === 2) {
      this.last = this.pair();
      next = this.twoTouch();
    }
    this.begin(next);
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const at = this.local(event);
    if (event.pointerType === 'touch') {
      for (const p of this.tracked.values()) if (!p.touch) return;
      // Touch reservation: keep the first finger for a coming two-finger gesture, unless no touch gesture is usable.
      if (this.oneTouch() === 'none' && this.twoTouch() === 'none') return;
      this.capture(event.pointerId);
      this.tracked.set(event.pointerId, { x: at.x, y: at.y, touch: true });
      this.retouch();
      return;
    }
    if (this.tracked.size) return;
    const fitButton = this.activeProfile?.fitClick;
    if (fitButton !== undefined && event.button === fitButton) {
      const prev = this.lastPress,
        time = event.timeStamp ?? 0;
      if (
        prev &&
        prev.button === event.button &&
        time - prev.time < FIT_CLICK_MS &&
        Math.hypot(at.x - prev.x, at.y - prev.y) < FIT_CLICK_PX
      ) {
        this.lastPress = null;
        this.dispatchEvent({ type: 'fit' });
      } else this.lastPress = { button: event.button, time, x: at.x, y: at.y };
    }
    const gesture = this.mouseGesture(event);
    if (!gesture) return;
    if (event.altKey && this.activeProfile?.drag) this.armAlt();
    this.capture(event.pointerId);
    this.tracked.set(event.pointerId, { x: at.x, y: at.y, touch: false });
    this.last = { x: at.x, y: at.y, spread: 0 };
    this.cursor = { x: at.x, y: at.y };
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
    const state = this.state;
    if (
      state === 'rotate' ||
      state === 'touch-rotate' ||
      state === 'pan' ||
      state === 'touch-pan' ||
      state === 'dolly'
    ) {
      const dx = at.x - this.last.x,
        dy = at.y - this.last.y;
      this.last = { x: at.x, y: at.y, spread: 0 };
      if (state === 'rotate' || state === 'touch-rotate') {
        this.rotateLeft(this.turn(dx));
        this.rotateUp(this.turn(dy));
      } else if (state === 'dolly') this.dollyScale *= this.zoomScale(dy);
      else this.pan(dx * this.panSpeed, dy * this.panSpeed);
    } else if ((state === 'touch-dolly-pan' || state === 'touch-dolly-rotate') && this.tracked.size === 2) {
      const now = this.pair(),
        before = this.last;
      if (this.enableZoom && before.spread > 0 && now.spread > 0) {
        this.cursor = { x: now.x, y: now.y };
        this.dollyScale *= (before.spread / now.spread) ** this.zoomSpeed;
      }
      const dx = now.x - before.x,
        dy = now.y - before.y;
      if (state === 'touch-dolly-pan' && this.enablePan) this.pan(dx * this.panSpeed, dy * this.panSpeed);
      else if (state === 'touch-dolly-rotate' && this.enableRotate) {
        this.rotateLeft(this.turn(dx));
        this.rotateUp(this.turn(dy));
      }
      this.last = now;
    } else return;
    if (!this.enableDamping) this.applyNow();
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
    let pixels = event.deltaY * (event.deltaMode === 1 ? LINE_PIXELS : event.deltaMode === 2 ? PAGE_PIXELS : 1);
    if (event.ctrlKey) pixels *= PINCH_BOOST;
    else if (this.activeProfile?.wheel === -1) pixels = -pixels;
    const at = this.local(event);
    this.cursor = { x: at.x, y: at.y };
    this.dispatchEvent({ type: 'start' });
    this.dollyScale *= this.zoomScale(pixels);
    this.applyNow();
    this.dispatchEvent({ type: 'end' });
  };

  private readonly onMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
  private readonly onMouseDown = (event: Event): void => {
    if (this.activeProfile?.drag && this.state !== 'none') event.preventDefault();
  };

  // ---- keyboard ----
  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    const bound = this.activeProfile?.keys?.[chord(event) + event.code];
    if (bound) {
      event.preventDefault();
      this.keyAction(bound);
      return;
    }
    const code = event.code || event.key,
      k = this.keys;
    if (code !== k.UP && code !== k.BOTTOM && code !== k.LEFT && code !== k.RIGHT) return;
    event.preventDefault();
    if ((event.ctrlKey || event.metaKey || event.shiftKey) && this.enableRotate) {
      const step = this.turn(1);
      if (code === k.UP) this.rotateUp(step);
      else if (code === k.BOTTOM) this.rotateUp(-step);
      else if (code === k.LEFT) this.rotateLeft(step);
      else this.rotateLeft(-step);
    } else if (this.enablePan) {
      const s = this.keyPanSpeed;
      if (code === k.UP) this.pan(0, s);
      else if (code === k.BOTTOM) this.pan(0, -s);
      else if (code === k.LEFT) this.pan(s, 0);
      else this.pan(-s, 0);
    }
    this.applyNow();
  };
  private keyAction(action: KeyAction): void {
    if (action === 'fit') {
      this.dispatchEvent({ type: 'fit' });
      return;
    }
    if (action === 'projection') {
      const projection = (this.engine as { plugins?: ReadonlyMap<string, unknown> } | null)?.plugins?.get('cameras') as
        | { mode?: string }
        | undefined;
      if (projection && typeof projection.mode === 'string')
        projection.mode = projection.mode === 'perspective' ? 'orthographic' : 'perspective';
      return;
    }
    const view = VIEWS[action];
    if (!view) return;
    const l = Math.hypot(view[0], view[1], view[2]),
      heading = view[0] || view[2] ? Math.atan2(view[0], view[2]) : 0;
    this.turnAzimuth = wrap(heading - this.getAzimuthalAngle());
    this.turnPolar = Math.acos(view[1] / l) - this.getPolarAngle();
    this.applyNow();
  }

  // ---- Alt keyup guard (stops the browser menu bar after an Alt drag) ----
  private armAlt(): void {
    if (this.altTarget || !this.element) return;
    const target = documentOf(this.element);
    target.addEventListener('keyup', this.onAltUp);
    this.altTarget = target;
  }
  private disarmAlt(): void {
    this.altTarget?.removeEventListener('keyup', this.onAltUp);
    this.altTarget = null;
  }
  private readonly onAltUp = (event: KeyboardEvent): void => {
    if (event.key !== 'Alt' && event.code !== 'AltLeft' && event.code !== 'AltRight') return;
    event.preventDefault();
    this.disarmAlt();
  };
}

/**
 * Map-style orbit controls: left drag pans on the ground plane, right drag rotates, middle drag dollies; one finger
 * pans, two fingers dolly and rotate. Ctrl/Meta/Shift + left rotates.
 */
export class MapControls extends OrbitControls {
  constructor(source: Camera | EngineKernel, element?: ControlElement | null) {
    super(source, element);
    this.screenSpacePanning = false;
    this.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    this.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_ROTATE };
  }
  protected override get kind(): string {
    return 'map';
  }
}

/** Options of {@link cadControls}. */
export interface CADControlsOptions {
  /** Mouse, wheel, touch and key mapping: `MARGO` (the default) or a CAD tool's profile (`SOLIDWORKS`, `AUTOCAD`, ...). */
  profile?: NavigationProfile;
  /** Where the profile's keys (view keys, F to fit) are read, for example `window`. Default none: keys are off. */
  keys?: EventTargetLike;
}

/**
 * Familiar CAD navigation in one call: replaces the stage's built-in core `CADCameraControls` (attached by
 * `createStage` unless `controls: false`) with `OrbitControls` under `profile`, or attaches them to a bare engine.
 * Core's controls take no profile; these give the same orbit, pan and zoom with a CAD tool's mouse buttons. Listen
 * for `fit` on the result to frame your model when the profile's fit gesture is used.
 */
export function cadControls(engine: EngineKernel, { profile, keys }: CADControlsOptions = {}): OrbitControls {
  // The stage facade's plugin that drives core CADCameraControls (packages/margoengine/src/index.ts); a no-op without it.
  engine.removePlugin('margoengine-controls');
  const orbit = OrbitControls.attach(engine);
  if (profile) orbit.setProfile(profile);
  if (keys) orbit.listenToKeyEvents(keys);
  return orbit;
}
