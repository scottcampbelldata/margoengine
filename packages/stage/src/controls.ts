import type { Camera, Vec3 } from '@margoengine/core';
import { rangeError } from '../../shared/errors.js';
const dot = (p: readonly number[], q: readonly number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
/**
 * An orthonormal frame [a, u, b] with u = normalized `up` and a = u x b, so +Y up gives the X, Y, Z axes: b is world +Z
 * with its part along u removed (world +Y when up is along Z).
 */
function frame(up: readonly number[]): [number[], number[], number[]] {
  const length = Math.hypot(up[0], up[1], up[2]);
  if (!length || !Number.isFinite(length)) throw rangeError('Invalid camera up: pass a nonzero [x, y, z]', 'camera');
  const u = [up[0] / length, up[1] / length, up[2] / length],
    seed = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0],
    along = dot(seed, u),
    raw = seed.map((v, i) => v - along * u[i]),
    size = Math.hypot(raw[0], raw[1], raw[2]),
    b = raw.map((v) => v / size);
  return [[u[1] * b[2] - u[2] * b[1], u[2] * b[0] - u[0] * b[2], u[0] * b[1] - u[1] * b[0]], u, b];
}

/**
 * Pointer orbit/pan/zoom for a {@link Camera} on a canvas: left drag orbits, middle/right or Shift+left drag pans, the
 * wheel zooms between 2x `near` and 0.8x `far`. Call `update(delta)` each frame (seconds) to apply wheel zoom, and
 * `dispose` to remove the listeners.
 */
export class CADCameraControls {
  private pointer?: { id: number; x: number; y: number; pan: boolean };
  private velocity = 0;
  private readonly previousTouchAction: string;
  constructor(
    readonly camera: Camera,
    readonly element: HTMLCanvasElement,
  ) {
    this.previousTouchAction = element.style.touchAction;
    try {
      element.style.touchAction = 'none';
      element.addEventListener('pointerdown', this.down);
      element.addEventListener('pointermove', this.move);
      element.addEventListener('pointerup', this.up);
      element.addEventListener('pointercancel', this.up);
      element.addEventListener('wheel', this.wheel, { passive: false });
      element.addEventListener('contextmenu', this.menu);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }
  private readonly menu = (event: Event) => event.preventDefault();
  private readonly down = (event: PointerEvent) => {
    if (![0, 1, 2].includes(event.button) || this.pointer) return;
    this.camera.cancelFit();
    this.element.setPointerCapture(event.pointerId);
    this.pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pan: event.button !== 0 || event.shiftKey,
    };
  };
  private readonly move = (event: PointerEvent) => {
    const p = this.pointer;
    if (!p || p.id !== event.pointerId) return;
    const x = (event.clientX - p.x) / Math.max(1, this.element.clientHeight),
      y = (event.clientY - p.y) / Math.max(1, this.element.clientHeight);
    p.x = event.clientX;
    p.y = event.clientY;
    if (p.pan) this.pan(x, y);
    else this.orbit(-x * Math.PI * 2, -y * Math.PI * 2);
  };
  private readonly up = (event: PointerEvent) => {
    if (this.pointer?.id === event.pointerId) {
      this.pointer = undefined;
      if (this.element.hasPointerCapture(event.pointerId)) this.element.releasePointerCapture(event.pointerId);
    }
  };
  private readonly wheel = (event: WheelEvent) => {
    event.preventDefault();
    this.camera.cancelFit();
    this.velocity += Math.max(
      -1,
      Math.min(
        1,
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.element.clientHeight : 1) * 0.001,
      ),
    );
  };
  setPivot(point: Vec3): void {
    if (
      point.length !== 3 ||
      !point.every(Number.isFinite) ||
      Math.hypot(...point.map((v, i) => v - this.camera.position[i])) <= this.camera.near
    )
      throw rangeError('Invalid pivot', 'camera');
    this.camera.target = [...point];
    this.camera.cancelFit();
  }
  /**
   * Turntable orbit about `camera.up` (any direction, not only +Y): `azimuth` turns about it, `elevation` tilts toward
   * it, stopping 0.001 rad short of either pole.
   */
  orbit(azimuth: number, elevation: number): void {
    if (![azimuth, elevation].every(Number.isFinite)) throw rangeError('Invalid orbit', 'camera');
    this.camera.cancelFit();
    const c = this.camera,
      p = c.position.map((v, i) => v - c.target[i]),
      r = Math.hypot(...p);
    if (!r || !Number.isFinite(r)) throw rangeError('Invalid orbit', 'camera');
    const [a, u, b] = frame(c.up),
      x = dot(p, a),
      z = dot(p, b),
      theta = (x || z ? Math.atan2(x, z) : 0) + azimuth,
      phi = Math.max(0.001, Math.min(Math.PI - 0.001, Math.acos(Math.max(-1, Math.min(1, dot(p, u) / r))) + elevation)),
      s = r * Math.sin(phi);
    c.position = c.target.map(
      (v, i) => v + s * Math.sin(theta) * a[i] + r * Math.cos(phi) * u[i] + s * Math.cos(theta) * b[i],
    ) as unknown as Vec3;
  }
  /** Moves position and target together in the screen plane, whose up follows `camera.up`. */
  pan(x: number, y: number): void {
    if (![x, y].every(Number.isFinite)) throw rangeError('Invalid pan', 'camera');
    this.camera.cancelFit();
    const c = this.camera,
      d = c.position.map((v, i) => v - c.target[i]),
      r = Math.hypot(...d);
    if (!r || !Number.isFinite(r)) throw rangeError('Invalid pan', 'camera');
    const [a, u] = frame(c.up),
      cross = [u[1] * d[2] - u[2] * d[1], u[2] * d[0] - u[0] * d[2], u[0] * d[1] - u[1] * d[0]],
      h = Math.hypot(...cross),
      right = h ? cross.map((v) => v / h) : a,
      up = [
        (d[1] * right[2] - d[2] * right[1]) / r,
        (d[2] * right[0] - d[0] * right[2]) / r,
        (d[0] * right[1] - d[1] * right[0]) / r,
      ],
      scale = 2 * r * Math.tan((c.fov * Math.PI) / 360),
      offset = right.map((v, i) => (-x * v + y * up[i]) * scale);
    c.position = c.position.map((v, i) => v + offset[i]) as unknown as Vec3;
    c.target = c.target.map((v, i) => v + offset[i]) as unknown as Vec3;
  }
  update(delta: number): void {
    if (!this.velocity) return;
    const step = this.velocity * (1 - Math.exp(-12 * delta));
    this.velocity -= step;
    if (!step) return;
    const c = this.camera,
      d = c.position.map((v, i) => v - c.target[i]),
      r = Math.hypot(...d),
      next = Math.max(c.near * 2, Math.min(c.far * 0.8, r * Math.exp(step)));
    c.position = c.target.map((v, i) => v + (d[i] / r) * next) as unknown as Vec3;
  }
  dispose(): void {
    if (this.pointer && this.element.hasPointerCapture(this.pointer.id))
      this.element.releasePointerCapture(this.pointer.id);
    this.pointer = undefined;
    this.element.style.touchAction = this.previousTouchAction;
    this.element.removeEventListener('pointerdown', this.down);
    this.element.removeEventListener('pointermove', this.move);
    this.element.removeEventListener('pointerup', this.up);
    this.element.removeEventListener('pointercancel', this.up);
    this.element.removeEventListener('wheel', this.wheel);
    this.element.removeEventListener('contextmenu', this.menu);
  }
}
