import { Camera, type Vec3 } from './camera.js';
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
    this.pointer = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      pan: event.button !== 0 || event.shiftKey,
    };
    this.element.setPointerCapture(event.pointerId);
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
      throw new RangeError('Invalid pivot');
    this.camera.target = [...point];
    this.camera.cancelFit();
  }
  orbit(azimuth: number, elevation: number): void {
    if (![azimuth, elevation].every(Number.isFinite)) throw new RangeError('Invalid orbit');
    this.camera.cancelFit();
    const c = this.camera,
      p = c.position.map((v, i) => v - c.target[i]),
      r = Math.hypot(...p),
      u = p[0] || p[2] ? p : c.up.map((v) => -v * p[1]),
      theta = Math.atan2(u[0], u[2]) + azimuth,
      phi = Math.max(0.001, Math.min(Math.PI - 0.001, Math.acos(p[1] / r) + elevation));
    c.position = [
      c.target[0] + r * Math.sin(phi) * Math.sin(theta),
      c.target[1] + r * Math.cos(phi),
      c.target[2] + r * Math.sin(phi) * Math.cos(theta),
    ];
  }
  pan(x: number, y: number): void {
    if (![x, y].every(Number.isFinite)) throw new RangeError('Invalid pan');
    this.camera.cancelFit();
    const c = this.camera,
      d = c.position.map((v, i) => v - c.target[i]),
      r = Math.hypot(...d),
      h = Math.hypot(d[0], d[2]),
      right = [d[2] / h, 0, -d[0] / h],
      up = [(-d[1] * right[2]) / r, h / r, (d[1] * right[0]) / r],
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
