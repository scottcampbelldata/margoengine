// 3D navigation for flying agents. The volume is the sparse voxel octree of D. Brewer, "3D Flight Navigation Using Sparse
// Voxel Octrees" (Game AI Pro 3, chapter 21, 2017): a leaf holds 4 x 4 x 4 voxels in 64 bits, kept here as a pair of u32
// so no BigInt is needed; nodes are built bottom up, siblings stay together in Morton order, and a node with no children
// is free space, however big. Routes come from Lazy Theta* (A. Nash, S. Koenig, C. Tovey, AAAI 2010, Algorithm 3): one
// sight check per expanded cell, so paths are not bound to the cells. They are short, not provably shortest: shortest
// paths among 3D obstacles are NP-hard.
import type { Vec3 } from '@margoengine/math';
import { validate } from './pipeline.js';
import { point } from './search.js';

/** Options of {@link NavVolume}, world units. */
export interface NavVolumeOptions {
  /** Side of the smallest cell. Smaller finds tighter gaps and costs more. Default 0.5. */
  voxelSize?: number;
  /** The flyer's radius: solids are grown by it. Default 0.5. */
  radius?: number;
  /** Lowest corner of the volume. Default the level's, less `padding`. */
  min?: readonly [number, number, number];
  /** Highest corner of the volume. Default the level's, plus `padding`. */
  max?: readonly [number, number, number];
  /** Open air around the level when `min` or `max` is left out. Default 8 voxels. */
  padding?: number;
}

/** Cells of a leaf along one side. */
const LEAF = 4;
/** Most leaves that hold something. */
const MAX_LEAVES = 4_000_000;
/** Most voxels along a side: leaf coordinates must fit a whole number key. */
const MAX_SIDE = 1 << 16;

interface Layer {
  /** First of a node's eight children in the layer below, or -1: free space, or on layer 0 a leaf. */
  first: Int32Array;
  /** Node coordinates, in nodes of this layer. */
  x: Int32Array;
  y: Int32Array;
  z: Int32Array;
}
interface Item {
  x: number;
  y: number;
  z: number;
  first: number;
  low: number;
  high: number;
}

/** Bits 0 and 1 of `v` at bits 0 and 3, and back: a leaf's voxels are in Morton order too. */
const spread = (v: number) => (v & 1) | ((v & 2) << 2);
const gather = (v: number) => (v & 1) | ((v >> 2) & 2);
const voxelBit = (x: number, y: number, z: number) => spread(x) | (spread(y) << 1) | (spread(z) << 2);

/** Morton order of two nodes, without building the code: the axis with the highest differing bit decides. */
function morton(a: Item, b: Item): number {
  let axis = a.z - b.z,
    most = a.z ^ b.z;
  const y = a.y ^ b.y,
    x = a.x ^ b.x;
  if (most < y && most < (most ^ y)) {
    most = y;
    axis = a.y - b.y;
  }
  if (most < x && most < (most ^ x)) axis = a.x - b.x;
  return axis;
}

/** Squared distance from a point to a triangle. */
function distanceToTriangle(
  px: number,
  py: number,
  pz: number,
  points: Float32Array,
  a: number,
  b: number,
  c: number,
): number {
  const ax = points[a],
    ay = points[a + 1],
    az = points[a + 2],
    ux = points[b] - ax,
    uy = points[b + 1] - ay,
    uz = points[b + 2] - az,
    vx = points[c] - ax,
    vy = points[c + 1] - ay,
    vz = points[c + 2] - az,
    wx = px - ax,
    wy = py - ay,
    wz = pz - az,
    uu = ux * ux + uy * uy + uz * uz,
    uv = ux * vx + uy * vy + uz * vz,
    vv = vx * vx + vy * vy + vz * vz,
    wu = wx * ux + wy * uy + wz * uz,
    wv = wx * vx + wy * vy + wz * vz,
    area = uu * vv - uv * uv;
  if (area > 0) {
    const s = (wu * vv - wv * uv) / area,
      t = (wv * uu - wu * uv) / area;
    if (s >= 0 && t >= 0 && s + t <= 1) {
      const dx = wx - s * ux - t * vx,
        dy = wy - s * uy - t * vy,
        dz = wz - s * uz - t * vz;
      return dx * dx + dy * dy + dz * dz;
    }
  }
  // Outside: the nearest point is on an edge.
  const edge = (ox: number, oy: number, oz: number, ex: number, ey: number, ez: number) => {
    const length = ex * ex + ey * ey + ez * ez,
      f = length > 0 ? Math.min(1, Math.max(0, ((px - ox) * ex + (py - oy) * ey + (pz - oz) * ez) / length)) : 0;
    return (ox + ex * f - px) ** 2 + (oy + ey * f - py) ** 2 + (oz + ez * f - pz) ** 2;
  };
  return Math.min(
    edge(ax, ay, az, ux, uy, uz),
    edge(ax, ay, az, vx, vy, vz),
    edge(ax + ux, ay + uy, az + uz, vx - ux, vy - uy, vz - uz),
  );
}

/** Open cells by estimated route length; an entry left behind by a better route is skipped on the way out. */
class Heap {
  private readonly keys: number[] = [];
  private readonly cells: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, cell: number): void {
    const { keys, cells } = this;
    let i = keys.length;
    keys.push(key);
    cells.push(cell);
    for (let up = (i - 1) >> 1; i > 0 && key < keys[up]; i = up, up = (i - 1) >> 1) {
      keys[i] = keys[up];
      cells[i] = cells[up];
    }
    keys[i] = key;
    cells[i] = cell;
  }
  /** Takes the lowest; `key` then holds what it was filed under. */
  key = 0;
  pop(): number {
    const { keys, cells } = this,
      top = cells[0];
    this.key = keys[0];
    const lastKey = keys.pop() as number,
      lastCell = cells.pop() as number,
      size = keys.length;
    if (size) {
      let i = 0;
      for (let child = 1; child < size; child = i * 2 + 1) {
        if (child + 1 < size && keys[child + 1] < keys[child]) child++;
        if (lastKey <= keys[child]) break;
        keys[i] = keys[child];
        cells[i] = cells[child];
        i = child;
      }
      keys[i] = lastKey;
      cells[i] = lastCell;
    }
    return top;
  }
}

/**
 * A sparse voxel volume of a level, for agents that fly. `path` gives corner points clear of every triangle by the
 * radius. Space inside a closed solid is not marked: it is a sealed pocket, so a route from outside never enters it.
 * Build it offline or at load; it does not change after that.
 */
export class NavVolume {
  /** Side of the smallest cell, world units. */
  readonly voxelSize: number;
  /** The radius solids were grown by. */
  readonly radius: number;
  private readonly origin: readonly [number, number, number];
  private readonly top: number;
  private readonly side: number;
  private readonly layers: Layer[] = [];
  /** Solid voxels of each layer 0 node, 64 bits as a low and a high half. */
  private readonly low: Uint32Array;
  private readonly high: Uint32Array;
  /** Cell numbers: the voxels of layer 0 come first, then every node by layer. */
  private readonly starts: number[] = [];
  // The box of the last cell asked of `box`, in voxels.
  private bx = 0;
  private by = 0;
  private bz = 0;
  private bs = 0;

  /**
   * Voxelises a level and builds the octree.
   * @param positions Flat xyz positions.
   * @param indices Flat triangle indices into `positions`.
   * @throws RangeError for invalid geometry or options, or a volume over 65,536 voxels a side or 4,000,000 leaves.
   */
  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>, options: NavVolumeOptions = {}) {
    const { voxelSize = 0.5, radius = 0.5, min, max, padding = 8 * voxelSize } = options ?? {};
    if (!(voxelSize > 0 && voxelSize < Infinity))
      throw new RangeError('Voxel size must be finite and above 0; pass a length.');
    if (!(radius >= 0 && radius < Infinity))
      throw new RangeError('Radius must be finite and 0 or more; pass a length.');
    if (!(padding >= 0 && padding < Infinity))
      throw new RangeError('Padding must be finite and 0 or more; pass a length.');
    const input = validate(positions, indices, {}, false),
      low = min ?? [input.min[0] - padding, input.min[1] - padding, input.min[2] - padding],
      high = max ?? [input.max[0] + padding, input.max[1] + padding, input.max[2] + padding];
    for (let i = 0; i < 3; i++)
      if (!(Number.isFinite(low[i]) && Number.isFinite(high[i]) && low[i] < high[i]))
        throw new RangeError('Volume corners must be finite with min below max; pass [x, y, z] for each.');
    this.voxelSize = voxelSize;
    this.radius = radius;
    this.origin = [low[0], low[1], low[2]];
    const longest = Math.max(high[0] - low[0], high[1] - low[1], high[2] - low[2]) / voxelSize;
    if (longest > MAX_SIDE) throw new RangeError('Volume is over 65,536 voxels a side; raise voxelSize.');
    let top = 1;
    while (LEAF << top < longest) top++;
    this.top = top;
    this.side = LEAF << top;
    const items = this.rasterise(input.points, input.triangles),
      [lows, highs] = this.link(items);
    this.low = lows;
    this.high = highs;
    let start = this.layers[0].first.length * 64;
    for (const layer of this.layers) {
      this.starts.push(start);
      start += layer.first.length;
    }
  }

  /** The leaves any triangle reaches. A voxel is solid when a point in it could be nearer than `radius` to a triangle. */
  private rasterise(points: Float32Array, triangles: Uint32Array): Item[] {
    const size = this.voxelSize,
      [ox, oy, oz] = this.origin,
      reach = this.radius + (size * Math.sqrt(3)) / 2,
      limit = reach * reach,
      last = this.side - 1,
      across = this.side / LEAF,
      leaves = new Map<number, Item>(),
      first = (v: number, o: number) => Math.max(0, Math.floor((v - reach - o) / size)),
      final = (v: number, o: number) => Math.min(last, Math.floor((v + reach - o) / size));
    for (let t = 0; t < triangles.length; t += 3) {
      const a = triangles[t] * 3,
        b = triangles[t + 1] * 3,
        c = triangles[t + 2] * 3,
        x0 = first(Math.min(points[a], points[b], points[c]), ox),
        x1 = final(Math.max(points[a], points[b], points[c]), ox),
        y0 = first(Math.min(points[a + 1], points[b + 1], points[c + 1]), oy),
        y1 = final(Math.max(points[a + 1], points[b + 1], points[c + 1]), oy),
        z0 = first(Math.min(points[a + 2], points[b + 2], points[c + 2]), oz),
        z1 = final(Math.max(points[a + 2], points[b + 2], points[c + 2]), oz);
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const px = ox + (x + 0.5) * size,
              py = oy + (y + 0.5) * size,
              pz = oz + (z + 0.5) * size;
            if (distanceToTriangle(px, py, pz, points, a, b, c) > limit) continue;
            const lx = x >> 2,
              ly = y >> 2,
              lz = z >> 2,
              name = (lz * across + ly) * across + lx;
            let leaf = leaves.get(name);
            if (!leaf) {
              if (leaves.size === MAX_LEAVES)
                throw new RangeError('Volume is over 4,000,000 leaves; raise voxelSize or set a smaller min and max.');
              leaves.set(name, (leaf = { x: lx, y: ly, z: lz, first: -1, low: 0, high: 0 }));
            }
            const bit = voxelBit(x & 3, y & 3, z & 3);
            if (bit < 32) leaf.low = (leaf.low | (1 << bit)) >>> 0;
            else leaf.high = (leaf.high | (1 << (bit - 32))) >>> 0;
          }
    }
    return [...leaves.values()];
  }

  /** Builds the layers bottom up: each holds the occupied nodes and their siblings, eight at a time. */
  private link(leaves: Item[]): [Uint32Array, Uint32Array] {
    let items = leaves,
      lows = new Uint32Array(0),
      highs = new Uint32Array(0);
    for (let layer = 0; layer < this.top; layer++) {
      const parents: Item[] = [],
        order = items
          .map((item) => ({ item, parent: { ...item, x: item.x >> 1, y: item.y >> 1, z: item.z >> 1 } }))
          .sort((a, b) => morton(a.parent, b.parent));
      let last: Item | null = null;
      for (const { parent } of order)
        if (!last || last.x !== parent.x || last.y !== parent.y || last.z !== parent.z) {
          last = { ...parent, first: parents.length * 8, low: 0, high: 0 };
          parents.push(last);
        }
      const count = parents.length * 8,
        nodes: Layer = {
          first: new Int32Array(count).fill(-1),
          x: new Int32Array(count),
          y: new Int32Array(count),
          z: new Int32Array(count),
        };
      if (layer === 0) {
        lows = new Uint32Array(count);
        highs = new Uint32Array(count);
      }
      parents.forEach(({ x, y, z, first }) => {
        for (let c = 0; c < 8; c++) {
          nodes.x[first + c] = x * 2 + (c & 1);
          nodes.y[first + c] = y * 2 + ((c >> 1) & 1);
          nodes.z[first + c] = z * 2 + (c >> 2);
        }
      });
      let at = 0;
      for (const { item, parent } of order) {
        while (parents[at].x !== parent.x || parents[at].y !== parent.y || parents[at].z !== parent.z) at++;
        const node = parents[at].first + (item.x & 1) + ((item.y & 1) << 1) + ((item.z & 1) << 2);
        nodes.first[node] = item.first;
        if (layer === 0) {
          lows[node] = item.low;
          highs[node] = item.high;
        }
      }
      this.layers.push(nodes);
      items = parents;
    }
    // The root stands alone; its children, if any, are the one group of the layer below.
    this.layers.push({
      first: Int32Array.of(items.length ? items[0].first : -1),
      x: new Int32Array(1),
      y: new Int32Array(1),
      z: new Int32Array(1),
    });
    return [lows, highs];
  }

  /** Nodes in the tree, leaves included. */
  get nodeCount(): number {
    return this.layers.reduce((sum, layer) => sum + layer.first.length, 0);
  }
  /** Memory the tree holds, in bytes. */
  get byteLength(): number {
    return this.nodeCount * 16 + this.low.byteLength + this.high.byteLength;
  }

  private solid(node: number, bit: number): boolean {
    return (bit < 32 ? (this.low[node] >>> bit) & 1 : (this.high[node] >>> (bit - 32)) & 1) === 1;
  }

  /** The free cell holding voxel (x, y, z), or -1 when it is solid or outside. */
  private cellAt(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.side || y >= this.side || z >= this.side) return -1;
    let node = 0;
    for (let layer = this.top; ; layer--) {
      if (layer === 0) {
        if (!this.low[node] && !this.high[node]) return this.starts[0] + node;
        const bit = voxelBit(x & 3, y & 3, z & 3);
        return this.solid(node, bit) ? -1 : node * 64 + bit;
      }
      const first = this.layers[layer].first[node];
      if (first < 0) return this.starts[layer] + node;
      const shift = layer + 1;
      node = first + ((x >> shift) & 1) + (((y >> shift) & 1) << 1) + (((z >> shift) & 1) << 2);
    }
  }

  /** Puts the box of a cell in `bx`, `by`, `bz` and `bs`, in voxels. */
  private box(cell: number): void {
    if (cell < this.starts[0]) {
      const node = Math.floor(cell / 64),
        bit = cell % 64,
        leaf = this.layers[0];
      this.bx = leaf.x[node] * LEAF + gather(bit);
      this.by = leaf.y[node] * LEAF + gather(bit >> 1);
      this.bz = leaf.z[node] * LEAF + gather(bit >> 2);
      this.bs = 1;
      return;
    }
    let layer = this.top;
    while (this.starts[layer] > cell) layer--;
    const node = cell - this.starts[layer],
      nodes = this.layers[layer],
      size = LEAF << layer;
    this.bx = nodes.x[node] * size;
    this.by = nodes.y[node] * size;
    this.bz = nodes.z[node] * size;
    this.bs = size;
  }

  /** Calls `visit` for every free cell that meets the voxel box from (x0, y0, z0) up to, not including, (x1, y1, z1). */
  private walk(
    layer: number,
    node: number,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    visit: (cell: number) => void,
  ): void {
    const nodes = this.layers[layer],
      size = LEAF << layer,
      nx = nodes.x[node] * size,
      ny = nodes.y[node] * size,
      nz = nodes.z[node] * size;
    if (nx >= x1 || ny >= y1 || nz >= z1 || nx + size <= x0 || ny + size <= y0 || nz + size <= z0) return;
    if (layer === 0) {
      if (!this.low[node] && !this.high[node]) {
        visit(this.starts[0] + node);
        return;
      }
      for (let z = Math.max(z0, nz), zEnd = Math.min(z1, nz + LEAF); z < zEnd; z++)
        for (let y = Math.max(y0, ny), yEnd = Math.min(y1, ny + LEAF); y < yEnd; y++)
          for (let x = Math.max(x0, nx), xEnd = Math.min(x1, nx + LEAF); x < xEnd; x++) {
            const bit = voxelBit(x & 3, y & 3, z & 3);
            if (!this.solid(node, bit)) visit(node * 64 + bit);
          }
      return;
    }
    const first = nodes.first[node];
    if (first < 0) visit(this.starts[layer] + node);
    else for (let c = 0; c < 8; c++) this.walk(layer - 1, first + c, x0, y0, z0, x1, y1, z1, visit);
  }

  /** The free cells across the six faces of a cell. */
  private neighbours(cell: number): number[] {
    this.box(cell);
    const { bx: x, by: y, bz: z, bs: s } = this,
      out: number[] = [],
      visit = (other: number) => {
        out.push(other);
      },
      around = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
        this.walk(this.top, 0, x0, y0, z0, x1, y1, z1, visit);
    around(x - 1, y, z, x, y + s, z + s);
    around(x + s, y, z, x + s + 1, y + s, z + s);
    around(x, y - 1, z, x + s, y, z + s);
    around(x, y + s, z, x + s, y + s + 1, z + s);
    around(x, y, z - 1, x + s, y + s, z);
    around(x, y, z + s, x + s, y + s, z + s + 1);
    return out;
  }

  private cellOf(position: Vec3): number {
    const size = this.voxelSize,
      [ox, oy, oz] = this.origin;
    return this.cellAt(
      Math.floor((position[0] - ox) / size),
      Math.floor((position[1] - oy) / size),
      Math.floor((position[2] - oz) / size),
    );
  }

  /**
   * Is the point in open air here?
   * @throws RangeError when `position` is not a finite 3D point.
   */
  isFree(position: Vec3): boolean {
    point(position);
    return this.cellOf(position) >= 0;
  }

  /**
   * Can a flyer go straight from `a` to `b`? Walks the cells the segment passes through.
   * @throws RangeError when a point is not a finite 3D point.
   */
  lineOfSight(a: Vec3, b: Vec3): boolean {
    point(a);
    point(b);
    const size = this.voxelSize,
      o = this.origin,
      ax = (a[0] - o[0]) / size,
      ay = (a[1] - o[1]) / size,
      az = (a[2] - o[2]) / size,
      dx = (b[0] - o[0]) / size - ax,
      dy = (b[1] - o[1]) / size - ay,
      dz = (b[2] - o[2]) / size - az,
      // Steps over a cell's face by a sliver: far under a voxel, so no cell can hide in it.
      nudge = 1e-6 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
    for (let t = 0; ; ) {
      const x = ax + dx * t,
        y = ay + dy * t,
        z = az + dz * t,
        cell = this.cellAt(Math.floor(x), Math.floor(y), Math.floor(z));
      if (cell < 0) return false;
      this.box(cell);
      const { bx, by, bz, bs } = this,
        exit = (at: number, d: number, low: number) =>
          d > 0 ? (low + bs - at) / d : d < 0 ? (low - at) / d : Infinity,
        left = Math.min(exit(x, dx, bx), exit(y, dy, by), exit(z, dz, bz));
      t += left + nudge;
      if (t >= 1) return true;
    }
  }

  /**
   * The middle of the nearest free voxel to `position`, within `reach` voxels, or null: for a start or end that stands
   * too near a solid.
   * @throws RangeError when `position` is not a finite 3D point.
   */
  closestFree(position: Vec3, reach = 8): Vec3 | null {
    point(position);
    if (this.cellOf(position) >= 0) return [position[0], position[1], position[2]] as unknown as Vec3;
    const size = this.voxelSize,
      [ox, oy, oz] = this.origin,
      cx = Math.floor((position[0] - ox) / size),
      cy = Math.floor((position[1] - oy) / size),
      cz = Math.floor((position[2] - oz) / size);
    for (let ring = 1; ring <= reach; ring++) {
      let best: Vec3 | null = null,
        nearest = Infinity;
      for (let z = -ring; z <= ring; z++)
        for (let y = -ring; y <= ring; y++)
          for (let x = -ring; x <= ring; x++) {
            if (Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) !== ring) continue;
            if (this.cellAt(cx + x, cy + y, cz + z) < 0) continue;
            const spot = [ox + (cx + x + 0.5) * size, oy + (cy + y + 0.5) * size, oz + (cz + z + 0.5) * size],
              d = Math.hypot(spot[0] - position[0], spot[1] - position[1], spot[2] - position[2]);
            if (d < nearest) {
              nearest = d;
              best = spot as unknown as Vec3;
            }
          }
      if (best) return best;
    }
    return null;
  }

  /**
   * Corner points from `start` to `end`, both included, or null when an end is not free or no way joins them.
   * @throws RangeError when a point is not a finite 3D point.
   */
  path(start: Vec3, end: Vec3): Vec3[] | null {
    point(start);
    point(end);
    const from = this.cellOf(start),
      to = this.cellOf(end);
    if (from < 0 || to < 0) return null;
    if (from === to) return [[...start] as unknown as Vec3, [...end] as unknown as Vec3];
    const size = this.voxelSize,
      o = this.origin,
      where = new Map<number, Vec3>([
        [from, start],
        [to, end],
      ]),
      at = (cell: number): Vec3 => {
        let spot = where.get(cell);
        if (!spot) {
          this.box(cell);
          const half = this.bs / 2;
          spot = [
            o[0] + (this.bx + half) * size,
            o[1] + (this.by + half) * size,
            o[2] + (this.bz + half) * size,
          ] as unknown as Vec3;
          where.set(cell, spot);
        }
        return spot;
      },
      apart = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
      g = new Map<number, number>([[from, 0]]),
      parent = new Map<number, number>([[from, from]]),
      closed = new Set<number>(),
      open = new Heap();
    open.push(apart(start, end), from);
    while (open.size) {
      const cell = open.pop(),
        key = open.key;
      if (closed.has(cell)) continue;
      const here = at(cell);
      // An entry from before a better route: a newer one is in the heap.
      if ((g.get(cell) as number) + apart(here, end) < key - 1e-9) continue;
      // SetVertex: the line from the parent was assumed; check it now, and fall back on the best closed neighbour.
      const round = this.neighbours(cell);
      if (!this.lineOfSight(at(parent.get(cell) as number), here)) {
        let best = Infinity,
          pick = -1;
        for (const other of round)
          if (closed.has(other)) {
            const cost = (g.get(other) as number) + apart(at(other), here);
            if (cost < best) {
              best = cost;
              pick = other;
            }
          }
        parent.set(cell, pick);
        g.set(cell, best);
      }
      if (cell === to) {
        const points: Vec3[] = [];
        for (let step = to; ; step = parent.get(step) as number) {
          points.push([...at(step)] as unknown as Vec3);
          if (step === from) return points.reverse();
        }
      }
      closed.add(cell);
      const root = parent.get(cell) as number,
        rootAt = at(root),
        base = g.get(root) as number;
      for (const other of round) {
        if (closed.has(other)) continue;
        const spot = at(other),
          cost = base + apart(rootAt, spot);
        if (cost < (g.get(other) ?? Infinity)) {
          g.set(other, cost);
          parent.set(other, root);
          open.push(cost + apart(spot, end), other);
        }
      }
    }
    return null;
  }
}
