/// <reference lib="esnext.disposable" preserve="true" />
// The far forest (biome look plan 3, B3): beyond the stored objects' radius a tree is a few pixels, so one
// camera-following Scatter per tree kind draws a 12-triangle stand-in over the world's canopy cover. Stand-ins are hashed,
// not placed, and hand over to the stored trees in a band of one tile, where a tree is about 5 pixels. Loaded only
// when `far` is on. They cast no shadow: shadow maps do not reach them.
import type { EngineKernel } from '@margoengine/core';
import type * as CoreModule from '@margoengine/core';
import type * as ScatterModule from '@margoengine/scatter';
import type { Scatter } from '@margoengine/scatter';
import { rangeError } from '../../shared/errors.js';
import { CANOPY_KINDS, type CanopyCover, canopyCover, COVER_STEP } from './cover.js';
import type { BiomeWorld } from './world.js';

/** Default stand-ins a far forest draws: `BiomeObjects` `far.count`. */
export const FAR_COUNT = 300000;

/** Crown colour of each kind (linear RGB, the full meshes' leaves, a touch lighter for the shaded volume they lose). */
const COLORS = [
  [0.14, 0.3, 0.05],
  [0.04, 0.17, 0.07],
  [0.1, 0.32, 0.07],
] as const;

/** Cover cells a side at most: a 65 km world's raster stays 16 MB, a 4 km world's is one cell every 16 m. */
const MOST_CELLS = 1024;

/** Metres between cover corners for a world: 16, or the multiple of it that keeps the raster within reason. */
export function farStep(world: BiomeWorld): number {
  const side = Math.max(world.bounds[2] - world.bounds[0], world.bounds[3] - world.bounds[1]);
  let step = COVER_STEP;
  while (side > step * MOST_CELLS) step *= 2;
  return step;
}

type Far = { scatter: Scatter; texture: GPUTexture; kind: number };
type Modules = { readonly scatter: typeof ScatterModule; readonly core: typeof CoreModule };

/** The stand-ins of one view: one `Scatter` per tree kind the world has. */
export class FarForest implements Disposable {
  readonly #engine: EngineKernel;
  readonly #world: BiomeWorld;
  readonly #off: () => void;
  readonly #parts: Far[] = [];
  #stale = false;
  #running = false;
  #disposed = false;

  private constructor(engine: EngineKernel, world: BiomeWorld) {
    this.#engine = engine;
    this.#world = world;
    // A paint or edit changes the forest: the raster is made again, one at a time, off this thread with workers.
    this.#off = world.onChange(() => {
      this.#stale = true;
      void this.#refresh();
    });
  }

  /**
   * Starts a far forest over `bounds`, drawn from `inner` metres of the camera out to `radius`.
   * @throws RangeError when `radius` does not reach past `inner`, or for a `count` that is not 1 to 1,000,000.
   */
  static async attach(
    engine: EngineKernel,
    modules: Modules,
    options: {
      readonly world: BiomeWorld;
      readonly heightmap: () => GPUTexture | undefined;
      readonly bounds: readonly [number, number, number, number];
      readonly inner: number;
      readonly fade: number;
      readonly radius: number;
      readonly count?: number;
    },
  ): Promise<FarForest> {
    const { world, heightmap, bounds, inner, fade, radius, count = FAR_COUNT } = options;
    if (!(radius > inner))
      throw rangeError("BiomeObjects far radius must reach past the stored objects' radius", 'biomes');
    if (!(count >= 1 && count <= 1000000))
      throw rangeError('BiomeObjects far count must be from 1 to 1,000,000', 'biomes');
    const standin = await import('@margoengine/procedural/standin'),
      far = new FarForest(engine, world),
      cover = await far.#cover(),
      device = (engine as unknown as { gpu: GPUDevice }).gpu;
    if (far.#disposed) return far;
    // Instances are shared out by how much of the world each kind holds; each kind's map is scaled to its own fullest.
    let all = 0;
    const totals = cover.kinds.map((map) => {
      let sum = 0;
      for (const v of map) sum += v;
      all += sum;
      return sum;
    });
    cover.kinds.forEach((_, kind) => {
      if (!totals[kind]) return;
      const shape = standin.generateTreeStandIn(CANOPY_KINDS[kind]),
        texture = device.createTexture({ size: [cover.width, cover.depth], format: 'r8unorm', usage: 4 | 2 }); // TEXTURE_BINDING | COPY_DST
      far.#upload(texture, cover, kind);
      const scatter = modules.scatter.Scatter.attach(
        engine,
        new modules.core.Geometry(shape.positions, shape.normals, shape.indices),
        {
          count: Math.max(1, Math.round((count * totals[kind]) / all)), // float division: all is above 0 here
          area: [2 * radius, 2 * radius],
          follow: true,
          bounds,
          heightmap,
          densityMap: () => texture,
          lod: [radius * 0.5, radius * 0.75, radius],
          lodFade: 0,
          edgeShrink: radius * 0.1,
          inner,
          innerFade: fade,
          scale: [0.8, 1.8],
          maxSlope: 90,
          material: new modules.core.PbrMaterial({ color: COLORS[kind], roughness: 0.85 }),
          variation: { hue: 0.06, value: 0.15 },
        },
      );
      far.#parts.push({ scatter, texture, kind });
    });
    return far;
  }

  /** The cover raster, on a worker when the world has them. */
  #cover(): Promise<CanopyCover> | CanopyCover {
    const step = farStep(this.#world),
      workers = this.#world.workers;
    return workers ? workers.run<CanopyCover>({ op: 'cover', step }) : canopyCover(this.#world, step);
  }

  #upload(texture: GPUTexture, cover: CanopyCover, kind: number): void {
    const device = (this.#engine as unknown as { gpu: GPUDevice }).gpu;
    device.queue.writeTexture({ texture }, cover.kinds[kind] as Uint8Array<ArrayBuffer>, { bytesPerRow: cover.width }, [
      cover.width,
      cover.depth,
    ]);
  }

  async #refresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    while (this.#stale && !this.#disposed) {
      this.#stale = false;
      const cover = await this.#cover();
      if (!this.#disposed) for (const p of this.#parts) this.#upload(p.texture, cover, p.kind);
    }
    this.#running = false;
  }

  /** Stand-ins drawn at most (the sum of the kinds' counts). */
  get count(): number {
    return this.#parts.reduce((n, p) => n + p.scatter.count, 0);
  }

  /** Frees every scatter and texture. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    for (const p of this.#parts) {
      p.scatter.dispose();
      p.texture.destroy();
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
