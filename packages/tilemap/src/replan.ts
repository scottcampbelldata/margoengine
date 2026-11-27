// Incremental replanning on a cost grid: D* Lite (S. Koenig and M. Likhachev, "D* Lite", AAAI 2002, pages 476-483,
// https://cdn.aaai.org/AAAI/2002/AAAI02-072.pdf, the optimized version of its figure 4). The search runs from the goal
// toward the start and keeps every cell's distance to the goal (g) and its one-step look-ahead of it (rhs). After costs
// change, or the start moves, only the cells whose two values disagree and that can matter to the start are expanded
// again; a key modifier (km) keeps the queued keys valid as the start moves.
// Costs here are floating point, where the same distance summed in two orders can differ in its last bits, so the search
// stops only once the cheapest queued key is above the start's by more than a billionth of it (the paper stops on the
// tie); the extra expansions are ordinary ones, so the distances stay those of the paper's search.
import { check, type Diagonal, estimator, index, open, steps } from './grid-search.js';
import type { CostGrid, GridPath, PathOptions } from './path.js';

/** Settings of {@link PathReplanner}. */
export interface ReplanOptions {
  /** Corner steps, as `findPath` takes them. Default `'no-corners'`. */
  diagonal?: PathOptions['diagonal'];
  /** Stops one `findPath` call after this many expanded cells; the work done is kept. Default 1,000,000. */
  maxCells?: number;
  /**
   * The lowest cost an open cell will ever have, which the distance estimate is multiplied by. A changed cell below it
   * starts the search afresh, so set it when costs will drop below today's lowest. Default the lowest cost on the grid.
   */
  minCost?: number;
}

/**
 * Cheapest paths to one goal over a grid that changes, for a unit that moves along its path and learns of new walls on
 * the way. Change `grid.cost`, tell {@link PathReplanner.update} which cells changed, and ask for the path again: the
 * cost is the one a fresh A* search would find, usually for a fraction of the work.
 */
export class PathReplanner {
  /** The grid searched; change its costs in place, then call {@link update}. */
  readonly grid: CostGrid;
  readonly goal: readonly [number, number];
  private readonly diagonal: Diagonal;
  private readonly square: boolean;
  private readonly max: number;
  private readonly to: number;
  private low: number;
  private estimate: (a: number, b: number) => number;
  /** The start of the last search, -1 before the first. */
  private last = -1;
  private km = 0;
  private readonly g: Float64Array;
  private readonly rhs: Float64Array;
  // An indexed binary heap of the inconsistent cells, ordered by the two keys; `slot` is a cell's place, -1 outside.
  private readonly heap: number[] = [];
  private readonly slot: Int32Array;
  private readonly key1: Float64Array;
  private readonly key2: Float64Array;

  constructor(grid: CostGrid, goal: readonly [number, number], options: ReplanOptions = {}) {
    const { diagonal, max, square } = check(grid, options);
    this.grid = grid;
    this.diagonal = diagonal;
    this.square = square;
    this.max = max;
    this.to = index(grid, goal, 'goal');
    this.goal = [goal[0], goal[1]];
    let low = options.minCost;
    if (low === undefined) {
      low = Number.POSITIVE_INFINITY;
      for (let i = 0; i < grid.cost.length; i++) if (open(grid.cost[i]) && grid.cost[i] < low) low = grid.cost[i];
      if (low === Number.POSITIVE_INFINITY) low = 1;
    } else if (!open(low)) throw new RangeError(`minCost must be a finite number above 0, got ${low}.`);
    this.low = low;
    this.estimate = estimator(grid, square, diagonal, low);
    const size = grid.cost.length;
    this.g = new Float64Array(size);
    this.rhs = new Float64Array(size);
    this.slot = new Int32Array(size);
    this.key1 = new Float64Array(size);
    this.key2 = new Float64Array(size);
  }

  /**
   * Tells the replanner which cells' costs changed since the last call. Every changed cell must be listed, or later
   * paths may use the old costs.
   */
  update(cells: Iterable<readonly [number, number]>): this {
    const { grid } = this,
      touched = new Set<number>();
    let lower = this.low;
    for (const cell of cells) {
      const c = index(grid, cell, 'cell'),
        [x, y] = cell;
      if (open(grid.cost[c]) && grid.cost[c] < lower) lower = grid.cost[c];
      // A cell's cost and openness reach the steps of the cells beside it (a corner step passes between two of them).
      touched.add(c);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (x + dx >= 0 && y + dy >= 0 && x + dx < grid.width && y + dy < grid.height)
            touched.add(c + dy * grid.width + dx);
    }
    if (lower < this.low) {
      // The estimate would overestimate now: search afresh with the new lowest cost.
      this.low = lower;
      this.estimate = estimator(grid, this.square, this.diagonal, lower);
      this.last = -1;
    } else if (this.last >= 0)
      for (const c of touched) {
        this.look(c);
        this.place(c);
      }
    return this;
  }

  /**
   * A cheapest path from `start` to the goal under the costs as last told, or null when there is no way (or `maxCells`
   * ran out; calling again continues from there). `searched` counts the cells this call expanded.
   */
  findPath(start: readonly [number, number]): GridPath | null {
    const { grid, g, rhs, to } = this,
      { cost, width } = grid,
      from = index(grid, start, 'start');
    if (this.last < 0) {
      g.fill(Number.POSITIVE_INFINITY);
      rhs.fill(Number.POSITIVE_INFINITY);
      this.slot.fill(-1);
      this.heap.length = 0;
      this.km = 0;
      this.last = from;
      this.look(to);
      this.place(to);
    } else if (from !== this.last) {
      this.km += this.estimate(this.last, from);
      this.last = from;
    }
    if (!open(cost[from]) || !open(cost[to])) return null;
    const searched = this.search(from);
    if (searched < 0 || rhs[from] === Number.POSITIVE_INFINITY) return null;
    // Walk down the distances: from each cell take the step whose cost plus the distance beyond it is lowest.
    const cells: [number, number][] = [[start[0], start[1]]];
    let spent = 0;
    for (let c = from; c !== to; ) {
      let best = Number.POSITIVE_INFINITY,
        next = -1,
        paid = 0;
      steps(grid, this.square, this.diagonal, c, (n, length) => {
        const total = cost[n] * length + g[n];
        if (total < best) {
          best = total;
          next = n;
          paid = cost[n] * length;
        }
      });
      if (next < 0 || cells.length > cost.length)
        throw new Error('the grid changed without update(); pass every changed cell to update() before findPath().');
      c = next;
      spent += paid;
      cells.push([c % width, Math.floor(c / width)]);
    }
    return { cells, cost: spent, searched, scanned: 0 };
  }

  /** Sets a cell's look-ahead from its steps: 0 at an open goal, Infinity on a blocked cell. */
  private look(c: number): void {
    const { grid, g } = this,
      { cost } = grid;
    let best = Number.POSITIVE_INFINITY;
    if (open(cost[c])) {
      if (c === this.to) best = 0;
      else
        steps(grid, this.square, this.diagonal, c, (n, length) => {
          const total = cost[n] * length + g[n];
          if (total < best) best = total;
        });
    }
    this.rhs[c] = best;
  }

  /** Expands cells until the start's distance is settled; the cells expanded, or -1 when `maxCells` ran out. */
  private search(from: number): number {
    const { grid, g, rhs, heap, key1, key2, to } = this,
      { cost } = grid;
    let expanded = 0;
    while (heap.length) {
      const u = heap[0],
        reach = Math.min(g[from], rhs[from]) + this.km;
      if (!(key1[u] <= reach + reach * 1e-9 || rhs[from] > g[from])) break;
      const m = Math.min(g[u], rhs[u]),
        k1 = m + this.estimate(this.last, u) + this.km;
      // Queued before the start moved: give it today's key and look again.
      if (key1[u] < k1 || (key1[u] === k1 && key2[u] < m)) {
        this.place(u);
        continue;
      }
      if (++expanded > this.max) return -1;
      if (g[u] > rhs[u]) {
        g[u] = rhs[u];
        this.remove(u);
        if (!open(cost[u])) continue;
        steps(grid, this.square, this.diagonal, u, (s, length) => {
          if (s !== to) rhs[s] = Math.min(rhs[s], cost[u] * length + g[u]);
          this.place(s);
        });
      } else {
        const old = g[u];
        g[u] = Number.POSITIVE_INFINITY;
        steps(grid, this.square, this.diagonal, u, (s, length) => {
          // Only a cell whose look-ahead came through u can have lost by it.
          if (s !== to && rhs[s] === cost[u] * length + old) this.look(s);
          this.place(s);
        });
        this.place(u);
      }
    }
    return expanded;
  }

  /** Queues `u` under today's key when its distance and look-ahead disagree, and takes it out when they agree. */
  private place(u: number): void {
    const { g, rhs, slot, key1, key2, heap } = this;
    if (g[u] === rhs[u]) {
      this.remove(u);
      return;
    }
    const m = Math.min(g[u], rhs[u]);
    key1[u] = m + this.estimate(this.last, u) + this.km;
    key2[u] = m;
    if (slot[u] < 0) {
      slot[u] = heap.length;
      heap.push(u);
    }
    this.sift(slot[u]);
  }

  private remove(u: number): void {
    const { slot, heap } = this,
      i = slot[u];
    if (i < 0) return;
    slot[u] = -1;
    const last = heap.pop()!;
    if (last === u) return;
    heap[i] = last;
    slot[last] = i;
    this.sift(i);
  }

  /** Moves the cell in place `i` up or down to where its key belongs. */
  private sift(i: number): void {
    const { heap, slot, key1, key2 } = this,
      cell = heap[i],
      before = (a: number, b: number) => key1[a] < key1[b] || (key1[a] === key1[b] && key2[a] < key2[b]);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!before(cell, heap[parent])) break;
      heap[i] = heap[parent];
      slot[heap[i]] = i;
      i = parent;
    }
    for (;;) {
      let child = i * 2 + 1;
      if (child >= heap.length) break;
      if (child + 1 < heap.length && before(heap[child + 1], heap[child])) child++;
      if (!before(heap[child], cell)) break;
      heap[i] = heap[child];
      slot[heap[i]] = i;
      i = child;
    }
    heap[i] = cell;
    slot[cell] = i;
  }
}
