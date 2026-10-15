/// <reference lib="esnext.disposable" preserve="true" />
import type { Mesh } from '@margoengine/core';
import { MargoError } from '@margoengine/math/errors';
import { parseColor, type ColorInput } from './color.js';
import { SpriteMaterial, type SpriteMaterialOptions } from './material.js';
import type { PointOwner } from './cloud.js';

/** Floats per sprite in `SpriteBatch.data`: position xyz, rotation, size wh, center xy, uv rect, linear RGBA. */
export const SPRITE_STRIDE = 16;

/** Properties of one sprite in a `SpriteBatch`, for `add` and `set`. */
export interface SpriteOptions {
  /** Local position (the batch's matrix or attached mesh applies). Default [0, 0, 0]. */
  position?: readonly [number, number, number];
  /** Width and height, or one number for a square. World units or pixels per `material.sizeUnits`. Default 1. */
  size?: number | readonly [number, number];
  /** Radians counterclockwise in the screen plane, added to `material.rotation`. Default 0. */
  rotation?: number;
  /** Pivot inside the quad: [0.5, 0.5] is the middle, [0, 0] the bottom left, [1, 1] the top right. Default [0.5, 0.5]. */
  center?: readonly [number, number];
  /** Multiplies the material color. Same formats as materials. Default white. */
  color?: ColorInput;
  /** Alpha multiplier. Default 1. */
  opacity?: number;
  /** Atlas rectangle [u0, v0, u1, v1] with the origin at the top left of the image (see `atlasRect`). Default [0, 0, 1, 1]. */
  uv?: readonly [number, number, number, number];
}

/** Options for `new SpriteBatch(...)`. */
export interface SpriteBatchOptions {
  /** A shared material or options for a new one. Default a new `SpriteMaterial`. */
  material?: SpriteMaterial | SpriteMaterialOptions;
  /** Initial capacity; the batch grows by doubling. Must be a positive integer (RangeError otherwise). Default 64. */
  capacity?: number;
  /** Sprites to add right away. */
  sprites?: readonly SpriteOptions[];
  /** Label for debugging. Default ''. */
  name?: string;
}

/**
 * Camera-facing textured quads drawn with one instanced draw call: the counterpart of many Three.js `Sprite`
 * objects sharing a `SpriteMaterial`. Sprites are addressed by index.
 */
export class SpriteBatch {
  name: string;
  visible = true;
  /** Column-major model matrix applied to sprite positions when not attached to a mesh. */
  readonly matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  readonly material: SpriteMaterial;
  /** Instance data, `SPRITE_STRIDE` floats per sprite. Call `markDirty` after writing to it directly. */
  data: Float32Array;
  /** Bumped when the instance buffer must be reallocated. @internal */
  structure = 0;
  /** Pending `[start, end)` sprite ranges. @internal */
  readonly dirty: Array<[number, number]> = [];
  private used = 0;
  private mesh: Mesh | null = null;
  private owner?: PointOwner;

  constructor(options: SpriteBatchOptions = {}) {
    this.name = options.name ?? '';
    this.material =
      options.material instanceof SpriteMaterial ? options.material : new SpriteMaterial(options.material);
    const capacity = options.capacity ?? 64;
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError('capacity must be a positive integer');
    this.data = new Float32Array(capacity * SPRITE_STRIDE);
    for (const sprite of options.sprites ?? []) this.add(sprite);
  }

  /** Number of sprites. */
  get count(): number {
    return this.used;
  }
  get capacity(): number {
    return this.data.length / SPRITE_STRIDE;
  }
  get attachedMesh(): Mesh | null {
    return this.mesh;
  }

  /** Follow a core mesh's world matrix and visibility. */
  attach(mesh: Mesh | null): this {
    this.mesh = mesh;
    return this;
  }

  /** Appends a sprite and returns its index. */
  add(sprite: SpriteOptions = {}): number {
    if (this.used === this.capacity) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
      this.structure++;
    }
    const index = this.used;
    this.write(index, sprite, true);
    this.used++;
    return index;
  }

  /** Changes some properties of sprite `index`; the rest stay. */
  set(index: number, sprite: SpriteOptions): this {
    this.check(index);
    this.write(index, sprite, false);
    return this;
  }

  /** Removes sprite `index` by moving the last sprite into its slot. Returns the old index of the moved sprite, or -1. */
  remove(index: number): number {
    this.check(index);
    const last = --this.used;
    if (index === last) return -1;
    this.data.copyWithin(index * SPRITE_STRIDE, last * SPRITE_STRIDE, (last + 1) * SPRITE_STRIDE);
    this.dirty.push([index, index + 1]);
    return last;
  }

  clear(): this {
    this.used = 0;
    return this;
  }

  /** Marks sprites `start .. start + count` changed after direct writes to `data`. */
  markDirty(start = 0, count = this.used - start): this {
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < 0 || count < 0 || start + count > this.used)
      throw new RangeError('Sprite range out of bounds');
    this.dirty.push([start, start + count]);
    return this;
  }

  /** Detaches from the plugin and frees GPU buffers. */
  dispose(): void {
    this.owner?.remove(this);
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }

  /** @internal */
  bind(owner: PointOwner | undefined): void {
    if (owner && this.owner && this.owner !== owner)
      throw new MargoError('attached', 'The batch already belongs to another plugin; remove it from that plugin first');
    this.owner = owner;
  }

  private check(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.used) throw new RangeError(`No sprite ${index}`);
  }

  private write(index: number, sprite: SpriteOptions, defaults: boolean): void {
    const d = this.data,
      o = index * SPRITE_STRIDE;
    const scratch = new Float32Array(SPRITE_STRIDE);
    scratch.set(defaults ? [0, 0, 0, 0, 1, 1, 0.5, 0.5, 0, 0, 1, 1, 1, 1, 1, 1] : d.subarray(o, o + SPRITE_STRIDE));
    if (sprite.position) scratch.set(sprite.position.slice(0, 3), 0);
    if (sprite.rotation !== undefined) scratch[3] = sprite.rotation;
    if (sprite.size !== undefined) {
      const size = typeof sprite.size === 'number' ? [sprite.size, sprite.size] : sprite.size;
      scratch[4] = size[0];
      scratch[5] = size[1];
      if (!(size[0] >= 0 && size[1] >= 0)) throw new RangeError('Sprite size must be non-negative');
    }
    if (sprite.center) {
      scratch[6] = sprite.center[0];
      scratch[7] = sprite.center[1];
    }
    if (sprite.uv) scratch.set(sprite.uv.slice(0, 4), 8);
    if (sprite.color !== undefined) parseColor(sprite.color, scratch, 12);
    if (sprite.opacity !== undefined) {
      if (!(sprite.opacity >= 0 && sprite.opacity <= 1)) throw new RangeError('Sprite opacity must be in [0, 1]');
      scratch[15] = sprite.opacity;
    }
    for (const v of scratch) if (!Number.isFinite(v)) throw new RangeError('Sprite values must be finite');
    d.set(scratch, o);
    this.dirty.push([index, index + 1]);
  }
}
