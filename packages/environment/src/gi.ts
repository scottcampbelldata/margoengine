// Dynamic global illumination: an irradiance volume re-captured every frame in a sweep, so bounce light follows moving
// lights and objects. Each capture renders the scene lit as the frame lights it, probe light included, so every sweep
// adds one bounce (the probes converge to the multi-bounce solution as a radiosity iteration does).
import type { EngineKernel } from '@margoengine/core';
import type { Vec3 } from '@margoengine/core/extension';
import type { Environment } from './environment.js';
import { LightProbes } from './probes.js';

/** Options of {@link DynamicGI}. */
export interface DynamicGIOptions {
  /** World-space corners of the lit box (a room, a courtyard). */
  min: Vec3;
  max: Vec3;
  /** Probes along x, y and z (1-64 each, at most 4,096 in total). Default [4, 4, 4]. */
  counts?: readonly [number, number, number];
  /** Probes re-captured per frame (1-4,096, default 4): more follows changes faster and costs more per frame. */
  probesPerFrame?: number;
  /** Cube face edge each probe captures (power of two, 8-64, default 16). */
  resolution?: number;
  /** Spherical-harmonic order per probe: 1 or 2 (default). */
  sh?: 1 | 2;
  /** World distance outside the box over which the light fades to the fallback (default 0). */
  blend?: number;
  /** Ambient light outside the box and the sky the probes see; without it, receivers keep their own ambient there. */
  environment?: Environment;
  /** Capture camera near and far planes (defaults 0.05 and 1000). */
  near?: number;
  far?: number;
  /** Plugin and pass name. Default 'dynamic-gi'. */
  name?: string;
}

/**
 * Bounce light that follows the scene each frame: `LightProbes` with an irradiance volume over `min`..`max` in live mode
 * ({@link LightProbes.setLiveVolume}). Opening a door or moving the sun changes the light in the room within one sweep
 * ({@link sweepFrames} frames); further bounces settle over the next sweeps. Lights core meshes after `engine.use(gi)`
 * and gltf-pro, materials and terrain models after `gi.add(model)`; no bake needed. Everything else is `LightProbes`.
 */
export class DynamicGI extends LightProbes {
  /** Same as `engine.use(new DynamicGI(options))`; returns the DynamicGI. */
  static override attach(engine: EngineKernel, options: DynamicGIOptions): DynamicGI {
    const value = new DynamicGI(options);
    engine.use(value);
    return value;
  }
  constructor(options: DynamicGIOptions) {
    if (!options || typeof options !== 'object') throw new TypeError('DynamicGI needs options with min and max');
    const { min, max, counts = [4, 4, 4], resolution, sh, blend, probesPerFrame = 4 } = options;
    super({
      environment: options.environment,
      volume: { min, max, counts, resolution, sh, blend },
      liveVolume: { probesPerFrame },
      near: options.near,
      far: options.far,
      name: options.name ?? 'dynamic-gi',
    });
  }
  /** Frames per full sweep: every probe is captured again within this many frames. */
  get sweepFrames(): number {
    const [x, y, z] = this.volume!.counts,
      perFrame = this.liveVolume?.probesPerFrame;
    return perFrame ? Math.ceil((x * y * z) / perFrame) : Infinity;
  }
}
