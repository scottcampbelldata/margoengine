import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { EPS, madd } from './math.js';
import { basis } from './view.js';

/**
 * Largest elevation of the view direction above or below the horizon, in radians: a milliradian short of straight
 * up or down, so the world-up camera always has a defined screen frame.
 */
export const MAX_PITCH = Math.PI / 2 - 1e-3;

// Shift multiplies the flight speed by this (public, documented on `movementSpeedMultiplier`).
const SLOW = 0.1;

/**
 * Turns the camera by `yaw` radians around world +Y (positive turns left, counterclockwise seen from above) and
 * raises the view by `pitch` radians (positive looks up), with the elevation clamped to plus or minus
 * {@link MAX_PITCH}. The eye stays where it is and the target keeps its distance from it.
 */
export function turn(camera: Pick<Camera, 'position' | 'target' | 'fov'>, yaw: number, pitch: number): void {
  const p = camera.position,
    t = camera.target,
    distance = Math.max(Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]), EPS),
    view = basis(camera).forward;
  // Heading on the ground plane, then the yaw about +Y: a turn by `a` maps (x, z) to (x cos a + z sin a, z cos a - x sin a).
  let hx = view[0],
    hz = view[2],
    flat = Math.hypot(hx, hz);
  if (flat < 1e-12) {
    // Looking straight up or down: leave the pole toward the screen top (looking down) or bottom (looking up).
    const up = (camera as { up?: readonly number[] }).up,
      side = view[1] > 0 ? -1 : 1;
    hx = up ? up[0] * side : 0;
    hz = up ? up[2] * side : -1;
    flat = Math.hypot(hx, hz);
    if (flat < 1e-12) (hx = 0), (hz = -1), (flat = 1);
  }
  hx /= flat;
  hz /= flat;
  const c = Math.cos(yaw),
    s = Math.sin(yaw),
    x = hx * c + hz * s,
    z = hz * c - hx * s;
  const elevation = Math.asin(Math.max(-1, Math.min(1, view[1]))),
    next = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, elevation + pitch)),
    across = Math.cos(next);
  camera.target = [p[0] + x * across * distance, p[1] + Math.sin(next) * distance, p[2] + z * across * distance];
}

/** Moves the camera position and target together by `offset`. */
export function translate(camera: Pick<Camera, 'position' | 'target'>, offset: readonly number[]): void {
  camera.position = madd(camera.position, offset, 1);
  camera.target = madd(camera.target, offset, 1);
}

/** Largest change of any coordinate between two snapshots of position and target. */
export function moved(before: readonly number[], camera: Pick<Camera, 'position' | 'target'>): boolean {
  const now = [...camera.position, ...camera.target];
  for (let i = 0; i < 6; i++) if (Math.abs(now[i] - before[i]) > EPS) return true;
  return false;
}

/**
 * Free flight. W/S fly forward and back along the view, A/D strafe, R/F rise and sink along the screen up axis, the
 * arrow keys yaw and pitch, and the pointer's offset from the element centre steers (proportionally, 1 at the edge).
 * Without `dragToLook` the pointer steers whenever it moves and the left and right buttons fly forward and back;
 * with `dragToLook` it steers only while a button is held. The camera always renders with world +Y up, so there is
 * no roll: Q and E do nothing, yaw turns around world +Y and pitch stops short of the poles ({@link MAX_PITCH}).
 * Keys are read from `keyTarget` (default the element's document); key presses with Alt held are ignored.
 * Events: `change`.
 */
export class FlyControls extends Controls {
  /** Flight speed in world units per second. Default 1. */
  movementSpeed = 1;
  /**
   * Turn rate in radians per second at full steering input (an arrow key, or the pointer at the element edge).
   * Default 0.01. The name is kept for compatibility; the camera does not roll.
   */
  rollSpeed = 0.01;
  /** Steer only while a pointer button is held. Default false. */
  dragToLook = false;
  /** Keep flying forward unless the back input is held. Default false. */
  autoForward = false;
  /** Your speed multiplier. Default 1. Holding either Shift key applies an additional factor of 0.1. */
  movementSpeedMultiplier = 1;
  /** Current inputs: 1 or 0 for keys and buttons, proportional (not clamped) for pointer steering. */
  readonly moveState = {
    up: 0,
    down: 0,
    left: 0,
    right: 0,
    forward: 0,
    back: 0,
    pitchUp: 0,
    pitchDown: 0,
    yawLeft: 0,
    yawRight: 0,
  };
  private readonly keyTarget: EventTargetLike | null;
  private presses = 0;
  private shiftLeft = false;
  private shiftRight = false;

  constructor(
    source: Camera | EngineKernel,
    element?: ControlElement | null,
    options: { keyTarget?: EventTargetLike | null } = {},
  ) {
    super(source, element);
    this.keyTarget = options.keyTarget ?? null;
    this.init();
  }
  protected override get kind(): string {
    return 'fly';
  }
  protected bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    const keys = this.keyTarget ?? documentOf(element);
    return [
      [element, 'pointerdown', this.onDown as InputEventListener],
      [element, 'pointermove', this.onMove as InputEventListener],
      [element, 'pointerup', this.onUp as InputEventListener],
      [element, 'pointercancel', this.onCancel as InputEventListener],
      [element, 'contextmenu', this.onContextMenu as InputEventListener],
      [keys, 'keydown', this.onKeyDown as InputEventListener],
      [keys, 'keyup', this.onKeyUp as InputEventListener],
    ];
  }
  protected override onDisconnect(): void {
    const state = this.moveState as Record<string, number>;
    for (const key in state) state[key] = 0;
    this.presses = 0;
    this.shiftLeft = this.shiftRight = false;
  }

  /** Flies and turns for `delta` seconds (default 1/60). Returns true when the camera moved. */
  update(delta = 1 / 60): boolean {
    const camera = this.camera,
      before = [...camera.position, ...camera.target],
      s = this.moveState,
      slow = this.shiftLeft || this.shiftRight ? SLOW : 1,
      step = delta * this.movementSpeed * this.movementSpeedMultiplier * slow,
      forward = this.autoForward && !s.back ? 1 : s.forward;
    const frame = basis(camera),
      across = (s.right - s.left) * step,
      lift = (s.up - s.down) * step,
      along = (forward - s.back) * step;
    if (across || lift || along)
      translate(camera, madd(madd(madd([0, 0, 0], frame.right, across), frame.up, lift), frame.forward, along));
    const rate = delta * this.rollSpeed,
      yaw = (s.yawLeft - s.yawRight) * rate,
      pitch = (s.pitchUp - s.pitchDown) * rate;
    if (yaw || pitch) turn(camera, yaw, pitch);
    const changed = moved(before, camera);
    if (changed) this.dispatchEvent({ type: 'change' });
    return changed;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.altKey) return;
    this.key(event.code, 1);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.key(event.code, 0);
  };
  private key(code: string, value: number): void {
    const s = this.moveState;
    switch (code) {
      case 'ShiftLeft':
        this.shiftLeft = !!value;
        break;
      case 'ShiftRight':
        this.shiftRight = !!value;
        break;
      case 'KeyW':
        s.forward = value;
        break;
      case 'KeyS':
        s.back = value;
        break;
      case 'KeyA':
        s.left = value;
        break;
      case 'KeyD':
        s.right = value;
        break;
      case 'KeyR':
        s.up = value;
        break;
      case 'KeyF':
        s.down = value;
        break;
      case 'ArrowUp':
        s.pitchUp = value;
        break;
      case 'ArrowDown':
        s.pitchDown = value;
        break;
      case 'ArrowLeft':
        s.yawLeft = value;
        break;
      case 'ArrowRight':
        s.yawRight = value;
        break;
    }
  }
  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.capture(event.pointerId);
    if (this.dragToLook) this.presses++;
    else if (event.button === 0) this.moveState.forward = 1;
    else if (event.button === 2) this.moveState.back = 1;
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.element || (this.dragToLook && this.presses <= 0)) return;
    const halfWidth = Math.max(this.element.clientWidth, 1) / 2,
      halfHeight = Math.max(this.element.clientHeight, 1) / 2,
      { x, y } = this.local(event),
      s = this.moveState;
    s.yawLeft = -(x - halfWidth) / halfWidth;
    s.pitchDown = (y - halfHeight) / halfHeight;
    s.yawRight = s.pitchUp = 0;
  };
  private readonly onUp = (event: PointerEvent): void => {
    this.release(event.pointerId);
    if (this.dragToLook) {
      this.presses = Math.max(0, this.presses - 1);
      this.moveState.yawLeft = this.moveState.pitchDown = 0;
    } else if (event.button === 0) this.moveState.forward = 0;
    else if (event.button === 2) this.moveState.back = 0;
  };
  private readonly onCancel = (event: PointerEvent): void => {
    this.release(event.pointerId);
    if (this.dragToLook) {
      this.presses = 0;
      this.moveState.yawLeft = this.moveState.pitchDown = 0;
    } else this.moveState.forward = this.moveState.back = 0;
  };
  private readonly onContextMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
}
