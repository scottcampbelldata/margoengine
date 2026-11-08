// What a collider's options mean to the kernel. On the step path, as a game can add colliders in its step: no `Math`.
import { MargoError } from '@margoengine/math/errors';
import type { KernelColliderOptions, KernelCompoundPart, KernelShape } from '../kernel.js';
import { checkVec, type Vec3 } from '../math.js';
import { bounds, geometryPositions, type ColliderGeometry, type ColliderOptions, type CompoundPart, type ShapeOptions } from '../shapes.js';
import { buildHull } from './hull.js';

const PI = 3.141592653589793;

/** The shapes the own solver holds so far, by the name their options use. */
const served: Readonly<Record<string, KernelShape | 'compound'>> = {
  box: 'box',
  sphere: 'ball',
  capsule: 'capsule',
  convexHull: 'hull',
  trimesh: 'trimesh',
  heightfield: 'trimesh',
  compound: 'compound',
};
/** The convex parts a compound takes, and the parts the own solver holds so far. */
const CONVEX_PARTS = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convexHull'],
  SERVED_PARTS = ['box', 'sphere', 'capsule', 'convexHull'];

/** What the kernel needs for one collider. */
export interface KernelCollider {
  name: ShapeOptions['shape'];
  shape: KernelShape | 'compound';
  size: number[];
  /** A compound's children, for KernelWorld.addCompound. */
  parts?: KernelCompoundPart[];
  options: KernelColliderOptions;
}

/** True when the own solver holds this shape. */
export function shapeServed(shape: ShapeOptions['shape']): boolean {
  return Object.hasOwn(served, shape);
}

function volume(shape: KernelShape, size: readonly number[], hullVolume: (row: number) => number): number {
  if (shape === 'box') return 8 * size[0] * size[1] * size[2];
  if (shape === 'hull') return hullVolume(size[0]);
  if (shape === 'trimesh') return 0;
  const [radius, halfLength = 0] = size;
  return PI * radius * radius * ((4 / 3) * radius + 2 * halfLength);
}

/**
 * A compound's parts as kernel children, each sized from its own options: parts are never fitted to the mesh.
 * @throws RangeError for no parts; TypeError for a part that is not convex or leaves out its size.
 */
function compoundParts(parts: readonly CompoundPart[], hulls: HullRows): KernelCompoundPart[] {
  if (!Array.isArray(parts) || !parts.length)
    throw new RangeError("A compound collider needs at least one part: {shape: 'compound', parts: [{shape: 'box', halfExtents: [1, 1, 1]}]}");
  return parts.map((part) => {
    if (!CONVEX_PARTS.includes(part?.shape))
      throw new TypeError(
        `Compound part shape ${String(part?.shape)} is not convex; use box, sphere, capsule, cylinder, cone or convexHull parts.`,
      );
    if (!SERVED_PARTS.includes(part.shape))
      throw new MargoError(
        'unsupported',
        `A ${part.shape} compound part is not in the own solver yet; use box, sphere, capsule or convexHull parts, or @margoengine/physics.`,
      );
    const offset = part.offset ?? [0, 0, 0];
    checkVec(offset, 'Compound part offset');
    const placed = { position: [offset[0], offset[1], offset[2]] as [number, number, number], rotation: part.rotation };
    if (part.shape === 'box') {
      if (!part.halfExtents) throw new TypeError('A compound box part needs halfExtents; parts are never fitted to the mesh.');
      checkVec(part.halfExtents, 'Compound box halfExtents');
      return { shape: 'box', size: [...part.halfExtents], ...placed };
    }
    if (part.shape === 'sphere') {
      if (part.radius === undefined) throw new TypeError('A compound sphere part needs a radius; parts are never fitted to the mesh.');
      return { shape: 'ball', size: [part.radius], ...placed };
    }
    if (part.shape === 'capsule') return { shape: 'capsule', size: [part.radius, part.halfHeight], ...placed };
    if (!part.points) throw new TypeError('A compound convexHull part needs points; parts are never fitted to the mesh.');
    const { vertices, faces } = buildHull(Float32Array.from(part.points));
    return { shape: 'hull', size: [hulls.addHull(vertices, faces)], ...placed };
  });
}

/** The radius that holds every point of a mesh around the centre of its bounds. */
function fittedSphere(points: Float32Array, center: number[]): number[] {
  let squared = 0;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - center[0],
      y = points[i + 1] - center[1],
      z = points[i + 2] - center[2];
    if (x * x + y * y + z * z > squared) squared = x * x + y * y + z * z;
  }
  // Newton from above, as a square root in JavaScript is not promised to round the same everywhere.
  let radius = squared > 1 ? squared : 1;
  for (let i = 0; i < 64 && radius * radius > squared * (1 + 1e-12); i++) radius = (radius + squared / radius) / 2;
  return [radius];
}

/** What building a collider needs from its world: a hull's row for its faces, a hull row's volume, a mesh's or a height field's row. */
export interface HullRows {
  addHull(vertices: readonly (readonly [number, number, number])[], faces: readonly (readonly number[])[]): number;
  hullVolume(row: number): number;
  addTrimesh(vertices: Float32Array, indices: Uint32Array, fixInternalEdges: boolean): number;
  addHeightfield(rows: number, columns: number, heights: ArrayLike<number>, scale: Vec3, fixInternalEdges: boolean): number;
}

/**
 * Turns collider options into kernel arguments. Box and sphere sizes left out are fitted to `fit`, as the Rapier entry does,
 * and a convex hull without points or geometry is the hull of the mesh.
 * @throws MargoError (`unsupported`) for a shape the own solver does not hold yet.
 * @throws TypeError when a size is left out and there is no geometry to fit.
 * @throws RangeError for hull points that span no volume.
 */
export function kernelCollider(
  options: ColliderOptions,
  fit: { geometry: ColliderGeometry | null; scale: Vec3 },
  hulls: HullRows,
): KernelCollider {
  const shape = shapeServed(options.shape) ? served[options.shape] : undefined;
  if (!shape)
    throw new MargoError(
      'unsupported',
      `The ${options.shape} shape is not in the own solver yet; use box, sphere, capsule, convexHull, trimesh, heightfield or compound, or @margoengine/physics.`,
    );
  const fitted = (): Float32Array => {
      if (!fit.geometry) throw new TypeError(`A ${options.shape} collider without explicit size needs a mesh with geometry`);
      return geometryPositions(fit.geometry, fit.scale);
    },
    center = [0, 0, 0];
  let size: number[],
    parts: KernelCompoundPart[] | undefined;
  if (options.shape === 'box') {
    let half = options.halfExtents;
    if (!half) {
      const { min, max } = bounds(fitted());
      half = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
      for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
    }
    checkVec(half, 'Box halfExtents');
    size = [...half];
  } else if (options.shape === 'sphere') {
    if (options.radius === undefined) {
      const points = fitted(),
        { min, max } = bounds(points);
      for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
      size = fittedSphere(points, center);
    } else size = [options.radius];
  } else if (options.shape === 'capsule') size = [options.radius, options.halfHeight];
  else if (options.shape === 'convexHull') {
    const points = options.points ?? (options.geometry ? geometryPositions(options.geometry, fit.scale) : fitted()),
      { vertices, faces } = buildHull(points);
    size = [hulls.addHull(vertices, faces)];
  } else if (options.shape === 'trimesh') {
    const source = options.geometry ?? (options.vertices ? null : fit.geometry),
      vertices = options.vertices ? Float32Array.from(options.vertices) : source ? geometryPositions(source, fit.scale) : fitted(),
      indexSource = options.indices ?? source?.indices;
    if (!indexSource) throw new TypeError('A trimesh needs indices; pass indices or a geometry that has them.');
    if (!indexSource.length || indexSource.length % 3 || vertices.length % 3)
      throw new RangeError('A trimesh needs whole triangles; pass three indices per triangle and three numbers per vertex.');
    for (let i = 0; i < vertices.length; i++)
      if (!Number.isFinite(vertices[i])) throw new RangeError('Trimesh vertices must be finite Float32 values.');
    if (options.mass !== undefined || options.density !== undefined)
      throw new RangeError(
        'A trimesh has no volume, so no mass or density; give the body its mass with setMassProperties, or use convexHull or convexDecomposition.',
      );
    size = [hulls.addTrimesh(vertices, Uint32Array.from(indexSource), options.fixInternalEdges ?? false)];
  } else if (options.shape === 'heightfield') {
    if (options.mass !== undefined || options.density !== undefined)
      throw new RangeError(
        'A heightfield has no volume, so no mass or density; make its body fixed, or give the body its mass with setMassProperties.',
      );
    checkVec(options.scale, 'Heightfield scale');
    size = [hulls.addHeightfield(options.rows, options.columns, options.heights, options.scale, options.fixInternalEdges ?? false)];
  } else if (options.shape === 'compound') {
    parts = compoundParts(options.parts, hulls);
    size = [];
  } else throw new TypeError(`Unknown shape ${options.shape}; use box, sphere, capsule, convexHull, trimesh, heightfield or compound.`);
  const offset = options.offset ?? [0, 0, 0];
  checkVec(offset, 'Collider offset');
  const whole = (): number =>
      parts
        ? parts.reduce((sum, part) => sum + volume(part.shape, part.size, hulls.hullVolume), 0)
        : volume(shape as KernelShape, size, hulls.hullVolume),
    density = options.massless || shape === 'trimesh'
      ? 0
      : options.mass !== undefined
        ? options.mass / whole()
        : (options.density ?? 1);
  return {
    name: options.shape,
    shape,
    size,
    parts,
    options: {
      position: [offset[0] + center[0], offset[1] + center[1], offset[2] + center[2]],
      rotation: options.rotation,
      density,
      friction: options.friction,
      restitution: options.restitution,
      frictionCombine: options.frictionCombine,
      restitutionCombine: options.restitutionCombine,
    },
  };
}
