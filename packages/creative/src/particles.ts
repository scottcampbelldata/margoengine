import type { EngineKernel } from '@margoengine/core';
import type { Vec3 } from '@margoengine/core/extension';
import { VFX, type VFXObstacle, type VFXTexture } from '@margoengine/vfx';
/** A sphere or box the leaves flow around and bounce off: `@margoengine/vfx`'s `VFXObstacle`. */
export type WindObstacle = VFXObstacle;
/** A leaf sprite (RGBA8 sRGB, up to 4096 px per side): `@margoengine/vfx`'s `VFXTexture`. */
export type ParticleTexture = VFXTexture;
/** `GPUParticles` settings, fixed at construction; invalid values throw RangeError. */
export interface ParticleOptions {
  /** Particles kept alive in the 6 m cube (the VFX capacity). Default 5000. */
  count?: number;
  /** Acceleration in metres per second squared, added to `wind`. Default [0, -0.5, 0]. */
  gravity?: Vec3;
  /** Steady drift acceleration in metres per second squared. Default [0.4, 0, 0]. */
  wind?: Vec3;
  /** Leaf radius in metres. Default 0.035. */
  size?: number;
  /** Curl-noise turbulence strength, 0-10. Default 0. */
  curl?: number;
  /** Up to 64 obstacles. */
  obstacles?: readonly WindObstacle[];
  /** Draw back to front. Default false. */
  sort?: boolean;
  /** Sprite instead of the soft disc. */
  texture?: ParticleTexture;
}
/** A drifting leaf/weather field: a `@margoengine/vfx` preset that keeps `count` particles wrapping inside a 6 m cube. */
export class GPUParticles extends VFX {
  override readonly name = 'gpu-particles';
  /** Same as `engine.use(new GPUParticles(options))`; returns the GPUParticles (VFX.attach would add a plain VFX). */
  static override attach(engine: EngineKernel, options?: ParticleOptions): GPUParticles {
    const value = new GPUParticles(options);
    engine.use(value);
    return value;
  }
  constructor(options: ParticleOptions = {}) {
    const { count = 5000, gravity = [0, -0.5, 0], wind = [0.4, 0, 0], size = 0.035, curl = 0 } = options;
    if (!Number.isFinite(size) || !(curl >= 0 && curl <= 10) || gravity.length !== 3 || wind.length !== 3)
      throw new RangeError('Invalid particle options');
    super({
      capacity: count,
      initialCount: count,
      rate: 0,
      position: [0, 0, 0],
      emissionExtent: [3, 3, 3],
      wrap: true,
      velocity: [0, 0, 0],
      spread: 0,
      gravity: [gravity[0] + wind[0], gravity[1] + wind[1], gravity[2] + wind[2]],
      turbulence: curl,
      size: size * 2,
      lifetime: [1e6, 1e6],
      ground: -1e30,
      bounce: 0.5,
      angularVelocity: 1,
      color: [0.93, 0.53, 0.17, 0.85],
      obstacles: options.obstacles,
      sort: options.sort,
      texture: options.texture,
    });
  }
  get count(): number {
    return this.capacity;
  }
}
