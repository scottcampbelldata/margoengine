import type {Geometry} from '@margoengine/core';
import {checkVec, quat, vec, type Quat, type Vec3} from './math.js';

/** The initialized `@dimforge/rapier3d-compat` module (after `await RAPIER.init()`). Typed loosely so Rapier stays optional. */
export interface RapierModule {
  World: new (gravity: {x: number; y: number; z: number}) => any;
  [name: string]: any;
}

/** Geometry-like source: a core `Geometry` (stride-6 interleaved vertices) or raw arrays. */
export type GeometryLike = Geometry | {readonly vertices: ArrayLike<number>; readonly indices?: ArrayLike<number>; readonly stride?: number};

export type ShapeOptions =
  | {shape: 'box'; halfExtents?: Vec3}
  | {shape: 'sphere'; radius?: number}
  | {shape: 'capsule'; halfHeight: number; radius: number}
  | {shape: 'cylinder'; halfHeight: number; radius: number}
  | {shape: 'cone'; halfHeight: number; radius: number}
  | {shape: 'convexHull'; geometry?: GeometryLike; points?: ArrayLike<number>}
  | {shape: 'trimesh'; geometry?: GeometryLike; vertices?: ArrayLike<number>; indices?: ArrayLike<number>}
  | {shape: 'heightfield'; rows: number; columns: number; heights: ArrayLike<number>; scale: Vec3};

export type CombineRule = 'average' | 'min' | 'multiply' | 'max';

export type ColliderOptions = ShapeOptions & {
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
  /** Sensors detect overlaps (intersection events) and produce no contact forces. */
  sensor?: boolean;
  /** Packed 32-bit interaction groups, see `collisionGroups`. */
  collisionGroups?: number;
  /** Packed 32-bit solver groups: which pairs generate contact forces (contacts still detected). */
  solverGroups?: number;
  /** Emit contact or intersection start and end events (default true). */
  events?: boolean;
  /** Collider enabled (default true). */
  enabled?: boolean;
};

/** Packs Rapier interaction groups. Each side is a list of group indices 0..15 or a 16-bit mask. */
export function collisionGroups(memberships: number | readonly number[], filter: number | readonly number[] = 0xffff): number {
  const mask = (value: number | readonly number[]): number => {
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError('Group masks are 16-bit integers');
      return value;
    }
    let bits = 0;
    for (const group of value) {
      if (!Number.isInteger(group) || group < 0 || group > 15) throw new RangeError('Group indices are 0..15');
      bits |= 1 << group;
    }
    return bits;
  };
  return ((mask(memberships) << 16) | mask(filter)) >>> 0;
}

const positive = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be a positive number`);
  return value;
};

/** Positions from a geometry-like source, scaled, as a packed xyz Float32Array. */
export function geometryPositions(source: GeometryLike, scale: Vec3 = [1, 1, 1]): Float32Array {
  const vertices = source.vertices;
  // A core Geometry interleaves position and normal (stride 6); raw sources default to packed xyz.
  const stride = ('stride' in source && source.stride) || ('bounds' in source ? 6 : 3);
  if (stride < 3 || vertices.length % stride) throw new RangeError('Vertex array length is not a multiple of its stride');
  const count = vertices.length / stride, out = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) for (let a = 0; a < 3; a++) out[i * 3 + a] = vertices[i * stride + a] * scale[a];
  return out;
}

export function bounds(positions: Float32Array): {min: [number, number, number]; max: [number, number, number]} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) {
    min[a] = Math.min(min[a], positions[i + a]); max[a] = Math.max(max[a], positions[i + a]);
  }
  if (!positions.length) throw new RangeError('Geometry has no vertices');
  return {min, max};
}

/**
 * Builds a Rapier ColliderDesc. Geometry-derived shapes and auto-fitted boxes and spheres use `fit`
 * (the mesh geometry and scale); their center offset is returned so it can be added to the collider offset.
 */
export function createColliderDesc(R: RapierModule, options: ShapeOptions, fit?: {geometry: GeometryLike | null; scale: Vec3}): {desc: any; center: [number, number, number]} {
  const center: [number, number, number] = [0, 0, 0];
  const fitted = (): Float32Array => {
    if (!fit?.geometry) throw new TypeError(`A ${options.shape} collider without explicit size needs a mesh with geometry`);
    return geometryPositions(fit.geometry, fit.scale);
  };
  let desc: any;
  switch (options.shape) {
    case 'box': {
      let half = options.halfExtents;
      if (!half) {
        const {min, max} = bounds(fitted());
        half = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
        for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
      }
      checkVec(half, 'Box halfExtents');
      desc = R.ColliderDesc.cuboid(positive(half[0], 'Box half extent'), positive(half[1], 'Box half extent'), positive(half[2], 'Box half extent'));
      break;
    }
    case 'sphere': {
      let radius = options.radius;
      if (radius === undefined) {
        const points = fitted(), {min, max} = bounds(points);
        for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
        radius = 0;
        for (let i = 0; i < points.length; i += 3) radius = Math.max(radius, Math.hypot(points[i] - center[0], points[i + 1] - center[1], points[i + 2] - center[2]));
      }
      desc = R.ColliderDesc.ball(positive(radius, 'Sphere radius'));
      break;
    }
    case 'capsule': desc = R.ColliderDesc.capsule(positive(options.halfHeight, 'Capsule halfHeight'), positive(options.radius, 'Capsule radius')); break;
    case 'cylinder': desc = R.ColliderDesc.cylinder(positive(options.halfHeight, 'Cylinder halfHeight'), positive(options.radius, 'Cylinder radius')); break;
    case 'cone': desc = R.ColliderDesc.cone(positive(options.halfHeight, 'Cone halfHeight'), positive(options.radius, 'Cone radius')); break;
    case 'convexHull': {
      const points = options.points ? Float32Array.from(options.points) : options.geometry ? geometryPositions(options.geometry, fit?.scale) : fitted();
      if (points.length < 12 || points.length % 3) throw new RangeError('A convex hull needs at least 4 points');
      desc = R.ColliderDesc.convexHull(points);
      if (!desc) throw new RangeError('Convex hull computation failed (degenerate points)');
      break;
    }
    case 'trimesh': {
      const source = options.geometry ?? (options.vertices ? null : fit?.geometry);
      const vertices = options.vertices ? Float32Array.from(options.vertices) : source ? geometryPositions(source, fit?.scale) : fitted();
      const indexSource = options.indices ?? source?.indices;
      if (!indexSource) throw new TypeError('A trimesh needs indices');
      const indices = Uint32Array.from(indexSource);
      if (!indices.length || indices.length % 3 || vertices.length % 3) throw new RangeError('A trimesh needs whole triangles');
      for (let i = 0; i < indices.length; i++) if (indices[i] >= vertices.length / 3) throw new RangeError('Trimesh index exceeds vertices');
      desc = R.ColliderDesc.trimesh(vertices, indices);
      break;
    }
    case 'heightfield': {
      const {rows, columns, heights, scale} = options;
      if (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1) throw new RangeError('Heightfield rows and columns must be positive integers');
      if (heights.length !== (rows + 1) * (columns + 1)) throw new RangeError(`Heightfield needs (rows + 1) * (columns + 1) = ${(rows + 1) * (columns + 1)} heights`);
      checkVec(scale, 'Heightfield scale');
      desc = R.ColliderDesc.heightfield(rows, columns, Float32Array.from(heights), vec(scale));
      break;
    }
    default: throw new TypeError(`Unknown collider shape ${(options as {shape: string}).shape}`);
  }
  return {desc, center};
}

const combine = (R: RapierModule, rule: CombineRule): number => {
  const value = {average: R.CoefficientCombineRule.Average, min: R.CoefficientCombineRule.Min, multiply: R.CoefficientCombineRule.Multiply, max: R.CoefficientCombineRule.Max}[rule];
  if (value === undefined) throw new TypeError(`Unknown combine rule ${rule}`);
  return value;
};

/** Applies material, mass, sensor, group and offset settings to a ColliderDesc. */
export function configureCollider(R: RapierModule, desc: any, options: ColliderOptions, center: Vec3, hooks: boolean): any {
  const offset = options.offset ?? [0, 0, 0];
  checkVec(offset, 'Collider offset');
  desc.setTranslation(offset[0] + center[0], offset[1] + center[1], offset[2] + center[2]);
  if (options.rotation) desc.setRotation(quat(options.rotation));
  if (options.friction !== undefined) desc.setFriction(options.friction);
  if (options.restitution !== undefined) desc.setRestitution(options.restitution);
  if (options.frictionCombine) desc.setFrictionCombineRule(combine(R, options.frictionCombine));
  if (options.restitutionCombine) desc.setRestitutionCombineRule(combine(R, options.restitutionCombine));
  if (options.mass !== undefined) desc.setMass(options.mass);
  else if (options.density !== undefined) desc.setDensity(options.density);
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
