import type { Camera, EngineKernel } from '@margoengine/core';
import { Controls, documentOf, type ControlElement, type EventTargetLike } from './controls.js';
import { EPS, madd, type V3 } from './math.js';
import { scale, sub } from '@margoengine/math/vec3';
import { clamp } from '@margoengine/math/mathutils';
import { basis } from './view.js';
import { translate } from './fly.js';

const DEG = Math.PI / 180;

/**
 * First-person walk-through (three.js `FirstPersonControls`): the pointer offset from the canvas center keeps
 * turning the view, WASD or arrows move, R/F move up and down, left button walks forward and right button back.
 * Latitude is limited to +/-85 degrees, so the Y-up camera never looks straight up or down.
 */
export class FirstPersonControls extends Controls {
  movementSpeed = 1;
  /** Radians per second per pixel of pointer offset from the center. */
  lookSpeed = 0.005;
  lookVertical = true;
  autoForward = false;
  activeLook = true;
  heightSpeed = false;
  heightCoef = 1;
  heightMin = 0;
  heightMax = 1;
  constrainVertical = false;
  verticalMin = 0;
  verticalMax = Math.PI;
  mouseDragOn = false;
  readonly moveState = { forward: false, backward: false, left: false, right: false, up: false, down: false };
  /** Pointer offset from the element center in CSS pixels. */
  pointerX = 0;
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
    this.setOrientation();
    this.init();
  }
  protected get kind(): string {
    return 'first-person';
  }
  protected bind(element: ControlElement) {
    const keys = this.keyTarget ?? documentOf(element);
    return [
      [element, 'pointerdown', this.onDown],
      [element, 'pointermove', this.onMove],
      [element, 'pointerup', this.onUp],
      [element, 'pointercancel', this.onUp],
      [element, 'contextmenu', this.onMenu],
      [keys, 'keydown', this.onKeyDown],
      [keys, 'keyup', this.onKeyUp],
    ] as Array<[EventTargetLike, string, (event: any) => void, AddEventListenerOptions?]>;
  }
  protected onDisconnect(): void {
    for (const key of Object.keys(this.moveState)) this.moveState[key as keyof typeof this.moveState] = false;
    this.mouseDragOn = false;
  }

  /** Points the camera at a world position and resynchronizes latitude and longitude. */
  lookAt(x: number | readonly number[], y?: number, z?: number): this {
    const point: V3 = typeof x === 'number' ? [x, y ?? 0, z ?? 0] : [x[0], x[1], x[2]];
    this.camera.target = point;
    this.setOrientation();
    return this;
  }
  /** Latitude and longitude in degrees. */
  get latitude(): number {
    return this.lat;
  }
  get longitude(): number {
    return this.lon;
  }

  update(delta = 1 / 60): boolean {
    const c = this.camera,
      before = [...c.position, ...c.target],
      s = this.moveState;
    let autoSpeed = 0;
    if (this.heightSpeed)
      autoSpeed = delta * (clamp(c.position[1], this.heightMin, this.heightMax) - this.heightMin) * this.heightCoef;
    const speed = delta * this.movementSpeed,
      b = basis(c);
    let offset: V3 = [0, 0, 0];
    if (s.forward || (this.autoForward && !s.backward)) offset = madd(offset, b.forward, speed + autoSpeed);
    if (s.backward) offset = madd(offset, b.forward, -speed);
    if (s.left) offset = madd(offset, b.right, -speed);
    if (s.right) offset = madd(offset, b.right, speed);
    if (s.up) offset = madd(offset, b.up, speed);
    if (s.down) offset = madd(offset, b.up, -speed);
    translate(c, offset);
    const look = this.activeLook ? delta * this.lookSpeed : 0;
    const ratio = this.constrainVertical ? Math.PI / (this.verticalMax - this.verticalMin) : 1;
    this.lon -= (this.pointerX * look) / DEG;
    if (this.lookVertical) this.lat -= (this.pointerY * look * ratio) / DEG;
    this.lat = clamp(this.lat, -85, 85);
    let phi = (90 - this.lat) * DEG;
    const theta = this.lon * DEG;
    if (this.constrainVertical) phi = this.verticalMin + (phi / Math.PI) * (this.verticalMax - this.verticalMin);
    phi = clamp(phi, 1e-3, Math.PI - 1e-3);
    const distance = Math.max(b.distance, EPS);
    c.target = madd(
      c.position,
      [Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)],
      distance,
    );
    const after = [...c.position, ...c.target],
      moved = before.some((v, i) => Math.abs(v - after[i]) > EPS);
    if (moved) this.dispatchEvent({ type: 'change' });
    return moved;
  }

  private setOrientation(): void {
    const d = sub(this.camera.target, this.camera.position),
      r = Math.hypot(...d) || 1,
      n = scale(d, 1 / r);
    this.lat = 90 - Math.acos(clamp(n[1], -1, 1)) / DEG;
    this.lon = Math.atan2(n[0], n[2]) / DEG;
  }
  private readonly onMenu = (event: Event): void => {
    if (this.enabled) event.preventDefault();
  };
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
      if (event.button === 0 || event.type === 'pointercancel') this.moveState.forward = false;
      if (event.button === 2 || event.type === 'pointercancel') this.moveState.backward = false;
    }
    this.mouseDragOn = false;
  };
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const p = this.local(event),
      e = this.element!;
    this.pointerX = p.x - e.clientWidth / 2;
    this.pointerY = p.y - e.clientHeight / 2;
  };
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.enabled) this.key(event.code, true);
  };
  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.key(event.code, false);
  };
  private key(code: string, value: boolean): void {
    const s = this.moveState;
    switch (code) {
      case 'ArrowUp':
      case 'KeyW':
        s.forward = value;
        break;
      case 'ArrowLeft':
      case 'KeyA':
        s.left = value;
        break;
      case 'ArrowDown':
      case 'KeyS':
        s.backward = value;
        break;
      case 'ArrowRight':
      case 'KeyD':
        s.right = value;
        break;
      case 'KeyR':
        s.up = value;
        break;
      case 'KeyF':
        s.down = value;
        break;
    }
  }
}
