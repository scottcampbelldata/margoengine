import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { EPS, madd, rotateAxis, type V3 } from './math.js';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { basis, rollFrame } from './view.js';
import { moved } from './steer.js';
export { Controls };

/** `MOUSE` values (kept local so this entry does not load the orbit module). */
const ROTATE = 0,
  DOLLY = 1,
  PAN = 2;

type State = 'none' | 'rotate' | 'zoom' | 'pan' | 'touch-rotate' | 'touch-zoom-pan';
type Pointer = { x: number; y: number; touch: boolean };

// Radius of the virtual trackball in circle units (half the element width). Near the centre a drag of one unit
// turns the view by about one radian at rotateSpeed 1.
const BALL = 1;
// The eye never comes closer than this to the world Y axis (radians), and long rotations are walked in steps of at
// most ARC_STEP so a single large step cannot jump across a pole.
const POLE = 1e-3;
const ARC_STEP = 0.05;
// Wheel deltas in zoom units (fractions of the element height) per pixel, per line and per page. A typical
// 100 px wheel notch zooms by exp(0.05 * zoomSpeed), about 6 % at the default; a line is taken as 16 px.
const WHEEL_PIXEL = 0.0005;
const WHEEL_LINE = 0.008;
const WHEEL_PAGE = 0.2;
// Remaining zoom or pan gaps (screen units) below this snap to zero.
const SNAP = 1e-9;

/**
 * Point on Bell's virtual trackball under a circle point: a sphere of radius BALL near the centre that blends
 * into the hyperbolic sheet z = BALL^2 / (2 r) beyond r = BALL / sqrt(2), so points outside the ball still turn it
 * smoothly (Bell, "Virtual Trackball", Graphics Gems IV notes, 1988; Henriksen, Sporring and Hornbaek, "Virtual
 * Trackballs Revisited", IEEE TVCG 2004).
 */
function onBall(x: number, y: number): V3 {
  const r2 = x * x + y * y,
    edge = (BALL * BALL) / 2;
  return [x, y, r2 <= edge ? Math.sqrt(BALL * BALL - r2) : edge / Math.sqrt(r2)];
}

/**
 * Rotation vector (camera frame: x right, y up, z toward the viewer) that turns the trackball from circle point `a`
 * to `b`. The z part is the roll about the view axis, which only `enableRoll` uses.
 */
function ballTurn(a: readonly number[], b: readonly number[]): V3 {
  const p = onBall(a[0], a[1]),
    q = onBall(b[0], b[1]),
    axis = cross(p, q),
    length = Math.hypot(...axis);
  if (length < 1e-15) return [0, 0, 0];
  const angle = Math.atan2(length, p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / length;
  return [axis[0] * angle, axis[1] * angle, axis[2] * angle];
}

/**
 * Rotates `eye` about the unit `axis` by `angle`, stopping just short of the world Y axis: the arc is walked in
 * small steps, and when a step comes within POLE of the axis or its heading flips (it went over the top), the eye is
 * placed exactly POLE from the axis at the previous step's heading. The length of `eye` is kept.
 */
function rotateClear(eye: V3, axis: readonly number[], angle: number): V3 {
  const length = Math.hypot(...eye),
    steps = Math.max(1, Math.ceil(Math.abs(angle) / ARC_STEP));
  let previous = eye;
  for (let i = 1; i <= steps; i++) {
    const next = rotateAxis(eye, axis, (angle * i) / steps),
      flat = Math.hypot(next[0], next[2]),
      flipped = previous[0] * next[0] + previous[2] * next[2] < 0;
    if (Math.atan2(flat, Math.abs(next[1])) < POLE || flipped) {
      let hx = previous[0],
        hz = previous[2];
      const h = Math.hypot(hx, hz);
      if (h > 0) (hx /= h), (hz /= h);
      else (hx = 0), (hz = 1);
      const side = Math.sin(POLE) * length;
      return [hx * side, (previous[1] < 0 ? -1 : 1) * Math.cos(POLE) * length, hz * side];
    }
    previous = next;
  }
  return previous;
}

/**
 * Free trackball rotation of the camera around `camera.target`: dragging turns the scene like a ball held under
 * the pointer (Bell's virtual trackball), with zoom and pan. Left drag rotates, middle drag zooms, right drag pans
 * (see `mouseButtons`); holding `keys[0..2]` (A, S, D) makes the left button rotate, zoom or pan. One finger
 * rotates, two fingers pinch to zoom and move to pan. With `staticMoving` off, the view keeps turning after a fling
 * and zoom and pan ease in; the easing is frame-rate independent and eased zoom and pan end where the static ones
 * would. By default the camera has no roll: the screen axes come from world +Y every frame, the roll part of the
 * trackball rotation is dropped, and the eye stops just short of the poles instead of tumbling over them. With
 * `enableRoll` the whole rotation applies, the view passes over the poles and the control drives `camera.up`.
 * `keyTarget` is where key events are read (default: the element's document, else the element). Events: `start`, `change`, `end`.
 */
export class TrackballControls extends Controls {
  /** Rotation rate multiplier. Default 1. */
  rotateSpeed = 1;
  /** Zoom rate multiplier. Default 1.2. */
  zoomSpeed = 1.2;
  /** Pan rate multiplier: a drag across the whole element moves the target by `panSpeed` times the distance. Default 0.3. */
  panSpeed = 0.3;
  /** Disable rotation. Default false. */
  noRotate = false;
  /** Disable zoom. Default false. */
  noZoom = false;
  /** Disable pan. Default false. */
  noPan = false;
  /** True stops as soon as the pointer stops; false coasts after a fling and eases zoom and pan. Default false. */
  staticMoving = false;
  /**
   * Fraction of the remaining motion given up per 1/60 s when `staticMoving` is off (compounded over time, so the
   * feel does not depend on the frame rate). Default 0.2.
   */
  dynamicDampingFactor = 0.2;
  /**
   * Apply the whole ball rotation: dragging near the edge rolls the view, the eye passes over the poles and the control
   * writes `camera.up`. Default false. Turning it off leaves `camera.up` as it is: set `camera.up = [0, 1, 0]` to
   * level the horizon.
   */
  enableRoll = false;
  /** Closest distance to the target. Default 0. */
  minDistance = 0;
  /** Farthest distance from the target. Default Infinity. */
  maxDistance = Infinity;
  /** `KeyboardEvent.code` values that, while held, make the left button rotate, zoom or pan. Default A, S, D. */
  keys = ['KeyA', 'KeyS', 'KeyD'];
  /** Action of each mouse button: a `MOUSE` value (`ROTATE`, `DOLLY` for zoom, `PAN`) or null. */
  mouseButtons: { LEFT: number | null; MIDDLE: number | null; RIGHT: number | null } = {
    LEFT: ROTATE,
    MIDDLE: DOLLY,
    RIGHT: PAN,
  };
  /** Current gesture. */
  state: State = 'none';

  private readonly keyTarget: EventTargetLike | null;
  private readonly pointers = new Map<number, Pointer>();
  private driver = -1;
  private keyMode: State = 'none';
  private previousTouchAction = '';
  // Rotation: last circle point, rotation vector gathered from moves since the last update, and the coast.
  private ball: [number, number] = [0, 0];
  private spin: V3 = [0, 0, 0];
  private coastAxis: V3 = [0, 1, 0];
  private coastRate = 0; // radians per 1/60 s
  // Zoom (screen y units), pan (screen units) and pinch spread (CSS px): start chases end.
  private zoomStart = 0;
  private zoomEnd = 0;
  private panStart: [number, number] = [0, 0];
  private panEnd: [number, number] = [0, 0];
  private spreadStart = 0;
  private spreadEnd = 0;
  private saved: { position: V3; target: V3; up: V3 };

  constructor(
    source: Camera | EngineKernel,
    element?: ControlElement | null,
    options: { keyTarget?: EventTargetLike | null } = {},
  ) {
    super(source, element);
    this.keyTarget = options.keyTarget ?? null;
    this.saved = this.snapshot();
    this.init();
  }
  protected override get kind(): string {
    return 'trackball';
  }
  protected bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    if (element.style) {
      this.previousTouchAction = element.style.touchAction;
      element.style.touchAction = 'none';
    }
    const keys = this.keyTarget ?? documentOf(element);
    return [
      [element, 'pointerdown', this.onDown as InputEventListener],
      [element, 'pointermove', this.onMove as InputEventListener],
      [element, 'pointerup', this.onUp as InputEventListener],
      [element, 'pointercancel', this.onUp as InputEventListener],
      [element, 'wheel', this.onWheel as InputEventListener, { passive: false }],
      [element, 'contextmenu', this.onContextMenu as InputEventListener],
      [keys, 'keydown', this.onKeyDown as InputEventListener],
      [keys, 'keyup', this.onKeyUp as InputEventListener],
    ];
  }
  protected override onDisconnect(): void {
    this.dropPointers();
    this.state = this.keyMode = 'none';
    if (this.element?.style) this.element.style.touchAction = this.previousTouchAction;
  }

  private snapshot(): { position: V3; target: V3; up: V3 } {
    const c = this.camera;
    return { position: [...c.position] as V3, target: [...c.target] as V3, up: [...c.up] as V3 };
  }
  /** Remembers the camera position, target and up for `reset`. */
  saveState(): void {
    this.saved = this.snapshot();
  }
  /** Restores the saved position, target and up and drops any pending or coasting motion. Dispatches `change`. */
  reset(): void {
    this.camera.target = [...this.saved.target];
    this.camera.position = [...this.saved.position];
    this.camera.up = [...this.saved.up];
    this.state = 'none';
    this.clearPending();
    this.dispatchEvent({ type: 'change' });
  }

  protected clearPending(): void {
    this.spin = [0, 0, 0];
    this.coastRate = 0;
    this.zoomStart = this.zoomEnd;
    this.panStart = [...this.panEnd];
    this.spreadStart = this.spreadEnd;
  }

  /** Applies the gathered rotation, zoom and pan, and the coast, for `delta` seconds (default 1/60). Returns true when the camera moved. */
  update(delta = 1 / 60): boolean {
    const camera = this.camera,
      before = [...camera.position, ...camera.target],
      frames = 60 * Math.max(0, delta),
      damping = Math.min(1, Math.max(1e-6, this.dynamicDampingFactor)),
      // Share of a remaining zoom or pan gap taken this update: dynamicDampingFactor per 1/60 s, compounded.
      share = this.staticMoving ? 1 : 1 - (1 - damping) ** frames,
      free = this.enableRoll,
      frame = free ? rollFrame(camera) : basis(camera);
    let target = [...camera.target] as V3,
      eye = sub(camera.position, target) as V3,
      up = frame.up,
      turned = false;
    // With roll the eye and the up vector turn together with no stop; without it the eye stops short of the poles.
    const swing = (axis: readonly number[], angle: number): void => {
      if (!free) {
        eye = rotateClear(eye, axis, angle);
        return;
      }
      eye = rotateAxis(eye, axis, angle);
      up = rotateAxis(up, axis, angle);
      turned = true;
    };

    // 1. Rotation.
    const [sx, sy, sz] = this.spin,
      twist = free ? sz : 0;
    this.spin = [0, 0, 0];
    if (!this.noRotate && Math.hypot(...eye) > EPS) {
      if (sx || sy || twist) {
        // The scene turns about the camera-frame axis; the eye turns the opposite way about the same world axis.
        const turnAxis = madd(madd(madd([0, 0, 0], frame.right, -sx), frame.up, -sy), frame.forward, twist),
          angle = Math.hypot(sx, sy, twist) * this.rotateSpeed;
        this.coastAxis = normalize(turnAxis) as V3;
        swing(this.coastAxis, angle);
        if (this.staticMoving) this.coastRate = 0;
        else if (frames > 0) this.coastRate = angle / frames;
      } else if (!this.staticMoving && this.coastRate > 0) {
        // Angular speed keeps sqrt(1 - damping) per 1/60 s: the spin's half-life is twice that of the zoom and pan
        // easing, so a fling carries on for a moment (at the default, about 9 drag frames' worth in total). The
        // speed is integrated over this update, so the coast covers the same angle at any frame rate.
        const keep = Math.sqrt(1 - damping);
        let angle = 0;
        if (keep > 0) {
          const fade = -Math.log(keep),
            left = keep ** frames;
          angle = (this.coastRate * (1 - left)) / fade;
          this.coastRate *= left;
          // Once a step's arc is short enough that no coordinate may change by more than the change threshold
          // (arc < 2 EPS > sqrt(3) EPS), take the rest of the coast now and stop, so the first update that reports
          // no change is followed by no further creep.
          if (angle * Math.hypot(...eye) < 2 * EPS) {
            angle += this.coastRate / fade;
            this.coastRate = 0;
          }
        } else this.coastRate = 0;
        if (angle) swing(this.coastAxis, angle);
      }
    } else if (this.noRotate) this.coastRate = 0;

    // 2. Zoom: scale the eye by exp(zoomSpeed * gap), so eased steps multiply to the same total as one static step.
    if (this.noZoom) {
      this.zoomStart = this.zoomEnd;
      this.spreadStart = this.spreadEnd;
    } else {
      if (this.state === 'touch-zoom-pan' && this.spreadEnd > 0 && this.spreadStart > 0) {
        const factor = this.spreadStart / this.spreadEnd;
        this.spreadStart = this.spreadEnd;
        if (factor !== 1) eye = madd([0, 0, 0], eye, factor);
      }
      const gap = this.zoomEnd - this.zoomStart;
      if (gap) {
        const taken = Math.abs(gap * (1 - share)) < SNAP ? gap : gap * share;
        this.zoomStart += taken;
        if (taken === gap) this.zoomStart = this.zoomEnd;
        eye = madd([0, 0, 0], eye, Math.exp(taken * this.zoomSpeed));
      }
    }

    // 3. Pan in the camera plane, scaled by the distance so the scene follows the pointer at any zoom.
    if (this.noPan) this.panStart = [...this.panEnd];
    else {
      const gx = this.panEnd[0] - this.panStart[0],
        gy = this.panEnd[1] - this.panStart[1];
      if (gx || gy) {
        const whole = Math.abs(gx * (1 - share)) < SNAP && Math.abs(gy * (1 - share)) < SNAP,
          tx = whole ? gx : gx * share,
          ty = whole ? gy : gy * share,
          scale = Math.hypot(...eye) * this.panSpeed,
          leftward = cross(eye, up),
          left = Math.hypot(...leftward) > 0 ? normalize(leftward) : frame.right.map((v) => -v);
        target = madd(madd(target, left, tx * scale), up, ty * scale);
        this.panStart = whole ? [...this.panEnd] : [this.panStart[0] + tx, this.panStart[1] + ty];
      }
    }

    // 4. Distance limits.
    const distance = Math.hypot(...eye);
    if (distance > 0) {
      const clamped = Math.min(Math.max(distance, this.minDistance, EPS), this.maxDistance);
      if (clamped !== distance) eye = madd([0, 0, 0], eye, clamped / distance);
    }

    camera.target = target;
    camera.position = madd(target, eye, 1);
    // Taken off the view again, so rounding cannot tilt the frame over a long tumble.
    let rolled = false;
    if (turned) {
      const back = normalize(eye),
        next = normalize(madd(up, back, -dot(up, back)));
      rolled = Math.hypot(...sub(next, frame.up)) > EPS;
      camera.up = next;
    }
    const changed = moved(before, camera) || rolled;
    if (changed) this.dispatchEvent({ type: 'change' });
    return changed;
  }

  // ---------- input ----------
  private size(): [number, number] {
    const element = this.element;
    return [Math.max(element?.clientWidth ?? 1, 1), Math.max(element?.clientHeight ?? 1, 1)];
  }
  /** Circle point: centred, x right and y up, both in units of half the element width. */
  private circle(p: { x: number; y: number }): [number, number] {
    const [width, height] = this.size(),
      half = width / 2;
    return [(p.x - half) / half, (height / 2 - p.y) / half];
  }
  /** Screen point: x over the width and y over the height, y down. */
  private screen(p: { x: number; y: number }): [number, number] {
    const [width, height] = this.size();
    return [p.x / width, p.y / height];
  }
  private grab(p: { x: number; y: number }): void {
    this.ball = this.circle(p);
    this.spin = [0, 0, 0];
    this.coastRate = 0; // taking hold of the ball stops it
  }
  private touches(): Pointer[] {
    const list: Pointer[] = [];
    for (const p of this.pointers.values()) if (p.touch) list.push(p);
    return list;
  }
  private retouch(): void {
    const [a, b] = this.touches();
    if (!a) return;
    if (!b) {
      this.state = 'touch-rotate';
      this.grab(a);
    } else {
      this.state = 'touch-zoom-pan';
      this.spreadStart = this.spreadEnd = Math.hypot(a.x - b.x, a.y - b.y);
      this.panEnd = this.screen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      this.panStart = [...this.panEnd];
    }
    this.dispatchEvent({ type: 'start' });
  }
  private finish(): void {
    if (this.state === 'none') return;
    this.state = 'none';
    this.dispatchEvent({ type: 'end' });
  }
  private dropPointers(): void {
    for (const id of this.pointers.keys()) this.release(id);
    this.pointers.clear();
    this.driver = -1;
  }
  private buttonMode(button: number): State {
    const action =
      button === 0
        ? this.mouseButtons.LEFT
        : button === 1
          ? this.mouseButtons.MIDDLE
          : button === 2
            ? this.mouseButtons.RIGHT
            : null;
    return action === ROTATE ? 'rotate' : action === DOLLY ? 'zoom' : action === PAN ? 'pan' : 'none';
  }

  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const id = event.pointerId,
      p = { ...this.local(event), touch: event.pointerType === 'touch' };
    this.capture(id);
    this.pointers.set(id, p);
    if (p.touch) return this.retouch();
    if (this.pointers.size > 1) return;
    let mode = this.keyMode !== 'none' ? this.keyMode : this.buttonMode(event.button);
    if ((mode === 'rotate' && this.noRotate) || (mode === 'zoom' && this.noZoom) || (mode === 'pan' && this.noPan))
      mode = 'none';
    if (mode === 'none') {
      this.pointers.delete(id);
      this.release(id);
      return;
    }
    this.driver = id;
    if (mode === 'rotate') this.grab(p);
    else if (mode === 'zoom') this.zoomStart = this.zoomEnd = this.screen(p)[1];
    else {
      this.panEnd = this.screen(p);
      this.panStart = [...this.panEnd];
    }
    this.state = mode;
    this.dispatchEvent({ type: 'start' });
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled) {
      if (this.pointers.size) {
        this.dropPointers();
        this.state = 'none';
        this.dispatchEvent({ type: 'end' });
      }
      return;
    }
    const p = this.pointers.get(event.pointerId);
    if (!p) return;
    const at = this.local(event);
    p.x = at.x;
    p.y = at.y;
    const state = this.state,
      mine = p.touch ? state.startsWith('touch') : event.pointerId === this.driver;
    if (!mine) return;
    if (state === 'rotate' || state === 'touch-rotate') {
      const next = this.circle(p),
        [dx, dy, dz] = ballTurn(this.ball, next);
      this.spin = [this.spin[0] + dx, this.spin[1] + dy, this.spin[2] + dz];
      this.ball = next;
    } else if (state === 'zoom') this.zoomEnd = this.screen(p)[1];
    else if (state === 'pan') this.panEnd = this.screen(p);
    else if (state === 'touch-zoom-pan') {
      const [a, b] = this.touches();
      if (!a || !b) return;
      this.spreadEnd = Math.hypot(a.x - b.x, a.y - b.y);
      this.panEnd = this.screen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    }
  };
  private readonly onUp = (event: PointerEvent): void => {
    const id = event.pointerId;
    if (!this.pointers.has(id)) return;
    this.release(id);
    this.pointers.delete(id);
    if (this.touches().length) this.retouch();
    else if (!this.pointers.size || id === this.driver) {
      this.driver = -1;
      this.finish();
    }
  };
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || this.noZoom) return;
    event.preventDefault();
    const unit = event.deltaMode === 2 ? WHEEL_PAGE : event.deltaMode === 1 ? WHEEL_LINE : WHEEL_PIXEL;
    this.zoomStart -= event.deltaY * unit;
    this.dispatchEvent({ type: 'start' });
    this.dispatchEvent({ type: 'end' });
  };
  private readonly onContextMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || this.keyMode !== 'none') return;
    const code = event.code;
    if (code === this.keys[0] && !this.noRotate) this.keyMode = 'rotate';
    else if (code === this.keys[1] && !this.noZoom) this.keyMode = 'zoom';
    else if (code === this.keys[2] && !this.noPan) this.keyMode = 'pan';
  };
  private readonly onKeyUp = (): void => {
    this.keyMode = 'none';
  };
}
