import type {Camera, EngineKernel} from '@margoengine/core';
import {Controls, documentOf, type ControlElement, type EventTargetLike} from './controls.js';
import {EPS, madd, rotateAxis, type V3} from './math.js';
import {add, cross, length, normalize, scale, sub} from '@margoengine/math/vec3';
import {clamp} from '@margoengine/math/mathutils';
import {basis} from './view.js';
import {MOUSE} from './orbit.js';

type Mode = 'none' | 'rotate' | 'zoom' | 'pan' | 'touch-rotate' | 'touch-zoom-pan';
type Point = {x: number; y: number};

/**
 * Free trackball rotation around `camera.target` (three.js `TrackballControls`).
 *
 * Roll: the Margo Engine camera is defined by position and target and always renders with world +Y up, so it cannot
 * roll. three.js rotates `camera.up` along with the eye; here the screen axes are re-derived from +Y every
 * frame, the roll component is dropped, and the eye stops just short of the poles instead of tumbling over
 * them (crossing a pole would flip the image 180 degrees).
 */
export class TrackballControls extends Controls {
  rotateSpeed = 1; zoomSpeed = 1.2; panSpeed = 0.3;
  noRotate = false; noZoom = false; noPan = false;
  /** True stops as soon as the pointer stops; false keeps coasting with `dynamicDampingFactor`. */
  staticMoving = false;
  dynamicDampingFactor = 0.2;
  minDistance = 0; maxDistance = Infinity;
  /** Hold to make the left button rotate, zoom or pan. */
  keys = ['KeyA', 'KeyS', 'KeyD'];
  mouseButtons: {LEFT: number | null; MIDDLE: number | null; RIGHT: number | null} = {LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN};
  state: Mode = 'none';

  private keyMode: Mode = 'none';
  private readonly pointers = new Map<number, Point>();
  private movePrev: Point = {x: 0, y: 0}; private moveCurr: Point = {x: 0, y: 0};
  private lastAxis: V3 = [0, 1, 0]; private lastAngle = 0;
  private zoomStart = 0; private zoomEnd = 0;
  private touchStartSpread = 0; private touchEndSpread = 0;
  private panStart: Point = {x: 0, y: 0}; private panEnd: Point = {x: 0, y: 0};
  private previousTouchAction = '';
  private readonly keyTarget: EventTargetLike | null;
  private saved!: {position: V3; target: V3};

  constructor(source: Camera | EngineKernel, element?: ControlElement | null, options: {keyTarget?: EventTargetLike | null} = {}) {
    super(source, element);
    this.keyTarget = options.keyTarget ?? null;
    this.saveState();
    this.init();
  }
  protected get kind(): string {return 'trackball';}
  protected bind(element: ControlElement) {
    if (element.style) {this.previousTouchAction = element.style.touchAction; element.style.touchAction = 'none';}
    const keys = this.keyTarget ?? documentOf(element);
    return [
      [element, 'pointerdown', this.onDown], [element, 'pointermove', this.onMove], [element, 'pointerup', this.onUp],
      [element, 'pointercancel', this.onUp], [element, 'wheel', this.onWheel, {passive: false}], [element, 'contextmenu', this.onMenu],
      [keys, 'keydown', this.onKeyDown], [keys, 'keyup', this.onKeyUp],
    ] as Array<[EventTargetLike, string, (event: any) => void, AddEventListenerOptions?]>;
  }
  protected onDisconnect(): void {
    for (const id of this.pointers.keys()) this.release(id);
    this.pointers.clear(); this.state = this.keyMode = 'none';
    if (this.element?.style) this.element.style.touchAction = this.previousTouchAction;
  }
  saveState(): void {this.saved = {position: [...this.camera.position] as V3, target: [...this.camera.target] as V3};}
  reset(): void {
    this.camera.position = [...this.saved.position]; this.camera.target = [...this.saved.target];
    this.state = 'none'; this.lastAngle = 0; this.movePrev = this.moveCurr; this.zoomStart = this.zoomEnd; this.panStart = this.panEnd;
    this.touchStartSpread = this.touchEndSpread;
    this.dispatchEvent({type: 'change'});
  }

  update(delta = 1 / 60): boolean {
    const c = this.camera, before = [...c.position, ...c.target];
    // three.js applies its damping once per frame; scale the exponent so it is frame-rate independent.
    const frames = Math.max(0, delta) * 60;
    let eye = sub(c.position, c.target);
    if (!this.noRotate) eye = this.rotate(eye, frames);
    if (!this.noZoom) eye = this.zoom(eye, frames);
    let target: V3 = [...c.target] as V3;
    if (!this.noPan) {const pan = this.pan(eye, frames); target = add(target, pan);}
    const distance = length(eye), clamped = clamp(distance, Math.max(this.minDistance, EPS), this.maxDistance);
    if (distance && clamped !== distance) eye = scale(eye, clamped / distance);
    c.target = target; c.position = add(target, eye);
    const after = [...c.position, ...c.target];
    const moved = before.some((v, i) => Math.abs(v - after[i]) > EPS);
    if (moved) this.dispatchEvent({type: 'change'});
    return moved;
  }

  private rotate(eye: V3, frames: number): V3 {
    const dx = this.moveCurr.x - this.movePrev.x, dy = this.moveCurr.y - this.movePrev.y;
    let angle = Math.hypot(dx, dy), axis: V3;
    if (angle) {
      const b = basis(this.camera), sideways = normalize(cross(b.up, normalize(eye)));
      const move = add(scale(b.up, dy), scale(sideways, dx));
      axis = normalize(cross(move, eye)); angle *= this.rotateSpeed;
      this.lastAxis = axis; this.lastAngle = angle;
    } else if (!this.staticMoving && this.lastAngle) {
      this.lastAngle *= Math.pow(Math.sqrt(1 - this.dynamicDampingFactor), frames);
      if (Math.abs(this.lastAngle) < 1e-9) this.lastAngle = 0;
      axis = this.lastAxis; angle = this.lastAngle;
    } else {this.movePrev = this.moveCurr; return eye;}
    this.movePrev = this.moveCurr;
    return keepOffPoles(eye, axis, angle);
  }
  private zoom(eye: V3, frames: number): V3 {
    if (this.state === 'touch-zoom-pan') {
      const factor = this.touchEndSpread ? this.touchStartSpread / this.touchEndSpread : 1;
      this.touchStartSpread = this.touchEndSpread;
      return factor > 0 ? scale(eye, factor) : eye;
    }
    const factor = 1 + (this.zoomEnd - this.zoomStart) * this.zoomSpeed;
    if (factor !== 1 && factor > 0) eye = scale(eye, factor);
    if (this.staticMoving) this.zoomStart = this.zoomEnd;
    else {this.zoomStart += (this.zoomEnd - this.zoomStart) * (1 - Math.pow(1 - this.dynamicDampingFactor, frames)); if (Math.abs(this.zoomEnd - this.zoomStart) < 1e-9) this.zoomStart = this.zoomEnd;}
    return eye;
  }
  private pan(eye: V3, frames: number): V3 {
    const dx = (this.panEnd.x - this.panStart.x) * length(eye) * this.panSpeed, dy = (this.panEnd.y - this.panStart.y) * length(eye) * this.panSpeed;
    if (!dx && !dy) return [0, 0, 0];
    const b = basis(this.camera), offset = madd(scale(normalize(cross(eye, b.up)), dx), b.up, dy);
    if (this.staticMoving) this.panStart = this.panEnd;
    else {
      const k = 1 - Math.pow(1 - this.dynamicDampingFactor, frames);
      this.panStart = {x: this.panStart.x + (this.panEnd.x - this.panStart.x) * k, y: this.panStart.y + (this.panEnd.y - this.panStart.y) * k};
    }
    return offset;
  }

  private onScreen(p: Point): Point {const e = this.element!; return {x: p.x / Math.max(1, e.clientWidth), y: p.y / Math.max(1, e.clientHeight)};}
  private onCircle(p: Point): Point {const e = this.element!, w = Math.max(1, e.clientWidth), h = Math.max(1, e.clientHeight); return {x: (p.x - w / 2) / (w / 2), y: (h - 2 * p.y) / w};}

  private readonly onMenu = (event: Event): void => {if (this.enabled) event.preventDefault();};
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || this.keyMode !== 'none') return;
    const index = this.keys.indexOf(event.code);
    if (index === 0 && !this.noRotate) this.keyMode = 'rotate'; else if (index === 1 && !this.noZoom) this.keyMode = 'zoom'; else if (index === 2 && !this.noPan) this.keyMode = 'pan';
  };
  private readonly onKeyUp = (): void => {this.keyMode = 'none';};
  private readonly onDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.capture(event.pointerId);
    const p = this.local(event); this.pointers.set(event.pointerId, p);
    if (event.pointerType === 'touch') {this.touchStart(); return;}
    if (this.pointers.size > 1) return;
    const action = event.button === 0 ? this.mouseButtons.LEFT : event.button === 1 ? this.mouseButtons.MIDDLE : event.button === 2 ? this.mouseButtons.RIGHT : null;
    let mode: Mode = this.keyMode !== 'none' ? this.keyMode : action === MOUSE.ROTATE ? 'rotate' : action === MOUSE.DOLLY ? 'zoom' : action === MOUSE.PAN ? 'pan' : 'none';
    if (mode === 'rotate' && this.noRotate || mode === 'zoom' && this.noZoom || mode === 'pan' && this.noPan) mode = 'none';
    if (mode === 'none') {this.pointers.delete(event.pointerId); this.release(event.pointerId); return;}
    this.state = mode;
    if (mode === 'rotate') {this.moveCurr = this.onCircle(p); this.movePrev = this.moveCurr;}
    else if (mode === 'zoom') {this.zoomStart = this.zoomEnd = this.onScreen(p).y;}
    else {this.panStart = this.panEnd = this.onScreen(p);}
    this.dispatchEvent({type: 'start'});
  };
  private touchStart(): void {
    const points = [...this.pointers.values()];
    if (points.length === 1) {this.state = 'touch-rotate'; this.moveCurr = this.onCircle(points[0]); this.movePrev = this.moveCurr;}
    else {
      const [a, b] = points; this.state = 'touch-zoom-pan';
      this.touchStartSpread = this.touchEndSpread = Math.hypot(a.x - b.x, a.y - b.y);
      this.panStart = this.panEnd = this.onScreen({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
    }
    this.dispatchEvent({type: 'start'});
  }
  private readonly onMove = (event: PointerEvent): void => {
    if (!this.enabled) {if (this.pointers.size) {for (const id of this.pointers.keys()) this.release(id); this.pointers.clear(); this.state = 'none'; this.dispatchEvent({type: 'end'});} return;}
    if (!this.pointers.has(event.pointerId)) return;
    const p = this.local(event); this.pointers.set(event.pointerId, p);
    if (this.state === 'rotate' || this.state === 'touch-rotate') {this.movePrev = this.moveCurr; this.moveCurr = this.onCircle(p);}
    else if (this.state === 'zoom') this.zoomEnd = this.onScreen(p).y;
    else if (this.state === 'pan') this.panEnd = this.onScreen(p);
    else if (this.state === 'touch-zoom-pan') {
      const [a, b] = [...this.pointers.values()];
      this.touchEndSpread = Math.hypot(a.x - b.x, a.y - b.y);
      this.panEnd = this.onScreen({x: (a.x + b.x) / 2, y: (a.y + b.y) / 2});
    }
  };
  private readonly onUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    this.release(event.pointerId);
    if (this.pointers.size && event.pointerType === 'touch') {this.touchStart(); return;}
    if (!this.pointers.size) {this.state = 'none'; this.dispatchEvent({type: 'end'});}
  };
  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || this.noZoom) return;
    event.preventDefault();
    this.zoomStart -= event.deltaY * (event.deltaMode === 2 ? 0.025 : event.deltaMode === 1 ? 0.01 : 0.00025);
    this.dispatchEvent({type: 'start'}); this.dispatchEvent({type: 'end'});
  };
}

/**
 * Rotates `eye` around `axis`, stopping just short of the +Y/-Y poles the Y-up camera cannot represent.
 * The arc is sampled so a large single step cannot jump across a pole either.
 */
function keepOffPoles(eye: V3, axis: V3, angle: number): V3 {
  const r = length(eye), limit = Math.sin(1e-3) * r, steps = Math.max(1, Math.ceil(Math.abs(angle) / 0.05));
  let previous = eye;
  for (let i = 1; i <= steps; i++) {
    const v = rotateAxis(eye, axis, angle * i / steps);
    // Reaching the axis, or the horizontal direction flipping, means the arc passed over a pole.
    if (Math.hypot(v[0], v[2]) >= limit && previous[0] * v[0] + previous[2] * v[2] > 0) {previous = v; continue;}
    const h = Math.hypot(previous[0], previous[2]) || 1;
    return [previous[0] / h * limit, Math.sign(previous[1] || 1) * Math.sqrt(Math.max(0, r * r - limit * limit)), previous[2] / h * limit];
  }
  return rotateAxis(eye, axis, angle);
}
