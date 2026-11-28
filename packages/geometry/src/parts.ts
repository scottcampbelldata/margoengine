// Shared shapes for props, instruments and machines: turned (lathe) parts, pipes, coils, ribbons, bevelled prisms,
// chamfered boxes, ring sectors, scale marks, arrows and parametric sheets. Every part is built by GeometryBuilder, so
// normals follow the faces with a crease angle (Thurmer, Wuthrich 1998; Max 1999).
//
// Sources:
// - Wang, Juttler, Zheng, Liu 2008, "Computation of rotation minimizing frames", ACM TOG 27(1):2
//   https://doi.org/10.1145/1330511.1330513 (the double reflection method; the closed-loop twist is spread evenly).
// - Bishop 1975, "There is more than one way to frame a curve", Amer. Math. Monthly 82(3) (why not Frenet frames).
// - Piegl, Tiller 1997, The NURBS Book, 2nd ed., section 7.3 (a corner rounded by a rational quadratic arc, weight
//   cos of half the turn).
// - Lame curves (superellipses), |x|^n + |y|^n = 1, for `ringSectorGeometry`'s `exponent`.
import { GeometryBuilder } from './builder.js';
import type { GeometryData } from './data.js';
import type { MutableVec2, MutableVec3 } from './math.js';

type P3 = ArrayLike<number>;
type P2 = ArrayLike<number>;
/** The axis a part is built around or along. */
export type PartAxis = 'x' | 'y' | 'z';

const TAU = Math.PI * 2;
const sub = (a: P3, b: P3): MutableVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: P3, b: P3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): MutableVec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: P3): MutableVec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
const positive = (value: number, label: string) => {
  if (!(value > 0 && value < Infinity)) throw new RangeError(`${label} must be a finite number above 0`);
  return value;
};
const whole = (value: number, min: number, label: string) => {
  if (!Number.isInteger(value) || value < min)
    throw new RangeError(`${label} must be a whole number of at least ${min}`);
  return value;
};

/**
 * Maps a point built around +y (the canonical frame) onto `axis` by a rotation, so windings stay outward: 'y' keeps
 * it, 'z' turns +y onto +z, 'x' turns +y onto +x.
 */
const orient = (axis: PartAxis) => {
  if (axis === 'y') return (p: P3): MutableVec3 => [p[0], p[1], p[2]];
  if (axis === 'z') return (p: P3): MutableVec3 => [p[0], -p[2], p[1]];
  if (axis === 'x') return (p: P3): MutableVec3 => [p[1], -p[0], p[2]];
  throw new RangeError(`Unknown axis "${axis}"; pass 'x', 'y' or 'z'`);
};

const signedArea = (ring: readonly P2[]) => {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i],
      q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
const ring2 = (points: readonly P2[], label: string): MutableVec2[] => {
  if (points.length < 3) throw new RangeError(`${label}: pass at least three [x, y] points`);
  for (const p of points)
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) throw new RangeError(`${label}: pass finite [x, y] points`);
  return points.map((p) => [p[0], p[1]]);
};

/** Options of {@link turnedGeometry}. */
export interface TurnedOptions {
  /** Steps around the axis. Default 48. */
  segments?: number;
  /** Start angle in radians, measured from +x toward -z (around +y). Default 0. */
  start?: number;
  /** Angle swept in radians. Default a full turn. */
  sweep?: number;
  /** Close profile ends that are off the axis with flat discs. Default true. */
  caps?: boolean;
  /** Crease angle in degrees: profile corners sharper than this stay sharp. Default 30. */
  crease?: number;
  /** The axis turned around. Default 'y'. */
  axis?: PartAxis;
}

/**
 * A turned part (a lathe solid): `profile` is [radius, height] pairs swept around the axis. A profile running up at
 * positive radius faces outward; a loop (last point equal to the first) makes a ring. Corners sharper than `crease`
 * stay sharp, so machined steps read crisp while curves stay smooth. UV is (around, along the profile by length).
 *
 * ```js
 * const knob = turnedGeometry([[0, 0], [0.02, 0], [0.024, 0.004], [0.024, 0.012], [0, 0.014]], { segments: 32 });
 * ```
 */
export function turnedGeometry(profile: readonly P2[], options: TurnedOptions = {}): GeometryData {
  const { segments = 48, start = 0, sweep = TAU, caps = true, crease = 30, axis = 'y' } = options;
  whole(segments, 3, 'turnedGeometry segments');
  if (profile.length < 2) throw new RangeError('turnedGeometry: pass at least two [radius, height] points');
  for (const p of profile)
    if (!(p[0] >= 0) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
      throw new RangeError('turnedGeometry: pass finite [radius, height] points with radius >= 0');
  if (!Number.isFinite(start) || !(Math.abs(sweep) > 0 && Math.abs(sweep) <= TAU))
    throw new RangeError('turnedGeometry: start must be finite and sweep a non-zero angle up to a full turn');
  const map = orient(axis),
    builder = new GeometryBuilder({ smooth: crease });
  const at = (r: number, h: number, k: number): MutableVec3 => {
    const a = start + (sweep * k) / segments;
    return map([r * Math.cos(a), h, -r * Math.sin(a)]);
  };
  const lengths = [0];
  for (let j = 1; j < profile.length; j++)
    lengths.push(lengths[j - 1] + Math.hypot(profile[j][0] - profile[j - 1][0], profile[j][1] - profile[j - 1][1]));
  const total = lengths.at(-1) || 1;
  for (let j = 1; j < profile.length; j++) {
    const r0 = profile[j - 1][0],
      h0 = profile[j - 1][1],
      r1 = profile[j][0],
      h1 = profile[j][1];
    if (r0 === r1 && h0 === h1) continue;
    const v0 = lengths[j - 1] / total,
      v1 = lengths[j] / total;
    for (let k = 0; k < segments; k++) {
      const u0 = k / segments,
        u1 = (k + 1) / segments;
      const a = at(r0, h0, k),
        b = at(r0, h0, k + 1),
        c = at(r1, h1, k + 1),
        d = at(r1, h1, k);
      const uvs = [
        [u0, v0],
        [u1, v0],
        [u1, v1],
        [u0, v1],
      ];
      // Points on the axis collapse a quad to a triangle.
      if (r0 === 0) builder.triangle(a, c, d, { uvs: [uvs[0], uvs[2], uvs[3]] });
      else if (r1 === 0) builder.triangle(a, b, c, { uvs: uvs.slice(0, 3) });
      else builder.quad(a, b, c, d, { uvs });
    }
  }
  const first = profile[0],
    last = profile[profile.length - 1];
  const loop = first[0] === last[0] && first[1] === last[1];
  if (caps && !loop) {
    const cap = (r: number, h: number, down: boolean) => {
      if (r === 0) return;
      const ring = Array.from({ length: segments + 1 }, (_, k) => at(r, h, k));
      if (Math.abs(sweep) < TAU) ring.push(at(0, h, 0));
      else ring.pop();
      builder.polygon(down ? ring.reverse() : ring);
    };
    // A profile that starts going up is open at the bottom, so its first cap faces down (and the last one up).
    const rising = last[1] >= first[1];
    cap(first[0], first[1], rising);
    cap(last[0], last[1], !rising);
  }
  return builder.data();
}

/** Rotation-minimizing frames along a polyline (double reflection); `closed` spreads the loop's twist evenly. */
export function rotationMinimizingFrames(
  points: readonly P3[],
  options: { closed?: boolean; up?: P3 } = {},
): { tangents: MutableVec3[]; normals: MutableVec3[]; binormals: MutableVec3[] } {
  const n = points.length,
    closed = options.closed ?? false;
  if (n < 2) throw new RangeError('rotationMinimizingFrames: pass at least two points');
  const tangents = points.map((_, i) => {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)],
      next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    return unit(sub(next, prev));
  });
  const t0 = tangents[0];
  let up = options.up ? unit(options.up) : [0, 1, 0];
  if (Math.abs(dot(up, t0)) > 0.999) up = Math.abs(t0[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const normals: MutableVec3[] = [unit(sub(up, scaleBy(t0, dot(up, t0))))];
  const steps = closed ? n : n - 1;
  for (let i = 0; i < steps; i++) {
    const x0 = points[i],
      x1 = points[(i + 1) % n],
      r = normals[i],
      t = tangents[i],
      t1 = tangents[(i + 1) % n];
    const v1 = sub(x1, x0),
      c1 = dot(v1, v1);
    if (c1 < 1e-20) {
      normals.push(r);
      continue;
    }
    const rL = sub(r, scaleBy(v1, (2 / c1) * dot(v1, r))),
      tL = sub(t, scaleBy(v1, (2 / c1) * dot(v1, t))),
      v2 = sub(t1, tL),
      c2 = dot(v2, v2);
    normals.push(unit(c2 < 1e-20 ? rL : sub(rL, scaleBy(v2, (2 / c2) * dot(v2, rL)))));
  }
  if (closed) {
    // normals[n] is the frame carried once round; turn the rest so it meets normals[0] again.
    const end = normals.pop()!,
      angle = Math.atan2(dot(cross(end, normals[0]), t0), dot(end, normals[0]));
    for (let i = 1; i < n; i++) normals[i] = turn(normals[i], tangents[i], (angle * i) / n);
  }
  const binormals = normals.map((r, i) => cross(tangents[i], r));
  return { tangents, normals, binormals };
}
function scaleBy(a: P3, s: number): MutableVec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}
function turn(v: MutableVec3, axis: MutableVec3, angle: number): MutableVec3 {
  const c = Math.cos(angle),
    s = Math.sin(angle),
    k = cross(axis, v),
    d = dot(axis, v) * (1 - c);
  return unit([
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ]);
}

/** Corners of a polyline rounded with circular arcs of `radius` (rational quadratic, Piegl and Tiller 7.3). */
function roundCorners(points: readonly P3[], radius: number, steps: number, closed: boolean): MutableVec3[] {
  const n = points.length,
    out: MutableVec3[] = [];
  for (let i = 0; i < n; i++) {
    const p: MutableVec3 = [points[i][0], points[i][1], points[i][2]];
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(p);
      continue;
    }
    const prev = points[(i - 1 + n) % n],
      next = points[(i + 1) % n];
    const a = sub(p, prev),
      b = sub(next, p),
      la = Math.hypot(...a),
      lb = Math.hypot(...b);
    const d1 = scaleBy(a, 1 / la),
      d2 = scaleBy(b, 1 / lb),
      angle = Math.acos(Math.max(-1, Math.min(1, dot(d1, d2))));
    if (!(angle > 1e-4) || !la || !lb) {
      out.push(p);
      continue;
    }
    // Each arc may use up to half of each neighbouring span.
    const reach = Math.min(radius * Math.tan(angle / 2), la / 2, lb / 2),
      s = sub(p, scaleBy(d1, reach)),
      e = [p[0] + d2[0] * reach, p[1] + d2[1] * reach, p[2] + d2[2] * reach],
      w = Math.cos(angle / 2);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps,
        b0 = (1 - t) ** 2,
        b1 = 2 * t * (1 - t) * w,
        b2 = t * t,
        q = b0 + b1 + b2;
      out.push([
        (b0 * s[0] + b1 * p[0] + b2 * e[0]) / q,
        (b0 * s[1] + b1 * p[1] + b2 * e[1]) / q,
        (b0 * s[2] + b1 * p[2] + b2 * e[2]) / q,
      ]);
    }
  }
  return out;
}

/** Options shared by the swept parts. */
interface SweepOptions {
  closed?: boolean;
  caps?: boolean;
  crease?: number;
  up?: P3;
  /** Section scale at each path fraction (0 to 1 by length). */
  scale?: (t: number) => number;
}

/** Sweeps a 2D section (x along the frame normal, y along the binormal) along a polyline. */
function sweep(
  path: readonly P3[],
  section: readonly P2[],
  closedSection: boolean,
  options: SweepOptions,
): GeometryData {
  const closed = options.closed ?? false;
  const frames = rotationMinimizingFrames(path, { closed, up: options.up });
  let shape = section.map((p) => [p[0], p[1]] as MutableVec2);
  if (closedSection && signedArea(shape) < 0) shape = shape.reverse();
  const along = [0];
  for (let i = 1; i < path.length; i++) along.push(along[i - 1] + Math.hypot(...sub(path[i], path[i - 1])));
  const total = along.at(-1) || 1;
  const rings = path.map((x, i) => {
    const s = options.scale ? options.scale(along[i] / total) : 1,
      r = frames.normals[i],
      b = frames.binormals[i];
    return shape.map(
      ([u, v]) =>
        [
          x[0] + (r[0] * u + b[0] * v) * s,
          x[1] + (r[1] * u + b[1] * v) * s,
          x[2] + (r[2] * u + b[2] * v) * s,
        ] as MutableVec3,
    );
  });
  const builder = new GeometryBuilder({ smooth: options.crease ?? 180 });
  const steps = closed ? path.length : path.length - 1,
    sides = closedSection ? shape.length : shape.length - 1;
  const around = [0];
  for (let j = 1; j <= sides; j++) {
    const p = shape[j % shape.length],
      q = shape[j - 1];
    around.push(around[j - 1] + Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  const perimeter = around[sides] || 1;
  for (let i = 0; i < steps; i++) {
    const a = rings[i],
      c = rings[(i + 1) % rings.length],
      v0 = along[i] / total,
      v1 = i + 1 < along.length ? along[i + 1] / total : 1;
    for (let j = 0; j < sides; j++) {
      const k = (j + 1) % shape.length,
        u0 = around[j] / perimeter,
        u1 = around[j + 1] / perimeter;
      builder.quad(a[j], a[k], c[k], c[j], {
        uvs: [
          [u0, v0],
          [u1, v0],
          [u1, v1],
          [u0, v1],
        ],
      });
    }
  }
  if (closedSection && !closed && (options.caps ?? true)) {
    builder.polygon([...rings[0]].reverse());
    builder.polygon(rings[rings.length - 1]);
  }
  return builder.data();
}

const pathPoints = (points: readonly P3[], label: string): MutableVec3[] => {
  if (points.length < 2) throw new RangeError(`${label}: pass at least two [x, y, z] points`);
  for (const p of points)
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2]))
      throw new RangeError(`${label}: pass finite [x, y, z] points`);
  return points.map((p) => [p[0], p[1], p[2]]);
};

/** Options of {@link pipeGeometry}. */
export interface PipeOptions {
  /** Sides around the pipe. Default 16. */
  sides?: number;
  /** Round each corner of the path with an arc of this radius (a bent pipe). Default 0: corners as given. */
  bend?: number;
  /** Arc steps per rounded corner. Default 8. */
  bendSegments?: number;
  /** Close the ends with flat discs. Default true (ignored when `closed`). */
  caps?: boolean;
  /** Join the end back to the start (a loop). Default false. */
  closed?: boolean;
  /** Up direction of the first frame (the section's x axis leans toward it). Default +y. */
  up?: P3;
  /** A cross-section [x, y] loop to sweep in place of the circle, in pipe-radius units. Default none. */
  section?: readonly P2[];
  /** Crease angle in degrees. Default 180 for the circle (smooth), 30 for a `section`. */
  crease?: number;
  /** Radius multiplier along the pipe, a function of the length fraction 0 to 1. Default constant 1. */
  taper?: (t: number) => number;
}

/**
 * A pipe (tube) of `radius` along a polyline, framed by rotation-minimizing frames so it never twists or flips at
 * straight runs or inflections (Wang et al. 2008). `bend` rounds the corners like bent tubing.
 *
 * ```js
 * const handrail = pipeGeometry([[0, 0, 0], [0, 1, 0], [1, 1, 0]], 0.02, { bend: 0.15 });
 * ```
 */
export function pipeGeometry(points: readonly P3[], radius: number, options: PipeOptions = {}): GeometryData {
  positive(radius, 'pipeGeometry radius');
  const { sides = 16, bend = 0, bendSegments = 8, closed = false } = options;
  whole(sides, 3, 'pipeGeometry sides');
  whole(bendSegments, 1, 'pipeGeometry bendSegments');
  if (!(bend >= 0)) throw new RangeError('pipeGeometry bend must be 0 or more');
  let path = pathPoints(points, 'pipeGeometry');
  if (bend > 0) path = roundCorners(path, bend, bendSegments, closed);
  const section =
    options.section ??
    Array.from({ length: sides }, (_, k) => [Math.cos((TAU * k) / sides), Math.sin((TAU * k) / sides)]);
  const shape = ring2(section, 'pipeGeometry section').map(([x, y]) => [x * radius, y * radius]);
  return sweep(path, shape, true, {
    closed,
    caps: options.caps,
    up: options.up,
    crease: options.crease ?? (options.section ? 30 : 180),
    scale: options.taper,
  });
}

/** Options of {@link helixGeometry}. */
export interface HelixOptions {
  /** Radius of the coil, axis to wire centre. Default 0.5. */
  radius?: number;
  /** Rise per turn. Default 0.2. */
  pitch?: number;
  /** Turns. Default 5. */
  turns?: number;
  /** Wire radius. Default 0.04. */
  wire?: number;
  /** Sides around the wire. Default 12. */
  sides?: number;
  /** Path steps per turn. Default 48. */
  segmentsPerTurn?: number;
  /** A thread cross-section [x, y] loop, in wire-radius units with x pointing away from the axis, in place of the round wire. */
  section?: readonly P2[];
  /** Turn left-handed. Default false (right-handed). */
  leftHanded?: boolean;
  /** Close the wire ends. Default true. */
  caps?: boolean;
  /** The coil's axis. Default 'y'; the coil starts at height 0 and rises along it. */
  axis?: PartAxis;
}

/**
 * A coil spring or screw thread: a wire swept along a helix about the axis. The wire's frame starts pointing away
 * from the axis, so a `section` (a thread profile) keeps its outward side out on every turn.
 *
 * ```js
 * const spring = helixGeometry({ radius: 0.05, pitch: 0.02, turns: 8, wire: 0.004 });
 * ```
 */
export function helixGeometry(options: HelixOptions = {}): GeometryData {
  const { radius = 0.5, pitch = 0.2, turns = 5, wire = 0.04, sides = 12, segmentsPerTurn = 48 } = options;
  positive(radius, 'helixGeometry radius');
  positive(turns, 'helixGeometry turns');
  positive(wire, 'helixGeometry wire');
  if (!Number.isFinite(pitch)) throw new RangeError('helixGeometry pitch must be finite');
  whole(segmentsPerTurn, 3, 'helixGeometry segmentsPerTurn');
  const map = orient(options.axis ?? 'y'),
    hand = options.leftHanded ? -1 : 1,
    steps = Math.max(2, Math.ceil(turns * segmentsPerTurn));
  const path = Array.from({ length: steps + 1 }, (_, i) => {
    const t = (i / steps) * turns,
      a = TAU * t * hand;
    return map([radius * Math.cos(a), pitch * t, -radius * Math.sin(a)]);
  });
  const up = map([1, 0, 0]);
  return pipeGeometry(path, wire, { sides, section: options.section, caps: options.caps, up });
}

/** Options of {@link ribbonGeometry}. */
export interface RibbonOptions {
  /** Thickness; 0 makes a single sheet facing the frame's up side. Default 0. */
  thickness?: number;
  /** The direction the ribbon's face looks at the start. Default +y. */
  up?: P3;
  /** Join the end back to the start. Default false. */
  closed?: boolean;
}

/**
 * A ribbon or band of `width` along a polyline, kept flat to its rotation-minimizing frame. With `thickness` it is a
 * solid band with square edges.
 *
 * ```js
 * const tape = ribbonGeometry([[0, 0, 0], [1, 0, 0.3], [2, 0, 0]], 0.1, { thickness: 0.004 });
 * ```
 */
export function ribbonGeometry(points: readonly P3[], width: number, options: RibbonOptions = {}): GeometryData {
  positive(width, 'ribbonGeometry width');
  const thickness = options.thickness ?? 0;
  if (!(thickness >= 0 && thickness < Infinity)) throw new RangeError('ribbonGeometry thickness must be 0 or more');
  const path = pathPoints(points, 'ribbonGeometry'),
    w = width / 2,
    t = thickness / 2;
  const common = { closed: options.closed, up: options.up, crease: 30 };
  if (!thickness)
    return sweep(
      path,
      [
        [0, -w],
        [0, w],
      ],
      false,
      common,
    );
  return sweep(
    path,
    [
      [-t, -w],
      [t, -w],
      [t, w],
      [-t, w],
    ],
    true,
    common,
  );
}

/** Options of {@link prismGeometry}. */
export interface PrismOptions {
  /** Inset of the chamfer on the top and bottom edges, across the outline. Default 0. */
  bevel?: number;
  /** Height of the chamfer along the axis. Default `bevel` (a 45 degree chamfer). */
  bevelHeight?: number;
  /** Holes: [a, b] loops inside the outline. */
  holes?: readonly (readonly P2[])[];
  /** Extrusion axis. Outline points are [x, z] for 'y', [x, y] for 'z' and [y, z] for 'x'. Default 'y'. */
  axis?: PartAxis;
  /** Crease angle in degrees: outline corners sharper than this stay sharp. Default 30. */
  crease?: number;
}

/** Miter offset of a ring by `d` toward its left side (into a counter-clockwise outline's inside). */
function inset(ring: readonly MutableVec2[], d: number): MutableVec2[] {
  const n = ring.length;
  return ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n],
      b = ring[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]],
      e2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(e1[0], e1[1]) || 1,
      l2 = Math.hypot(e2[0], e2[1]) || 1;
    const n1 = [-e1[1] / l1, e1[0] / l1],
      n2 = [-e2[1] / l2, e2[0] / l2];
    const k = Math.max(0.25, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
    return [p[0] + (d * (n1[0] + n2[0])) / k, p[1] + (d * (n1[1] + n2[1])) / k];
  });
}

/**
 * A prism: `outline` (any simple polygon, either winding) extruded `height` along the axis, centred on the origin, with
 * holes and an optional chamfer on both caps' edges (45 degrees unless `bevelHeight` differs from `bevel`).
 *
 * ```js
 * const plate = prismGeometry([[-1, -0.5], [1, -0.5], [1, 0.5], [-1, 0.5]], 0.1, { bevel: 0.01 });
 * ```
 */
export function prismGeometry(outline: readonly P2[], height: number, options: PrismOptions = {}): GeometryData {
  positive(height, 'prismGeometry height');
  const bevel = options.bevel ?? 0,
    rise = options.bevelHeight ?? bevel;
  if (!(bevel >= 0 && bevel < Infinity) || !(rise >= 0 && rise < height / 2) || !bevel !== !rise)
    throw new RangeError('prismGeometry bevel must be 0 or more, with a bevelHeight under half the height');
  const axis = options.axis ?? 'y';
  // Canonical frame: outline (a, b) in the XY plane, extruded along +z; then rotated onto the axis (proper rotations).
  const map =
    axis === 'z'
      ? (p: P3): MutableVec3 => [p[0], p[1], p[2]]
      : axis === 'y'
        ? (p: P3): MutableVec3 => [p[0], -p[2], p[1]]
        : axis === 'x'
          ? (p: P3): MutableVec3 => [p[2], p[0], p[1]]
          : orient(axis);
  let outer = ring2(outline, 'prismGeometry outline');
  if (signedArea(outer) < 0) outer = outer.reverse();
  const holes = (options.holes ?? []).map((h) => {
    const ring = ring2(h, 'prismGeometry hole');
    return signedArea(ring) > 0 ? ring.reverse() : ring;
  });
  const builder = new GeometryBuilder({ smooth: options.crease ?? 30 });
  const h = height / 2;
  const at = (ring: readonly MutableVec2[], z: number) => ring.map(([x, y]) => map([x, y, z]));
  const levels = (ring: MutableVec2[]) => {
    if (!bevel) return [at(ring, -h), at(ring, h)];
    const small = inset(ring, bevel);
    return [at(small, -h), at(ring, -h + rise), at(ring, h - rise), at(small, h)];
  };
  const capRing = (ring: MutableVec2[]) => (bevel ? inset(ring, bevel) : ring);
  for (const ring of [outer, ...holes]) {
    const rows = levels(ring);
    for (let r = 0; r < rows.length - 1; r++) builder.strip(rows[r], rows[r + 1], { closed: true });
  }
  const top = at(capRing(outer), h),
    bottom = at(capRing(outer), -h);
  builder.polygon(top, { holes: holes.map((hole) => at(capRing(hole), h)) });
  builder.polygon([...bottom].reverse(), { holes: holes.map((hole) => at(capRing(hole), -h)) });
  return builder.data();
}

/** Options of {@link chamferBoxGeometry}. */
export interface ChamferBoxOptions {
  /** Width of the 45 degree chamfer on the top and bottom edges. Default 4% of the smallest side. */
  chamfer?: number;
  /** Radius of the four upright corners. Default: the chamfer, cut flat (one segment). */
  radius?: number;
  /** Steps per rounded upright corner. Default 1 when `radius` is not given, 6 when it is. */
  segments?: number;
}

/**
 * A box (width along x, height along y, depth along z, centred) with chamfered top and bottom edges and chamfered or
 * rounded upright corners: trays, plinths, panels and keycaps.
 *
 * ```js
 * const tray = chamferBoxGeometry(1.2, 0.08, 0.6, { chamfer: 0.012, radius: 0.06 });
 * ```
 */
export function chamferBoxGeometry(
  width: number,
  height: number,
  depth: number,
  options: ChamferBoxOptions = {},
): GeometryData {
  positive(width, 'chamferBoxGeometry width');
  positive(height, 'chamferBoxGeometry height');
  positive(depth, 'chamferBoxGeometry depth');
  const chamfer = options.chamfer ?? 0.04 * Math.min(width, height, depth);
  const radius = Math.min(options.radius ?? chamfer, width / 2, depth / 2);
  const segments = whole(options.segments ?? (options.radius === undefined ? 1 : 6), 1, 'chamferBoxGeometry segments');
  const x = width / 2 - radius,
    z = depth / 2 - radius,
    outline: MutableVec2[] = [];
  for (const [phase, sx, sz] of [
    [0, 1, 1],
    [1, -1, 1],
    [2, -1, -1],
    [3, 1, -1],
  ])
    for (let i = 0; i <= segments; i++) {
      if (!radius && i) break;
      const a = ((phase + i / segments) * Math.PI) / 2;
      outline.push([sx * x + radius * Math.cos(a), sz * z + radius * Math.sin(a)]);
    }
  return prismGeometry(outline, height, { bevel: chamfer, axis: 'y' });
}

/** Options of {@link ringSectorGeometry}. */
export interface RingSectorOptions {
  /** Start angle in radians, from +x toward -z (around +y). Default 0. */
  start?: number;
  /** Angle swept in radians. Default a full turn. */
  sweep?: number;
  /** Steps along the arc. Default 64. */
  segments?: number;
  /** Superellipse exponent of the rings: 2 is a circle, higher is squarer, between 1 and 2 a rounded diamond. Default 2. */
  exponent?: number;
  /** Thickness along +y; 0 makes a flat sheet facing +y at height 0. Default 0. */
  depth?: number;
  /** Chamfer of a solid sector's edges. Default 0. */
  bevel?: number;
}

/**
 * An annulus sector in the XZ plane: dial bands, gauge arcs, washers, rings and (with inner 0) discs and pie slices.
 * `exponent` turns the rings into superellipses (Lame curves) for squarish bezels and soft footprints.
 *
 * ```js
 * const band = ringSectorGeometry(0.8, 0.9, { start: -Math.PI / 4, sweep: (3 * Math.PI) / 2 });
 * ```
 */
export function ringSectorGeometry(inner: number, outer: number, options: RingSectorOptions = {}): GeometryData {
  const { start = 0, sweep: arc = TAU, segments = 64, exponent = 2, depth = 0, bevel = 0 } = options;
  if (!(inner >= 0) || !(outer > inner) || !Number.isFinite(outer))
    throw new RangeError('ringSectorGeometry: pass 0 <= inner < outer, finite');
  whole(segments, 3, 'ringSectorGeometry segments');
  positive(exponent, 'ringSectorGeometry exponent');
  if (!(Math.abs(arc) > 0 && Math.abs(arc) <= TAU) || !Number.isFinite(start))
    throw new RangeError('ringSectorGeometry: start must be finite and sweep a non-zero angle up to a full turn');
  const full = Math.abs(arc) >= TAU - 1e-9,
    count = full ? segments : segments + 1;
  // A Lame curve point at angle a: sign(cos) |cos|^(2/n), sign(sin) |sin|^(2/n).
  const lame = (a: number, r: number): MutableVec2 => {
    const c = Math.cos(a),
      s = Math.sin(a),
      e = 2 / exponent;
    return [r * Math.sign(c) * Math.abs(c) ** e, -r * Math.sign(s) * Math.abs(s) ** e];
  };
  const ring = (r: number) => Array.from({ length: count }, (_, k) => lame(start + (arc * k) / segments, r));
  const outerRing = ring(outer);
  if (depth > 0) {
    // Solid: a prism of the sector outline (a full ring is an outline with a hole).
    if (full) {
      const holes = inner > 0 ? [ring(inner)] : [];
      return placeY(
        prismGeometry(
          outerRing.map(([x, z]) => [x, z]),
          depth,
          { bevel, holes, axis: 'y' },
        ),
        depth / 2,
      );
    }
    const innerRing = inner > 0 ? ring(inner).reverse() : [[0, 0] as MutableVec2];
    return placeY(prismGeometry([...outerRing, ...innerRing], depth, { bevel, axis: 'y' }), depth / 2);
  }
  const builder = new GeometryBuilder();
  const up = (p: MutableVec2): MutableVec3 => [p[0], 0, p[1]];
  if (inner === 0) {
    // A disc or a pie slice: one polygon, counter-clockwise seen from +y.
    const fan = outerRing.map(up);
    if (!full) fan.push([0, 0, 0]);
    return builder.polygon(arc > 0 ? fan : fan.reverse()).data();
  }
  const a = outerRing.map(up),
    b = ring(inner).map(up);
  // a runs from +x toward -z, counter-clockwise seen from +y, so the strip from the outer row to the inner one faces +y.
  const v: [number, number] = [1, inner / outer];
  builder.strip(arc > 0 ? a : b, arc > 0 ? b : a, { closed: full, v: arc > 0 ? v : [v[1], v[0]] });
  return builder.data();
}
function placeY(data: GeometryData, dy: number): GeometryData {
  const positions = Float32Array.from(data.positions);
  for (let i = 1; i < positions.length; i += 3) positions[i] += dy;
  return { ...data, positions };
}

/** Options of {@link scaleMarksGeometry}. */
export interface ScaleMarksOptions {
  /** 'linear': marks step along +x; 'radial': marks step around +y. Default 'linear'. */
  kind?: 'linear' | 'radial';
  /** Number of marks. Default 11. */
  count?: number;
  /** Linear: x of the first mark. Radial: angle of the first mark in radians (from +x toward -z). Default 0. */
  start?: number;
  /** Linear: distance between marks. Default 0.1. */
  spacing?: number;
  /** Radial: angle swept from the first mark to the last, radians. Default a full turn (the last mark is not doubled). */
  sweep?: number;
  /** Radial: radius where the marks start (they run inward). Default 1. */
  radius?: number;
  /** Every `major`-th mark (from the first) is major. Default 5; 0 makes none major. */
  major?: number;
  /** Which marks to make. Default 'all'. */
  marks?: 'all' | 'major' | 'minor';
  /** Minor mark length (linear: along -z from `align`; radial: inward). Default 0.03. */
  length?: number;
  /** Major mark length. Default twice `length`. */
  majorLength?: number;
  /** Minor mark width. Default 0.004. */
  width?: number;
  /** Major mark width. Default 1.6 times `width`. */
  majorWidth?: number;
  /** Linear only: where z = 0 sits on each mark: 'start' (marks run toward -z), 'center' or 'end'. Default 'start'. */
  align?: 'start' | 'center' | 'end';
}

/**
 * Engraved or printed scale marks as flat quads facing +y at height 0: rulers, dials, gauges and grids.
 *
 * ```js
 * const ruler = scaleMarksGeometry({ count: 49, spacing: 0.01, major: 10, length: 0.004 });
 * const dial = scaleMarksGeometry({ kind: 'radial', count: 41, radius: 0.1, sweep: 1.5 * Math.PI, major: 5 });
 * ```
 */
export function scaleMarksGeometry(options: ScaleMarksOptions = {}): GeometryData {
  const { kind = 'linear', count = 11, start = 0, spacing = 0.1, radius = 1, major = 5, marks = 'all' } = options;
  whole(count, 1, 'scaleMarksGeometry count');
  if (!Number.isInteger(major) || major < 0)
    throw new RangeError('scaleMarksGeometry major must be a whole number >= 0');
  const length = positive(options.length ?? 0.03, 'scaleMarksGeometry length'),
    majorLength = positive(options.majorLength ?? length * 2, 'scaleMarksGeometry majorLength'),
    width = positive(options.width ?? 0.004, 'scaleMarksGeometry width'),
    majorWidth = positive(options.majorWidth ?? width * 1.6, 'scaleMarksGeometry majorWidth');
  const sweepAngle = options.sweep ?? TAU,
    full = Math.abs(sweepAngle) >= TAU - 1e-9,
    align = options.align ?? 'start';
  if (!Number.isFinite(start) || !Number.isFinite(spacing) || !Number.isFinite(sweepAngle) || !(radius > 0))
    throw new RangeError('scaleMarksGeometry: pass finite start, spacing and sweep and a positive radius');
  const builder = new GeometryBuilder();
  for (let i = 0; i < count; i++) {
    const isMajor = major > 0 && i % major === 0;
    if ((marks === 'major' && !isMajor) || (marks === 'minor' && isMajor)) continue;
    const l = isMajor ? majorLength : length,
      w = (isMajor ? majorWidth : width) / 2;
    if (kind === 'linear') {
      const x = start + i * spacing,
        z0 = align === 'start' ? 0 : align === 'center' ? l / 2 : l,
        z1 = z0 - l;
      builder.quad([x - w, 0, z0], [x + w, 0, z0], [x + w, 0, z1], [x - w, 0, z1]);
    } else if (kind === 'radial') {
      const a = start + (sweepAngle * i) / (full ? count : Math.max(1, count - 1)),
        c = Math.cos(a),
        s = -Math.sin(a),
        // Along the mark (outward) and across it, in the XZ plane.
        o = [c, s],
        q = [-s, c];
      const p = (r: number, k: number): MutableVec3 => [o[0] * r + q[0] * k, 0, o[1] * r + q[1] * k];
      builder.quad(p(radius, w), p(radius, -w), p(radius - l, -w), p(radius - l, w));
    } else throw new RangeError(`Unknown scale kind "${kind}"; pass 'linear' or 'radial'`);
  }
  return builder.data();
}

/** Options of {@link strokeGeometry}. */
export interface StrokeOptions {
  /** The axis the strokes face. Points are [x, z] for 'y', [x, y] for 'z' and [y, z] for 'x'. Default 'y'. */
  axis?: PartAxis;
}

/**
 * Flat bands of `width` over line segments, one quad per [from, to] pair facing +axis: drafting lines, grids, map
 * strokes and wiring that must be lit like the surface they lie on. Zero-length segments are skipped.
 *
 * ```js
 * const grid = strokeGeometry([[[-1, 0], [1, 0]], [[0, -1], [0, 1]]], 0.004, { axis: 'z' });
 * ```
 */
export function strokeGeometry(
  segments: readonly (readonly [P2, P2])[],
  width: number,
  options: StrokeOptions = {},
): GeometryData {
  positive(width, 'strokeGeometry width');
  const axis = options.axis ?? 'y';
  const at: (a: number, b: number) => MutableVec3 =
    axis === 'y'
      ? (a, b) => [a, 0, b]
      : axis === 'z'
        ? (a, b) => [a, b, 0]
        : axis === 'x'
          ? (a, b) => [0, a, b]
          : (orient(axis), () => [0, 0, 0]);
  // Counter-clockwise in (a, b) faces +z and +x but -y, whose plane is (x, z).
  const flip = axis === 'y';
  const builder = new GeometryBuilder();
  for (const [from, to] of segments) {
    const ax = from[0],
      ay = from[1],
      bx = to[0],
      by = to[1],
      length = Math.hypot(bx - ax, by - ay);
    if (![ax, ay, bx, by].every(Number.isFinite)) throw new RangeError('strokeGeometry: pass finite [a, b] points');
    if (length < 1e-12) continue;
    const dx = ((by - ay) / length) * (width / 2),
      dy = ((ax - bx) / length) * (width / 2);
    // (dx, dy) points right of the segment, so this quad runs counter-clockwise in (a, b).
    builder.quad(at(ax + dx, ay + dy), at(bx + dx, by + dy), at(bx - dx, by - dy), at(ax - dx, ay - dy), { flip });
  }
  return builder.data();
}

/** Options of {@link arrowGeometry}. */
export interface ArrowOptions {
  /** Total length, base to tip, along +y. Default 1. */
  length?: number;
  /** Shaft radius. Default 2% of the length. */
  radius?: number;
  /** Head length. Default 20% of the length. */
  headLength?: number;
  /** Head radius. Default 2.5 times the shaft radius. */
  headRadius?: number;
  /** Sides around. Default 16. */
  sides?: number;
}

/**
 * An arrow from the origin along +y: a round shaft and a cone head. Point it with a mesh rotation, or place copies
 * with `GeometryBuilder.append`.
 *
 * ```js
 * const arrow = arrowGeometry({ length: 0.5 });
 * ```
 */
export function arrowGeometry(options: ArrowOptions = {}): GeometryData {
  const length = positive(options.length ?? 1, 'arrowGeometry length');
  const radius = positive(options.radius ?? length * 0.02, 'arrowGeometry radius');
  const headLength = positive(options.headLength ?? length * 0.2, 'arrowGeometry headLength');
  const headRadius = positive(options.headRadius ?? radius * 2.5, 'arrowGeometry headRadius');
  if (headLength >= length) throw new RangeError('arrowGeometry headLength must be shorter than the length');
  const neck = length - headLength;
  return turnedGeometry(
    [
      [0, 0],
      [radius, 0],
      [radius, neck],
      [headRadius, neck],
      [0, length],
    ],
    { segments: whole(options.sides ?? 16, 3, 'arrowGeometry sides') },
  );
}

/** Options of {@link gridSheetGeometry}. */
export interface GridSheetOptions {
  /** Normal at (u, v). Default: from the surface's derivatives. */
  normal?: (u: number, v: number) => P3;
  /** Reverse the winding and normals. Default false. */
  flip?: boolean;
}

/**
 * A parametric sheet: `fn(u, v)` sampled on an `nu` x `nv` grid of shared vertices (ground, water, cloth, shells and
 * curved panels). The front is where the u derivative crossed with the v derivative points.
 *
 * ```js
 * const dune = gridSheetGeometry(64, 64, (u, v) => [u * 10 - 5, Math.sin(u * 6) * 0.3, v * 10 - 5]);
 * ```
 */
export function gridSheetGeometry(
  nu: number,
  nv: number,
  fn: (u: number, v: number) => P3,
  options: GridSheetOptions = {},
): GeometryData {
  return new GeometryBuilder({ weld: false }).grid(nu, nv, fn, options).data();
}

/** Options of {@link wingGeometry}. */
export interface WingOptions {
  /** Tip to tip span along z, centred on z 0. Default 2. */
  span?: number;
  /** Chord at the centre, along +x from the leading edge at x 0. Default 1. */
  rootChord?: number;
  /** Chord at each tip. Default `rootChord`. */
  tipChord?: number;
  /** NACA four-digit symmetric thickness as a fraction of the chord (0.12 is a NACA 0012), up to 0.4. Default 0.12. */
  thickness?: number;
  /** Leading edge moved aft (+x) at the tips. Default 0. */
  sweep?: number;
  /** Tips raised (+y). Default 0. */
  dihedral?: number;
  /**
   * Exponent of the spanwise curve the chord, sweep and dihedral follow from the centre (0) to a tip (1). Default 1,
   * straight; 2 rounds the planform toward the tips.
   */
  curve?: number;
  /** Points around each section, cosine spaced so the nose stays round. Default 48. */
  sections?: number;
  /** Spanwise intervals. Default 32. */
  stations?: number;
  /** Close the tips with flat caps. Default true. */
  caps?: boolean;
}

/** NACA four-digit half thickness at chord fraction x (0 to 1), with the closed trailing edge coefficient -0.1036. */
export function nacaThickness(x: number, thickness: number): number {
  const s = Math.sqrt(Math.max(0, x));
  return 5 * thickness * (0.2969 * s - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4);
}

/**
 * A straight or tapered wing: NACA four-digit symmetric sections (Abbott, von Doenhoff 1959, "Theory of Wing
 * Sections", section 6.4; Jacobs, Ward, Pinkerton 1933, NACA Report 460) lofted along z, with sweep, dihedral and flat
 * tip caps. Smooth over the skin, sharp at the trailing edge and the tips.
 *
 * ```js
 * const wing = wingGeometry({ span: 3, rootChord: 1.5, tipChord: 1, thickness: 0.13, sweep: 0.4, curve: 2 });
 * ```
 */
export function wingGeometry(options: WingOptions = {}): GeometryData {
  const span = positive(options.span ?? 2, 'wingGeometry span'),
    root = positive(options.rootChord ?? 1, 'wingGeometry rootChord'),
    tip = positive(options.tipChord ?? root, 'wingGeometry tipChord'),
    thickness = positive(options.thickness ?? 0.12, 'wingGeometry thickness'),
    sweep = options.sweep ?? 0,
    dihedral = options.dihedral ?? 0,
    curve = positive(options.curve ?? 1, 'wingGeometry curve'),
    around = whole(options.sections ?? 48, 8, 'wingGeometry sections'),
    stations = whole(options.stations ?? 32, 1, 'wingGeometry stations');
  if (!Number.isFinite(sweep) || !Number.isFinite(dihedral))
    throw new RangeError('wingGeometry sweep and dihedral must be finite numbers');
  if (thickness > 0.4) throw new RangeError('wingGeometry thickness must be at most 0.4 of the chord');
  const half = around / 2;
  const loop = (z: number): MutableVec3[] => {
    const k = (Math.abs(z) / (span / 2)) ** curve,
      chord = root + (tip - root) * k;
    const points: MutableVec3[] = [];
    // From the trailing edge over the upper side to the nose, then back under it: x = (1 + cos t) / 2.
    for (let i = 0; i < around; i++) {
      const x = 0.5 + 0.5 * Math.cos((i / half) * Math.PI),
        y = nacaThickness(x, thickness) * chord * (i < half ? 1 : -1);
      points.push([sweep * k + x * chord, dihedral * k + y, z]);
    }
    return points;
  };
  const builder = new GeometryBuilder({ smooth: 40 });
  const rows = Array.from({ length: stations + 1 }, (_, j) => loop(-span / 2 + (span * j) / stations));
  for (let j = 0; j < stations; j++) builder.strip(rows[j], rows[j + 1], { closed: true });
  if (options.caps ?? true) {
    builder.polygon(rows[0], { flip: true });
    builder.polygon(rows[stations]);
  }
  return builder.data();
}
