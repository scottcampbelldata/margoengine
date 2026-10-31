import type { ColliderDesc2D, RapierModule2D } from './rapier-types.js';

/** A 2D point or vector [x, y]. */
export type Vec2D = readonly [number, number];

/** How a collider is shaped. Sizes are in world units (sprite pixels). */
export type ShapeOptions2D =
  | {
      /** A box centred on the body (move it with `offset`). */
      shape: 'box';
      width: number;
      height: number;
    }
  | { shape: 'circle'; radius: number }
  | {
      /** A vertical pill: `height` is the whole length including both round ends. */
      shape: 'capsule';
      radius: number;
      height: number;
    }
  | {
      /** A filled polygon, convex or concave (concave ones are split into convex pieces). */
      shape: 'polygon';
      points: readonly Vec2D[];
    }
  | {
      /** Edges with no area: terrain outlines. Close the loop by repeating the first point. */
      shape: 'polyline';
      points: readonly Vec2D[];
    }
  | { shape: 'segment'; from: Vec2D; to: Vec2D };

/** Material, sensor and filtering settings of a collider. */
export interface ColliderSettings2D {
  /** Position of the collider relative to its body, world units. Default [0, 0]. */
  offset?: Vec2D;
  /** Rotation relative to its body, radians. Default 0. */
  rotation?: number;
  friction?: number;
  restitution?: number;
  /** Mass per square metre (Rapier units). Default 1. */
  density?: number;
  /** Overrides density with a total mass in Rapier units. */
  mass?: number;
  /** Sensors report overlaps (`intersectionstart`) and push nothing. */
  sensor?: boolean;
  /** Packed interaction groups, see `interactionGroups`. */
  collisionGroups?: number;
  /** Emit contact or intersection events (default true). */
  events?: boolean;
}

/** Options for a collider: shape plus settings. */
export type ColliderOptions2D = ShapeOptions2D & ColliderSettings2D;

const groupMask = (value: number | readonly number[]): number => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff)
      throw new RangeError(
        `A group mask must be an integer 0..65535, got ${value}; or pass an array of group indices.`,
      );
    return value;
  }
  return value.reduce((bits, group) => {
    if (!Number.isInteger(group) || group < 0 || group > 15)
      throw new RangeError(`A group index must be an integer 0..15, got ${group}; there are 16 groups.`);
    return bits | (1 << group);
  }, 0);
};

/**
 * Packs Rapier interaction groups into one number. `memberships` are the groups a collider belongs to and `filter` the
 * groups it interacts with, each as an array of group indices 0..15 or a 16-bit mask. Two colliders interact when each
 * one's filter includes a group of the other's memberships.
 */
export function interactionGroups(
  memberships: number | readonly number[],
  filter: number | readonly number[] = 0xffff,
): number {
  return ((groupMask(memberships) << 16) | groupMask(filter)) >>> 0;
}

const finite = (value: number, what: string, positive = false): number => {
  if (!Number.isFinite(value) || (positive && value <= 0))
    throw new RangeError(`${what} must be a finite number${positive ? ' above 0' : ''}, got ${value}; fix the value.`);
  return value;
};

function flatten(points: readonly Vec2D[], scale: number, min: number, what: string): Float32Array {
  if (!Array.isArray(points) || points.length < min)
    throw new TypeError(`${what} needs at least ${min} points as [x, y] pairs; pass more points.`);
  const out = new Float32Array(points.length * 2);
  points.forEach((p, i) => {
    out[2 * i] = finite(p[0], `${what} x`) * scale;
    out[2 * i + 1] = finite(p[1], `${what} y`) * scale;
  });
  return out;
}

/** True when the polygon's turns all go one way (collinear points allowed). */
function isConvex(points: readonly Vec2D[]): boolean {
  let sign = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i],
      b = points[(i + 1) % n],
      c = points[(i + 2) % n];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross !== 0) {
      if (sign !== 0 && Math.sign(cross) !== sign) return false;
      sign = Math.sign(cross);
    }
  }
  return true;
}

function polygonDesc(R: RapierModule2D, points: readonly Vec2D[], scale: number): ColliderDesc2D {
  const flat = flatten(points, scale, 3, 'polygon');
  // Rapier builds hulls lazily and fails later in createCollider, so a flat polygon is caught here.
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  if (!(Math.abs(area) > 1e-9))
    throw new RangeError('polygon points are degenerate (no area); give at least three points not on a line.');
  let desc: ColliderDesc2D | null;
  if (isConvex(points)) desc = R.ColliderDesc.convexHull(flat);
  else {
    const n = points.length,
      edges = new Uint32Array(n * 2);
    for (let i = 0; i < n; i++) {
      edges[2 * i] = i;
      edges[2 * i + 1] = (i + 1) % n;
    }
    desc = R.ColliderDesc.convexDecomposition(flat, edges);
  }
  if (!desc) throw new RangeError('polygon points could not form a shape; give at least three points not on a line.');
  return desc;
}

/** Builds a Rapier collider description; `scale` is metres per world unit. */
export function createColliderDesc(R: RapierModule2D, options: ColliderOptions2D, scale: number): ColliderDesc2D {
  const D = R.ColliderDesc;
  let desc: ColliderDesc2D;
  switch (options.shape) {
    case 'box':
      desc = D.cuboid(
        (finite(options.width, 'box width', true) * scale) / 2,
        (finite(options.height, 'box height', true) * scale) / 2,
      );
      break;
    case 'circle':
      desc = D.ball(finite(options.radius, 'circle radius', true) * scale);
      break;
    case 'capsule': {
      const r = finite(options.radius, 'capsule radius', true);
      const half = Math.max(0, finite(options.height, 'capsule height', true) / 2 - r);
      desc = D.capsule(half * scale, r * scale);
      break;
    }
    case 'polygon':
      desc = polygonDesc(R, options.points, scale);
      break;
    case 'polyline':
      desc = D.polyline(flatten(options.points, scale, 2, 'polyline'), null);
      break;
    case 'segment':
      desc = D.segment(
        { x: finite(options.from[0], 'segment from') * scale, y: finite(options.from[1], 'segment from') * scale },
        { x: finite(options.to[0], 'segment to') * scale, y: finite(options.to[1], 'segment to') * scale },
      );
      break;
    default:
      throw new TypeError(
        `Unknown collider shape "${(options as { shape?: string }).shape}"; use box, circle, capsule, polygon, polyline or segment.`,
      );
  }
  const [ox, oy] = options.offset ?? [0, 0];
  if (ox || oy) desc.setTranslation(ox * scale, oy * scale);
  if (options.rotation) desc.setRotation(options.rotation);
  const { friction, restitution, mass, density, collisionGroups } = options;
  if (friction !== undefined) desc.setFriction(friction);
  if (restitution !== undefined) desc.setRestitution(restitution);
  if (mass !== undefined) desc.setMass(mass);
  else if (density !== undefined) desc.setDensity(density);
  if (collisionGroups !== undefined) desc.setCollisionGroups(collisionGroups);
  if (options.sensor) {
    // A sensor also senses fixed and kinematic bodies, so a walking character can enter a trigger.
    desc.setSensor(true).setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
  }
  if (options.events !== false) desc.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
  return desc;
}
