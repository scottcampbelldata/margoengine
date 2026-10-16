import { madd, type V3 } from './math.js';
import { cross, dot, normalize, sub } from '@margoengine/math/vec3';
import { intersectPlane, project, ray, type Basis } from './view.js';

export type TransformMode = 'translate' | 'rotate' | 'scale';
export type HandleName = 'X' | 'Y' | 'Z' | 'XY' | 'YZ' | 'XZ' | 'XYZ' | 'E' | 'XYZE';
export type RGBA = readonly [number, number, number, number];

/** A world-space line strip segment list (pairs of points) drawn `width` CSS pixels wide. */
export interface LinePrim {
  kind: 'lines';
  points: V3[];
  width: number;
  colors: RGBA[];
}
/** World-space triangles (three points each). */
export interface TrianglePrim {
  kind: 'triangles';
  points: V3[];
  color: RGBA;
}
export type Prim = LinePrim | TrianglePrim;

type Pick =
  | { type: 'segment'; a: V3; b: V3 }
  | { type: 'ring'; points: V3[]; facing: boolean[] }
  | { type: 'screen-ring'; radius: number }
  | { type: 'quad'; normal: V3; u: V3; v: V3; min: number; max: number; size: number }
  | { type: 'disc'; radius: number; minPx: number; score: number };

export interface Handle {
  name: HandleName;
  prims: Prim[];
  pick: Pick;
}

/** Everything the gizmo layout depends on, in world space. */
export interface GizmoFrame {
  mode: TransformMode;
  origin: V3;
  /** Unit X, Y and Z axes of the gizmo (world axes, or the object's world rotation in local space). */
  axes: [V3, V3, V3];
  /** World units per gizmo unit (constant screen size). */
  size: number;
  /** Unit vector from the origin toward the camera. */
  eye: V3;
  /** Camera up, used to orient screen-facing rings. */
  up: V3;
  show: { X: boolean; Y: boolean; Z: boolean };
  /** Hovered or dragged handle, drawn highlighted. */
  axis: HandleName | null;
  dragging: boolean;
}

const RED: RGBA = [1, 0.25, 0.25, 1],
  GREEN: RGBA = [0.3, 0.9, 0.3, 1],
  BLUE: RGBA = [0.3, 0.5, 1, 1];
const YELLOW: RGBA = [1, 1, 0, 1],
  WHITE: RGBA = [1, 1, 1, 0.55],
  GRAY: RGBA = [0.75, 0.75, 0.75, 0.6],
  VIEW: RGBA = [1, 0.85, 0.45, 0.85];
const COLORS = [RED, GREEN, BLUE];
const PLANES: Array<[HandleName, number, number, number]> = [
  ['XY', 0, 1, 2],
  ['YZ', 1, 2, 0],
  ['XZ', 0, 2, 1],
];
/** three.js hides an axis that points at the camera and a plane seen edge-on. */
export const AXIS_HIDE_THRESHOLD = 0.99,
  PLANE_HIDE_THRESHOLD = 0.2;
/** Gizmo-unit layout. */
export const LAYOUT = {
  arrow: 1,
  tip: 1.15,
  coneRadius: 0.065,
  planeMin: 0.12,
  planeMax: 0.32,
  center: 0.1,
  ring: 1,
  viewRing: 1.25,
  scaleEnd: 0.95,
  cube: 0.06,
  pickStart: 0.2,
};
/** Pick tolerance in CSS pixels. */
export const PICK_RADIUS = 8;

const perpendicular = (a: V3): [V3, V3] => {
  const p = normalize(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
  return [p, cross(a, p)];
};
const tint = (color: RGBA, alpha: number): RGBA => [color[0], color[1], color[2], color[3] * alpha];

function cone(base: V3, tip: V3, radius: number, color: RGBA): TrianglePrim {
  const axis = normalize(sub(tip, base)),
    [p, q] = perpendicular(axis),
    points: V3[] = [],
    n = 12;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2,
      a1 = ((i + 1) / n) * Math.PI * 2;
    const r0 = madd(madd(base, p, Math.cos(a0) * radius), q, Math.sin(a0) * radius),
      r1 = madd(madd(base, p, Math.cos(a1) * radius), q, Math.sin(a1) * radius);
    points.push(r0, r1, tip, r1, r0, base);
  }
  return { kind: 'triangles', points, color };
}
function cube(center: V3, axes: [V3, V3, V3], half: number, color: RGBA): TrianglePrim {
  const corner = (i: number): V3 =>
    madd(
      madd(madd(center, axes[0], i & 1 ? half : -half), axes[1], i & 2 ? half : -half),
      axes[2],
      i & 4 ? half : -half,
    );
  const faces = [
      [0, 1, 3, 2],
      [4, 6, 7, 5],
      [0, 4, 5, 1],
      [2, 3, 7, 6],
      [0, 2, 6, 4],
      [1, 5, 7, 3],
    ],
    points: V3[] = [];
  for (const [a, b, c, d] of faces) points.push(corner(a), corner(b), corner(c), corner(a), corner(c), corner(d));
  return { kind: 'triangles', points, color };
}
function octahedron(center: V3, axes: [V3, V3, V3], radius: number, color: RGBA): TrianglePrim {
  const points: V3[] = [];
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1])
        points.push(
          madd(center, axes[0], sx * radius),
          madd(center, axes[1], sy * radius),
          madd(center, axes[2], sz * radius),
        );
  return { kind: 'triangles', points, color };
}
function circle(center: V3, u: V3, v: V3, radius: number, segments = 64): V3[] {
  const points: V3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(madd(madd(center, u, Math.cos(a) * radius), v, Math.sin(a) * radius));
  }
  return points;
}
const strip = (points: V3[]): V3[] => {
  const out: V3[] = [];
  for (let i = 0; i + 1 < points.length; i++) out.push(points[i], points[i + 1]);
  return out;
};

/** Builds the visible handles for the current frame. */
export function buildGizmo(f: GizmoFrame): Handle[] {
  const { origin: o, axes, size: s, eye } = f,
    handles: Handle[] = [];
  const hidden = (name: string) =>
    (!f.show.X && name.includes('X')) || (!f.show.Y && name.includes('Y')) || (!f.show.Z && name.includes('Z'));
  const lit = (name: HandleName, color: RGBA): RGBA => {
    if (!f.axis) return color;
    if (f.axis === name || (f.axis.length === 2 && name.length === 1 && f.axis.includes(name) && f.mode !== 'rotate'))
      return YELLOW;
    return f.dragging ? tint(color, 0.35) : color;
  };
  const screenU = normalize(cross(f.up, eye)),
    screenV = cross(eye, screenU);
  if (f.mode === 'translate' || f.mode === 'scale') {
    for (let i = 0; i < 3; i++) {
      const name = 'XYZ'[i] as HandleName,
        a = axes[i];
      if (hidden(name) || Math.abs(dot(a, eye)) > AXIS_HIDE_THRESHOLD) continue;
      const color = lit(name, COLORS[i]),
        prims: Prim[] = [];
      if (f.mode === 'translate') {
        prims.push({ kind: 'lines', points: [o, madd(o, a, LAYOUT.arrow * s)], width: 2.5, colors: [color] });
        prims.push(cone(madd(o, a, (LAYOUT.tip - 0.25) * s), madd(o, a, LAYOUT.tip * s), LAYOUT.coneRadius * s, color));
      } else {
        prims.push({ kind: 'lines', points: [o, madd(o, a, LAYOUT.scaleEnd * s)], width: 2.5, colors: [color] });
        prims.push(cube(madd(o, a, LAYOUT.scaleEnd * s), axes, LAYOUT.cube * s, color));
      }
      const end = f.mode === 'translate' ? LAYOUT.tip : LAYOUT.scaleEnd + LAYOUT.cube;
      handles.push({
        name,
        prims,
        pick: { type: 'segment', a: madd(o, a, LAYOUT.pickStart * s), b: madd(o, a, end * s) },
      });
    }
    if (f.mode === 'translate')
      for (const [name, i, j, k] of PLANES) {
        if (hidden(name) || Math.abs(dot(axes[k], eye)) < PLANE_HIDE_THRESHOLD) continue;
        const u = axes[i],
          v = axes[j],
          at = (x: number, y: number) => madd(madd(o, u, x * s), v, y * s),
          lo = LAYOUT.planeMin,
          hi = LAYOUT.planeMax;
        const color = lit(name, tint(COLORS[k], 0.5));
        handles.push({
          name,
          prims: [
            {
              kind: 'triangles',
              points: [at(lo, lo), at(hi, lo), at(hi, hi), at(lo, lo), at(hi, hi), at(lo, hi)],
              color,
            },
          ],
          pick: { type: 'quad', normal: axes[k], u, v, min: lo - 0.02, max: hi + 0.02, size: s },
        });
      }
    if (!hidden('XYZ')) {
      const color = lit('XYZ', WHITE);
      handles.push({
        name: 'XYZ',
        prims: [
          f.mode === 'translate'
            ? octahedron(o, axes, LAYOUT.center * s, color)
            : cube(o, axes, LAYOUT.center * s, color),
        ],
        pick: { type: 'disc', radius: LAYOUT.center * 1.3 * s, minPx: 10, score: 5 },
      });
    }
    return handles;
  }
  // Rotate: axis rings, the view ring and the free trackball disc.
  for (let i = 0; i < 3; i++) {
    const name = 'XYZ'[i] as HandleName;
    if (hidden(name)) continue;
    const [u, v] = [axes[(i + 1) % 3], axes[(i + 2) % 3]],
      ring = circle(o, u, v, LAYOUT.ring * s),
      color = lit(name, COLORS[i]);
    const facing = ring.map((p) => dot(sub(p, o), eye) >= -1e-6 * s),
      colors: RGBA[] = [];
    for (let n = 0; n + 1 < ring.length; n++) colors.push(facing[n] && facing[n + 1] ? color : tint(color, 0.3));
    handles.push({
      name,
      prims: [{ kind: 'lines', points: strip(ring), width: 2.5, colors }],
      pick: { type: 'ring', points: ring, facing },
    });
  }
  if (!hidden('E'))
    handles.push({
      name: 'E',
      prims: [
        {
          kind: 'lines',
          points: strip(circle(o, screenU, screenV, LAYOUT.viewRing * s)),
          width: 2,
          colors: [lit('E', VIEW)],
        },
      ],
      pick: { type: 'screen-ring', radius: LAYOUT.viewRing * s },
    });
  if (!hidden('XYZE')) {
    const outline = circle(o, screenU, screenV, LAYOUT.ring * s),
      prims: Prim[] = [{ kind: 'lines', points: strip(outline), width: 1, colors: [tint(GRAY, 0.6)] }];
    if (f.axis === 'XYZE') {
      const points: V3[] = [];
      for (let n = 0; n + 1 < outline.length; n++) points.push(o, outline[n], outline[n + 1]);
      prims.unshift({ kind: 'triangles', points, color: [0.75, 0.75, 0.75, 0.18] });
    }
    handles.push({
      name: 'XYZE',
      prims,
      pick: { type: 'disc', radius: LAYOUT.ring * s, minPx: 0, score: PICK_RADIUS + 0.5 },
    });
  }
  return handles;
}

const segmentDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number): number => {
  const dx = bx - ax,
    dy = by - ay,
    l = dx * dx + dy * dy,
    t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

/**
 * Screen-space hit test. Lines and rings use the pixel distance to their projection, plane handles use a
 * ray-plane intersection, center handles a projected disc. The lowest score within `PICK_RADIUS` wins.
 */
export function pickHandle(
  handles: Handle[],
  b: Basis,
  origin: V3,
  x: number,
  y: number,
  width: number,
  height: number,
): HandleName | null {
  let best: HandleName | null = null,
    bestScore = Infinity;
  const o = project(b, origin, width, height);
  if (o.depth <= 0) return null;
  const pixelsAt = (radius: number) => {
    const right = project(b, madd(origin, b.right, radius), width, height);
    return Math.hypot(right.x - o.x, right.y - o.y);
  };
  for (const handle of handles) {
    const p = handle.pick;
    let score = Infinity;
    if (p.type === 'segment') {
      const a = project(b, p.a, width, height),
        c = project(b, p.b, width, height);
      if (a.depth > 0 && c.depth > 0) {
        const d = segmentDistance(x, y, a.x, a.y, c.x, c.y);
        if (d <= PICK_RADIUS) score = d;
      }
    } else if (p.type === 'ring') {
      const projected = p.points.map((q) => project(b, q, width, height));
      for (let i = 0; i + 1 < projected.length; i++) {
        const a = projected[i],
          c = projected[i + 1];
        if (a.depth <= 0 || c.depth <= 0) continue;
        const d = segmentDistance(x, y, a.x, a.y, c.x, c.y);
        if (d <= PICK_RADIUS) score = Math.min(score, d + (p.facing[i] && p.facing[i + 1] ? 0 : 3));
      }
    } else if (p.type === 'screen-ring') {
      const d = Math.abs(Math.hypot(x - o.x, y - o.y) - pixelsAt(p.radius));
      if (d <= PICK_RADIUS) score = d;
    } else if (p.type === 'quad') {
      const hit = intersectPlane(ray(b, x, y, width, height), origin, p.normal);
      if (hit) {
        const offset = sub(hit, origin),
          u = dot(offset, p.u) / p.size,
          v = dot(offset, p.v) / p.size;
        if (u >= p.min && u <= p.max && v >= p.min && v <= p.max) score = 4;
      }
    } else {
      const d = Math.hypot(x - o.x, y - o.y);
      if (d <= Math.max(p.minPx, pixelsAt(p.radius))) score = p.score;
    }
    if (score < bestScore) {
      bestScore = score;
      best = handle.name;
    }
  }
  return best;
}
