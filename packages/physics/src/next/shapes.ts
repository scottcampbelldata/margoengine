// What a collider's options mean to the kernel. On the step path, as a game can add colliders in its step: no `Math`.
import { MargoError } from '@margoengine/math/errors';
import type { KernelColliderOptions, KernelCompoundPart, KernelQueryShape, KernelShape } from '../kernel.js';
import { checkVec, type Vec3 } from '../math.js';
import { bounds, geometryPositions, roundness, usedVertices, type ColliderGeometry, type ColliderOptions, type CompoundPart, type ShapeOptions } from '../shapes.js';
import { buildHull } from './hull.js';
import { cleanTrimesh, wantsClean } from './mesh-clean.js';

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
  convexDecomposition: 'compound',
  voxels: 'trimesh',
  // A segment is a capsule with no radius, a triangle a one-triangle mesh and a polyline a compound of segments.
  segment: 'capsule',
  triangle: 'trimesh',
  polyline: 'compound',
  halfSpace: 'halfspace',
};
/** The convex parts a compound takes, and the parts the own solver holds so far. */
const CONVEX_PARTS = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'convexHull'];

type Quat4 = readonly [number, number, number, number];
const multiply = (a: Quat4, b: Quat4): [number, number, number, number] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/** `v` turned by the unit quaternion `q`. */
function turn(q: Quat4, v: Vec3): Vec3 {
  const t = [2 * (q[1] * v[2] - q[2] * v[1]), 2 * (q[2] * v[0] - q[0] * v[2]), 2 * (q[0] * v[1] - q[1] * v[0])];
  return [
    v[0] + q[3] * t[0] + q[1] * t[2] - q[2] * t[1],
    v[1] + q[3] * t[1] + q[2] * t[0] - q[0] * t[2],
    v[2] + q[3] * t[2] + q[0] * t[1] - q[1] * t[0],
  ];
}

/**
 * A segment as the capsule with no radius that holds it: its middle, the turn that stands local Y along it, and half its length.
 * @throws RangeError for a segment of no length.
 */
function segmentFrame(a: Vec3, b: Vec3, label: string): { middle: Vec3; rotation: Quat4; half: number } {
  checkVec(a, `${label} a`);
  checkVec(b, `${label} b`);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    squared = d[0] * d[0] + d[1] * d[1] + d[2] * d[2],
    length = root(squared);
  if (!(squared > 0)) throw new RangeError(`A ${label.toLowerCase()} needs two different points; a and b are the same.`);
  const y = d[1] / length;
  // The shortest turn from +Y to the direction: the axis Y x d with the angle's half in w, and a half turn about X for -Y.
  let q: [number, number, number, number];
  if (y < -0.999999) q = [1, 0, 0, 0];
  else {
    const w = 1 + y,
      x = d[2] / length,
      z = -d[0] / length,
      norm = root(x * x + z * z + w * w);
    q = [x / norm, 0, z / norm, w / norm];
  }
  return { middle: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], rotation: q, half: length / 2 };
}

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
  if (shape === 'trimesh' || shape === 'halfspace') return 0;
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
      return { shape: 'box', size: [...part.halfExtents], border: roundness(part.borderRadius, 'Compound box'), ...placed };
    }
    if (part.shape === 'sphere') {
      if (part.radius === undefined) throw new TypeError('A compound sphere part needs a radius; parts are never fitted to the mesh.');
      return { shape: 'ball', size: [part.radius], ...placed };
    }
    if (part.shape === 'capsule') return { shape: 'capsule', size: [part.radius, part.halfHeight], ...placed };
    if (part.shape === 'cylinder' || part.shape === 'cone') return { shape: part.shape, size: revolvedSize(part), ...placed };
    if (!part.points) throw new TypeError('A compound convexHull part needs points; parts are never fitted to the mesh.');
    const { vertices, faces } = buildHull(Float32Array.from(part.points));
    return { shape: 'hull', size: [hulls.addHull(vertices, faces)], border: roundness(part.borderRadius, 'Compound hull'), ...placed };
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
  addTrimesh(vertices: Float32Array, indices: Uint32Array, fixInternalEdges: boolean, oriented?: boolean): number;
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
      `The ${options.shape} shape is not in the own solver yet; use box, sphere, capsule, cylinder, cone, convexHull, trimesh, heightfield, compound, convexDecomposition, voxels, segment, triangle, polyline or halfSpace, or @margoengine/physics.`,
    );
  const fitted = (): Float32Array => {
      if (!fit.geometry) throw new TypeError(`A ${options.shape} collider without explicit size needs a mesh with geometry`);
      return geometryPositions(fit.geometry, fit.scale);
    },
    center = [0, 0, 0];
  let size: number[],
    parts: KernelCompoundPart[] | undefined,
    voxels: number | undefined,
    segment: { middle: Vec3; rotation: Quat4 } | undefined,
    border = 0;
  const surface = options.shape === 'segment' || options.shape === 'triangle' || options.shape === 'polyline' || options.shape === 'halfSpace';
  if (surface && (options.mass !== undefined || options.density !== undefined))
    throw new RangeError(
      `A ${options.shape} has no volume, so no mass or density; give the body its mass with setMassProperties, or use a convexHull or box.`,
    );
  if (options.shape === 'box') {
    let half = options.halfExtents;
    if (!half) {
      const { min, max } = bounds(fitted());
      half = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
      for (let a = 0; a < 3; a++) center[a] = (min[a] + max[a]) / 2;
    }
    checkVec(half, 'Box halfExtents');
    size = [...half];
    border = roundness(options.borderRadius, 'Box');
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
    const points = options.points ?? (options.vertices && options.indices ? usedVertices(options.vertices, options.indices) : options.geometry ? geometryPositions(options.geometry, fit.scale) : fitted()),
      { vertices, faces } = buildHull(points);
    size = [hulls.addHull(vertices, faces)];
    border = roundness(options.borderRadius, 'Convex hull');
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
    let meshVertices: Float32Array = vertices,
      meshIndices: Uint32Array = Uint32Array.from(indexSource);
    if (wantsClean(options)) ({ vertices: meshVertices, indices: meshIndices } = cleanTrimesh(vertices, meshIndices, options));
    if (!meshIndices.length) throw new RangeError('Every triangle of the trimesh was dropped by its clean-up flags; keep some, or leave the flags out.');
    size = [hulls.addTrimesh(Float32Array.from(meshVertices), Uint32Array.from(meshIndices), options.fixInternalEdges ?? false, options.oriented ?? false)];
  } else if (options.shape === 'heightfield') {
    if (options.mass !== undefined || options.density !== undefined)
      throw new RangeError(
        'A heightfield has no volume, so no mass or density; make its body fixed, or give the body its mass with setMassProperties.',
      );
    checkVec(options.scale, 'Heightfield scale');
    size = [hulls.addHeightfield(options.rows, options.columns, options.heights, options.scale, options.fixInternalEdges ?? false)];
  } else if (options.shape === 'segment') {
    const frame = segmentFrame(options.a, options.b, 'Segment');
    size = [0, frame.half];
    segment = frame;
  } else if (options.shape === 'halfSpace') {
    const normal = options.normal ?? [0, 1, 0];
    checkVec(normal, 'Half space normal');
    const squared = normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2],
      length = root(squared);
    if (!(squared > 0)) throw new RangeError('A half space needs a nonzero normal; pass the direction out of the solid.');
    size = [normal[0] / length, normal[1] / length, normal[2] / length];
  } else if (options.shape === 'triangle') {
    checkVec(options.a, 'Triangle a');
    checkVec(options.b, 'Triangle b');
    checkVec(options.c, 'Triangle c');
    size = [hulls.addTrimesh(Float32Array.of(...options.a, ...options.b, ...options.c), Uint32Array.of(0, 1, 2), false)];
    border = roundness(options.borderRadius, 'Triangle');
  } else if (options.shape === 'polyline') {
    const points = Float32Array.from(options.vertices);
    if (points.length < 6 || points.length % 3) throw new RangeError('A polyline needs at least two vertices, three numbers each.');
    const count = points.length / 3,
      pairs = options.indices ? Array.from(options.indices) : Array.from({ length: (count - 1) * 2 }, (_, i) => (i >> 1) + (i & 1));
    if (!pairs.length || pairs.length % 2) throw new RangeError('A polyline needs whole segments; pass two indices per segment.');
    parts = [];
    for (let i = 0; i < pairs.length; i += 2) {
      for (const index of [pairs[i], pairs[i + 1]])
        if (!Number.isInteger(index) || index < 0 || index >= count)
          throw new RangeError('Polyline index is out of range; keep every index below the vertex count.');
      const a = Array.from(points.subarray(3 * pairs[i], 3 * pairs[i] + 3)) as unknown as Vec3,
        b = Array.from(points.subarray(3 * pairs[i + 1], 3 * pairs[i + 1] + 3)) as unknown as Vec3,
        frame = segmentFrame(a, b, 'Polyline segment');
      parts.push({ shape: 'capsule', size: [0, frame.half], position: frame.middle, rotation: frame.rotation });
    }
    size = [];
  } else if (options.shape === 'compound') {
    parts = compoundParts(options.parts, hulls);
    size = [];
  } else if (options.shape === 'convexDecomposition') {
    // The search is build-time work in its own entry, so a game that never decomposes never loads it.
    if (!options.parts)
      throw new MargoError(
        'unsupported',
        "The own solver takes a decomposed mesh, not the mesh: import { convexDecomposition } from '@margoengine/physics/decomposition' and pass its result, body.addCollider(convexDecomposition({ vertices, indices })).",
      );
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
    throw new TypeError(`Unknown shape ${options.shape}; use box, sphere, capsule, cylinder, cone, convexHull, trimesh, heightfield, compound, convexDecomposition or voxels.`);
  let offset = options.offset ?? [0, 0, 0],
    rotation = options.rotation;
  checkVec(offset, 'Collider offset');
  if (segment) {
    // The capsule stands in the collider's frame, which is itself turned in the body's.
    const turned = rotation ? turn(rotation as Quat4, segment.middle) : segment.middle;
    offset = [offset[0] + turned[0], offset[1] + turned[1], offset[2] + turned[2]];
    rotation = rotation ? multiply(rotation as Quat4, segment.rotation) : [...segment.rotation];
  }
  const whole = (): number =>
      parts
        ? parts.reduce((sum, part) => sum + volume(part.shape, part.size, hulls.hullVolume), 0)
        : (voxels ?? volume(shape as KernelShape, size, hulls.hullVolume)),
    density = options.massless || surface || (shape === 'trimesh' && voxels === undefined)
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
      rotation,
      density,
      friction: options.friction,
      restitution: options.restitution,
      frictionCombine: options.frictionCombine,
      restitutionCombine: options.restitutionCombine,
      border,
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
  const border = options.shape === 'box' || options.shape === 'convexHull' ? roundness(options.borderRadius, 'Query shape') : 0;
  if (options.shape === 'sphere' && options.radius !== undefined) return { shape: 'ball', size: [options.radius] };
  if (options.shape === 'box' && options.halfExtents) {
    checkVec(options.halfExtents, 'Box halfExtents');
    if (border > 0) {
      // A round box is a hull of its corners with a border, as the kernel holds the query's rounded polyhedra.
      const [x, y, z] = options.halfExtents,
        points = Float32Array.from([-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z]),
        { vertices, faces } = buildHull(points);
      return { shape: 'hull', size: [hulls.addHull(vertices, faces), border] };
    }
    return { shape: 'box', size: [...options.halfExtents] };
  }
  if (options.shape === 'segment') {
    const frame = segmentFrame(options.a, options.b, 'Segment');
    return { shape: 'capsule', size: [0, frame.half], placed: { offset: frame.middle, turn: frame.rotation } };
  }
  if (options.shape === 'triangle') {
    checkVec(options.a, 'Triangle a');
    checkVec(options.b, 'Triangle b');
    checkVec(options.c, 'Triangle c');
    const round = roundness(options.borderRadius, 'Triangle'),
      row = hulls.addTrimesh(Float32Array.of(...options.a, ...options.b, ...options.c), Uint32Array.of(0, 1, 2), false);
    return { shape: 'trimesh', size: round > 0 ? [row, round] : [row] };
  }
  if (options.shape === 'capsule') return { shape: 'capsule', size: [options.radius, options.halfHeight] };
  if (options.shape === 'cylinder' || options.shape === 'cone') return { shape: options.shape, size: revolvedSize(options) };
  if (options.shape === 'convexHull' && options.points) {
    const { vertices, faces } = buildHull(options.points);
    return { shape: 'hull', size: border > 0 ? [hulls.addHull(vertices, faces), border] : [hulls.addHull(vertices, faces)] };
  }
  throw new MargoError(
    'unsupported',
    `A ${String(options?.shape)} query shape is not in the own solver yet; cast or overlap a sphere, box, capsule, cylinder, cone, segment, triangle or convexHull with its size or points given, or use @margoengine/physics.`,
  );
}
