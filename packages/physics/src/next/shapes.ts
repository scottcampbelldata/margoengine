// What a collider's options mean to the kernel. On the step path, as a game can add colliders in its step: no `Math`.
import { MargoError } from '@margoengine/math/errors';
import type { KernelColliderOptions, KernelShape } from '../kernel.js';
import { checkVec, type Vec3 } from '../math.js';
import { bounds, geometryPositions, type ColliderGeometry, type ColliderOptions, type ShapeOptions } from '../shapes.js';
import { buildHull } from './hull.js';

const PI = 3.141592653589793;

/** The shapes the own solver holds so far, by the name their options use. */
const served: Readonly<Record<string, KernelShape>> = { box: 'box', sphere: 'ball', capsule: 'capsule', convexHull: 'hull' };

/** What the kernel needs for one collider. */
export interface KernelCollider {
  name: ShapeOptions['shape'];
  shape: KernelShape;
  size: number[];
  options: KernelColliderOptions;
}

/** True when the own solver holds this shape. */
export function shapeServed(shape: ShapeOptions['shape']): boolean {
  return Object.hasOwn(served, shape);
}

function volume(shape: KernelShape, size: readonly number[], hullVolume: (row: number) => number): number {
  if (shape === 'box') return 8 * size[0] * size[1] * size[2];
  if (shape === 'hull') return hullVolume(size[0]);
  const [radius, halfLength = 0] = size;
  return PI * radius * radius * ((4 / 3) * radius + 2 * halfLength);
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

/** What building a collider needs from its world: a hull's row for its faces, and a hull row's volume. */
export interface HullRows {
  addHull(vertices: readonly (readonly [number, number, number])[], faces: readonly (readonly number[])[]): number;
  hullVolume(row: number): number;
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
      `The ${options.shape} shape is not in the own solver yet; use box, sphere, capsule or convexHull, or @margoengine/physics.`,
    );
  const fitted = (): Float32Array => {
      if (!fit.geometry) throw new TypeError(`A ${options.shape} collider without explicit size needs a mesh with geometry`);
      return geometryPositions(fit.geometry, fit.scale);
    },
    center = [0, 0, 0];
  let size: number[];
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
  } else throw new TypeError(`Unknown shape ${options.shape}; use box, sphere, capsule or convexHull.`);
  const offset = options.offset ?? [0, 0, 0];
  checkVec(offset, 'Collider offset');
  const density = options.massless
    ? 0
    : options.mass !== undefined
      ? options.mass / volume(shape, size, hulls.hullVolume)
      : (options.density ?? 1);
  return {
    name: options.shape,
    shape,
    size,
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
