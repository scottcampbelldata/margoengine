// Flow fields: one field per goal steers any number of units. The three fields (cost, integration, flow), walls at cost
// 255, the line of sight flags near the goal, cost stamps and steering are E. Emerson, "Crowd Pathfinding and Steering
// Using Flow Field Tiles", Game AI Pro, chapter 23, 2013. Integration solves the eikonal equation by fast marching as
// A. Treuille, S. Cooper, Z. Popovic, "Continuum Crowds", SIGGRAPH 2006, section 4.3, sets out, so distances are round
// and there are no diamond shapes around the goal.

/** A position or direction, `[x, y, z]`. */
export type Point = ArrayLike<number>;

/** Cost of a wall: nothing crosses it. */
export const WALL = 255;

/** Options of {@link FlowField}. */
export interface FlowFieldOptions {
  /** Lowest corner on the ground plane, `[x, z]` (default `[0, 0]`). */
  min?: readonly [number, number];
  /** Cells along x and along z. */
  size: readonly [number, number];
  /** Cell width (default 1). */
  cell?: number;
  /**
   * Cost per cell, row by row along x: 1 is clear, up to 254 is slow ground, 255 is a wall. A function is called with
   * each cell's centre (default all clear).
   */
  cost?: ArrayLike<number> | ((x: number, z: number) => number);
}

/** Structure-of-arrays units for {@link FlowField.steer}. ECS component fields fit as they are. */
export interface FlowFieldUnits {
  /** Position along x. */
  x: { [index: number]: number };
  /** Position along z. */
  z: { [index: number]: number };
}

const SQRT2 = Math.SQRT2;
// Neighbour order: the four sides, then the four corners.
const STEP_X = [1, -1, 0, 0, 1, 1, -1, -1];
const STEP_Z = [0, 0, 1, -1, 1, -1, 1, -1];

/**
 * A grid that steers units to a goal from anywhere. Set a goal with {@link FlowField.setGoal}, then read
 * {@link FlowField.direction} per unit, or move a whole array at once with {@link FlowField.steer}. The work is per
 * cell, not per unit, so a thousand units cost a thousand lookups.
 * @example
 * const field = new FlowField({ size: [64, 64], cost: (x, z) => (x > 30 && x < 32 && z < 50 ? WALL : 1) });
 * field.setGoal([60, 0, 5]);
 * const heading = field.direction([2, 0, 2]);
 */
export class FlowField {
  /** Cells along x. */
  readonly width: number;
  /** Cells along z. */
  readonly depth: number;
  /** Cell width. */
  readonly cell: number;
  /** Cost per cell. After changing it call {@link FlowField.rebuild}. */
  readonly cost: Uint8Array;
  /** Travel cost to the goal per cell; `Infinity` for walls and cells cut off from the goal. */
  readonly integration: Float32Array;
  /** The neighbour to step to per cell, 0 to 7, or -1 for none: a goal, a wall, or cut off. */
  readonly flow: Int8Array;
  /** 1 for cells that see the goal in a straight clear line, which steer at the goal itself. */
  readonly lineOfSight: Uint8Array;
  private readonly minX: number;
  private readonly minZ: number;
  private goals: readonly (readonly [number, number, number])[] = [];
  private readonly heapCells: Int32Array;
  private readonly heapAt: Int32Array;
  private heapSize = 0;
  // Live cost stamps, oldest first: each maps a cell to the cost it replaced.
  private readonly stamps: Map<number, number>[] = [];

  /** @throws TypeError or RangeError for a malformed option. */
  constructor(options: FlowFieldOptions) {
    if (options == null || typeof options !== 'object') throw new TypeError('A flow field must be {size, cell, cost}');
    const { size, min = [0, 0], cell = 1, cost } = options;
    const width = size?.[0] as number;
    const depth = size?.[1] as number;
    if (!Number.isInteger(width) || !Number.isInteger(depth) || width < 1 || depth < 1)
      throw new RangeError('Flow field size must be two whole numbers of 1 or more');
    if (!(cell > 0) || !Number.isFinite(cell)) throw new RangeError('Flow field cell must be above 0');
    if (!Number.isFinite(min[0]) || !Number.isFinite(min[1])) throw new RangeError('Flow field min must be [x, z]');
    this.width = width;
    this.depth = depth;
    this.cell = cell;
    this.minX = min[0];
    this.minZ = min[1];
    const count = width * depth;
    this.cost = new Uint8Array(count).fill(1);
    if (typeof cost === 'function') {
      for (let z = 0; z < depth; z++)
        for (let x = 0; x < width; x++)
          this.cost[z * width + x] = this.checkCost(cost(min[0] + (x + 0.5) * cell, min[1] + (z + 0.5) * cell));
    } else if (cost != null) {
      if (cost.length !== count) throw new RangeError(`Flow field cost must hold ${count} cells, not ${cost.length}`);
      for (let i = 0; i < count; i++) this.cost[i] = this.checkCost(cost[i] as number);
    }
    this.integration = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
    this.flow = new Int8Array(count).fill(-1);
    this.lineOfSight = new Uint8Array(count);
    this.heapCells = new Int32Array(count);
    this.heapAt = new Int32Array(count).fill(-1);
  }

  private checkCost(value: number): number {
    if (!Number.isInteger(value) || value < 1 || value > WALL)
      throw new RangeError('Flow field cost must be a whole number from 1 to 255');
    return value;
  }

  /** The cell holding a world position, or -1 outside the grid. */
  cellAt(position: Point): number {
    const x = Math.floor(((position[0] as number) - this.minX) / this.cell);
    const z = Math.floor(((position[2] as number) - this.minZ) / this.cell);
    return x < 0 || z < 0 || x >= this.width || z >= this.depth ? -1 : z * this.width + x;
  }

  /**
   * Set where units go and build the field. Several goals work: each unit heads for its cheapest. Line of sight
   * flags are built for a single goal only.
   * @param goals One position, or several.
   * @returns True when at least one goal is on open ground inside the grid.
   * @throws RangeError for a malformed position.
   */
  setGoal(goals: Point | readonly Point[]): boolean {
    if (goals == null) throw new RangeError('A flow field goal must be [x, y, z] with finite numbers');
    const list = (typeof (goals as Point)[0] === 'number' ? [goals] : goals) as readonly Point[];
    this.goals = list.map((goal) => {
      if (
        goal == null ||
        goal.length < 3 ||
        !Number.isFinite(goal[0]) ||
        !Number.isFinite(goal[1]) ||
        !Number.isFinite(goal[2])
      )
        throw new RangeError('A flow field goal must be [x, y, z] with finite numbers');
      return [goal[0], goal[1], goal[2]] as [number, number, number];
    });
    return this.rebuild();
  }

  /**
   * Replace the costs of a rectangle of cells and rebuild, for a building dropped on the map. `x` and `z` are world
   * positions of the rectangle's low corner.
   * @returns A function that puts the old costs back and rebuilds. Overlapping stamps may be undone in any order: a
   * cell still under a later stamp keeps that stamp's cost, and the cost from before the first stamp returns when the
   * last one covering the cell is undone. A second call does nothing.
   */
  stamp(x: number, z: number, cellsX: number, cellsZ: number, cost: number): () => void {
    this.checkCost(cost);
    if (!Number.isFinite(x) || !Number.isFinite(z))
      throw new RangeError('Flow field stamp x and z must be finite numbers');
    if (!Number.isInteger(cellsX) || !Number.isInteger(cellsZ) || cellsX < 1 || cellsZ < 1)
      throw new RangeError('Flow field stamp size must be two whole numbers of 1 or more');
    const startX = Math.floor((x - this.minX) / this.cell);
    const startZ = Math.floor((z - this.minZ) / this.cell);
    const saved = new Map<number, number>();
    for (let row = Math.max(0, startZ); row < Math.min(this.depth, startZ + cellsZ); row++)
      for (let column = Math.max(0, startX); column < Math.min(this.width, startX + cellsX); column++) {
        const at = row * this.width + column;
        saved.set(at, this.cost[at] as number);
        this.cost[at] = cost;
      }
    this.stamps.push(saved);
    this.rebuild();
    return () => {
      const index = this.stamps.indexOf(saved);
      if (index < 0) return;
      this.stamps.splice(index, 1);
      for (const [at, old] of saved) {
        // A later stamp over this cell saved this stamp's cost as its "before"; hand it the real one instead.
        const later = this.stamps.slice(index).find((stamp) => stamp.has(at));
        if (later) later.set(at, old);
        else this.cost[at] = old;
      }
      this.rebuild();
    };
  }

  /**
   * Build the integration and flow fields again from the costs and goals. Call it after writing {@link FlowField.cost}.
   * @returns True when at least one goal is on open ground inside the grid.
   */
  rebuild(): boolean {
    const { integration, flow, lineOfSight, cost, heapAt } = this;
    integration.fill(Number.POSITIVE_INFINITY);
    flow.fill(-1);
    lineOfSight.fill(0);
    heapAt.fill(-1);
    this.heapSize = 0;
    let seeded = 0;
    for (const goal of this.goals) {
      const cell = this.cellAt(goal);
      if (cell < 0 || cost[cell] === WALL) continue;
      seeded++;
      if (integration[cell] === 0) continue; // Two goals in one cell seed it once.
      integration[cell] = 0;
      this.heapUp(this.heapInsert(cell));
    }
    if (seeded === 0) return false;
    this.march();
    this.buildFlow();
    if (this.goals.length === 1) this.buildLineOfSight(this.cellAt(this.goals[0] as Point));
    return true;
  }

  private heapInsert(cell: number): number {
    const at = this.heapSize++;
    this.heapCells[at] = cell;
    this.heapAt[cell] = at;
    return at;
  }
  private heapUp(start: number): void {
    const { heapCells, heapAt, integration } = this;
    const cell = heapCells[start] as number;
    const value = integration[cell] as number;
    let at = start;
    while (at > 0) {
      const parent = (at - 1) >> 1;
      const other = heapCells[parent] as number;
      if ((integration[other] as number) <= value) break;
      heapCells[at] = other;
      heapAt[other] = at;
      at = parent;
    }
    heapCells[at] = cell;
    heapAt[cell] = at;
  }
  private heapPop(): number {
    const { heapCells, heapAt, integration } = this;
    const top = heapCells[0] as number;
    heapAt[top] = -2;
    const last = heapCells[--this.heapSize] as number;
    if (this.heapSize > 0) {
      const value = integration[last] as number;
      let at = 0;
      for (;;) {
        let child = at * 2 + 1;
        if (child >= this.heapSize) break;
        if (
          child + 1 < this.heapSize &&
          (integration[heapCells[child + 1] as number] as number) < (integration[heapCells[child] as number] as number)
        )
          child++;
        const other = heapCells[child] as number;
        if ((integration[other] as number) >= value) break;
        heapCells[at] = other;
        heapAt[other] = at;
        at = child;
      }
      heapCells[at] = last;
      heapAt[last] = at;
    }
    return top;
  }

  /** Fast marching: known cells grow from the goals, the cheapest candidate first. */
  private march(): void {
    const { width, depth, cost, integration, heapAt } = this;
    while (this.heapSize > 0) {
      const cell = this.heapPop();
      const x = cell % width;
      const z = (cell - x) / width;
      for (let side = 0; side < 4; side++) {
        const nx = x + (STEP_X[side] as number);
        const nz = z + (STEP_Z[side] as number);
        if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
        const next = nz * width + nx;
        if (cost[next] === WALL || heapAt[next] === -2) continue;
        const value = this.solve(nx, nz, cost[next] as number);
        if (value >= (integration[next] as number)) continue;
        integration[next] = value;
        this.heapUp(heapAt[next] === -1 ? this.heapInsert(next) : (heapAt[next] as number));
      }
    }
  }

  /** The larger root of the quadratic from the cheaper known neighbour on each axis (Treuille et al. equation 11). */
  private solve(x: number, z: number, price: number): number {
    const { width, depth, integration, heapAt } = this;
    const known = (cell: number): number =>
      heapAt[cell] === -2 ? (integration[cell] as number) : Number.POSITIVE_INFINITY;
    const at = z * width + x;
    const a = Math.min(
      x > 0 ? known(at - 1) : Number.POSITIVE_INFINITY,
      x + 1 < width ? known(at + 1) : Number.POSITIVE_INFINITY,
    );
    const b = Math.min(
      z > 0 ? known(at - width) : Number.POSITIVE_INFINITY,
      z + 1 < depth ? known(at + width) : Number.POSITIVE_INFINITY,
    );
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    if (high - low >= price) return low + price;
    return (low + high + Math.sqrt(2 * price * price - (high - low) * (high - low))) / 2;
  }

  /** Each cell points at its cheapest neighbour of eight, and never cuts the corner of a wall. */
  private buildFlow(): void {
    const { width, depth, cost, integration, flow } = this;
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++) {
        const cell = z * width + x;
        const here = integration[cell] as number;
        if (here === 0 || here === Number.POSITIVE_INFINITY) continue;
        // Compare slopes, so a corner's longer step does not win just by reaching further. Only downhill counts.
        let best = 0;
        let bestDirection = -1;
        for (let i = 0; i < 8; i++) {
          const nx = x + (STEP_X[i] as number);
          const nz = z + (STEP_Z[i] as number);
          if (nx < 0 || nz < 0 || nx >= width || nz >= depth) continue;
          if (i >= 4 && (cost[z * width + nx] === WALL || cost[nz * width + x] === WALL)) continue;
          const slope = ((integration[nz * width + nx] as number) - here) / (i >= 4 ? SQRT2 : 1);
          if (slope < best) {
            best = slope;
            bestDirection = i;
          }
        }
        flow[cell] = bestDirection;
      }
  }

  /**
   * Flag cells that see the goal. Rings grow from the goal, and a cell is flagged when it is clear ground and every
   * cell its straight line to the goal enters next is flagged. That can miss a few cells at the edge of a shadow, but
   * never flags one that cannot see the goal. Slow ground blocks the line, as the chapter has it: a unit there
   * should follow the flow around it.
   */
  private buildLineOfSight(goal: number): void {
    const { width, depth, cost, lineOfSight } = this;
    if (goal < 0 || cost[goal] === WALL) return;
    const gx = goal % width;
    const gz = (goal - gx) / width;
    lineOfSight[goal] = 1;
    const reach = Math.max(gx, width - 1 - gx, gz, depth - 1 - gz);
    const test = (x: number, z: number): void => {
      if (x < 0 || z < 0 || x >= width || z >= depth) return;
      const cell = z * width + x;
      if (cost[cell] !== 1) return;
      const dx = gx - x;
      const dz = gz - z;
      const ax = Math.abs(dx);
      const az = Math.abs(dz);
      const sx = Math.sign(dx);
      const sz = Math.sign(dz);
      const open = (cx: number, cz: number): boolean => lineOfSight[cz * width + cx] === 1;
      const clear = (cx: number, cz: number): boolean => cost[cz * width + cx] === 1;
      let visible: boolean;
      // A true diagonal only touches its two side cells at a corner, and they sit on this same ring: clear is enough.
      if (ax === az) visible = open(x + sx, z + sz) && clear(x + sx, z) && clear(x, z + sz);
      else if (ax > az) visible = open(x + sx, z) && (az === 0 || open(x + sx, z + sz));
      else visible = open(x, z + sz) && (ax === 0 || open(x + sx, z + sz));
      if (visible) lineOfSight[cell] = 1;
    };
    for (let ring = 1; ring <= reach; ring++) {
      for (let i = -ring; i <= ring; i++) {
        test(gx + i, gz - ring);
        test(gx + i, gz + ring);
      }
      for (let i = -ring + 1; i <= ring - 1; i++) {
        test(gx - ring, gz + i);
        test(gx + ring, gz + i);
      }
    }
  }

  /** True when a unit at `position` can reach a goal: an island test, as cheap as a lookup. */
  reachable(position: Point): boolean {
    const cell = this.cellAt(position);
    return cell >= 0 && this.integration[cell] !== Number.POSITIVE_INFINITY;
  }

  /**
   * The way to go from `position`: a unit vector on the ground plane, straight at the goal inside its line of sight,
   * along the flow elsewhere, and `[0, 0, 0]` at the goal, on a wall, cut off, or outside the grid.
   */
  direction(position: Point, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
    out[0] = out[1] = out[2] = 0;
    const cell = this.cellAt(position);
    if (cell < 0) return out;
    if (this.lineOfSight[cell] === 1) {
      const goal = this.goals[0] as readonly [number, number, number];
      const dx = goal[0] - (position[0] as number);
      const dz = goal[2] - (position[2] as number);
      const length = Math.hypot(dx, dz);
      if (length > 0) {
        out[0] = dx / length;
        out[2] = dz / length;
      }
      return out;
    }
    const step = this.flow[cell] as number;
    if (step < 0) return out;
    const length = step >= 4 ? SQRT2 : 1;
    out[0] = (STEP_X[step] as number) / length;
    out[2] = (STEP_Z[step] as number) / length;
    return out;
  }

  /**
   * Move `count` units along the field for `delta` seconds at `speed`, a cell at most per step, so no speed jumps a
   * wall. A step into a wall keeps the part along the wall, so units slide instead of sticking. It steers and nothing
   * more: units do not avoid each other, so add `separation` or physics for that.
   * @returns How many units moved.
   */
  steer(units: FlowFieldUnits, count: number, speed: number, delta: number): number {
    if (!Number.isInteger(count) || count < 0) throw new RangeError('Flow field steer count must be 0 or more');
    if (!(speed >= 0) || !Number.isFinite(speed)) throw new RangeError('Flow field steer speed must be 0 or more');
    if (!(delta >= 0) || !Number.isFinite(delta)) throw new RangeError('Flow field steer delta must be 0 or more');
    const { x, z } = units;
    const at: [number, number, number] = [0, 0, 0];
    const to: [number, number, number] = [0, 0, 0];
    const way: [number, number, number] = [0, 0, 0];
    let moving = 0;
    for (let i = 0; i < count; i++) {
      const startX = x[i] as number;
      const startZ = z[i] as number;
      at[0] = startX;
      at[2] = startZ;
      for (let left = speed * delta; left > 0; left -= this.cell) {
        this.direction(at, way);
        if (way[0] === 0 && way[2] === 0) break;
        let length = Math.min(left, this.cell);
        if (this.lineOfSight[this.cellAt(at)] === 1) {
          const goal = this.goals[0] as readonly [number, number, number];
          length = Math.min(length, Math.hypot(goal[0] - at[0], goal[2] - at[2]));
        }
        to[0] = at[0] + way[0] * length;
        to[2] = at[2];
        if (this.open(to)) at[0] = to[0];
        to[0] = at[0];
        to[2] = at[2] + way[2] * length;
        if (this.open(to)) at[2] = to[2];
      }
      x[i] = at[0];
      z[i] = at[2];
      if (x[i] !== startX || z[i] !== startZ) moving++;
    }
    return moving;
  }

  private open(position: Point): boolean {
    const cell = this.cellAt(position);
    return cell >= 0 && this.cost[cell] !== WALL;
  }
}
