import type { Camera, EngineKernel } from '@margoengine/core';
import {
  Controls,
  documentOf,
  type ControlElement,
  type EventTargetLike,
  type InputEventListener,
} from './controls.js';
import { EPS, finiteInput, madd } from './math.js';
import { basis } from './view.js';
import { moved, translate } from './steer.js';

const DEGREES = 180 / Math.PI;
// Latitude limit in degrees: one degree short of straight up or down. Any value below 90 keeps the world-up camera's
// screen frame defined; one degree still lets the view look almost vertically.
const LATITUDE_LIMIT = 89;
// Smallest distance of the final polar angle from the poles, in radians (after the constrainVertical remap).
const POLAR_GAP = 1e-3;

/**
 * First-person walk-through. The pointer's offset from the element centre keeps turning the view (`lookSpeed`
 * radians per second per CSS pixel), W/A/S/D or the arrow keys move, R/F move along the screen up axis, and with
 * `activeLook` the left button walks forward and the right button back. Latitude is limited to plus or minus
 * 89 degrees so the world-up camera never looks straight up or down. Every update points the target from latitude
 * and longitude; use `lookAt` to aim at a world position. Keys are read from `keyTarget` (default the element's
 * document). Events: `change`.
 */
export class FirstPersonControls extends Controls {
  /** Walking speed in world units per second. Default 1. */
  movementSpeed = 1;
  /** Turn rate in radians per second per CSS pixel of pointer offset from the element centre. Default 0.005. */
  lookSpeed = 0.005;
  /** Let the vertical pointer offset change the latitude. Default true. */
  lookVertical = true;
  /** Keep walking forward unless backward is held. Default false. */
  autoForward = false;
  /** Pointer look and button walking. Default true. */
  activeLook = true;
  /** Walk forward faster the higher the camera is (see `heightCoef`, `heightMin`, `heightMax`). Default false. */
  heightSpeed = false;
  /** Extra forward speed per unit of camera height above `heightMin`, when `heightSpeed`. Default 1. */
  heightCoef = 1;
  /** Height at which the extra forward speed starts. Default 0. */
  heightMin = 0;
  /** Height above which the extra forward speed stops growing. Default 1. */
  heightMax = 1;
  /** Map the full vertical look range onto [`verticalMin`, `verticalMax`]. Default false. */
  constrainVertical = false;
  /** Smallest polar angle (radians from +Y) when `constrainVertical`. Default 0. */
  verticalMin = 0;
  /** Largest polar angle (radians from +Y) when `constrainVertical`. Default PI. */
  verticalMax = Math.PI;
  /** True while a pointer button is held. */
  mouseDragOn = false;
  /** Movement keys and buttons currently held. */
  readonly moveState = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  /** Pointer offset from the element centre in CSS pixels, x right. */
  pointerX = 0;
  /** Pointer offset from the element centre in CSS pixels, y down. */
  pointerY = 0;
  private lat = 0;
  private lon = 0;
  private readonly keyTarget: EventTargetLike | null;

  constructor(
    source: Camera | EngineKernel,
    element?: ControlElement | null,
    options: { keyTarget?: EventTargetLike | null } = {},
  ) {
    super(source, element);
    this.keyTarget = options.keyTarget ?? null;
    this.sync();
    this.init();
  }
  protected override get kind(): string {
    return 'first-person';
  }
  protected bind(
    element: ControlElement,
  ): Array<[EventTargetLike, string, InputEventListener, AddEventListenerOptions?]> {
    const keys = this.keyTarget ?? documentOf(element);
    return [
      [element, 'pointerdown', this.onDown as InputEventListener],
      [element, 'pointermove', this.onMove as InputEventListener],
      [element, 'pointerup', this.onUp as InputEventListener],
      [element, 'pointercancel', this.onUp as InputEventListener],
      [element, 'contextmenu', this.onContextMenu as InputEventListener],
      [keys, 'keydown', this.onKeyDown as InputEventListener],
      [keys, 'keyup', this.onKeyUp as InputEventListener],
    ];
  }
  protected override onDisconnect(): void {
    const state = this.moveState as Record<string, boolean>;
    for (const key in state) state[key] = false;
    this.mouseDragOn = false;
  }

  /** Points the camera at a world position (three numbers or an array) and resynchronises latitude and longitude. */
  lookAt(x: number | readonly number[], y = 0, z = 0): this {
    const target: [number, number, number] = typeof x === 'number' ? [x, y, z] : [x[0], x[1], x[2]];
    finiteInput('First-person look target', ...target);
    this.camera.target = target;
    this.sync();
    return this;
  }
  /** Elevation of the view above the horizon, in degrees. */
  get latitude(): number {
    return this.lat;
  }
  /** Heading in degrees, `atan2(dir.x, dir.z)`: 0 looks toward +Z, 180 toward -Z. */
  get longitude(): number {
    return this.lon;
  }

  /** Walks and turns for `delta` seconds (default 1/60). Returns true when the camera moved. */
  update(delta = 1 / 60): boolean {
    finiteInput('First-person update step', delta);
    const camera = this.camera,
      before = [...camera.position, ...camera.target],
      s = this.moveState,
      speed = delta * this.movementSpeed,
      frame = basis(camera);
    const height = Math.min(Math.max(camera.position[1], this.heightMin), this.heightMax),
      boost = this.heightSpeed ? delta * (height - this.heightMin) * this.heightCoef : 0;
    let along = 0;
    if (s.forward || (this.autoForward && !s.backward)) along += speed + boost;
    if (s.backward) along -= speed;
    const across = (+s.right - +s.left) * speed,
      lift = (+s.up - +s.down) * speed;
    if (along || across || lift)
      translate(camera, madd(madd(madd([0, 0, 0], frame.forward, along), frame.right, across), frame.up, lift));

    const look = this.activeLook ? delta * this.lookSpeed : 0;
    this.lon -= this.pointerX * look * DEGREES;
    if (this.lookVertical) {
      const ratio = this.constrainVertical ? Math.PI / (this.verticalMax - this.verticalMin) : 1;
      this.lat -= this.pointerY * look * ratio * DEGREES;
    }
    this.lat = Math.max(-LATITUDE_LIMIT, Math.min(LATITUDE_LIMIT, this.lat));

    let polar = (90 - this.lat) / DEGREES;
    if (this.constrainVertical) polar = this.verticalMin + (polar / Math.PI) * (this.verticalMax - this.verticalMin);
    polar = Math.max(POLAR_GAP, Math.min(Math.PI - POLAR_GAP, polar));
    const heading = this.lon / DEGREES,
      p = camera.position,
      t = camera.target,
      distance = Math.max(Math.hypot(t[0] - p[0], t[1] - p[1], t[2] - p[2]), EPS),
      ring = Math.sin(polar) * distance;
    camera.target = [
      p[0] + ring * Math.sin(heading),
      p[1] + Math.cos(polar) * distance,
      p[2] + ring * Math.cos(heading),
    ];

    const changed = moved(before, camera);
    if (changed) this.dispatchEvent({ type: 'change' });
    return changed;
  }

  /** Reads latitude and longitude from the camera's current view direction. */
  private sync(): void {
    const view = basis(this.camera).forward;
    this.lat = 90 - Math.acos(Math.max(-1, Math.min(1, view[1]))) * DEGREES;
    this.lon = Math.atan2(view[0], view[2]) * DEGREES;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.enabled) this.key(event.code, true);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.key(event.code, false);
  };
  private key(code: string, held: boolean): void {
    const s = this.moveState;
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        s.forward = held;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        s.left = held;
        break;
      case 'ArrowDown':
      case 'KeyS':
        s.backward = held;
        break;
      case 'ArrowRight':
      case 'KeyD':
        s.right = held;
        break;
      case 'KeyR':
        s.up = held;
        break;
      case 'KeyF':
        s.down = held;
        break;
    }
  }
  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.capture(event.pointerId);
    if (this.activeLook) {
      if (event.button === 0) this.moveState.forward = true;
      else if (event.button === 2) this.moveState.backward = true;
    }
    this.mouseDragOn = true;
  };
  private readonly onUp = (event: PointerEvent): void => {
    this.release(event.pointerId);
    if (this.activeLook) {
      const cancel = event.type === 'pointercancel';
      if (cancel || event.button === 0) this.moveState.forward = false;
      if (cancel || event.button === 2) this.moveState.backward = false;
    }
    this.mouseDragOn = false;
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled || !this.element) return;
    const { x, y } = this.local(event);
    this.pointerX = x - this.element.clientWidth / 2;
    this.pointerY = y - this.element.clientHeight / 2;
  };
  private readonly onContextMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
}
