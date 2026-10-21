// Planar mirror: entry @margoengine/environment/reflector.
import type { EngineKernel } from '@margoengine/core';
import type { Camera, Vec3 } from '@margoengine/core/extension';
import { PlanarSurface, type PlanarOptions } from './planar.js';

export { PlanarSurface, type PlanarOptions, type NormalMapImage } from './planar.js';
export { scenePasses, type CapturePassFilter } from './capture.js';

/** Options of {@link Reflector}; see {@link PlanarOptions}. */
export type ReflectorOptions = PlanarOptions;

let count = 0;

/**
 * A planar mirror: the rectangle `width` x `height` in its `node`'s local XY plane, reflecting on the +Z side. Before
 * each frame it renders the scene from the main camera mirrored in the plane into its own HDR target, with the near
 * plane on the mirror (nothing behind the mirror shows), and draws the surface with that image through projective
 * texture coordinates, times `color`, optionally blurred (`roughness`) and distorted (`normalMap`). The capture runs the
 * scene passes only (no post-processing), so TAA, tone mapping and other effects treat the mirror as an ordinary
 * surface. Perspective and orthographic main cameras, 1x and 4x MSAA. Seen from behind, it draws nothing. WebGPU only.
 */
export class Reflector extends PlanarSurface {
  /** Same as `engine.use(new Reflector(options))`; returns the Reflector. */
  static attach(engine: EngineKernel, options?: ReflectorOptions): Reflector {
    const value = new Reflector(options);
    engine.use(value);
    return value;
  }
  constructor(options: ReflectorOptions = {}) {
    super('reflector', ++count, options);
  }
  protected aim(main: Camera): boolean {
    const n = this.normal,
      o = this.origin,
      e = main.position,
      side = n[0] * (e[0] - o[0]) + n[1] * (e[1] - o[1]) + n[2] * (e[2] - o[2]);
    if (!(side > 0)) return false;
    const point = (p: Vec3): Vec3 => {
        const d = 2 * (n[0] * (p[0] - o[0]) + n[1] * (p[1] - o[1]) + n[2] * (p[2] - o[2]));
        return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]];
      },
      up = main.up,
      u = 2 * (n[0] * up[0] + n[1] * up[1] + n[2] * up[2]);
    this.camera.position = point(e);
    this.camera.target = point(main.target);
    this.camera.up = [up[0] - u * n[0], up[1] - u * n[1], up[2] - u * n[2]];
    return this.clip(main, n, -(n[0] * o[0] + n[1] * o[1] + n[2] * o[2]) - this.clipBias);
  }
  protected faces(side: number): boolean {
    return side > 0;
  }
}
