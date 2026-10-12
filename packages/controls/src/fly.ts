import type {Camera, EngineKernel} from '@margoengine/core';
import {Controls, documentOf, type ControlElement, type EventTargetLike} from './controls.js';
import {EPS, add, clamp, madd, rotateAxis, scale, type V3} from './math.js';
import {basis} from './view.js';

/** Largest pitch away from the horizon. The Y-up camera cannot look straight up or down. */
export const MAX_PITCH = Math.PI / 2 - 1e-3;

/** Turns the camera by yaw (around world +Y) and pitch (around its right axis), keeping the target distance. */
export function turn(camera: Pick<Camera, 'position' | 'target' | 'fov'>, yaw: number, pitch: number): void {
  const b = basis(camera), distance = Math.max(b.distance, EPS);
  let forward = rotateAxis(b.forward, [0, 1, 0], yaw);
  const current = Math.asin(clamp(forward[1], -1, 1)), next = clamp(current + pitch, -MAX_PITCH, MAX_PITCH);
  const h = Math.hypot(forward[0], forward[2]) || 1;
  forward = [forward[0] / h * Math.cos(next), Math.sin(next), forward[2] / h * Math.cos(next)];
  camera.target = madd(camera.position, forward, distance);
}
/** Moves position and target together by `offset`. */
export function translate(camera: Pick<Camera, 'position' | 'target'>, offset: readonly number[]): void {
  camera.position = add(camera.position, offset); camera.target = add(camera.target, offset);
}

/**
 * Six-degree-of-freedom flight (three.js `FlyControls`): WASD moves, R/F moves up and down, arrows yaw and pitch,
 * the mouse offset from the canvas center steers (or drag to look with `dragToLook`). Left button flies forward
 * and right button backward unless `dragToLook` is set.
 *
 * Roll: Q and E roll in three.js. The Margo Engine camera has no up vector and always renders with world +Y up, so roll
 * is not supported and those keys do nothing; yaw turns around world +Y and pitch stops short of the poles.
 */
export class FlyControls extends Controls {
  /** World units per second. */
  movementSpeed = 1;
  /** Radians per second per unit of steering input, as in three.js (the turn rate is about twice this value). */
  rollSpeed = 0.005;
  dragToLook = false;
  autoForward = false;
  /** Speed multiplier while Shift is held. */
  movementSpeedMultiplier = 1;
  readonly moveState = {up: 0, down: 0, left: 0, right: 0, forward: 0, back: 0, pitchUp: 0, pitchDown: 0, yawLeft: 0, yawRight: 0};
  private status = 0;
  private readonly keyTarget: EventTargetLike | null;

  constructor(source: Camera | EngineKernel, element?: ControlElement | null, options: {keyTarget?: EventTargetLike | null} = {}) {
    super(source, element);
    this.keyTarget = options.keyTarget ?? null;
    this.init();
  }
  protected get kind(): string {return 'fly';}
  protected bind(element: ControlElement) {
    const keys = this.keyTarget ?? documentOf(element);
    return [
      [element, 'pointerdown', this.onDown], [element, 'pointermove', this.onMove], [element, 'pointerup', this.onUp],
      [element, 'pointercancel', this.onCancel], [element, 'contextmenu', this.onMenu],
      [keys, 'keydown', this.onKeyDown], [keys, 'keyup', this.onKeyUp],
    ] as Array<[EventTargetLike, string, (event: any) => void, AddEventListenerOptions?]>;
  }
  protected onDisconnect(): void {for (const key of Object.keys(this.moveState)) this.moveState[key as keyof typeof this.moveState] = 0; this.status = 0;}

  update(delta = 1 / 60): boolean {
    const c = this.camera, before = [...c.position, ...c.target], s = this.moveState;
    const move = delta * this.movementSpeed * this.movementSpeedMultiplier, rotate = 2 * delta * this.rollSpeed;
    const forward = s.forward || (this.autoForward && !s.back ? 1 : 0);
    const b = basis(c);
    let offset: V3 = scale(b.right, (s.right - s.left) * move);
    offset = madd(offset, b.up, (s.up - s.down) * move);
    offset = madd(offset, b.forward, (forward - s.back) * move);
    translate(c, offset);
    turn(c, (s.yawLeft - s.yawRight) * rotate, (s.pitchUp - s.pitchDown) * rotate);
    const after = [...c.position, ...c.target], moved = before.some((v, i) => Math.abs(v - after[i]) > EPS);
    if (moved) this.dispatchEvent({type: 'change'});
    return moved;
  }

  private readonly onMenu = (event: Event): void => {if (this.enabled) event.preventDefault();};
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || event.altKey) return;
    this.key(event.code, 1);
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this.movementSpeedMultiplier = 0.1;
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.key(event.code, 0);
    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') this.movementSpeedMultiplier = 1;
  };
  private key(code: string, value: number): void {
    const s = this.moveState;
    switch (code) {
      case 'KeyW': s.forward = value; break; case 'KeyS': s.back = value; break;
      case 'KeyA': s.left = value; break; case 'KeyD': s.right = value; break;
      case 'KeyR': s.up = value; break; case 'KeyF': s.down = value; break;
      case 'ArrowUp': s.pitchUp = value; break; case 'ArrowDown': s.pitchDown = value; break;
      case 'ArrowLeft': s.yawLeft = value; break; case 'ArrowRight': s.yawRight = value; break;
    }
  }
  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.capture(event.pointerId);
    if (this.dragToLook) this.status++;
    else if (event.button === 0) this.moveState.forward = 1; else if (event.button === 2) this.moveState.back = 1;
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled || this.dragToLook && this.status <= 0) return;
    const p = this.local(event), e = this.element!, hw = Math.max(1, e.clientWidth) / 2, hh = Math.max(1, e.clientHeight) / 2;
    this.moveState.yawLeft = -(p.x - hw) / hw; this.moveState.pitchDown = (p.y - hh) / hh;
    this.moveState.yawRight = 0; this.moveState.pitchUp = 0;
  };
  private readonly onUp = (event: PointerEvent): void => {
    this.release(event.pointerId);
    if (this.dragToLook) {this.status = Math.max(0, this.status - 1); this.moveState.yawLeft = this.moveState.pitchDown = 0;}
    else if (event.button === 0) this.moveState.forward = 0; else if (event.button === 2) this.moveState.back = 0;
  };
  private readonly onCancel = (event: PointerEvent): void => {
    this.release(event.pointerId);
    if (this.dragToLook) {this.status = 0; this.moveState.yawLeft = this.moveState.pitchDown = 0;}
    else this.moveState.forward = this.moveState.back = 0;
  };
}
