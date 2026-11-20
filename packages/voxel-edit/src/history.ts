// Undo/redo for one dense grid. Each step is a private copy. This is not a document transaction,
// and maxCells is a per-grid check, not a cumulative byte budget (see maxBytes for that).
import { cellLimit, checkGrid, type VoxelGrid } from './grid.js';

/** Options of {@link VoxelHistory}. */
export interface HistoryOptions {
  /** Most snapshots kept, including the current one. Default 64. */
  maxDepth?: number;
  /** Most cells of each pushed grid, 1 to 67,108,864. Not a cumulative budget. Default 16,777,216. */
  maxCells?: number;
  /**
   * Bytes of voxel buffers this history may retain at once. A push past it drops the oldest steps until the new one
   * fits, as editors' undo memory limits do; a single step larger than the whole budget is kept as the only step.
   * Default no extra limit (only `maxDepth` applies). This counts the history's own copies, not the rest of an editor
   * document.
   */
  maxBytes?: number;
}

/** One recorded state. `grid` is a copy the caller owns. */
export interface HistoryEntry {
  /** A copy of the grid at this step. */
  grid: VoxelGrid;
  /** Optional name of the operation that produced it. */
  label?: string;
}

/**
 * An undo/redo stack of copied grids. Mutating a grid you passed in, or a grid this class returned, does not change
 * the stored steps. `maxCells` checks one grid. `maxBytes`, when set, is the sum of the stored copies only: like
 * GIMP's "Maximum undo memory" (GIMP 3.2 User Manual, "Undoing"), going past it drops the oldest steps, and the newest
 * step always stays, so `bytes` exceeds `maxBytes` only while one step alone is larger than it.
 */
export class VoxelHistory {
  #entries: { grid: VoxelGrid; label?: string }[] = [];
  #index = -1;
  #bytes = 0;
  readonly #maxDepth: number;
  readonly #maxCells: number;
  readonly #maxBytes: number;

  /**
   * Starts a history whose first step is a copy of `initial`.
   * @throws RangeError when an option is out of range or `initial` fails the cell budget.
   */
  constructor(initial: VoxelGrid, options: HistoryOptions = {}) {
    this.#maxDepth = checkDepth(options.maxDepth);
    this.#maxCells = cellLimit(options);
    this.#maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
    if (!(this.#maxBytes > 0)) throw new RangeError('History maxBytes must be greater than 0');
    this.push(initial, 'initial');
  }

  /** A copy of the grid at the current step. */
  get current(): VoxelGrid {
    return copyGrid(this.#entries[this.#index].grid);
  }

  /** Whether a step can be undone. */
  get canUndo(): boolean {
    return this.#index > 0;
  }

  /** Whether a step can be redone. */
  get canRedo(): boolean {
    return this.#index < this.#entries.length - 1;
  }

  /** The label of the current step, if any. */
  get label(): string | undefined {
    return this.#entries[this.#index].label;
  }

  /** Number of stored snapshots. */
  get depth(): number {
    return this.#entries.length;
  }

  /** Bytes of voxel buffers currently stored. */
  get bytes(): number {
    return this.#bytes;
  }

  /**
   * Record a copy of `grid`. Discards any redo branch, then drops the oldest steps while the stored copies pass
   * `maxDepth` or `maxBytes` (never the new step). Returns an owned grid copy, like undo/redo/go/current.
   * @throws RangeError when the grid fails the cell budget; nothing is recorded then.
   */
  push(grid: VoxelGrid, label?: string): VoxelGrid {
    checkGrid(grid, this.#maxCells, 'History grid');
    const stored = copyGrid(grid);
    const next = this.#entries.slice(0, this.#index + 1);
    let bytes = this.#bytes + stored.voxels.byteLength;
    for (let i = next.length; i < this.#entries.length; i++) bytes -= this.#entries[i].grid.voxels.byteLength;
    next.push({ grid: stored, label });
    // Scott's ruling (2026-11-15): past maxBytes drop the oldest step, never the one just pushed.
    while (next.length > this.#maxDepth || (next.length > 1 && bytes > this.#maxBytes))
      bytes -= next.shift()!.grid.voxels.byteLength;
    this.#entries = next;
    this.#index = next.length - 1;
    this.#bytes = bytes;
    return copyGrid(stored);
  }

  /** Move to the previous step and return a copy of its grid, or the current copy if at the start. */
  undo(): VoxelGrid {
    if (this.#index > 0) this.#index--;
    return this.current;
  }

  /** Move to the next step and return a copy of its grid, or the current copy if at the end. */
  redo(): VoxelGrid {
    if (this.#index < this.#entries.length - 1) this.#index++;
    return this.current;
  }

  /**
   * Jump to a stored step by index (0 is the oldest) and return a copy of its grid.
   * @throws RangeError when `index` is out of range.
   */
  go(index: number): VoxelGrid {
    if (!Number.isInteger(index) || index < 0 || index >= this.#entries.length)
      throw new RangeError(
        `History index ${index} is out of range 0 to ${this.#entries.length - 1}; pass an index of an existing entry`,
      );
    this.#index = index;
    return this.current;
  }

  /** Copies of the stored entries, oldest first. */
  entries(): readonly HistoryEntry[] {
    return this.#entries.map((entry) => ({ grid: copyGrid(entry.grid), label: entry.label }));
  }
}

function copyGrid(grid: VoxelGrid): VoxelGrid {
  return { size: [grid.size[0], grid.size[1], grid.size[2]], voxels: new Uint8Array(grid.voxels) };
}

function checkDepth(value: number | undefined): number {
  if (value === undefined) return 64;
  if (!Number.isInteger(value) || value < 1 || value > 1024)
    throw new RangeError('History maxDepth must be an integer from 1 to 1024');
  return value;
}
