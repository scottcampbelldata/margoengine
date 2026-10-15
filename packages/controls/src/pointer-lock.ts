import type { Camera, EngineKernel } from '@margoengine/core';
import { Controls, documentOf, type ControlElement, type EventTargetLike } from './controls.js';
import { type V3 } from './math.js';
import { cross, normalize, scale } from '@margoengine/math/vec3';
import { clamp } from '@margoengine/math/mathutils';
import { basis } from './view.js';
import { MAX_PITCH, translate, turn } from './fly.js';

/**
 * Mouse-look with the pointer locked to the canvas (three.js `PointerLockControls`), plus WASD movement helpers.
 * `lock()` must be called from a user gesture. While locked, mouse movement turns the view; `update(delta)` moves
 * at `movementSpeed` while movement keys are held.
 */
export class PointerLockControls extends Controls {
  isLocked = false;
  minPolarAngle = 0;
  maxPolarAngle = Math.PI;
  pointerSpeed = 1;
  /** World units per second for the keyboard helpers. Set 0 to disable keyboard movement. */
  movementSpeed = 1;
  /** Move with the keys only while locked (default) or any time. */
  requireLock = true;
  keys = {
    FORWARD: ['KeyW', 'ArrowUp'],
    BACKWARD: ['KeyS', 'ArrowDown'],
    LEFT: ['KeyA', 'ArrowLeft'],
    RIGHT: ['KeyD', 'ArrowRight'],
    UP: ['KeyR'],
    DOWN: ['KeyF'],
  };
  readonly pressed = new Set<string>();
  private readonly keyTarget: EventTargetLike | null;
  private doc: any = null;

  constructor(
    source: Camera | EngineKernel,
    element?: ControlElement | null,
    options: { keyTarget?: EventTargetLike | null; document?: EventTargetLike | null } = {},
  ) {
    super(source, element);
    this.keyTarget = options.keyTarget ?? null;
    this.doc = options.document ?? null;
    this.init();
  }
  protected override get kind(): string {
    return 'pointer-lock';
  }
  protected bind(element: ControlElement) {
    const doc = this.doc ?? documentOf(element),
      keys = this.keyTarget ?? doc;
    this.doc = doc;
    return [
      [doc, 'mousemove', this.onMouseMove],
      [doc, 'pointerlockchange', this.onLockChange],
      [doc, 'pointerlockerror', this.onLockError],
      [keys, 'keydown', this.onKeyDown],
      [keys, 'keyup', this.onKeyUp],
    ] as Array<[EventTargetLike, string, (event: any) => void, AddEventListenerOptions?]>;
  }
  protected override onDisconnect(): void {
    this.pressed.clear();
  }

  /** Requests pointer lock. Call from a click handler. */
  lock(unadjustedMovement = false): void {
    const request = this.element?.requestPointerLock as ((options?: unknown) => unknown) | undefined;
    const result = request?.call(this.element, { unadjustedMovement }) as Promise<void> | undefined;
    if (result && typeof result.catch === 'function') result.catch(() => this.dispatchEvent({ type: 'error' }));
  }
  unlock(): void {
    this.doc?.exitPointerLock?.();
  }

  /** Unit view direction. */
  getDirection(): V3 {
    return basis(this.camera).forward;
  }
  /** Moves parallel to the ground plane along the view direction. */
  moveForward(distance: number): void {
    const b = basis(this.camera);
    translate(this.camera, scale(normalize(cross([0, 1, 0], b.right)), distance));
  }
  moveRight(distance: number): void {
    translate(this.camera, scale(basis(this.camera).right, distance));
  }
  moveUp(distance: number): void {
    translate(this.camera, [0, distance, 0]);
  }

  update(delta = 1 / 60): boolean {
    if (!this.movementSpeed || (this.requireLock && !this.isLocked) || !this.pressed.size) return false;
    const has = (list: string[]) => (list.some((code) => this.pressed.has(code)) ? 1 : 0),
      k = this.keys;
    let forward = has(k.FORWARD) - has(k.BACKWARD),
      right = has(k.RIGHT) - has(k.LEFT);
    const up = has(k.UP) - has(k.DOWN),
      length = Math.hypot(forward, right);
    if (length > 1) {
      forward /= length;
      right /= length;
    }
    const step = this.movementSpeed * delta;
    if ((!forward && !right && !up) || !step) return false;
    this.moveForward(forward * step);
    this.moveRight(right * step);
    this.moveUp(up * step);
    this.dispatchEvent({ type: 'change' });
    return true;
  }

  /** Applies a mouse movement in pixels (what the `mousemove` handler does while locked). */
  look(movementX: number, movementY: number): void {
    const b = basis(this.camera),
      pitch = Math.asin(clamp(b.forward[1], -1, 1));
    const low = Math.max(-MAX_PITCH, Math.PI / 2 - this.maxPolarAngle),
      high = Math.min(MAX_PITCH, Math.PI / 2 - this.minPolarAngle);
    const next = clamp(pitch - movementY * 0.002 * this.pointerSpeed, low, high);
    turn(this.camera, -movementX * 0.002 * this.pointerSpeed, next - pitch);
    this.dispatchEvent({ type: 'change' });
  }

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || !this.isLocked) return;
    this.look(event.movementX || 0, event.movementY || 0);
  };
  private readonly onLockChange = (): void => {
    const locked = !!this.doc && this.doc.pointerLockElement === this.element;
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
