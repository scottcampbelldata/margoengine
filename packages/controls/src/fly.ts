import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { EPS, madd, rotateAxis } from './math.js';
import { dot, normalize } from '@margoengine/math/vec3';
import { basis, rollFrame } from './view.js';
import { moved, translate, turn } from './steer.js';
export { Controls };

// Shift multiplies the flight speed by this (public, documented on `movementSpeedMultiplier`).
const SLOW = 0.1;


/**
 * Free flight. W/S fly forward and back along the view, A/D strafe, R/F rise and sink along the screen up axis, the
 * arrow keys yaw and pitch, and the pointer's offset from the element centre steers (proportionally, 1 at the edge).
 * Without `dragToLook` the pointer steers whenever it moves and the left and right buttons fly forward and back;
 * with `dragToLook` it steers only while a button is held. By default the camera renders with world +Y up, so there
 * is no roll: Q and E do nothing, yaw turns around world +Y and pitch stops short of the poles. With `enableRoll` it
 * flies like an aircraft: Q and E roll, yaw and pitch turn about the camera's own axes, nothing stops at the poles, and
 * the control drives `camera.up`.
 * Keys are read from `keyTarget` (default the element's document); key presses with Alt held are ignored.
 * Events: `change`.
 */
export class FlyControls extends Controls {
  /** Flight speed in world units per second. Default 1. */
  movementSpeed = 1;
  /**
   * Turn rate in radians per second at full steering input (an arrow key, or the pointer at the element edge).
   * Default 0.01. With `enableRoll`, Q and E roll at this rate too.
   */
  rollSpeed = 0.01;
  /**
   * Q rolls left, E rolls right, and yaw and pitch turn about the camera's own axes with no stop at the poles; the
   * control writes `camera.up`. Default false. Turning it off leaves `camera.up` as it is: set `camera.up = [0, 1, 0]`
   * to level the horizon.
   */
  enableRoll = false;
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
    rollLeft: 0,
    rollRight: 0,
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
    const free = this.enableRoll,
      frame = free ? rollFrame(camera) : basis(camera),
      across = (s.right - s.left) * step,
      lift = (s.up - s.down) * step,
      along = (forward - s.back) * step;
    if (across || lift || along)
      translate(camera, madd(madd(madd([0, 0, 0], frame.right, across), frame.up, lift), frame.forward, along));
    const rate = delta * this.rollSpeed,
      yaw = (s.yawLeft - s.yawRight) * rate,
      pitch = (s.pitchUp - s.pitchDown) * rate,
      roll = free ? (s.rollRight - s.rollLeft) * rate : 0;
    if (free) {
      if (yaw || pitch || roll) {
        // Body axes, as an aircraft turns: yaw about up, pitch about right, roll about the view. The eye stays put.
        const side = rotateAxis(frame.right, frame.up, yaw),
          forward = normalize(rotateAxis(rotateAxis(frame.forward, frame.up, yaw), side, pitch)),
          up = rotateAxis(rotateAxis(frame.up, side, pitch), forward, roll);
        camera.target = madd(camera.position, forward, frame.distance);
        // Taken off the view again, so rounding cannot tilt the frame over a long flight.
        camera.up = normalize(madd(up, forward, -dot(up, forward)));
      }
    } else if (yaw || pitch) turn(camera, yaw, pitch);
    const changed = moved(before, camera) || Math.abs(roll) > EPS;
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
      case 'KeyQ':
        s.rollLeft = value;
        break;
      case 'KeyE':
        s.rollRight = value;
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
