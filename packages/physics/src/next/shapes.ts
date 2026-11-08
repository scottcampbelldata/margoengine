// What a collider's options mean to the kernel. On the step path, as a game can add colliders in its step: no `Math`.
import { MargoError } from '@margoengine/math/errors';
import type { KernelColliderOptions, KernelCompoundPart, KernelQueryShape, KernelShape } from '../kernel.js';
import { checkVec, type Vec3 } from '../math.js';
import { bounds, geometryPositions, type ColliderGeometry, type ColliderOptions, type CompoundPart, type ShapeOptions } from '../shapes.js';
import { buildHull } from './hull.js';

const PI = 3.141592653589793;

/** The shapes the own solver holds so far, by the name their options use. */
const served: Readonly<Record<string, KernelShape | 'compound'>> = {
  box: 'box',
  sphere: 'ball',
  capsule: 'capsule',
  cylinder: 'cylinder',
  cone: 'cone',
  convexHull: 'hull',
  trimesh: 'trimesh',
  heightfield: 'trimesh',
  compound: 'compound',
  voxels: 'trimesh',
};
/** The convex parts a compound takes, and the parts the own solver holds so far. */
const CONVEX_PARTS = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convexHull'];

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

/** A square root by Newton's steps from above, as `Math.sqrt` is not promised to round the same everywhere. */
function root(squared: number): number {
  let value = squared > 1 ? squared : 1;
  for (let i = 0; i < 64 && value * value > squared * (1 + 1e-15); i++) value = (value + squared / value) / 2;
  return value;
}

/** The arctangent of `x` >= 0, by halving the angle (atan x = 2 atan(x / (1 + sqrt(1 + x^2)))) and then its series. */
function arctan(x: number): number {
  let scale = 1;
  while (x > 0.0625) {
    x /= 1 + root(1 + x * x);
    scale *= 2;
  }
  let sum = 0,
    term = x;
  for (let n = 1; n < 40; n += 2, term *= -x * x) sum += term / n;
  return scale * sum;
}

/**
 * A cylinder's or cone's volume with its border, by Pappus: 2 pi times the first moment about the axis of its profile, the
 * core's rectangle or triangle with a strip along each outer side and a sector at each outer corner, as the kernel's
 * `revolved_mass` adds them up.
 */
function revolvedVolume(cone: boolean, r: number, h: number, b: number): number {
  if (!cone) return 2 * PI * (h * r * r + 2 * h * b * (r + b / 2) + r * r * b + ((PI * b * b) / 2) * (r + (4 * b) / (3 * PI)));
  // The slanted side's length, its outward normal (nr, ny) and that normal's angle above the base.
  const length = root(4 * h * h + r * r),
    nr = (2 * h) / length,
    ny = r / length,
    side = arctan(r / (2 * h));
  const core = (r * r * h) / 3,
    strip = (length * b * (r + b * nr)) / 2,
    base = (r * r * b) / 2,
    rim = (r * b * b * (side + PI / 2)) / 2 + (b * b * b * (ny + 1)) / 3,
    apex = (b * b * b * (1 - ny)) / 3;
  return 2 * PI * (core + strip + base + rim + apex);
}

function volume(shape: KernelShape, size: readonly number[], hullVolume: (row: number) => number): number {
  if (shape === 'box') return 8 * size[0] * size[1] * size[2];
  if (shape === 'hull') return hullVolume(size[0]);
  if (shape === 'trimesh') return 0;
  if (shape === 'cylinder' || shape === 'cone') return revolvedVolume(shape === 'cone', size[0], size[1], size[2]);
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
    if (part.shape === 'cylinder' || part.shape === 'cone') return { shape: part.shape, size: revolvedSize(part), ...placed };
    if (!part.points) throw new TypeError('A compound convexHull part needs points; parts are never fitted to the mesh.');
    const { vertices, faces } = buildHull(Float32Array.from(part.points));
    return { shape: 'hull', size: [hulls.addHull(vertices, faces)], ...placed };
  });
}

/** A cylinder's or cone's kernel size: radius, half height and border radius (Rapier's `roundCylinder`, `roundCone`). */
function revolvedSize(options: { radius: number; halfHeight: number; borderRadius?: number }): number[] {
  const { radius, halfHeight, borderRadius = 0 } = options;
  if (!(borderRadius >= 0) || !Number.isFinite(borderRadius))
    throw new RangeError(`A border radius is 0 or more and finite (got ${borderRadius}); it rounds the shape's edges outside its radius and half height.`);
  return [radius, halfHeight, borderRadius];
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
  addVoxels(cells: Int32Array, size: Vec3): number;
}

/** The volume of a voxels collider's distinct cells. */
function voxelVolume(cells: Int32Array, size: Vec3): number {
  const seen = new Set<string>();
  for (let i = 0; i < cells.length; i += 3) seen.add(`${cells[i]},${cells[i + 1]},${cells[i + 2]}`);
  return seen.size * size[0] * size[1] * size[2];
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
      `The ${options.shape} shape is not in the own solver yet; use box, sphere, capsule, cylinder, cone, convexHull, trimesh, heightfield, compound or voxels, or @margoengine/physics.`,
    );
  const fitted = (): Float32Array => {
      if (!fit.geometry) throw new TypeError(`A ${options.shape} collider without explicit size needs a mesh with geometry`);
      return geometryPositions(fit.geometry, fit.scale);
    },
    center = [0, 0, 0];
  let size: number[],
    parts: KernelCompoundPart[] | undefined,
    voxels: number | undefined;
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
  else if (options.shape === 'cylinder' || options.shape === 'cone') size = revolvedSize(options);
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
  } else if (options.shape === 'voxels') {
    const { cells, size: cell = [1, 1, 1] } = options;
    if (!(cells instanceof Int32Array) || cells.length % 3)
      throw new TypeError('A voxels collider needs cells as an Int32Array of x, y, z cell coordinates, three per cell.');
    checkVec(cell, 'Voxel size');
    for (const value of cell)
      if (!(value > 0)) throw new RangeError(`Voxel size must be above zero on every axis (got ${cell.join(', ')}); pass one cell's size in metres.`);
    voxels = voxelVolume(cells, cell);
    size = [hulls.addVoxels(cells, cell)];
  } else
    throw new TypeError(`Unknown shape ${options.shape}; use box, sphere, capsule, cylinder, cone, convexHull, trimesh, heightfield, compound or voxels.`);
  const offset = options.offset ?? [0, 0, 0];
  checkVec(offset, 'Collider offset');
  const whole = (): number =>
      parts
        ? parts.reduce((sum, part) => sum + volume(part.shape, part.size, hulls.hullVolume), 0)
        : (voxels ?? volume(shape as KernelShape, size, hulls.hullVolume)),
    density = options.massless || (shape === 'trimesh' && voxels === undefined)
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

/**
 * A query shape for `shapeCast` and `intersectShape`: a sphere, box, capsule, cylinder, cone or convexHull with its size
 * given.
 * @throws MargoError `unsupported` for another shape or one sized from a mesh; RangeError for hull points that span no
 * volume.
 */
export function queryShape(options: ShapeOptions, hulls: HullRows): KernelQueryShape {
  if (options.shape === 'sphere' && options.radius !== undefined) return { shape: 'ball', size: [options.radius] };
  if (options.shape === 'box' && options.halfExtents) {
    checkVec(options.halfExtents, 'Box halfExtents');
    return { shape: 'box', size: [...options.halfExtents] };
  }
  if (options.shape === 'capsule') return { shape: 'capsule', size: [options.radius, options.halfHeight] };
  if (options.shape === 'cylinder' || options.shape === 'cone') return { shape: options.shape, size: revolvedSize(options) };
  if (options.shape === 'convexHull' && options.points) {
    const { vertices, faces } = buildHull(options.points);
    return { shape: 'hull', size: [hulls.addHull(vertices, faces)] };
  }
  throw new MargoError(
    'unsupported',
    `A ${String(options?.shape)} query shape is not in the own solver yet; cast or overlap a sphere, box, capsule, cylinder, cone or convexHull with its size or points given, or use @margoengine/physics.`,
  );
}
