// =====================================================================================================================
// LIGHTING SETUP: the only place the sandbox sets up light, sky, fog and post-processing. Everything else in the
// example draws the world with `VoxelRenderer` alone.
//
// - `Sky` (preetham day sky, clouds, sun and moon) drives `engine.lighting`, which VoxelRenderer reads every frame;
//   the ambient strength and colour are set by hand below, and `voxels.daylight` follows the sky's night factor.
// - `Shadows` casts the sun's (and at night the moon's) shadows from the voxels: `shadows.add(voxels, {static: true})`
//   redraws the map only when chunks change inside it or the sun moves.
// - `Clustered` gives the light-emitting blocks nearest the camera a local light (`clustered.add(voxels)`): block
//   light from VoxelLighting already brightens their surroundings; these add direct light by angle and highlights.
// - Sky's own screen-space fog (`fog: {depth}`), which reads the scene depth Bloom captures, hides the edge of the
//   loaded range in the sky's own horizon colour. (`Fog.add(voxels)` from @margoengine/environment also works; the
//   sky's fog blends into the sky, which hides the range edge better.)
// - Bloom: HDR capture (VoxelRenderer then skips its own tone map) and a little glow on torches and glowstone.
// =====================================================================================================================
import { Clustered, type PointLight } from '@margoengine/clustered';
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { Bloom } from '@margoengine/post/bloom';
import { Shadows } from '@margoengine/shadows';
import { Sky } from '@margoengine/sky/base';
import { clouds } from '@margoengine/sky/clouds';
import { fog } from '@margoengine/sky/fog';
import { lighting } from '@margoengine/sky/lighting';
import { preetham } from '@margoengine/sky/preetham';
import { blockId } from '@margoengine/voxel';
import type { VoxelRenderer } from '@margoengine/voxel/render';

/** What {@link setupLighting} returns: live controls of the light. */
export interface SceneLighting {
  /** Fits the fog to a new view distance in blocks (the loaded range's radius). */
  setDistance(blocks: number): void;
  /** Clock hours (0-24) of the sun. */
  hours: number;
  /** The sun's (and moon's) shadow maps. */
  readonly shadows: Shadows;
  /** The local lights of light-emitting blocks near the camera. */
  readonly lights: Clustered;
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
  /** Ids of the block types that give off light (torches, glowstone): the nearest get a local light. */
  lightBlocks?: readonly number[];
}

// Fog that starts at 60% of the view distance and is nearly opaque (exp(-4) visibility) at 95% of it.
const fogFor = (distance: number, depth: () => GPUTexture | undefined) => ({
  depth,
  start: distance * 0.6,
  density: 2 / (distance * 0.35),
});

/**
 * Sets up the scene's light for `voxels` (see the block comment above): sky, sun, ambient, shadows, local lights for
 * light-emitting blocks, fog and Bloom.
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
  const shadows = Shadows.attach(engine, {
      distance: Math.min(96, options.distance),
      cascades: 2,
      resolution: 2048,
      filter: 'pcf',
    }),
    removeShadows = shadows.add(voxels, { static: true }),
    lamps = blockLights(engine, voxels, new Set(options.lightBlocks ?? []));
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
    shadows,
    lights: lamps.clustered,
    dispose() {
      engine.removePlugin(daylight);
      lamps.dispose();
      removeShadows();
      engine.removePlugin(shadows.name);
      sky.dispose();
      post.dispose();
    },
  };
}

// Local lights for the LAMPS light-emitting blocks nearest the camera, within a chunk of the camera's chunk. Blocks are
// found when a chunk first comes that near (a palette check, then a scan only if it holds one) and kept up to date
// from the world's edits; a chunk that is replaced or unloaded is scanned again.
const LAMPS = 24;
function blockLights(
  engine: EngineKernel,
  voxels: VoxelRenderer,
  ids: ReadonlySet<number>,
): { clustered: Clustered; dispose(): void } {
  const world = voxels.world,
    clustered = Clustered.attach(engine),
    remove = clustered.add(voxels),
    found = new Map<string, Map<number, [number, number, number]>>(),
    key = (cx: number, cy: number, cz: number) => `${cx},${cy},${cz}`,
    last = [Number.NaN, 0, 0];
  let dirty = true;
  const offChange = world.onChange((x, y, z, state) => {
    const cells = found.get(key(x >> 5, y >> 5, z >> 5));
    if (!cells) return;
    const cell = (x & 31) | ((z & 31) << 5) | ((y & 31) << 10);
    if (ids.has(blockId(state))) cells.set(cell, [x + 0.5, y + 0.5, z + 0.5]);
    else if (!cells.delete(cell)) return;
    dirty = true;
  });
  const offChunk = world.onChunk((cx, cy, cz) => {
    if (found.delete(key(cx, cy, cz))) dirty = true;
  });
  const scan = (cx: number, cy: number, cz: number) => {
    const chunk = world.getChunk(cx, cy, cz),
      cells = new Map<number, [number, number, number]>();
    if (chunk && chunk.pack().palette.some((state) => ids.has(blockId(state))))
      for (let y = 0; y < 32; y++)
        for (let z = 0; z < 32; z++)
          for (let x = 0; x < 32; x++)
            if (ids.has(blockId(chunk.get(x, y, z))))
              cells.set(x | (z << 5) | (y << 10), [cx * 32 + x + 0.5, cy * 32 + y + 0.5, cz * 32 + z + 0.5]);
    found.set(key(cx, cy, cz), cells);
  };
  const name = 'voxel-sandbox:lamps';
  engine.use({
    name,
    setup() {},
    onPreUpdate: () => {
      if (!ids.size) return;
      const p = engineRuntime(engine).camera.position;
      if (!dirty && Math.hypot(p[0] - last[0], p[1] - last[1], p[2] - last[2]) < 2) return;
      const [cx, cy, cz] = [p[0], p[1], p[2]].map((v) => Math.floor(v / 32)),
        near: [number, number, number][] = [];
      for (const k of found.keys()) {
        const [x, y, z] = k.split(',').map(Number);
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) > 2) found.delete(k);
      }
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const k = key(cx + dx, cy + dy, cz + dz);
            if (!found.has(k) && world.getChunk(cx + dx, cy + dy, cz + dz)) scan(cx + dx, cy + dy, cz + dz);
            for (const at of found.get(k)?.values() ?? []) near.push(at);
          }
      const d = (a: readonly number[]) => (a[0] - p[0]) ** 2 + (a[1] - p[1]) ** 2 + (a[2] - p[2]) ** 2;
      near.sort((a, b) => d(a) - d(b));
      clustered.setLights(
        near
          .slice(0, LAMPS)
          .map(
            (at): PointLight => ({
              position: [at[0], at[1] + 0.2, at[2]],
              range: 9,
              color: [1, 0.66, 0.36],
              intensity: 3,
            }),
          ),
      );
      last[0] = p[0];
      last[1] = p[1];
      last[2] = p[2];
      dirty = false;
    },
  });
  return {
    clustered,
    dispose() {
      offChange();
      offChunk();
      engine.removePlugin(name);
      remove();
      engine.removePlugin(clustered.name);
    },
  };
}
