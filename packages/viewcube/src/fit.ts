import type { EngineKernel } from '@margoengine/core';
import { UpViewCube, type UpViewCubeOptions } from './up.js';

/** World AABB as minX, minY, minZ, maxX, maxY, maxZ, evaluated at each view request. */
export type ViewBounds = ArrayLike<number> | (() => ArrayLike<number>);
/** CameraProjection's public framing fields; no cameras runtime dependency is required. */
export interface ViewFitProjection {
  mode: 'orthographic' | 'perspective';
  up?: [number, number, number];
  zoom: number;
  height?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  near?: number;
  far?: number;
  applyLens?(aspect: number): number;
}
/** Framing, world frame and inherited widget options. */
export interface FitViewCubeOptions extends UpViewCubeOptions {
  /** Bounds to frame. Default none; assign bounds before requesting a fitted view. */
  bounds?: ViewBounds;
  /** Multiplicative margin, at least 1. Default 1.1. */
  padding?: number;
  /** Viewport width / height. Default the chosen engine view's aspect. */
  aspect?: number | (() => number);
  /** A CameraProjection or equivalent; auto-detected when attached as the cameras plugin. */
  projection?: ViewFitProjection;
}

/** Frames bounds throughout face, edge, corner, keyboard, home and roll transitions. */
export class FitViewCube extends UpViewCube {
  /** Current world bounds or live bounds provider. Undefined disables automatic fitting. */
  bounds?: ViewBounds;
  /** Margin around the enclosing sphere. Default 1.1. */
  padding: number;
  private readonly aspectSource: () => number;
  private readonly fitProjection?: ViewFitProjection;
  private framing?: { center: number[]; radius: number; aspect: number };

  static override attach(engine: EngineKernel, options?: FitViewCubeOptions): FitViewCube {
    return new FitViewCube(engine, options);
  }
  constructor(engine: EngineKernel, options: FitViewCubeOptions = {}) {
    super(engine, { ...options, up: options.up ?? 'y' });
    this.bounds = options.bounds;
    this.padding = options.padding ?? 1.1;
    const aspect = options.aspect,
      view = options.view;
    this.aspectSource = () => {
      if (aspect !== undefined) return typeof aspect === 'function' ? aspect() : aspect;
      const [, , w, h] = view?.viewport ?? [0, 0, 1, 1];
      return (w / h) * (view?.pixels ? 1 : engine.canvas.width / engine.canvas.height);
    };
    this.fitProjection =
      options.projection ??
      (engine as unknown as { plugins?: ReadonlyMap<string, ViewFitProjection> }).plugins?.get('cameras');
  }
  /** Frames the current direction without changing its roll. Default duration is the widget duration. */
  fit(duration = this.duration): void {
    this.roll(0, duration);
  }
  override setProjection(mode: 'orthographic' | 'perspective'): void {
    super.setProjection(mode);
    if (this.bounds) this.fit(0);
  }
  protected override orbit(
    theta: number,
    phi: number,
    duration: number,
    to?: readonly number[],
    distance?: number,
    twist = 0,
  ): void {
    if (!this.bounds) return super.orbit(theta, phi, duration, to, distance, twist);
    const b = Array.from(typeof this.bounds === 'function' ? this.bounds() : this.bounds),
      aspect = this.aspectSource(),
      padding = this.padding,
      c = this.camera;
    if (
      b.length !== 6 ||
      !b.every(Number.isFinite) ||
      b.slice(0, 3).some((v, i) => v > b[i + 3]) ||
      ![aspect, padding, duration].every(Number.isFinite) ||
      aspect <= 0 ||
      padding < 1 ||
      duration < 0
    )
      throw new RangeError('Invalid view fit; use ordered finite bounds, aspect > 0, padding >= 1 and duration >= 0');
    const center = b.slice(0, 3).map((v, i) => v / 2 + b[i + 3] / 2),
      radius = Math.max(c.near * 2, Math.hypot(...b.slice(0, 3).map((v, i) => b[i + 3] / 2 - v / 2))) * padding,
      offset = Math.hypot(...center.map((v, i) => v - c.target[i])),
      back = c.position.map((v, i) => v - c.target[i]),
      current = Math.hypot(...back);
    this.fitProjection?.applyLens?.(aspect);
    const angle = Math.atan(Math.tan((c.fov * Math.PI) / 360) * Math.min(1, aspect)),
      ortho = this.fitProjection?.mode === 'orthographic',
      orthoDistance = (extent: number): number => {
        const p = this.fitProjection!,
          low = Math.max(c.near + extent, (p.near ?? c.near) + extent),
          high = p.far === undefined ? Infinity : p.far - extent;
        if (low > high) throw new RangeError('View bounds exceed projection clip planes; widen projection.near/far');
        return Math.max(low, Math.min(current, high));
      },
      finalDistance = ortho ? orthoDistance(radius) : radius / Math.sin(angle),
      startDistance = ortho ? orthoDistance(radius + offset) : Math.max(current, (radius + offset) / Math.sin(angle));
    if (
      !current ||
      ![radius, finalDistance, startDistance].every(Number.isFinite) ||
      c.fov <= 0 ||
      c.fov >= 180 ||
      (ortho ? radius + offset >= c.far / 2 : Math.max(startDistance, finalDistance) + radius + offset >= c.far)
    )
      throw new RangeError('View bounds exceed the camera clip range; raise camera.far or supply smaller bounds');
    if (ortho) this.checkProjection(this.fitProjection!);
    this.framing = { center, radius, aspect };
    c.position = back.map((v, i) => c.target[i] + (v / current) * startDistance) as [number, number, number];
    super.orbit(theta, phi, duration, center, finalDistance, twist);
    this.fitZoom();
  }
  override update(delta: number): void {
    super.update(delta);
    if (this.framing) {
      this.fitZoom();
      if (!this.animating) this.framing = undefined;
    }
  }
  private checkProjection(p: ViewFitProjection): void {
    const explicit = [p.left, p.right, p.top, p.bottom];
    if (
      !Number.isFinite(p.zoom) ||
      (p.height !== undefined && !(p.height > 0 && Number.isFinite(p.height))) ||
      [p.near, p.far].some((v) => v !== undefined && !Number.isFinite(v)) ||
      (p.near !== undefined && p.far !== undefined && p.near >= p.far) ||
      (explicit.every((v) => v !== undefined) &&
        (!explicit.every(Number.isFinite) || p.right! <= p.left! || p.top! <= p.bottom!))
    )
      throw new RangeError(
        'Invalid fit projection; use CameraProjection with positive height and ordered finite frustum bounds',
      );
  }
  private fitZoom(): void {
    const f = this.framing,
      p = this.fitProjection,
      c = this.camera;
    if (!f || p?.mode !== 'orthographic') return;
    const length = Math.hypot(...c.position.map((v, i) => v - c.target[i])),
      radius = f.radius + Math.hypot(...f.center.map((v, i) => v - c.target[i])),
      half = (p.height ?? 2 * length * Math.tan((c.fov * Math.PI) / 360)) / 2,
      explicit = [p.left, p.right, p.top, p.bottom].every((v) => v !== undefined),
      width = explicit ? (p.right! - p.left!) / 2 : half * f.aspect,
      height = explicit ? (p.top! - p.bottom!) / 2 : half,
      cx = explicit ? (p.right! + p.left!) / 2 : 0,
      cy = explicit ? (p.top! + p.bottom!) / 2 : 0;
    p.zoom = Math.min(width / (radius + Math.abs(cx)), height / (radius + Math.abs(cy)));
  }
}
