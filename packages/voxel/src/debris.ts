/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/debris: voxel destruction. After edits, groups of solid blocks no longer joined to anything that
// holds them (the ground, an anchor block, an unloaded chunk) are taken out of the world and become dynamic physics
// bodies: a compound of merged boxes for the solver and core meshes of the group's open faces for the picture.
// Only types come from @margoengine/physics: the caller's Physics makes the bodies, so this entry pulls no solver.
import type { Engine, Mesh, PbrMaterial } from '@margoengine/core';
import { Geometry, PbrMaterial as Material } from '@margoengine/core';
import type { Vec3 } from '@margoengine/math';
import { MargoError } from '@margoengine/math/errors';
import type { CompoundPart, Physics, PhysicsBody } from '@margoengine/physics';
import type { BlockType } from './blocks.js';
import { chunkKey, VoxelWorld } from './world.js';

/** Options of {@link VoxelDebris}. */
export interface VoxelDebrisOptions {
  /**
   * The physics world for the pieces: each becomes a dynamic body there (with `@margoengine/voxel/physics` on the same
   * world, it lands on the blocks). Default none: pieces are only taken out of the world and reported.
   */
  physics?: Physics;
  /** Draws each piece as core meshes (one per block type) that follow its body. Default none: nothing is drawn. */
  engine?: Engine;
  /** Cells at this y or lower hold everything joined to them. Default `-Infinity`: only anchors and unloaded chunks. */
  floor?: number;
  /** Block types (ids or names) that never fall and hold everything joined to them, such as bedrock. Default none. */
  anchors?: readonly (number | string)[];
  /**
   * A joined group of this many cells or more stays in the world as if held, which bounds the search after an edit.
   * Integer 1 to 65,536, default 4,096.
   */
  maxCells?: number;
  /** Most pieces alive at once; breaking one more removes the oldest. Integer 1 or more, default 64. */
  maxPieces?: number;
  /** Seconds a piece lives (counted by {@link VoxelDebris.update}'s `delta`) before it is removed. Default `Infinity`. */
  lifetime?: number;
  /** Mass per cell in kg (density of a 1 x 1 x 1 block). Default 1. A number > 0. */
  density?: number;
  /** Friction of the pieces' colliders, default 0.6. A number >= 0. */
  friction?: number;
  /** Core material per block type; default a `PbrMaterial` of the type's colour and roughness, one per type. */
  material?: (type: BlockType) => PbrMaterial;
}

/** One broken-off group of blocks. */
export interface DebrisPiece {
  /** Increasing id, from 1. */
  readonly id: number;
  /** The world cells the piece held when it broke off: x, y, z per cell. */
  readonly cells: Int32Array;
  /** The block state of each cell, in the order of `cells`. */
  readonly states: Uint32Array;
  /** Where the body started: the mean of the cell centres, in world units. Mesh vertices are relative to it. */
  readonly center: Vec3;
  /** Boxes of merged cells, as `[x0, y0, z0, x1, y1, z1)` world cells, six numbers per box: the collider's parts. */
  readonly boxes: Int32Array;
  /** Its dynamic body, or null without `physics`. Its `userData` is this piece. */
  readonly body: PhysicsBody | null;
  /** Its core meshes, one per block type; the first is the body's mesh and the others are its children. */
  readonly meshes: readonly Mesh[];
  /** Seconds since it broke off. */
  readonly age: number;
}

interface Piece {
  id: number;
  cells: Int32Array;
  states: Uint32Array;
  center: Vec3;
  boxes: Int32Array;
  body: PhysicsBody | null;
  meshes: Mesh[];
  age: number;
}

const DX = [1, -1, 0, 0, 0, 0],
  DY = [0, 0, 1, -1, 0, 0],
  DZ = [0, 0, 0, 0, 1, -1];
// Face corners per direction (+x, -x, +y, -y, +z, -z), counter-clockwise seen from outside, as unit-cube offsets.
const FACES = [
  [1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1],
  [0, 0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0],
  [0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1],
  [0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1],
  [0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0],
];

const positive = (name: string, value: number, fix: string): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelDebris ${name} must be a number; ${fix}`);
  if (!(value > 0)) throw new RangeError(`VoxelDebris ${name} is ${value}; ${fix}`);
  return value;
};
const whole = (name: string, value: number, max: number): number => {
  if (typeof value !== 'number') throw new TypeError(`VoxelDebris ${name} must be a number; pass a whole number`);
  if (!Number.isInteger(value) || value < 1 || value > max)
    throw new RangeError(`VoxelDebris ${name} is ${value}; pass a whole number from 1 to ${max}`);
  return value;
};

/**
 * Voxel destruction: watches a {@link VoxelWorld}'s edits and, on {@link VoxelDebris.update}, breaks off every group of
 * solid blocks (face-joined, `solid` block types) that an edit cut loose. A group is held when it reaches a cell at
 * `floor` or below, an `anchors` block, an unloaded chunk or `maxCells` cells; any other group is cleared from the world
 * in one `setBlocks` and becomes a {@link DebrisPiece}: a dynamic body in `physics` and core meshes in `engine`.
 *
 * Call `update(delta)` after edits and before `physics.step()`, so the voxel colliders lose the cells before the piece
 * moves. Only removals start a search, from the six cells beside each removed solid block.
 */
export class VoxelDebris {
  readonly world: VoxelWorld;
  readonly physics: Physics | null;
  readonly maxCells: number;
  readonly maxPieces: number;
  readonly lifetime: number;
  readonly floor: number;
  #engine: Engine | null;
  #density: number;
  #friction: number;
  #material: (type: BlockType) => PbrMaterial;
  #materials = new Map<number, PbrMaterial>();
  #anchors: readonly (number | string)[];
  #solid = new Uint8Array(0);
  #anchor = new Uint8Array(0);
  #seeds: number[] = [];
  #marks = new Map<string, Int32Array>();
  #group = 0;
  #pieces: Piece[] = [];
  #next = 1;
  #clearing = false;
  #listeners = new Set<(piece: DebrisPiece) => void>();
  #off: () => void;
  #disposed = false;

  /**
   * @throws TypeError when `world` is not a VoxelWorld, `physics` not a Physics, `engine` not an Engine or an option
   * of the wrong type.
   * @throws RangeError for an option out of range or an anchor that is not a defined block type.
   */
  constructor(world: VoxelWorld, options: VoxelDebrisOptions = {}) {
    if (!(world instanceof VoxelWorld))
      throw new TypeError('VoxelDebris needs a VoxelWorld; pass new VoxelWorld({blocks})');
    if (!options || typeof options !== 'object') throw new TypeError('VoxelDebris options must be an object; pass {}');
    const {
      physics,
      engine,
      floor = -Infinity,
      anchors = [],
      maxCells = 4096,
      maxPieces = 64,
      lifetime = Infinity,
      density = 1,
      friction = 0.6,
      material,
    } = options;
    if (physics !== undefined && (typeof physics?.addBody !== 'function' || typeof physics.removeBody !== 'function'))
      throw new TypeError(
        'VoxelDebris physics must be a Physics; pass Physics.attach(engine) from @margoengine/physics',
      );
    if (engine !== undefined && typeof engine?.createMesh !== 'function')
      throw new TypeError('VoxelDebris engine must be an Engine; pass the engine that draws the world');
    if (typeof floor !== 'number' || Number.isNaN(floor))
      throw new TypeError('VoxelDebris floor must be a number; pass a block y such as 0, or -Infinity');
    if (!Array.isArray(anchors))
      throw new TypeError("VoxelDebris anchors must be an array; pass block ids or names such as ['bedrock']");
    for (const a of anchors) world.blocks.get(typeof a === 'string' ? world.blocks.id(a) : a);
    if (typeof lifetime !== 'number' || !(lifetime > 0))
      throw new RangeError(`VoxelDebris lifetime is ${lifetime}; pass seconds > 0, or Infinity`);
    if (typeof friction !== 'number' || !(friction >= 0) || friction === Infinity)
      throw new RangeError(`VoxelDebris friction is ${friction}; pass a number >= 0 such as 0.6`);
    if (material !== undefined && typeof material !== 'function')
      throw new TypeError(
        'VoxelDebris material must be a function; pass (type) => new PbrMaterial({ color: type.color })',
      );
    this.world = world;
    this.physics = physics ?? null;
    this.#engine = engine ?? null;
    this.floor = floor;
    this.#anchors = anchors;
    this.maxCells = whole('maxCells', maxCells, 65536);
    this.maxPieces = whole('maxPieces', maxPieces, 2 ** 31 - 1);
    this.lifetime = lifetime;
    this.#density = positive('density', density, 'pass kg per cell > 0 such as 1');
    this.#friction = friction;
    this.#material =
      material ?? ((t) => new Material({ color: [...t.color], roughness: t.roughness, metalness: t.metalness }));
    this.#off = world.onChange(this.#edit);
  }

  /** The pieces alive, oldest first. */
  get pieces(): readonly DebrisPiece[] {
    return this.#pieces;
  }

  /** Cells waiting to be searched from at the next {@link VoxelDebris.update}. */
  get pending(): number {
    return this.#seeds.length / 3;
  }

  /** Calls `listener` with each piece as it breaks off, before `update` returns. Returns a function that unsubscribes. */
  onBreak(listener: (piece: DebrisPiece) => void): () => void {
    if (typeof listener !== 'function') throw new TypeError('VoxelDebris.onBreak needs a function; pass (piece) => {}');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Breaks off the groups cut loose since the last call, ages every piece by `delta` seconds and removes those past
   * `lifetime`. Returns the pieces broken off by this call.
   * @throws RangeError when `delta` is not a number >= 0. @throws MargoError `disposed` after dispose().
   */
  update(delta = 0): DebrisPiece[] {
    if (this.#disposed) throw new MargoError('disposed', 'VoxelDebris is disposed; create a new one');
    if (typeof delta !== 'number' || !(delta >= 0) || delta === Infinity)
      throw new RangeError(`VoxelDebris.update delta is ${delta}; pass seconds >= 0 such as 1 / 60`);
    const broken: DebrisPiece[] = [];
    if (this.#seeds.length) {
      this.#tables();
      const seeds = this.#seeds;
      this.#seeds = [];
      for (let i = 0; i < seeds.length; i += 3) {
        const group = this.#search(seeds[i], seeds[i + 1], seeds[i + 2]);
        if (group) broken.push(this.#break(group.cells, group.states));
      }
      this.#marks.clear();
      this.#group = 0;
    }
    for (const piece of this.#pieces) piece.age += delta;
    while (this.#pieces.length && this.#pieces[0].age >= this.lifetime) this.#remove(this.#pieces[0]);
    for (const piece of broken) for (const listener of [...this.#listeners]) listener(piece);
    return broken;
  }

  /** Removes `piece`'s body and meshes now (it does not go back into the world). Unknown pieces are ignored. */
  remove(piece: DebrisPiece): void {
    const own = this.#pieces.find((p) => p === piece);
    if (own) this.#remove(own);
  }

  /** Removes every piece and stops watching the world. Calling it again does nothing. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#off();
    for (const piece of [...this.#pieces]) this.#remove(piece);
    this.#seeds = [];
    this.#listeners.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }

  readonly #edit = (x: number, y: number, z: number, state: number, previous: number): void => {
    if (this.#clearing) return;
    this.#tables();
    if (!this.#solid[previous & 0xffff] || this.#solid[state & 0xffff]) return;
    for (let d = 0; d < 6; d++) this.#seeds.push(x + DX[d], y + DY[d], z + DZ[d]);
  };

  #tables(): void {
    const table = this.world.blocks.table;
    if (this.#solid.length === table.length) return;
    this.#solid = Uint8Array.from(table, (t) => +(t.solid && !t.liquid));
    this.#anchor = new Uint8Array(table.length);
    for (const a of this.#anchors) this.#anchor[typeof a === 'string' ? this.world.blocks.id(a) : a] = 1;
  }

  // The loose group holding solid cell (x, y, z), or null when it is held (or the cell is not solid). Depth first with
  // downward steps taken first, since what holds a group is usually below it; stops at the first holding cell.
  #search(x0: number, y0: number, z0: number): { cells: number[]; states: number[] } | null {
    const world = this.world,
      solid = this.#solid,
      anchor = this.#anchor,
      group = ++this.#group,
      stack = [x0, y0, z0],
      cells: number[] = [],
      states: number[] = [];
    while (stack.length) {
      const z = stack.pop() as number,
        y = stack.pop() as number,
        x = stack.pop() as number,
        chunk = world.getChunk(x >> 5, y >> 5, z >> 5);
      if (!chunk) return null; // joined to an unloaded chunk: it may hold the group
      const state = chunk.get(x & 31, y & 31, z & 31);
      if (!solid[state & 0xffff]) continue;
      const key = chunkKey(x >> 5, y >> 5, z >> 5);
      let marks = this.#marks.get(key);
      if (!marks) this.#marks.set(key, (marks = new Int32Array(32768)));
      const i = (x & 31) | ((z & 31) << 5) | ((y & 31) << 10),
        mark = marks[i];
      if (mark === group) continue;
      // A cell of an earlier search in this update that is still solid belongs to a held group.
      if (mark) return null;
      marks[i] = group;
      if (y <= this.floor || anchor[state & 0xffff] || cells.length / 3 + 1 >= this.maxCells) return null;
      cells.push(x, y, z);
      states.push(state);
      stack.push(x, y + 1, z, x + 1, y, z, x - 1, y, z, x, y, z + 1, x, y, z - 1, x, y - 1, z);
    }
    return cells.length ? { cells, states } : null;
  }

  #break(list: number[], stateList: number[]): DebrisPiece {
    const cells = Int32Array.from(list),
      states = Uint32Array.from(stateList),
      n = states.length,
      clear = new Array<number>(n * 4),
      center: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < 3; a++) {
        clear[i * 4 + a] = cells[i * 3 + a];
        center[a] += cells[i * 3 + a] + 0.5;
      }
      clear[i * 4 + 3] = 0;
    }
    for (let a = 0; a < 3; a++) center[a] /= n;
    this.#clearing = true;
    try {
      this.world.setBlocks(clear);
    } finally {
      this.#clearing = false;
    }
    const boxes = mergeBoxes(cells),
      piece: Piece = { id: this.#next++, cells, states, center, boxes, body: null, meshes: [], age: 0 };
    if (this.#engine) piece.meshes = this.#meshes(piece);
    if (this.physics) {
      const parts: CompoundPart[] = [];
      for (let b = 0; b < boxes.length; b += 6)
        parts.push({
          shape: 'box',
          halfExtents: [
            (boxes[b + 3] - boxes[b]) / 2,
            (boxes[b + 4] - boxes[b + 1]) / 2,
            (boxes[b + 5] - boxes[b + 2]) / 2,
          ],
          offset: [
            (boxes[b] + boxes[b + 3]) / 2 - center[0],
            (boxes[b + 1] + boxes[b + 4]) / 2 - center[1],
            (boxes[b + 2] + boxes[b + 5]) / 2 - center[2],
          ],
        });
      piece.body = this.physics.addBody(piece.meshes[0] ?? null, {
        position: center,
        colliders: { shape: 'compound', parts, density: this.#density, friction: this.#friction },
        userData: piece,
      });
    }
    this.#pieces.push(piece);
    while (this.#pieces.length > this.maxPieces) this.#remove(this.#pieces[0]);
    return piece;
  }

  // Open faces of the piece, one core mesh per block type, vertices relative to the centre.
  #meshes(piece: Piece): Mesh[] {
    const { cells, states, center } = piece,
      n = states.length,
      min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n * 3; i++) {
      min[i % 3] = Math.min(min[i % 3], cells[i]);
      max[i % 3] = Math.max(max[i % 3], cells[i]);
    }
    const sx = max[0] - min[0] + 3,
      sy = max[1] - min[1] + 3,
      at = (x: number, y: number, z: number) => x - min[0] + 1 + (y - min[1] + 1) * sx + (z - min[2] + 1) * sx * sy,
      inside = new Set<number>();
    for (let i = 0; i < n; i++) inside.add(at(cells[i * 3], cells[i * 3 + 1], cells[i * 3 + 2]));
    const parts = new Map<number, { p: number[]; q: number[]; t: number[] }>();
    for (let i = 0; i < n; i++) {
      const x = cells[i * 3],
        y = cells[i * 3 + 1],
        z = cells[i * 3 + 2],
        id = states[i] & 0xffff;
      for (let d = 0; d < 6; d++) {
        if (inside.has(at(x + DX[d], y + DY[d], z + DZ[d]))) continue;
        let part = parts.get(id);
        if (!part) parts.set(id, (part = { p: [], q: [], t: [] }));
        const base = part.p.length / 3,
          f = FACES[d];
        for (let c = 0; c < 4; c++) {
          part.p.push(x + f[c * 3] - center[0], y + f[c * 3 + 1] - center[1], z + f[c * 3 + 2] - center[2]);
          part.q.push(DX[d], DY[d], DZ[d]);
        }
        part.t.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    const engine = this.#engine as Engine,
      meshes: Mesh[] = [];
    for (const [id, part] of parts) {
      let material = this.#materials.get(id);
      if (!material) this.#materials.set(id, (material = this.#material(this.world.blocks.get(id))));
      const mesh = engine
        .createMesh(meshes[0] ?? null)
        .setGeometry(new Geometry(part.p, part.q, part.t))
        .setMaterial(material);
      if (!meshes.length) mesh.position.set(center[0], center[1], center[2]);
      meshes.push(mesh);
    }
    return meshes;
  }

  #remove(piece: Piece): void {
    const i = this.#pieces.indexOf(piece);
    if (i < 0) return;
    this.#pieces.splice(i, 1);
    if (piece.body?.valid && this.physics && !this.physics.isDisposed) this.physics.removeBody(piece.body);
    for (let m = piece.meshes.length - 1; m >= 0; m--) piece.meshes[m].dispose();
  }
}

/**
 * Merges cells (x, y, z per cell) into boxes `[x0, y0, z0, x1, y1, z1)`, six numbers per box, that cover exactly those
 * cells: runs along x, then runs of equal x span along z, then equal rectangles along y. Each cell is in one box.
 */
export function mergeBoxes(cells: ArrayLike<number>): Int32Array {
  const n = cells.length / 3,
    order = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) =>
        cells[a * 3 + 1] - cells[b * 3 + 1] || cells[a * 3 + 2] - cells[b * 3 + 2] || cells[a * 3] - cells[b * 3],
    ),
    // Runs along x: [x0, x1, y, z].
    runs: number[][] = [];
  for (const i of order) {
    const x = cells[i * 3],
      y = cells[i * 3 + 1],
      z = cells[i * 3 + 2],
      last = runs[runs.length - 1];
    if (last && last[2] === y && last[3] === z && last[1] === x) last[1] = x + 1;
    else runs.push([x, x + 1, y, z]);
  }
  // Rectangles in one layer: [x0, x1, y, z0, z1], grown along z while the next row has the same x span.
  const rects: number[][] = [],
    open = new Map<string, number[]>();
  for (const [x0, x1, y, z] of runs) {
    const key = `${x0},${x1},${y},${z}`;
    let rect = open.get(key);
    open.delete(key);
    if (rect) rect[4] = z + 1;
    else rects.push((rect = [x0, x1, y, z, z + 1]));
    open.set(`${x0},${x1},${y},${z + 1}`, rect);
  }
  // Boxes grown along y while the layer above has the same rectangle (rects are in y order already).
  const boxes: number[][] = [],
    tops = new Map<string, number[]>();
  for (const [x0, x1, y, z0, z1] of rects) {
    const key = `${x0},${x1},${z0},${z1},${y}`;
    let box = tops.get(key);
    tops.delete(key);
    if (box) box[4] = y + 1;
    else boxes.push((box = [x0, y, z0, x1, y + 1, z1]));
    tops.set(`${x0},${x1},${z0},${z1},${y + 1}`, box);
  }
  const flat = new Int32Array(boxes.length * 6);
  boxes.forEach((b, i) => flat.set(b, i * 6));
  return flat;
}
