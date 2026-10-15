/// <reference lib="esnext.disposable" preserve="true" />
import type { Mesh } from '@margoengine/core';
import { buildBlocks, expandBlockBounds, packColors, NO_BLOCK, type PointBlocks } from './math.js';
import { PointsMaterial, type PointsMaterialOptions } from './material.js';

/**
 * Point data. This is also the point-cloud output of `@margoengine/loaders`
 * (`{kind: 'points', positions, colors?, normals?}`), which can be passed straight in.
 */
export interface PointCloudData {
  /** xyz per point. A Float32Array is used in place (not copied); other arrays are copied. */
  positions: Float32Array | ArrayLike<number>;
  /** RGB or RGBA per point: floats in 0..1, or 0..255 in a Uint8Array/Uint8ClampedArray. Packed to RGBA8. */
  colors?: Float32Array | Uint8Array | Uint8ClampedArray | ArrayLike<number> | null;
  /** 3 or 4. Inferred from `colors.length / count` when omitted. */
  colorComponents?: 3 | 4;
  /** Per-point size multiplier of `material.size`. A Float32Array is used in place. */
  sizes?: Float32Array | ArrayLike<number> | null;
  /** Accepted for loader interop and kept on the cloud; not used for shading. */
  normals?: Float32Array | null;
}

export interface PointCloudOptions extends PointCloudData {
  material?: PointsMaterial | PointsMaterialOptions;
  /** Maximum points per culling block. Default 16384. */
  blockSize?: number;
  /** Seed of the per-block shuffle used for level of detail. Default 1. */
  seed?: number;
  /** Color space of per-point colors. Loader output and 8-bit scanner colors are sRGB. Default 'srgb'. */
  colorSpace?: 'srgb' | 'linear';
  /**
   * Permute the arrays into block order once at construction so the GPU reads them sequentially (faster for
   * huge, spatially scrambled inputs). Point indices then refer to the new order; `sourceIndex` maps back.
   * Default false.
   */
  reorder?: boolean;
  /** World-unit margin added to every frustum plane test, for large points at block edges. Default 0. */
  cullMargin?: number;
  name?: string;
}

type Channel = 'positions' | 'colors' | 'sizes';

/** Owner interface the plugin implements, so `dispose()` can detach the cloud. */
export interface PointOwner {
  remove(item: unknown): void;
}

/**
 * A chunked, GPU-resident point cloud: the counterpart of Three.js `Points` with a `PointsMaterial`.
 * Add it to a `PointsPlugin` to draw it.
 */
export class PointCloud {
  name: string;
  /** Hidden clouds are skipped entirely. */
  visible = true;
  /** Column-major model matrix, used when the cloud is not attached to a mesh. */
  readonly matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  readonly material: PointsMaterial;
  readonly count: number;
  readonly positions: Float32Array;
  /** Packed RGBA8 per point (r in the low byte), or null. */
  colors: Uint32Array | null = null;
  /** Component count of the colors last given (3 or 4). */
  colorComponents: 3 | 4 = 3;
  sizes: Float32Array | null = null;
  readonly normals: Float32Array | null;
  readonly colorSpace: 'srgb' | 'linear';
  readonly blockSize: number;
  readonly seed: number;
  cullMargin: number;
  /** True when `reorder` permuted the arrays; the GPU then reads slots directly. */
  readonly direct: boolean;
  /** With `reorder`, the original index of each stored point. */
  readonly sourceIndex: Uint32Array | null;
  /** Chunking result: blocks, bounds and the shuffled draw order. */
  blocks: PointBlocks;
  /** Points drawn and blocks visible in the latest frame. */
  readonly stats = { blocksVisible: 0, pointsVisible: 0, pointsDrawn: 0 };
  /** Bumped when GPU buffers must be recreated (colors or sizes added or removed, rebuild). @internal */
  structure = 0;
  /** Pending `[start, end)` point ranges per channel. @internal */
  readonly dirty: Record<Channel, Array<[number, number]>> = { positions: [], colors: [], sizes: [] };
  private mesh: Mesh | null = null;
  private owner?: PointOwner;

  constructor(options: PointCloudOptions) {
    if (!options || typeof options !== 'object' || !options.positions)
      throw new TypeError('PointCloud needs positions');
    const { positions } = options;
    if (positions.length % 3) throw new RangeError('positions length must be a multiple of 3');
    this.name = options.name ?? '';
    this.count = positions.length / 3;
    this.blockSize = options.blockSize ?? 16384;
    this.seed = options.seed ?? 1;
    this.cullMargin = options.cullMargin ?? 0;
    this.colorSpace = options.colorSpace ?? 'srgb';
    if (this.colorSpace !== 'srgb' && this.colorSpace !== 'linear')
      throw new RangeError("colorSpace must be 'srgb' or 'linear'");
    if (!Number.isFinite(this.cullMargin) || this.cullMargin < 0)
      throw new RangeError('cullMargin must be finite and non-negative');
    this.material =
      options.material instanceof PointsMaterial ? options.material : new PointsMaterial(options.material);
    let stored = positions instanceof Float32Array ? positions : Float32Array.from(positions);
    if (options.colors) this.setColors(options.colors, options.colorComponents, false);
    if (options.sizes) this.setSizes(options.sizes, false);
    this.normals = options.normals ?? null;
    const blocks = buildBlocks(stored, this.count, this.blockSize, this.seed);
    this.direct = options.reorder === true;
    if (this.direct) {
      // Finite points in slot order first, then any non-finite ones, so indices stay a permutation.
      const source = new Uint32Array(this.count);
      source.set(blocks.order.subarray(0, blocks.finite));
      let tail = blocks.finite;
      for (let i = 0; i < this.count; i++) if (blocks.blockOf[i] === NO_BLOCK) source[tail++] = i;
      const permute = <T extends Float32Array | Uint32Array>(array: T, stride: number): T => {
        const out = new (array.constructor as { new (length: number): T })(array.length);
        for (let i = 0; i < this.count; i++)
          for (let c = 0; c < stride; c++) out[i * stride + c] = array[source[i] * stride + c];
        return out;
      };
      stored = permute(stored, 3);
      if (this.colors) this.colors = permute(this.colors, 1);
      if (this.sizes) this.sizes = permute(this.sizes, 1);
      const blockOf = new Uint32Array(this.count).fill(NO_BLOCK);
      for (let b = 0; b < blocks.length; b++) blockOf.fill(b, blocks.starts[b], blocks.starts[b] + blocks.counts[b]);
      const order = new Uint32Array(this.count);
      for (let i = 0; i < this.count; i++) order[i] = i;
      this.blocks = { ...blocks, order, blockOf };
      this.sourceIndex = source;
    } else {
      this.blocks = blocks;
      this.sourceIndex = null;
    }
    this.positions = stored;
  }

  /** The mesh whose world matrix this cloud follows, or null. */
  get attachedMesh(): Mesh | null {
    return this.mesh;
  }

  /** Follow a core mesh's world matrix (and its visibility). Pass null to use `matrix` again. */
  attach(mesh: Mesh | null): this {
    this.mesh = mesh;
    return this;
  }

  /** Copies `values` (xyz per point) over points `start ..` and uploads only that range next frame. */
  updatePositions(start: number, values: ArrayLike<number>): this {
    const n = this.range(start, values.length, 3);
    this.positions.set(values, start * 3);
    expandBlockBounds(this.blocks, this.positions, start, n);
    this.dirty.positions.push([start, start + n]);
    return this;
  }

  /** Overwrites colors of points `start ..`. `components` defaults to the cloud's current component count. */
  updateColors(start: number, values: ArrayLike<number>, components: 3 | 4 = this.colorComponents): this {
    if (!this.colors) throw new Error('The cloud has no per-point colors; call setColors first');
    const n = this.range(start, values.length, components);
    packColors(values, components, n, this.colors, start);
    this.dirty.colors.push([start, start + n]);
    return this;
  }

  /** Overwrites per-point sizes of points `start ..`. */
  updateSizes(start: number, values: ArrayLike<number>): this {
    if (!this.sizes) throw new Error('The cloud has no per-point sizes; call setSizes first');
    const n = this.range(start, values.length, 1);
    for (let i = 0; i < n; i++)
      if (!(values[i] >= 0) || !Number.isFinite(values[i]))
        throw new RangeError('sizes must be finite and non-negative');
    this.sizes.set(values, start);
    this.dirty.sizes.push([start, start + n]);
    return this;
  }

  /**
   * Marks points `start .. start + count` of a channel as changed after you wrote into `positions`, `colors`
   * (packed) or `sizes` directly. Position edits also grow the block bounds.
   */
  markDirty(channel: Channel, start = 0, count = this.count - start): this {
    this.range(start, count, 1);
    if (channel === 'positions') expandBlockBounds(this.blocks, this.positions, start, count);
    this.dirty[channel].push([start, start + count]);
    return this;
  }

  /** Replaces or removes all per-point colors (reallocates the GPU buffer). */
  setColors(values: ArrayLike<number> | null, components?: 3 | 4, notify = true): this {
    if (values === null) this.colors = null;
    else {
      const inferred = components ?? (values.length === this.count * 4 && values.length !== this.count * 3 ? 4 : 3);
      if (values.length !== this.count * inferred)
        throw new RangeError(`colors needs ${this.count * inferred} values (${inferred} per point)`);
      this.colorComponents = inferred;
      this.colors = packColors(values, inferred, this.count, new Uint32Array(this.count));
    }
    if (notify) this.structure++;
    return this;
  }

  /** Replaces or removes all per-point sizes (reallocates the GPU buffer). */
  setSizes(values: ArrayLike<number> | null, notify = true): this {
    if (values === null) this.sizes = null;
    else {
      if (values.length !== this.count) throw new RangeError(`sizes needs ${this.count} values`);
      const sizes = values instanceof Float32Array ? values : Float32Array.from(values);
      for (let i = 0; i < sizes.length; i++)
        if (!(sizes[i] >= 0) || !Number.isFinite(sizes[i]))
          throw new RangeError('sizes must be finite and non-negative');
      this.sizes = sizes;
    }
    if (notify) this.structure++;
    return this;
  }

  /** Re-chunks from the current positions: tight bounds again, and points that became finite join a block. */
  rebuild(): this {
    if (this.direct) throw new Error('A reordered cloud cannot be rebuilt; create a new PointCloud');
    this.blocks = buildBlocks(this.positions, this.count, this.blockSize, this.seed);
    this.structure++;
    return this;
  }

  /** Detaches from its plugin, which frees the GPU buffers. The CPU arrays stay usable. */
  dispose(): void {
    this.owner?.remove(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** @internal */
  bind(owner: PointOwner | undefined): void {
    if (owner && this.owner && this.owner !== owner) throw new Error('The cloud already belongs to another plugin');
    this.owner = owner;
  }

  private range(start: number, length: number, stride: number): number {
    const n = length / stride;
    if (!Number.isInteger(start) || !Number.isInteger(n) || start < 0 || start + n > this.count)
      throw new RangeError(`Range ${start}..${start + n} is outside the cloud of ${this.count} points`);
    return n;
  }
}
