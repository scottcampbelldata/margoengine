import type { Geometry } from '@margoengine/core';
import type { Quat, Vec3 } from './math.js';
import { bodyInput } from './rigid-errors.js';

/**
 * Densities of common materials in kg/m³ at room temperature, for `density: 'steel'` on a collider or
 * `collider.setDensity('oak')`. Metals, glass, water, ice and concrete from the CRC Handbook of Chemistry and Physics
 * (97th ed., 2016); woods at 12 percent moisture from the USDA Wood Handbook (FPL-GTR-282, 2021, table 5-3a: specific
 * gravity times 1000 kg/m³ and the moisture); polymers from their mid-range in Callister and Rethwisch, Materials Science
 * and Engineering (10th ed., 2018, appendix B); the human body from Clauser, McConville and Young (AMRL-TR-69-70, 1969).
 */
export const densities = Object.freeze({
  air: 1.204,
  water: 998,
  seawater: 1025,
  ice: 917,
  human: 1010,
  balsa: 160,
  pine: 510,
  oak: 750,
  cork: 240,
  rubber: 1100,
  plastic: 1050,
  glass: 2500,
  concrete: 2400,
  brick: 1920,
  granite: 2700,
  sand: 1600,
  aluminium: 2700,
  steel: 7850,
  iron: 7870,
  copper: 8960,
  lead: 11340,
  gold: 19300,
});
/** A material named in {@link densities}. */
export type MaterialName = keyof typeof densities;
/** A density in kg/m³ from a number or a material name; a name not in {@link densities} is refused naming them. */
export function densityOf(value: number | MaterialName): number {
  if (typeof value === 'number') return value;
  const found = (densities as Record<string, number>)[value];
  if (found === undefined || !Object.hasOwn(densities, value))
    throw bodyInput(
      `Unknown material '${String(value)}'; pass kilograms a cubic metre or one of ${Object.keys(densities).join(', ')}.`,
    );
  return found;
}

/** Geometry-like source: a core `Geometry` (stride-6 interleaved vertices) or raw arrays. */
export type ColliderGeometry =
  | Geometry
  | { readonly vertices: ArrayLike<number>; readonly indices?: ArrayLike<number>; readonly stride?: number };

/**
 * The bits of a height field cell's status (Rapier's `HeightFieldCellStatus`): add them together. The left triangle of a
 * cell is the one on its lower x, the right one the one on its higher x, whichever way the cell is split.
 */
export const HeightfieldCell = {
  /** Split the cell along the diagonal from its lower row and column to its higher ones (the default runs the other way). */
  zigzag: 1,
  /** Remove the triangle on the cell's lower x. */
  leftRemoved: 2,
  /** Remove the triangle on the cell's higher x. */
  rightRemoved: 4,
  /** Remove both triangles. */
  removed: 6,
} as const;

/** Collider shape description: a primitive, mesh or heightfield with its size. */
export type ShapeOptions =
  | {
      shape: 'box';
      halfExtents?: Vec3;
      /** Rounds every edge and corner with a border outside `halfExtents` (default 0), Rapier's `roundCuboid`. */
      borderRadius?: number;
    }
  | { shape: 'sphere'; radius?: number }
  /** A capsule along local Y by default, or along X or Z with `axis` (Rapier's `capsule_x`, `capsule_z`). */
  | { shape: 'capsule'; halfHeight: number; radius: number; axis?: 'x' | 'y' | 'z' }
  /** A capsule from two end points and a radius (Rapier's `capsule_from_endpoints`): the segment `a` to `b` grown by `radius`. */
  | { shape: 'capsule'; a: Vec3; b: Vec3; radius: number }
  /** A tetrahedron of four points, a convex hull of them (Rapier's `Tetrahedron`); `borderRadius` rounds it. */
  | { shape: 'tetrahedron'; a: Vec3; b: Vec3; c: Vec3; d: Vec3; borderRadius?: number }
  /**
   * Along local Y, centred. `borderRadius` (default 0) rounds every edge with a border outside `radius` and `halfHeight`,
   * Rapier's `roundCylinder`.
   */
  | { shape: 'cylinder'; halfHeight: number; radius: number; borderRadius?: number }
  /** Apex at +`halfHeight` on local Y, base disk at -`halfHeight`; `borderRadius` as a cylinder's, Rapier's `roundCone`. */
  | { shape: 'cone'; halfHeight: number; radius: number; borderRadius?: number }
  | {
      shape: 'convexHull';
      geometry?: ColliderGeometry;
      points?: ArrayLike<number>;
      /**
       * A mesh of the hull as `vertices` (flat x, y, z) and `indices` (three a triangle), Rapier's `convexMesh`: the hull of
       * the vertices the triangles use, so a mesh that is not convex is wrapped.
       */
      vertices?: ArrayLike<number>;
      indices?: ArrayLike<number>;
      /** Rounds every edge and corner with a border outside the hull (default 0), Rapier's `roundConvexHull`. */
      borderRadius?: number;
    }
  | {
      shape: 'trimesh';
      geometry?: ColliderGeometry;
      vertices?: ArrayLike<number>;
      indices?: ArrayLike<number>;
      /** Smooth the normals at shared edges so bodies slide and roll over the seams without catching (default false). */
      fixInternalEdges?: boolean;
      /** Joins vertices at one position before the mesh is built (default false), Rapier's `MERGE_DUPLICATE_VERTICES`. */
      mergeDuplicateVertices?: boolean;
      /** Drops triangles with a repeated vertex or no area (default false), Rapier's `DELETE_DEGENERATE_TRIANGLES`. */
      deleteDegenerateTriangles?: boolean;
      /** Drops a triangle another one repeats (default false), Rapier's `DELETE_DUPLICATE_TRIANGLES`. */
      deleteDuplicateTriangles?: boolean;
      /** Drops triangles that make an edge belong to more than two (default false), Rapier's `DELETE_BAD_TOPOLOGY_TRIANGLES`. */
      deleteBadTopologyTriangles?: boolean;
      /**
       * The mesh is a closed surface with its outside known (default false), Rapier's `ORIENTED`: a point inside it is found
       * inside by `projectPoint` and `intersectPoint`, and a solid ray from inside hits at distance 0. Contacts are
       * unchanged. Only the own solver holds it.
       */
      oriented?: boolean;
      /** Lets `collider.connectedComponents()` read the mesh's connected components (default false), Rapier's `CONNECTED_COMPONENTS`. */
      connectedComponents?: boolean;
      /** Lets `collider.halfEdgeTopology()` read the mesh's half edges (default false), Rapier's `HALF_EDGE_TOPOLOGY`. */
      halfEdgeTopology?: boolean;
      /**
       * The vertices may move after the mesh is made (default false), Rapier's `TriMeshFlags.DEFORMABLE`: `collider.setVertices`
       * moves them, and the tree follows by a refit with no rebuild. A deformable mesh is not shared between colliders.
       */
      deformable?: boolean;
      /**
       * How a trimesh with `mass` or `density` handles open or inside-out surfaces (PA-88): `'strict'` (default) requires a
       * closed outward-wound mesh and throws otherwise; `'winding'` automatically flips inside-out closed meshes and falls back
       * to f64 generalized winding-number voxel integration (Jacobson et al. 2013) for open meshes.
       */
      massFallback?: 'strict' | 'winding';
    }
  | {
      shape: 'heightfield';
      rows: number;
      columns: number;
      heights: ArrayLike<number>;
      scale: Vec3;
      /** Smooth the normals at the grid's inner edges so bodies slide and roll over them without catching (default false). */
      fixInternalEdges?: boolean;
      /**
       * The status of each cell, one number a cell, row r of column c at `r + rows * c` (default every cell plain): add
       * {@link HeightfieldCell}`.zigzag` (1) to split the cell along its other diagonal, `leftRemoved` (2) to take away the
       * triangle on its lower x and `rightRemoved` (4) the one on its higher x, as Rapier's `HeightFieldCellStatus` does
       * (Rapier's JavaScript build has no way to set them). A removed triangle is a hole: nothing touches it, no ray hits it.
       */
      cellStatus?: ArrayLike<number>;
    }
  /**
   * Several convex parts welded into one collider (one handle, one set of events), each with its own offset and
   * rotation in the collider's frame: a chair from boxes, a dumbbell from two spheres and a cylinder.
   */
  | {
      shape: 'compound';
      parts: readonly CompoundPart[];
      /**
       * Treat the faces where two hull parts meet as inside the union, as Rapier's `CompoundFlags.FIX_INTERNAL_EDGES` (default
       * false; the cuts of a convex decomposition): a contact on such a face is dropped, and one on an edge beside it, where the
       * outline goes on flat, is clamped to the outline's normal, so a ball or a box rolls over the join with no catch. A one-off
       * pass over the parts' faces; only hull parts are read.
       */
      fixInternalEdges?: boolean;
    }
  /**
   * A concave mesh split into convex pieces, so dynamic bodies get a hollow cup or a torus right. Takes `parts`, the
   * result of `convexDecomposition` from `@margoengine/physics/decomposition` (the own decomposition, which
   * `@margoengine/physics/next` needs), or on this entry `geometry` or `vertices` and `indices` like a trimesh, which
   * Rapier splits with V-HACD; without any of them it uses the mesh geometry.
   */
  | {
      shape: 'convexDecomposition';
      parts?: readonly CompoundPart[];
      geometry?: ColliderGeometry;
      vertices?: ArrayLike<number>;
      indices?: ArrayLike<number>;
      /** As on `compound`: the cuts between the convex pieces are inside the union (default false). */
      fixInternalEdges?: boolean;
    }
  /**
   * A grid of filled cells: terrain and other block worlds. `cells` holds integer x, y, z cell coordinates, three per
   * cell, and `size` is one cell's size in the collider's frame (default [1, 1, 1]). Edit it in place with
   * {@link PhysicsCollider.setVoxel}; {@link PhysicsCollider.combineVoxelStates} couples two grids along a shared border.
   */
  | { shape: 'voxels'; cells: Int32Array; size?: Vec3 }
  /** A line segment from `a` to `b` in the collider's frame. It has no volume, so no mass; it collides, is raycast and is cast against. */
  | { shape: 'segment'; a: Vec3; b: Vec3 }
  /** A single triangle `a`, `b`, `c` in the collider's frame, solid on both sides, with no volume and so no mass; `borderRadius` rounds it by that much all round (Rapier's `roundTriangle`). */
  | { shape: 'triangle'; a: Vec3; b: Vec3; c: Vec3; borderRadius?: number }
  /**
   * A chain or set of segments in the collider's frame: `vertices` (flat x, y, z) joined by `indices` (two a segment), or in
   * order when `indices` is left out. No volume, so no mass.
   */
  | { shape: 'polyline'; vertices: ArrayLike<number>; indices?: ArrayLike<number> }
  /** Everything on one side of a plane through the collider's origin; `normal` points out of the solid (default up). */
  | { shape: 'halfSpace'; normal?: Vec3 };

/** One part of a `compound` collider: a convex primitive or hull placed in the collider's frame. */
export type CompoundPart = (
  | { shape: 'box'; halfExtents: Vec3; borderRadius?: number }
  | { shape: 'sphere'; radius: number }
  | { shape: 'capsule'; halfHeight: number; radius: number }
  | { shape: 'cylinder'; halfHeight: number; radius: number; borderRadius?: number }
  | { shape: 'cone'; halfHeight: number; radius: number; borderRadius?: number }
  | { shape: 'convexHull'; points: ArrayLike<number>; borderRadius?: number }
  /** The half space behind a plane through the part's offset (default normal up): an endless floor or wall in a compound. */
  | { shape: 'halfSpace'; normal?: Vec3 }
  /** A mesh, height field or voxel grid as a part: a surface (a voxel grid weighs nothing here), for a fixed body's scenery. */
  | { shape: 'trimesh'; vertices: ArrayLike<number>; indices: ArrayLike<number>; fixInternalEdges?: boolean }
  | {
      shape: 'heightfield';
      rows: number;
      columns: number;
      heights: ArrayLike<number>;
      scale: Vec3;
      fixInternalEdges?: boolean;
      cellStatus?: ArrayLike<number>;
    }
  | { shape: 'voxels'; cells: Int32Array; size?: Vec3 }
  /** The half space behind a plane through the part's offset (default normal up): an endless floor or wall in a compound. */
  | { shape: 'halfSpace'; normal?: Vec3 }
) & {
  /** Part position in the collider's frame (default origin). */
  offset?: Vec3;
  /** Part rotation quaternion [x, y, z, w] in the collider's frame (default identity). */
  rotation?: Quat;
};

const _ZERO = { x: 0, y: 0, z: 0 },
  _IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const _CONVEX_PARTS = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convexHull'];

/** How two colliders combine their friction or restitution values. */
export type CombineRule = 'average' | 'min' | 'multiply' | 'max' | 'clampedSum' | 'geometricMean';

/**
 * A kind of body pair a collider can take part in, Rapier's `ActiveCollisionTypes`. A pair of colliders is made when both
 * want the kind of pair their bodies make.
 */
export type CollisionPairKind =
  | 'dynamicDynamic'
  | 'dynamicKinematic'
  | 'dynamicFixed'
  | 'kinematicKinematic'
  | 'kinematicFixed'
  | 'fixedFixed';

/** The kinds a collider takes part in when it names none: dynamic bodies with anything. */
export const DEFAULT_PAIR_KINDS: readonly CollisionPairKind[] = ['dynamicDynamic', 'dynamicKinematic', 'dynamicFixed'];

/** Everything about a collider except its shape. */
export interface ColliderSettings {
  /** Collider position relative to the body. */
  offset?: Vec3;
  /** Collider rotation relative to the body, as a quaternion [x, y, z, w]. */
  rotation?: Quat;
  friction?: number;
  restitution?: number;
  frictionCombine?: CombineRule;
  restitutionCombine?: CombineRule;
  /**
   * Density in kg per cubic metre, or the name of a material in {@link densities} (`'steel'`, `'oak'`, `'water'` ...).
   * Default 1, Rapier's, so values tuned for Rapier carry over; pass a real one for real masses. Ignored when `mass` is set.
   */
  density?: number | MaterialName;
  mass?: number;
  /**
   * Adds no mass and no inertia to the body, and skips computing them (default false). For the static world pieces of a
   * fixed body, where integrating every triangle or cell is wasted work. Wins over `mass` and `density`.
   */
  massless?: boolean;
  /** Sensors detect overlaps (intersection events) and produce no contact forces. */
  sensor?: boolean;
  /** Interaction groups: packed 16 + 16 bits (see `collisionGroups`) or 32 bits wide with a test mode (see `interactionGroups`). */
  collisionGroups?: number | InteractionGroups;
  /** Solver groups, packed or wide: which pairs generate contact forces (contacts still detected). */
  solverGroups?: number | InteractionGroups;
  /**
   * A skin around the shape in metres (default 0), Rapier's contact skin: contacts are made and solved as if the shape were
   * this much thicker, so a body rests a skin above what it lies on, and starts touching a skin away. Two colliders'
   * skins add up.
   */
  contactSkin?: number;
  /** Emit contact or intersection start and end events (default true). */
  events?: boolean;
  /**
   * The kinds of body pair this collider takes part in (default dynamic with anything; a sensor sees every kind). Add
   * `kinematicKinematic` or `fixedFixed` for events between bodies that cannot push each other.
   */
  activeCollisionTypes?: readonly CollisionPairKind[];
  /**
   * Shows the pairs this collider is in to the world's `contactModifier` after their friction and bounce are set and before
   * they are solved (default false), as Rapier's `MODIFY_SOLVER_CONTACTS` hook. Only the own solver has it; Rapier's
   * JavaScript does not.
   */
  modifyContacts?: boolean;
  /**
   * Which hooks involve this collider, as Rapier's `activeHooks`: `filterContactPairs` and `filterIntersectionPairs` (the
   * pair filters of the world are asked about a pair when either collider has the flag; both on by default) and
   * `modifyContacts` (off by default).
   */
  activeHooks?: { filterContactPairs?: boolean; filterIntersectionPairs?: boolean; modifyContacts?: boolean };
  /**
   * Mass properties of the collider's own in place of its shape's at its density, Rapier's `setMassProperties`: the mass in
   * kilograms, the centre of mass in the collider's frame, the principal moments of inertia and the turn of their axes
   * (default none). Wins over `mass` and `density`; `massless` wins over it.
   */
  massProperties?: { mass: number; centerOfMass: Vec3; principalInertia: Vec3; inertiaFrame?: Quat };
  /**
   * Whether this collider asks for contact-force events on the own solver (default true; a pair speaks when either side
   * asks). See `contactForceThreshold`.
   */
  contactForceEvents?: boolean;
  /** The force in newtons a pair must pass before its contact-force event is made; the larger of the two colliders' (default 0). */
  contactForceThreshold?: number;
  /** Collider enabled (default true). */
  enabled?: boolean;
  /** Anything you want to find again from an event, a query or a contact, kept on `collider.userData` (default undefined). */
  userData?: unknown;
}

/** Options for a collider: shape, material, sensor and filtering. */
export type ColliderOptions = ShapeOptions & ColliderSettings;

/** Packs Rapier interaction groups. Each side is a list of group indices 0..15 or a 16-bit mask. */
export function collisionGroups(
  memberships: number | readonly number[],
  filter: number | readonly number[] = 0xffff,
): number {
  const mask = (value: number | readonly number[]): number => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff)
        throw bodyInput(
          'Group mask must be an integer from 0 to 65535; pass a 16-bit mask or an array of group indices.',
        );
      return value;
    }
    let bits = 0;
    for (const group of value) {
      if (!Number.isInteger(group) || group < 0 || group > 15)
        throw bodyInput('Group indices must be integers from 0 to 15; use one of the 16 groups.');
      bits |= 1 << group;
    }
    return bits;
  };
  return ((mask(memberships) << 16) | mask(filter)) >>> 0;
}

/**
 * Interaction groups 32 bits wide with a test mode, as the Rust `InteractionGroups` of Rapier: `memberships` and `filter` are
 * masks of up to 32 groups. Two colliders meet when each one's memberships share a bit with the other's filter (`'and'`, the
 * default), or when either's do (`'or'`, used only when both colliders ask for it; a mixed pair tests by `'and'`).
 */
export interface InteractionGroups {
  readonly memberships: number;
  readonly filter: number;
  readonly testMode?: 'and' | 'or';
}

/**
 * Makes interaction groups from masks or lists of group indices 0..31. {@link collisionGroups} packs 16 groups a side into one
 * number, as Rapier's JavaScript build does; this keeps 32 and the test mode.
 * @throws MargoError (code `unsupported`) for a mask that is not an integer from 0 to 4,294,967,295, an index outside 0..31 or a test mode that is not `and` or `or`.
 */
export function interactionGroups(
  memberships: number | readonly number[] = 0xffffffff,
  filter: number | readonly number[] = 0xffffffff,
  testMode: 'and' | 'or' = 'and',
): InteractionGroups {
  const mask = (value: number | readonly number[]): number => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw bodyInput(
          'A group mask must be an integer from 0 to 4294967295; pass a 32-bit mask or an array of group indices.',
        );
      return value;
    }
    let bits = 0;
    for (const group of value) {
      if (!Number.isInteger(group) || group < 0 || group > 31)
        throw bodyInput('Group indices must be integers from 0 to 31; use one of the 32 groups.');
      bits = (bits | (1 << group)) >>> 0;
    }
    return bits;
  };
  if (testMode !== 'and' && testMode !== 'or')
    throw bodyInput(`Unknown test mode ${String(testMode)}; use 'and' or 'or'.`);
  return Object.freeze({ memberships: mask(memberships), filter: mask(filter), testMode });
}

/**
 * The words a collider's columns hold for groups: the packed lower 16 bits of each side, the upper halves, and whether the
 * test is `or`. A packed number (`collisionGroups`) has no upper halves: 0, so a 16-bit group never meets a 32-bit one by
 * a bit it does not have.
 */
export function groupWords(groups: number | InteractionGroups): {
  packed: number;
  hi: number;
  or: boolean;
  wide: boolean;
} {
  if (typeof groups === 'number') return { packed: groups >>> 0, hi: 0, or: false, wide: false };
  const { memberships, filter } = interactionGroups(groups.memberships, groups.filter, groups.testMode);
  return {
    packed: (((memberships & 0xffff) << 16) | (filter & 0xffff)) >>> 0,
    hi: ((memberships & 0xffff0000) | (filter >>> 16)) >>> 0,
    or: groups.testMode === 'or',
    wide: true,
  };
}

const _positive = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw bodyInput(`${label} must be a positive number`);
  return value;
};

/** Positions from a geometry-like source, scaled, as a packed xyz Float32Array. */
export function geometryPositions(source: ColliderGeometry, scale: Vec3 = [1, 1, 1]): Float32Array {
  const vertices = source.vertices;
  // A core Geometry interleaves position and normal (stride 6); raw sources default to packed xyz.
  const stride = ('stride' in source ? source.stride : undefined) ?? ('bounds' in source ? 6 : 3);
  if (!Number.isInteger(stride) || stride < 3 || vertices.length % stride)
    throw bodyInput(
      'Vertex array length must be a multiple of its stride; pass whole vertices and a stride of at least 3.',
    );
  const count = vertices.length / stride,
    out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = vertices[i * stride + a] * scale[a];
  return out;
}

export function bounds(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity],
    max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], positions[i + a]);
      max[a] = Math.max(max[a], positions[i + a]);
    }
  if (!positions.length)
    throw bodyInput('Geometry has no vertices; give the mesh geometry or set an explicit collider size.');
  return { min, max };
}

/** The points of a convex hull collider that has a mesh: the vertices its triangles use. */
export function usedVertices(vertices: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const count = vertices.length / 3,
    used = new Set<number>();
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw bodyInput('Convex hull index is out of range; keep every index below the vertex count.');
    used.add(index);
  }
  const points: number[] = [];
  for (const index of [...used].sort((a, b) => a - b))
    points.push(vertices[3 * index]!, vertices[3 * index + 1]!, vertices[3 * index + 2]!);
  return Float32Array.from(points);
}

/** A border radius: 0 for none, else above zero and finite. */
export function roundness(border: number | undefined, label: string): number {
  if (border === undefined) return 0;
  if (!(border >= 0) || !Number.isFinite(border))
    throw bodyInput(`${label} borderRadius must be 0 or more and finite (got ${border}).`);
  return border;
}
