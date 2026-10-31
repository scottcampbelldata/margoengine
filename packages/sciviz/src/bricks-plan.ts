// The CPU half of bricked volumes, free of GPU calls so it runs and tests in Node: the octree of bricks over a pyramid
// of downsampled levels, view-driven selection by projected voxel size under a slot budget, atlas sizing from a memory
// budget, least-recently-used slot reuse, and copying a brick with its repeated border voxels. The method follows the
// public literature on out-of-core volume rendering (E. Gobbetti et al., "A single-pass GPU ray casting framework for
// interactive out-of-core rendering of massive volumetric datasets", The Visual Computer 2008; J. Beyer, M. Hadwiger
// and H. Pfister, "State-of-the-art in GPU-based large-scale volume visualization", Computer Graphics Forum 2015).
import { rangeError, typeError } from '../../shared/errors.js';
import { f16Bits } from '../../shared/f16.js';

type Triple = readonly [number, number, number];

/** One level of a {@link BrickPlan}. */
export interface BrickLevel {
  /** Voxels per axis at this level: the full grid's, halved `level` times and rounded up. */
  readonly dims: Triple;
  /** Bricks per axis at this level. */
  readonly bricks: Triple;
  /** Key of this level's first brick. */
  readonly offset: number;
}

/** The bricks of a volume at every level, from {@link planBricks}. Level 0 is full resolution; the last is one brick. */
export interface BrickPlan {
  /** Grid size [nx, ny, nz] of level 0. */
  readonly dims: Triple;
  /** Voxels per brick side, without the border. */
  readonly brickSize: number;
  /** Voxels repeated from the neighbour on each side of a brick. */
  readonly border: number;
  /** The levels, finest first. */
  readonly levels: readonly BrickLevel[];
  /** Bricks over all levels. */
  readonly count: number;
}

/** A brick: its level and its position in that level's brick grid. */
export interface BrickAddress {
  /** Level: 0 is full resolution. */
  readonly level: number;
  /** Position along x in the level's brick grid. */
  readonly x: number;
  /** Position along y in the level's brick grid. */
  readonly y: number;
  /** Position along z in the level's brick grid. */
  readonly z: number;
}

/** A selected brick. */
export interface SelectedBrick extends BrickAddress {
  /** Pixels one of its voxels covers on screen (Infinity when it crosses the eye plane). */
  readonly error: number;
}

/**
 * Lays out the bricks of a grid. Each level halves the last until one brick covers the volume, so a brick's parent is
 * the brick at half its grid position one level up.
 * @param dims Grid size [nx, ny, nz].
 * @param brickSize Voxels per brick side. Default 64.
 * @param border Voxels each brick repeats from its neighbours. Default 1.
 */
export function planBricks(dims: Triple, brickSize = 64, border = 1): BrickPlan {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((d) => !Number.isInteger(d) || d < 2))
    throw rangeError(
      `Bricked volume dims must be [nx, ny, nz], integers of 2 or more, got [${String(dims)}]`,
      'sciviz',
    );
  if (!Number.isInteger(brickSize) || brickSize < 4)
    throw rangeError(`Bricked volume brickSize must be an integer of 4 or more, got ${brickSize}`, 'sciviz');
  if (!Number.isInteger(border) || border < 0)
    throw rangeError(`Bricked volume border must be an integer of 0 or more, got ${border}`, 'sciviz');
  const levels: BrickLevel[] = [];
  let count = 0;
  for (let level = 0; ; level++) {
    const size = dims.map((d) => Math.ceil(d / 2 ** level)) as unknown as Triple,
      bricks = size.map((d) => Math.ceil(d / brickSize)) as unknown as Triple;
    levels.push({ dims: size, bricks, offset: count });
    count += bricks[0] * bricks[1] * bricks[2];
    if (bricks[0] === 1 && bricks[1] === 1 && bricks[2] === 1) break;
  }
  return { dims, brickSize, border, levels, count };
}

/** A number unique to a brick within its plan. */
export function brickKey(plan: BrickPlan, { level, x, y, z }: BrickAddress): number {
  const { offset, bricks } = plan.levels[level];
  return offset + x + bricks[0] * (y + bricks[1] * z);
}

/** Bytes per voxel in the atlas (r16float). */
const VOXEL_BYTES = 2;
/** Bytes per page table entry (rgba16uint). */
const PAGE_BYTES = 8;

/** The atlas and page table sizes a memory budget gives, from {@link fitBudget}. */
export interface BrickBudget {
  /** Atlas size in slots per axis. */
  readonly slots: Triple;
  /** Bricks the atlas holds. */
  readonly capacity: number;
  /** Bytes of the atlas. */
  readonly atlasBytes: number;
  /** Bytes of the page table. */
  readonly pageBytes: number;
}

/**
 * Sizes the atlas: as many slots as the budget leaves after the page table, no more than the bricks of all frames need
 * and no wider than the GPU's 3D texture limit.
 * @param plan The bricks.
 * @param budget Bytes of GPU memory the atlas and page table may use.
 * @param maxTexture The GPU's largest 3D texture side.
 * @param frames Time steps of the volume. Default 1.
 */
export function fitBudget(plan: BrickPlan, budget: number, maxTexture: number, frames = 1): BrickBudget {
  if (!(budget > 0) || !Number.isFinite(budget))
    throw rangeError(`Bricked volume memoryBudget must be a positive number of bytes, got ${budget}`, 'sciviz');
  const side = plan.brickSize + 2 * plan.border,
    slotBytes = side ** 3 * VOXEL_BYTES,
    [px, py, pz] = plan.levels[0].bricks,
    pageBytes = px * py * pz * PAGE_BYTES,
    perAxis = Math.floor(maxTexture / side);
  if (perAxis < 1)
    throw rangeError(
      `Bricked volume bricks of ${side} voxels exceed this GPU's 3D texture limit of ${maxTexture}; lower brickSize`,
      'sciviz',
    );
  if (Math.max(px, py, pz) > maxTexture)
    throw rangeError(
      `Bricked volume page table of [${px}, ${py}, ${pz}] exceeds this GPU's 3D texture limit of ${maxTexture}; raise brickSize`,
      'sciviz',
    );
  const wanted = Math.min(Math.floor((budget - pageBytes) / slotBytes), plan.count * frames);
  if (wanted < 1)
    throw rangeError(
      `Bricked volume memoryBudget of ${budget} B cannot hold the page table (${pageBytes} B) and one brick (${slotBytes} B): raise it or lower brickSize`,
      'sciviz',
    );
  // The box of slots that holds the most, within the texture limit and what the budget pays for; nearest a cube on a tie.
  let slots: Triple = [1, 1, 1];
  let capacity = 1;
  for (let sx = 1; sx <= Math.min(perAxis, wanted); sx++)
    for (let sy = 1; sy <= Math.min(sx, Math.floor(wanted / sx)); sy++) {
      const sz = Math.min(perAxis, sy, Math.floor(wanted / (sx * sy))),
        room = sx * sy * sz;
      if (room > capacity || (room === capacity && sx - sz < slots[0] - slots[2])) {
        slots = [sx, sy, sz];
        capacity = room;
      }
    }
  return { slots, capacity, atlasBytes: capacity * slotBytes, pageBytes };
}

// Pixels one voxel of a brick covers under `m` (box to clip space), or -1 when the frustum's sides cull it. A brick
// crossing the eye plane has no finite projection, and needs full detail.
function projectedError(
  plan: BrickPlan,
  m: ArrayLike<number>,
  width: number,
  height: number,
  { level, x, y, z }: BrickAddress,
): number {
  const size = plan.brickSize,
    { dims } = plan.levels[level],
    lo = [x * size, y * size, z * size],
    hi = [Math.min((x + 1) * size, dims[0]), Math.min((y + 1) * size, dims[1]), Math.min((z + 1) * size, dims[2])],
    // Level voxels to the box: a level's voxel is 2^level of the full grid's.
    scale = 2 ** level;
  let left = true,
    right = true,
    below = true,
    above = true,
    crossing = false,
    minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let corner = 0; corner < 8; corner++) {
    const bx = Math.min(1, ((corner & 1 ? hi[0] : lo[0]) * scale) / plan.dims[0]),
      by = Math.min(1, ((corner & 2 ? hi[1] : lo[1]) * scale) / plan.dims[1]),
      bz = Math.min(1, ((corner & 4 ? hi[2] : lo[2]) * scale) / plan.dims[2]),
      cx = m[0] * bx + m[4] * by + m[8] * bz + m[12],
      cy = m[1] * bx + m[5] * by + m[9] * bz + m[13],
      w = m[3] * bx + m[7] * by + m[11] * bz + m[15];
    left &&= cx < -w;
    right &&= cx > w;
    below &&= cy < -w;
    above &&= cy > w;
    if (w <= 0) {
      crossing = true;
      continue;
    }
    const sx = (cx / w) * 0.5 * width,
      sy = (cy / w) * 0.5 * height;
    minX = Math.min(minX, sx);
    maxX = Math.max(maxX, sx);
    minY = Math.min(minY, sy);
    maxY = Math.max(maxY, sy);
  }
  if (left || right || below || above) return -1;
  if (crossing) return Infinity;
  return Math.hypot(maxX - minX, maxY - minY) / Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
}

/**
 * The bricks to keep for a view, coarsest first. Starts from the root (always kept, so the whole box has data) and
 * splits the brick whose voxels look largest, until every kept voxel covers at most `detail` pixels or `capacity`
 * slots are used. A brick's parent is always selected before it, and bricks outside the view are never split into.
 * @param plan The bricks.
 * @param matrix Column-major 4x4 from the volume's [0, 1] box to clip space.
 * @param width Viewport width in pixels.
 * @param height Viewport height in pixels.
 * @param capacity Most bricks to select.
 * @param detail Pixels a voxel may cover before finer bricks are wanted; 0 asks for level 0 everywhere in view.
 */
export function selectBricks(
  plan: BrickPlan,
  matrix: ArrayLike<number>,
  width: number,
  height: number,
  capacity: number,
  detail: number,
): SelectedBrick[] {
  const top = plan.levels.length - 1,
    root: SelectedBrick = {
      level: top,
      x: 0,
      y: 0,
      z: 0,
      error: Math.max(0, projectedError(plan, matrix, width, height, { level: top, x: 0, y: 0, z: 0 })),
    },
    out: SelectedBrick[] = [root],
    // A binary max-heap on error.
    heap: SelectedBrick[] = [root];
  const push = (brick: SelectedBrick) => {
    let i = heap.push(brick) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].error >= brick.error) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = brick;
  };
  const pop = (): SelectedBrick => {
    const first = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && heap[child + 1].error > heap[child].error) child++;
        if (heap[child].error <= last.error) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  while (heap.length && out.length < capacity) {
    const brick = pop();
    if (brick.error <= detail) break;
    if (brick.level === 0) continue;
    const level = brick.level - 1,
      [bx, by, bz] = plan.levels[level].bricks,
      children: SelectedBrick[] = [];
    for (let k = 0; k < 8; k++) {
      const x = brick.x * 2 + (k & 1),
        y = brick.y * 2 + ((k >> 1) & 1),
        z = brick.z * 2 + (k >> 2);
      if (x >= bx || y >= by || z >= bz) continue;
      const error = projectedError(plan, matrix, width, height, { level, x, y, z });
      if (error >= 0) children.push({ level, x, y, z, error });
    }
    // All of a brick's children or none: a smaller brick elsewhere may still fit.
    if (out.length + children.length > capacity) continue;
    for (const child of children) {
      out.push(child);
      push(child);
    }
  }
  return out;
}

/**
 * Atlas slots by key, reusing the least recently used. A slot holding a key `keep` names is never taken, so a view's
 * bricks cannot push each other out.
 */
export class BrickCache {
  /** Slots available. */
  readonly capacity: number;
  // Map order is use order: the first entry is the least recently used.
  readonly #slots = new Map<number, number>();
  #next = 0;

  /** @param capacity Slots available. */
  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Slots in use. */
  get size(): number {
    return this.#slots.size;
  }

  /** True if `key` holds a slot. */
  has(key: number): boolean {
    return this.#slots.has(key);
  }

  /** The slot of `key`, or undefined. */
  slot(key: number): number | undefined {
    return this.#slots.get(key);
  }

  /** Marks `key` as just used. */
  touch(key: number): void {
    const slot = this.#slots.get(key);
    if (slot === undefined) return;
    this.#slots.delete(key);
    this.#slots.set(key, slot);
  }

  /**
   * A slot for `key`. Takes a free one, else the least recently used key that `keep` does not hold.
   * @returns The slot and the key it replaced, or undefined when every slot is kept.
   */
  place(key: number, keep: (key: number) => boolean): { slot: number; evicted?: number } | undefined {
    if (this.#next < this.capacity) {
      const slot = this.#next++;
      this.#slots.set(key, slot);
      return { slot };
    }
    for (const [old, slot] of this.#slots)
      if (!keep(old)) {
        this.#slots.delete(old);
        this.#slots.set(key, slot);
        return { slot, evicted: old };
      }
    return undefined;
  }
}

/** The voxels to read for a brick: its own and its border, inside the level's grid. */
export function brickRegion(plan: BrickPlan, { level, x, y, z }: BrickAddress): { origin: Triple; size: Triple } {
  const { brickSize: b, border: g } = plan,
    { dims } = plan.levels[level],
    at = [x, y, z],
    origin = at.map((k) => Math.max(0, k * b - g)) as unknown as Triple,
    size = at.map((k, a) => Math.min(dims[a], (k + 1) * b + g) - origin[a]) as unknown as Triple;
  return { origin, size };
}

/**
 * Writes a brick's atlas slot: normalised half floats over brick plus border on every side, repeating the edge voxel
 * past the grid's edge, as a sampler's clamp would. NaN becomes 0, as in a whole volume.
 * @param plan The bricks.
 * @param brick The brick.
 * @param values The voxels of {@link brickRegion}, x fastest.
 * @param lo Data value that maps to 0.
 * @param hi Data value that maps to 1.
 * @param out The slot's (brickSize + 2 border)^3 voxels.
 */
export function fillBrick(
  plan: BrickPlan,
  brick: BrickAddress,
  values: ArrayLike<number>,
  lo: number,
  hi: number,
  out: Uint16Array,
): void {
  const { brickSize: b, border: g } = plan,
    { origin, size } = brickRegion(plan, brick),
    side = b + 2 * g,
    scale = 1 / (hi - lo),
    // Per axis: the region index of each slot voxel.
    axis = (k: number, a: number) => {
      const map = new Int32Array(side);
      for (let i = 0; i < side; i++) map[i] = Math.min(size[a] - 1, Math.max(0, k * b - g + i - origin[a]));
      return map;
    },
    mx = axis(brick.x, 0),
    my = axis(brick.y, 1),
    mz = axis(brick.z, 2);
  let w = 0;
  for (let k = 0; k < side; k++) {
    const plane = mz[k] * size[0] * size[1];
    for (let j = 0; j < side; j++) {
      const row = plane + my[j] * size[0];
      for (let i = 0; i < side; i++) {
        const v = values[row + mx[i]];
        out[w++] = f16Bits(v === v ? Math.min(1, Math.max(0, (v - lo) * scale)) : 0);
      }
    }
  }
}

/** What a brick source is asked for: a block of voxels at a level. */
export interface BrickRequest {
  /** Level: 0 is full resolution, each level above averages 2 x 2 x 2 voxels of the one below. */
  readonly level: number;
  /** Time step, from 0. */
  readonly frame: number;
  /** First voxel [x, y, z] at this level. Always inside the level's grid. */
  readonly origin: readonly [number, number, number];
  /** Voxels per axis. The block always fits the level's grid. */
  readonly size: readonly [number, number, number];
  /** Aborts when the view no longer needs this brick or the layer is disposed. */
  readonly signal: AbortSignal;
}

/** Where a bricked volume's voxels come from: files, a server, a function or {@link arraySource}. */
export interface BrickSource {
  /** Grid size [nx, ny, nz] at full resolution. */
  readonly dims: readonly [number, number, number];
  /** Data range for the transfer function, unless the layer's `range` option gives it. */
  readonly range?: readonly [number, number];
  /** Time steps. Default 1. */
  readonly frames?: number;
  /** The requested block's `size[0] * size[1] * size[2]` values, x fastest. */
  read(request: BrickRequest): ArrayLike<number> | Promise<ArrayLike<number>>;
}

// One level up: each voxel averages the finite values among the 2 x 2 x 2 below it.
function halve(values: ArrayLike<number>, dims: Triple): { values: Float32Array; dims: Triple } {
  const [nx, ny, nz] = dims,
    next = dims.map((d) => Math.ceil(d / 2)) as unknown as Triple,
    out = new Float32Array(next[0] * next[1] * next[2]);
  for (let z = 0, w = 0; z < next[2]; z++)
    for (let y = 0; y < next[1]; y++)
      for (let x = 0; x < next[0]; x++, w++) {
        let sum = 0,
          n = 0;
        for (let k = z * 2; k < Math.min(nz, z * 2 + 2); k++)
          for (let j = y * 2; j < Math.min(ny, y * 2 + 2); j++)
            for (let i = x * 2; i < Math.min(nx, x * 2 + 2); i++) {
              const v = values[i + nx * (j + ny * k)];
              if (v === v) {
                sum += v;
                n++;
              }
            }
        out[w] = n ? sum / n : Number.NaN;
      }
  return { values: out, dims: next };
}

/**
 * A brick source over arrays in memory. Coarser levels are averaged the first time they are read and kept.
 * @param data The voxels (x fastest), or one array per time step.
 * @param dims Grid size [nx, ny, nz].
 */
export function arraySource(
  data: ArrayLike<number> | readonly ArrayLike<number>[],
  dims: readonly [number, number, number],
): BrickSource {
  const first = (data as ArrayLike<unknown>)[0],
    frames = (typeof first === 'object' ? data : [data]) as readonly ArrayLike<number>[];
  if (!dims || dims.length !== 3) throw typeError('arraySource needs dims: [nx, ny, nz]', 'sciviz');
  const voxels = dims[0] * dims[1] * dims[2];
  frames.forEach((values, frame) => {
    if (values.length !== voxels)
      throw rangeError(
        `arraySource frame ${frame} holds ${values.length} values; pass ${voxels} (dims multiplied)`,
        'sciviz',
      );
  });
  let lo = Infinity,
    hi = -Infinity;
  for (const values of frames)
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (!(lo <= hi)) [lo, hi] = [0, 1];
  if (lo === hi) [lo, hi] = [lo - 0.5, hi + 0.5];
  const pyramids = frames.map((values) => [{ values, dims: dims as Triple }]);
  return {
    dims,
    range: [lo, hi],
    frames: frames.length,
    read({ level, frame, origin, size }) {
      const pyramid = pyramids[frame];
      while (pyramid.length <= level) {
        const below = pyramid[pyramid.length - 1];
        pyramid.push(halve(below.values, below.dims));
      }
      const { values, dims: d } = pyramid[level],
        out = new Float32Array(size[0] * size[1] * size[2]);
      for (let k = 0, w = 0; k < size[2]; k++)
        for (let j = 0; j < size[1]; j++) {
          const row = origin[0] + d[0] * (origin[1] + j + d[1] * (origin[2] + k));
          for (let i = 0; i < size[0]; i++) out[w++] = values[row + i];
        }
      return out;
    },
  };
}
