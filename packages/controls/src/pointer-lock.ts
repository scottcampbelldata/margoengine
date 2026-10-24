import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlDocument,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { madd, type V3 } from './math.js';
import { basis } from './view.js';
import { MAX_PITCH, translate, turn } from './fly.js';

// Look sensitivity at pointerSpeed 1, in radians per pixel (mouse count) of locked movement. Derived so that 2 inches
// (5.08 cm) of travel on an 800 DPI mouse (1600 counts) turns the view a quarter turn (90 degrees): a full turn
// takes about 20 cm, a mid-range desktop first-person setting. Higher-DPI mice turn faster; scale with pointerSpeed.
const RADIANS_PER_PIXEL = Math.PI / 2 / (2 * 800); // about 9.82e-4

/**
 * Mouse look with the pointer locked to the element, plus keyboard movement. Call `lock()` from a user gesture
 * (a click); while locked, mouse movement turns the view and `update(delta)` moves at `movementSpeed` while a key in
 * `keys` is held (W/A/S/D and arrows on the ground plane, R/F along world +Y). `look(mx, my)` applies a mouse movement
 * in pixels, as a locked `mousemove` does. Elevation stays within `minPolarAngle`..`maxPolarAngle` and short of the
 * poles. Pass `document` to listen on another document (an iframe, or a test fake); keys default to that document.
 * Events: `lock`, `unlock`, `change`, and `error` when the lock request fails.
 */
export class PointerLockControls extends Controls {
  /** True while the pointer is locked to the element. */
  isLocked = false;
  /** Smallest polar angle of the view, radians from +Y. Default 0. */
  minPolarAngle = 0;
  /** Largest polar angle of the view, radians from +Y. Default PI. */
  maxPolarAngle = Math.PI;
  /** Mouse-look sensitivity multiplier. Default 1. */
  pointerSpeed = 1;
  /** Key movement speed in world units per second; 0 turns key movement off. Default 1. */
  movementSpeed = 1;
  /** Keys move the camera only while the pointer is locked. Default true. */
  requireLock = true;
  /** `KeyboardEvent.code` values for each movement direction. */
  keys = {
    FORWARD: ['KeyW', 'ArrowUp'],
    BACKWARD: ['KeyS', 'ArrowDown'],
    LEFT: ['KeyA', 'ArrowLeft'],
    RIGHT: ['KeyD', 'ArrowRight'],
    UP: ['KeyR'],
    DOWN: ['KeyF'],
  };
  /** `KeyboardEvent.code` values currently held. */
  readonly pressed = new Set<string>();
  private readonly keyOption: EventTargetLike | null;
  private readonly documentOption: EventTargetLike | null;
  private doc: ControlDocument | null = null;

  constructor(
    source: Camera | EngineKernel,
    element?: ControlElement | null,
    options: { keyTarget?: EventTargetLike | null; document?: EventTargetLike | null } = {},
  ) {
    super(source, element);
    this.keyOption = options.keyTarget ?? null;
    this.documentOption = options.document ?? null;
    this.init();
  }
  protected override get kind(): string {
    return 'pointer-lock';
  }
  protected bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    const doc = this.documentOption ?? documentOf(element),
      keys = this.keyOption ?? doc;
    this.doc = doc as ControlDocument;
    return [
      [doc, 'mousemove', this.onMouseMove as InputEventListener],
      [doc, 'pointerlockchange', this.onLockChange],
      [doc, 'pointerlockerror', this.onLockError],
      [keys, 'keydown', this.onKeyDown as InputEventListener],
      [keys, 'keyup', this.onKeyUp as InputEventListener],
    ];
  }
  protected override onDisconnect(): void {
    this.pressed.clear();
  }

  /** Asks the browser to lock the pointer to the element; call it from a user gesture. */
  lock(unadjustedMovement = false): void {
    const element = this.element as (ControlElement & { requestPointerLock?(options?: object): unknown }) | null;
    if (!element?.requestPointerLock) return;
    let request: unknown;
    try {
      request = element.requestPointerLock({ unadjustedMovement });
    } catch (error) {
      this.dispatchEvent({ type: 'error', error });
      return;
    }
    if (request && typeof (request as Promise<void>).then === 'function')
      (request as Promise<void>).then(undefined, (error: unknown) => this.dispatchEvent({ type: 'error', error }));
  }
  /** Releases the pointer lock. */
  unlock(): void {
    this.doc?.exitPointerLock?.();
  }
  /** Unit view direction. */
  getDirection(): V3 {
    return basis(this.camera).forward;
  }
  /** Moves by `distance` along the view heading on the ground plane (looking down still moves horizontally). */
  moveForward(distance: number): void {
    const right = basis(this.camera).right;
    // World +Y crossed with the horizontal screen right is the horizontal heading.
    translate(this.camera, [right[2] * distance, 0, -right[0] * distance]);
  }
  /** Moves by `distance` along the horizontal screen right. */
  moveRight(distance: number): void {
    translate(this.camera, madd([0, 0, 0], basis(this.camera).right, distance));
  }
  /** Moves by `distance` along world +Y. */
  moveUp(distance: number): void {
    translate(this.camera, [0, distance, 0]);
  }

  /** Moves for `delta` seconds (default 1/60) while movement keys are held. Returns true when it moved. */
  update(delta = 1 / 60): boolean {
    if (!this.movementSpeed || (this.requireLock && !this.isLocked) || !this.pressed.size) return false;
    const held = (codes: readonly string[]) => (codes.some((code) => this.pressed.has(code)) ? 1 : 0),
      k = this.keys;
    let forward = held(k.FORWARD) - held(k.BACKWARD),
      right = held(k.RIGHT) - held(k.LEFT);
    const up = held(k.UP) - held(k.DOWN),
      flat = Math.hypot(forward, right);
    // Diagonals are not faster than straight movement.
    if (flat > 1) (forward /= flat), (right /= flat);
    const step = this.movementSpeed * delta;
    if ((!forward && !right && !up) || !step) return false;
    if (forward) this.moveForward(forward * step);
    if (right) this.moveRight(right * step);
    if (up) this.moveUp(up * step);
    this.dispatchEvent({ type: 'change' });
    return true;
  }

  /** Turns the view by a mouse movement in pixels: right turns right, down looks down. Dispatches `change`. */
  look(movementX: number, movementY: number): void {
    const rate = RADIANS_PER_PIXEL * this.pointerSpeed,
      view = basis(this.camera).forward,
      elevation = Math.asin(Math.max(-1, Math.min(1, view[1]))),
      low = Math.max(-MAX_PITCH, Math.PI / 2 - this.maxPolarAngle),
      high = Math.min(MAX_PITCH, Math.PI / 2 - this.minPolarAngle),
      next = Math.max(low, Math.min(high, elevation - movementY * rate));
    turn(this.camera, -movementX * rate, next - elevation);
    this.dispatchEvent({ type: 'change' });
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (this.enabled && this.isLocked) this.look(event.movementX || 0, event.movementY || 0);
  };
  private readonly onLockChange = (): void => {
    const locked = !!this.element && this.doc?.pointerLockElement === this.element;
    if (locked === this.isLocked) return;
    this.isLocked = locked;
    if (!locked) this.pressed.clear();
    this.dispatchEvent({ type: locked ? 'lock' : 'unlock' });
  };
  private readonly onLockError = (): void => {
    this.dispatchEvent({ type: 'error' });
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.enabled && event.code) this.pressed.add(event.code);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };
}
