// Grid pathfinding over tile maps: A* from a start to a goal, and a flow field (every cell's cost to the nearest goal
// and the next cell toward it) by Dijkstra's search run from the goals. Both expand the cell with the lowest priority
// in a binary heap and stop a cell once it is popped; A* adds an estimate that never exceeds the true cost, so its first
// path to the goal is a cheapest one (A. Patel, "Introduction to the A* Algorithm", Red Blob Games, 2014, which credits
// P. Hart, N. Nilsson and B. Raphael, IEEE Transactions on Systems Science and Cybernetics 4(2), 1968).
import { GID_MASK, type Properties, type TileLayer, type TileMapData } from './index.js';
import { cellNeighbors, type MapGrid } from './layout.js';

/** Cells to search: `cost[y * width + x]` is the price of stepping into a cell; 0, a negative or Infinity blocks it. */
export interface CostGrid {
  readonly width: number;
  readonly height: number;
  readonly cost: ArrayLike<number>;
  /**
   * The map's layout, for staggered and hexagonal maps: steps go to the cells that share an edge. Orthogonal and
   * isometric grids (and no layout) step along rows and columns, and across corners as `diagonal` allows.
   */
  readonly layout?: MapGrid;
}

/** Settings of {@link findPath} and {@link flowField}. */
export interface PathOptions {
  /**
   * Corner steps on orthogonal and isometric grids, which cost `cost * sqrt(2)`: `'never'`, `'always'`, or
   * `'no-corners'` (default), which allows one only when both cells beside it are open, so paths do not cut wall corners.
   */
  diagonal?: 'never' | 'always' | 'no-corners';
  /** Stops a search after this many cells; `findPath` then returns null. Default 1,000,000. */
  maxCells?: number;
}

/** Settings of {@link tileCosts}. */
export interface TileCostOptions {
  /** Tile layers to read, by name; a cell takes the highest cost of its tiles. Default every tile layer. */
  layers?: readonly string[];
  /** Tile property holding a cost, a number above 0. Default `'cost'`. */
  property?: string;
  /** Tile property that blocks a cell when true. Default `'solid'`. */
  solid?: string;
  /** Cost of an empty cell, or of a tile without the property. Default 1. */
  fallback?: number;
  /** Cost of a cell no layer has a tile in: Infinity blocks the gaps. Default `fallback`. */
  empty?: number;
}

/**
 * Costs from a tile map's tile properties: a tile with `solid: true` blocks its cell, one with a numeric `cost`
 * sets it, others cost `fallback`. The map's layout comes along, so the grid steps as the map does.
 */
export function tileCosts(map: TileMapData, options: TileCostOptions = {}): CostGrid {
  const { property = 'cost', solid = 'solid', fallback = 1 } = options,
    empty = options.empty ?? fallback;
  if (!(fallback > 0)) throw new RangeError(`fallback must be above 0, got ${fallback}.`);
  const width = map.width,
    height = map.height,
    cost = new Float64Array(width * height).fill(Number.NaN),
    byGid = new Map<number, number>();
  const tileCost = (gid: number): number => {
    let c = byGid.get(gid);
    if (c !== undefined) return c;
    let props: Properties | undefined;
    for (const set of map.tilesets)
      if (gid >= set.firstGid && gid < set.firstGid + set.tileCount)
        props = set.tiles?.find((t) => t.id === gid - set.firstGid)?.properties;
    const p = props?.[property];
    c = props?.[solid] === true ? Number.POSITIVE_INFINITY : typeof p === 'number' && p > 0 ? p : fallback;
    byGid.set(gid, c);
    return c;
  };
  const layers = map.layers.filter(
    (l): l is TileLayer => l.type === 'tile' && (!options.layers || options.layers.includes(l.name)),
  );
  for (const layer of layers) {
    if (layer.width !== width || layer.height !== height)
      throw new RangeError(
        `layer "${layer.name}" is ${layer.width} x ${layer.height}, the map ${width} x ${height}; every tile layer must match the map size.`,
      );
    for (let i = 0; i < cost.length; i++) {
      const gid = layer.data[i] & GID_MASK;
      if (!gid) continue;
      const c = tileCost(gid);
      cost[i] = Number.isNaN(cost[i]) ? c : Math.max(cost[i], c);
    }
  }
  for (let i = 0; i < cost.length; i++) if (Number.isNaN(cost[i])) cost[i] = empty;
  return { width, height, cost, layout: map };
}

const SQRT2 = Math.SQRT2;
const open = (c: number): boolean => c > 0 && c < Number.POSITIVE_INFINITY;

/** A binary min-heap of cell indices by priority; ties pop the cell pushed first. */
class Heap {
  private cells: number[] = [];
  private keys: number[] = [];
  private order: number[] = [];
  private pushed = 0;
  get size(): number {
    return this.cells.length;
  }
  private less(a: number, b: number): boolean {
    return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.order[a] < this.order[b]);
  }
  private swap(a: number, b: number): void {
    for (const list of [this.cells, this.keys, this.order]) [list[a], list[b]] = [list[b], list[a]];
  }
  push(cell: number, key: number): void {
    let i = this.cells.length;
    this.cells.push(cell);
    this.keys.push(key);
    this.order.push(this.pushed++);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  pop(): number {
    const top = this.cells[0],
      last = this.cells.length - 1;
    this.swap(0, last);
    this.cells.pop();
    this.keys.pop();
    this.order.pop();
    for (let i = 0; ; ) {
      const l = i * 2 + 1,
        r = l + 1;
      let m = i;
      if (l < this.cells.length && this.less(l, m)) m = l;
      if (r < this.cells.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
    return top;
  }
}

const check = (grid: CostGrid, options: PathOptions) => {
  if (
    !grid ||
    !Number.isInteger(grid.width) ||
    !Number.isInteger(grid.height) ||
    grid.cost?.length !== grid.width * grid.height
  )
    throw new RangeError('a CostGrid needs whole width and height and width * height costs.');
  const diagonal = options.diagonal ?? 'no-corners';
  if (diagonal !== 'never' && diagonal !== 'always' && diagonal !== 'no-corners')
    throw new RangeError(`diagonal must be never, always or no-corners, got ${diagonal}.`);
  const max = options.maxCells ?? 1_000_000;
  if (!(max >= 1)) throw new RangeError(`maxCells must be 1 or more, got ${max}.`);
  const orientation = grid.layout?.orientation ?? 'orthogonal';
  return { diagonal, max, square: orientation === 'orthogonal' || orientation === 'isometric' };
};

/** Calls `visit(next, length)` for each open step from `cell`; steps are symmetric, so the same edges serve both ways. */
const steps = (
  grid: CostGrid,
  square: boolean,
  diagonal: 'never' | 'always' | 'no-corners',
  cell: number,
  visit: (next: number, length: number) => void,
) => {
  const { width, height, cost } = grid,
    x = cell % width,
    y = (cell - x) / width,
    inside = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < width && cy < height;
  if (!square) {
    for (const [nx, ny] of cellNeighbors(grid.layout!, x, y))
      if (inside(nx, ny) && open(cost[ny * width + nx])) visit(ny * width + nx, 1);
    return;
  }
  for (const [dx, dy] of [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ])
    if (inside(x + dx, y + dy) && open(cost[(y + dy) * width + x + dx])) visit((y + dy) * width + x + dx, 1);
  if (diagonal === 'never') return;
  for (const [dx, dy] of [
    [1, -1],
    [1, 1],
    [-1, 1],
    [-1, -1],
  ]) {
    if (!inside(x + dx, y + dy) || !open(cost[(y + dy) * width + x + dx])) continue;
    if (diagonal === 'no-corners' && !(open(cost[y * width + x + dx]) && open(cost[(y + dy) * width + x]))) continue;
    visit((y + dy) * width + x + dx, SQRT2);
  }
};

const index = (grid: CostGrid, [x, y]: readonly [number, number], what: string): number => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= grid.width || y >= grid.height)
    throw new RangeError(
      `${what} (${x}, ${y}) is outside the ${grid.width} x ${grid.height} grid; pass a cell inside it.`,
    );
  return y * grid.width + x;
};

/** The result of {@link findPath}: the cells from start to goal, both included, and the summed cost of the steps. */
export interface GridPath {
  readonly cells: [number, number][];
  readonly cost: number;
}

/**
 * A cheapest path from `start` to `goal` by A*, or null when the goal cannot be reached (or `maxCells` ran out). A step
 * costs the cell it enters times its length (1, or sqrt(2) across a corner). The estimate is the octile distance (the
 * hex distance on staggered and hexagonal maps) times the lowest cost on the grid, which never overestimates.
 */
export function findPath(
  grid: CostGrid,
  start: readonly [number, number],
  goal: readonly [number, number],
  options: PathOptions = {},
): GridPath | null {
  const { diagonal, max, square } = check(grid, options),
    from = index(grid, start, 'start'),
    to = index(grid, goal, 'goal'),
    { width, cost } = grid;
  if (!open(cost[to]) || !open(cost[from])) return null;
  let low = Number.POSITIVE_INFINITY;
  for (let i = 0; i < cost.length; i++) if (open(cost[i]) && cost[i] < low) low = cost[i];
  const gx = goal[0],
    gy = goal[1],
    goalCube = square ? undefined : cube(grid.layout!, gx, gy);
  const estimate = (cell: number): number => {
    const x = cell % width,
      y = (cell - x) / width;
    if (goalCube) {
      const [q, r, s] = cube(grid.layout!, x, y);
      return low * Math.max(Math.abs(q - goalCube[0]), Math.abs(r - goalCube[1]), Math.abs(s - goalCube[2]));
    }
    const dx = Math.abs(x - gx),
      dy = Math.abs(y - gy);
    return low * (diagonal === 'never' ? dx + dy : Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy));
  };
  const spent = new Float64Array(cost.length).fill(Number.POSITIVE_INFINITY),
    came = new Int32Array(cost.length).fill(-1),
    done = new Uint8Array(cost.length),
    heap = new Heap();
  spent[from] = 0;
  heap.push(from, estimate(from));
  let popped = 0;
  while (heap.size) {
    const cell = heap.pop();
    if (done[cell]) continue;
    done[cell] = 1;
    if (cell === to) break;
    if (++popped > max) return null;
    steps(grid, square, diagonal, cell, (next, length) => {
      const total = spent[cell] + cost[next] * length;
      if (total < spent[next]) {
        spent[next] = total;
        came[next] = cell;
        heap.push(next, total + estimate(next));
      }
    });
  }
  if (!done[to]) return null;
  const cells: [number, number][] = [];
  for (let c = to; c !== -1; c = came[c]) cells.push([c % width, Math.floor(c / width)]);
  return { cells: cells.reverse(), cost: spent[to] };
}

// Cube coordinates of staggered and hexagonal cells, as in ./hex.ts (kept here so this entry does not load it).
const cube = (map: MapGrid, x: number, y: number): [number, number, number] => {
  const odd = (map.staggerIndex ?? 'odd') === 'odd';
  if ((map.staggerAxis ?? 'y') === 'y') {
    const q = x - (odd ? (y - (y & 1)) / 2 : (y + (y & 1)) / 2);
    return [q, y, -q - y];
  }
  const r = y - (odd ? (x - (x & 1)) / 2 : (x + (x & 1)) / 2);
  return [x, r, -x - r];
};

/** The result of {@link flowField}. */
export interface FlowField {
  readonly width: number;
  readonly height: number;
  /** Each cell's cost to reach the nearest goal; Infinity where none can be reached. */
  readonly distance: Float64Array;
  /** Each cell's next cell toward that goal, `y * width + x`; -1 at goals and where none can be reached. */
  readonly next: Int32Array;
}

/**
 * Every cell's cheapest cost to the nearest of `goals`, and the next cell toward it, by Dijkstra's search from the goals
 * outward. Steps cost as in {@link findPath}, so following `next` from any cell walks one of its cheapest paths.
 */
export function flowField(
  grid: CostGrid,
  goals: readonly (readonly [number, number])[],
  options: PathOptions = {},
): FlowField {
  const { diagonal, max, square } = check(grid, options),
    { width, height, cost } = grid,
    distance = new Float64Array(cost.length).fill(Number.POSITIVE_INFINITY),
    next = new Int32Array(cost.length).fill(-1),
    done = new Uint8Array(cost.length),
    heap = new Heap();
  for (const goal of goals) {
    const g = index(grid, goal, 'goal');
    if (open(cost[g]) && distance[g] !== 0) {
      distance[g] = 0;
      heap.push(g, 0);
    }
  }
  let popped = 0;
  while (heap.size && popped < max) {
    const cell = heap.pop();
    if (done[cell]) continue;
    done[cell] = 1;
    popped++;
    // Stepping from a neighbour into this cell costs this cell's cost times the step's length.
    steps(grid, square, diagonal, cell, (from, length) => {
      const total = distance[cell] + cost[cell] * length;
      if (total < distance[from]) {
        distance[from] = total;
        next[from] = cell;
        heap.push(from, total);
      }
    });
  }
  return { width, height, distance, next };
}

/** The cells from (`x`, `y`) along a flow field to its goal, both included; just the start when it has no way. */
export function followFlow(field: FlowField, x: number, y: number): [number, number][] {
  const out: [number, number][] = [[x, y]];
  for (let c = field.next[y * field.width + x], n = 0; c !== -1 && n < field.next.length; c = field.next[c], n++)
    out.push([c % field.width, Math.floor(c / field.width)]);
  return out;
}
