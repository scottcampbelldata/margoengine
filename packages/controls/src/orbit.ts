import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { EPS, madd, type V3 } from './math.js';
import { add, cross, dot, sub } from '@margoengine/math/vec3';
import { clamp } from '@margoengine/math/mathutils';
import { basis, intersectPlane, ray } from './view.js';
import type { KeyAction, NavigationProfile } from './profiles.js';

/** Mouse button actions, as in three.js `MOUSE`. */
export const MOUSE = { ROTATE: 0, DOLLY: 1, PAN: 2 } as const;
/** Touch gesture actions, as in three.js `TOUCH`. */
export const TOUCH = { ROTATE: 0, PAN: 1, DOLLY_PAN: 2, DOLLY_ROTATE: 3 } as const;

type Action =
  | 'none'
  | 'rotate'
  | 'dolly'
  | 'pan'
  | 'touch-rotate'
  | 'touch-pan'
  | 'touch-dolly-pan'
  | 'touch-dolly-rotate';
type Point = { x: number; y: number };
const TAU = Math.PI * 2;
/** Profile binding key: `ctrl+shift+alt+` (as held; Meta counts as ctrl) then the button or key code. */
const chord = (e: MouseEvent | KeyboardEvent, input: number | string): string =>
  (e.ctrlKey || e.metaKey ? 'ctrl+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + input;
const VIEWS: Record<string, V3> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0],
  bottom: [0, -1, 0],
  iso: [1, 1, 1],
};

/**
 * Orbits the camera around `camera.target` (three.js `OrbitControls`). Left drag rotates, middle drag or wheel
 * dollies, right drag (or shift/ctrl + left) pans; one finger rotates, two fingers dolly and pan.
 */
export class OrbitControls extends Controls {
  enableDamping = false;
  /** Fraction of the remaining motion applied per 1/60 s frame. Frame-rate independent. */
  dampingFactor = 0.05;
  enableZoom = true;
  zoomSpeed = 1;
  enableRotate = true;
  rotateSpeed = 1;
  enablePan = true;
  panSpeed = 1;
  /** True pans in the screen plane; false pans along the ground (XZ) plane. */
  screenSpacePanning = true;
  /** Pixels moved per arrow key press. */
  keyPanSpeed = 7;
  /** Dolly toward the point under the cursor instead of toward the target. */
  zoomToCursor = false;
  autoRotate = false;
  /** 2.0 is one turn every 30 seconds. */
  autoRotateSpeed = 2;
  minDistance = 0;
  maxDistance = Infinity;
  minPolarAngle = 0;
  maxPolarAngle = Math.PI;
  minAzimuthAngle = -Infinity;
  maxAzimuthAngle = Infinity;
  keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };
  mouseButtons: { LEFT: number | null; MIDDLE: number | null; RIGHT: number | null } = {
    LEFT: MOUSE.ROTATE,
    MIDDLE: MOUSE.DOLLY,
    RIGHT: MOUSE.PAN,
  };
  touches: { ONE: number | null; TWO: number | null } = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };
  /** Current gesture, `'none'` when idle. */
  state: Action = 'none';
  private nav: NavigationProfile | null = null;
  private lastClick: (Point & { t: number }) | null = null;
  private altTarget: EventTargetLike | null = null;
  private altDrag = false;

  private dTheta = 0;
  private dPhi = 0;
  private dPan: V3 = [0, 0, 0];
  private dScale = 1;
  private cursor: Point | null = null;
  private readonly pointers = new Map<number, Point>();
  private last: Point = { x: 0, y: 0 };
  private lastSpread = 0;
  private keyTarget: EventTargetLike | null = null;
  private previousTouchAction = '';
  private saved!: { position: V3; target: V3; fov: number };
  private readonly nextPosition: V3 = [0, 0, 0];
  private readonly nextTarget: V3 = [0, 0, 0];
  private readonly changeEvent = { type: 'change' };

  constructor(source: Camera | EngineKernel, element?: ControlElement | null) {
    super(source, element);
    this.saveState();
    this.init();
  }
  protected override get kind(): string {
    return 'orbit';
  }

  protected bind(element: ControlElement) {
    if (element.style) {
      this.previousTouchAction = element.style.touchAction;
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
    ] as Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]>;
  }
  protected override onDisconnect(): void {
    this.stopListenToKeyEvents();
    this.altTarget?.removeEventListener('keyup', this.onAltUp);
    this.altTarget = null;
    for (const id of this.pointers.keys()) this.release(id);
    this.pointers.clear();
    this.state = 'none';
    if (this.element?.style) this.element.style.touchAction = this.previousTouchAction;
  }
  /** Arrow keys pan (or rotate with ctrl, meta or shift). Pass `window` or a focusable element. */
  listenToKeyEvents(target: EventTargetLike): void {
    this.stopListenToKeyEvents();
    target.addEventListener('keydown', this.onKey);
    this.keyTarget = target;
  }
  stopListenToKeyEvents(): void {
    this.keyTarget?.removeEventListener('keydown', this.onKey);
    this.keyTarget = null;
  }

  /** The CAD navigation profile set with `setProfile`, or null for the three.js defaults. */
  get profile(): NavigationProfile | null {
    return this.nav;
  }
  /**
   * Uses a CAD tool's mouse, wheel, touch and key bindings: `orbit.setProfile(SOLIDWORKS)`. Sets `mouseButtons` (when the
   * profile has no `drag` table), `touches` and `zoomToCursor`; `THREE_ORBIT` restores the defaults. Returns the controls.
   */
  setProfile(profile: NavigationProfile): this {
    this.nav = profile;
    if (profile.mouseButtons) this.mouseButtons = { ...profile.mouseButtons };
    this.touches = { ...profile.touches };
    this.zoomToCursor = profile.zoomToCursor;
    return this;
  }

  getPolarAngle(): number {
    const o = this.offset();
    return Math.acos(clamp(o[1] / Math.hypot(...o), -1, 1));
  }
  getAzimuthalAngle(): number {
    const o = this.offset();
    return this.heading(o[0], o[1], o[2]);
  }
  /** Azimuth of an offset; on an exact pole (a ViewCube top or bottom view) it comes from `camera.up`, the screen up. */
  private heading(x: number, y: number, z: number): number {
    if (x || z) return Math.atan2(x, z);
    const up = this.camera.up,
      s = y > 0 ? -1 : 1;
    return Math.atan2(s * up[0], s * up[2]);
  }
  getDistance(): number {
    return Math.hypot(...this.offset());
  }
  get target(): V3 {
    return [...this.camera.target] as V3;
  }
  set target(value: readonly number[]) {
    this.camera.target = [value[0], value[1], value[2]];
  }

  saveState(): void {
    this.saved = {
      position: [...this.camera.position] as V3,
      target: [...this.camera.target] as V3,
      fov: this.camera.fov,
    };
  }
  reset(): void {
    this.camera.position = [...this.saved.position];
    this.camera.target = [...this.saved.target];
    this.camera.fov = this.saved.fov;
    this.dTheta = this.dPhi = 0;
    this.dPan = [0, 0, 0];
    this.dScale = 1;
    this.state = 'none';
    this.dispatchEvent({ type: 'change' });
  }

  /** Rotates left by `angle` radians (positive moves the camera clockwise seen from above). */
  rotateLeft(angle: number): void {
    this.dTheta -= angle;
  }
  rotateUp(angle: number): void {
    this.dPhi -= angle;
  }
  /** Pans by a screen delta in CSS pixels. */
  pan(deltaX: number, deltaY: number): void {
    const element = this.element,
      height = Math.max(1, element?.clientHeight ?? 1);
    const b = basis(this.camera),
      distance = b.ortho ?? b.distance * b.tanHalf;
    this.dPan = madd(this.dPan, b.right, (-2 * deltaX * distance) / height);
    const up = this.screenSpacePanning ? b.up : cross([0, 1, 0], b.right);
    this.dPan = madd(this.dPan, up, (2 * deltaY * distance) / height);
  }
  /** Multiplies the distance by 1 / `factor` (factor above 1 moves closer). */
  dollyIn(factor: number): void {
    this.dScale *= factor;
  }
  dollyOut(factor: number): void {
    this.dScale /= factor;
  }

  update(delta = 1 / 60): boolean {
    const c = this.camera,
      px = c.position[0],
      py = c.position[1],
      pz = c.position[2],
      tx = c.target[0],
      ty = c.target[1],
      tz = c.target[2];
    if (this.autoRotate && this.state === 'none') this.rotateLeft((-TAU / 60) * this.autoRotateSpeed * delta);
    const f = this.enableDamping ? 1 - Math.pow(1 - clamp(this.dampingFactor, 0, 1), Math.max(0, delta) * 60) : 1;
    const ox = px - tx,
      oy = py - ty,
      oz = pz - tz,
      radius = Math.hypot(ox, oy, oz);
    let theta = this.heading(ox, oy, oz) + this.dTheta * f,
      phi = Math.acos(clamp(oy / radius, -1, 1)) + this.dPhi * f;
    let min = this.minAzimuthAngle,
      max = this.maxAzimuthAngle;
    if (Number.isFinite(min) && Number.isFinite(max)) {
      if (min < -Math.PI) min += TAU;
      else if (min > Math.PI) min -= TAU;
      if (max < -Math.PI) max += TAU;
      else if (max > Math.PI) max -= TAU;
      if (theta > Math.PI) theta -= TAU;
      else if (theta < -Math.PI) theta += TAU;
      theta =
        min <= max ? clamp(theta, min, max) : theta > (min + max) / 2 ? Math.max(min, theta) : Math.min(max, theta);
    }
    // Core rejects a view parallel to camera.up (default +Y), so the poles stay EPS away.
    phi = clamp(clamp(phi, this.minPolarAngle, this.maxPolarAngle), EPS, Math.PI - EPS);
    const target = this.nextTarget,
      cursorZoom = this.zoomToCursor && this.cursor && this.dScale !== 1;
    target[0] = tx + this.dPan[0] * f;
    target[1] = ty + this.dPan[1] * f;
    target[2] = tz + this.dPan[2] * f;
    const next = this.clampDistance(radius * this.dScale),
      s = Math.sin(phi);
    const position = this.nextPosition;
    position[0] = target[0] + next * s * Math.sin(theta);
    position[1] = target[1] + next * Math.cos(phi);
    position[2] = target[2] + next * s * Math.cos(theta);
    if (cursorZoom) {
      // Scale about the point under the cursor on the plane through the target facing the camera: the view
      // direction is unchanged and that point keeps its pixel.
      const b = basis({
        position: add(target, [radius * s * Math.sin(theta), radius * Math.cos(phi), radius * s * Math.cos(theta)]),
        target,
        fov: c.fov,
      });
      const element = this.element!,
        hit = intersectPlane(
          ray(b, this.cursor!.x, this.cursor!.y, Math.max(1, element.clientWidth), Math.max(1, element.clientHeight)),
          target,
          b.forward,
        );
      const k = next / radius;
      if (hit) {
        c.position = madd(hit, sub(b.position, hit), k);
        c.target = madd(hit, sub(target, hit), k);
      } else {
        c.position = position;
        c.target = target;
      }
    } else {
      c.position = position;
      c.target = target;
    }
    if (this.enableDamping) {
      this.dTheta *= 1 - f;
      this.dPhi *= 1 - f;
      this.dPan[0] *= 1 - f;
      this.dPan[1] *= 1 - f;
      this.dPan[2] *= 1 - f;
      if (Math.abs(this.dTheta) < 1e-10) this.dTheta = 0;
      if (Math.abs(this.dPhi) < 1e-10) this.dPhi = 0;
      if (dot(this.dPan, this.dPan) < 1e-20) this.dPan.fill(0);
    } else {
      this.dTheta = this.dPhi = 0;
      this.dPan.fill(0);
    }
    this.dScale = 1;
    const moved =
      (px - c.position[0]) ** 2 + (py - c.position[1]) ** 2 + (pz - c.position[2]) ** 2 > EPS * EPS ||
      (tx - c.target[0]) ** 2 + (ty - c.target[1]) ** 2 + (tz - c.target[2]) ** 2 > EPS * EPS;
    if (moved) this.dispatchEvent(this.changeEvent);
    return moved;
  }

  private offset(): V3 {
    return sub(this.camera.position, this.camera.target);
  }
  private clampDistance(d: number): number {
    return clamp(d, Math.max(this.minDistance, EPS), this.maxDistance);
  }
  private zoomScale(delta: number): number {
    return Math.pow(0.95, this.zoomSpeed * Math.abs(delta * 0.01));
  }
  private applyNow(): void {
    if (!this.enableDamping) this.update(0);
  }
  private begin(state: Action): void {
    this.state = state;
    if (state !== 'none') this.dispatchEvent({ type: 'start' });
  }
  private cancel(): void {
    if (this.state !== 'none') this.dispatchEvent({ type: 'end' });
    for (const id of this.pointers.keys()) this.release(id);
    this.pointers.clear();
    this.state = 'none';
  }

  private readonly onMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.capture(event.pointerId);
    const p = this.local(event);
    this.pointers.set(event.pointerId, p);
    if (event.pointerType === 'touch') {
      this.touchStart();
      return;
    }
    if (this.pointers.size > 1) return;
    const nav = this.nav,
      table = nav?.drag;
    if (nav?.fitClick === event.button) {
      // Double click: a second press within 400 ms and 6 px of the first.
      const l = this.lastClick,
        t = event.timeStamp;
      if (l && t - l.t < 400 && Math.hypot(p.x - l.x, p.y - l.y) < 6) {
        this.lastClick = null;
        this.dispatchEvent({ type: 'fit' });
      } else this.lastClick = { x: p.x, y: p.y, t };
    }
    let state: Action;
    if (table) {
      let drag = table[chord(event, event.button)];
      if (drag === 'rotate-or-pan') drag = basis(this.camera).ortho ? 'pan' : 'rotate';
      state =
        drag === 'rotate' && this.enableRotate
          ? 'rotate'
          : drag === 'dolly' && this.enableZoom
            ? 'dolly'
            : drag === 'pan' && this.enablePan
              ? 'pan'
              : 'none';
      if (state !== 'none' && event.altKey) {
        // Releasing Alt after an Alt drag would open the menu bar in some browsers (Firefox on Windows): eat that keyup.
        this.altDrag = true;
        if (!this.altTarget) (this.altTarget = documentOf(this.element!)).addEventListener('keyup', this.onAltUp);
      }
    } else {
      let action =
        event.button === 0
          ? this.mouseButtons.LEFT
          : event.button === 1
            ? this.mouseButtons.MIDDLE
            : event.button === 2
              ? this.mouseButtons.RIGHT
              : null;
      const modified = event.ctrlKey || event.metaKey || event.shiftKey;
      if (action === MOUSE.ROTATE && modified) action = MOUSE.PAN;
      else if (action === MOUSE.PAN && modified) action = MOUSE.ROTATE;
      state =
        action === MOUSE.ROTATE && this.enableRotate
          ? 'rotate'
          : action === MOUSE.DOLLY && this.enableZoom
            ? 'dolly'
            : action === MOUSE.PAN && this.enablePan
              ? 'pan'
              : 'none';
    }
    this.last = p;
    this.cursor = p;
    if (state === 'none') {
      this.pointers.delete(event.pointerId);
      this.release(event.pointerId);
      return;
    }
    this.begin(state);
  };
  /** With a profile: a press that starts a gesture (e.g. middle drag) must not start autoscroll, text selection or a native drag. */
  private readonly onMouseDown = (event: MouseEvent): void => {
    if (this.nav?.drag && this.state !== 'none') event.preventDefault();
  };
  private readonly onAltUp = (event: KeyboardEvent): void => {
    if (event.key === 'Alt' && this.altDrag) {
      this.altDrag = false;
      event.preventDefault();
    }
  };
  private touchStart(): void {
    const points = [...this.pointers.values()];
    if (this.state !== 'none') this.dispatchEvent({ type: 'end' });
    this.state = 'none';
    if (points.length === 1) {
      const action = this.touches.ONE;
      const state: Action =
        action === TOUCH.ROTATE && this.enableRotate
          ? 'touch-rotate'
          : action === TOUCH.PAN && this.enablePan
            ? 'touch-pan'
            : 'none';
      this.last = points[0];
      this.begin(state);
    } else if (points.length === 2) {
      const action = this.touches.TWO;
      const state: Action =
        action === TOUCH.DOLLY_PAN && (this.enableZoom || this.enablePan)
          ? 'touch-dolly-pan'
          : action === TOUCH.DOLLY_ROTATE && (this.enableZoom || this.enableRotate)
            ? 'touch-dolly-rotate'
            : 'none';
      this.last = mid(points[0], points[1]);
      this.lastSpread = spread(points[0], points[1]);
      this.begin(state);
    }
  }
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled) {
      if (this.state !== 'none' || this.pointers.size) this.cancel();
      return;
    }
    if (!this.pointers.has(event.pointerId)) return;
    const p = this.local(event);
    this.pointers.set(event.pointerId, p);
    const height = Math.max(1, this.element!.clientHeight);
    const rotate = (dx: number, dy: number) => {
      this.rotateLeft((TAU * dx * this.rotateSpeed) / height);
      this.rotateUp((TAU * dy * this.rotateSpeed) / height);
    };
    const dolly = (factor: number, at: Point) => {
      this.cursor = at;
      if (factor > 1) this.dollyOut(factor);
      else if (factor < 1) this.dollyIn(1 / factor);
    };
    switch (this.state) {
      case 'rotate':
      case 'touch-rotate':
        rotate(p.x - this.last.x, p.y - this.last.y);
        this.last = p;
        break;
      case 'pan':
      case 'touch-pan':
        this.pan((p.x - this.last.x) * this.panSpeed, (p.y - this.last.y) * this.panSpeed);
        this.last = p;
        break;
      case 'dolly': {
        const dy = p.y - this.last.y;
        if (dy > 0) this.dollyOut(this.zoomScale(dy));
        else if (dy < 0) this.dollyIn(this.zoomScale(dy));
        this.last = p;
        break;
      }
      case 'touch-dolly-pan':
      case 'touch-dolly-rotate': {
        const [a, b] = [...this.pointers.values()],
          center = mid(a, b),
          distance = spread(a, b);
        if (this.enableZoom && this.lastSpread > 0 && distance > 0)
          dolly(Math.pow(distance / this.lastSpread, this.zoomSpeed), center);
        if (this.state === 'touch-dolly-pan' && this.enablePan)
          this.pan((center.x - this.last.x) * this.panSpeed, (center.y - this.last.y) * this.panSpeed);
        if (this.state === 'touch-dolly-rotate' && this.enableRotate)
          rotate(center.x - this.last.x, center.y - this.last.y);
        this.last = center;
        this.lastSpread = distance;
        break;
      }
      default:
        return;
    }
    this.applyNow();
  };
  private readonly onUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    this.release(event.pointerId);
    if (!this.pointers.size) {
      if (this.state !== 'none') this.dispatchEvent({ type: 'end' });
      this.state = 'none';
      return;
    }
    if (event.pointerType === 'touch') this.touchStart();
  };
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.enableZoom || this.state !== 'none') return;
    event.preventDefault();
    let delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    if (event.ctrlKey)
      delta *= 10; // trackpad pinch (never inverted)
    else if (this.nav?.wheel === -1) delta = -delta;
    this.cursor = this.local(event);
    this.dispatchEvent({ type: 'start' });
    if (delta < 0) this.dollyIn(this.zoomScale(delta));
    else if (delta > 0) this.dollyOut(this.zoomScale(delta));
    this.update(0);
    this.dispatchEvent({ type: 'end' });
  };
  private readonly onKey = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    const bound = this.nav?.keys?.[chord(event, event.code)];
    if (bound) {
      event.preventDefault();
      this.keyAction(bound);
      return;
    }
    const height = Math.max(1, this.element?.clientHeight ?? 1),
      turn = (TAU * this.rotateSpeed) / height;
    const rotate = (event.ctrlKey || event.metaKey || event.shiftKey) && this.enableRotate;
    let handled = true;
    switch (event.code ?? event.key) {
      case this.keys.UP:
        if (rotate) this.rotateUp(turn);
        else if (this.enablePan) this.pan(0, this.keyPanSpeed);
        break;
      case this.keys.BOTTOM:
        if (rotate) this.rotateUp(-turn);
        else if (this.enablePan) this.pan(0, -this.keyPanSpeed);
        break;
      case this.keys.LEFT:
        if (rotate) this.rotateLeft(turn);
        else if (this.enablePan) this.pan(this.keyPanSpeed, 0);
        break;
      case this.keys.RIGHT:
        if (rotate) this.rotateLeft(-turn);
        else if (this.enablePan) this.pan(-this.keyPanSpeed, 0);
        break;
      default:
        handled = false;
    }
    if (handled) {
      event.preventDefault();
      this.update(0);
    }
  };
  private keyAction(action: KeyAction): void {
    if (action === 'fit') {
      this.dispatchEvent({ type: 'fit' });
      return;
    }
    if (action === 'projection') {
      // The engine's @margoengine/cameras CameraProjection, found by plugin name (as the ViewCube does).
      const projection = (
        this.engine as unknown as { plugins?: ReadonlyMap<string, { mode?: string }> } | null
      )?.plugins?.get('cameras');
      if (projection?.mode) projection.mode = projection.mode === 'orthographic' ? 'perspective' : 'orthographic';
      return;
    }
    // Snap to the view's spherical angles: the shortest turn, eased when damping is on.
    const d = VIEWS[action],
      o = this.offset(),
      turn = (d[0] || d[2] ? Math.atan2(d[0], d[2]) : 0) - this.heading(o[0], o[1], o[2]);
    this.dTheta = (((turn % TAU) + 3 * Math.PI) % TAU) - Math.PI;
    this.dPhi = Math.acos(d[1] / Math.hypot(...d)) - Math.acos(clamp(o[1] / Math.hypot(...o), -1, 1));
    this.applyNow();
  }
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const spread = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Map-style orbit (three.js `MapControls`): left drag pans along the ground plane, right drag rotates,
 * two fingers dolly and rotate.
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
