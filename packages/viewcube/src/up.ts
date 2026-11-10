import type { EngineKernel } from '@margoengine/core';
import { ViewCube, type ViewCubeOptions } from './index.js';

type Vector = readonly [number, number, number];
/** A positive world axis or any finite nonzero world direction. */
export type UpAxis = 'x' | 'y' | 'z' | Vector;
/** World frame and inherited appearance/navigation options for {@link UpViewCube}. */
export interface UpViewCubeOptions extends ViewCubeOptions {
  /** Optional projection; a CameraProjection's pole up is aligned to the widget's front. */
  projection?: { mode: 'orthographic' | 'perspective'; up?: [number, number, number] };
  /** World up. Default 'z'. Named views and tuple views use the resulting widget frame. */
  up?: UpAxis;
  /** World direction toward the front camera, projected perpendicular to up.
   * Default +Z, or -Y when up is nearly parallel to +Z. Must not be parallel to up. */
  front?: Vector;
}
const dot = (a: readonly number[], b: readonly number[]): number => a.reduce((s, x, i) => s + x * b[i], 0);
const unit = (v: readonly number[]): Vector => {
  const length = Math.hypot(...v);
  if (v.length !== 3 || !v.every(Number.isFinite) || !Number.isFinite(length) || !length)
    throw new RangeError('View cube frame needs finite nonzero directions');
  return v.map((x) => x / length) as unknown as Vector;
};

/** A ViewCube whose entire navigation and display use a configurable world frame. */
export class UpViewCube extends ViewCube {
  private frame?: readonly Vector[];

  static override attach(engine: EngineKernel, options?: UpViewCubeOptions): UpViewCube {
    return new UpViewCube(engine, options);
  }
  constructor(engine: EngineKernel, { up = 'z', front, ...options }: UpViewCubeOptions = {}) {
    const axes = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const,
      y = unit(typeof up === 'string' ? axes[up] ?? [] : up),
      hint = unit(front ?? (Math.abs(y[2]) < 0.9 ? [0, 0, 1] : [0, -1, 0])),
      projected = hint.map((x, i) => x - dot(hint, y) * y[i]);
    if (Math.hypot(...projected) < 1e-10) throw new RangeError('Front must not be parallel to up');
    const z = unit(projected),
      x: Vector = [y[1] * z[2] - y[2] * z[1], y[2] * z[0] - y[0] * z[2], y[0] * z[1] - y[1] * z[0]];
    super(engine, options);
    this.frame = [x, y, z];
    const projection = options.projection ?? (engine as unknown as { plugins?: ReadonlyMap<string, { up?: number[] }> }).plugins?.get('cameras');
    if (projection && 'up' in projection) projection.up = z.map((v) => -v) as [number, number, number];
    // Own only navigation up, as the base cube does for poles and roll. The world frame is stable
    // even when a controller supplies another screen-up direction.
    this.camera.up = [...y];
    this.view(this.local(this.camera.position.map((v, i) => v - this.camera.target[i])) as Vector, 0);
    this.sync();
  }
  /** Maps a world direction into the cube's right, up and front coordinates. */
  override local(direction: readonly number[]): readonly number[] {
    if (!this.frame) return direction;
    const scale = Math.hypot(...direction);
    return this.frame.map((axis) => {
      const n = dot(axis, direction);
      return Math.abs(n) < 1e-14 * scale ? 0 : n;
    });
  }
  /** Maps a cube direction to world space. */
  override world(direction: readonly number[]): readonly number[] {
    return this.frame ? [0, 1, 2].map((i) => this.frame!.reduce((s, axis, j) => s + axis[i] * direction[j], 0)) : direction;
  }
}
