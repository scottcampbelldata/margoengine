export interface Tile {
  weight?: number;
  neighbors: readonly (readonly number[])[];
}
export interface Pin {
  position: readonly [number, number, number];
  tile: number;
}
const directions = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
] as const;

/** 3D adjacency WFC, using <=32 tile types and deterministic contradiction retries. */
export class WFC {
  readonly cells: Uint32Array;
  private readonly allowed: Uint32Array;
  private readonly weights: Float64Array;
  private readonly weightedLogs: Float64Array;
  private readonly queue: Uint32Array;
  private readonly queued: Uint8Array;
  // Entropy before jitter depends only on a cell's mask, so each cell keeps the last mask it was computed for.
  private readonly entropyMasks: Uint32Array;
  private readonly entropies: Float64Array;
  private readonly union = new Int32Array(6);
  private readonly undecided: Uint32Array;
  private randomState = 1;
  private pending = 0;
  private readonly full: number;
  readonly dimensions: readonly [number, number, number];
  constructor(
    dimensions: readonly [number, number, number],
    readonly tiles: readonly Tile[],
  ) {
    if (
      dimensions.length !== 3 ||
      dimensions.some((n) => !Number.isInteger(n) || n < 1) ||
      dimensions[0] * dimensions[1] * dimensions[2] > 1_000_000 ||
      tiles.length < 1 ||
      tiles.length > 32
    )
      throw new RangeError('Invalid WFC dimensions or tile count');
    this.dimensions = [...dimensions];
    this.full = tiles.length === 32 ? 0xffffffff : (1 << tiles.length) - 1;
    this.cells = new Uint32Array(dimensions[0] * dimensions[1] * dimensions[2]);
    this.queue = new Uint32Array(this.cells.length);
    this.queued = new Uint8Array(this.cells.length);
    this.entropyMasks = new Uint32Array(this.cells.length);
    this.entropies = new Float64Array(this.cells.length);
    this.undecided = new Uint32Array(this.cells.length);
    this.weights = new Float64Array(tiles.length);
    this.weightedLogs = new Float64Array(tiles.length);
    this.allowed = new Uint32Array(tiles.length * 6);
    for (let tile = 0; tile < tiles.length; tile++) {
      const def = tiles[tile],
        weight = def.weight ?? 1;
      if (!Number.isFinite(weight) || weight <= 0 || def.neighbors.length !== 6)
        throw new TypeError('Tile needs positive weight and six neighbor lists');
      this.weights[tile] = weight;
      this.weightedLogs[tile] = weight * Math.log(weight);
      for (let direction = 0; direction < 6; direction++)
        for (const neighbor of def.neighbors[direction]) {
          if (
            !Number.isInteger(neighbor) ||
            neighbor < 0 ||
            neighbor >= tiles.length ||
            !tiles[neighbor].neighbors[direction ^ 1]?.includes(tile)
          )
            throw new TypeError('WFC adjacency must be valid and reciprocal');
          this.allowed[tile * 6 + direction] |= 1 << neighbor;
        }
    }
  }
  private random(): number {
    let x = this.randomState;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.randomState = x >>> 0;
    return this.randomState / 4294967296;
  }
  private enqueue(index: number): void {
    if (!this.queued[index]) {
      this.queued[index] = 1;
      this.queue[this.pending++] = index;
    }
  }
  private propagate(): boolean {
    const [width, height, depth] = this.dimensions,
      cells = this.cells,
      queue = this.queue,
      queued = this.queued,
      table = this.allowed,
      union = this.union;
    while (this.pending) {
      const index = queue[--this.pending];
      queued[index] = 0;
      const x = index % width,
        y = Math.floor(index / width) % height,
        z = Math.floor(index / (width * height)),
        mask = cells[index];
      // One pass over the set tiles gathers the allowed neighbors for all six directions.
      union.fill(0);
      for (let rest = mask; rest; rest &= rest - 1) {
        const row = (31 - Math.clz32(rest & -rest)) * 6;
        for (let direction = 0; direction < 6; direction++) union[direction] |= table[row + direction];
      }
      for (let direction = 0; direction < 6; direction++) {
        const d = directions[direction],
          nx = x + d[0],
          ny = y + d[1],
          nz = z + d[2];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) continue;
        const neighbor = nx + width * (ny + height * nz),
          next = (cells[neighbor] & union[direction]) >>> 0; // unsigned, or tile 31 never compares equal and propagation never settles
        if (!next) return false;
        if (next !== cells[neighbor]) {
          cells[neighbor] = next;
          if (!queued[neighbor]) {
            queued[neighbor] = 1;
            queue[this.pending++] = neighbor;
          }
        }
      }
    }
    return true;
  }
  solve(seed = 1, pins: readonly Pin[] = [], attempts = 16): Uint8Array {
    if (!Number.isInteger(seed) || !Number.isInteger(attempts) || attempts < 1 || attempts > 1024)
      throw new RangeError('Invalid WFC seed or retry budget');
    const [w, h, d] = this.dimensions,
      cells = this.cells,
      weights = this.weights,
      weightedLogs = this.weightedLogs,
      entropyMasks = this.entropyMasks,
      entropies = this.entropies,
      undecided = this.undecided;
    for (const pin of pins)
      if (
        pin.position.length !== 3 ||
        pin.position.some((v, axis) => !Number.isInteger(v) || v < 0 || v >= this.dimensions[axis]) ||
        !Number.isInteger(pin.tile) ||
        pin.tile < 0 ||
        pin.tile >= this.tiles.length
      )
        throw new RangeError('Invalid WFC pin');
    this.randomState = seed >>> 0 || 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.cells.fill(this.full);
      this.queued.fill(0);
      this.pending = 0;
      let contradiction = false;
      for (const pin of pins) {
        const [x, y, z] = pin.position,
          index = x + w * (y + h * z),
          mask = 1 << pin.tile;
        if (!(this.cells[index] & mask)) {
          contradiction = true;
          break;
        }
        this.cells[index] = mask;
        this.enqueue(index);
      }
      if (contradiction) continue;
      for (let i = 0; i < this.cells.length; i++) {
        this.enqueue(i);
        undecided[i] = i;
      }
      let undecidedCount = cells.length;
      while (this.propagate()) {
        let selected = -1,
          entropy = Infinity;
        // Cells never regain tiles within an attempt, so decided cells drop out of the ascending scan list for good.
        let kept = 0,
          state = this.randomState;
        for (let k = 0; k < undecidedCount; k++) {
          const i = undecided[k],
            mask = cells[i];
          if (!(mask & (mask - 1))) continue; // fewer than two tiles left
          undecided[kept++] = i;
          if (entropyMasks[i] !== mask) {
            let sum = 0,
              log = 0;
            for (let rest = mask; rest; rest &= rest - 1) {
              const tile = 31 - Math.clz32(rest & -rest);
              sum += weights[tile];
              log += weightedLogs[tile];
            }
            entropyMasks[i] = mask;
            entropies[i] = Math.log(sum) - log / sum;
          }
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          state >>>= 0; // same stream as random()
          const value = entropies[i] + (state / 4294967296) * 1e-8;
          if (value < entropy) {
            selected = i;
            entropy = value;
          }
        }
        undecidedCount = kept;
        this.randomState = state;
        if (selected < 0) {
          const result = new Uint8Array(this.cells.length);
          for (let i = 0; i < result.length; i++) result[i] = 31 - Math.clz32(this.cells[i]);
          return result;
        }
        const mask = this.cells[selected];
        let sum = 0;
        for (let tile = 0; tile < this.tiles.length; tile++) if (mask & (1 << tile)) sum += this.weights[tile];
        let choice = this.random() * sum;
        for (let tile = 0; tile < this.tiles.length; tile++)
          if (mask & (1 << tile)) {
            choice -= this.weights[tile];
            if (choice <= 0) {
              this.cells[selected] = (1 << tile) >>> 0;
              break;
            }
          }
        this.enqueue(selected);
      }
    }
    throw new Error('WFC constraints contradicted within the retry budget');
  }
}
