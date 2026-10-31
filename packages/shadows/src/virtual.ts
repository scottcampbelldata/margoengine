/// <reference lib="esnext.disposable" preserve="true" />
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime, type Engine, type EnginePlugin } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { preset } from '../../shared/preset.js';
import { PAGES_PER_SIDE, PAGE_TEXELS, PagePool, basePageSize } from './pages.js';
import type { ShadowFilter } from './shader.js';
export type { ShadowFilter } from './shader.js';
declare const GPUTextureUsage: {
  RENDER_ATTACHMENT: number;
  TEXTURE_BINDING: number;
  COPY_SRC: number;
  COPY_DST: number;
};
/** Virtual shadow map settings; invalid values throw RangeError. */
export interface VirtualShadowOptions {
  /**
   * Physical page pool size in texels (default 4096: 32 x 32 pages of 128 texels), a multiple of 256 up to the device's
   * `maxTextureDimension2D`. Memory is two `depth32float` pools: 128 MiB at 4096, 32 MiB at 2048 (for phones).
   */
  poolSize?: number;
  /** Clipmap levels, 1 to 16 (default 8). Each level's pages are twice the size of the one before. */
  levels?: number;
  /** Farthest shadowed distance from the camera in light space, world units, > 0. Default 500. */
  distance?: number;
  /** Most resident pages, 1 up to the pool's. Default the pool's. */
  budgetPages?: number;
  /** Light size for the `'soft'` filter's penumbra width, 0 or more. Default 0.02. */
  lightSize?: number;
  /** Constant depth bias along the light, world units, 0 or more. Default 0.002. */
  bias?: number;
  /** Receiver offset along its normal, world units, 0 or more. Default 0.02. */
  normalBias?: number;
  /** World units the depth range extends towards the light for off-screen casters, 0 or more. Default 100. */
  casterMargin?: number;
  /** Edge filter (default `'soft'`), as `Shadows`. Read when receiver shaders are built. */
  filter?: ShadowFilter;
}
/**
 * A directional virtual shadow map: one depth page pool mapped through a page table over a clipmap of light-space levels
 * around the camera, so resolution follows what the camera sees and still pages stay cached. The optional sibling of
 * `Shadows`; importing `@margoengine/shadows` alone pays nothing for it. WebGPU only.
 * @throws RangeError when an option is out of range or the pool exceeds the device limits.
 * @throws MargoError `'unsupported'` on a WebGL engine, `'disposed'` for a disposed effect, `'state'` when used before
 * attaching.
 */
export class VirtualShadows implements EnginePlugin {
  readonly name = 'virtual-shadows';
  /** Frame counters: `residentPages` now, `pagesRendered` drawn this frame. */
  readonly stats = { residentPages: 0, pagesRendered: 0 };
  private engine?: Engine;
  private device?: GPUDevice;
  private pool?: GPUTexture;
  private cached?: GPUTexture;
  private tableTexture?: GPUTexture;
  private pages?: PagePool;
  private entries: GPUBindGroupEntry[] = [];
  private disposed = false;
  constructor(readonly options: VirtualShadowOptions = {}) {
    this.options = preset('shadows', options);
    this.validate();
  }
  /** Attaches a new effect to `instance`. */
  static attach(instance: EngineKernel, options: VirtualShadowOptions = {}): VirtualShadows {
    const effect = new VirtualShadows(options);
    engineRuntime(instance).use(effect);
    return effect;
  }
  private validate(): void {
    const o = this.options,
      size = o.poolSize ?? 4096,
      levels = o.levels ?? 8,
      budget = o.budgetPages,
      side = size / PAGE_TEXELS;
    if (!Number.isInteger(size) || size < 256 || size % 256)
      throw new RangeError('Invalid virtual shadow poolSize: use a multiple of 256, such as 2048 or 4096');
    if (!Number.isInteger(levels) || levels < 1 || levels > 16)
      throw new RangeError('Invalid virtual shadow levels: use an integer from 1 to 16');
    if (budget !== undefined && (!Number.isInteger(budget) || budget < 1 || budget > side * side))
      throw new RangeError(`Invalid virtual shadow budgetPages: use an integer from 1 to ${side * side}`);
    if (!((o.distance ?? 500) > 0) || !Number.isFinite(o.distance ?? 500))
      throw new RangeError('Invalid virtual shadow distance: use a finite number above 0');
    for (const v of [o.lightSize, o.bias, o.normalBias, o.casterMargin])
      if (v !== undefined && !(v >= 0 && Number.isFinite(v)))
        throw new RangeError(
          'Invalid virtual shadow options: lightSize, bias, normalBias and casterMargin must be finite and 0 or more',
        );
    const filter = o.filter ?? 'soft';
    if (filter !== 'soft' && filter !== 'pcf' && filter !== 'hard')
      throw new RangeError(`Invalid shadow filter '${String(filter)}': use 'soft', 'pcf' or 'hard'`);
  }
  /** Bytes of GPU memory the pools and the page table hold; 0 before attaching. */
  get memoryBytes(): number {
    if (!this.pool) return 0;
    const size = this.options.poolSize ?? 4096;
    return 2 * size * size * 4 + PAGES_PER_SIDE * PAGES_PER_SIDE * (this.options.levels ?? 8) * 4;
  }
  /** Allocates the pools and the page table. Called by `engine.use`. */
  setup(engine: Engine): void {
    if (this.disposed || !engine.gpu)
      throw new MargoError(
        this.disposed ? 'disposed' : 'unsupported',
        'VirtualShadows require WebGPU and a live effect; attach a new VirtualShadows to a WebGPU engine',
      );
    this.engine = engine;
    const device = (this.device = engine.gpu),
      o = this.options,
      size = o.poolSize ?? 4096,
      levels = o.levels ?? 8;
    if (size > device.limits.maxTextureDimension2D || levels > device.limits.maxTextureArrayLayers)
      throw new RangeError('Virtual shadow pool exceeds device limit; lower poolSize or levels');
    const pool = () =>
      device.createTexture({
        size: [size, size],
        format: 'depth32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      });
    this.pool = pool();
    this.cached = pool();
    this.tableTexture = device.createTexture({
      size: [PAGES_PER_SIDE, PAGES_PER_SIDE, levels],
      format: 'r32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.pages = new PagePool({
      levels,
      base: basePageSize(o.distance ?? 500, levels),
      poolPages: size / PAGE_TEXELS,
      budgetPages: o.budgetPages,
    });
    this.entries = [{ binding: 2, resource: this.pool.createView() }];
  }
  /** Receiver bind group entries; throws before attaching. */
  bindings(): GPUBindGroupEntry[] {
    if (!this.pool || this.disposed)
      throw new MargoError('state', 'VirtualShadows are not attached; attach them to an engine first');
    return this.entries;
  }
  private release(): void {
    for (const texture of [this.pool, this.cached, this.tableTexture]) texture?.destroy();
    this.pool = this.cached = this.tableTexture = undefined;
    this.pages = undefined;
    this.entries = [];
  }
  /** Rebuilds the GPU resources after a lost device. */
  onDeviceRestored(engine: Engine): void {
    this.release();
    this.setup(engine);
  }
  /** Removes the effect and frees its GPU memory. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.engine?.removePlugin(this.name);
    this.release();
    this.engine = this.device = undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
