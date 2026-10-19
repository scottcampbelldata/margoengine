/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/voxel/physics: Rapier voxel colliders for the chunks near moving bodies (design: DESIGN.md phase 11).
// Only types come from @margoengine/physics: this entry adds no runtime import, so neither it nor the root pulls Rapier.
import type { CollisionEvent, Physics } from '@margoengine/physics';
import { MargoError } from '@margoengine/math/errors';
import type { VoxelChunk } from './chunk.js';
import { chunkKey, VoxelWorld } from './world.js';

/** Options of {@link VoxelPhysics}. */
export interface VoxelPhysicsOptions {
  /**
   * Chunks per axis around each moving body's chunk that get colliders: 1 (default) covers the body's chunk and its
   * 26 neighbours, so a body always has at least one chunk (32 blocks) of terrain ahead of it. Integer >= 1.
   */
  radius?: number;
}

type Collider = CollisionEvent['colliderA'];
// The Rapier >= 0.17.1 voxel API this module uses, structurally (as @margoengine/physics types Rapier).
interface VoxelCollider extends Collider {
  setVoxel(x: number, y: number, z: number, filled: boolean): void;
  combineVoxelStates(other: VoxelCollider, sx: number, sy: number, sz: number): void;
  propagateVoxelChange(other: VoxelCollider, x: number, y: number, z: number, sx: number, sy: number, sz: number): void;
}
interface RapierVoxels {
  ColliderDesc: { voxels?(cells: Int32Array, size: { x: number; y: number; z: number }): unknown };
  Collider?: { prototype: Partial<VoxelCollider> };
}
interface RapierWorld {
  forEachRigidBody(f: (body: { isFixed(): boolean; translation(): { x: number; y: number; z: number } }) => void): void;
  createCollider(desc: unknown): VoxelCollider;
  removeCollider(collider: Collider, wakeUp: boolean): void;
}
interface Entry {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: string;
  chunk: VoxelChunk;
  collider: VoxelCollider;
  // Faces (bit d, see DX) whose neighbour collider went away: this collider's border states may still count its voxels.
  stale: number;
}

const ONE = { x: 1, y: 1, z: 1 },
  // Face d: +x, -x, +y, -y, +z, -z; d ^ 1 is the opposite face.
  DX = [1, -1, 0, 0, 0, 0],
  DY = [0, 0, 1, -1, 0, 0],
  DZ = [0, 0, 0, 0, 1, -1],
  LIMIT = 0x3ffffff; // largest chunk coordinate (cell >> 5 of a 32-bit cell)
const neighbour = (e: Entry, d: number): string => chunkKey(e.cx + DX[d], e.cy + DY[d], e.cz + DZ[d]);

/**
 * Rapier voxel colliders for a {@link VoxelWorld}, so dynamic bodies (mobs, item drops, debris) and kinematic
 * character controllers of a `@margoengine/physics` world collide with its blocks. Before each physics step, every
 * loaded chunk within `radius` chunks of any non-fixed body (dynamic or kinematic, awake or asleep: a sleeping body
 * keeps its floor) gets one parentless voxel collider in cell coordinates, built from the chunk's surface: its solid
 * cells (block types with `solid`) with at least one non-solid face neighbour, reading neighbour chunks (an
 * unloaded one counts as air). Chunks no body is near, and unloaded chunks, lose theirs. Neighbouring colliders are
 * coupled with Rapier's `combineVoxelStates`, and edits (`VoxelWorld.onChange`) update colliders in place with
 * `setVoxel` and `propagateVoxelChange`, so bodies cross chunk borders without snagging and a block removed under a
 * body lets it fall. The colliders are not physics bodies: `Physics` collision events and queries skip them (use
 * `raycastVoxels` from `@margoengine/voxel/query` for picking).
 *
 * Rapier 0.21.0 panics (`RuntimeError: unreachable`, which ends the whole Rapier instance) when a ball collider meets
 * a voxel edge: rolling off a ledge, over a chunk border, or into a wall. Give round bodies a convex hull, capsule or
 * round box until Rapier fixes it; boxes, capsules, cylinders and convex hulls work.
 */
export class VoxelPhysics {
  /** Chunks per axis around each moving body's chunk that get colliders. */
  readonly radius: number;
  private readonly physics: Physics;
  private readonly world: VoxelWorld;
  private readonly rapier: RapierVoxels;
  private readonly raw: RapierWorld;
  private readonly entries = new Map<string, Entry>();
  private readonly cells = new Int32Array(32768 * 3);
  private readonly mask = new Uint8Array(32768);
  private solid = new Uint8Array(0);
  private disposed = false;
  private readonly offStep: () => void;
  private readonly offChange: () => void;
  /**
   * Keeps colliders for `world`'s chunks near the bodies of `physics`, from the next physics step on.
   * @throws TypeError when `physics` is not a `@margoengine/physics` Physics or `world` is not a {@link VoxelWorld}.
   * @throws RangeError (TypeError for a non-number) unless `options.radius` is an integer >= 1.
   * @throws MargoError `'disposed'` when `physics` is disposed, `'unsupported'` when its Rapier has no voxel
   * colliders (needs `@dimforge/rapier3d-compat` 0.17.1 or newer).
   */
  constructor(physics: Physics, world: VoxelWorld, options: VoxelPhysicsOptions = {}) {
    if (!physics || typeof physics.on !== 'function' || !physics.rapier)
      throw new TypeError(
        'VoxelPhysics needs a Physics: pass Physics.attach(engine, {rapier}) from @margoengine/physics',
      );
    if (!(world instanceof VoxelWorld))
      throw new TypeError('VoxelPhysics needs a VoxelWorld: pass new VoxelWorld({blocks})');
    const { radius = 1 } = options ?? {};
    if (typeof radius !== 'number') throw new TypeError('VoxelPhysics radius must be a number of chunks such as 1');
    if (!Number.isInteger(radius) || radius < 1)
      throw new RangeError(`VoxelPhysics radius ${radius} is not an integer >= 1; pass 1 or more chunks`);
    if (physics.isDisposed)
      throw new MargoError('disposed', 'Physics is disposed; pass a live Physics to VoxelPhysics');
    const rapier = physics.rapier as unknown as RapierVoxels;
    if (
      typeof rapier.ColliderDesc.voxels !== 'function' ||
      typeof rapier.Collider?.prototype.combineVoxelStates !== 'function'
    )
      throw new MargoError(
        'unsupported',
        'This Rapier has no voxel colliders; install @dimforge/rapier3d-compat 0.17.1 or newer for VoxelPhysics',
      );
    this.physics = physics;
    this.world = world;
    this.rapier = rapier;
    this.raw = physics.world as unknown as RapierWorld;
    this.radius = radius;
    this.offStep = physics.on('beforestep', () => this.update());
    this.offChange = world.onChange(this.edit);
  }
  /**
   * A snapshot of the colliders, by chunk key ({@link chunkKey}). A collider is replaced when its chunk is replaced
   * or comes back into range, so settings changed on it (friction, groups) do not last.
   */
  get colliders(): ReadonlyMap<string, CollisionEvent['colliderA']> {
    return new Map(Array.from(this.entries, ([key, entry]) => [key, entry.collider]));
  }
  /** Removes every collider and stops following the world and the physics steps. Calling it again does nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offStep();
    this.offChange();
    if (!this.physics.isDisposed)
      for (const entry of this.entries.values()) this.raw.removeCollider(entry.collider, true);
    this.entries.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  // Brings the colliders in line with the bodies and the loaded chunks; runs before each physics step.
  private update(): void {
    const r = this.radius,
      world = this.world,
      needed = new Set<string>(),
      centres = new Set<string>(),
      wanted: number[] = [];
    this.raw.forEachRigidBody((body) => {
      if (body.isFixed()) return;
      const t = body.translation(),
        cx = Math.floor(t.x / 32),
        cy = Math.floor(t.y / 32),
        cz = Math.floor(t.z / 32);
      // A body at NaN or beyond the 32-bit cell range has no chunks around it.
      if (!(Math.abs(cx) <= LIMIT - r && Math.abs(cy) <= LIMIT - r && Math.abs(cz) <= LIMIT - r)) return;
      const centre = chunkKey(cx, cy, cz);
      if (centres.has(centre)) return;
      centres.add(centre);
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = cz - r; z <= cz + r; z++) {
            const key = chunkKey(x, y, z);
            if (needed.has(key)) continue;
            needed.add(key);
            if (!this.entries.has(key)) wanted.push(x, y, z);
          }
    });
    for (const entry of this.entries.values()) {
      const chunk = needed.has(entry.key) ? world.getChunk(entry.cx, entry.cy, entry.cz) : undefined;
      if (chunk === entry.chunk) continue;
      this.remove(entry);
      if (chunk) wanted.push(entry.cx, entry.cy, entry.cz); // replaced: build the new chunk
    }
    const fresh: Entry[] = [];
    for (let i = 0; i < wanted.length; i += 3) {
      const cx = wanted[i],
        cy = wanted[i + 1],
        cz = wanted[i + 2],
        chunk = world.getChunk(cx, cy, cz);
      if (!chunk) continue;
      const key = chunkKey(cx, cy, cz),
        entry: Entry = { cx, cy, cz, key, chunk, collider: this.build(cx, cy, cz, chunk), stale: 0 };
      this.entries.set(key, entry);
      fresh.push(entry);
    }
    // Rebuild a collider with stale border states once the chunk beside that border is needed again (combining only
    // adds neighbour flags; it cannot clear the old ones). Until then no body is within a chunk of that border.
    for (const entry of this.entries.values())
      for (let d = 0; entry.stale && d < 6; d++)
        if (entry.stale & (1 << d) && needed.has(neighbour(entry, d))) {
          this.raw.removeCollider(entry.collider, false);
          entry.collider = this.build(entry.cx, entry.cy, entry.cz, entry.chunk);
          entry.stale = 0;
          fresh.push(entry);
        }
    // Couple each new collider with its face neighbours (voxel states only track the 6 faces), once per pair.
    const coupled = new Set<Entry>();
    for (const entry of fresh) {
      for (let d = 0; d < 6; d++) {
        const other = this.entries.get(neighbour(entry, d));
        if (other && !coupled.has(other)) entry.collider.combineVoxelStates(other.collider, 0, 0, 0);
      }
      coupled.add(entry);
    }
  }
  private remove(entry: Entry): void {
    this.raw.removeCollider(entry.collider, true);
    this.entries.delete(entry.key);
    for (let d = 0; d < 6; d++) {
      const other = this.entries.get(neighbour(entry, d));
      if (other) other.stale |= 1 << (d ^ 1);
    }
  }
  // Solid flag per block id, refreshed when the world's block types grow.
  private solidIds(): Uint8Array {
    const table = this.world.blocks.table;
    if (this.solid.length !== table.length) this.solid = Uint8Array.from(table, (type) => +type.solid);
    return this.solid;
  }
  // A voxel collider holding the chunk's surface cells, in world cell coordinates.
  private build(cx: number, cy: number, cz: number, chunk: VoxelChunk): VoxelCollider {
    const { palette, bits, words } = chunk.pack(),
      ids = this.solidIds(),
      mask = this.mask,
      cells = this.cells;
    let n = 0;
    if (bits) {
      const m = (1 << bits) - 1;
      for (let i = 0; i < 32768; i++)
        mask[i] = ids[palette[(words[(i * bits) >>> 5] >>> ((i * bits) & 31)) & m] & 0xffff];
    } else mask.fill(ids[palette[0] & 0xffff]);
    if (mask[0] || bits) {
      // Solid flags of the cell layer just outside each face, in the order of DX.
      const outside = DX.map((_, d) => this.layer(cx + DX[d], cy + DY[d], cz + DZ[d], d)),
        [px, nx, py, ny, pz, nz] = outside,
        ox = cx * 32,
        oy = cy * 32,
        oz = cz * 32;
      for (let y = 0; y < 32; y++)
        for (let z = 0; z < 32; z++)
          for (let x = 0; x < 32; x++) {
            const i = x | (z << 5) | (y << 10);
            if (
              mask[i] &&
              !(
                (x < 31 ? mask[i + 1] : px[z | (y << 5)]) &&
                (x ? mask[i - 1] : nx[z | (y << 5)]) &&
                (y < 31 ? mask[i + 1024] : py[x | (z << 5)]) &&
                (y ? mask[i - 1024] : ny[x | (z << 5)]) &&
                (z < 31 ? mask[i + 32] : pz[x | (y << 5)]) &&
                (z ? mask[i - 32] : nz[x | (y << 5)])
              )
            ) {
              cells[n++] = ox + x;
              cells[n++] = oy + y;
              cells[n++] = oz + z;
            }
          }
    }
    return this.raw.createCollider(this.rapier.ColliderDesc.voxels!(cells.slice(0, n), ONE));
  }
  // Solid flags of the facing layer of chunk (cx, cy, cz), seen from its neighbour across face d (all 0 when unloaded).
  private layer(cx: number, cy: number, cz: number, d: number): Uint8Array {
    const out = new Uint8Array(1024),
      chunk =
        Math.abs(cx) <= LIMIT && Math.abs(cy) <= LIMIT && Math.abs(cz) <= LIMIT
          ? this.world.getChunk(cx, cy, cz)
          : undefined;
    if (!chunk) return out;
    const ids = this.solidIds(),
      // The facing layer: x = 0 seen from -x (face +x), x = 31 from +x, and so on.
      at = d & 1 ? 31 : 0;
    for (let a = 0; a < 32; a++)
      for (let b = 0; b < 32; b++)
        out[a | (b << 5)] =
          ids[(d < 2 ? chunk.get(at, b, a) : d < 4 ? chunk.get(a, at, b) : chunk.get(a, b, at)) & 0xffff];
    return out;
  }
  // VoxelWorld.onChange: solidity flips become setVoxel calls; a removed cell exposes its solid neighbours.
  private readonly edit = (x: number, y: number, z: number, state: number, previous: number): void => {
    if (this.physics.isDisposed) return this.dispose();
    const ids = this.solidIds(),
      solid = ids[state & 0xffff];
    if (solid === ids[previous & 0xffff]) return;
    this.set(x, y, z, !!solid);
    if (!solid)
      for (let d = 0; d < 6; d++) {
        const nx = x + DX[d],
          ny = y + DY[d],
          nz = z + DZ[d];
        if ((nx | 0) === nx && (nz | 0) === nz && ids[this.world.getBlock(nx, ny, nz) & 0xffff])
          this.set(nx, ny, nz, true);
      }
  };
  private set(x: number, y: number, z: number, filled: boolean): void {
    const cx = x >> 5,
      cy = y >> 5,
      cz = z >> 5,
      entry = this.entries.get(chunkKey(cx, cy, cz));
    if (!entry) return;
    entry.collider.setVoxel(x, y, z, filled);
    // A border cell's face neighbour is in the next chunk's collider: keep their voxel states coupled.
    const lx = x & 31,
      ly = y & 31,
      lz = z & 31;
    if (lx === 31) this.propagate(entry, cx + 1, cy, cz, x, y, z);
    if (lx === 0) this.propagate(entry, cx - 1, cy, cz, x, y, z);
    if (ly === 31) this.propagate(entry, cx, cy + 1, cz, x, y, z);
    if (ly === 0) this.propagate(entry, cx, cy - 1, cz, x, y, z);
    if (lz === 31) this.propagate(entry, cx, cy, cz + 1, x, y, z);
    if (lz === 0) this.propagate(entry, cx, cy, cz - 1, x, y, z);
  }
  private propagate(entry: Entry, cx: number, cy: number, cz: number, x: number, y: number, z: number): void {
    const other = this.entries.get(chunkKey(cx, cy, cz));
    if (other) entry.collider.propagateVoxelChange(other.collider, x, y, z, 0, 0, 0);
  }
}
