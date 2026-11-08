/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/splats/set: one depth sort for many splat clouds. Separate `Splats` clouds each sort and draw on their
// own, so where two captures overlap one of them lands on top of the other whole; a SplatSet writes every added cloud
// into ranges of one pooled `Splats`, so all their splats project, sort and blend far to near together, as one merged
// cloud would, while each stays addable, movable and removable on its own. Back-to-front "over" compositing is only
// correct in one global order: Porter and Duff 1984, "Compositing Digital Images"; for splats, Kerbl et al. 2023.
import type { EngineKernel } from '@margoengine/core';
import { engineRuntime } from '@margoengine/core/extension';
import { MargoError } from '@margoengine/math/errors';
import { validateSplats, type SplatData } from './data.js';
import { transformSplats } from './edit.js';
import { Splats } from './index.js';

/** Options of {@link SplatSet}. */
export interface SplatSetOptions {
  /** Splats the set can hold at once (1 to 3,000,000). Default 1,000,000. */
  capacity?: number;
  /** SH coefficients per channel of every added cloud: 0, 4, 9 or 16. Default 0. */
  coefficients?: number;
}

/** A cloud in a {@link SplatSet}: its range in the pool, and how to move or remove it. */
export interface SplatSetMember {
  /** First pool index of its splats. */
  readonly first: number;
  readonly count: number;
  /** Places the cloud by a column-major 4x4 affine matrix (from its own data, as `transformSplats`). */
  setMatrix(matrix: ArrayLike<number> | null): void;
  /** Takes the cloud out of the set; its range is free again. */
  remove(): void;
  [Symbol.dispose](): void;
}

/**
 * Many splat clouds sorted together: `SplatSet.attach(engine, {capacity})`, then `set.add(data, {matrix})` per cloud.
 * Every member's splats go into one `Splats` (`set.cloud`) of `capacity` splats, so the GPU sort orders them all.
 * WebGPU only, as `Splats`.
 * @throws RangeError for a capacity outside 1 to 3,000,000 or other coefficients.
 */
export class SplatSet {
  readonly cloud: Splats;
  readonly capacity: number;
  // Free ranges [first, count], sorted by first and merged with their neighbours.
  private free: Array<[number, number]>;
  private readonly members = new Set<SplatSetMember>();
  private disposed = false;
  constructor(options: SplatSetOptions = {}) {
    this.capacity = options.capacity ?? 1_000_000;
    this.cloud = Splats.reserve(this.capacity, options.coefficients ?? 0);
    this.free = [[0, this.capacity]];
  }
  /** Makes a set and attaches its cloud to `engine`. */
  static attach(engine: EngineKernel, options: SplatSetOptions = {}): SplatSet {
    const set = new SplatSet(options);
    engineRuntime(engine).use(set.cloud);
    return set;
  }
  /** Splats held by the members. */
  get used(): number {
    let n = 0;
    for (const m of this.members) n += m.count;
    return n;
  }
  /** The members, in the order they were added. */
  get clouds(): readonly SplatSetMember[] {
    return [...this.members];
  }
  /**
   * Adds a cloud (with the set's SH coefficient count), placed by `matrix` when given, into the first free range that
   * holds it.
   * @throws RangeError when `data` is invalid, has another SH count, or no free range holds it (`capacity` or
   * fragmentation); MargoError `'disposed'` after `dispose()`.
   */
  add(data: SplatData, options: { matrix?: ArrayLike<number> } = {}): SplatSetMember {
    if (this.disposed) throw new MargoError('disposed', 'This SplatSet was disposed; make a new one');
    const count = validateSplats(data),
      at = this.free.findIndex(([, n]) => n >= count);
    if (at < 0)
      throw new RangeError(`No free range of ${count} splats in this SplatSet (${this.capacity - this.used} free); remove clouds or raise capacity`);
    const first = this.free[at][0];
    // Writing checks the SH count before the range is taken.
    this.cloud.write(first, options.matrix ? transformSplats(data, options.matrix) : data);
    if (this.free[at][1] === count) this.free.splice(at, 1);
    else this.free[at] = [first + count, this.free[at][1] - count];
    const set = this;
    let live = true;
    const member: SplatSetMember = {
      first,
      count,
      setMatrix(matrix) {
        if (!live) throw new MargoError('disposed', 'This cloud was removed from its SplatSet; add it again with set.add');
        set.cloud.write(first, matrix ? transformSplats(data, matrix) : data);
      },
      remove() {
        if (!live) return;
        live = false;
        set.members.delete(member);
        if (set.disposed) return;
        set.cloud.clear(first, count);
        set.release(first, count);
      },
      [Symbol.dispose]() {
        member.remove();
      },
    };
    this.members.add(member);
    return member;
  }
  private release(first: number, count: number): void {
    const list = this.free;
    let i = list.findIndex(([f]) => f > first);
    if (i < 0) i = list.length;
    list.splice(i, 0, [first, count]);
    // Merge with the next range, then with the previous one.
    if (i + 1 < list.length && list[i][0] + list[i][1] === list[i + 1][0]) {
      list[i][1] += list[i + 1][1];
      list.splice(i + 1, 1);
    }
    if (i > 0 && list[i - 1][0] + list[i - 1][1] === list[i][0]) {
      list[i - 1][1] += list[i][1];
      list.splice(i, 1);
    }
  }
  /** Removes every member and disposes the cloud. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const m of [...this.members]) m.remove();
    this.cloud.dispose();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
