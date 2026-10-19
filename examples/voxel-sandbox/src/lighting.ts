// =====================================================================================================================
// LIGHTING SETUP: the only place the sandbox sets up light, sky, fog and post-processing. Everything else in the
// example draws the world with `VoxelRenderer` alone.
//
// MERGER: VoxelRenderer's lighting hooks are being added in parallel (packages/voxel/DESIGN.md, phase 5):
// `voxels.addLighting`, `shadows.add(voxels, {static: true})`, `clustered.add(voxels)`, `fog.add(voxels)`, IBL,
// day/night and water/lava animation. Fill them in here (and drop what they replace). Until then this function uses
// only what works without them:
// - `Sky` (preetham day sky and clouds) drives `engine.lighting`'s sun direction, strength and colour, which
//   VoxelRenderer already reads; the ambient strength and colour are set by hand below.
// - Sky's own screen-space fog (`fog: {depth}`), which reads the scene depth Bloom captures, hides the edge of the
//   loaded range. It is not `fog.add(voxels)`: it fogs by depth after the voxel passes.
// - Bloom: HDR capture (VoxelRenderer then skips its own tone map) and a little glow on torches and glowstone.
// Visual baselines are not recorded yet because all of this will change (README, "Visual checks").
// =====================================================================================================================
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Bloom } from '@margoengine/post/bloom';
import { Sky } from '@margoengine/sky/base';
import { clouds } from '@margoengine/sky/clouds';
import { fog } from '@margoengine/sky/fog';
import { lighting } from '@margoengine/sky/lighting';
import { preetham } from '@margoengine/sky/preetham';
import type { VoxelRenderer } from '@margoengine/voxel/render';

/** What {@link setupLighting} returns: live controls of the light. */
export interface SceneLighting {
  /** Fits the fog to a new view distance in blocks (the loaded range's radius). */
  setDistance(blocks: number): void;
  /** Clock hours (0-24) of the sun. */
  hours: number;
  dispose(): void;
}

/** Options of {@link setupLighting}. */
export interface LightingOptions {
  /** Time of day in hours, 0-24. */
  hours: number;
  /** Clock hours per real second (0 holds the time). */
  timeScale: number;
  /** View distance in blocks: the fog closes in before it. */
  distance: number;
}

// Fog that starts at 60% of the view distance and is nearly opaque (exp(-4) visibility) at 95% of it.
const fogFor = (distance: number, depth: () => GPUTexture | undefined) => ({
  depth,
  start: distance * 0.6,
  density: 2 / (distance * 0.35),
});

/**
 * Sets up the scene's light for `voxels` (see the block comment above): sky, sun, ambient, fog and Bloom.
 * The voxel lighting hooks of DESIGN.md phase 5 go here.
 */
export function setupLighting(engine: EngineKernel, voxels: VoxelRenderer, options: LightingOptions): SceneLighting {
  const post = Bloom.attach(engine, { strength: 0.1, threshold: 1.5, exposure: 0.3, radius: 0.4 }),
    depth = () => post.depthTexture,
    sky = Sky.attach(
      engine,
      {
        model: 'preetham',
        hours: options.hours,
        timeScale: options.timeScale,
        turbidity: 2.4,
        clouds: { coverage: 0.35, speed: 4, height: 1200 },
        fog: fogFor(options.distance, depth),
        lighting: {
          intensity: 3.2,
          color: [1, 0.96, 0.9],
          moon: { intensity: 0.22, color: [0.45, 0.55, 0.85] },
        },
      },
      { preetham, clouds, fog, lighting },
    );
  // Ambient: VoxelRenderer scales it by each face's sky light and ambient occlusion, so this is the light of open sky.
  const light = engineRuntime(engine).lighting;
  light.radiance[3] = 0.75;
  light.ambient?.set([0.72, 0.84, 1]);
  // Night: the sky light (not block light) fades with the sky's night factor. Added after Sky, so it reads this frame's.
  const daylight = 'voxel-sandbox:daylight';
  engine.use({
    name: daylight,
    setup() {},
    onPreUpdate: () => {
      voxels.daylight = 0.06 + 0.94 * (1 - sky.nightFactor);
    },
  });
  return {
    setDistance(blocks) {
      sky.options.fog = fogFor(blocks, depth);
    },
    get hours() {
      return sky.options.hours ?? options.hours;
    },
    set hours(value) {
      sky.options.hours = value;
    },
    dispose() {
      engine.removePlugin(daylight);
      sky.dispose();
      post.dispose();
    },
  };
}
