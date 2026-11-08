// The Rust kernel from JavaScript: loads the blueprint and reads the world's columns through typed-array views.
import { MargoError } from '@margoengine/math/errors';
import { LoadOnce } from '../../shared/load-once.js';
import type { Quat, Vec3 } from './math.js';
import { kernelColumns, wasmBase64 } from './wasm.js';

interface KernelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  world_new(bodies: number, colliders: number): number;
  world_base(): number;
  world_bytes(): number;
  world_capacity(rows: number): number;
  world_offset(column: number): number;
  world_columns(): number;
  world_reserve(bodies: number, colliders: number): number;
  world_hash(): number;
  world_set_gravity(x: number, y: number, z: number): void;
  world_gravity(axis: number): number;
  world_set_substeps(substeps: number): void;
  world_substeps(): number;
  world_set_iterations(iterations: number): void;
  world_iterations(): number;
  world_steps(): number;
  world_step(dt: number): number;
  world_lost(): number;
  world_layout(): number;
  world_pairs(): number;
  world_pair_rows(): number;
  world_solving(): number;
  world_events(): number;
  world_clear_events(): void;
  world_set_filtering(on: number): void;
  collider_set_state(collider: number, state: number): void;
  collider_touch(collider: number): void;
  body_set_enabled(body: number, enabled: number): void;
  body_touch(body: number): void;
  world_awake(): number;
  world_islands(): number;
  world_set_sleep(energy: number, time: number): void;
  world_sleep_energy(): number;
  world_sleep_time(): number;
  body_wake(body: number): void;
  body_wake_touching(body: number): void;
  body_sleep(body: number): void;
  world_ensure(bytes: number): number;
  body_set_pose(
    body: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    wake: number,
  ): void;
  body_set_target(body: number, x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): void;
  body_add(kind: number): number;
  body_remove(body: number): number;
  body_update_mass(body: number): void;
  body_set_kind(body: number, kind: number, wake: number): void;
  body_set_own(
    body: number,
    mass: number,
    x: number,
    y: number,
    z: number,
    ix: number,
    iy: number,
    iz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): void;
  collider_add(
    body: number,
    shape: number,
    a: number,
    b: number,
    c: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
    density: number,
  ): number;
  collider_add_part(
    compound: number,
    shape: number,
    a: number,
    b: number,
    c: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): number;
  collider_remove(collider: number): number;
  joint_add(a: number, b: number, flags: number): number;
  joint_remove(joint: number): number;
  joint_set_axis(joint: number, x: number, y: number, z: number): void;
  joint_set_frames(
    joint: number,
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number,
  ): void;
  hull_begin(vertices: number, faces: number, edges: number): number;
  hull_end(vertices: number, faces: number, edges: number): number;
  hull_next(rows: number): number;
  mesh_begin(vertices: number, triangles: number): number;
  mesh_end(vertices: number, triangles: number, flags: number): number;
  mesh_end_grid(rows: number, columns: number, flags: number): number;
  mesh_next(rows: number): number;
  voxels_begin(cells: number): number;
  voxels_end(x: number, y: number, z: number, dx: number, dy: number, dz: number, sx: number, sy: number, sz: number): number;
  voxels_set(collider: number, x: number, y: number, z: number, filled: number): number;
  voxels_combine(a: number, b: number, sx: number, sy: number, sz: number): number;
  voxels_propagate(a: number, b: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): number;
  query_buffer(): number;
  query_ray(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, solid: number, flags: number, groups: number, collider: number, body: number): number;
  query_ray_all(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, max: number, solid: number, flags: number, groups: number, collider: number, body: number, skip: number): number;
  query_shape_cast(...words: number[]): number;
  query_shape_cast_all(...words: number[]): number;
  query_project_point(x: number, y: number, z: number, solid: number, flags: number, groups: number, collider: number, body: number): number;
  query_project_point_all(x: number, y: number, z: number, solid: number, flags: number, groups: number, collider: number, body: number, skip: number): number;
  query_point_all(x: number, y: number, z: number, flags: number, groups: number, collider: number, body: number, skip: number): number;
  query_shape_all(...words: number[]): number;
  hull_count(): number;
  mesh_count(): number;
}

/** Bits of the `jointFlags` column, each shifted by the axis it is for: 0 to 2 along frame A, 3 to 5 about it. */
export const JOINT_LOCK = 1;
export const JOINT_LIMIT = 1 << 6;
export const JOINT_MOTOR_ON = 1 << 12;
export const JOINT_MOTOR_FORCE = 1 << 18;
/** Not shifted: the two bodies may collide with each other. */
export const JOINT_CONTACTS = 1 << 25;
export const JOINT_CONE = 1 << 26;
export const JOINT_DISTANCE = 1 << 27;
/** Bits of the `colliderFlags` column. */
export const COLLIDER_SENSOR = 1;
export const COLLIDER_OFF = 2;
/** Bit of the `flags` column: the body is out of the world. */
export const BODY_DISABLED = 1 << 11;
/** Bits of the `flags` column: continuous collision on, and whether the last step's CCD pass checked the body. */
export const BODY_CCD = 1 << 13,
  BODY_CCD_ACTIVE = 1 << 14;
/** An event's first word: the first collider's row under this mask, the sensor bit, and the top bit when it started. */
export const EVENT_COLLIDER = (1 << 30) - 1;
export const EVENT_SENSOR = 1 << 30;
/** Bit of the `pairFlags` column: a part of a mesh pair, one triangle's manifold. */
export const PAIR_IS_PART = 16;

/** How a body moves: `dynamic` by forces, `kinematicPosition` to a target, `kinematicVelocity` at its velocity. */
export type KernelBodyKind = 'fixed' | 'dynamic' | 'kinematicPosition' | 'kinematicVelocity';

/**
 * Shapes the kernel holds today. Sizes: a ball's radius; a box's half extents; a capsule's radius and half core length; a
 * hull's row from {@link KernelWorld.addHull}; a mesh's row from {@link KernelWorld.addTrimesh} or
 * {@link KernelWorld.addHeightfield}.
 */
export type KernelShape = 'ball' | 'box' | 'capsule' | 'hull' | 'trimesh';

/** One convex child of {@link KernelWorld.addCompound}: a shape and size as {@link KernelWorld.addCollider} takes them. */
export interface KernelCompoundPart {
  shape: 'ball' | 'box' | 'capsule' | 'hull';
  size: readonly number[];
  /** Place in the compound's frame (default its origin). */
  position?: readonly [number, number, number];
  /** Unit quaternion, x, y, z, w, in the compound's frame (default none). */
  rotation?: readonly [number, number, number, number];
}

/** How many numbers each shape's size takes, and its value in the `colliderShape` column. */
const shapes: Readonly<Record<KernelShape, readonly [number, number]>> = {
  ball: [0, 1],
  box: [1, 3],
  capsule: [2, 2],
  hull: [3, 1],
  trimesh: [4, 1],
};
/** The `colliderShape` value of a compound (layout.rs SHAPE_COMPOUND). */
export const SHAPE_COMPOUND = 5;

/** What each refusal of `mesh_end` means, with the fix. */
const meshErrors: Readonly<Record<number, string>> = {
  [-1]: 'A triangle mesh needs at least 3 vertices and one triangle',
  [-2]: 'A triangle names a vertex that does not exist; check the indices',
  [-3]: 'A vertex is not finite; check what fed it',
  [-4]: 'The triangle found across an edge does not exist',
  [-5]: 'The heights do not make a grid the kernel can hold; pass a scale whose cells are wider than rounding, and fewer cells',
};

/** Options of {@link KernelWorld.addTrimesh}. */
export interface KernelTrimeshOptions {
  /**
   * Keeps contacts on a triangle's inner edges to the normals the surface allows, so shapes slide over the seams between
   * triangles without catching (Rapier's `TriMeshFlags.FIX_INTERNAL_EDGES`). Default false, as in Rapier.
   */
  fixInternalEdges?: boolean;
}

/** Options of {@link KernelWorld.addHeightfield}. */
export interface KernelHeightfieldOptions {
  /**
   * Keeps contacts on the grid's inner edges to the normals the surface allows, as for a trimesh (Rapier's
   * `HeightFieldFlags.FIX_INTERNAL_EDGES`). Default false, as in Rapier.
   */
  fixInternalEdges?: boolean;
}

/**
 * The triangle across each edge of each triangle (edge k runs from corner k to corner k + 1), or -1 for an open edge. Edges
 * meet by corner position, so a mesh split at texture seams still joins; an edge three or more triangles share is open.
 */
export function trianglesAcross(vertices: ArrayLike<number>, indices: ArrayLike<number>): Int32Array {
  const count = indices.length / 3,
    out = new Int32Array(indices.length).fill(-1),
    bits = new Float32Array(3),
    words = new Uint32Array(bits.buffer),
    places = new Map<string, number>(),
    weld = new Int32Array(vertices.length / 3).fill(-1);
  // Each corner by its place: one name per distinct position, so edges compare as two small numbers.
  const place = (index: number): number => {
    let p = weld[index];
    if (p < 0) {
      bits[0] = vertices[3 * index];
      bits[1] = vertices[3 * index + 1];
      bits[2] = vertices[3 * index + 2];
      const key = `${words[0]},${words[1]},${words[2]}`;
      p = places.get(key) ?? places.size;
      places.set(key, p);
      weld[index] = p;
    }
    return p;
  };
  for (let i = 0; i < weld.length; i++) place(i);
  const span = places.size,
    seen = new Map<number, number>(),
    shared: number[] = [];
  const edge = (t: number, k: number): number => {
    const a = weld[indices[3 * t + k]],
      b = weld[indices[3 * t + ((k + 1) % 3)]];
    return a === b ? -1 : a < b ? a * span + b : b * span + a;
  };
  for (let t = 0; t < count; t++)
    for (let k = 0; k < 3; k++) {
      const key = edge(t, k);
      if (key < 0) continue;
      const other = seen.get(key);
      if (other === undefined) seen.set(key, 3 * t + k);
      else if (other >= 0) {
        out[3 * t + k] = (other / 3) | 0;
        out[other] = t;
        seen.set(key, -1);
      } else if (other === -1) {
        // A third triangle on one edge: no side is the surface's, so the edge is open for all of them.
        seen.set(key, -2);
        shared.push(key);
      }
    }
  if (shared.length)
    for (let t = 0; t < count; t++)
      for (let k = 0; k < 3; k++) {
        const key = edge(t, k);
        if (key >= 0 && seen.get(key) === -2) out[3 * t + k] = -1;
      }
  return out;
}

/** What each refusal of `hull_end` means, with the fix. */
const hullErrors: Readonly<Record<number, string>> = {
  [-1]: 'A hull needs at least 4 vertices and 4 faces; memory may also be out',
  [-2]: 'A face names a vertex that does not exist, or has under 3 vertices; check the indices',
  [-3]: 'A face is not flat; split it or move its vertices onto one plane',
  [-4]: 'The faces do not close into one surface; each edge must join exactly two faces, running opposite ways',
  [-5]: 'The shape is not convex, or a face runs clockwise from outside; turn the face or build the convex hull',
  [-6]: 'Two neighbouring faces lie in one plane; merge them, as contact clipping sees only one face at a time, or build it with convexHull',
  [-7]: 'A face has over 256 edges; pass fewer points around it',
};

/** A point of a manifold. */
export interface KernelContactPoint {
  /** Midway between the two surfaces when the point was found, in world space. */
  position: [number, number, number];
  /** The gap along the normal in metres, negative when the shapes overlap. */
  separation: number;
  /** Names the features that made the point, and stays the same while they do. */
  id: number;
  /** What the solver pushed with along the normal in the last substep, in newton seconds. */
  normalImpulse: number;
}

/** The manifold of one pair of colliders. */
export interface KernelContact {
  colliderA: number;
  colliderB: number;
  /** Unit vector from A to B, shared by every point. */
  normal: [number, number, number];
  points: KernelContactPoint[];
}

/** A ray's hit: the collider row, the distance along the ray's unit direction, the surface normal (zero for a start
 * inside a solid shape) and the point, all world space. */
export interface KernelRayHit {
  collider: number;
  distance: number;
  normal: [number, number, number];
  point: [number, number, number];
}
/** Filter bits of the kernel's queries (`KernelWorld.raycast`), as Rapier's `QueryFilterFlags`. */
export const QUERY_EXCLUDE_FIXED = 1,
  QUERY_EXCLUDE_KINEMATIC = 2,
  QUERY_EXCLUDE_DYNAMIC = 4,
  QUERY_EXCLUDE_SENSORS = 8,
  QUERY_EXCLUDE_SOLIDS = 16,
  QUERY_ONLY_DYNAMIC = 32,
  QUERY_ONLY_KINEMATIC = 64,
  QUERY_ONLY_FIXED = 128;
/** Hits the kernel's query buffer holds at once; `raycastAll` pages through more. */
const QUERY_HITS = 256;
/** A query shape of {@link KernelWorld.shapeCast} and {@link KernelWorld.intersectShape}: a convex kernel shape and its
 * `addCollider` size (a hull names its `addHull` row). */
export interface KernelQueryShape {
  shape: 'ball' | 'box' | 'capsule' | 'hull';
  size: readonly number[];
}
/** How far a cast goes, how far short of touching it stops, and what a start in contact means (Rapier's `ShapeCastOptions`). */
export interface KernelCastOptions {
  max: number;
  target: number;
  /** A start in contact is a hit even when the cast leads out of it. */
  stop: boolean;
  /** A start in contact gets its normal and points. */
  geometry: boolean;
}
/** A shape cast's first touch, world space: the collider row, the distance along the direction's unit, the point and
 * outward normal on the collider, the point and normal on the cast shape, and whether it touched at the start. */
export interface KernelShapeCastHit {
  collider: number;
  distance: number;
  point: [number, number, number];
  normal: [number, number, number];
  queryPoint: [number, number, number];
  queryNormal: [number, number, number];
  started: boolean;
}
/** A collider's point nearest a query point (inside a solid shape the point itself), and how far it is. */
export interface KernelProjection {
  collider: number;
  inside: boolean;
  point: [number, number, number];
  distance: number;
}
const QUERY_KINDS = { ball: 0, box: 1, capsule: 2, hull: 3 } as const;
const castBits = (cast: KernelCastOptions): number => (cast.stop ? 1 : 0) | (cast.geometry ? 2 : 0);
const CAST_REFUSED =
    'A shape query needs a finite position, a nonzero rotation, a finite nonzero direction, a target distance of 0 or more and a ball, box, capsule or hull row; pass those.',
  POINT_REFUSED = 'A point query needs a finite point; pass three finite numbers.';

/** How two colliders mix a value. When their rules differ the pair takes the higher: max, multiply, min, average. */
export type KernelCombine = 'average' | 'min' | 'multiply' | 'max';
const combines: readonly KernelCombine[] = ['average', 'min', 'multiply', 'max'];

/** Options of {@link KernelWorld.addCollider}. */
export interface KernelColliderOptions {
  /** Place in the body's frame (default the origin). */
  position?: readonly [number, number, number];
  /** Unit quaternion, x, y, z, w, in the body's frame (default none). */
  rotation?: readonly [number, number, number, number];
  /** In kg/m^3 (default 1000, water). 0 adds no mass. */
  density?: number;
  /** Coulomb friction, 0 or more: a block slides above the slope whose tangent this is (default 0.5). */
  friction?: number;
  /** Share of its approach speed a contact gives back, 0 to 1 (default 0). */
  restitution?: number;
  /** How a pair mixes its two frictions (default 'average'). */
  frictionCombine?: KernelCombine;
  /** How a pair mixes its two restitutions (default 'average'). */
  restitutionCombine?: KernelCombine;
}

/** Bits of the `flags` column (kernel/src/layout.rs). */
const ALIVE = 1,
  SLEEPING = 1 << 9,
  CAN_SLEEP = 1 << 10,
  RESTING = 1 << 12;

/** The kind bits of the `flags` column (kernel/src/layout.rs). */
const bodyKinds: Readonly<Record<KernelBodyKind, number>> = {
  fixed: 0,
  dynamic: 2,
  kinematicPosition: 4,
  kinematicVelocity: 6,
};

const compiled = new LoadOnce<WebAssembly.Module>(async () => {
  const bytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
  return WebAssembly.compile(
    await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer(),
  );
});

/** Options of {@link loadKernel}. */
export interface KernelLoadOptions {
  /** Stops waiting for the load; the load itself carries on and a later call reuses it. */
  signal?: AbortSignal;
}

/**
 * Compiles the kernel, once per app: compiling is asynchronous, so `new KernelWorld()` can stay synchronous.
 * @throws AbortError (the signal's reason) when `signal` aborts first.
 */
export async function loadKernel({ signal }: KernelLoadOptions = {}): Promise<void> {
  await compiled.load(signal);
}

/** A column view: float columns are `Float32Array`, integer columns `Uint32Array`. One row per body or collider. */
export type KernelColumn = Float32Array | Uint32Array;

/**
 * One simulated world in its own Wasm instance. Column views alias the kernel's memory: reading a pose is a typed-array
 * read, with no call and no copy. Growth, which a step can cause, replaces every view, so read them from `columns` each
 * time and never keep one.
 * Everything a step can change lives in one block, so {@link KernelWorld.snapshot} is one copy.
 */
export class KernelWorld {
  /** Every column by name, for example `columns.positionX[body]`. */
  readonly columns: Record<string, KernelColumn> = {};
  private readonly api: KernelExports;
  private layout = -1;
  private stepping = false;
  private filter: ((a: number, b: number) => boolean) | null = null;
  private hullRows = 0;
  private meshRows = 0;
  /** Sleepers whose kind changed: they wake before the next step, as Rapier's do. */
  private wakeAtStep: number[] = [];

  /**
   * @param bodies Body rows to start with (default 1024); `reserve` adds more.
   * @param colliders Collider rows to start with (default as many as bodies).
   * @throws MargoError (`state`) before {@link loadKernel} has finished.
   * @throws RangeError for a capacity the kernel refuses.
   */
  constructor(bodies = 1024, colliders = bodies) {
    const module = compiled.value;
    if (!module) throw new MargoError('state', 'The physics kernel is not loaded; call await loadKernel() first.');
    this.api = new WebAssembly.Instance(module, { env: { contact_filter: (a: number, b: number) => this.ask(a, b) } }).exports as KernelExports;
    if (!Number.isSafeInteger(bodies) || !Number.isSafeInteger(colliders) || !this.api.world_new(bodies, colliders))
      throw new RangeError(
        `Bodies and colliders must be integers from 1 to 4194304; use a smaller world (got ${bodies}, ${colliders}).`,
      );
    this.bind();
  }

  /** The step asks about a pair. Finding pairs can have grown the world, and a filter may read the columns. */
  private ask(a: number, b: number): number {
    if (this.api.world_layout() !== this.layout) this.bind();
    return this.filter!(a, b) ? 1 : 0;
  }

  private bind(): void {
    const { api } = this,
      { buffer } = api.memory,
      base = api.world_base();
    this.layout = api.world_layout();
    kernelColumns.forEach(([name, kind, rows], column) => {
      const at = base + (api.world_offset(column) >>> 0),
        length = api.world_capacity(rows);
      this.columns[name] = kind === 'f' ? new Float32Array(buffer, at, length) : new Uint32Array(buffer, at, length);
    });
  }

  /** Rows of body columns. */
  get capacity(): number {
    return this.api.world_capacity(0);
  }
  /** Rows of collider columns. */
  get colliderCapacity(): number {
    return this.api.world_capacity(1);
  }
  /** Pairs of colliders whose fat boxes overlap, after the last step. */
  get pairCount(): number {
    return this.api.world_pairs();
  }
  /**
   * Every pair as two collider rows, the lower first, after the last step. A pair is near, not yet touching: a fat box
   * holds what the coming step can reach, plus a margin. Colliders of one body and of two fixed bodies are no pair.
   */
  pairs(): [number, number][] {
    const { pairA, pairB } = this.columns,
      rows = this.api.world_pair_rows(),
      out: [number, number][] = [];
    const { pairFlags } = this.columns;
    for (let row = 0; row < rows; row++)
      if (pairA[row] !== 0xffffffff && !(pairFlags[row] & PAIR_IS_PART)) out.push([pairA[row], pairB[row]]);
    return out;
  }
  /**
   * The first pair on a collider's list, or 0xffffffff when it has none; {@link KernelWorld.nextPair} gives the next. The
   * walk reads only the rows of that collider's pairs, near and touching alike, so a query about one body costs its own
   * pairs and not the world's.
   */
  firstPair(collider: number): number {
    return this.columns.colliderPairs[collider];
  }
  /** The pair after `row` on `collider`'s list, or 0xffffffff at its end. */
  nextPair(row: number, collider: number): number {
    const c = this.columns;
    return c.pairA[row] === collider ? c.pairNextA[row] : c.pairNextB[row];
  }
  /**
   * Every pair with contact points, after the last step. A point may lie a little apart: anything the step could reach
   * counts, so its `separation` can be above zero. A mesh pair gives one entry for each triangle it touches, each with
   * its own normal.
   */
  contacts(): KernelContact[] {
    const c = this.columns,
      rows = this.api.world_pair_rows(),
      out: KernelContact[] = [];
    for (let row = 0; row < rows; row++) {
      const count = c.pairContacts[row];
      if (c.pairA[row] === 0xffffffff || count === 0) continue;
      const points: KernelContactPoint[] = [];
      for (let at = row * 4; at < row * 4 + count; at++)
        points.push({
          position: [c.contactX[at], c.contactY[at], c.contactZ[at]],
          separation: c.contactSeparation[at],
          id: c.contactId[at],
          normalImpulse: c.contactNormalImpulse[at],
        });
      out.push({
        colliderA: c.pairA[row],
        colliderB: c.pairB[row],
        normal: [c.pairNormalX[row], c.pairNormalY[row], c.pairNormalZ[row]],
        points,
      });
    }
    return out;
  }
  /**
   * Decides each pair of collider rows the step looks at; false keeps them from touching, sensor pairs too. It runs inside
   * the step, so it may read the world and must not change it. Null, the default, asks nothing.
   */
  set contactFilter(filter: ((a: number, b: number) => boolean) | null) {
    this.filter = filter;
    this.api.world_set_filtering(filter ? 1 : 0);
  }
  /** Events waiting in the `events` column, two words each. Read them after a step, then call {@link KernelWorld.clearEvents}. */
  get eventCount(): number {
    return this.api.world_events();
  }
  clearEvents(): void {
    this.api.world_clear_events();
  }
  /** Sets a collider's `COLLIDER_` bits. What it touched ends, and whatever rested on it wakes. */
  setColliderState(collider: number, state: number): void {
    this.api.collider_set_state(collider, state);
  }
  /** Wakes what a collider can reach, after its groups were written. */
  touchCollider(collider: number): void {
    this.api.collider_touch(collider);
  }
  /** Takes a body out of the world or puts it back: out, it keeps its pose and speed, touches nothing and its joints rest. */
  setBodyEnabled(body: number, enabled: boolean): void {
    this.api.body_set_enabled(body, enabled ? 1 : 0);
  }
  /** Pairs the last step solved: the first this many rows of the `solvePairs` column. */
  get solvingPairs(): number {
    return this.api.world_solving();
  }
  /** Bodies a step walks: the moving ones. Sleeping and fixed bodies are on no list, so they cost a step nothing. */
  get awakeCount(): number {
    return this.api.world_awake();
  }
  /** Groups of touching bodies still awake after the last step. Fixed and kinematic bodies join none. */
  get islandCount(): number {
    return this.api.world_islands();
  }
  /** Kinetic energy per unit of mass under which a body counts as still, in J/kg (default 0.0002, a slide of 0.02 m/s). */
  get sleepEnergy(): number {
    return this.api.world_sleep_energy();
  }
  /** Seconds a body must stay still before it may sleep (default 0.5). */
  get sleepTime(): number {
    return this.api.world_sleep_time();
  }
  /**
   * Sets when bodies sleep: under `energy` J/kg for `time` seconds, with no energy gained across that time.
   * @throws RangeError unless both are finite and not negative.
   */
  setSleep(energy: number, time: number): this {
    if (!(energy >= 0) || !(time >= 0) || !Number.isFinite(energy) || !Number.isFinite(time))
      throw new RangeError(`Sleep needs a finite energy and time, not negative; the defaults are 0.0002 and 0.5 (got ${energy}, ${time}).`);
    this.api.world_set_sleep(energy, time);
    return this;
  }
  /** True when the row holds a sleeping body, or a kinematic one still for the sleep window (it reads asleep, as on Rapier). */
  isSleeping(body: number): boolean {
    const flags = this.columns.flags[body] ?? 0;
    return (flags & ALIVE) !== 0 && (flags & (SLEEPING | RESTING)) !== 0;
  }
  /**
   * Wakes a body and every body it sleeps with. Writing a sleeper's velocity or force columns does not wake it, so call
   * this first.
   */
  wake(body: number): this {
    this.api.body_wake(body);
    return this;
  }
  /** Asks a dynamic body to stop and sleep. It goes when every body it touches is ready too. */
  sleep(body: number): this {
    this.api.body_sleep(body);
    return this;
  }
  /**
   * Sets continuous collision on a body (default off), Rapier's `enableCcd`: after each step a dynamic body that moved
   * further than its thinnest piece is thick is swept from its start pose to its end pose against the colliders its path
   * box meets, and put back to its first touch, its velocity kept.
   */
  setCcd(body: number, enabled: boolean): this {
    const { flags } = this.columns;
    flags[body] = enabled ? flags[body] | BODY_CCD : flags[body] & ~BODY_CCD;
    return this;
  }
  /** True when the last step's CCD pass checked the body: CCD is on and it moved further than it is thick. */
  isCcdActive(body: number): boolean {
    return ((this.columns.flags[body] ?? 0) & BODY_CCD_ACTIVE) !== 0;
  }
  /** Sets whether a body may sleep (default true). A body that may not keeps everything it touches awake. */
  setCanSleep(body: number, canSleep: boolean): this {
    const { flags } = this.columns;
    flags[body] = canSleep ? flags[body] | CAN_SLEEP : flags[body] & ~CAN_SLEEP;
    return this;
  }
  /** Steps taken so far. */
  get steps(): number {
    return this.api.world_steps() >>> 0;
  }
  /**
   * Equal pieces each step is split into (default 8). Forces reach every piece; impulses land once, before the first.
   * @throws RangeError unless it is a whole number from 1 up.
   */
  get substeps(): number {
    return this.api.world_substeps();
  }
  set substeps(substeps: number) {
    if (!Number.isInteger(substeps) || substeps < 1 || substeps > 0xffff)
      throw new RangeError(`Substeps must be a whole number from 1 to 65535; use 8 unless you measured (got ${substeps}).`);
    this.api.world_set_substeps(substeps);
  }
  /** Solver passes in each substep (default 2). More holds a tall stack stiffer, at that much more solver time. */
  get iterations(): number {
    return this.api.world_iterations();
  }
  set iterations(iterations: number) {
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 0xffff)
      throw new RangeError(`Iterations must be a whole number from 1 to 65535; use 2 unless you measured (got ${iterations}).`);
    this.api.world_set_iterations(iterations);
  }
  /** Gravity as `[x, y, z]`, in m/s^2 (default `[0, -9.81, 0]`, read back as f32). */
  get gravity(): [number, number, number] {
    const { api } = this;
    return [api.world_gravity(0), api.world_gravity(1), api.world_gravity(2)];
  }
  /**
   * Sets gravity.
   * @throws RangeError for a value that is not finite: a NaN in the state would end bit equality.
   */
  setGravity(x: number, y: number, z: number): this {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z))
      throw new RangeError(`Gravity must be three finite numbers; check what fed it (got ${x}, ${y}, ${z}).`);
    this.api.world_set_gravity(x, y, z);
    return this;
  }
  /**
   * Adds a body and returns its row, which is its index in every column. Grows the world when the rows run out, so read
   * views from `columns` after this call. A new row is at the origin with no mass: give a dynamic body `inverseMass`.
   * @throws RangeError for an unknown kind, or when the world cannot grow.
   */
  addBody(kind: KernelBodyKind): number {
    const bits = Object.hasOwn(bodyKinds, kind) ? bodyKinds[kind] : undefined;
    if (bits === undefined)
      throw new RangeError(`Unknown body kind ${String(kind)}; use one of ${Object.keys(bodyKinds).join(', ')}.`);
    let row = this.api.body_add(bits);
    if (row < 0) {
      this.reserve(this.capacity * 2);
      row = this.api.body_add(bits);
    }
    return row;
  }
  /**
   * Removes a body and its colliders. Its row comes back from a later {@link KernelWorld.addBody}, last freed first; the
   * colliders' rows after the next step.
   * @returns false when the row holds no body.
   */
  removeBody(body: number): boolean {
    if (!(Number.isInteger(body) && body >= 0 && this.api.body_remove(body) === 1)) return false;
    // The row may hold a new body before the step: the wake was for the old one.
    if (this.wakeAtStep.length) this.wakeAtStep = this.wakeAtStep.filter((row) => row !== body);
    return true;
  }
  /**
   * Adds a collider to a body and works out the body's mass, centre and inertia again. Grows the world when the rows run
   * out, so read views from `columns` after this call.
   * @param size A ball's `[radius]`, a box's `[halfX, halfY, halfZ]`, a capsule's `[radius, halfLength]` along local Y, a
   * hull's `[row]`, a triangle mesh's `[row]` (no volume, so no mass).
   * @returns The collider's row.
   * @throws RangeError for a dead body, an unknown shape, or a size, pose or density the kernel cannot use.
   */
  addCollider(body: number, shape: KernelShape, size: readonly number[], options: KernelColliderOptions = {}): number {
    const { position = [0, 0, 0], rotation = [0, 0, 0, 1] } = options,
      spec = Object.hasOwn(shapes, shape) ? shapes[shape] : undefined,
      { flags } = this.columns;
    if (!spec) throw new RangeError(`Unknown shape ${String(shape)}; use one of ${Object.keys(shapes).join(', ')}.`);
    if (!Number.isInteger(body) || body < 0 || body >= flags.length || !(flags[body] & 1))
      throw new RangeError(`Row ${body} holds no body; use a row addBody returned.`);
    this.checkSize(shape, size);
    this.checkPose(position, rotation);
    return this.place(body, spec[0], size, options);
  }

  /**
   * Adds a compound collider: convex children welded into one collider, with one row, one pair against each other
   * collider and one set of events, as Rapier's compound shape is. Its density is every child's. The body's mass, centre and
   * inertia are worked out again, so read views from `columns` after this call.
   * @param parts At least one ball, box, capsule or hull, each placed in the compound's frame.
   * @returns The compound's row. Its children have rows of their own, off the broad phase, that nothing else names.
   * @throws RangeError for a dead body, no parts, a part the kernel cannot use, or a size, pose or density it cannot use.
   */
  addCompound(body: number, parts: readonly KernelCompoundPart[], options: KernelColliderOptions = {}): number {
    const { flags } = this.columns;
    if (!Number.isInteger(body) || body < 0 || body >= flags.length || !(flags[body] & 1))
      throw new RangeError(`Row ${body} holds no body; use a row addBody returned.`);
    if (!Array.isArray(parts) || parts.length === 0)
      throw new RangeError('A compound needs at least one part; pass [{shape: "box", size: [1, 1, 1]}].');
    const codes: number[] = [];
    for (const part of parts) {
      const shape: string = part?.shape,
        spec = shape !== 'trimesh' && Object.hasOwn(shapes, shape) ? shapes[shape as KernelShape] : undefined;
      if (!spec) throw new RangeError(`A compound part is a ball, box, capsule or hull (got ${String(part?.shape)}); pass one of those.`);
      this.checkSize(part.shape, part.size);
      this.checkPose(part.position ?? [0, 0, 0], part.rotation ?? [0, 0, 0, 1]);
      codes.push(spec[0]);
    }
    this.checkPose(options.position ?? [0, 0, 0], options.rotation ?? [0, 0, 0, 1]);
    const row = this.place(body, SHAPE_COMPOUND, [], options);
    parts.forEach((part, k) => {
      const { size, position = [0, 0, 0], rotation = [0, 0, 0, 1] } = part,
        add = (): number =>
          this.api.collider_add_part(
            row,
            codes[k],
            size[0],
            size[1] ?? 0,
            size[2] ?? 0,
            position[0],
            position[1],
            position[2],
            rotation[0],
            rotation[1],
            rotation[2],
            rotation[3],
          );
      if (add() < 0) {
        this.reserve(this.capacity, this.colliderCapacity * 2);
        add();
      }
    });
    return row;
  }

  private checkSize(shape: KernelShape, size: readonly number[]): void {
    const numbers = shapes[shape][1];
    if (shape === 'hull') {
      if (size.length !== 1 || !Number.isInteger(size[0]) || size[0] < 0 || size[0] >= this.hullRows)
        throw new RangeError(`A hull collider needs [row], a row addHull returned (got ${size.join(', ')}).`);
    } else if (shape === 'trimesh') {
      if (size.length !== 1 || !Number.isInteger(size[0]) || size[0] < 0 || size[0] >= this.meshRows)
        throw new RangeError(`A trimesh collider needs [row], a row addTrimesh returned (got ${size.join(', ')}).`);
    } else if (!Array.isArray(size) || size.length !== numbers || !size.every((value) => value > 0 && Number.isFinite(value)))
      throw new RangeError(`A ${shape} needs ${numbers} finite sizes above zero (got ${String(size)}).`);
  }

  private checkPose(position: readonly number[], rotation: readonly number[]): void {
    if (![...position, ...rotation].every(Number.isFinite))
      throw new RangeError('A collider pose must be finite; check what fed it.');
    const [qx, qy, qz, qw] = rotation,
      squared = qx * qx + qy * qy + qz * qz + qw * qw;
    if (!(squared >= 0.998001 && squared <= 1.002001))
      throw new RangeError(`A collider rotation must be a unit quaternion; normalize it (its length squared is ${squared}).`);
  }

  /** Adds a collider of shape `code` once its size and pose are checked. */
  private place(body: number, code: number, size: readonly number[], options: KernelColliderOptions): number {
    const {
      position = [0, 0, 0],
      rotation = [0, 0, 0, 1],
      density = 1000,
      friction = 0.5,
      restitution = 0,
      frictionCombine = 'average',
      restitutionCombine = 'average',
    } = options;
    if (!(density >= 0) || !Number.isFinite(density))
      throw new RangeError(`Density must be finite and not negative; 1000 is water (got ${density}).`);
    if (!(friction >= 0) || !Number.isFinite(friction))
      throw new RangeError(`Friction must be finite and not negative; 0.5 is a common start (got ${friction}).`);
    if (!(restitution >= 0 && restitution <= 1))
      throw new RangeError(`Restitution must be from 0 to 1, as a contact cannot give back more than it took (got ${restitution}).`);
    const frictionRule = combines.indexOf(frictionCombine),
      restitutionRule = combines.indexOf(restitutionCombine);
    if (frictionRule < 0 || restitutionRule < 0)
      throw new RangeError(`Unknown combine rule; use one of ${combines.join(', ')}.`);
    const add = (): number =>
      this.api.collider_add(
        body,
        code,
        size[0] ?? 0,
        size[1] ?? 0,
        size[2] ?? 0,
        position[0],
        position[1],
        position[2],
        rotation[0],
        rotation[1],
        rotation[2],
        rotation[3],
        density,
      );
    let row = add();
    if (row < 0) {
      this.reserve(this.capacity, this.colliderCapacity * 2);
      row = add();
    }
    // After the add: a world that grew has new views.
    const { colliderFriction, colliderRestitution, colliderCombine } = this.columns;
    colliderFriction[row] = friction;
    colliderRestitution[row] = restitution;
    colliderCombine[row] = frictionRule | (restitutionRule << 2);
    return row;
  }
  /**
   * Adds a convex polyhedron that colliders can share, for {@link KernelWorld.addCollider} with shape `hull`. Rows stay for
   * the world's life, and a snapshot carries them. Read views from `columns` after this call.
   * @param vertices Points in the hull's frame.
   * @param faces Each face's vertex indices, counter-clockwise seen from outside. Neighbouring faces must not lie in one
   * plane, and a face holds at most 256 edges. `convexHull` builds such faces from points.
   * @returns The hull's row.
   * @throws RangeError for a shape that is not a closed convex polyhedron with flat faces, naming what is wrong.
   */
  addHull(vertices: readonly (readonly [number, number, number])[], faces: readonly (readonly number[])[]): number {
    const { api } = this,
      edges = faces.reduce((sum, face) => sum + face.length, 0);
    if (!vertices.every((vertex) => vertex.length === 3 && vertex.every(Number.isFinite)))
      throw new RangeError('A hull vertex must be three finite numbers; check what fed it.');
    if (!api.hull_begin(vertices.length, faces.length, edges))
      throw new RangeError(`Memory cannot hold a hull of ${vertices.length} vertices; free another world, or simplify the hull.`);
    if (api.world_layout() !== this.layout) this.bind();
    const c = this.columns,
      [v0, e0, f0] = [api.hull_next(0), api.hull_next(1), api.hull_next(2)];
    vertices.forEach(([x, y, z], i) => {
      c.vertexX[v0 + i] = x;
      c.vertexY[v0 + i] = y;
      c.vertexZ[v0 + i] = z;
    });
    let edge = 0;
    faces.forEach((face, f) => {
      c.faceEdge[f0 + f] = edge;
      for (const index of face) {
        if (!Number.isInteger(index) || index < 0) throw new RangeError(`A hull face index must be a whole number; use a place in the vertex list (got ${index}).`);
        c.edgeOrigin[e0 + edge++] = index;
      }
    });
    const row = api.hull_end(vertices.length, faces.length, edges);
    if (row < 0) throw new RangeError(`This hull was refused; fix what this says: ${hullErrors[row]}.`);
    this.hullRows = row + 1;
    return row;
  }
  /**
   * Adds a triangle mesh that colliders can share, for {@link KernelWorld.addCollider} with shape `trimesh`: the kernel
   * sorts its edges and builds a tree over its triangles (binned SAH, Wald 2007). Rows stay for the world's life, and a
   * snapshot carries them. Read views from `columns` after this call.
   * @param vertices Flat x, y, z numbers in the mesh's frame.
   * @param indices Three vertex indices a triangle, counter-clockwise seen from its front. Both sides collide.
   * @returns The mesh's row.
   * @throws RangeError for indices or numbers the kernel cannot use, naming what is wrong.
   */
  addTrimesh(vertices: ArrayLike<number>, indices: ArrayLike<number>, options: KernelTrimeshOptions = {}): number {
    const { api } = this,
      { fixInternalEdges = false } = options,
      count = vertices.length / 3,
      triangles = indices.length / 3;
    if (!Number.isInteger(count) || !Number.isInteger(triangles))
      throw new RangeError(`A trimesh takes three numbers a vertex and three indices a triangle (got ${vertices.length} and ${indices.length}); pass whole vertices and whole triangles.`);
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (!Number.isInteger(index) || index < 0 || index >= count)
        throw new RangeError(`Trimesh index ${i} is ${index}; use a place in the vertex list, from 0 to ${count - 1}.`);
    }
    // The edges' neighbours serve only the internal edge rule, so a mesh without it skips finding them.
    const across = fixInternalEdges ? trianglesAcross(vertices, indices) : null;
    if (!api.mesh_begin(count, triangles))
      throw new RangeError(`Memory cannot hold a trimesh of ${triangles} triangles; free another world, or simplify the mesh.`);
    if (api.world_layout() !== this.layout) this.bind();
    const c = this.columns,
      [v0, t0] = [api.mesh_next(0), api.mesh_next(1)],
      links = [c.triangleAcross0, c.triangleAcross1, c.triangleAcross2];
    for (let i = 0; i < count; i++) {
      c.meshVertexX[v0 + i] = vertices[3 * i];
      c.meshVertexY[v0 + i] = vertices[3 * i + 1];
      c.meshVertexZ[v0 + i] = vertices[3 * i + 2];
    }
    for (let t = 0; t < triangles; t++) {
      c.triangleA[t0 + t] = indices[3 * t];
      c.triangleB[t0 + t] = indices[3 * t + 1];
      c.triangleC[t0 + t] = indices[3 * t + 2];
      for (let k = 0; k < 3; k++) {
        const other = across ? across[3 * t + k] : -1;
        links[k][t0 + t] = other < 0 ? 0xffffffff : other;
      }
    }
    const row = api.mesh_end(count, triangles, fixInternalEdges ? 1 : 0);
    if (row < 0) throw new RangeError(`This trimesh was refused; fix what this says: ${meshErrors[row]}.`);
    this.meshRows = row + 1;
    return row;
  }
  /**
   * Adds a height field that colliders can share, for {@link KernelWorld.addCollider} with shape `trimesh`, laid out as
   * Rapier's `heightfield`: `rows` cells along z and `columns` along x, `(rows + 1) * (columns + 1)` heights column major
   * (row r, column c is `heights[r + (rows + 1) * c]`), times `scale`, the whole field's size, centred on the collider.
   * Each cell is two triangles split along the diagonal from row r + 1, column c to row r, column c + 1. The kernel keeps
   * the grid's vertices only, 12 bytes each, and finds the cells under a shape by halving, so it builds no tree.
   * @returns The mesh's row.
   * @throws RangeError for a size, height or scale the kernel cannot use, naming what is wrong.
   */
  addHeightfield(
    rows: number,
    columns: number,
    heights: ArrayLike<number>,
    scale: readonly [number, number, number],
    options: KernelHeightfieldOptions = {},
  ): number {
    const { api } = this,
      { fixInternalEdges = false } = options;
    if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || 2 * rows * columns >= 0xffffffff)
      throw new RangeError(`A heightfield takes whole rows and columns of cells from 1 up, under 2^31 cells (got ${rows} and ${columns}); pass the cells along z and along x.`);
    const count = (rows + 1) * (columns + 1);
    if (heights.length !== count)
      throw new RangeError(`A heightfield of ${rows} by ${columns} cells takes (rows + 1) * (columns + 1) = ${count} heights (got ${heights.length}); pass one a grid point, column major.`);
    if (scale.length !== 3 || !scale.every((value) => value > 0 && Number.isFinite(value)))
      throw new RangeError(`A heightfield scale is three finite sizes above zero (got ${scale.join(', ')}); pass the field's width, height factor and depth.`);
    for (let i = 0; i < count; i++)
      if (!Number.isFinite(heights[i])) throw new RangeError(`Heightfield height ${i} is ${heights[i]}; pass finite heights.`);
    if (!api.mesh_begin(count, 0))
      throw new RangeError(`Memory cannot hold a heightfield of ${count} points; free another world, or use fewer cells.`);
    if (api.world_layout() !== this.layout) this.bind();
    const c = this.columns,
      v0 = api.mesh_next(0),
      [width, lift, depth] = scale;
    for (let column = 0; column <= columns; column++) {
      const x = -width / 2 + (width * column) / columns;
      for (let row = 0; row <= rows; row++) {
        const i = row + (rows + 1) * column;
        c.meshVertexX[v0 + i] = x;
        c.meshVertexY[v0 + i] = heights[i] * lift;
        c.meshVertexZ[v0 + i] = -depth / 2 + (depth * row) / rows;
      }
    }
    const row = api.mesh_end_grid(rows, columns, fixInternalEdges ? 1 : 0);
    if (row < 0) throw new RangeError(`This heightfield was refused; fix what this says: ${meshErrors[row]}.`);
    this.meshRows = row + 1;
    return row;
  }
  /**
   * Adds a voxel grid, for {@link KernelWorld.addCollider} with shape `trimesh`: the filled cells, three whole numbers
   * each, cell (i, j, k) spanning `[i, i + 1] * size[0]` along x and so on in the collider's frame, as Rapier's `voxels`
   * takes them. A cell named twice is one cell; no cells is an empty grid. The kernel keeps a byte a cell over the box of
   * the cells, so a sparse grid costs its box.
   * @returns The grid's mesh row. A grid is not shared: its edits change every collider that names it.
   * @throws RangeError for a cell or size the kernel cannot use, naming what is wrong.
   */
  addVoxels(cells: Int32Array, size: readonly [number, number, number]): number {
    const { api } = this;
    if (!(cells instanceof Int32Array) || cells.length % 3)
      throw new RangeError(`Voxel cells are an Int32Array of x, y, z cell coordinates, three per cell (got ${cells?.length} numbers); pass whole cells.`);
    if (size.length !== 3 || !size.every((value) => value > 0 && Number.isFinite(value)))
      throw new RangeError(`A voxel size is three finite sizes above zero (got ${size.join(', ')}); pass one cell's width, height and depth.`);
    const low = [0, 0, 0],
      high = [0, 0, 0];
    for (let i = 0; i < cells.length; i++) {
      const k = i % 3,
        value = cells[i];
      if (i < 3 || value < low[k]) low[k] = value;
      if (i < 3 || value > high[k]) high[k] = value;
    }
    const dims = [high[0] - low[0] + 1, high[1] - low[1] + 1, high[2] - low[2] + 1],
      count = dims[0] * dims[1] * dims[2];
    if (count > 0x40000000)
      throw new RangeError(`A voxel grid spans at most 2^30 cells of its box (these span ${count}); split the world into chunks, one grid each.`);
    if (!api.voxels_begin(count))
      throw new RangeError(`Memory cannot hold a voxel grid of ${count} cells; free another world, or split the grid into chunks.`);
    if (api.world_layout() !== this.layout) this.bind();
    const words = this.columns.voxelWord,
      first = api.mesh_next(3);
    for (let i = 0; i < cells.length; i += 3) {
      const index = cells[i] - low[0] + dims[0] * (cells[i + 1] - low[1] + dims[1] * (cells[i + 2] - low[2]));
      words[first + (index >>> 2)] |= 1 << (8 * (index & 3));
    }
    const row = api.voxels_end(low[0], low[1], low[2], dims[0], dims[1], dims[2], size[0], size[1], size[2]);
    if (row < 0) throw new RangeError('This voxel grid was refused; pass cells whose box fits 32-bit cell numbers, and a positive size.');
    this.meshRows = row + 1;
    return row;
  }
  /**
   * Fills or empties cell (x, y, z) of a voxel collider in place, growing the grid for a cell outside it. The body's mass
   * is worked out again and what touches the collider wakes.
   * @throws RangeError for a collider that is not a voxel grid, or when memory cannot grow the grid.
   */
  setVoxel(collider: number, x: number, y: number, z: number, filled: boolean): void {
    this.voxelDone(this.api.voxels_set(collider, x, y, z, filled ? 1 : 0), 'setVoxel');
  }
  /** Makes two voxel colliders see each other's border cells, `b`'s cell (0, 0, 0) at `a`'s `shift`. */
  combineVoxels(a: number, b: number, shift: readonly [number, number, number]): void {
    this.voxelDone(this.api.voxels_combine(a, b, shift[0], shift[1], shift[2]), 'combineVoxelStates');
  }
  /** Tells voxel collider `b`, coupled at `shift`, that cell `at` of `a` changed. */
  propagateVoxel(a: number, b: number, at: readonly [number, number, number], shift: readonly [number, number, number]): void {
    this.voxelDone(this.api.voxels_propagate(a, b, at[0], at[1], at[2], shift[0], shift[1], shift[2]), 'propagateVoxelChange');
  }
  /**
   * The nearest ray hit among the colliders the filter words let through, or null. The direction need not be unit
   * length; `distance` is along its unit. Words: `flags` (QUERY_ bits), `groups` (packed, as `collisionGroups`), and a
   * collider row and a body row to leave out (0xffffffff for none).
   * @throws RangeError for an origin or direction that is not finite, or a zero direction.
   */
  raycast(origin: readonly number[], direction: readonly number[], max: number, solid: boolean, flags: number, groups: number, collider: number, body: number): KernelRayHit | null {
    const found = this.api.query_ray(origin[0]!, origin[1]!, origin[2]!, direction[0]!, direction[1]!, direction[2]!, max, solid ? 1 : 0, flags, groups, collider, body);
    if (found < 0) throw new RangeError('A ray needs a finite origin and a finite, nonzero direction; pass three numbers for each.');
    return found ? this.readHit(0) : null;
  }
  /**
   * Each collider's ray hit, in row order (not sorted), with the same words as {@link KernelWorld.raycast}.
   * @throws RangeError for an origin or direction that is not finite, or a zero direction.
   */
  raycastAll(origin: readonly number[], direction: readonly number[], max: number, solid: boolean, flags: number, groups: number, collider: number, body: number): KernelRayHit[] {
    const hits: KernelRayHit[] = [];
    for (let skip = 0, total = 1; skip < total; ) {
      total = this.api.query_ray_all(origin[0]!, origin[1]!, origin[2]!, direction[0]!, direction[1]!, direction[2]!, max, solid ? 1 : 0, flags, groups, collider, body, skip);
      if (total < 0) throw new RangeError('A ray needs a finite origin and a finite, nonzero direction; pass three numbers for each.');
      const page = total - skip < QUERY_HITS ? total - skip : QUERY_HITS;
      for (let i = 0; i < page; i++) hits.push(this.readHit(i));
      skip += page;
    }
    return hits;
  }
  /**
   * The nearest first touch of a query shape cast from a pose along a direction, among the colliders the filter words
   * let through, or null. `shape` is a kernel shape kind and its numbers as a collider's (`addCollider`'s `size`; a hull
   * names its `addHull` row). `distance` is along the direction's unit; the cast goes up to `max` and stops `target` short.
   * `stop` makes a start in contact a hit even on its way out; `geometry` works out its normal and points.
   * @throws RangeError for a pose, direction or shape the kernel cannot cast.
   */
  shapeCast(
    shape: KernelQueryShape,
    position: readonly number[],
    rotation: readonly number[],
    direction: readonly number[],
    cast: KernelCastOptions,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): KernelShapeCastHit | null {
    const found = this.api.query_shape_cast(...this.shapeWords(shape, position, rotation), direction[0]!, direction[1]!, direction[2]!, cast.max, cast.target, castBits(cast), flags, groups, collider, body);
    if (found < 0) throw new RangeError(CAST_REFUSED);
    return found ? this.readCast(0) : null;
  }
  /** Each collider's shape cast hit, in row order (not sorted), as {@link KernelWorld.shapeCast}. */
  shapeCastAll(
    shape: KernelQueryShape,
    position: readonly number[],
    rotation: readonly number[],
    direction: readonly number[],
    cast: KernelCastOptions,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): KernelShapeCastHit[] {
    const hits: KernelShapeCastHit[] = [],
      words = this.shapeWords(shape, position, rotation);
    for (let skip = 0, total = 1; skip < total; ) {
      total = this.api.query_shape_cast_all(...words, direction[0]!, direction[1]!, direction[2]!, cast.max, cast.target, castBits(cast), flags, groups, collider, body, skip);
      if (total < 0) throw new RangeError(CAST_REFUSED);
      const page = total - skip < QUERY_HITS / 2 ? total - skip : QUERY_HITS / 2;
      for (let i = 0; i < page; i++) hits.push(this.readCast(i));
      skip += page;
    }
    return hits;
  }
  /**
   * The collider point nearest `point` among the colliders the filter words let through, or null; inside a solid shape
   * (`solid` true) the point itself.
   * @throws RangeError for a point that is not finite.
   */
  projectPoint(point: readonly number[], solid: boolean, flags: number, groups: number, collider: number, body: number): KernelProjection | null {
    const found = this.api.query_project_point(point[0]!, point[1]!, point[2]!, solid ? 1 : 0, flags, groups, collider, body);
    if (found < 0) throw new RangeError(POINT_REFUSED);
    return found ? this.readProjection(0) : null;
  }
  /** Each collider's nearest point to `point`, in row order, as {@link KernelWorld.projectPoint}. */
  projectPointAll(point: readonly number[], solid: boolean, flags: number, groups: number, collider: number, body: number): KernelProjection[] {
    const hits: KernelProjection[] = [];
    for (let skip = 0, total = 1; skip < total; ) {
      total = this.api.query_project_point_all(point[0]!, point[1]!, point[2]!, solid ? 1 : 0, flags, groups, collider, body, skip);
      if (total < 0) throw new RangeError(POINT_REFUSED);
      const page = total - skip < QUERY_HITS ? total - skip : QUERY_HITS;
      for (let i = 0; i < page; i++) hits.push(this.readProjection(i));
      skip += page;
    }
    return hits;
  }
  /** The collider rows that hold `point`, in row order. @throws RangeError for a point that is not finite. */
  intersectPoint(point: readonly number[], flags: number, groups: number, collider: number, body: number): number[] {
    return this.rows((skip) => this.api.query_point_all(point[0]!, point[1]!, point[2]!, flags, groups, collider, body, skip), POINT_REFUSED);
  }
  /** The collider rows a query shape at a pose overlaps, in row order. @throws RangeError as {@link KernelWorld.shapeCast}. */
  intersectShape(shape: KernelQueryShape, position: readonly number[], rotation: readonly number[], flags: number, groups: number, collider: number, body: number): number[] {
    const words = this.shapeWords(shape, position, rotation);
    return this.rows((skip) => this.api.query_shape_all(...words, flags, groups, collider, body, skip), CAST_REFUSED);
  }
  private rows(call: (skip: number) => number, refused: string): number[] {
    const rows: number[] = [];
    for (let skip = 0, total = 1; skip < total; ) {
      total = call(skip);
      if (total < 0) throw new RangeError(refused);
      const page = total - skip < 8 * QUERY_HITS ? total - skip : 8 * QUERY_HITS,
        words = new Uint32Array(this.api.memory.buffer, this.api.query_buffer(), page);
      for (let i = 0; i < page; i++) rows.push(words[i]!);
      skip += page;
    }
    return rows;
  }
  private shapeWords(shape: KernelQueryShape, p: readonly number[], q: readonly number[]): [number, number, number, number, number, number, number, number, number, number, number, number] {
    const s = shape.size;
    return [QUERY_KINDS[shape.shape], shape.shape === 'hull' ? 0 : s[0]!, s[1] ?? 0, s[2] ?? 0, shape.shape === 'hull' ? s[0]! : 0, p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, q[3]!];
  }
  private readCast(i: number): KernelShapeCastHit {
    const words = new Uint32Array(this.api.memory.buffer, this.api.query_buffer() + 64 * i, 16),
      f = new Float32Array(words.buffer, words.byteOffset, 16);
    return {
      collider: words[0]!,
      distance: f[1]!,
      point: [f[2]!, f[3]!, f[4]!],
      normal: [f[5]!, f[6]!, f[7]!],
      queryPoint: [f[8]!, f[9]!, f[10]!],
      queryNormal: [f[11]!, f[12]!, f[13]!],
      started: words[14] === 1,
    };
  }
  private readProjection(i: number): KernelProjection {
    const words = new Uint32Array(this.api.memory.buffer, this.api.query_buffer() + 32 * i, 8),
      f = new Float32Array(words.buffer, words.byteOffset, 8);
    return { collider: words[0]!, inside: words[1] === 1, point: [f[2]!, f[3]!, f[4]!], distance: f[5]! };
  }
  private readHit(i: number): KernelRayHit {
    const words = new Uint32Array(this.api.memory.buffer, this.api.query_buffer() + 32 * i, 8),
      floats = new Float32Array(words.buffer, words.byteOffset, 8);
    return { collider: words[0]!, distance: floats[1]!, normal: [floats[2]!, floats[3]!, floats[4]!], point: [floats[5]!, floats[6]!, floats[7]!] };
  }
  private voxelDone(code: number, what: string): void {
    if (this.api.world_layout() !== this.layout) this.bind();
    if (code === -2) throw new RangeError(`${what} works on voxels colliders only; call it on a collider made with shape 'voxels'.`);
    if (code < 0) throw new RangeError(`Memory cannot grow this voxel grid for ${what}; free another world, or keep edits inside the grid.`);
  }
  /**
   * Removes a collider and works out its body's mass again. Its row comes back after the next step.
   * @returns false when the row holds no collider.
   */
  removeCollider(collider: number): boolean {
    return Number.isInteger(collider) && collider >= 0 && this.api.collider_remove(collider) === 1;
  }
  /**
   * Adds a joint between two bodies and returns its row in the joint columns. Grows the world when the rows run out, so
   * read views from `columns` after this call. Its frames start as the identity and every other column as zero.
   * @param flags The `JOINT_` bits; the axes it locks hold from the first step.
   * @throws RangeError for a body that is gone, a body joined to itself, or when the world cannot grow.
   */
  addJoint(a: number, b: number, flags: number): number {
    const { api } = this,
      row = api.joint_add(a, b, flags);
    if (row < 0) throw new RangeError(`Rows ${a} and ${b} cannot take a joint; use two rows addBody returned, or free memory.`);
    if (api.world_layout() !== this.layout) this.bind();
    return row;
  }
  /**
   * Removes a joint and wakes its bodies. Its row comes back from a later {@link KernelWorld.addJoint}, last freed first.
   * @returns false when the row holds no joint.
   */
  removeJoint(joint: number): boolean {
    return Number.isInteger(joint) && joint >= 0 && this.api.joint_remove(joint) === 1;
  }
  /** Turns a joint's frames on both bodies so that frame X runs along `axis`, a direction in each body's own frame. */
  setJointAxis(joint: number, axis: readonly [number, number, number]): void {
    this.api.joint_set_axis(joint, axis[0], axis[1], axis[2]);
  }
  /** Sets a joint's frame on each body, as quaternions `[x, y, z, w]` in that body's frame; the kernel makes them unit length. */
  setJointFrames(joint: number, a: Quat, b: Quat): void {
    this.api.joint_set_frames(joint, a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]);
  }
  /**
   * Works out a body's mass again, after a write to its `additionalMass` column. Extra mass is spread as the colliders
   * are, so it scales the inertia too.
   */
  updateMass(body: number): this {
    this.api.body_update_mass(body);
    return this;
  }
  /**
   * Changes how a body moves, keeping its pose, colliders and joints. A body made fixed stops and drops its pairs with
   * other fixed bodies, so what they touched ends; one made `kinematicPosition` holds its pose until given a target. With
   * `wakeUp` (default true) a body made dynamic or kinematic wakes now, with what it touches. A sleeper otherwise, or made
   * fixed, reads asleep until the next step, which wakes it and what it touches whatever `wakeUp` said: Rapier does both
   * (measured on the root entry).
   * @throws RangeError for an unknown kind.
   */
  setKind(body: number, kind: KernelBodyKind, wakeUp = true): this {
    const bits = Object.hasOwn(bodyKinds, kind) ? bodyKinds[kind] : undefined;
    if (bits === undefined)
      throw new RangeError(`Unknown body kind ${String(kind)}; use one of ${Object.keys(bodyKinds).join(', ')}.`);
    const flags = this.columns.flags[body] ?? 0,
      changes = (flags & ALIVE) !== 0 && (flags & (3 << 1)) !== bits;
    this.api.body_set_kind(body, bits, wakeUp ? 1 : 0);
    if (changes && ((this.columns.flags[body] ?? 0) & (SLEEPING | RESTING)) !== 0) this.wakeAtStep.push(body);
    return this;
  }
  /**
   * Gives a body a solid of its own on top of its colliders and works out its mass again: `mass` kilograms at `center`,
   * and principal moments `inertia` in kg m² along `frame`, all in the body's frame. It replaces an earlier one, and the
   * `additionalMass` column goes to 0. With no collider mass these figures are the body's, exactly.
   */
  setOwnSolid(body: number, mass: number, center: Vec3, inertia: Vec3, frame: Quat = [0, 0, 0, 1]): this {
    this.api.body_set_own(body, mass, center[0], center[1], center[2], inertia[0], inertia[1], inertia[2], frame[0], frame[1], frame[2], frame[3]);
    return this;
  }
  /**
   * Puts a body at a pose by hand: the step starts from it, interpolation holds it, and a `kinematicPosition` body stays
   * there until given a target. The kernel normalises the rotation.
   * @param wake False leaves a sleeper asleep at its new place.
   */
  setPose(body: number, position: Vec3, rotation: Quat, wake = true): this {
    const [x, y, z] = position,
      [qx, qy, qz, qw] = rotation;
    this.api.body_set_pose(body, x, y, z, qx, qy, qz, qw, wake ? 1 : 0);
    return this;
  }
  /** The pose a `kinematicPosition` body reaches at the end of the next step. The kernel normalises the rotation. */
  setTarget(body: number, position: Vec3, rotation: Quat): this {
    const [x, y, z] = position,
      [qx, qy, qz, qw] = rotation;
    this.api.body_set_target(body, x, y, z, qx, qy, qz, qw);
    return this;
  }
  /** Sets the world axes a body may not move along or turn about: bit 0 for x, 1 for y, 2 for z. */
  setLocks(body: number, { linear, angular }: { linear?: number; angular?: number }): this {
    const { flags } = this.columns;
    if (linear !== undefined) flags[body] = (flags[body] & ~(7 << 3)) | (linear << 3);
    if (angular !== undefined) flags[body] = (flags[body] & ~(7 << 6)) | (angular << 6);
    return this;
  }
  /**
   * Says a body's pose was written by hand. Moving bodies are looked at every step anyway; a fixed or sleeping body is
   * not, so call this after writing the pose of one. A sleeper wakes.
   */
  touch(body: number): this {
    this.api.body_touch(body);
    return this;
  }
  /**
   * Advances the world by `dt` seconds, in {@link KernelWorld.substeps} equal pieces. Finding new pairs can grow the world,
   * so read views from `columns` after this call.
   * @throws RangeError unless `dt` is finite and above zero, or when memory cannot hold the pairs found.
   * @throws MargoError (`failed`) when a body went past 1e15 in position or speed: the world keeps its last state and steps no
   * more. {@link KernelWorld.restore} an earlier snapshot, or build the world again with what drove the body limited.
   */
  step(dt: number): this {
    if (!(dt > 0) || !Number.isFinite(dt))
      throw new RangeError(`A step must be finite and above zero; a usual step is 1 / 60 (got ${dt}).`);
    if (this.stepping) throw new MargoError('state', 'A contact filter ran a step; a filter may only read the world.');
    for (const row of this.wakeAtStep) this.api.body_wake_touching(row);
    this.wakeAtStep.length = 0;
    this.stepping = true;
    let failed: number;
    try {
      failed = this.api.world_step(dt);
    } finally {
      this.stepping = false;
    }
    if (this.api.world_layout() !== this.layout) this.bind();
    if (failed) throw new RangeError('Memory cannot hold the pairs of this world; spread the colliders out or use fewer.');
    const lost = this.api.world_lost();
    if (lost >= 0)
      throw new MargoError(
        'failed',
        `Body row ${lost} went past 1e15 in position or speed, where a step has no numbers left to work with. A true path can do this: a bead free on a spinning rail flies out exponentially. This world has stopped; limit the joint that drives the body, then restore a snapshot or build the world again.`,
      );
    return this;
  }
  /** Bytes of the world, and of a {@link KernelWorld.snapshot}. */
  get bytes(): number {
    return this.api.world_bytes() >>> 0;
  }
  /** FNV-1a of the world's bytes: equal in every browser, in Node and on any machine for the same inputs. */
  get hash(): number {
    return this.api.world_hash() >>> 0;
  }
  /** The whole world as one copy of its bytes, for {@link KernelWorld.restore}. Only this kernel build can read them. */
  snapshot(): Uint8Array {
    const { api } = this;
    return new Uint8Array(api.memory.buffer, api.world_base(), this.bytes).slice();
  }
  /**
   * Puts the world back as a {@link KernelWorld.snapshot} found it, in one copy, at the snapshot's size. Rows, pairs, sleep
   * and every value come back, so the steps after it give the same bits as the first time.
   * @throws RangeError for bytes that are not a snapshot of this kernel, or when memory cannot hold them.
   */
  restore(snapshot: Uint8Array): this {
    const { api } = this,
      base = api.world_base(),
      bytes = snapshot.byteLength,
      words = new DataView(snapshot.buffer, snapshot.byteOffset, bytes);
    if (
      bytes < 8 ||
      words.getUint32(0, true) !== new DataView(api.memory.buffer).getUint32(base, true) ||
      words.getUint32(4, true) !== bytes
    )
      throw new RangeError('These bytes are not a snapshot of this kernel; use what snapshot() returned.');
    if (!api.world_ensure(bytes)) throw new RangeError(`Memory cannot hold a snapshot of ${bytes} bytes; free another world, or use a smaller one.`);
    new Uint8Array(api.memory.buffer, base, bytes).set(snapshot);
    this.bind();
    // Rows handed out, not rows of room: a collider must not name a row no hull or mesh was written to.
    this.hullRows = api.hull_count();
    this.meshRows = api.mesh_count();
    return this;
  }
  /**
   * Makes room for `bodies` and `colliders` rows. Rows keep their index and values; later steps give the same results.
   * @throws RangeError when the kernel cannot grow that far.
   */
  reserve(bodies: number, colliders: number = this.colliderCapacity): this {
    if (!Number.isSafeInteger(bodies) || !Number.isSafeInteger(colliders) || !this.api.world_reserve(bodies, colliders))
      throw new RangeError(`Cannot reserve ${bodies} bodies and ${colliders} colliders; the limit of each is 4194304 and what memory allows.`);
    this.bind();
    return this;
  }
}
