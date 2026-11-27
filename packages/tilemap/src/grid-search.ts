// What the grid searches of @margoengine/tilemap share (path, replan and hpa): the binary heap, the option checks, the
// steps from a cell and the distance estimate.
import { cellNeighbors, type MapGrid } from './layout.js';
import type { CostGrid, PathOptions } from './path.js';

/** The corner-step rule of {@link PathOptions}. */
export type Diagonal = NonNullable<PathOptions['diagonal']>;

export const SQRT2 = Math.SQRT2;
export const open = (c: number): boolean => c > 0 && c < Number.POSITIVE_INFINITY;

/** A binary min-heap of cell indices by priority; ties pop the cell pushed first. */
export class Heap {
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

export const check = (grid: CostGrid, options: PathOptions) => {
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
export const steps = (
  grid: CostGrid,
  square: boolean,
  diagonal: Diagonal,
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

export const index = (grid: CostGrid, [x, y]: readonly [number, number], what: string): number => {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= grid.width || y >= grid.height)
    throw new RangeError(
      `${what} (${x}, ${y}) is outside the ${grid.width} x ${grid.height} grid; pass a cell inside it.`,
    );
  return y * grid.width + x;
};

/**
 * An estimate of the cost between two cells that never overestimates, for a grid whose open cells cost `low` or more:
 * the octile distance (the hex distance on staggered and hexagonal maps, the row and column distance without corner
 * steps) times `low`. It also obeys the triangle inequality.
 */
export const estimator = (grid: CostGrid, square: boolean, diagonal: Diagonal, low: number) => {
  const { width } = grid;
  return (a: number, b: number): number => {
    const ax = a % width,
      ay = (a - ax) / width,
      bx = b % width,
      by = (b - bx) / width;
    if (!square) {
      const from = cube(grid.layout!, ax, ay),
        to = cube(grid.layout!, bx, by);
      return low * Math.max(Math.abs(from[0] - to[0]), Math.abs(from[1] - to[1]), Math.abs(from[2] - to[2]));
    }
    const dx = Math.abs(ax - bx),
      dy = Math.abs(ay - by);
    return low * (diagonal === 'never' ? dx + dy : Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy));
  };
};

// Cube coordinates of staggered and hexagonal cells, as in ./hex.ts (kept here so this entry does not load it).
export const cube = (map: MapGrid, x: number, y: number): [number, number, number] => {
  const odd = (map.staggerIndex ?? 'odd') === 'odd';
  if ((map.staggerAxis ?? 'y') === 'y') {
    const q = x - (odd ? (y - (y & 1)) / 2 : (y + (y & 1)) / 2);
    return [q, y, -q - y];
  }
  const r = y - (odd ? (x - (x & 1)) / 2 : (x + (x & 1)) / 2);
  return [x, r, -x - r];
};
