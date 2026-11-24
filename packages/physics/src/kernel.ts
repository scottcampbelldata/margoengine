// The Rust kernel from JavaScript: loads the blueprint and reads the world's columns through typed-array views.
import { clock } from './clock.js';
import { MargoError } from '@margoengine/math/errors';
import { LoadOnce } from '../../shared/load-once.js';
import type { Quat, Vec3 } from './math.js';

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
  world_set_prediction(distance: number): number;
  world_prediction(): number;
  world_sleep_energy(): number;
  world_sleep_time(): number;
  world_set_solver(index: number, value: number): number;
  world_solver(index: number): number;
  world_timing(phase: number): number;
  world_set_ccd(substeps: number): void;
  world_ccd(): number;
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
  collider_set_border(collider: number, border: number): number;
  collider_set_part_border(compound: number, child: number, border: number): number;
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
  collider_refit(collider: number, motion: number): number;
  collider_aim(collider: number, motion: number): number;
  mesh_end_grid(rows: number, columns: number, flags: number): number;
  mesh_set_cell(collider: number, row: number, column: number, status: number): number;
  query_groups_hi(hi: number): void;
  mesh_cell(collider: number, row: number, column: number): number;
  mesh_next(rows: number): number;
  voxels_begin(cells: number): number;
  voxels_end(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    sx: number,
    sy: number,
    sz: number,
  ): number;
  voxels_set(collider: number, x: number, y: number, z: number, filled: number): number;
  voxels_combine(a: number, b: number, sx: number, sy: number, sz: number): number;
  voxels_propagate(a: number, b: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): number;
  query_buffer(): number;
  probe_input(): number;
  probe_output(): number;
  probe_capacity(): number;
  probe_depth(): number;
  soft_probe(count: number, k: number, flags: number, body: number): number;
  collider_set_shape(collider: number, shape: number, a: number, b: number, c: number): number;
  collider_set_pose(
    collider: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): number;
  collider_aabb(collider: number): number;
  collider_aabb_at(
    collider: number,
    x: number,
    y: number,
    z: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): number;
  query_aabb(
    lx: number,
    ly: number,
    lz: number,
    hx: number,
    hy: number,
    hz: number,
    flags: number,
    groups: number,
    collider: number,
    body: number,
    skip: number,
  ): number;
  collider_ray(
    collider: number,
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    max: number,
    solid: number,
  ): number;
  collider_project(collider: number, x: number, y: number, z: number, solid: number): number;
  collider_shape_cast(collider: number, ...words: number[]): number;
  collider_overlaps(collider: number, ...words: number[]): number;
  pair_intersects(a: number, b: number): number;
  pair_contacts(a: number, b: number, prediction: number): number;
  pair_distance(a: number, b: number): number;
  collider_shape_contacts(collider: number, ...words: number[]): number;
  collider_cast_collider(
    moving: number,
    target: number,
    dx: number,
    dy: number,
    dz: number,
    max: number,
    target_distance: number,
    options: number,
  ): number;
  collider_set_mass_properties(
    collider: number,
    mass: number,
    cx: number,
    cy: number,
    cz: number,
    ix: number,
    iy: number,
    iz: number,
    qx: number,
    qy: number,
    qz: number,
    qw: number,
  ): number;
  collider_volume(collider: number): number;
  collider_mass(collider: number): number;
  query_ray(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    max: number,
    solid: number,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): number;
  query_ray_all(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    max: number,
    solid: number,
    flags: number,
    groups: number,
    collider: number,
    body: number,
    skip: number,
  ): number;
  query_shape_cast(...words: number[]): number;
  query_shape_cast_all(...words: number[]): number;
  query_project_point(
    x: number,
    y: number,
    z: number,
    solid: number,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): number;
  query_project_point_all(
    x: number,
    y: number,
    z: number,
    solid: number,
    flags: number,
    groups: number,
    collider: number,
    body: number,
    skip: number,
  ): number;
  query_point_all(
    x: number,
    y: number,
    z: number,
    flags: number,
    groups: number,
    collider: number,
    body: number,
    skip: number,
  ): number;
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
/** The joint broke under its load and solves nothing. */
export const JOINT_BROKEN = 1 << 29;
/** The turning motors drive frame B toward the `jointDrive` rotation in frame A (a cone's rotation motor). */
export const JOINT_DRIVE = 1 << 30;
/** The caller switched the joint off: it solves nothing until switched on. */
export const JOINT_DISABLED = 1 << 31;
/** Bits of the `colliderFlags` column. */
export const COLLIDER_SENSOR = 1;
export const COLLIDER_OFF = 2;
/** Bits 2 to 7 of a collider's flags: each flips one kind of body pair from its default (layout.rs COLLIDER_TYPES). */
export const COLLIDER_TYPES_SHIFT = 2;
/** Bit 8 of a collider's flags: its pairs are shown to the contact modifier (layout.rs COLLIDER_MODIFY). */
export const COLLIDER_MODIFY = 1 << 8;
/** Bits 9 and 10 of a collider's flags: the pair filter is not asked about solid pairs, or pairs with a sensor, for it. */
export const COLLIDER_NO_CONTACT_FILTER = 1 << 9;
export const COLLIDER_NO_INTERSECTION_FILTER = 1 << 10;
/** Bits 12 and 13 of a collider's flags: its collision groups, or its solver groups, test by `or` (layout.rs COLLIDER_GROUPS_OR). */
export const COLLIDER_GROUPS_OR = 1 << 12;
export const COLLIDER_SOLVER_OR = 1 << 13;
/** Bits 14 and 15 of a collider's flags: its collision groups, or its solver groups, are 32 bits wide (layout.rs COLLIDER_GROUPS_WIDE). */
export const COLLIDER_GROUPS_WIDE = 1 << 14;
export const COLLIDER_SOLVER_WIDE = 1 << 15;
export const COLLIDER_TYPES = 63 << COLLIDER_TYPES_SHIFT;
/** Bit of the `flags` column: the body is out of the world. */
export const BODY_DISABLED = 1 << 11;
/** Bits of the `flags` column: continuous collision on, and whether the last step's CCD pass checked the body. */
export const BODY_CCD = 1 << 13,
  BODY_CCD_ACTIVE = 1 << 14;
/** Bit of the `flags` column: the body's gyroscopic term is off. */
export const BODY_NO_GYROSCOPIC = 1 << 16;
/** An event's first word: the first collider's row under this mask, the sensor bit, and the top bit when it started. */
export const EVENT_COLLIDER = (1 << 30) - 1;
export const EVENT_SENSOR = 1 << 30;
/** The top bit of an event's second word: the stop is because a collider or its body was removed (layout.rs EVENT_REMOVED). */
export const EVENT_REMOVED = 0x80000000;
/** Bit of the `pairFlags` column: a part of a mesh pair, one triangle's manifold. */
export const PAIR_IS_PART = 16;
/** Bit of a pair's flags: the pair touched at the end of the last step it was looked at (layout.rs PAIR_TOUCHING). */
export const PAIR_TOUCHING = 1;

/** How a body moves: `dynamic` by forces, `kinematicPosition` to a target, `kinematicVelocity` at its velocity. */
export type KernelBodyKind = 'fixed' | 'dynamic' | 'kinematicPosition' | 'kinematicVelocity';

/**
 * Shapes the kernel holds today. Sizes: a ball's radius; a box's half extents; a capsule's radius and half core length; a
 * cylinder's or cone's radius, half height along local Y and border radius (0 for none; a cone's apex is at +Y); a hull's
 * row from {@link KernelWorld.addHull}; a mesh's row from {@link KernelWorld.addTrimesh} or
 * {@link KernelWorld.addHeightfield}.
 */
export type KernelShape = 'ball' | 'box' | 'capsule' | 'cylinder' | 'cone' | 'hull' | 'trimesh' | 'halfspace';

/** One convex child of {@link KernelWorld.addCompound}: a shape and size as {@link KernelWorld.addCollider} takes them. */
export interface KernelCompoundPart {
  shape: 'ball' | 'box' | 'capsule' | 'cylinder' | 'cone' | 'hull' | 'trimesh' | 'halfspace';
  size: readonly number[];
  /** Place in the compound's frame (default its origin). */
  position?: readonly [number, number, number];
  /** Unit quaternion, x, y, z, w, in the compound's frame (default none). */
  rotation?: readonly [number, number, number, number];
  /** A box's or hull's border (see {@link KernelColliderOptions.border}); default 0. */
  border?: number;
}

/** How many numbers each shape's size takes, and its value in the `colliderShape` column. */
const shapes: Readonly<Record<KernelShape, readonly [number, number]>> = {
  ball: [0, 1],
  box: [1, 3],
  capsule: [2, 2],
  hull: [3, 1],
  trimesh: [4, 1],
  cylinder: [6, 3],
  cone: [7, 3],
  halfspace: [8, 3],
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
  [-6]: 'A trimesh with a mass or a density must be a closed surface wound outwards, enclosing a volume; flip its triangles, close it, or give its body mass with setMassProperties',
};

/** Options of {@link KernelWorld.addTrimesh}. */
export interface KernelTrimeshOptions {
  /**
   * Keeps contacts on a triangle's inner edges to the normals the surface allows, so shapes slide over the seams between
   * triangles without catching (Rapier's `TriMeshFlags.FIX_INTERNAL_EDGES`). Default false, as in Rapier.
   */
  fixInternalEdges?: boolean;
  /**
   * The mesh is a closed surface, so a point inside it is known (Rapier's `TriMeshFlags.ORIENTED`): `projectPoint` and
   * `intersectPoint` find it inside, and a solid ray from inside hits at distance 0. A mesh that is not closed answers by
   * how many triangles a ray from the point crosses. Default false.
   */
  oriented?: boolean;
  /** The mesh is a closed surface wound outwards and has the mass of its volume at a density (Rapier's trimesh mass). Default false. */
  solid?: boolean;
  /** The vertices may move later: {@link KernelWorld.refitCollider} follows them with no rebuild (Rapier's `DEFORMABLE`). Default false. */
  deformable?: boolean;
}

/** Options of {@link KernelWorld.addHeightfield}. */
export interface KernelHeightfieldOptions {
  /**
   * Keeps contacts on the grid's inner edges to the normals the surface allows, as for a trimesh (Rapier's
   * `HeightFieldFlags.FIX_INTERNAL_EDGES`). Default false, as in Rapier.
   */
  fixInternalEdges?: boolean;
  /**
   * The status of each cell, one byte a cell, row r of column c at `r + rows * c`: bit 0 (1) splits the cell the other way
   * (Rapier's `HeightFieldCellStatus.ZIGZAG_SUBDIVISION`), bit 1 (2) removes its left triangle (the one on its lower x) and
   * bit 2 (4) its right one (`LEFT_TRIANGLE_REMOVED`, `RIGHT_TRIANGLE_REMOVED`; both is `CELL_REMOVED`). Default none.
   */
  cellStatus?: ArrayLike<number>;
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
/** What one particle's move meets: see {@link KernelWorld.probeParticles}. */
export interface KernelParticleContact {
  /** The collider row, and its body's row. */
  collider: number;
  body: number;
  /** The fraction of the move, 0 to 1, at which the particle first touches: 1 for one that only ends within reach, 0 for one that starts touching. */
  t: number;
  /** The unit normal out of the collider. */
  normal: [number, number, number];
  /** How far the end of the move is inside the particle's radius from the surface, along the normal: push out by this when positive; a gap still open when negative. */
  depth: number;
  /** The point on the collider's surface. */
  point: [number, number, number];
  /** The velocity of the surface at that point: the body's, and a deformable mesh's vertices'. */
  velocity: [number, number, number];
  /** The particle started the move touching. */
  started: boolean;
  /** The triangle of a deformable mesh it touches, or 0xffffffff. */
  triangle: number;
}
/** Options of {@link KernelWorld.probeParticles} and {@link KernelWorld.softContacts}: a query filter's flags and a body to leave out. */
export interface KernelProbeOptions {
  flags?: number;
  /** Packed interaction groups of every particle (as `collisionGroups`); left out, every collider is met. */
  groups?: number;
  /** A body row whose colliders are left out (a soft body's own rigid frame). */
  excludeBody?: number;
  /**
   * The length of the step in seconds. Given, each particle is swept against every collider along that collider's own motion over
   * the step (its linear and angular velocity, in the collider's frame), so a fast bat or a spinning paddle cannot pass a
   * particle; the contact's point and normal are then in the collider's pose at the start of the step, and the plane goes on at
   * `velocity`. Left out (0), every collider is met where it is.
   */
  dt?: number;
}
/**
 * The particles of a soft body for {@link KernelWorld.softContacts}: packed x, y, z where each was and where each ends the step,
 * a radius (one for all, or one each), and how far past its radius a surface still counts (default 0).
 */
export interface KernelParticleViews {
  from: ArrayLike<number>;
  to: ArrayLike<number>;
  radius: number | ArrayLike<number>;
  margin?: number | ArrayLike<number>;
  /** One packed groups word each (a `Uint32Array` ok), for particles of different groups; else `options.groups` serves all. */
  groups?: ArrayLike<number>;
}
/** The answer of {@link KernelWorld.softContacts}: `k` slots for each particle, in the order of the particles. A slot with no contact has `collider` 0xffffffff. */
export interface KernelSoftContacts {
  k: number;
  collider: Uint32Array;
  body: Uint32Array;
  /** Fraction of the move at which the touch happens. */
  t: Float32Array;
  /** Three numbers a slot: the unit normal out of the collider. */
  normal: Float32Array;
  /** Depth the end of the move is inside the radius (negative: still a gap). */
  depth: Float32Array;
  /** Three numbers a slot: the point on the surface. */
  point: Float32Array;
  /** Three numbers a slot: the velocity of the surface there. */
  velocity: Float32Array;
  started: Uint8Array;
  triangle: Uint32Array;
}
/** Filter bits of the kernel's queries (`KernelWorld.raycast`), as Rapier's `QueryFilterFlags`. */
export const QUERY_EXCLUDE_FIXED = 1,
  QUERY_EXCLUDE_KINEMATIC = 2,
  QUERY_EXCLUDE_DYNAMIC = 4,
  QUERY_EXCLUDE_SENSORS = 8,
  QUERY_EXCLUDE_SOLIDS = 16,
  QUERY_ONLY_DYNAMIC = 32,
  QUERY_ONLY_KINEMATIC = 64,
  QUERY_ONLY_FIXED = 128,
  /** No group test at all: a query without groups sees every collider, whatever its groups. */
  QUERY_NO_GROUPS = 256,
  /** The query's groups are 32 bits wide: the upper halves come from `setQueryGroupsHi`. */
  QUERY_WIDE_GROUPS = 512,
  /** With QUERY_WIDE_GROUPS: test by `or` against a collider that asks for it too. */
  QUERY_GROUPS_OR = 1024;
/** Hits the kernel's query buffer holds at once; `raycastAll` pages through more. */
const QUERY_HITS = 256;
/** A query shape of {@link KernelWorld.shapeCast} and {@link KernelWorld.intersectShape}: a convex kernel shape and its
 * `addCollider` size (a hull names its `addHull` row). */
export interface KernelQueryShape {
  shape: 'ball' | 'box' | 'capsule' | 'cylinder' | 'cone' | 'hull' | 'trimesh' | 'halfspace';
  /** A hull's or a one-triangle mesh's is `[row]`, and a hull's `[row, border]` when it has a border. */
  size: readonly number[];
  /** Where the shape sits in the query's frame, before its position and rotation (default the origin, no turn). */
  placed?: { offset: readonly [number, number, number]; turn: readonly [number, number, number, number] };
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
/** One manifold of two colliders: the normal from the first to the second and up to four points. */
export interface KernelManifold {
  normal: [number, number, number];
  points: { onA: [number, number, number]; onB: [number, number, number]; separation: number; id: number }[];
}
/** The distance between two colliders (0 when they overlap) and the nearest point on each. */
export interface KernelDistance {
  distance: number;
  pointA: [number, number, number];
  pointB: [number, number, number];
}
const QUERY_KINDS = { ball: 0, box: 1, capsule: 2, hull: 3, trimesh: 4, cylinder: 6, cone: 7, halfspace: 8 } as const;
const castBits = (cast: KernelCastOptions): number => (cast.stop ? 1 : 0) | (cast.geometry ? 2 : 0);
const PAIR_REFUSED =
  'A pair query needs two colliders that are in the world, and a prediction of 0 or more; pass rows addCollider returned.';
const CAST_REFUSED =
    'A shape query needs a finite position, a nonzero rotation, a finite nonzero direction, a target distance of 0 or more and a ball, box, capsule, cylinder, cone or hull row; pass those.',
  POINT_REFUSED = 'A point query needs a finite point; pass three finite numbers.';

/**
 * How two colliders mix a value, as Rapier's `CoefficientCombineRule`. When their rules differ the pair takes the higher:
 * geometricMean (the square root of the product, 0 if either is 0), clampedSum (the sum, at most 1), max, multiply, min, average.
 */
export type KernelCombine = 'average' | 'min' | 'multiply' | 'max' | 'clampedSum' | 'geometricMean';
/** The rules in the order of their codes, the order of their precedence too. */
export const combines: readonly KernelCombine[] = ['average', 'min', 'multiply', 'max', 'clampedSum', 'geometricMean'];

/**
 * The COLLIDER_COMBINE word of a friction rule and a restitution rule: each rule's low two bits sit in bits 0 and 1 (friction)
 * and 2 and 3 (restitution), the third bit of each in bits 4 and 5.
 */
export const combineBits = (friction: number, restitution: number): number =>
  (friction & 3) | ((restitution & 3) << 2) | ((friction & 4) << 2) | ((restitution & 4) << 3);
/** The friction rule (`restitution` false) or restitution rule of a COLLIDER_COMBINE word. */
export const combineRule = (bits: number, restitution: boolean): number =>
  restitution ? ((bits >> 2) & 3) | ((bits >> 3) & 4) : (bits & 3) | ((bits >> 2) & 4);

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
  /** A box's or hull's border: every point within it of the shape, outside its size (default 0). Its mass stays the core's. */
  border?: number;
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

// The blueprint (the deflated kernel and its column table) is a chunk of its own: an app that imports the entry but never
// calls `Physics.load()` does not download it.
let kernelColumns: readonly (readonly [string, 'f' | 'u', number])[] = [];
const compiled = new LoadOnce<WebAssembly.Module>(async () => {
  const blueprint = await import('./wasm.js');
  kernelColumns = blueprint.kernelColumns;
  const bytes = Uint8Array.from(atob(blueprint.wasmBase64), (c) => c.charCodeAt(0));
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

/** The solver settings of {@link KernelWorld.setSolver}. */
export interface KernelSolverOptions {
  contactHertz?: number;
  contactDamping?: number;
  contactMaxPush?: number;
  allowedPenetration?: number;
  jointShare?: number;
  jointLooseShare?: number;
  jointMaxPush?: number;
  warmStart?: number;
  /** The share of each joint impulse carried from a step to the next, from 0 to 1 (default 1). */
  warmStartJoints?: number;
  /** One cap on every dynamic body's linear speed, in m/s; 0 is none (default). A lower cap of a body still wins. */
  maxLinearSpeed?: number;
  /** A contact stiffness of its own for contacts with a fixed or kinematic body, in hertz; 0 is the same as `contactHertz` (default). */
  staticContactHertz?: number;
  /** The damping ratio of {@link KernelSolverOptions.staticContactHertz}. */
  staticContactDamping?: number;
}

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
  private filter: ((a: number, b: number) => boolean | 'noForces') | null = null;
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
    this.api = new WebAssembly.Instance(module, {
      env: {
        contact_filter: (a: number, b: number) => this.ask(a, b),
        contact_modify: (row: number) => this.modifyRow(row),
        // Times the phases of a step. Nothing in the world reads it back, so it is not part of a snapshot or the hash.
        clock,
      },
    }).exports as KernelExports;
    if (!Number.isSafeInteger(bodies) || !Number.isSafeInteger(colliders) || !this.api.world_new(bodies, colliders))
      throw new RangeError(
        `Bodies and colliders must be integers from 1 to 4194304; use a smaller world (got ${bodies}, ${colliders}).`,
      );
    this.bind();
  }

  private modifier: ((row: number) => void) | null = null;
  /** Calls `modifier` with a pair's row, after its friction and bounce are set and before it is solved, for each pair with a collider that has `COLLIDER_MODIFY` set; null stops. */
  setContactModifier(modifier: ((row: number) => void) | null): void {
    this.modifier = modifier;
  }
  private modifyRow(row: number): void {
    if (this.api.world_layout() !== this.layout) this.bind();
    this.modifier?.(row);
  }
  /** The step asks about a pair. Finding pairs can have grown the world, and a filter may read the columns. */
  private ask(a: number, b: number): number {
    if (this.api.world_layout() !== this.layout) this.bind();
    const answer = this.filter!(a, b);
    return answer === 'noForces' ? 2 : answer ? 1 : 0;
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
   * Decides each pair of collider rows the step looks at; false keeps them from touching, sensor pairs too, and 'noForces'
   * finds their contacts and fires their events but pushes nothing, as Rapier's hook answering with no solver flags. It runs inside
   * the step, so it may read the world and must not change it. Null, the default, asks nothing.
   */
  set contactFilter(filter: ((a: number, b: number) => boolean | 'noForces') | null) {
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
  /** The solver settings, with the defaults and units {@link KernelWorld.setSolver} documents. */
  get solver(): Required<KernelSolverOptions> {
    const read = (index: number): number => this.api.world_solver(index);
    return {
      contactHertz: read(0),
      contactDamping: read(1),
      contactMaxPush: read(2),
      allowedPenetration: read(3),
      jointShare: read(4),
      jointLooseShare: read(5),
      jointMaxPush: read(6),
      warmStart: read(7),
      warmStartJoints: read(8),
      maxLinearSpeed: read(9),
      staticContactHertz: read(10),
      staticContactDamping: read(11),
    };
  }
  /**
   * Tunes the solver; leave out what stays. Contacts are soft constraints (Catto 2011): `contactHertz` is their stiffness as
   * a frequency (default 120, held under an eighth of the substep rate) and `contactDamping` their damping ratio (default
   * 10); `contactMaxPush` is the fastest a depth is pushed out, in m/s (default 3), and `allowedPenetration` the depth left
   * alone, in metres (default 0.0002). Joints close `jointShare` of an error a substep where the solve is exact (default 1,
   * from 0 to 1) and `jointLooseShare` where they meet in a branch or a ring (default 0.2), at most `jointMaxPush` units a
   * second (default 3). `warmStart` is the share of each carried contact impulse kept at the start of a substep, from 0 (a cold
   * start) to 1 (all, the default). A value takes effect at the next step and is part of a {@link KernelWorld.snapshot}.
   * @throws RangeError when a value is not finite, or outside its range.
   */
  setSolver(options: KernelSolverOptions): this {
    const names: readonly (readonly [keyof KernelSolverOptions, number, number])[] = [
      ['contactHertz', 0, Infinity],
      ['contactDamping', 0, Infinity],
      ['contactMaxPush', 0, Infinity],
      ['allowedPenetration', 0, Infinity],
      ['jointShare', 0, 1],
      ['jointLooseShare', 0, 1],
      ['jointMaxPush', 0, Infinity],
      ['warmStart', 0, 1],
      ['warmStartJoints', 0, 1],
      ['maxLinearSpeed', 0, Infinity],
      ['staticContactHertz', 0, Infinity],
      ['staticContactDamping', 0, Infinity],
    ];
    names.forEach(([name, low, high]) => {
      const value = options[name];
      if (value === undefined) return;
      if (!(value >= low && value <= high) || Number.isNaN(value) || value === Infinity)
        throw new RangeError(
          `Solver ${name} must be a finite number from ${low} to ${high === Infinity ? 'any size' : high}; got ${value}.`,
        );
    });
    names.forEach(([name], index) => {
      if (options[name] !== undefined) this.api.world_set_solver(index, options[name]);
    });
    return this;
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
  /** How far apart two shapes may be, in metres, and still have contacts made (default 0.04), Rapier's `predictionDistance`. */
  get predictionDistance(): number {
    return this.api.world_prediction();
  }
  /**
   * Sets how far apart two shapes may be and still have contacts made, in metres: a contact inside it is speculative, kept
   * from sinking in but pushing nothing until the shapes close. A larger distance finds contacts earlier and costs more
   * pairs; every box is fitted again at the next step.
   * @throws RangeError unless it is finite and between 0 and 1,000,000.
   */
  setPredictionDistance(distance: number): this {
    if (!this.api.world_set_prediction(distance))
      throw new RangeError(
        `The prediction distance is a length from 0 to 1,000,000 metres (got ${distance}); 0.04 is the default.`,
      );
    return this;
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
      throw new RangeError(
        `Sleep needs a finite energy and time, not negative; the defaults are 0.0002 and 0.5 (got ${energy}, ${time}).`,
      );
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
  /**
   * How long the phases of the last step took, in milliseconds, as Rapier's `timingStep` and its siblings do: `step` is the
   * whole of it, then `begin` (impulses land, kinematic targets are read), `broad` phase, `narrow` phase, `islands`,
   * `solver` (contact and joint rows and every substep), `ccd` and `events`. The phases add up to `step`, bar the clock's
   * own calls. All zero before the first step. A reading is not part of the world: a snapshot and the hash leave it out.
   */
  get timing(): {
    step: number;
    begin: number;
    broad: number;
    narrow: number;
    islands: number;
    solver: number;
    ccd: number;
    events: number;
  } {
    const read = (phase: number): number => this.api.world_timing(phase);
    return {
      step: read(0),
      begin: read(1),
      broad: read(2),
      narrow: read(3),
      islands: read(4),
      solver: read(5),
      ccd: read(6),
      events: read(7),
    };
  }
  /**
   * How many continuous-collision passes a step may make (default 1), Rapier's `maxCcdSubsteps`: 0 turns CCD off for the
   * whole world, whatever bodies ask for. The kernel resolves a body's whole sweep in the one pass, so a number above 1 finds
   * nothing more and is the same as 1. Part of a snapshot.
   * @throws RangeError unless a whole number from 0 to 65535.
   */
  get maxCcdSubsteps(): number {
    return this.api.world_ccd() >>> 0;
  }
  set maxCcdSubsteps(substeps: number) {
    if (!Number.isInteger(substeps) || substeps < 0 || substeps > 65535)
      throw new RangeError(
        `maxCcdSubsteps must be a whole number from 0 to 65535; use 0 to turn CCD off (got ${substeps}).`,
      );
    this.api.world_set_ccd(substeps);
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
      throw new RangeError(
        `Substeps must be a whole number from 1 to 65535; use 8 unless you measured (got ${substeps}).`,
      );
    this.api.world_set_substeps(substeps);
  }
  /** Solver passes in each substep (default 2). More holds a tall stack stiffer, at that much more solver time. */
  get iterations(): number {
    return this.api.world_iterations();
  }
  set iterations(iterations: number) {
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 0xffff)
      throw new RangeError(
        `Iterations must be a whole number from 1 to 65535; use 2 unless you measured (got ${iterations}).`,
      );
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
   * cylinder's or cone's `[radius, halfHeight, borderRadius]` along local Y (border 0 for a sharp one), a hull's `[row]`,
   * a triangle mesh's `[row]` (no volume, so no mass).
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
    const { border } = options;
    if (
      border !== undefined &&
      !(
        border >= 0 &&
        Number.isFinite(border) &&
        (border === 0 || shape === 'box' || shape === 'hull' || shape === 'trimesh')
      )
    )
      throw new RangeError(
        `A border is 0 or more and finite, and only a box, hull or single triangle takes one here (got ${border} on a ${shape}).`,
      );
    const row = this.place(body, spec[0], size, options);
    if (border) this.api.collider_set_border(row, border);
    return row;
  }

  /**
   * Adds a compound collider: convex children welded into one collider, with one row, one pair against each other
   * collider and one set of events, as Rapier's compound shape is. Its density is every child's. The body's mass, centre and
   * inertia are worked out again, so read views from `columns` after this call.
   * @param parts At least one ball, box, capsule, cylinder, cone or hull, each placed in the compound's frame.
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
        spec = Object.hasOwn(shapes, shape) ? shapes[shape as KernelShape] : undefined;
      if (!spec)
        throw new RangeError(
          `A compound part is a ball, box, capsule, cylinder, cone, hull, half space or mesh row (got ${String(part?.shape)}); pass one of those.`,
        );
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
      let child = add();
      if (child < 0) {
        this.reserve(this.capacity, this.colliderCapacity * 2);
        child = add();
      }
      if (part.border && !this.api.collider_set_part_border(row, child, part.border))
        throw new RangeError(
          `A compound part's border is 0 or more, and only a box or hull part takes one (got ${part.border} on a ${part.shape}).`,
        );
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
    } else if (shape === 'cylinder' || shape === 'cone') {
      if (
        !Array.isArray(size) ||
        size.length !== 3 ||
        !size.every(Number.isFinite) ||
        !(size[0] > 0 && size[1] > 0 && size[2] >= 0)
      )
        throw new RangeError(
          `A ${shape} needs [radius, halfHeight, borderRadius], the first two above zero and the border 0 or more (got ${String(size)}).`,
        );
    } else if (shape === 'halfspace') {
      // A unit normal: its square within 0.2% of 1.
      const squared =
        Array.isArray(size) && size.length === 3 && size.every(Number.isFinite)
          ? size[0]! * size[0]! + size[1]! * size[1]! + size[2]! * size[2]!
          : NaN;
      if (!(squared > 0.998 && squared < 1.002))
        throw new RangeError(`A halfspace needs [x, y, z], the unit normal out of the solid (got ${String(size)}).`);
    } else if (shape === 'capsule') {
      // A radius of 0 is a segment: no volume, and it touches, is cast and is hit as the line it is.
      if (!Array.isArray(size) || size.length !== 2 || !size.every(Number.isFinite) || !(size[0] >= 0 && size[1] > 0))
        throw new RangeError(
          `A capsule needs [radius, halfLength], the radius 0 or more and the half length above zero (got ${String(size)}).`,
        );
    } else if (
      !Array.isArray(size) ||
      size.length !== numbers ||
      !size.every((value) => value > 0 && Number.isFinite(value))
    )
      throw new RangeError(`A ${shape} needs ${numbers} finite sizes above zero (got ${String(size)}).`);
  }

  private checkPose(position: readonly number[], rotation: readonly number[]): void {
    if (![...position, ...rotation].every(Number.isFinite))
      throw new RangeError('A collider pose must be finite; check what fed it.');
    const [qx, qy, qz, qw] = rotation,
      squared = qx * qx + qy * qy + qz * qz + qw * qw;
    if (!(squared >= 0.998001 && squared <= 1.002001))
      throw new RangeError(
        `A collider rotation must be a unit quaternion; normalize it (its length squared is ${squared}).`,
      );
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
      throw new RangeError(
        `Restitution must be from 0 to 1, as a contact cannot give back more than it took (got ${restitution}).`,
      );
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
    colliderCombine[row] = combineBits(frictionRule, restitutionRule);
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
      throw new RangeError(
        `Memory cannot hold a hull of ${vertices.length} vertices; free another world, or simplify the hull.`,
      );
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
        if (!Number.isInteger(index) || index < 0)
          throw new RangeError(
            `A hull face index must be a whole number; use a place in the vertex list (got ${index}).`,
          );
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
      { fixInternalEdges = false, oriented = false, deformable = false, solid = false } = options,
      count = vertices.length / 3,
      triangles = indices.length / 3;
    if (!Number.isInteger(count) || !Number.isInteger(triangles))
      throw new RangeError(
        `A trimesh takes three numbers a vertex and three indices a triangle (got ${vertices.length} and ${indices.length}); pass whole vertices and whole triangles.`,
      );
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i];
      if (!Number.isInteger(index) || index < 0 || index >= count)
        throw new RangeError(`Trimesh index ${i} is ${index}; use a place in the vertex list, from 0 to ${count - 1}.`);
    }
    // The edges' neighbours serve only the internal edge rule, so a mesh without it skips finding them.
    const across = fixInternalEdges ? trianglesAcross(vertices, indices) : null;
    if (!api.mesh_begin(deformable ? 3 * count : count, triangles))
      throw new RangeError(
        `Memory cannot hold a trimesh of ${triangles} triangles; free another world, or simplify the mesh.`,
      );
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
    const row = api.mesh_end(
      count,
      triangles,
      (fixInternalEdges ? 1 : 0) | (oriented ? 4 : 0) | (deformable ? 8 : 0) | (solid ? 32 : 0),
    );
    if (row < 0) throw new RangeError(`This trimesh was refused; fix what this says: ${meshErrors[row]}.`);
    this.meshRows = row + 1;
    return row;
  }
  /**
   * Follows the vertices of a deformable trimesh collider's mesh, written into the mesh's vertex rows, with no rebuild: every
   * node's box is refit once, edge classes and bounds are recomputed, the broad phase is told, what rests on it wakes, and
   * contacts reach `motion` (how far the farthest vertex moved) further until the next refit.
   * @returns The nodes it touched, each once.
   * @throws RangeError for a collider that is not a deformable trimesh or a vertex that is not finite.
   */
  refitCollider(collider: number, motion: number): number {
    const touched = this.api.collider_refit(collider, motion);
    if (touched < 0)
      throw new RangeError(
        `Collider ${collider} cannot be refit (code ${touched}); it must be a trimesh made with deformable: true, with finite vertices.`,
      );
    return touched;
  }
  /**
   * Aims a deformable trimesh collider's mesh at the targets written into the second block of its vertex rows and the
   * velocities in the third (each `vertexCount` rows after the one before): the next step's contacts see the surface where it
   * is, each vertex moving at its velocity (friction, bounce and sweeping count it), and the end of that step lands the mesh
   * on its targets with one refit. `motion` is how far the farthest vertex goes.
   * @throws RangeError for a collider that is not a deformable trimesh or a number that is not finite.
   */
  aimCollider(collider: number, motion: number): void {
    const code = this.api.collider_aim(collider, motion);
    if (code < 0)
      throw new RangeError(
        `Collider ${collider} cannot be aimed (code ${code}); it must be a trimesh made with deformable: true, with finite vertices.`,
      );
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
      { fixInternalEdges = false, cellStatus } = options;
    if (
      !Number.isInteger(rows) ||
      !Number.isInteger(columns) ||
      rows < 1 ||
      columns < 1 ||
      2 * rows * columns >= 0xffffffff
    )
      throw new RangeError(
        `A heightfield takes whole rows and columns of cells from 1 up, under 2^31 cells (got ${rows} and ${columns}); pass the cells along z and along x.`,
      );
    const count = (rows + 1) * (columns + 1);
    if (heights.length !== count)
      throw new RangeError(
        `A heightfield of ${rows} by ${columns} cells takes (rows + 1) * (columns + 1) = ${count} heights (got ${heights.length}); pass one a grid point, column major.`,
      );
    if (scale.length !== 3 || !scale.every((value) => value > 0 && Number.isFinite(value)))
      throw new RangeError(
        `A heightfield scale is three finite sizes above zero (got ${scale.join(', ')}); pass the field's width, height factor and depth.`,
      );
    for (let i = 0; i < count; i++)
      if (!Number.isFinite(heights[i]))
        throw new RangeError(`Heightfield height ${i} is ${heights[i]}; pass finite heights.`);
    if (cellStatus !== undefined) {
      if (cellStatus.length !== rows * columns)
        throw new RangeError(
          `A heightfield of ${rows} by ${columns} cells takes ${rows * columns} cell statuses (got ${cellStatus.length}); pass one a cell, row r of column c at r + rows * c.`,
        );
      for (let i = 0; i < cellStatus.length; i++)
        if (!Number.isInteger(cellStatus[i]) || cellStatus[i] < 0 || cellStatus[i] > 7)
          throw new RangeError(
            `Cell status ${i} is ${cellStatus[i]}; use 0 to 7: 1 splits the cell the other way, 2 removes its left triangle, 4 its right one.`,
          );
    }
    if (!api.mesh_begin(count, 0) || !api.voxels_begin(rows * columns))
      throw new RangeError(
        `Memory cannot hold a heightfield of ${count} points; free another world, or use fewer cells.`,
      );
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
    const words = this.columns.voxelWord,
      first = api.mesh_next(3);
    if (cellStatus)
      for (let i = 0; i < cellStatus.length; i++) words[first + (i >>> 2)] |= cellStatus[i] << (8 * (i & 3));
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
      throw new RangeError(
        `Voxel cells are an Int32Array of x, y, z cell coordinates, three per cell (got ${cells?.length} numbers); pass whole cells.`,
      );
    if (size.length !== 3 || !size.every((value) => value > 0 && Number.isFinite(value)))
      throw new RangeError(
        `A voxel size is three finite sizes above zero (got ${size.join(', ')}); pass one cell's width, height and depth.`,
      );
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
      throw new RangeError(
        `A voxel grid spans at most 2^30 cells of its box (these span ${count}); split the world into chunks, one grid each.`,
      );
    if (!api.voxels_begin(count))
      throw new RangeError(
        `Memory cannot hold a voxel grid of ${count} cells; free another world, or split the grid into chunks.`,
      );
    if (api.world_layout() !== this.layout) this.bind();
    const words = this.columns.voxelWord,
      first = api.mesh_next(3);
    for (let i = 0; i < cells.length; i += 3) {
      const index = cells[i] - low[0] + dims[0] * (cells[i + 1] - low[1] + dims[1] * (cells[i + 2] - low[2]));
      words[first + (index >>> 2)] |= 1 << (8 * (index & 3));
    }
    const row = api.voxels_end(low[0], low[1], low[2], dims[0], dims[1], dims[2], size[0], size[1], size[2]);
    if (row < 0)
      throw new RangeError(
        'This voxel grid was refused; pass cells whose box fits 32-bit cell numbers, and a positive size.',
      );
    this.meshRows = row + 1;
    return row;
  }
  /** Sets the upper halves of the groups of the next queries that carry QUERY_WIDE_GROUPS. */
  setQueryGroupsHi(hi: number): void {
    this.api.query_groups_hi(hi >>> 0);
  }
  /**
   * Sets the status of cell (row, column) of a heightfield collider in place (see {@link KernelHeightfieldOptions.cellStatus}),
   * and wakes what touches it.
   * @throws RangeError for a collider that is no heightfield, a cell off it or a status above 7.
   */
  setCellStatus(collider: number, row: number, column: number, status: number): void {
    if (!Number.isInteger(status) || !this.api.mesh_set_cell(collider, row >>> 0, column >>> 0, status))
      throw new RangeError(
        `Cell (${row}, ${column}) with status ${status} cannot be set: the collider must be a heightfield, the cell on it and the status 0 to 7 (1 splits the cell the other way, 2 removes its left triangle, 4 its right one).`,
      );
  }
  /** The status of cell (row, column) of a heightfield collider; 0 for a cell off it. */
  cellStatus(collider: number, row: number, column: number): number {
    return this.api.mesh_cell(collider, row >>> 0, column >>> 0);
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
  propagateVoxel(
    a: number,
    b: number,
    at: readonly [number, number, number],
    shift: readonly [number, number, number],
  ): void {
    this.voxelDone(
      this.api.voxels_propagate(a, b, at[0], at[1], at[2], shift[0], shift[1], shift[2]),
      'propagateVoxelChange',
    );
  }
  /**
   * The nearest ray hit among the colliders the filter words let through, or null. The direction need not be unit
   * length; `distance` is along its unit. Words: `flags` (QUERY_ bits), `groups` (packed, as `collisionGroups`), and a
   * collider row and a body row to leave out (0xffffffff for none).
   * @throws RangeError for an origin or direction that is not finite, or a zero direction.
   */
  raycast(
    origin: readonly number[],
    direction: readonly number[],
    max: number,
    solid: boolean,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): KernelRayHit | null {
    const found = this.api.query_ray(
      origin[0]!,
      origin[1]!,
      origin[2]!,
      direction[0]!,
      direction[1]!,
      direction[2]!,
      max,
      solid ? 1 : 0,
      flags,
      groups,
      collider,
      body,
    );
    if (found < 0)
      throw new RangeError('A ray needs a finite origin and a finite, nonzero direction; pass three numbers for each.');
    return found ? this.readHit(0) : null;
  }
  /**
   * Each collider's ray hit, in row order (not sorted), with the same words as {@link KernelWorld.raycast}.
   * @throws RangeError for an origin or direction that is not finite, or a zero direction.
   */
  raycastAll(
    origin: readonly number[],
    direction: readonly number[],
    max: number,
    solid: boolean,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): KernelRayHit[] {
    const hits: KernelRayHit[] = [];
    for (let skip = 0, total = 1; skip < total; ) {
      total = this.api.query_ray_all(
        origin[0]!,
        origin[1]!,
        origin[2]!,
        direction[0]!,
        direction[1]!,
        direction[2]!,
        max,
        solid ? 1 : 0,
        flags,
        groups,
        collider,
        body,
        skip,
      );
      if (total < 0)
        throw new RangeError(
          'A ray needs a finite origin and a finite, nonzero direction; pass three numbers for each.',
        );
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
    const found = this.api.query_shape_cast(
      ...this.shapeWords(shape, position, rotation),
      direction[0]!,
      direction[1]!,
      direction[2]!,
      cast.max,
      cast.target,
      castBits(cast),
      flags,
      groups,
      collider,
      body,
    );
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
      total = this.api.query_shape_cast_all(
        ...words,
        direction[0]!,
        direction[1]!,
        direction[2]!,
        cast.max,
        cast.target,
        castBits(cast),
        flags,
        groups,
        collider,
        body,
        skip,
      );
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
  projectPoint(
    point: readonly number[],
    solid: boolean,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): KernelProjection | null {
    const found = this.api.query_project_point(
      point[0]!,
      point[1]!,
      point[2]!,
      solid ? 1 : 0,
      flags,
      groups,
      collider,
      body,
    );
    if (found < 0) throw new RangeError(POINT_REFUSED);
    return found ? this.readProjection(0) : null;
  }
  /** Each collider's nearest point to `point`, in row order, as {@link KernelWorld.projectPoint}. */
  projectPointAll(
    point: readonly number[],
    solid: boolean,
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): KernelProjection[] {
    const hits: KernelProjection[] = [];
    for (let skip = 0, total = 1; skip < total; ) {
      total = this.api.query_project_point_all(
        point[0]!,
        point[1]!,
        point[2]!,
        solid ? 1 : 0,
        flags,
        groups,
        collider,
        body,
        skip,
      );
      if (total < 0) throw new RangeError(POINT_REFUSED);
      const page = total - skip < QUERY_HITS ? total - skip : QUERY_HITS;
      for (let i = 0; i < page; i++) hits.push(this.readProjection(i));
      skip += page;
    }
    return hits;
  }
  /** The collider rows that hold `point`, in row order. @throws RangeError for a point that is not finite. */
  intersectPoint(point: readonly number[], flags: number, groups: number, collider: number, body: number): number[] {
    return this.rows(
      (skip) => this.api.query_point_all(point[0]!, point[1]!, point[2]!, flags, groups, collider, body, skip),
      POINT_REFUSED,
    );
  }
  /** The collider rows a query shape at a pose overlaps, in row order. @throws RangeError as {@link KernelWorld.shapeCast}. */
  intersectShape(
    shape: KernelQueryShape,
    position: readonly number[],
    rotation: readonly number[],
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): number[] {
    const words = this.shapeWords(shape, position, rotation);
    return this.rows((skip) => this.api.query_shape_all(...words, flags, groups, collider, body, skip), CAST_REFUSED);
  }
  /**
   * The tight box of a collider's shape at its body's pose, with no margin: `[low, high]`, or null for a collider that is gone.
   */
  /**
   * The tight box of a collider as if its body stood at `position` turned by the unit quaternion `rotation`, nothing in the
   * world moved. Null when the collider is gone.
   */
  colliderAabbAt(
    collider: number,
    position: readonly number[],
    rotation: readonly number[],
  ): [[number, number, number], [number, number, number]] | null {
    if (
      !this.api.collider_aabb_at(
        collider,
        position[0]!,
        position[1]!,
        position[2]!,
        rotation[0]!,
        rotation[1]!,
        rotation[2]!,
        rotation[3]!,
      )
    )
      return null;
    const f = new Float32Array(this.api.memory.buffer, this.api.query_buffer(), 6);
    return [
      [f[0]!, f[1]!, f[2]!],
      [f[3]!, f[4]!, f[5]!],
    ];
  }
  colliderAabb(collider: number): [[number, number, number], [number, number, number]] | null {
    if (!this.api.collider_aabb(collider)) return null;
    const f = new Float32Array(this.api.memory.buffer, this.api.query_buffer(), 6);
    return [
      [f[0]!, f[1]!, f[2]!],
      [f[3]!, f[4]!, f[5]!],
    ];
  }
  /**
   * Gives a live collider another shape, as {@link KernelWorld.addCollider} takes `shape` and `size`: what it touched ends,
   * its border goes and the body's mass is worked out again, so read views from `columns` after this call.
   * @throws RangeError for a collider that is gone or a compound, or a shape or size the kernel cannot use.
   */
  setColliderShape(collider: number, shape: KernelShape, size: readonly number[]): void {
    const spec = Object.hasOwn(shapes, shape) ? shapes[shape] : undefined;
    if (!spec) throw new RangeError(`Unknown shape ${String(shape)}; use one of ${Object.keys(shapes).join(', ')}.`);
    this.checkSize(shape, size);
    if (!this.api.collider_set_shape(collider, spec[0], size[0] ?? 0, size[1] ?? 0, size[2] ?? 0))
      throw new RangeError(
        `Row ${collider} holds no collider that can change shape (a compound cannot); use a row addCollider returned.`,
      );
  }
  /** Gives a box or hull a border (see {@link KernelColliderOptions.border}). @throws RangeError for a collider that cannot have one. */
  setColliderBorder(collider: number, border: number): void {
    if (!this.api.collider_set_border(collider, border))
      throw new RangeError(
        `Row ${collider} holds no box or hull that can have a border of ${border}; use a row addCollider returned and a border of 0 or more.`,
      );
  }
  /**
   * Moves a live collider in its body's frame and works the body's mass out again.
   * @throws RangeError for a collider that is gone, a position that is not finite or a rotation that is not a unit quaternion.
   */
  setColliderPose(collider: number, position: readonly number[], rotation: readonly number[]): void {
    this.checkPose(position, rotation);
    if (
      !this.api.collider_set_pose(
        collider,
        position[0]!,
        position[1]!,
        position[2]!,
        rotation[0]!,
        rotation[1]!,
        rotation[2]!,
        rotation[3]!,
      )
    )
      throw new RangeError(`Row ${collider} holds no collider; use a row addCollider returned.`);
  }
  /** The collider rows whose tight box meets the box `low` to `high`, in row order. @throws RangeError for a box that is not finite or is inside out. */
  intersectAabb(
    low: readonly number[],
    high: readonly number[],
    flags: number,
    groups: number,
    collider: number,
    body: number,
  ): number[] {
    return this.rows(
      (skip) =>
        this.api.query_aabb(
          low[0]!,
          low[1]!,
          low[2]!,
          high[0]!,
          high[1]!,
          high[2]!,
          flags,
          groups,
          collider,
          body,
          skip,
        ),
      'A box query needs finite corners with low at or under high on every axis; pass [x, y, z] corners.',
    );
  }
  /** A ray against one collider: the hit, or null. @throws RangeError for a ray that is not finite and nonzero, or a collider that is gone. */
  colliderRay(
    collider: number,
    origin: readonly number[],
    direction: readonly number[],
    max: number,
    solid: boolean,
  ): KernelRayHit | null {
    const found = this.api.collider_ray(
      collider,
      origin[0]!,
      origin[1]!,
      origin[2]!,
      direction[0]!,
      direction[1]!,
      direction[2]!,
      max,
      solid ? 1 : 0,
    );
    if (found < 0)
      throw new RangeError(`${PAIR_REFUSED} A ray also needs a finite origin and a finite nonzero direction.`);
    return found ? this.readHit(0) : null;
  }
  /** The point of one collider nearest `point`: null when nothing can be projected. @throws RangeError for a point that is not finite or a collider that is gone. */
  colliderProject(collider: number, point: readonly number[], solid: boolean): KernelProjection | null {
    const found = this.api.collider_project(collider, point[0]!, point[1]!, point[2]!, solid ? 1 : 0);
    if (found < 0) throw new RangeError(`${PAIR_REFUSED} A point also needs three finite numbers.`);
    return found ? this.readProjection(0) : null;
  }
  /** A shape cast against one collider, or null. @throws RangeError as {@link KernelWorld.shapeCast}, or for a collider that is gone. */
  colliderShapeCast(
    collider: number,
    shape: KernelQueryShape,
    position: readonly number[],
    rotation: readonly number[],
    direction: readonly number[],
    cast: KernelCastOptions,
  ): KernelShapeCastHit | null {
    const found = this.api.collider_shape_cast(
      collider,
      ...this.shapeWords(shape, position, rotation),
      direction[0]!,
      direction[1]!,
      direction[2]!,
      cast.max,
      cast.target,
      castBits(cast),
    );
    if (found < 0) throw new RangeError(CAST_REFUSED);
    return found ? this.readCast(0) : null;
  }
  /** Whether a query shape at a pose overlaps one collider. @throws RangeError as {@link KernelWorld.shapeCast}, or for a collider that is gone. */
  colliderOverlaps(
    collider: number,
    shape: KernelQueryShape,
    position: readonly number[],
    rotation: readonly number[],
  ): boolean {
    const found = this.api.collider_overlaps(collider, ...this.shapeWords(shape, position, rotation));
    if (found < 0) throw new RangeError(CAST_REFUSED);
    return found === 1;
  }
  /** Whether two colliders overlap now. @throws RangeError for a collider row that is gone. */
  pairIntersects(a: number, b: number): boolean {
    const found = this.api.pair_intersects(a, b);
    if (found < 0) throw new RangeError(PAIR_REFUSED);
    return found === 1;
  }
  /**
   * The manifolds of two colliders within `prediction` of touching, normals from `a` to `b`: one for convex colliders, one a
   * pair of children for a compound, one a triangle or cell for a mesh (up to 56).
   * @throws RangeError for a collider row that is gone or a prediction that is negative or not finite.
   */
  pairContacts(a: number, b: number, prediction: number): KernelManifold[] {
    const total = this.api.pair_contacts(a, b, prediction);
    if (total < 0) throw new RangeError(PAIR_REFUSED);
    return this.readManifolds(total);
  }
  private readManifolds(total: number): KernelManifold[] {
    const kept = total < 56 ? total : 56,
      words = new Uint32Array(this.api.memory.buffer, this.api.query_buffer(), 36 * kept),
      f = new Float32Array(words.buffer, words.byteOffset, 36 * kept),
      manifolds: KernelManifold[] = [];
    for (let m = 0; m < kept; m++) {
      const at = 36 * m,
        points: KernelManifold['points'] = [];
      for (let k = 0; k < words[at + 3]!; k++) {
        const p = at + 4 + 8 * k;
        points.push({
          onA: [f[p]!, f[p + 1]!, f[p + 2]!],
          onB: [f[p + 3]!, f[p + 4]!, f[p + 5]!],
          separation: f[p + 6]!,
          id: words[p + 7]!,
        });
      }
      manifolds.push({ normal: [f[at]!, f[at + 1]!, f[at + 2]!], points });
    }
    return manifolds;
  }
  /**
   * The manifolds of a collider and a query shape within `prediction` of touching, normals from the collider to the shape.
   * @throws RangeError for a collider that is gone, a shape or pose the kernel refuses, or a prediction below 0.
   */
  colliderShapeContacts(
    collider: number,
    shape: KernelQueryShape,
    position: readonly number[],
    rotation: readonly number[],
    prediction: number,
  ): KernelManifold[] {
    const total = this.api.collider_shape_contacts(collider, ...this.shapeWords(shape, position, rotation), prediction);
    if (total < 0)
      throw new RangeError(
        `${PAIR_REFUSED} ${CAST_REFUSED} Pass a live collider row and a query shape the kernel holds.`,
      );
    return this.readManifolds(total);
  }
  /** The first touch of collider `moving`, as it is, moving along `direction` with collider `target`, or null. @throws RangeError for a collider that is gone. */
  colliderCastCollider(
    moving: number,
    target: number,
    direction: readonly number[],
    cast: KernelCastOptions,
  ): KernelShapeCastHit | null {
    const found = this.api.collider_cast_collider(
      moving,
      target,
      direction[0]!,
      direction[1]!,
      direction[2]!,
      cast.max,
      cast.target,
      castBits(cast),
    );
    if (found < 0)
      throw new RangeError(
        `${PAIR_REFUSED} A cast also needs a finite nonzero direction and a target distance of 0 or more.`,
      );
    return found ? this.readCast(0) : null;
  }
  /**
   * Gives a collider mass properties of its own in place of its shape's at its density, or takes them off (`mass` null); the
   * body's mass, centre and inertia are worked out again.
   * @throws RangeError for a collider that is gone, or a mass, centre, moments or frame that cannot be a body's.
   */
  setColliderMassProperties(
    collider: number,
    mass: number | null,
    center: readonly number[],
    inertia: readonly number[],
    frame: readonly number[],
  ): void {
    const ok = this.api.collider_set_mass_properties(
      collider,
      mass === null ? -1 : mass,
      center[0]!,
      center[1]!,
      center[2]!,
      inertia[0]!,
      inertia[1]!,
      inertia[2]!,
      frame[0]!,
      frame[1]!,
      frame[2]!,
      frame[3]!,
    );
    if (!ok)
      throw new RangeError(
        `Row ${collider} holds no collider, or its mass properties are not a body's: a finite mass of 0 or more, a finite centre, moments of 0 or more and a unit quaternion; pass a live collider row and those numbers.`,
      );
  }
  /** A collider's volume in cubic metres (0 for a mesh). @throws RangeError for a collider that is gone. */
  colliderVolume(collider: number): number {
    const volume = this.api.collider_volume(collider);
    if (volume < 0) throw new RangeError(PAIR_REFUSED);
    return volume;
  }
  /** The mass a collider adds to its body, in kilograms. @throws RangeError for a collider that is gone. */
  colliderMass(collider: number): number {
    const mass = this.api.collider_mass(collider);
    if (mass < 0) throw new RangeError(PAIR_REFUSED);
    return mass;
  }
  /** The distance between two colliders and the nearest point on each; null when none can be read. @throws RangeError for a collider row that is gone. */
  pairDistance(a: number, b: number): KernelDistance | null {
    const found = this.api.pair_distance(a, b);
    if (found < 0) throw new RangeError(PAIR_REFUSED);
    if (!found) return null;
    const f = new Float32Array(this.api.memory.buffer, this.api.query_buffer(), 7);
    return { distance: f[0]!, pointA: [f[1]!, f[2]!, f[3]!], pointB: [f[4]!, f[5]!, f[6]!] };
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
  private shapeWords(
    shape: KernelQueryShape,
    p: readonly number[],
    q: readonly number[],
  ): [number, number, number, number, number, number, number, number, number, number, number, number] {
    const s = shape.size,
      row = shape.shape === 'hull' || shape.shape === 'trimesh';
    let [px, py, pz, qx, qy, qz, qw] = [p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, q[3]!];
    if (shape.placed) {
      // The shape's own frame inside the query's: its offset turned by the query's rotation, and its turn after it.
      const [ox, oy, oz] = shape.placed.offset,
        [tx, ty, tz, tw] = shape.placed.turn,
        cx = 2 * (qy * oz - qz * oy),
        cy = 2 * (qz * ox - qx * oz),
        cz = 2 * (qx * oy - qy * ox);
      px += ox + qw * cx + qy * cz - qz * cy;
      py += oy + qw * cy + qz * cx - qx * cz;
      pz += oz + qw * cz + qx * cy - qy * cx;
      [qx, qy, qz, qw] = [
        qw * tx + qx * tw + qy * tz - qz * ty,
        qw * ty - qx * tz + qy * tw + qz * tx,
        qw * tz + qx * ty - qy * tx + qz * tw,
        qw * tw - qx * tx - qy * ty - qz * tz,
      ];
    }
    return [
      QUERY_KINDS[shape.shape],
      row ? (s[1] ?? 0) : s[0]!,
      row ? 0 : (s[1] ?? 0),
      row ? 0 : (s[2] ?? 0),
      row ? s[0]! : 0,
      px,
      py,
      pz,
      qx,
      qy,
      qz,
      qw,
    ];
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
  /**
   * The contacts of a batch of soft body particles with the colliders: for each particle of radius r that moves from one
   * position to another over a step, up to `k` colliders (at most {@link KernelWorld.probeDepth}), the deepest first, each as a
   * plane (the point on its surface and the normal out of it) with the depth to it, the velocity of its surface there (a rigid
   * body's, plus a deformable mesh's vertices') and the time of the touch. Every shape is met; sensors and disabled colliders
   * never are; groups and flags are honoured. A particle is swept, so a fast one never tunnels, and a collider within `margin`
   * past the radius of where it ends is listed even when it does not touch yet (depth negative), so one call a step serves the
   * substeps: apply each plane as a constraint with the surface moving at its velocity. Read and answered through two buffers in
   * the kernel's memory, up to {@link KernelWorld.probeCapacity} particles a call (more go in chunks).
   * @throws RangeError for arrays that are not the same length, a `k` out of range, or a number that is not finite.
   */
  softContacts(views: KernelParticleViews, k = 1, options: KernelProbeOptions = {}): KernelSoftContacts {
    const { from, to, radius, margin = 0, groups } = views;
    const count = from.length / 3;
    if (!Number.isInteger(count) || to.length !== from.length)
      throw new RangeError(
        `softContacts takes packed x, y, z for each particle in both arrays, the same number (got ${from.length} and ${to.length}); pass 3 numbers a particle.`,
      );
    for (const [name, value] of [
      ['radii', radius],
      ['margins', margin],
      ['groups words', groups],
    ] as const)
      if (value !== undefined && typeof value !== 'number' && value.length !== count)
        throw new RangeError(`softContacts got ${value.length} ${name} for ${count} particles; pass one or one each.`);
    if (this.api.world_layout() !== this.layout) this.bind();
    const depth = this.api.probe_depth();
    if (!Number.isInteger(k) || k < 1 || k > depth)
      throw new RangeError(`softContacts gives each particle 1 to ${depth} contacts; ${k} is out of that range.`);
    const capacity = this.api.probe_capacity(),
      slots = count * k,
      out: KernelSoftContacts = {
        k,
        collider: new Uint32Array(slots),
        body: new Uint32Array(slots),
        t: new Float32Array(slots),
        normal: new Float32Array(3 * slots),
        depth: new Float32Array(slots),
        point: new Float32Array(3 * slots),
        velocity: new Float32Array(3 * slots),
        started: new Uint8Array(slots),
        triangle: new Uint32Array(slots),
      };
    const { flags = 0, groups: shared, excludeBody = 0xffffffff, dt = 0 } = options;
    if (!(dt >= 0) || !Number.isFinite(dt))
      throw new RangeError(
        `softContacts takes a step length of zero or more seconds (got ${dt}); pass the step's dt, or leave it out.`,
      );
    const all = shared === undefined ? 0xffffffff : shared >>> 0;
    for (let start = 0; start < count; start += capacity) {
      const n = capacity < count - start ? capacity : count - start,
        input = new Float32Array(this.api.memory.buffer, this.api.probe_input(), 12 * n),
        words = new Uint32Array(input.buffer, input.byteOffset, 12 * n);
      for (let i = 0; i < n; i++) {
        const p = start + i,
          at = 12 * i;
        for (let axis = 0; axis < 3; axis++) {
          input[at + axis] = from[3 * p + axis]!;
          input[at + 3 + axis] = to[3 * p + axis]!;
        }
        input[at + 6] = typeof radius === 'number' ? radius : radius[p]!;
        input[at + 7] = typeof margin === 'number' ? margin : margin[p]!;
        words[at + 8] = groups ? groups[p]! >>> 0 : all;
        input[at + 9] = dt;
        input[at + 10] = input[at + 11] = 0;
        for (let j = 0; j < 8; j++)
          if (!Number.isFinite(input[at + j]!))
            throw new RangeError('softContacts needs finite positions, radii and margins.');
      }
      this.api.soft_probe(n, k, flags, excludeBody);
      const answer = new Uint32Array(this.api.memory.buffer, this.api.probe_output(), 16 * k * n),
        floats = new Float32Array(answer.buffer, answer.byteOffset, answer.length);
      for (let i = 0; i < n; i++)
        for (let slot = 0; slot < k; slot++) {
          const w = 16 * (k * i + slot),
            o = k * (start + i) + slot;
          out.collider[o] = answer[w]!;
          out.body[o] = answer[w + 1]!;
          out.t[o] = floats[w + 2]!;
          for (let axis = 0; axis < 3; axis++) {
            out.normal[3 * o + axis] = floats[w + 3 + axis]!;
            out.point[3 * o + axis] = floats[w + 7 + axis]!;
            out.velocity[3 * o + axis] = floats[w + 10 + axis]!;
          }
          out.depth[o] = floats[w + 6]!;
          out.started[o] = answer[w + 13]! ? 1 : 0;
          out.triangle[o] = answer[w + 14]!;
        }
    }
    return out;
  }
  /**
   * The first contact of each of a batch of particles, as {@link KernelWorld.softContacts} with one slot a particle and no margin
   * (only a touching or a penetrating particle is listed): one entry a particle, its contact or null.
   */
  probeParticles(
    from: ArrayLike<number>,
    to: ArrayLike<number>,
    radius: number | ArrayLike<number>,
    options: KernelProbeOptions = {},
  ): (KernelParticleContact | null)[] {
    const c = this.softContacts({ from, to, radius }, 1, options),
      result: (KernelParticleContact | null)[] = [];
    for (let i = 0; i < c.collider.length; i++) {
      if (c.collider[i] === 0xffffffff) {
        result.push(null);
        continue;
      }
      result.push({
        collider: c.collider[i]!,
        body: c.body[i]!,
        t: c.t[i]!,
        normal: [c.normal[3 * i]!, c.normal[3 * i + 1]!, c.normal[3 * i + 2]!],
        depth: c.depth[i]!,
        point: [c.point[3 * i]!, c.point[3 * i + 1]!, c.point[3 * i + 2]!],
        velocity: [c.velocity[3 * i]!, c.velocity[3 * i + 1]!, c.velocity[3 * i + 2]!],
        started: c.started[i] === 1,
        triangle: c.triangle[i]!,
      });
    }
    return result;
  }
  /** Contacts a particle gets at most from {@link KernelWorld.softContacts}. */
  get probeDepth(): number {
    return this.api.probe_depth();
  }
  /** Particles one {@link KernelWorld.probeParticles} chunk holds. */
  get probeCapacity(): number {
    return this.api.probe_capacity();
  }
  private readHit(i: number): KernelRayHit {
    const words = new Uint32Array(this.api.memory.buffer, this.api.query_buffer() + 32 * i, 8),
      floats = new Float32Array(words.buffer, words.byteOffset, 8);
    return {
      collider: words[0]!,
      distance: floats[1]!,
      normal: [floats[2]!, floats[3]!, floats[4]!],
      point: [floats[5]!, floats[6]!, floats[7]!],
    };
  }
  private voxelDone(code: number, what: string): void {
    if (this.api.world_layout() !== this.layout) this.bind();
    if (code === -2)
      throw new RangeError(`${what} works on voxels colliders only; call it on a collider made with shape 'voxels'.`);
    if (code < 0)
      throw new RangeError(
        `Memory cannot grow this voxel grid for ${what}; free another world, or keep edits inside the grid.`,
      );
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
    if (row < 0)
      throw new RangeError(`Rows ${a} and ${b} cannot take a joint; use two rows addBody returned, or free memory.`);
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
    this.api.body_set_own(
      body,
      mass,
      center[0],
      center[1],
      center[2],
      inertia[0],
      inertia[1],
      inertia[2],
      frame[0],
      frame[1],
      frame[2],
      frame[3],
    );
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
  /** Seconds of the last step, or one 60th before the first. */
  stepSeconds = 1 / 60;
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
    this.stepSeconds = dt;
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
    if (failed)
      throw new RangeError('Memory cannot hold the pairs of this world; spread the colliders out or use fewer.');
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
    if (!api.world_ensure(bytes))
      throw new RangeError(
        `Memory cannot hold a snapshot of ${bytes} bytes; free another world, or use a smaller one.`,
      );
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
      throw new RangeError(
        `Cannot reserve ${bodies} bodies and ${colliders} colliders; the limit of each is 4194304 and what memory allows.`,
      );
    this.bind();
    return this;
  }
}
