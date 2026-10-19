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
  /**
   * Milliseconds of triangle-mesh building per physics step, default 2 (see {@link VoxelPhysics.budget}). `Infinity`
   * builds everything in the step that needs it. A number >= 0.
   */
  budget?: number;
}

type Collider = CollisionEvent['colliderA'];
interface Vec {
  x: number;
  y: number;
  z: number;
}
// The Rapier >= 0.17.1 voxel API this module uses, structurally (as @margoengine/physics types Rapier).
interface VoxelCollider extends Collider {
  setVoxel(x: number, y: number, z: number, filled: boolean): void;
  combineVoxelStates(other: VoxelCollider, sx: number, sy: number, sz: number): void;
  propagateVoxelChange(other: VoxelCollider, x: number, y: number, z: number, sx: number, sy: number, sz: number): void;
}
interface BodyCollider extends Collider {
  halfExtents(target?: Vec): Vec | null;
  translationWrtParent(target?: Vec): Vec | null;
  roundRadius(): number;
}
interface RapierVoxels {
  ColliderDesc: {
    voxels?(cells: Int32Array, size: Vec): unknown;
    trimesh(vertices: Float32Array, indices: Uint32Array, flags?: number): unknown;
  };
  Collider?: { prototype: Partial<VoxelCollider> };
  ShapeType: Record<
    'Ball' | 'Cuboid' | 'RoundCuboid' | 'Capsule' | 'Cylinder' | 'Cone' | 'RoundCylinder' | 'RoundCone',
    number
  >;
  TriMeshFlags?: { FIX_INTERNAL_EDGES?: number };
}
interface RapierBody {
  isFixed(): boolean;
  translation(): Vec;
  linvel(): Vec;
  numColliders(): number;
  collider(i: number): BodyCollider;
}
interface RapierWorld {
  forEachRigidBody(f: (body: RapierBody) => void): void;
  createCollider(desc: unknown): Collider;
  removeCollider(collider: Collider, wakeUp: boolean): void;
}
// A box of chunk-local cells [x0, y0, z0, x1, y1, z1) meshed as one Rapier triangle mesh.
interface Piece {
  readonly box: readonly number[];
  // The mesh (null when the box has no open faces or is not built yet); kept until its rebuild replaces it.
  collider: Collider | null;
  // Needs a (re)build: new, or an edit changed a cell in or beside the box.
  dirty: boolean;
}
interface Entry {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly key: string;
  chunk: VoxelChunk;
  // Always kept up to date (edits, coupling) once built; disabled in MESH mode, when only its neighbours' coupling
  // uses it. Null until its first build.
  collider: VoxelCollider | null;
  // The voxel collider is missing or has stale borders.
  rebuild: boolean;
  // VOXELS, BUILDING (pieces built disabled, voxel collider active) or MESH (pieces active, voxel collider disabled).
  mode: number;
  // Boxes partitioning the chunk; empty in VOXELS mode.
  pieces: Piece[];
  // Open faces for the pieces (from scan), kept while some are dirty, and whether they still match the world.
  faces: Uint8Array | null;
  scanned: boolean;
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
  WHOLE: readonly number[] = [0, 0, 0, 32, 32, 32],
  // Face d: +x, -x, +y, -y, +z, -z; d ^ 1 is the opposite face, d >> 1 its axis.
  DX = [1, -1, 0, 0, 0, 0],
  DY = [0, 0, 1, -1, 0, 0],
  DZ = [0, 0, 0, 0, 1, -1],
  STRIDE = [1, 1024, 32], // cell index step along x, y, z
  LIMIT = 0x3ffffff, // largest chunk coordinate (cell >> 5 of a 32-bit cell)
  VOXELS = 0,
  BUILDING = 1,
  MESH = 2,
  // Most triangles in one mesh piece: one Rapier FIX_INTERNAL_EDGES build of about 1 ms on the reference desktop.
  PIECE = 2048,
  // Metres added to every body's reach: what a body can touch before the next step is never left pending.
  MARGIN = 1;
const neighbour = (e: Entry, d: number): string => chunkKey(e.cx + DX[d], e.cy + DY[d], e.cz + DZ[d]);
const same = (a: Map<string, number>, b: Map<string, number>): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
};
const checkBudget = (budget: unknown): number => {
  if (typeof budget !== 'number')
    throw new TypeError('VoxelPhysics budget must be a number of milliseconds per step such as 2');
  if (!(budget >= 0)) throw new RangeError(`VoxelPhysics budget ${budget} is not >= 0; pass milliseconds such as 2`);
  return budget;
};

/**
 * Rapier colliders for a {@link VoxelWorld}, so dynamic bodies (mobs, item drops, debris, balls) and kinematic
 * character controllers of a `@margoengine/physics` world collide with its blocks. Before each physics step, every
 * loaded chunk within `radius` chunks of any non-fixed body (dynamic or kinematic, awake or asleep: a sleeping body
 * keeps its floor) gets a collider in cell coordinates, built from the chunk's surface: its solid cells (block types
 * with `solid`) with at least one non-solid face neighbour, reading neighbour chunks (an unloaded one counts as air).
 * A chunk keeps it until no body is within `radius + 1` (so a body on a chunk border does not make chunks come and go
 * every step) or the chunk unloads.
 *
 * That is a Rapier voxel collider: neighbouring ones are coupled with `combineVoxelStates`, and edits
 * (`VoxelWorld.onChange`) update them in place with `setVoxel` and `propagateVoxelChange`, so bodies cross chunk
 * borders without snagging and a block removed under a body lets it fall. Rapier 0.21 panics when a ball collider
 * meets a voxel edge (rapier issues 1029 and 1043), so a chunk within `radius` of a body with a `'sphere'` collider
 * also gets a triangle mesh of the same open faces (merged into rectangles, `FIX_INTERNAL_EDGES` so balls roll over
 * its edges and seams smoothly), split into pieces of at most 2,048 triangles, and its voxel collider is disabled,
 * still updated and coupled so the voxel chunks beside it stay seamless; that lasts until no ball body is within
 * `radius + 1`. An edit rebuilds only the pieces holding the changed cell and its neighbours.
 *
 * Mesh building is spread over steps by {@link VoxelPhysics.budget}: what a body can reach before the next step is
 * built at once, the rest nearest first within the budget. A chunk keeps its voxel collider until its mesh is
 * complete, a ball arriving early switches it at once (with the pieces around every body built in that step), and an
 * edited piece keeps its previous mesh until the rebuild replaces it.
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
  private limit: number;
  private readonly entries = new Map<string, Entry>();
  // Entries with something to build.
  private readonly work = new Set<Entry>();
  private centres = new Map<string, number>(); // body chunk key -> 1 when a ball body is there
  private near = new Map<string, Near>();
  private needed: Near[] = [];
  // Conservative cost estimates (ms) of a voxel build, a scan and a piece build: a decaying maximum of measured runs.
  private readonly cost = [0.5, 0.3, 0.5];
  // x, y, z, reach, ball per non-fixed body, gathered when there is work.
  private readonly spheres: number[] = [];
  private readonly vector = { x: 0, y: 0, z: 0 };
  private readonly cells = new Int32Array(32768 * 3);
  private readonly mask = new Uint8Array(32768);
  private readonly faces = new Uint8Array(32768);
  private readonly plane = new Uint8Array(1024);
  private readonly vertices = new Float32Array(PIECE * 6);
  private readonly indices = new Uint32Array(PIECE * 3);
  private solid = new Uint8Array(0);
  private disposed = false;
  private readonly offStep: () => void;
  private readonly offChange: () => void;
  /**
   * Keeps colliders for `world`'s chunks near the bodies of `physics`, from the next physics step on.
   * @throws TypeError when `physics` is not a `@margoengine/physics` Physics or `world` is not a {@link VoxelWorld}.
   * @throws RangeError (TypeError for a non-number) unless `options.radius` is an integer >= 1 and `options.budget`
   * a number >= 0.
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
    const { radius = 1, budget = 2 } = options ?? {};
    if (typeof radius !== 'number') throw new TypeError('VoxelPhysics radius must be a number of chunks such as 1');
    if (!Number.isInteger(radius) || radius < 1)
      throw new RangeError(`VoxelPhysics radius ${radius} is not an integer >= 1; pass 1 or more chunks`);
    this.limit = checkBudget(budget);
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
   * Milliseconds of triangle-mesh building per physics step (default 2; live); voxel colliders are built in the step
   * that needs them. Mesh work a body can reach before the next step (the pieces around a ball, an edited piece under
   * a body) is always done in that step. The rest (meshes still away from balls) is built nearest first while the
   * step's estimated cost stays within the budget; a step with nothing urgent still does one unit (one scan or one
   * mesh piece), so building always progresses. `Infinity` builds everything at once.
   * @throws RangeError for a negative or NaN value, TypeError for a non-number.
   */
  get budget(): number {
    return this.limit;
  }
  set budget(value: number) {
    this.limit = checkBudget(value);
  }
  /** Chunks with mesh work left: pieces still to build or rebuild. */
  get pending(): number {
    return this.work.size;
  }
  /**
   * A snapshot of the colliders bodies touch, by chunk key ({@link chunkKey}): the chunk's voxel collider, or the
   * triangle-mesh pieces of a chunk near ball bodies. A chunk whose first collider is still pending is missing. A
   * collider is replaced when its chunk is replaced or comes back into range, and a mesh piece also when it is edited,
   * so settings changed on one (friction, groups) do not last.
   */
  get colliders(): ReadonlyMap<string, readonly CollisionEvent['colliderA'][]> {
    const out = new Map<string, Collider[]>();
    for (const [key, entry] of this.entries) {
      const list: Collider[] = [];
      if (entry.mode !== MESH) {
        if (entry.collider) list.push(entry.collider);
      } else for (const piece of entry.pieces) if (piece.collider) list.push(piece.collider);
      if (list.length) out.set(key, list);
    }
    return out;
  }
  /** Removes every collider and stops following the world and the physics steps. Calling it again does nothing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offStep();
    this.offChange();
    if (!this.physics.isDisposed)
      for (const entry of this.entries.values()) {
        if (entry.collider) this.detach(entry.collider);
        for (const piece of entry.pieces) if (piece.collider) this.detach(piece.collider);
      }
    this.entries.clear();
    this.work.clear();
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
    const world = this.world;
    for (const entry of this.entries.values()) {
      const near = this.near.get(entry.key);
      if (!near || world.getChunk(entry.cx, entry.cy, entry.cz) !== entry.chunk) {
        this.remove(entry); // out of range, unloaded or replaced (a needed replacement is queued below)
        continue;
      }
      // A mesh while a ball body is within radius (so a ball never meets a voxel collider), voxels again once none
      // is within radius + 1.
      const mesh = near.b <= r || (entry.mode !== VOXELS && near.b <= r + 1);
      if (mesh !== (entry.mode !== VOXELS)) this.setMode(entry, mesh);
    }
    for (const near of this.needed) {
      if (this.entries.has(near.key)) continue;
      const { cx, cy, cz, key } = near,
        chunk = world.getChunk(cx, cy, cz);
      if (!chunk) continue;
      const entry: Entry = {
        cx,
        cy,
        cz,
        key,
        chunk,
        collider: null,
        rebuild: true,
        mode: VOXELS,
        pieces: [],
        faces: null,
        scanned: false,
        stale: 0,
      };
      this.entries.set(key, entry);
      this.work.add(entry);
      if (near.b <= r) this.setMode(entry, true);
    }
    // Rebuild a collider with stale borders once the chunk beside that border is needed again (combining only adds
    // neighbour flags; it cannot clear the old ones, and a mesh lacks the faces the old neighbour hid). Until then
    // no body is within a chunk of that border.
    for (const entry of this.entries.values())
      for (let d = 0; entry.stale && !entry.rebuild && d < 6; d++)
        if (entry.stale & (1 << d) && (this.near.get(neighbour(entry, d))?.d ?? r + 1) <= r) {
          entry.rebuild = true;
          this.work.add(entry);
        }
    if (this.work.size) this.build();
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
  // Runs the pending work: everything a body can reach before the next step, then the rest within the budget.
  private build(): void {
    const start = performance.now();
    this.reach();
    let urgent = false;
    for (const entry of this.work) {
      if (entry.rebuild) this.unit(0, entry); // voxel colliders are built in the step that needs them
      if (this.reaches(entry, WHOLE, false)) {
        // A ball about to touch a chunk that is not a mesh yet: switch now (pieces near bodies are built below).
        if (entry.mode !== MESH && this.reaches(entry, WHOLE, true)) {
          if (entry.mode === VOXELS) this.setMode(entry, true);
          this.activate(entry);
        }
        if (entry.mode === MESH)
          for (let i = 0; i < entry.pieces.length; i++)
            if (entry.pieces[i].dirty && this.reaches(entry, entry.pieces[i].box, false)) {
              if (!entry.scanned) this.unit(1, entry);
              if (this.unit(2, entry, i)) i--; // split: look at the first half again
              urgent = true;
            }
      }
      this.settle(entry);
    }
    if (!this.work.size || (urgent && performance.now() - start >= this.limit)) return;
    const order = Array.from(this.work).sort((a, b) => this.distance(a) - this.distance(b));
    let ran = urgent;
    for (const entry of order) {
      for (;;) {
        const i = entry.rebuild ? -1 : entry.pieces.findIndex((piece) => piece.dirty);
        if (!entry.rebuild && i < 0) break;
        const kind = entry.rebuild ? 0 : entry.scanned ? 2 : 1;
        if (ran && performance.now() - start + this.cost[kind] > this.limit) return;
        this.unit(kind, entry, i);
        ran = true;
      }
      this.settle(entry);
    }
  }
  // One unit of work, timed: 0 builds the voxel collider, 1 scans the faces for the pieces, 2 builds piece i.
  // Returns true when the piece was over the triangle cap and split instead.
  private unit(kind: number, entry: Entry, i = 0): boolean {
    const start = performance.now();
    let split = false;
    if (kind === 0) this.voxels(entry);
    else if (kind === 1) {
      this.scan(entry, (entry.faces ??= new Uint8Array(32768)));
      entry.scanned = true;
    } else split = this.piece(entry, i);
    this.cost[kind] = Math.max(performance.now() - start, this.cost[kind] * 0.98);
    return split;
  }
  // Leaves the work set once nothing is pending; a building chunk becomes a mesh then.
  private settle(entry: Entry): void {
    if (entry.rebuild || entry.pieces.some((piece) => piece.dirty)) return;
    if (entry.mode === BUILDING) this.activate(entry);
    entry.faces = null;
    this.work.delete(entry);
  }
  // The chunk's distance in chunks to the nearest body: the order of budgeted work.
  private distance(entry: Entry): number {
    return this.near.get(entry.key)?.d ?? Infinity;
  }
  // Whether a body (a ball body) can touch the chunk-local box of `entry` before the next step.
  private reaches(entry: Entry, box: readonly number[], balls: boolean): boolean {
    const s = this.spheres,
      x0 = entry.cx * 32 + box[0],
      y0 = entry.cy * 32 + box[1],
      z0 = entry.cz * 32 + box[2],
      x1 = entry.cx * 32 + box[3],
      y1 = entry.cy * 32 + box[4],
      z1 = entry.cz * 32 + box[5];
    for (let i = 0; i < s.length; i += 5) {
      if (balls && !s[i + 4]) continue;
      const dx = Math.max(x0 - s[i], 0, s[i] - x1),
        dy = Math.max(y0 - s[i + 1], 0, s[i + 1] - y1),
        dz = Math.max(z0 - s[i + 2], 0, s[i + 2] - z1);
      if (dx * dx + dy * dy + dz * dz <= s[i + 3] * s[i + 3]) return true;
    }
    return false;
  }
  // Gathers a bounding sphere per non-fixed body, grown by two steps of its velocity and MARGIN.
  private reach(): void {
    const out = this.spheres,
      S = this.rapier.ShapeType,
      v = this.vector,
      travel = 2 * this.physics.fixedTimestep;
    out.length = 0;
    this.raw.forEachRigidBody((body) => {
      if (body.isFixed()) return;
      const t = body.translation(),
        l = body.linvel();
      let extent = 0,
        ball = 0;
      for (let i = body.numColliders(); i-- > 0; ) {
        const c = body.collider(i),
          type = c.shapeType();
        let size = 32; // another shape: assume a chunk, so everything around it is built at once
        if (type === S.Ball) {
          size = c.radius();
          ball = 1;
        } else if (type === S.Capsule) size = c.halfHeight() + c.radius();
        else if (type === S.Cylinder || type === S.Cone) size = Math.hypot(c.halfHeight(), c.radius());
        else if (type === S.RoundCylinder || type === S.RoundCone)
          size = Math.hypot(c.halfHeight(), c.radius()) + c.roundRadius();
        else if (type === S.Cuboid || type === S.RoundCuboid) {
          const h = c.halfExtents(v);
          if (h) size = Math.hypot(h.x, h.y, h.z) + (type === S.RoundCuboid ? c.roundRadius() : 0);
        }
        const p = c.translationWrtParent(v);
        extent = Math.max(extent, size + (p ? Math.hypot(p.x, p.y, p.z) : 0));
      }
      out.push(t.x, t.y, t.z, extent + travel * Math.hypot(l.x, l.y, l.z) + MARGIN, ball);
    });
  }
  // Starts (mesh) or ends the triangle mesh of a chunk; the voxel collider is disabled exactly in MESH mode.
  private setMode(entry: Entry, mesh: boolean): void {
    if (mesh) {
      entry.mode = BUILDING;
      entry.pieces = [{ box: WHOLE, collider: null, dirty: true }];
      entry.scanned = false;
      this.work.add(entry);
      return;
    }
    for (const piece of entry.pieces) if (piece.collider) this.detach(piece.collider);
    entry.pieces = [];
    entry.faces = null;
    entry.collider?.setEnabled(true);
    entry.mode = VOXELS;
    if (!entry.rebuild) this.work.delete(entry);
  }
  // MESH mode: the pieces built so far take over from the voxel collider.
  private activate(entry: Entry): void {
    entry.mode = MESH;
    entry.collider?.setEnabled(false);
    for (const piece of entry.pieces) piece.collider?.setEnabled(true);
  }
  // Adds a parentless collider (enabled or not).
  private attach(desc: unknown, enabled: boolean): Collider {
    const collider = this.raw.createCollider(desc);
    if (!enabled) collider.setEnabled(false);
    return collider;
  }
  private detach(collider: Collider): void {
    this.raw.removeCollider(collider, true);
  }
  private remove(entry: Entry): void {
    if (entry.collider) {
      this.detach(entry.collider);
      for (let d = 0; d < 6; d++) {
        const other = this.entries.get(neighbour(entry, d));
        if (other) other.stale |= 1 << (d ^ 1);
      }
    }
    for (const piece of entry.pieces) if (piece.collider) this.detach(piece.collider);
    this.entries.delete(entry.key);
    this.work.delete(entry);
  }
  // Solid flag per block id, refreshed when the world's block types grow.
  private solidIds(): Uint8Array {
    const table = this.world.blocks.table;
    if (this.solid.length !== table.length) this.solid = Uint8Array.from(table, (type) => +type.solid);
    return this.solid;
  }
  // Fills `faces` with the open faces (bit d: that neighbour is not solid) of each solid cell; returns how many have any.
  private scan(e: Place, faces: Uint8Array): number {
    const { palette, bits, words } = e.chunk.pack(),
      ids = this.solidIds(),
      mask = this.mask;
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
  // (Re)builds the voxel collider holding the chunk's surface cells, in world cell coordinates, and couples it.
  private voxels(entry: Entry): void {
    const keep = entry.mode !== VOXELS,
      faces = keep ? (entry.faces ??= new Uint8Array(32768)) : this.faces,
      cells = this.cells;
    let n = 0;
    if (this.scan(entry, faces))
      for (let i = 0; i < 32768; i++)
        if (faces[i]) {
          cells[n++] = entry.cx * 32 + (i & 31);
          cells[n++] = entry.cy * 32 + (i >> 10);
          cells[n++] = entry.cz * 32 + ((i >> 5) & 31);
        }
    if (keep) entry.scanned = true;
    const collider = this.attach(
      this.rapier.ColliderDesc.voxels!(cells.subarray(0, n), ONE),
      entry.mode !== MESH,
    ) as VoxelCollider;
    if (entry.collider) this.detach(entry.collider);
    entry.collider = collider;
    entry.rebuild = false;
    // A border whose old neighbour came back: the pieces along it lack the faces that neighbour hid.
    for (let d = 0; entry.stale && d < 6; d++)
      if (entry.stale & (1 << d))
        for (const piece of entry.pieces)
          if (d & 1 ? piece.box[d >> 1] === 0 : piece.box[(d >> 1) + 3] === 32) piece.dirty = true;
    entry.stale = 0;
    // Couple with the face neighbours built so far (voxel states only track the faces); later ones couple with it.
    for (let d = 0; d < 6; d++) {
      const other = this.entries.get(neighbour(entry, d))?.collider;
      if (other) collider.combineVoxelStates(other, 0, 0, 0);
    }
  }
  // Builds piece i of the chunk's mesh from its faces (enabled in MESH mode), replacing its previous mesh; over the
  // triangle cap it splits the piece in two along its longest axis instead (y first: horizontal cuts keep floors,
  // where balls roll, in one piece more often) and returns true.
  private piece(entry: Entry, i: number): boolean {
    const piece = entry.pieces[i],
      triangles = this.triangles(entry, piece.box);
    if (piece.collider && triangles < 0) this.detach(piece.collider);
    if (triangles < 0) {
      const box = piece.box,
        size = [box[3] - box[0], box[4] - box[1], box[5] - box[2]],
        axis = size[1] >= size[0] && size[1] >= size[2] ? 1 : size[0] >= size[2] ? 0 : 2,
        mid = box[axis] + (size[axis] >> 1),
        low = box.slice(),
        high = box.slice();
      low[axis + 3] = mid;
      high[axis] = mid;
      entry.pieces[i] = { box: low, collider: null, dirty: true };
      entry.pieces.push({ box: high, collider: null, dirty: true });
      return true;
    }
    const R = this.rapier,
      collider = triangles
        ? this.attach(
            R.ColliderDesc.trimesh(
              this.vertices.subarray(0, triangles * 6),
              this.indices.subarray(0, triangles * 3),
              R.TriMeshFlags?.FIX_INTERNAL_EDGES,
            ),
            entry.mode === MESH,
          )
        : null;
    if (piece.collider) this.detach(piece.collider);
    piece.collider = collider;
    piece.dirty = false;
    return false;
  }
  // Fills `vertices` and `indices` with the open faces in the chunk-local box, merged into rectangles per face
  // direction and cell layer, with outward winding; returns the triangle count, or -1 past PIECE triangles.
  private triangles(e: Entry, box: readonly number[]): number {
    const faces = e.faces!,
      plane = this.plane,
      vertices = this.vertices,
      indices = this.indices,
      origin = [e.cx * 32, e.cy * 32, e.cz * 32],
      corner = [0, 0, 0];
    let rects = 0;
    for (let d = 0; d < 6; d++) {
      const u = d >> 1,
        v = (u + 1) % 3,
        w = (u + 2) % 3,
        bit = 1 << d,
        positive = !(d & 1),
        a0 = box[v],
        a9 = box[v + 3],
        b0 = box[w],
        b9 = box[w + 3];
      for (let k = box[u]; k < box[u + 3]; k++) {
        for (let a = a0; a < a9; a++)
          for (let b = b0; b < b9; b++)
            plane[a | (b << 5)] = faces[k * STRIDE[u] + a * STRIDE[v] + b * STRIDE[w]] & bit;
        for (let b = b0; b < b9; b++)
          for (let a = a0; a < a9; a++) {
            if (!plane[a | (b << 5)]) continue;
            if (rects === PIECE / 2) return -1;
            let a1 = a + 1,
              b1 = b + 1;
            while (a1 < a9 && plane[a1 | (b << 5)]) a1++;
            grow: while (b1 < b9) {
              for (let t = a; t < a1; t++) if (!plane[t | (b1 << 5)]) break grow;
              b1++;
            }
            for (let s = b; s < b1; s++) for (let t = a; t < a1; t++) plane[t | (s << 5)] = 0;
            // Corners counter-clockwise seen from outside: v then w spans +u, so a negative face goes w then v.
            const base = rects * 4;
            corner[u] = origin[u] + k + (positive ? 1 : 0);
            for (let c = 0; c < 4; c++) {
              // Positive: (a, b) (a1, b) (a1, b1) (a, b1); negative: (a, b) (a, b1) (a1, b1) (a1, b).
              const far = c === 1 || c === 2,
                side = c >= 2;
              corner[v] = origin[v] + ((positive ? far : side) ? a1 : a);
              corner[w] = origin[w] + ((positive ? side : far) ? b1 : b);
              vertices[(base + c) * 3] = corner[0];
              vertices[(base + c) * 3 + 1] = corner[1];
              vertices[(base + c) * 3 + 2] = corner[2];
            }
            const at = rects * 6;
            indices[at] = indices[at + 3] = base;
            indices[at + 1] = base + 1;
            indices[at + 2] = indices[at + 4] = base + 2;
            indices[at + 5] = base + 3;
            rects++;
          }
      }
    }
    return rects * 2;
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
  // VoxelWorld.onChange: solidity flips become setVoxel calls and dirty mesh pieces; a removed cell exposes its solid
  // neighbours, and any flip changes their open faces.
  private readonly edit = (x: number, y: number, z: number, state: number, previous: number): void => {
    if (this.physics.isDisposed) return this.dispose();
    const ids = this.solidIds(),
      solid = ids[state & 0xffff];
    if (solid === ids[previous & 0xffff]) return;
    this.set(x, y, z, !!solid);
    this.touch(x, y, z);
    for (let d = 0; d < 6; d++) {
      const nx = x + DX[d],
        ny = y + DY[d],
        nz = z + DZ[d];
      if ((nx | 0) !== nx || (nz | 0) !== nz || !ids[this.world.getBlock(nx, ny, nz) & 0xffff]) continue;
      if (!solid) this.set(nx, ny, nz, true);
      this.touch(nx, ny, nz);
    }
  };
  private set(x: number, y: number, z: number, filled: boolean): void {
    const cx = x >> 5,
      cy = y >> 5,
      cz = z >> 5,
      entry = this.entries.get(chunkKey(cx, cy, cz));
    if (!entry?.collider) return; // a pending build reads the world when it runs
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
    const other = this.entries.get(chunkKey(cx, cy, cz))?.collider;
    if (other) entry.collider!.propagateVoxelChange(other, x, y, z, 0, 0, 0);
  }
  // The mesh piece holding cell (x, y, z) rebuilds, after a rescan of its chunk.
  private touch(x: number, y: number, z: number): void {
    const entry = this.entries.get(chunkKey(x >> 5, y >> 5, z >> 5));
    if (!entry?.pieces.length) return;
    const lx = x & 31,
      ly = y & 31,
      lz = z & 31;
    entry.scanned = false;
    for (const piece of entry.pieces) {
      const box = piece.box;
      if (lx >= box[0] && ly >= box[1] && lz >= box[2] && lx < box[3] && ly < box[4] && lz < box[5]) {
        piece.dirty = true;
        break;
      }
    }
    this.work.add(entry);
  }
}
