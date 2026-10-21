// Planar glass or water surface: entry @margoengine/environment/refractor.
import type { EngineKernel } from '@margoengine/core';
import type { Camera, Vec3 } from '@margoengine/core/extension';
import { PlanarSurface, type PlanarOptions } from './planar.js';

export { PlanarSurface, type PlanarOptions, type NormalMapImage } from './planar.js';
export { scenePasses, type CapturePassFilter } from './capture.js';

/** Options of {@link Refractor}; see {@link PlanarOptions}. */
export type RefractorOptions = PlanarOptions;

let count = 0;

/**
 * A planar see-through surface (glass, a water plane): the rectangle `width` x `height` in its `node`'s local XY plane.
 * Before each frame it renders the scene through the main camera with the near plane on the surface, so only what
 * lies beyond the surface (on the side away from the camera) is captured, then draws the surface with that image
 * through projective texture coordinates, times `color` and distorted by `normalMap`. Visible from both sides. The
 * capture runs the scene passes only (no post-processing). Perspective and orthographic main cameras. WebGPU only.
 */
export class Refractor extends PlanarSurface {
  /** Same as `engine.use(new Refractor(options))`; returns the Refractor. */
  static attach(engine: EngineKernel, options?: RefractorOptions): Refractor {
    const value = new Refractor(options);
    engine.use(value);
    return value;
  }
  constructor(options: RefractorOptions = {}) {
    super('refractor', ++count, options);
  }
  protected aim(main: Camera): boolean {
    const n = this.normal,
      o = this.origin,
      e = main.position,
      side = n[0] * (e[0] - o[0]) + n[1] * (e[1] - o[1]) + n[2] * (e[2] - o[2]);
    if (!side || !Number.isFinite(side)) return false;
    // Keep the far side of the plane: its normal points away from the eye.
    const s = side > 0 ? -1 : 1,
      far: Vec3 = [s * n[0], s * n[1], s * n[2]];
    this.camera.position = e;
    this.camera.target = main.target;
    this.camera.up = main.up;
    return this.clip(main, far, -(far[0] * o[0] + far[1] * o[1] + far[2] * o[2]) - this.clipBias);
  }
  protected faces(side: number): boolean {
    return side !== 0;
  }
}
