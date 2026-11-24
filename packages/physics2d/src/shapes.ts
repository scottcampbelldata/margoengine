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
  /**
   * Solver groups, packed as `collisionGroups` is: a pair whose solver groups do not meet still reports contacts but
   * pushes nothing. Default: meets everything.
   */
  solverGroups?: number;
  /**
   * Which pairs of body types this collider meets, as `ActiveCollisionTypes` bits: 1 dynamic-dynamic, 2 dynamic-kinematic,
   * 4 dynamic-fixed, 8 kinematic-kinematic, 16 kinematic-fixed, 32 fixed-fixed. Default 7; sensors default to all (63).
   */
  activeCollisionTypes?: number;
  /** Report `contactforce` events when the contact's total force passes this many newtons. Default: no force events. */
  contactForceThreshold?: number;
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

const KIND = { circle: 0, capsule: 1, segment: 2, rect: 3, polygon: 4, chain: 5, decomposed: 6 } as const;

/** A collider ready for the kernel: its shape kind, the eight settings words and the geometry words, in metres. */
export interface Described {
  kind: number;
  settings: Uint32Array;
  geometry: Uint32Array;
  /** Area in square metres (0 for edges): a collider given a `mass` takes its density from it. */
  area: number;
  /** Whether a query can use it: the kernel's convex shapes only. */
  convex: boolean;
}

/** Words that read as floats and as integers, so a count sits beside the numbers it counts. */
class Buffer32 {
  readonly u: Uint32Array;
  readonly f: Float32Array;
  constructor(words: number) {
    const buffer = new ArrayBuffer(words * 4);
    this.u = new Uint32Array(buffer);
    this.f = new Float32Array(buffer);
  }
}

function polygonArea(points: ArrayLike<number>): number {
  let area = 0;
  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += points[2 * i] * points[2 * j + 1] - points[2 * j] * points[2 * i + 1];
  }
  return Math.abs(area) / 2;
}

/**
 * Describes a collider for the kernel; `scale` is metres per world unit. The collider's own offset and rotation are
 * applied to its points here, so the kernel gets every shape in the body's frame.
 */
export function describeShape(options: ColliderOptions2D, scale: number): Described {
  const [ox, oy] = options.offset ?? [0, 0];
  const turn = options.rotation ?? 0;
  finite(ox, 'collider offset x');
  finite(oy, 'collider offset y');
  finite(turn, 'collider rotation');
  const c = Math.cos(turn),
    s = Math.sin(turn);
  // A point of the collider, turned and moved into the body's frame, in metres.
  const place = (x: number, y: number): [number, number] => [(c * x - s * y + ox) * scale, (s * x + c * y + oy) * scale];
  let kind: number,
    geometry: Buffer32,
    area = 0,
    convex = true;
  switch (options.shape) {
    case 'box': {
      const hx = (finite(options.width, 'box width', true) * scale) / 2,
        hy = (finite(options.height, 'box height', true) * scale) / 2;
      kind = KIND.rect;
      geometry = new Buffer32(7);
      geometry.f.set([hx, hy, ox * scale, oy * scale, c, s, 0]);
      area = 4 * hx * hy;
      break;
    }
    case 'circle': {
      const r = finite(options.radius, 'circle radius', true) * scale;
      kind = KIND.circle;
      geometry = new Buffer32(3);
      geometry.f.set([ox * scale, oy * scale, r]);
      area = Math.PI * r * r;
      break;
    }
    case 'capsule': {
      const r = finite(options.radius, 'capsule radius', true);
      const half = Math.max(0, finite(options.height, 'capsule height', true) / 2 - r);
      const a = place(0, -half),
        b = place(0, half);
      kind = KIND.capsule;
      geometry = new Buffer32(5);
      geometry.f.set([a[0], a[1], b[0], b[1], r * scale]);
      area = Math.PI * r * r * scale * scale + 4 * half * r * scale * scale;
      break;
    }
    case 'segment': {
      const a = place(finite(options.from[0], 'segment from'), finite(options.from[1], 'segment from')),
        b = place(finite(options.to[0], 'segment to'), finite(options.to[1], 'segment to'));
      kind = KIND.segment;
      geometry = new Buffer32(4);
      geometry.f.set([a[0], a[1], b[0], b[1]]);
      break;
    }
    case 'polyline': {
      const flat = flatten(options.points, 1, 2, 'polyline');
      const n = flat.length / 2;
      const closed = n >= 4 && flat[0] === flat[2 * n - 2] && flat[1] === flat[2 * n - 1];
      const used = closed ? n - 1 : n;
      kind = KIND.chain;
      geometry = new Buffer32(2 + 2 * used);
      geometry.u[0] = closed ? 1 : 0;
      geometry.u[1] = used;
      for (let i = 0; i < used; i++) geometry.f.set(place(flat[2 * i], flat[2 * i + 1]), 2 + 2 * i);
      break;
    }
    case 'polygon': {
      const flat = flatten(options.points, 1, 3, 'polygon');
      const n = flat.length / 2;
      const placed = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) placed.set(place(flat[2 * i], flat[2 * i + 1]), 2 * i);
      area = polygonArea(placed);
      if (!(polygonArea(flat) > 1e-9))
        throw new RangeError('polygon points are degenerate (no area); give at least three points not on a line.');
      convex = n <= 8 && isConvex(options.points);
      kind = convex ? KIND.polygon : KIND.decomposed;
      geometry = new Buffer32(2 + 2 * n);
      geometry.f[0] = 0;
      geometry.u[1] = n;
      geometry.f.set(placed, 2);
      break;
    }
    default:
      throw new TypeError(
        `Unknown collider shape "${(options as { shape?: string }).shape}"; use box, circle, capsule, polygon, polyline or segment.`,
      );
  }
  const settings = new Buffer32(8);
  const sensor = options.sensor === true;
  const events = (options.events !== false ? 1 : 0) | (options.contactForceThreshold !== undefined ? 2 : 0);
  let density = options.density ?? 1;
  if (options.mass !== undefined) density = area > 0 ? finite(options.mass, 'collider mass') / area : 0;
  settings.f[0] = finite(density, 'collider density');
  settings.f[1] = finite(options.friction ?? 0.5, 'collider friction');
  settings.f[2] = finite(options.restitution ?? 0, 'collider restitution');
  settings.u[3] = options.collisionGroups ?? 0xffffffff;
  settings.u[4] = options.solverGroups ?? 0xffffffff;
  // A sensor also senses fixed and kinematic bodies, so a walking character can enter a trigger.
  const active = options.activeCollisionTypes ?? (sensor ? 63 : 7);
  settings.u[5] = events | ((active & 0xff) << 8) | (sensor ? 1 << 16 : 0);
  settings.f[6] = options.contactForceThreshold ?? 0;
  return { kind, settings: settings.u, geometry: geometry.u, area, convex };
}

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
