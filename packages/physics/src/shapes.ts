import { MargoError } from '@margoengine/math/errors';
import type { ColliderDesc, RapierModule, Rotation, Shape, Vector } from './rapier-types.js';
export type { RapierModule } from './rapier-types.js';
import type { Geometry } from '@margoengine/core';
import { checkVec, quat, vec, type Quat, type Vec3 } from './math.js';

/** Geometry-like source: a core `Geometry` (stride-6 interleaved vertices) or raw arrays. */
export type ColliderGeometry =
  | Geometry
  | { readonly vertices: ArrayLike<number>; readonly indices?: ArrayLike<number>; readonly stride?: number };

/** Collider shape description: a primitive, mesh or heightfield with its size. */
export type ShapeOptions =
  | {
      shape: 'box';
      halfExtents?: Vec3;
      /** Rounds every edge and corner with a border outside `halfExtents` (default 0), Rapier's `roundCuboid`. */
      borderRadius?: number;
    }
  | { shape: 'sphere'; radius?: number }
  | { shape: 'capsule'; halfHeight: number; radius: number }
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
    }
  | {
      shape: 'heightfield';
      rows: number;
      columns: number;
      heights: ArrayLike<number>;
      scale: Vec3;
      /** Smooth the normals at the grid's inner edges so bodies slide and roll over them without catching (default false). */
      fixInternalEdges?: boolean;
    }
  /**
   * Several convex parts welded into one collider (one handle, one set of events), each with its own offset and
   * rotation in the collider's frame: a chair from boxes, a dumbbell from two spheres and a cylinder.
   */
  | { shape: 'compound'; parts: readonly CompoundPart[] }
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
    }
  /**
   * A grid of filled cells: terrain and other block worlds. `cells` holds integer x, y, z cell coordinates, three per
   * cell, and `size` is one cell's size in the collider's frame (default [1, 1, 1]). Edit it in place with
   * {@link PhysicsCollider.setVoxel}; {@link PhysicsCollider.combineVoxelStates} couples two grids along a shared border.
   */
  | { shape: 'voxels'; cells: Int32Array; size?: Vec3 }
  /** A line segment from `a` to `b` in the collider's frame. It has no volume, so no mass; it collides, is raycast and is cast against. */
  | { shape: 'segment'; a: Vec3; b: Vec3 }
  /** A single triangle `a`, `b`, `c` in the collider's frame, solid on both sides, with no volume and so no mass. */
  | { shape: 'triangle'; a: Vec3; b: Vec3; c: Vec3 }
  /**
   * A chain or set of segments in the collider's frame: `vertices` (flat x, y, z) joined by `indices` (two a segment), or in
   * order when `indices` is left out. No volume, so no mass.
   */
  | { shape: 'polyline'; vertices: ArrayLike<number>; indices?: ArrayLike<number> }
  /** Everything on one side of a plane through the collider's origin; `normal` points out of the solid (default up). */
  | { shape: 'halfSpace'; normal?: Vec3 }
  /**
   * A Rapier `ColliderDesc` you built yourself, for what this wrapper does not cover. The other options apply on top;
   * its own translation is kept unless `offset` is given. It leaves with Rapier.
   */
  | { shape: 'custom'; desc: ColliderDesc };

/** One part of a `compound` collider: a convex primitive or hull placed in the collider's frame. */
export type CompoundPart = (
  | { shape: 'box'; halfExtents: Vec3 }
  | { shape: 'sphere'; radius: number }
  | { shape: 'capsule'; halfHeight: number; radius: number }
  | { shape: 'cylinder'; halfHeight: number; radius: number; borderRadius?: number }
  | { shape: 'cone'; halfHeight: number; radius: number; borderRadius?: number }
  | { shape: 'convexHull'; points: ArrayLike<number> }
) & {
  /** Part position in the collider's frame (default origin). */
  offset?: Vec3;
  /** Part rotation quaternion [x, y, z, w] in the collider's frame (default identity). */
  rotation?: Quat;
};

const ZERO = { x: 0, y: 0, z: 0 },
  IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const CONVEX_PARTS = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convexHull'];

/** How two colliders combine their friction or restitution values. */
export type CombineRule = 'average' | 'min' | 'multiply' | 'max';

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
  /** Density in kg per cubic unit (default 1). Ignored when `mass` is set. */
  density?: number;
  mass?: number;
  /**
   * Adds no mass and no inertia to the body, and skips computing them (default false). For the static world pieces of a
   * fixed body, where integrating every triangle or cell is wasted work. Wins over `mass` and `density`.
   */
  massless?: boolean;
  /** Sensors detect overlaps (intersection events) and produce no contact forces. */
  sensor?: boolean;
  /** Packed 32-bit interaction groups, see `collisionGroups`. */
  collisionGroups?: number;
  /** Packed 32-bit solver groups: which pairs generate contact forces (contacts still detected). */
  solverGroups?: number;
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
   * Whether this collider asks for contact-force events on the own solver (default true; a pair speaks when either side
   * asks). See `contactForceThreshold`.
   */
  contactForceEvents?: boolean;
  /** The force in newtons a pair must pass before its contact-force event is made; the larger of the two colliders' (default 0). */
  contactForceThreshold?: number;
  /** Collider enabled (default true). */
  enabled?: boolean;
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
        throw new RangeError(
          'Group mask must be an integer from 0 to 65535; pass a 16-bit mask or an array of group indices.',
        );
      return value;
    }
    let bits = 0;
    for (const group of value) {
      if (!Number.isInteger(group) || group < 0 || group > 15)
        throw new RangeError('Group indices must be integers from 0 to 15; use one of the 16 groups.');
      bits |= 1 << group;
    }
    return bits;
  };
  return ((mask(memberships) << 16) | mask(filter)) >>> 0;
}

const positive = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new RangeError(`${label} must be a positive number`);
  return value;
};

/** Positions from a geometry-like source, scaled, as a packed xyz Float32Array. */
export function geometryPositions(source: ColliderGeometry, scale: Vec3 = [1, 1, 1]): Float32Array {
  const vertices = source.vertices;
  // A core Geometry interleaves position and normal (stride 6); raw sources default to packed xyz.
  const stride = ('stride' in source ? source.stride : undefined) ?? ('bounds' in source ? 6 : 3);
  if (!Number.isInteger(stride) || stride < 3 || vertices.length % stride)
    throw new RangeError(
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
    throw new RangeError('Geometry has no vertices; give the mesh geometry or set an explicit collider size.');
  return { min, max };
}

/** The points of a convex hull collider that has a mesh: the vertices its triangles use. */
export function usedVertices(vertices: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const count = vertices.length / 3,
    used = new Set<number>();
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i]!;
    if (!Number.isInteger(index) || index < 0 || index >= count)
      throw new RangeError('Convex hull index is out of range; keep every index below the vertex count.');
    used.add(index);
  }
  const points: number[] = [];
  for (const index of [...used].sort((a, b) => a - b)) points.push(vertices[3 * index]!, vertices[3 * index + 1]!, vertices[3 * index + 2]!);
  return Float32Array.from(points);
}

/** A border radius: 0 for none, else above zero and finite. */
export function roundness(border: number | undefined, label: string): number {
  if (border === undefined) return 0;
  if (!(border >= 0) || !Number.isFinite(border))
    throw new RangeError(`${label} borderRadius must be 0 or more and finite (got ${border}).`);
  return border;
}

/**
 * Builds a Rapier ColliderDesc. Geometry-derived shapes and auto-fitted boxes and spheres use `fit`
 * (the mesh geometry and scale); their center offset is returned so it can be added to the collider offset.
 */
export function createColliderDesc(
  R: RapierModule,
  options: ShapeOptions,
  fit?: { geometry: ColliderGeometry | null; scale: Vec3 },
): { desc: ColliderDesc; center: [number, number, number] } {
  const center: [number, number, number] = [0, 0, 0];
  const fitted = (): Float32Array => {
    if (!fit?.geometry)
      throw new TypeError(`A ${options.shape} collider without explicit size needs a mesh with geometry`);
    return geometryPositions(fit.geometry, fit.scale);
  };
  let desc: ColliderDesc | null;
  switch (options.shape) {
    case 'box': {
      let half = options.halfExtents;
      if (!half) {
        const { min, max } = bounds(fitted());
        half = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
        for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
      }
      checkVec(half, 'Box halfExtents');
      const border = roundness(options.borderRadius, 'Box');
      desc = border
        ? R.ColliderDesc.roundCuboid(positive(half[0], 'Box half extent'), positive(half[1], 'Box half extent'), positive(half[2], 'Box half extent'), border)
        : R.ColliderDesc.cuboid(positive(half[0], 'Box half extent'), positive(half[1], 'Box half extent'), positive(half[2], 'Box half extent'));
      break;
    }
    case 'sphere': {
      let radius = options.radius;
      if (radius === undefined) {
        const points = fitted(),
          { min, max } = bounds(points);
        for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
        radius = 0;
        for (let i = 0; i < points.length; i += 3)
          radius = Math.max(
            radius,
            Math.hypot(points[i] - center[0], points[i + 1] - center[1], points[i + 2] - center[2]),
          );
      }
      desc = R.ColliderDesc.ball(positive(radius, 'Sphere radius'));
      break;
    }
    case 'capsule':
      desc = R.ColliderDesc.capsule(
        positive(options.halfHeight, 'Capsule halfHeight'),
        positive(options.radius, 'Capsule radius'),
      );
      break;
    case 'cylinder':
    case 'cone': {
      const name = options.shape === 'cone' ? 'Cone' : 'Cylinder',
        halfHeight = positive(options.halfHeight, `${name} halfHeight`),
        radius = positive(options.radius, `${name} radius`),
        border = options.borderRadius ?? 0;
      if (!(border >= 0) || !Number.isFinite(border))
        throw new RangeError(`${name} borderRadius must be 0 or more and finite (got ${border}).`);
      if (options.shape === 'cone') desc = border > 0 ? R.ColliderDesc.roundCone(halfHeight, radius, border) : R.ColliderDesc.cone(halfHeight, radius);
      else desc = border > 0 ? R.ColliderDesc.roundCylinder(halfHeight, radius, border) : R.ColliderDesc.cylinder(halfHeight, radius);
      break;
    }
    case 'convexHull': {
      const points = options.points
        ? Float32Array.from(options.points)
        : options.vertices && options.indices
          ? usedVertices(options.vertices, options.indices)
        : options.geometry
          ? geometryPositions(options.geometry, fit?.scale)
          : fitted();
      if (points.length < 12 || points.length % 3) throw new RangeError('A convex hull needs at least 4 points');
      finite(points, 'Convex hull points');
      const round = roundness(options.borderRadius, 'Convex hull');
      desc = round ? R.ColliderDesc.roundConvexHull(points, round) : R.ColliderDesc.convexHull(points);
      if (!desc)
        throw new RangeError(
          'Convex hull failed because the points are degenerate; provide points that span a volume.',
        );
      break;
    }
    case 'trimesh': {
      const source = options.geometry ?? (options.vertices ? null : fit?.geometry);
      const vertices = options.vertices
        ? Float32Array.from(options.vertices)
        : source
          ? geometryPositions(source, fit?.scale)
          : fitted();
      const indexSource = options.indices ?? source?.indices;
      if (!indexSource) throw new TypeError('A trimesh needs indices');
      const indices = triangleIndices(indexSource, vertices, 'Trimesh');
      let flags: number | undefined;
      for (const [option, name] of [
        ['fixInternalEdges', 'FIX_INTERNAL_EDGES'],
        ['mergeDuplicateVertices', 'MERGE_DUPLICATE_VERTICES'],
        ['deleteDegenerateTriangles', 'DELETE_DEGENERATE_TRIANGLES'],
        ['deleteDuplicateTriangles', 'DELETE_DUPLICATE_TRIANGLES'],
        ['deleteBadTopologyTriangles', 'DELETE_BAD_TOPOLOGY_TRIANGLES'],
        ['oriented', 'ORIENTED'],
      ] as const) {
        if (!options[option]) continue;
        const bit = R.TriMeshFlags?.[name];
        if (bit === undefined)
          throw new MargoError(
            'unsupported',
            `${option} needs a Rapier that has TriMeshFlags.${name} (0.17.1 or later; ORIENTED and the clean-up flags need 0.18); upgrade @dimforge/rapier3d-compat or leave it out.`,
          );
        flags = (flags ?? 0) | bit;
      }
      desc = R.ColliderDesc.trimesh(vertices, indices, flags);
      break;
    }
    case 'heightfield': {
      const { rows, columns, heights, scale } = options;
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1)
        throw new RangeError('Heightfield rows and columns must be positive integers');
      if (heights.length !== (rows + 1) * (columns + 1))
        throw new RangeError(`Heightfield needs (rows + 1) * (columns + 1) = ${(rows + 1) * (columns + 1)} heights`);
      checkVec(scale, 'Heightfield scale');
      const values = Float32Array.from(heights);
      finite(values, 'Heightfield heights');
      const flags = options.fixInternalEdges ? R.HeightFieldFlags?.FIX_INTERNAL_EDGES : undefined;
      if (options.fixInternalEdges && flags === undefined)
        throw new MargoError(
          'unsupported',
          'fixInternalEdges on a heightfield needs a Rapier with HeightFieldFlags; upgrade @dimforge/rapier3d-compat or leave it out.',
        );
      desc = R.ColliderDesc.heightfield(rows, columns, values, vec(scale), flags);
      break;
    }
    case 'compound': {
      if (!R.ColliderDesc.compound)
        throw new MargoError(
          'unsupported',
          'Compound colliders need Rapier 0.19 or later; upgrade @dimforge/rapier3d-compat or add one collider per part.',
        );
      const parts = options.parts;
      if (!Array.isArray(parts) || !parts.length)
        throw new RangeError(
          "A compound collider needs at least one part: {shape: 'compound', parts: [{shape: 'box', halfExtents: [1, 1, 1]}]}",
        );
      const shapes: Shape[] = [],
        positions: Vector[] = [],
        rotations: Rotation[] = [];
      for (const part of parts as readonly CompoundPart[]) {
        if (!CONVEX_PARTS.includes(part?.shape))
          throw new TypeError(
            `Compound part shape ${String(part?.shape)} is not convex; use box, sphere, capsule, cylinder, cone or convexHull parts.`,
          );
        if (part.shape === 'box' && !part.halfExtents)
          throw new TypeError('A compound box part needs halfExtents; parts are never fitted to the mesh.');
        if (part.shape === 'sphere' && part.radius === undefined)
          throw new TypeError('A compound sphere part needs a radius; parts are never fitted to the mesh.');
        if (part.shape === 'convexHull' && !part.points)
          throw new TypeError('A compound convexHull part needs points; parts are never fitted to the mesh.');
        const offset = part.offset ?? [0, 0, 0];
        checkVec(offset, 'Compound part offset');
        shapes.push(createColliderDesc(R, part).desc.shape);
        positions.push(vec(offset));
        rotations.push(quat(part.rotation));
      }
      desc = R.ColliderDesc.compound(shapes, positions, rotations);
      break;
    }
    case 'convexDecomposition': {
      // Parts decomposed already (@margoengine/physics/decomposition) are a compound of their hulls.
      if (options.parts) return createColliderDesc(R, { shape: 'compound', parts: options.parts });
      if (!R.ColliderDesc.convexDecomposition)
        throw new MargoError(
          'unsupported',
          'Convex decomposition needs Rapier 0.19 or later; upgrade @dimforge/rapier3d-compat or use a convexHull.',
        );
      const source = options.geometry ?? (options.vertices ? null : fit?.geometry);
      const vertices = options.vertices
        ? Float32Array.from(options.vertices)
        : source
          ? geometryPositions(source, fit?.scale)
          : fitted();
      const indexSource = options.indices ?? source?.indices;
      if (!indexSource)
        throw new TypeError('A convexDecomposition collider needs indices; pass indices or an indexed geometry.');
      const indices = triangleIndices(indexSource, vertices, 'Convex decomposition');
      desc = R.ColliderDesc.convexDecomposition(vertices, indices);
      if (!desc)
        throw new MargoError(
          'failed',
          'Convex decomposition produced no pieces because the mesh is degenerate; pass a closed mesh that spans a volume.',
        );
      break;
    }
    case 'voxels': {
      const { cells, size = [1, 1, 1] } = options;
      if (!(cells instanceof Int32Array) || cells.length % 3)
        throw new TypeError('A voxels collider needs cells as an Int32Array of x, y, z cell coordinates, three per cell.');
      checkVec(size, 'Voxel size');
      if (!shapeSupported(R, 'voxels'))
        throw new MargoError(
          'unsupported',
          'Voxel colliders need Rapier 0.17.1 or later; upgrade @dimforge/rapier3d-compat.',
        );
      desc = R.ColliderDesc.voxels!(
        cells,
        vec([positive(size[0], 'Voxel size'), positive(size[1], 'Voxel size'), positive(size[2], 'Voxel size')]),
      );
      break;
    }
    case 'segment': {
      checkVec(options.a, 'Segment a');
      checkVec(options.b, 'Segment b');
      desc = R.ColliderDesc.segment(vec(options.a), vec(options.b));
      break;
    }
    case 'triangle': {
      checkVec(options.a, 'Triangle a');
      checkVec(options.b, 'Triangle b');
      checkVec(options.c, 'Triangle c');
      desc = R.ColliderDesc.triangle(vec(options.a), vec(options.b), vec(options.c));
      break;
    }
    case 'polyline': {
      const points = Float32Array.from(options.vertices);
      finite(points, 'Polyline vertices');
      if (points.length < 6 || points.length % 3) throw new RangeError('A polyline needs at least two vertices, three numbers each.');
      let indices: Uint32Array | undefined;
      if (options.indices) {
        if (!options.indices.length || options.indices.length % 2) throw new RangeError('A polyline needs whole segments; pass two indices per segment.');
        for (const index of Array.from(options.indices))
          if (!Number.isInteger(index) || index < 0 || index >= points.length / 3)
            throw new RangeError('Polyline index is out of range; keep every index below the vertex count.');
        indices = Uint32Array.from(options.indices);
      }
      desc = R.ColliderDesc.polyline(points, indices);
      break;
    }
    case 'halfSpace': {
      const normal = options.normal ?? [0, 1, 0];
      checkVec(normal, 'Half space normal');
      const length = Math.hypot(...normal);
      if (!length) throw new RangeError('A half space needs a nonzero normal; pass the direction out of the solid.');
      desc = new R.ColliderDesc(
        new R.HalfSpace(vec([normal[0] / length, normal[1] / length, normal[2] / length])) as never,
      );
      break;
    }
    case 'custom':
      if (typeof options.desc?.setActiveEvents !== 'function')
        throw new TypeError(
          "A 'custom' collider needs a Rapier ColliderDesc: {shape: 'custom', desc: RAPIER.ColliderDesc.ball(1)}",
        );
      desc = options.desc;
      break;
    default:
      throw new TypeError(
        `Unknown collider shape ${(options as { shape: string }).shape}; use box, sphere, capsule, cylinder, cone, convexHull, trimesh, heightfield, compound, convexDecomposition, voxels, segment, triangle, polyline, halfSpace or custom.`,
      );
  }
  return { desc, center };
}

/** Whether this solver build can make a shape; every shape but `voxels` needs nothing past the oldest supported one. */
export function shapeSupported(R: RapierModule, shape: ShapeOptions['shape']): boolean {
  return (
    shape !== 'voxels' ||
    (typeof R.ColliderDesc.voxels === 'function' && typeof R.Collider?.prototype.combineVoxelStates === 'function')
  );
}

// A hand-built collider is named after what it holds, so helpers that treat a sphere or a grid differently still can.
const SHAPE_OF_TYPE: Readonly<Record<string, ShapeOptions['shape']>> = {
  Ball: 'sphere',
  Cuboid: 'box',
  Capsule: 'capsule',
  Cylinder: 'cylinder',
  Cone: 'cone',
  RoundCylinder: 'cylinder',
  RoundCone: 'cone',
  ConvexPolyhedron: 'convexHull',
  TriMesh: 'trimesh',
  HeightField: 'heightfield',
  Compound: 'compound',
  Voxels: 'voxels',
  HalfSpace: 'halfSpace',
  Segment: 'segment',
  Triangle: 'triangle',
  Polyline: 'polyline',
};
/** What a made collider is called: its option, or for `custom` what its solver type maps to. */
export function shapeName(R: RapierModule, shape: ShapeOptions['shape'], type: number): ShapeOptions['shape'] {
  return shape === 'custom' ? (SHAPE_OF_TYPE[String(R.ShapeType[type])] ?? 'custom') : shape;
}

/** Validated triangle indices (whole triangles, every index in range) and finite vertices, for trimesh-like shapes. */
function triangleIndices(source: ArrayLike<number>, vertices: Float32Array, label: string): Uint32Array {
  if (!source.length || source.length % 3 || vertices.length % 3)
    throw new RangeError(
      `A ${label === 'Trimesh' ? 'trimesh' : 'convex decomposition'} needs whole triangles; pass three indices per triangle.`,
    );
  for (let i = 0; i < source.length; i++)
    if (!Number.isInteger(source[i]) || source[i] < 0 || source[i] >= vertices.length / 3)
      throw new RangeError(`${label} index is out of range; keep every index below the vertex count.`);
  finite(vertices, `${label} vertices`);
  return Uint32Array.from(source);
}

/** Rapier takes NaN and infinite coordinates silently (a convex hull of them fails inside Rapier with an internal error, a trimesh poisons the simulation): refuse them by name first. */
function finite(values: Float32Array, label: string): void {
  for (let i = 0; i < values.length; i++)
    if (!Number.isFinite(values[i])) throw new RangeError(`${label} must be finite Float32 values`);
}

const combine = (R: RapierModule, rule: CombineRule): number => {
  const value = {
    average: R.CoefficientCombineRule.Average,
    min: R.CoefficientCombineRule.Min,
    multiply: R.CoefficientCombineRule.Multiply,
    max: R.CoefficientCombineRule.Max,
  }[rule];
  if (value === undefined) throw new TypeError(`Unknown combine rule ${rule}; use average, min, multiply or max.`);
  return value;
};

/** Applies material, mass, sensor, group and offset settings to a ColliderDesc. */
export function configureCollider(
  R: RapierModule,
  desc: ColliderDesc,
  options: ColliderOptions,
  center: Vec3,
  hooks: boolean,
): ColliderDesc {
  // A custom desc keeps its own translation unless an offset is given.
  if (options.shape !== 'custom' || options.offset) {
    const offset = options.offset ?? [0, 0, 0];
    checkVec(offset, 'Collider offset');
    desc.setTranslation(offset[0] + center[0], offset[1] + center[1], offset[2] + center[2]);
  }
  if (options.rotation) desc.setRotation(quat(options.rotation));
  if (options.friction !== undefined) desc.setFriction(options.friction);
  if (options.restitution !== undefined) desc.setRestitution(options.restitution);
  if (options.frictionCombine) desc.setFrictionCombineRule(combine(R, options.frictionCombine));
  if (options.restitutionCombine) desc.setRestitutionCombineRule(combine(R, options.restitutionCombine));
  if (options.massless) desc.setMassProperties(0, ZERO, ZERO, IDENTITY);
  else if (options.mass !== undefined) desc.setMass(options.mass);
  else if (options.density !== undefined) desc.setDensity(options.density);
  if (options.modifyContacts)
    throw new MargoError(
      'unsupported',
      "modifyContacts needs the own solver: import {Physics} from '@margoengine/physics/next'. Rapier's JavaScript has no contact modification hook.",
    );
  if (options.activeCollisionTypes) {
    const kinds = R.ActiveCollisionTypes as unknown as Record<string, number>;
    let types = 0;
    for (const kind of options.activeCollisionTypes) {
      const name = kind.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
      if (typeof kinds[name] !== 'number')
        throw new RangeError(
          `Unknown collision pair kind ${String(kind)}; use dynamicDynamic, dynamicKinematic, dynamicFixed, kinematicKinematic, kinematicFixed or fixedFixed.`,
        );
      types |= kinds[name];
    }
    desc.setActiveCollisionTypes(types);
  }
  if (options.sensor) {
    desc.setSensor(true);
    // Let sensors see kinematic and fixed bodies too (character controllers walking into triggers).
    desc.setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
  }
  if (options.collisionGroups !== undefined) desc.setCollisionGroups(options.collisionGroups);
  if (options.solverGroups !== undefined) desc.setSolverGroups(options.solverGroups);
  if (options.events !== false) desc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  if (hooks) desc.setActiveHooks(R.ActiveHooks.FILTER_CONTACT_PAIRS | R.ActiveHooks.FILTER_INTERSECTION_PAIRS);
  if (options.enabled === false) desc.setEnabled(false);
  return desc;
}
