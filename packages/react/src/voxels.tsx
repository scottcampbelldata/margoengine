import { forwardRef } from 'react';
import type { EngineKernel, FrameCallback } from '@margoengine/core';
import type { Vec3 } from '@margoengine/math';
import type { VoxelLighting, VoxelLightingOptions } from '@margoengine/voxel/light';
import type { BlockTextures, VoxelRenderer, VoxelRendererOptions } from '@margoengine/voxel/render';
import type { Loader } from './assets.js';
import { useLoader } from './hooks.js';
import { assignRef, useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';

type RenderApi = typeof import('@margoengine/voxel/render');
type LightApi = typeof import('@margoengine/voxel/light');
/** Props of `<Voxels>`: the world and its textures, the renderer's options, and its live light settings. */
export interface VoxelsProps extends Omit<VoxelRendererOptions, 'daylight' | 'lightmap'> {
  /** Sky light, 0 (night) to 1 (noon); block light (torches) does not dim. Live. Default 1. */
  daylight?: number;
  /** Colour of block light, linear `[r, g, b]`. Live. */
  blockLightColor?: Vec3;
  /** Baked light (`@margoengine/voxel/lightmap`). Live. */
  lightmap?: VoxelRendererOptions['lightmap'];
  /**
   * Light the world's chunks with `@margoengine/voxel/light` (sky and block light), updated from the Canvas frame
   * loop; pass options for its budget, or false when you fill the light bytes yourself. Default true.
   */
  lighting?: boolean | VoxelLightingOptions;
  /** Loading the voxel packages or attaching failed. */
  onError?: (error: unknown) => void;
}
interface Attached {
  renderer: VoxelRenderer;
  lighting: VoxelLighting | null;
  stop: () => void;
}
/**
 * Draws a `VoxelWorld` (`@margoengine/voxel/render`): its dirty chunks are meshed in workers and drawn with one
 * indirect draw per layer; edit the world (`world.setBlock`) and the change shows two frames later, with no React
 * render. `world`, `textures` and the renderer's construction options (`workers`, `maxQuadBytes`, `fancyLeaves`,
 * `bevel`, `lighting`) recreate it when changed; `daylight`, `blockLightColor` and `lightmap` are live. The ref is
 * the live VoxelRenderer. WebGPU and Web Workers only.
 */
export const Voxels = forwardRef<VoxelRenderer, VoxelsProps>(function Voxels(
  {
    world,
    textures,
    workers,
    maxQuadBytes,
    fancyLeaves,
    bevel,
    daylight = 1,
    blockLightColor,
    lightmap,
    lighting = true,
    onError,
  },
  ref,
) {
  const scene = useScene(),
    lightingKey = typeof lighting === 'object' ? JSON.stringify(lighting) : lighting;
  const attached = useCreated<[RenderApi, LightApi | null], Attached>(
    scene,
    {
      load: () =>
        Promise.all([
          optionalPeer('@margoengine/voxel', () => import('@margoengine/voxel/render')),
          lighting ? optionalPeer('@margoengine/voxel', () => import('@margoengine/voxel/light')) : null,
        ]),
      create: ([render, light]) => {
        const renderer = render.VoxelRenderer.attach(scene.engine as unknown as EngineKernel, {
          world,
          textures,
          workers,
          maxQuadBytes,
          fancyLeaves,
          bevel,
          daylight,
          lightmap,
        });
        let lit: VoxelLighting | null = null;
        try {
          lit = light ? light.VoxelLighting.attach(world, typeof lighting === 'object' ? lighting : {}) : null;
        } catch (error) {
          renderer.dispose();
          throw error;
        }
        const frame: FrameCallback = () => {
          lit?.update();
        };
        if (lit) scene.frames.callbacks.add(frame);
        return { renderer, lighting: lit, stop: () => scene.frames.callbacks.delete(frame) };
      },
      dispose: ({ renderer, lighting: lit, stop }) => {
        stop();
        lit?.dispose();
        renderer.dispose();
      },
      onError,
    },
    [world, textures, workers, maxQuadBytes, fancyLeaves, bevel, lightingKey],
  );
  // The ref is the renderer, not the internal pair.
  useCommit(() => {
    if (!attached || !ref) return;
    assignRef(ref, attached.renderer);
    return () => assignRef(ref, null);
  }, [attached, ref]);
  useCommit(() => {
    if (!attached) return;
    attached.renderer.daylight = daylight;
    if (blockLightColor) attached.renderer.blockLightColor = blockLightColor;
    attached.renderer.lightmap = lightmap;
  });
  return null;
});

// One loader for every texture list: the URLs are joined into one cache key, so equal lists share a load.
const blockTexturesLoader: Loader<BlockTextures> = async (key, { fetch }) =>
  (await optionalPeer('@margoengine/voxel', () => import('@margoengine/voxel/render'))).BlockTextures.load(
    key.split('\n'),
    { fetch },
  );
/**
 * Loads block texture images (one layer each, in order) for `<Voxels>` and suspends until they are ready: wrap the
 * component in `<Suspense>`. Shares one load per list of URLs in the Canvas and counts in `useProgress`.
 */
export function useBlockTextures(urls: readonly string[]): BlockTextures {
  return useLoader(blockTexturesLoader, urls.join('\n'));
}
