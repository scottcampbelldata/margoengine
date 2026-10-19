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
   * 26 neighbours, so a body always has at least one chunk (32 blocks) of terrain ahead of it. They are kept until no
   * body is within `radius + 1`. Integer >= 1.
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
  ColliderDesc: {
    voxels?(cells: Int32Array, size: { x: number; y: number; z: number }): unknown;
    trimesh(vertices: Float32Array, indices: Uint32Array, flags?: number): unknown;
  };
  Collider?: { prototype: Partial<VoxelCollider> };
  ShapeType: { Ball: number };
  TriMeshFlags?: { FIX_INTERNAL_EDGES?: number };
}
interface RapierBody {
  isFixed(): boolean;
  translation(): { x: number; y: number; z: number };
  numColliders(): number;
  collider(i: number): Collider;
}
interface RapierWorld {
  forEachRigidBody(f: (body: RapierBody) => void): void;
  createCollider(desc: unknown): VoxelCollider;
  removeCollider(collider: Collider, wakeUp: boolean): void;
}
interface Entry {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: string;
  chunk: VoxelChunk;
  // Always kept up to date (edits, coupling); disabled while `ball`, when only its neighbours' coupling uses it.
  collider: VoxelCollider;
  // While a ball body is near (`ball`): a triangle mesh of the same faces, or null when there are none.
  mesh: Collider | null;
  ball: boolean;
  // Rebuild the mesh before the next step: an edit changed a cell in or beside the chunk.
  dirty: boolean;
  // Faces (bit d, see DX) whose neighbour collider went away: this collider's border states may still count its voxels.
  stale: number;
}
type Place = Pick<Entry, 'cx' | 'cy' | 'cz' | 'chunk'>;
// A chunk within radius + 1 of a body: Chebyshev distance in chunks to the nearest body (d) and ball body (b).
interface Near {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: string;
  d: number;
  b: number;
}

const ONE = { x: 1, y: 1, z: 1 },
  // Face d: +x, -x, +y, -y, +z, -z; d ^ 1 is the opposite face, d >> 1 its axis.
  DX = [1, -1, 0, 0, 0, 0],
  DY = [0, 0, 1, -1, 0, 0],
  DZ = [0, 0, 0, 0, 1, -1],
  STRIDE = [1, 1024, 32], // cell index step along x, y, z
  LIMIT = 0x3ffffff; // largest chunk coordinate (cell >> 5 of a 32-bit cell)
const neighbour = (e: Entry, d: number): string => chunkKey(e.cx + DX[d], e.cy + DY[d], e.cz + DZ[d]);
const same = (a: Map<string, number>, b: Map<string, number>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
};

/**
 * Rapier colliders for a {@link VoxelWorld}, so dynamic bodies (mobs, item drops, debris, balls) and kinematic
 * character controllers of a `@margoengine/physics` world collide with its blocks. Before each physics step, every
 * loaded chunk within `radius` chunks of any non-fixed body (dynamic or kinematic, awake or asleep: a sleeping body
 * keeps its floor) gets one parentless collider in cell coordinates, built from the chunk's surface: its solid cells
 * (block types with `solid`) with at least one non-solid face neighbour, reading neighbour chunks (an unloaded one
 * counts as air). A chunk keeps it until no body is within `radius + 1` (so a body on a chunk border does not make
 * chunks come and go every step) or the chunk unloads.
 *
 * That is a Rapier voxel collider: neighbouring ones are coupled with `combineVoxelStates`, and edits
 * (`VoxelWorld.onChange`) update them in place with `setVoxel` and `propagateVoxelChange`, so bodies cross chunk
 * borders without snagging and a block removed under a body lets it fall. Rapier 0.21 panics when a ball collider
 * meets a voxel edge (rapier issues 1029 and 1043), so a chunk within `radius` of a body with a `'sphere'` collider
 * also gets a triangle mesh of the same open faces (merged into rectangles, `FIX_INTERNAL_EDGES` so balls roll over
 * its edges and seams smoothly) and its voxel collider is disabled, still updated and coupled so the voxel chunks
 * beside it stay seamless; that lasts until no ball body is within `radius + 1`. A mesh is rebuilt from scratch
 * before the next step after an edit in or beside its chunk, so edits there cost more than on voxels alone.
 *
 * The colliders are not physics bodies: `Physics` collision events and queries skip them (use `raycastVoxels` from
 * `@margoengine/voxel/query` for picking).
 */
export class VoxelPhysics {
  /** Chunks per axis around each moving body's chunk that get colliders. */
  readonly radius: number;
  private readonly physics: Physics;
  private readonly world: VoxelWorld;
  private readonly rapier: RapierVoxels;
  private readonly raw: RapierWorld;
  private readonly entries = new Map<string, Entry>();
  private centres = new Map<string, number>(); // body chunk key -> 1 when a ball body is there
  private near = new Map<string, Near>();
  private needed: Near[] = [];
  private readonly cells = new Int32Array(32768 * 3);
  private readonly mask = new Uint8Array(32768);
  private readonly faces = new Uint8Array(32768);
  private readonly plane = new Uint8Array(1024);
  private solid = new Uint8Array(0);
  private disposed = false;
  private readonly offStep: () => void;
  private readonly offChange: () => void;
  /**
   * Keeps colliders for `world`'s chunks near the bodies of `physics`, from the next physics step on.
   * @throws TypeError when `physics` is not a `@margoengine/physics` Physics or `world` is not a {@link VoxelWorld}.
   * @throws RangeError (TypeError for a non-number) unless `options.radius` is an integer >= 1.
   * @throws MargoError `'disposed'` when `physics` is disposed, `'unsupported'` when its Rapier has no voxel
   * colliders or no `TriMeshFlags.FIX_INTERNAL_EDGES` (needs `@dimforge/rapier3d-compat` 0.17.1 or newer).
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
      typeof rapier.Collider?.prototype.combineVoxelStates !== 'function' ||
      typeof rapier.TriMeshFlags?.FIX_INTERNAL_EDGES !== 'number'
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
   * A snapshot of the colliders bodies touch, by chunk key ({@link chunkKey}): voxel colliders, or triangle meshes
   * near ball bodies. A collider is replaced when its chunk is replaced or comes back into range, and a mesh also
   * when it is edited, so settings changed on one (friction, groups) do not last.
   */
  get colliders(): ReadonlyMap<string, CollisionEvent['colliderA']> {
    const out = new Map<string, Collider>();
    for (const [key, entry] of this.entries) {
      const collider = entry.ball ? entry.mesh : entry.collider;
      if (collider) out.set(key, collider);
    }
    return out;
  }
  /** Removes every collider and stops following the world and the physics steps. Calling it again does nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offStep();
    this.offChange();
    if (!this.physics.isDisposed) for (const entry of this.entries.values()) this.free(entry);
    this.entries.clear();
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
  // Brings the colliders in line with the bodies and the loaded chunks; runs before each physics step.
  private update(): void {
    const r = this.radius,
      ballShape = this.rapier.ShapeType.Ball,
      centres = new Map<string, number>();
    this.raw.forEachRigidBody((body) => {
      if (body.isFixed()) return;
      const t = body.translation(),
        cx = Math.floor(t.x / 32),
        cy = Math.floor(t.y / 32),
        cz = Math.floor(t.z / 32);
      // A body at NaN or beyond the 32-bit cell range has no chunks around it.
      if (!(Math.abs(cx) <= LIMIT - r - 1 && Math.abs(cy) <= LIMIT - r - 1 && Math.abs(cz) <= LIMIT - r - 1)) return;
      const key = chunkKey(cx, cy, cz);
      let balls = centres.get(key) ?? 0;
      for (let i = body.numColliders(); !balls && i-- > 0; ) if (body.collider(i).shapeType() === ballShape) balls = 1;
      centres.set(key, balls);
    });
    if (!same(centres, this.centres)) this.survey(centres);
    const world = this.world,
      fresh: Entry[] = [];
    for (const entry of this.entries.values()) {
      const near = this.near.get(entry.key);
      if (!near || world.getChunk(entry.cx, entry.cy, entry.cz) !== entry.chunk) {
        this.remove(entry); // out of range, unloaded or replaced (a needed replacement is built below)
        continue;
      }
      // A mesh while a ball body is within radius (so a ball never meets a voxel collider), voxels again once none
      // is within radius + 1.
      const ball = near.b <= r || (entry.ball && near.b <= r + 1);
      if (ball !== entry.ball || entry.dirty) this.remesh(entry, ball);
    }
    for (const near of this.needed) {
      if (this.entries.has(near.key)) continue;
      const { cx, cy, cz, key } = near,
        chunk = world.getChunk(cx, cy, cz);
      if (!chunk) continue;
      const collider = this.voxelCollider({ cx, cy, cz, chunk }),
        entry: Entry = { cx, cy, cz, key, chunk, collider, mesh: null, ball: false, dirty: false, stale: 0 };
      this.entries.set(key, entry);
      fresh.push(entry);
      if (near.b <= r) this.remesh(entry, true);
    }
    // Rebuild a collider with stale borders once the chunk beside that border is needed again (combining only adds
    // neighbour flags; it cannot clear the old ones, and a mesh lacks the faces the old neighbour hid). Until then
    // no body is within a chunk of that border.
    for (const entry of this.entries.values())
      for (let d = 0; entry.stale && d < 6; d++)
        if (entry.stale & (1 << d) && (this.near.get(neighbour(entry, d))?.d ?? r + 1) <= r) {
          this.raw.removeCollider(entry.collider, true);
          entry.collider = this.voxelCollider(entry);
          entry.stale = 0;
          fresh.push(entry);
          if (entry.ball) {
            entry.collider.setEnabled(false);
            this.remesh(entry, true);
          }
        }
    // Couple each new voxel collider with its face neighbours (voxel states only track the faces), once per pair.
    const coupled = new Set<Entry>();
    for (const entry of fresh) {
      for (let d = 0; d < 6; d++) {
        const other = this.entries.get(neighbour(entry, d));
        if (other && !coupled.has(other)) entry.collider.combineVoxelStates(other.collider as VoxelCollider, 0, 0, 0);
      }
      coupled.add(entry);
    }
  }
  // Distances from every chunk within radius + 1 of a body chunk to the nearest body and ball body.
  private survey(centres: Map<string, number>): void {
    const r = this.radius + 1,
      near = new Map<string, Near>();
    for (const [key, ball] of centres) {
      const [cx, cy, cz] = key.split(',').map(Number);
      for (let x = cx - r; x <= cx + r; x++)
        for (let y = cy - r; y <= cy + r; y++)
          for (let z = cz - r; z <= cz + r; z++) {
            const k = chunkKey(x, y, z),
              d = Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz));
            let entry = near.get(k);
            if (!entry) near.set(k, (entry = { cx: x, cy: y, cz: z, key: k, d, b: Infinity }));
            else entry.d = Math.min(entry.d, d);
            if (ball) entry.b = Math.min(entry.b, d);
          }
    }
    this.centres = centres;
    this.near = near;
    this.needed = Array.from(near.values()).filter((entry) => entry.d <= this.radius);
  }
  // Gives the chunk a fresh mesh (ball) or drops it; the voxel collider is disabled exactly while there is a mesh.
  private remesh(entry: Entry, ball: boolean): void {
    if (entry.mesh) this.raw.removeCollider(entry.mesh, true);
    entry.mesh = ball ? this.meshCollider(entry) : null;
    if (ball !== entry.ball) entry.collider.setEnabled(!ball);
    entry.ball = ball;
    entry.dirty = false;
  }
  private free(entry: Entry): void {
    this.raw.removeCollider(entry.collider, true);
    if (entry.mesh) this.raw.removeCollider(entry.mesh, true);
  }
  private remove(entry: Entry): void {
    this.free(entry);
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
  // Fills `faces` with the open faces (bit d: that neighbour is not solid) of each solid cell; returns how many have any.
  private scan(e: Place): number {
    const { palette, bits, words } = e.chunk.pack(),
      ids = this.solidIds(),
      mask = this.mask,
      faces = this.faces;
    faces.fill(0);
    if (bits) {
      const m = (1 << bits) - 1;
      for (let i = 0; i < 32768; i++)
        mask[i] = ids[palette[(words[(i * bits) >>> 5] >>> ((i * bits) & 31)) & m] & 0xffff];
    } else if (ids[palette[0] & 0xffff]) mask.fill(1);
    else return 0;
    // Solid flags of the cell layer just outside each face, in the order of DX.
    const [px, nx, py, ny, pz, nz] = DX.map((_, d) => this.layer(e.cx + DX[d], e.cy + DY[d], e.cz + DZ[d], d));
    let count = 0;
    for (let y = 0; y < 32; y++)
      for (let z = 0; z < 32; z++)
        for (let x = 0; x < 32; x++) {
          const i = x | (z << 5) | (y << 10);
          if (!mask[i]) continue;
          const open =
            +!(x < 31 ? mask[i + 1] : px[z | (y << 5)]) |
            (+!(x ? mask[i - 1] : nx[z | (y << 5)]) << 1) |
            (+!(y < 31 ? mask[i + 1024] : py[x | (z << 5)]) << 2) |
            (+!(y ? mask[i - 1024] : ny[x | (z << 5)]) << 3) |
            (+!(z < 31 ? mask[i + 32] : pz[x | (y << 5)]) << 4) |
            (+!(z ? mask[i - 32] : nz[x | (y << 5)]) << 5);
          if (open) {
            faces[i] = open;
            count++;
          }
        }
    return count;
  }
  // A voxel collider holding the chunk's surface cells, in world cell coordinates.
  private voxelCollider(e: Place): VoxelCollider {
    const cells = this.cells,
      faces = this.faces;
    let n = 0;
    if (this.scan(e))
      for (let i = 0; i < 32768; i++)
        if (faces[i]) {
          cells[n++] = e.cx * 32 + (i & 31);
          cells[n++] = e.cy * 32 + (i >> 10);
          cells[n++] = e.cz * 32 + ((i >> 5) & 31);
        }
    return this.raw.createCollider(this.rapier.ColliderDesc.voxels!(cells.slice(0, n), ONE));
  }
  // A triangle mesh of the chunk's open faces, merged into rectangles per face direction and cell layer, with
  // outward winding; null when there are none (Rapier cannot build an empty mesh).
  private meshCollider(e: Place): Collider | null {
    if (!this.scan(e)) return null;
    const faces = this.faces,
      plane = this.plane,
      origin = [e.cx * 32, e.cy * 32, e.cz * 32],
      vertices: number[] = [],
      indices: number[] = [],
      corner = [0, 0, 0];
    for (let d = 0; d < 6; d++) {
      const u = d >> 1,
        v = (u + 1) % 3,
        w = (u + 2) % 3,
        bit = 1 << d,
        positive = !(d & 1);
      for (let k = 0; k < 32; k++) {
        for (let a = 0; a < 32; a++)
          for (let b = 0; b < 32; b++) plane[a | (b << 5)] = faces[k * STRIDE[u] + a * STRIDE[v] + b * STRIDE[w]] & bit;
        for (let b = 0; b < 32; b++)
          for (let a = 0; a < 32; a++) {
            if (!plane[a | (b << 5)]) continue;
            let a1 = a + 1,
              b1 = b + 1;
            while (a1 < 32 && plane[a1 | (b << 5)]) a1++;
            grow: while (b1 < 32) {
              for (let t = a; t < a1; t++) if (!plane[t | (b1 << 5)]) break grow;
              b1++;
            }
            for (let s = b; s < b1; s++) for (let t = a; t < a1; t++) plane[t | (s << 5)] = 0;
            // Corners counter-clockwise seen from outside: v then w spans +u, so a negative face goes w then v.
            const base = vertices.length / 3,
              rect = positive ? [a, b, a1, b, a1, b1, a, b1] : [a, b, a, b1, a1, b1, a1, b];
            corner[u] = origin[u] + k + (positive ? 1 : 0);
            for (let c = 0; c < 8; c += 2) {
              corner[v] = origin[v] + rect[c];
              corner[w] = origin[w] + rect[c + 1];
              vertices.push(corner[0], corner[1], corner[2]);
            }
            indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
          }
      }
    }
    const R = this.rapier;
    return this.raw.createCollider(
      R.ColliderDesc.trimesh(
        Float32Array.from(vertices),
        Uint32Array.from(indices),
        R.TriMeshFlags?.FIX_INTERNAL_EDGES,
      ),
    );
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
  // VoxelWorld.onChange: solidity flips become setVoxel calls (and mesh rebuilds); a removed cell exposes its solid
  // neighbours.
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
    // A mesh rebuilds at the next step. A neighbour chunk's mesh only needs to when this exposes one of its cells,
    // and edit() sets those cells too.
    if (entry.ball) entry.dirty = true;
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
