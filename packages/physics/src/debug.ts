// Debug lines of the own solver, Rapier's debug-render pipeline: colliders, joints, contact points and boxes as line
// segments to draw with `@margoengine/lines`. It reads the kernel's columns and is not on the step path, so it may use `Math`.
import type { KernelWorld } from './kernel.js';
import { readGroups } from './groups.js';
import type { InteractionGroups } from './shapes.js';
import type { PhysicsBody } from './body.js';
import type { PhysicsJoint } from './joints.js';
import type { PhysicsCollider } from './collider.js';
import type { QueryFilter } from './physics.js';

/** What {@link Physics.debugRender} draws. */
export interface DebugRenderOptions {
  /** Collider outlines (default true). */
  colliders?: boolean;
  /** A line from each joint's anchor on one body to its anchor on the other, and from each anchor to its body (default true). */
  joints?: boolean;
  /** Each contact point of the last step, with a short line along its normal (default true). */
  contacts?: boolean;
  /** The world-space box around each collider (default false). */
  boxes?: boolean;
  /**
   * Draw only the colliders a query with this filter would see, as Rapier's debug render filters by query flags and a
   * predicate: the kind, sensor and `exclude` options, `groups` (when given, tested both ways) and `predicate`. Joints are
   * drawn when both bodies are shown (a body is shown when one of its colliders is, or it has none), contacts when both
   * colliders are.
   */
  filter?: QueryFilter;
  /**
   * The points the solver pressed this step, one line each from where it put the point on the first body to where it put it on
   * the second (a line of the gap, long for a speculative contact), with a short line along the contact normal (default false;
   * Rapier's `SOLVER_CONTACTS`). Unlike `contacts` it shows what the solver held, after the modifier.
   */
  solverContacts?: boolean;
  /**
   * For each triangle mesh built with `fixInternalEdges`, the normal of each triangle at its middle and, at the middle of each
   * edge a triangle shares with another, the normal the ghost-collision rule clamps to there: the mean of the two faces' normals
   * (default false; Rapier's `PSEUDO_NORMALS`).
   */
  pseudoNormals?: boolean;
  /** The three axes of each body at its origin, red x, green y and blue z, `axisLength` metres long (default false; Rapier's `RIGID_BODY_AXES`). */
  axes?: boolean;
  /** Colours and sizes, each left out one keeping its default (Rapier's `DebugRenderStyle`). */
  style?: DebugStyle;
}

/** A line colour: red, green, blue and alpha, each from 0 to 1. */
export type DebugColor = readonly [number, number, number, number];

/**
 * The colours and sizes of {@link DebugRenderOptions.style}. Defaults: dynamic [0.35, 0.85, 0.45, 1], fixed [0.6, 0.6, 0.65, 1],
 * kinematic [0.35, 0.6, 1, 1], sleeping [0.3, 0.45, 0.35, 1], sensor [1, 0.9, 0.2, 1], joint [1, 0.3, 0.25, 1], brokenJoint
 * [0.5, 0.15, 0.15, 1], contact [1, 0.3, 0.9, 1], solverContact [1, 0.6, 0.1, 1], pseudoNormal [0.6, 1, 0.3, 1], box [0.3, 0.9, 0.95, 0.6]; `normalLength` 0.1 m, `axisLength` 0.5 m.
 */
export interface DebugStyle {
  dynamic?: DebugColor;
  fixed?: DebugColor;
  kinematic?: DebugColor;
  sleeping?: DebugColor;
  sensor?: DebugColor;
  joint?: DebugColor;
  brokenJoint?: DebugColor;
  contact?: DebugColor;
  solverContact?: DebugColor;
  pseudoNormal?: DebugColor;
  box?: DebugColor;
  /** The line along each contact normal, in metres. */
  normalLength?: number;
  /** The length of each body axis, in metres. */
  axisLength?: number;
}

/** Line segments: `vertices` hold x, y, z, two vertices a segment, and `colors` hold r, g, b, a for each vertex. */
export interface DebugLines {
  vertices: Float32Array;
  colors: Float32Array;
}

type V = [number, number, number];
type Q = [number, number, number, number];
type Color = readonly [number, number, number, number];

const DYNAMIC: Color = [0.35, 0.85, 0.45, 1],
  FIXED: Color = [0.6, 0.6, 0.65, 1],
  KINEMATIC: Color = [0.35, 0.6, 1, 1],
  SLEEPING: Color = [0.3, 0.45, 0.35, 1],
  SENSOR: Color = [1, 0.9, 0.2, 1],
  JOINT: Color = [1, 0.3, 0.25, 1],
  BROKEN: Color = [0.5, 0.15, 0.15, 1],
  CONTACT: Color = [1, 0.3, 0.9, 1],
  SOLVER: Color = [1, 0.6, 0.1, 1],
  PSEUDO: Color = [0.6, 1, 0.3, 1],
  BOX: Color = [0.3, 0.9, 0.95, 0.6];
const COS = [
    1, 0.9659258, 0.8660254, 0.7071068, 0.5, 0.258819, 0, -0.258819, -0.5, -0.7071068, -0.8660254, -0.9659258, -1,
    -0.9659258, -0.8660254, -0.7071068, -0.5, -0.258819, 0, 0.258819, 0.5, 0.7071068, 0.8660254, 0.9659258,
  ],
  SIN = [
    0, 0.258819, 0.5, 0.7071068, 0.8660254, 0.9659258, 1, 0.9659258, 0.8660254, 0.7071068, 0.5, 0.258819, 0, -0.258819,
    -0.5, -0.7071068, -0.8660254, -0.9659258, -1, -0.9659258, -0.8660254, -0.7071068, -0.5, -0.258819,
  ],
  NONE = 0xffffffff;

/** Packed groups meet when each one's memberships (high 16 bits) are in the other's filter (low 16). */
function groupsMeet(a: number, b: number): boolean {
  return ((a >>> 16) & b) !== 0 && ((b >>> 16) & a) !== 0;
}

/** Whether a query's groups meet a collider's collision groups, as the kernel tests them (`query_meets`). */
function queryMeets(groups: number | InteractionGroups, world: KernelWorld, row: number): boolean {
  if (typeof groups === 'number') return groupsMeet(groups >>> 0, world.columns.colliderGroups![row]!);
  const own = readGroups(world, row, false),
    one = (groups.memberships & own.filter) !== 0,
    other = (own.memberships & groups.filter) !== 0;
  return groups.testMode === 'or' && own.testMode === 'or' ? one || other : one && other;
}

function rotate(q: Q, v: V): V {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]),
    ty = 2 * (q[2] * v[0] - q[0] * v[2]),
    tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
  ];
}
function multiply(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** @internal Line segment accumulator producing {@link DebugLines}. */
export class DebugLineWriter {
  positions: number[] = [];
  colors: number[] = [];
  segment(a: readonly number[], b: readonly number[], color: Color): void {
    this.positions.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!);
    this.colors.push(color[0], color[1], color[2], color[3], color[0], color[1], color[2], color[3]);
  }
  cross(center: readonly number[], size: number, color: Color): void {
    const [x, y, z] = [center[0]!, center[1]!, center[2]!];
    this.segment([x - size, y, z], [x + size, y, z], color);
    this.segment([x, y - size, z], [x, y + size, z], color);
    this.segment([x, y, z - size], [x, y, z + size], color);
  }
  finish(): DebugLines {
    return { vertices: new Float32Array(this.positions), colors: new Float32Array(this.colors) };
  }
}

/** A collider's local points taken into the world. */
type Place = (p: V) => V;

function ring(
  out: DebugLineWriter,
  place: Place,
  color: Color,
  axis: 0 | 1 | 2,
  radius: number,
  along: number,
  radiusB = radius,
): void {
  for (let i = 0; i < COS.length; i++) {
    const j = (i + 1) % COS.length,
      at = (k: number): V => {
        const a = COS[k]! * radius,
          b = SIN[k]! * radiusB;
        return axis === 0 ? [along, a, b] : axis === 1 ? [a, along, b] : [a, b, along];
      };
    out.segment(place(at(i)), place(at(j)), color);
  }
}

/** @internal Wireframe outline of a sphere, box, capsule, cylinder or cone collider at a world pose (other shapes draw nothing). */
export function drawPrimitiveOutline(
  out: DebugLineWriter,
  collider: PhysicsCollider,
  position: readonly number[],
  rotation: readonly number[],
  color: Color,
): void {
  const kind = collider.shape;
  if (kind !== 'sphere' && kind !== 'box' && kind !== 'capsule' && kind !== 'cylinder' && kind !== 'cone') return;
  const q: Q = [rotation[0]!, rotation[1]!, rotation[2]!, rotation[3]!],
    place: Place = (v) => {
      const r = rotate(q, v);
      return [position[0]! + r[0], position[1]! + r[1], position[2]! + r[2]];
    };
  if (kind === 'sphere') {
    const r = collider.radius();
    ring(out, place, color, 0, r, 0);
    ring(out, place, color, 1, r, 0);
    ring(out, place, color, 2, r, 0);
    return;
  }
  if (kind === 'box') {
    const h = collider.halfExtents()!,
      [a, b, d] = [h.x, h.y, h.z],
      corner = (i: number): V => [i & 1 ? a : -a, i & 2 ? b : -b, i & 4 ? d : -d];
    for (let i = 0; i < 8; i++)
      for (const bit of [1, 2, 4]) if (!(i & bit)) out.segment(place(corner(i)), place(corner(i | bit)), color);
    return;
  }
  const a = collider.radius(),
    b = collider.halfHeight();
  if (kind === 'cone') {
    ring(out, place, color, 1, a, -b);
    for (const [x, z] of [
      [a, 0],
      [-a, 0],
      [0, a],
      [0, -a],
    ] as const)
      out.segment(place([x, -b, z]), place([0, b, 0]), color);
    return;
  }
  ring(out, place, color, 1, a, b);
  ring(out, place, color, 1, a, -b);
  for (const [x, z] of [
    [a, 0],
    [-a, 0],
    [0, a],
    [0, -a],
  ] as const)
    out.segment(place([x, b, z]), place([x, -b, z]), color);
  if (kind === 'capsule')
    for (const s of [1, -1])
      for (const [x, z] of [
        [a, 0],
        [0, a],
        [-a, 0],
        [0, -a],
      ] as const)
        out.segment(place([x, b * s, z]), place([0, (b + a) * s, 0]), color);
}

/**
 * The lines of every collider, joint and contact of a world as Rapier's debug-render pipeline gives them, with its own
 * colours: green awake dynamic bodies, grey fixed, blue kinematic, dim sleeping, yellow sensors, red joints (dark when broken),
 * magenta contacts, and a translucent cyan box.
 */
export function debugLines(
  world: KernelWorld,
  bodies: Iterable<PhysicsBody>,
  joints: Iterable<PhysicsJoint>,
  options: DebugRenderOptions = {},
): DebugLines {
  const {
      colliders = true,
      joints: drawJoints = true,
      contacts = true,
      boxes = false,
      axes = false,
      solverContacts = false,
      pseudoNormals = false,
      filter,
    } = options,
    style = options.style ?? {},
    paint = (name: keyof DebugStyle, fallback: Color): Color => (style[name] as Color | undefined) ?? fallback,
    out = new DebugLineWriter(),
    c = world.columns,
    list = [...bodies],
    seen = new Set<number>(),
    shown = new Set<PhysicsBody>();
  const sees = (body: PhysicsBody, collider: PhysicsCollider): boolean => {
    if (!filter) return true;
    const sensor = collider.isSensor(),
      type = body.type,
      kinematic = type !== 'dynamic' && type !== 'fixed',
      only = filter.onlyDynamic || filter.onlyKinematic || filter.onlyFixed;
    return !(
      (filter.exclude && filter.exclude === body) ||
      (filter.excludeCollider && filter.excludeCollider === collider) ||
      (sensor && filter.excludeSensors) ||
      (!sensor && filter.excludeSolids) ||
      (type === 'fixed' && filter.excludeFixed) ||
      (kinematic && filter.excludeKinematic) ||
      (type === 'dynamic' && filter.excludeDynamic) ||
      (only &&
        !(
          (type === 'dynamic' && filter.onlyDynamic) ||
          (kinematic && filter.onlyKinematic) ||
          (type === 'fixed' && filter.onlyFixed)
        )) ||
      (filter.groups !== undefined && !queryMeets(filter.groups, world, collider.handle)) ||
      (filter.predicate && !filter.predicate(body, collider))
    );
  };
  for (const body of list) {
    let any = body.colliders.length === 0;
    for (const collider of body.colliders)
      if (sees(body, collider)) {
        seen.add(collider.handle);
        any = true;
      }
    if (any) shown.add(body);
  }
  const shape = (row: number, body: V, turn: Q, color: Color, local: boolean): void => {
    const lp: V = [c.colliderX[row]!, c.colliderY[row]!, c.colliderZ[row]!],
      lq: Q = [
        c.colliderRotationX[row]!,
        c.colliderRotationY[row]!,
        c.colliderRotationZ[row]!,
        c.colliderRotationW[row]!,
      ],
      q = multiply(turn, local ? lq : [0, 0, 0, 1]),
      p = local ? rotate(turn, lp) : [0, 0, 0],
      place: Place = (v) => {
        const r = rotate(q, v);
        return [body[0] + p[0]! + r[0], body[1] + p[1]! + r[1], body[2] + p[2]! + r[2]];
      },
      [a, b, d] = [c.colliderA[row]!, c.colliderB[row]!, c.colliderC[row]!];
    switch (c.colliderShape[row]) {
      case 0:
        ring(out, place, color, 0, a, 0);
        ring(out, place, color, 1, a, 0);
        ring(out, place, color, 2, a, 0);
        break;
      case 1: {
        const corner = (i: number): V => [i & 1 ? a : -a, i & 2 ? b : -b, i & 4 ? d : -d];
        for (let i = 0; i < 8; i++)
          for (const bit of [1, 2, 4]) if (!(i & bit)) out.segment(place(corner(i)), place(corner(i | bit)), color);
        break;
      }
      case 2:
        ring(out, place, color, 1, a, b);
        ring(out, place, color, 1, a, -b);
        for (const [x, z] of [
          [a, 0],
          [-a, 0],
          [0, a],
          [0, -a],
        ] as const)
          out.segment(place([x, b, z]), place([x, -b, z]), color);
        for (const s of [1, -1])
          for (const [x, z] of [
            [a, 0],
            [0, a],
            [-a, 0],
            [0, -a],
          ] as const)
            out.segment(place([x, b * s, z]), place([0, (b + a) * s, 0]), color);
        break;
      case 3: {
        const hull = c.colliderHull[row]!,
          [v0, e0, edges] = [c.hullFirstVertex[hull]!, c.hullFirstEdge[hull]!, c.hullEdges[hull]!];
        for (let e = 0; e < edges; e++) {
          const twin = c.edgeTwin[e0 + e]!;
          if (twin === NONE || twin < e) continue;
          const from = c.edgeOrigin[e0 + e]!,
            to = c.edgeOrigin[e0 + c.edgeNext[e0 + e]!]!;
          out.segment(
            place([c.vertexX[v0 + from]!, c.vertexY[v0 + from]!, c.vertexZ[v0 + from]!]),
            place([c.vertexX[v0 + to]!, c.vertexY[v0 + to]!, c.vertexZ[v0 + to]!]),
            color,
          );
        }
        break;
      }
      case 4: {
        const mesh = c.colliderHull[row]!,
          [v0, t0, triangles] = [c.meshFirstVertex[mesh]!, c.meshFirstTriangle[mesh]!, c.meshTriangles[mesh]!],
          at = (i: number): V => [c.meshVertexX[v0 + i]!, c.meshVertexY[v0 + i]!, c.meshVertexZ[v0 + i]!];
        const drawn = new Set<number>(),
          count = c.meshVertices[mesh]!;
        for (let t = 0; t < triangles; t++) {
          const corners = [c.triangleA[t0 + t]!, c.triangleB[t0 + t]!, c.triangleC[t0 + t]!];
          for (let k = 0; k < 3; k++) {
            const [from, to] = [corners[k]!, corners[(k + 1) % 3]!],
              key = from < to ? from * count + to : to * count + from;
            // An edge two triangles share is drawn once.
            if (drawn.has(key)) continue;
            drawn.add(key);
            out.segment(place(at(from)), place(at(to)), color);
          }
        }
        break;
      }
      case 6:
        ring(out, place, color, 1, a, b);
        ring(out, place, color, 1, a, -b);
        for (const [x, z] of [
          [a, 0],
          [-a, 0],
          [0, a],
          [0, -a],
        ] as const)
          out.segment(place([x, b, z]), place([x, -b, z]), color);
        break;
      case 7:
        ring(out, place, color, 1, a, -b);
        for (const [x, z] of [
          [a, 0],
          [-a, 0],
          [0, a],
          [0, -a],
        ] as const)
          out.segment(place([x, -b, z]), place([0, b, 0]), color);
        break;
      case 8:
        // A half space: its plane as a grid of 2 m cells, 10 m each way.
        for (let i = -5; i <= 5; i++) {
          const [nx, ny, nz] = [a, b, d],
            u: V = Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0],
            s: V = [u[1] * nz - u[2] * ny, u[2] * nx - u[0] * nz, u[0] * ny - u[1] * nx],
            sl = Math.hypot(...s),
            t: V = [(ny * s[2] - nz * s[1]) / sl, (nz * s[0] - nx * s[2]) / sl, (nx * s[1] - ny * s[0]) / sl],
            sn: V = [s[0] / sl, s[1] / sl, s[2] / sl],
            at = (x: number, y: number): V => [sn[0] * x + t[0] * y, sn[1] * x + t[1] * y, sn[2] * x + t[2] * y];
          out.segment(place(at(i * 2, -10)), place(at(i * 2, 10)), color);
          out.segment(place(at(-10, i * 2)), place(at(10, i * 2)), color);
        }
        break;
      default: {
        // A voxel grid: the box around it.
        const mesh = c.colliderHull[row]!,
          [hx, hy, hz] = [c.meshHalfX[mesh]!, c.meshHalfY[mesh]!, c.meshHalfZ[mesh]!],
          centre: V = [c.meshBoxX[mesh]!, c.meshBoxY[mesh]!, c.meshBoxZ[mesh]!],
          corner = (i: number): V => [
            centre[0] + (i & 1 ? hx : -hx),
            centre[1] + (i & 2 ? hy : -hy),
            centre[2] + (i & 4 ? hz : -hz),
          ];
        for (let i = 0; i < 8; i++)
          for (const bit of [1, 2, 4]) if (!(i & bit)) out.segment(place(corner(i)), place(corner(i | bit)), color);
      }
    }
  };
  const bodyPose = (body: PhysicsBody): { p: V; q: Q } => ({
    p: [c.positionX[body.row]!, c.positionY[body.row]!, c.positionZ[body.row]!],
    q: [c.rotationX[body.row]!, c.rotationY[body.row]!, c.rotationZ[body.row]!, c.rotationW[body.row]!],
  });
  const worldAnchor = (body: PhysicsBody, local: V): V => {
    const { p, q } = bodyPose(body),
      r = rotate(q, local);
    return [p[0] + r[0], p[1] + r[1], p[2] + r[2]];
  };
  if (colliders || boxes)
    for (const body of list) {
      const { p, q } = bodyPose(body),
        color =
          body.sleeping && body.type === 'dynamic'
            ? paint('sleeping', SLEEPING)
            : body.type === 'dynamic'
              ? paint('dynamic', DYNAMIC)
              : body.type === 'fixed'
                ? paint('fixed', FIXED)
                : paint('kinematic', KINEMATIC);
      for (const collider of body.colliders) {
        const row = collider.handle;
        if (!seen.has(row)) continue;
        if (colliders) {
          const tint = c.colliderFlags[row]! & 1 ? paint('sensor', SENSOR) : color;
          if (c.colliderShape[row] === 5) {
            for (let child = c.colliderHull[row]!; child !== NONE; child = c.colliderNext[child]!)
              shape(child, p, q, tint, true);
          } else shape(row, p, q, tint, true);
        }
        if (boxes) {
          const box = world.colliderAabb(row);
          if (box) {
            const [lo, hi] = box,
              corner = (i: number): V => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
            for (let i = 0; i < 8; i++)
              for (const bit of [1, 2, 4]) if (!(i & bit)) out.segment(corner(i), corner(i | bit), paint('box', BOX));
          }
        }
      }
    }
  if (axes)
    for (const body of list) {
      if (![...body.colliders].some((collider) => seen.has(collider.handle)) && body.colliders.length) continue;
      const { p, q } = bodyPose(body),
        length = style.axisLength ?? 0.5;
      (
        [
          [
            [length, 0, 0],
            [1, 0.2, 0.2, 1],
          ],
          [
            [0, length, 0],
            [0.2, 1, 0.2, 1],
          ],
          [
            [0, 0, length],
            [0.3, 0.4, 1, 1],
          ],
        ] as const
      ).forEach(([end, color]) => {
        const r = rotate(q, [end[0], end[1], end[2]]);
        out.segment(p, [p[0] + r[0], p[1] + r[1], p[2] + r[2]], color);
      });
    }
  if (drawJoints)
    for (const joint of joints) {
      if (!shown.has(joint.bodyA) || !shown.has(joint.bodyB)) continue;
      const a = worldAnchor(joint.bodyA, joint.anchorA),
        b = worldAnchor(joint.bodyB, joint.anchorB),
        color = joint.broken ? paint('brokenJoint', BROKEN) : paint('joint', JOINT);
      out.segment(a, b, color);
      out.segment(a, bodyPose(joint.bodyA).p, color);
      out.segment(b, bodyPose(joint.bodyB).p, color);
    }
  if (contacts)
    for (const manifold of world.contacts()) {
      if (!seen.has(manifold.colliderA) || !seen.has(manifold.colliderB)) continue;
      for (const point of manifold.points) {
        const [x, y, z] = point.position,
          n = manifold.normal,
          length = style.normalLength ?? 0.1;
        out.segment([x, y, z], [x + n[0] * length, y + n[1] * length, z + n[2] * length], paint('contact', CONTACT));
      }
    }
  if (solverContacts) solverLines(world, seen, out, style.normalLength ?? 0.1, paint('solverContact', SOLVER));
  if (pseudoNormals)
    for (const body of list)
      for (const collider of body.colliders) {
        if (!seen.has(collider.handle) || c.colliderShape[collider.handle] !== 4) continue;
        pseudoNormalLines(
          world,
          collider.handle,
          bodyPose(body),
          out,
          style.normalLength ?? 0.1,
          paint('pseudoNormal', PSEUDO),
        );
      }
  return out.finish();
}

/** The solver's contact points of the last step: a line across each gap and a tick along the normal. */
function solverLines(
  world: KernelWorld,
  seen: ReadonlySet<number>,
  out: DebugLineWriter,
  length: number,
  color: Color,
): void {
  const c = world.columns;
  for (let i = 0; i < world.solvingPairs; i++) {
    const row = c.solvePairs[i]!,
      a = c.pairA[row]!,
      b = c.pairB[row]!;
    if (!seen.has(a) || !seen.has(b)) continue;
    const bodyA = c.colliderBody[a]!,
      bodyB = c.colliderBody[b]!,
      qa: Q = [c.rotationX[bodyA]!, c.rotationY[bodyA]!, c.rotationZ[bodyA]!, c.rotationW[bodyA]!],
      qb: Q = [c.rotationX[bodyB]!, c.rotationY[bodyB]!, c.rotationZ[bodyB]!, c.rotationW[bodyB]!],
      n: V = [c.pairNormalX[row]!, c.pairNormalY[row]!, c.pairNormalZ[row]!];
    for (let k = 0; k < c.pairContacts[row]!; k++) {
      const at = row * 4 + k,
        ra = rotate(qa, [c.contactAnchorAX[at]!, c.contactAnchorAY[at]!, c.contactAnchorAZ[at]!]),
        rb = rotate(qb, [c.contactAnchorBX[at]!, c.contactAnchorBY[at]!, c.contactAnchorBZ[at]!]),
        pa: V = [c.centerX[bodyA]! + ra[0], c.centerY[bodyA]! + ra[1], c.centerZ[bodyA]! + ra[2]],
        pb: V = [c.centerX[bodyB]! + rb[0], c.centerY[bodyB]! + rb[1], c.centerZ[bodyB]! + rb[2]];
      out.segment(pa, pb, color);
      out.segment(pb, [pb[0] + n[0] * length, pb[1] + n[1] * length, pb[2] + n[2] * length], color);
    }
  }
}

/**
 * The normals of a `fixInternalEdges` triangle mesh or height field: one at each triangle's middle, one at the middle of each edge
 * two triangles share (the mean of their faces' normals), and one at each vertex (the faces round it, weighted by their angle
 * there, Baerentzen and Aanaes 2005). A removed or split height field cell draws what is left of it.
 */
function pseudoNormalLines(
  world: KernelWorld,
  row: number,
  pose: { p: V; q: Q },
  out: DebugLineWriter,
  length: number,
  color: Color,
): void {
  const c = world.columns,
    mesh = c.colliderHull[row]!;
  if (!(c.meshFlags[mesh]! & 1)) return;
  const v0 = c.meshFirstVertex[mesh]!,
    columns = c.meshColumns[mesh]!,
    local = (i: number): V => [c.meshVertexX[v0 + i]!, c.meshVertexY[v0 + i]!, c.meshVertexZ[v0 + i]!],
    triangles: [number, number, number][] = [];
  if (columns === 0) {
    const t0 = c.meshFirstTriangle[mesh]!;
    for (let t = 0; t < c.meshTriangles[mesh]!; t++)
      triangles.push([c.triangleA[t0 + t]!, c.triangleB[t0 + t]!, c.triangleC[t0 + t]!]);
  } else {
    // A height field: two triangles a cell, split and thinned as the cell's status says (the kernel's own split).
    const rows = c.meshVertices[mesh]! / (columns + 1) - 1,
      at = (r: number, k: number): number => r + (rows + 1) * k,
      first = c.voxelFirst[mesh]!;
    for (let k = 0; k < columns; k++)
      for (let r = 0; r < rows; r++) {
        const cell = r + rows * k,
          status = (c.voxelWord[first + (cell >>> 2)]! >>> (8 * (cell & 3))) & 0xff,
          [a, b, d, e] = [at(r, k), at(r + 1, k), at(r, k + 1), at(r + 1, k + 1)];
        const [left, right]: [number[], number[]] =
          status & 1
            ? [
                [a, b, e],
                [a, e, d],
              ]
            : [
                [a, b, d],
                [b, e, d],
              ];
        if (!(status & 2)) triangles.push(left as [number, number, number]);
        if (!(status & 4)) triangles.push(right as [number, number, number]);
      }
  }
  const place = (v: V): V => {
      const r = rotate(pose.q, v);
      return [pose.p[0] + r[0], pose.p[1] + r[1], pose.p[2] + r[2]];
    },
    tick = (from: V, n: V): void => {
      const start = place(from),
        r = rotate(pose.q, n);
      out.segment(start, [start[0] + r[0] * length, start[1] + r[1] * length, start[2] + r[2] * length], color);
    },
    unit = (x: V): V => {
      const l = Math.hypot(x[0], x[1], x[2]) || 1;
      return [x[0] / l, x[1] / l, x[2] / l];
    },
    normals = triangles.map(([a, b, d]) => {
      const [p, q, r] = [local(a), local(b), local(d)],
        u: V = [q[0] - p[0], q[1] - p[1], q[2] - p[2]],
        w: V = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
      return unit([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
    }),
    vertexSum = new Map<number, V>(),
    edges = new Map<string, number>();
  triangles.forEach((tri, t) => {
    const n = normals[t]!,
      mid: V = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const p = local(tri[k]!),
        previous = local(tri[(k + 2) % 3]!),
        next = local(tri[(k + 1) % 3]!),
        e1 = unit([next[0] - p[0], next[1] - p[1], next[2] - p[2]]),
        e2 = unit([previous[0] - p[0], previous[1] - p[1], previous[2] - p[2]]),
        angle = Math.acos(Math.max(-1, Math.min(1, e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]))),
        sum = vertexSum.get(tri[k]!) ?? [0, 0, 0];
      vertexSum.set(tri[k]!, [sum[0] + n[0] * angle, sum[1] + n[1] * angle, sum[2] + n[2] * angle]);
      mid[0] += p[0] / 3;
      mid[1] += p[1] / 3;
      mid[2] += p[2] / 3;
      const from = tri[k]!,
        to = tri[(k + 1) % 3]!,
        key = from < to ? `${from},${to}` : `${to},${from}`,
        other = edges.get(key);
      if (other === undefined) edges.set(key, t);
      else {
        const m = normals[other]!,
          a = local(from),
          b = local(to);
        tick([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], unit([n[0] + m[0], n[1] + m[1], n[2] + m[2]]));
      }
    }
    tick(mid, n);
  });
  for (const [vertex, sum] of vertexSum) tick(local(vertex), unit(sum));
}
