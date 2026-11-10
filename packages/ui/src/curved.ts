import { WorldPanel, type WorldPanelOptions, type PanelHit, type UiRay } from '@margoengine/ui/world';
import type { Ui } from '@margoengine/ui';
import { rangeError } from '../../shared/errors.js';

/** Surface dimensions are arc lengths in metres, with the centre tangent to local Z=0. */
export interface CurvedPanelOptions extends WorldPanelOptions {
  /** Default 'cylinder'. A sphere curves vertically as well. */
  shape?: 'cylinder' | 'sphere';
  /** Radius in metres, default 2. Width must be below one circumference; sphere height below pi*radius. */
  radius?: number;
  /** Tessellation per curved axis, default 64, integer 4..512. Rays always hit the analytic surface. */
  segments?: number;
}
/** Textured cylinder or sphere patch, usable by either world-panel renderer and its XR ray router. */
export class CurvedPanel extends WorldPanel {
  readonly shape: 'cylinder' | 'sphere';
  readonly radius: number;
  readonly segments: number;
  constructor(ui: Ui, options: CurvedPanelOptions = {}) {
    super(ui, options);
    this.shape = options.shape ?? 'cylinder';
    this.radius = options.radius ?? 2;
    this.segments = options.segments ?? 64;
    if (
      !['cylinder', 'sphere'].includes(this.shape) ||
      !(this.radius > 0) ||
      !Number.isFinite(this.radius) ||
      !Number.isInteger(this.segments) ||
      this.segments < 4 ||
      this.segments > 512 ||
      this.width >= 2 * Math.PI * this.radius ||
      (this.shape === 'sphere' && this.height >= Math.PI * this.radius)
    )
      throw rangeError(
        'Use cylinder or sphere, positive radius, 4..512 segments and arc sizes below a full wrap',
        'ui',
      );
  }
  override get surface(): readonly [number, number, number, number] {
    return [this.radius, this.shape === 'sphere' ? 2 : 1, this.segments, this.shape === 'sphere' ? this.segments : 1];
  }
  /** Curved patches require per-fragment sidedness, rather than a single plane-side rejection. */
  override side(_eye: ArrayLike<number>): number {
    return 1;
  }
  /** Local position at normalized UI coordinates; also defines the render and hit parameterization. */
  pointAt(u: number, v: number): [number, number, number] {
    const r = this.radius,
      a = ((u - 0.5) * this.width) / r,
      b = ((0.5 - v) * this.height) / r;
    return [
      r * Math.sin(a) * (this.shape === 'sphere' ? Math.cos(b) : 1),
      this.shape === 'sphere' ? r * Math.sin(b) : (0.5 - v) * this.height,
      r * (Math.cos(a) * (this.shape === 'sphere' ? Math.cos(b) : 1) - 1),
    ];
  }
  override intersect(ray: UiRay): PanelHit | null {
    const m = this.matrix,
      sphere = this.shape === 'sphere',
      r = this.radius;
    const origin = [0, 1, 2].map((i) => ray.origin[i] - m[12 + i]);
    const o = [0, 4, 8].map((i) => origin[0] * m[i] + origin[1] * m[i + 1] + origin[2] * m[i + 2]);
    const d = [0, 4, 8].map((i) => ray.direction[0] * m[i] + ray.direction[1] * m[i + 1] + ray.direction[2] * m[i + 2]);
    o[2] += r;
    const axes = sphere ? [0, 1, 2] : [0, 2];
    const a = axes.reduce((s, i) => s + d[i] * d[i], 0),
      b = 2 * axes.reduce((s, i) => s + o[i] * d[i], 0),
      c = axes.reduce((s, i) => s + o[i] * o[i], -r * r),
      disc = b * b - 4 * a * c;
    if (!(a > 0) || !(disc >= 0) || !Number.isFinite(disc)) return null;
    const q = -0.5 * (b + (b < 0 ? -1 : 1) * Math.sqrt(disc));
    const roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q].sort((x, y) => x - y);
    let outside: PanelHit | null = null;
    for (const t of roots) {
      if (t < 0) continue;
      const p = o.map((x, i) => x + t * d[i]);
      const back = axes.reduce((s, i) => s + p[i] * d[i], 0) > 0;
      if (back && !this.doubleSided) continue;
      let u = 0.5 + (Math.atan2(p[0], p[2]) * r) / this.width;
      const v = 0.5 - (sphere ? Math.asin(Math.max(-1, Math.min(1, p[1] / r))) * r : p[1]) / this.height;
      if (back) u = 1 - u;
      const hit: PanelHit = {
        distance: t,
        point: [
          ray.origin[0] + t * ray.direction[0],
          ray.origin[1] + t * ray.direction[1],
          ray.origin[2] + t * ray.direction[2],
        ],
        x: u * this.cssWidth,
        y: v * this.cssHeight,
        back,
        inside: u >= 0 && u <= 1 && v >= 0 && v <= 1,
      };
      if (hit.inside) return hit;
      outside ??= hit;
    }
    return outside;
  }
}

/** Options for a row-major XR menu arrangement. Existing panels retain their dimensions. */
export interface PanelLayoutOptions {
  /** Default 'plane'. */
  shape?: 'plane' | 'cylinder' | 'sphere';
  /** Default ceil(sqrt(panel count)). */
  columns?: number;
  /** Metres between panel centres along each arc, default [1.2, .8]. */
  spacing?: readonly [number, number];
  /** Radius, default 2. */
  radius?: number;
  /** Centre of the arrangement's tangent plane, default [0,0,0]. */
  position?: readonly [number, number, number];
  /** Face the centre of curvature, default false (outward-facing). */
  inward?: boolean;
}
/** Arrange any world panels on a plane, cylinder or sphere with tangent orientations. */
export function layoutPanels(panels: readonly WorldPanel[], options: PanelLayoutOptions = {}): void {
  const shape = options.shape ?? 'plane',
    columns = options.columns ?? Math.max(1, Math.ceil(Math.sqrt(panels.length))),
    [sx, sy] = options.spacing ?? [1.2, 0.8],
    r = options.radius ?? 2,
    base = options.position ?? [0, 0, 0];
  if (
    !['plane', 'cylinder', 'sphere'].includes(shape) ||
    !Number.isInteger(columns) ||
    columns < 1 ||
    ![sx, sy, r].every((x) => x > 0 && Number.isFinite(x)) ||
    !base.every(Number.isFinite)
  )
    throw rangeError(
      'Use a plane, cylinder or sphere, positive integer columns, positive spacing/radius and finite position',
      'ui',
    );
  const rows = Math.ceil(panels.length / columns);
  if (
    shape !== 'plane' &&
    ((Math.min(columns, panels.length) - 1) * sx >= 2 * Math.PI * r ||
      (shape === 'sphere' && (rows - 1) * sy >= Math.PI * r))
  )
    throw rangeError('Panel arrangement wraps onto itself; increase radius or reduce spacing', 'ui');
  panels.forEach((panel, i) => {
    const count = Math.min(columns, panels.length - Math.floor(i / columns) * columns),
      x = ((i % columns) - (count - 1) / 2) * sx,
      y = ((rows - 1) / 2 - Math.floor(i / columns)) * sy,
      a = shape === 'plane' ? 0 : x / r,
      b = shape === 'sphere' ? y / r : 0,
      yaw = a + (options.inward ? Math.PI : 0),
      pitch = options.inward ? b : -b,
      sa = Math.sin(yaw / 2),
      ca = Math.cos(yaw / 2),
      sb = Math.sin(pitch / 2),
      cb = Math.cos(pitch / 2);
    panel.setPose(
      [
        base[0] + (shape === 'plane' ? x : r * Math.sin(a) * Math.cos(b)),
        base[1] + (shape === 'sphere' ? r * Math.sin(b) : y),
        base[2] + (shape === 'plane' ? 0 : r * (Math.cos(a) * Math.cos(b) - 1)),
      ],
      [ca * sb, sa * cb, -sa * sb, ca * cb],
    );
  });
}
