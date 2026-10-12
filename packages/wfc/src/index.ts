export interface Tile {weight?: number; neighbors: readonly (readonly number[])[]}
export interface Pin {position: readonly [number, number, number]; tile: number}
const directions = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
const bits = (value: number): number => {value -= (value >>> 1) & 0x55555555; value = (value & 0x33333333) + ((value >>> 2) & 0x33333333); return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;};

/** 3D adjacency WFC, using <=32 tile types and deterministic contradiction retries. */
export class WFC {
  readonly cells: Uint32Array;
  private readonly allowed: Uint32Array;
  private readonly weights: Float64Array;
  private readonly queue: Uint32Array;
  private readonly queued: Uint8Array;
  private randomState = 1;
  private pending = 0;
  private readonly full: number;
  readonly dimensions: readonly [number, number, number];
  constructor(dimensions: readonly [number, number, number], readonly tiles: readonly Tile[]) {
    if (dimensions.length !== 3 || dimensions.some(n => !Number.isInteger(n) || n < 1) || dimensions[0] * dimensions[1] * dimensions[2] > 1_000_000 || tiles.length < 1 || tiles.length > 32) throw new RangeError('Invalid WFC dimensions or tile count');
    this.dimensions = [...dimensions]; this.full = tiles.length === 32 ? 0xffffffff : (1 << tiles.length) - 1;
    this.cells = new Uint32Array(dimensions[0] * dimensions[1] * dimensions[2]); this.queue = new Uint32Array(this.cells.length); this.queued = new Uint8Array(this.cells.length);
    this.weights = new Float64Array(tiles.length); this.allowed = new Uint32Array(tiles.length * 6);
    for (let tile = 0; tile < tiles.length; tile++) {
      const def = tiles[tile], weight = def.weight ?? 1;
      if (!Number.isFinite(weight) || weight <= 0 || def.neighbors.length !== 6) throw new TypeError('Tile needs positive weight and six neighbor lists');
      this.weights[tile] = weight;
      for (let direction = 0; direction < 6; direction++) for (const neighbor of def.neighbors[direction]) {
        if (!Number.isInteger(neighbor) || neighbor < 0 || neighbor >= tiles.length || !tiles[neighbor].neighbors[direction ^ 1]?.includes(tile)) throw new TypeError('WFC adjacency must be valid and reciprocal');
        this.allowed[tile * 6 + direction] |= 1 << neighbor;
      }
    }
  }
  private random(): number {let x = this.randomState; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; this.randomState = x >>> 0; return this.randomState / 4294967296;}
  private enqueue(index: number): void {if (!this.queued[index]) {this.queued[index] = 1; this.queue[this.pending++] = index;}}
  private propagate(): boolean {
    const [width, height, depth] = this.dimensions;
    while (this.pending) {
      const index = this.queue[--this.pending]; this.queued[index] = 0;
      const x = index % width, y = Math.floor(index / width) % height, z = Math.floor(index / (width * height)), mask = this.cells[index];
      for (let direction = 0; direction < 6; direction++) {
        const d = directions[direction], nx = x + d[0], ny = y + d[1], nz = z + d[2];
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) continue;
        let allowed = 0; for (let tile = 0; tile < this.tiles.length; tile++) if (mask & (1 << tile)) allowed |= this.allowed[tile * 6 + direction];
        const neighbor = nx + width * (ny + height * nz), next = this.cells[neighbor] & allowed;
        if (!next) return false;
        if (next !== this.cells[neighbor]) {this.cells[neighbor] = next; this.enqueue(neighbor);}
      }
    }
    return true;
  }
  solve(seed = 1, pins: readonly Pin[] = [], attempts = 16): Uint8Array {
    if (!Number.isInteger(seed) || !Number.isInteger(attempts) || attempts < 1 || attempts > 1024) throw new RangeError('Invalid WFC seed or retry budget');
    const [w, h, d] = this.dimensions;
    for (const pin of pins) if (pin.position.length !== 3 || pin.position.some((v, axis) => !Number.isInteger(v) || v < 0 || v >= this.dimensions[axis]) || !Number.isInteger(pin.tile) || pin.tile < 0 || pin.tile >= this.tiles.length) throw new RangeError('Invalid WFC pin');
    this.randomState = (seed >>> 0) || 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      this.cells.fill(this.full); this.queued.fill(0); this.pending = 0; let contradiction = false;
      for (const pin of pins) {
        const [x, y, z] = pin.position, index = x + w * (y + h * z), mask = 1 << pin.tile;
        if (!(this.cells[index] & mask)) {contradiction = true; break;} this.cells[index] = mask; this.enqueue(index);
      }
      if (contradiction) continue;
      for (let i = 0; i < this.cells.length; i++) this.enqueue(i);
      while (this.propagate()) {
        let selected = -1, entropy = Infinity;
        for (let i = 0; i < this.cells.length; i++) {
          const mask = this.cells[i]; if (bits(mask) < 2) continue;
          let sum = 0, log = 0;
          for (let tile = 0; tile < this.tiles.length; tile++) if (mask & (1 << tile)) {const weight = this.weights[tile]; sum += weight; log += weight * Math.log(weight);}
          const value = Math.log(sum) - log / sum + this.random() * 1e-8; if (value < entropy) {selected = i; entropy = value;}
        }
        if (selected < 0) {const result = new Uint8Array(this.cells.length); for (let i = 0; i < result.length; i++) result[i] = 31 - Math.clz32(this.cells[i]); return result;}
        const mask = this.cells[selected]; let sum = 0;
        for (let tile = 0; tile < this.tiles.length; tile++) if (mask & (1 << tile)) sum += this.weights[tile];
        let choice = this.random() * sum;
        for (let tile = 0; tile < this.tiles.length; tile++) if (mask & (1 << tile)) {choice -= this.weights[tile]; if (choice <= 0) {this.cells[selected] = (1 << tile) >>> 0; break;}}
        this.enqueue(selected);
      }
    }
    throw new Error('WFC constraints contradicted within the retry budget');
  }
}
