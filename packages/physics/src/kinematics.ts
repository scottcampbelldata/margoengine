// Joint coordinates, forward kinematics and inverse kinematics of a multibody, read from and written to the kernel's columns.
// It runs between steps, never inside one, so it may use `Math`. Inverse kinematics is the damped least squares of Buss, "Introduction
// to Inverse Kinematics with Jacobian Transpose, Pseudoinverse and Damped Least Squares methods", 2004, section 6, with the step
// bound of Buss and Kim 2005, "Selectively Damped Least Squares for Inverse Kinematics" (section 4: a bound on how far one step
// may turn any joint).
import { MargoError } from '@margoengine/math/errors';
import { JOINT_LIMIT, JOINT_LOCK, type KernelWorld } from './kernel.js';
import type { Quat, Vec3 } from './math.js';
import type { Multibody } from './multibody.js';

/** What `inverseKinematics` is to reach: a position of the chosen point, a rotation of the link, or both. */
export interface IkTarget {
  /** World position the point of the link should reach. */
  position?: Vec3;
  /** World rotation the link should take, a unit quaternion [x, y, z, w]. */
  rotation?: Quat;
}

/** Options of {@link Multibody.inverseKinematics}. */
export interface IkOptions {
  /** The point of the link to bring to the target position, in the link's frame (default its origin). */
  point?: Vec3;
  /** Damping lambda of the least squares in metres or radians (default 0.05); larger is steadier and slower near a singular pose. */
  damping?: number;
  /** Most iterations (default 100). */
  iterations?: number;
  /** Position error in metres under which it stops (default 1e-4). */
  positionTolerance?: number;
  /** Rotation error in radians under which it stops (default 1e-3). */
  rotationTolerance?: number;
  /** The most any joint moves in one iteration, in metres or radians (default 0.3). */
  maxStep?: number;
}

/** Where `inverseKinematics` ended. */
export interface IkResult {
  converged: boolean;
  iterations: number;
  /** Distance of the point from the target position in metres, 0 without one. */
  positionError: number;
  /** Angle of the link's turn from the target rotation in radians, 0 without one. */
  rotationError: number;
}

type V = [number, number, number];
type Q = [number, number, number, number];

const qmul = (a: Q, b: Q): Q => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qconj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
const qnorm = (q: Q): Q => {
  const n = 1 / Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] * n, q[1] * n, q[2] * n, q[3] * n];
};
const qshort = (q: Q): Q => (q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q);
function qrot(q: Q, v: Vec3): V {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]),
    ty = 2 * (q[2] * v[0] - q[0] * v[2]),
    tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
  ];
}
function fromVector(r: Vec3): Q {
  const angle = Math.hypot(r[0], r[1], r[2]);
  if (angle < 1e-12) return qnorm([r[0] / 2, r[1] / 2, r[2] / 2, 1]);
  const s = Math.sin(angle / 2) / angle;
  return [r[0] * s, r[1] * s, r[2] * s, Math.cos(angle / 2)];
}
function toVector(q: Q): V {
  const s = qshort(q),
    sine = Math.hypot(s[0], s[1], s[2]);
  if (sine < 1e-12) return [2 * s[0], 2 * s[1], 2 * s[2]];
  const k = (2 * Math.atan2(sine, s[3])) / sine;
  return [s[0] * k, s[1] * k, s[2] * k];
}
const sub = (a: Vec3, b: Vec3): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cross = (a: Vec3, b: Vec3): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit: readonly Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

/** A joint of the tree as the kernel holds it. */
interface Link {
  index: number;
  parent: number;
  body: number;
  parentBody: number;
  row: number;
  frameA: Q;
  frameB: Q;
  anchorA: V;
  anchorB: V;
  linear: number[];
  angular: number[];
  limits: ([number, number] | null)[];
}

function describe(kernel: KernelWorld, multibody: Multibody): { links: Link[] } {
  const c = kernel.columns,
    rows = [multibody.root.row, ...multibody.links.map((link) => link.body.row)],
    links: Link[] = [];
  multibody.links.forEach((link, i) => {
    const row = link.joint.row,
      flags = c.jointFlags[row]!,
      free = (k: number): boolean => (flags & (JOINT_LOCK << k)) === 0;
    const axes = (offset: number): number[] => [0, 1, 2].filter((k) => free(offset + k));
    links.push({
      index: i + 1,
      parent: rows.indexOf(link.parent.row),
      body: link.body.row,
      parentBody: link.parent.row,
      row,
      frameA: [c.jointFrameAX[row]!, c.jointFrameAY[row]!, c.jointFrameAZ[row]!, c.jointFrameAW[row]!],
      frameB: [c.jointFrameBX[row]!, c.jointFrameBY[row]!, c.jointFrameBZ[row]!, c.jointFrameBW[row]!],
      anchorA: [c.jointAnchorAX[row]!, c.jointAnchorAY[row]!, c.jointAnchorAZ[row]!],
      anchorB: [c.jointAnchorBX[row]!, c.jointAnchorBY[row]!, c.jointAnchorBZ[row]!],
      linear: axes(0),
      angular: axes(3),
      limits: [0, 1, 2, 3, 4, 5].map((k) =>
        flags & (JOINT_LIMIT << k)
          ? ([
              (c as never as Record<string, Float32Array>)[`jointMin${k}`]![row]!,
              (c as never as Record<string, Float32Array>)[`jointMax${k}`]![row]!,
            ] as [number, number])
          : null,
      ),
    });
  });
  return { links };
}

const poseOf = (kernel: KernelWorld, row: number): { p: V; q: Q } => {
  const c = kernel.columns;
  return {
    p: [c.positionX[row]!, c.positionY[row]!, c.positionZ[row]!],
    q: [c.rotationX[row]!, c.rotationY[row]!, c.rotationZ[row]!, c.rotationW[row]!],
  };
};

/** A joint's state: offsets along its free linear axes, and the turn of frame B in frame A. */
interface State {
  offsets: number[];
  rel: Q;
  /** The angle of a joint with one free turning axis, unwrapped. */
  angle: number;
}

function measure(kernel: KernelWorld, link: Link): State {
  const parent = poseOf(kernel, link.parentBody),
    body = poseOf(kernel, link.body),
    frame = qmul(parent.q, link.frameA),
    rel = qshort(qmul(qconj(frame), qmul(body.q, link.frameB))),
    anchorA = add(parent.p, qrot(parent.q, link.anchorA)),
    gap = sub(add(body.p, qrot(body.q, link.anchorB)), anchorA);
  let angle = 0;
  if (link.angular.length === 1) {
    const k = link.angular[0]!,
      raw = 2 * Math.atan2(rel[k]!, rel[3]),
      last = kernel.columns.jointAngle[link.row]!;
    angle = raw + 2 * Math.PI * Math.round((last - raw) / (2 * Math.PI));
  }
  return { offsets: link.linear.map((k) => dot(gap, qrot(frame, unit[k]!))), rel, angle };
}

/** The turn of frame B in frame A that a state means. */
function turnOf(link: Link, state: State): Q {
  if (link.angular.length === 0) return [0, 0, 0, 1];
  if (link.angular.length === 1) {
    const k = link.angular[0]!,
      axis: V = [0, 0, 0];
    axis[k] = Math.sin(state.angle / 2);
    return [axis[0], axis[1], axis[2], Math.cos(state.angle / 2)];
  }
  return state.rel;
}

/** Poses every link from the root and the states: positions and rotations of the bodies, root first. */
function forward(kernel: KernelWorld, links: Link[], states: State[], rootRow: number): { p: V; q: Q }[] {
  const poses: { p: V; q: Q }[] = [poseOf(kernel, rootRow)];
  links.forEach((link, i) => {
    const parent = poses[link.parent]!,
      frame = qmul(parent.q, link.frameA),
      turned = qnorm(qmul(qmul(frame, turnOf(link, states[i]!)), qconj(link.frameB))),
      anchorA = add(parent.p, qrot(parent.q, link.anchorA));
    let target: V = anchorA;
    link.linear.forEach(
      (k, n) => (target = add(target, qrot(frame, unit[k]!).map((x) => x * states[i]!.offsets[n]!) as V)),
    );
    poses.push({ p: sub(target, qrot(turned, link.anchorB)), q: turned });
  });
  return poses;
}

export function coordinates(kernel: KernelWorld, multibody: Multibody): number[] {
  const { links } = describe(kernel, multibody),
    out: number[] = [];
  for (const link of links) {
    const state = measure(kernel, link);
    out.push(...state.offsets);
    if (link.angular.length === 1) out.push(state.angle);
    else if (link.angular.length > 1) {
      const v = toVector(state.rel);
      out.push(...link.angular.map((k) => v[k]!));
    }
  }
  return out;
}

function statesFrom(links: Link[], values: readonly number[], kernel: KernelWorld): State[] {
  let at = 0;
  return links.map((link) => {
    const base = measure(kernel, link),
      offsets = link.linear.map(() => values[at++]!);
    let rel = base.rel,
      angle = base.angle;
    if (link.angular.length === 1) angle = values[at++]!;
    else if (link.angular.length > 1) {
      const v: V = [0, 0, 0];
      for (const k of link.angular) v[k] = values[at++]!;
      rel = fromVector(v);
    }
    return { offsets, rel, angle };
  });
}

function place(kernel: KernelWorld, multibody: Multibody, links: Link[], states: State[]): void {
  const poses = forward(kernel, links, states, multibody.root.row);
  links.forEach((link, i) => {
    const pose = poses[i + 1]!;
    kernel.setPose(link.body, pose.p, pose.q, true);
  });
}

export function setCoordinates(kernel: KernelWorld, multibody: Multibody, values: readonly number[]): void {
  const { links } = describe(kernel, multibody),
    need = links.reduce((n, l) => n + l.linear.length + l.angular.length, 0);
  if (values.length !== need || !values.every(Number.isFinite))
    throw new RangeError(`This multibody has ${need} coordinates, all finite numbers; got ${values.length}.`);
  place(kernel, multibody, links, statesFrom(links, values, kernel));
}

export function jointVelocities(kernel: KernelWorld, multibody: Multibody): number[] {
  const { links } = describe(kernel, multibody),
    c = kernel.columns,
    out: number[] = [],
    speed = (row: number): { v: V; w: V } => ({
      v: [c.linearX[row]!, c.linearY[row]!, c.linearZ[row]!],
      w: [c.angularX[row]!, c.angularY[row]!, c.angularZ[row]!],
    });
  for (const link of links) {
    const parent = poseOf(kernel, link.parentBody),
      body = poseOf(kernel, link.body),
      frame = qmul(parent.q, link.frameA),
      [p, b] = [speed(link.parentBody), speed(link.body)],
      center = (row: number): V => [c.centerX[row]!, c.centerY[row]!, c.centerZ[row]!],
      armA = sub(add(parent.p, qrot(parent.q, link.anchorA)), center(link.parentBody)),
      armB = sub(add(body.p, qrot(body.q, link.anchorB)), center(link.body)),
      va = add(p.v, cross(p.w, armA)),
      vb = add(b.v, cross(b.w, armB)),
      along = sub(vb, va);
    for (const k of link.linear) out.push(dot(along, qrot(frame, unit[k]!)));
    const spin = sub(b.w, p.w);
    for (const k of link.angular) out.push(dot(spin, qrot(frame, unit[k]!)));
  }
  return out;
}

/** Solves a x = b for a small dense square a by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length,
    m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[best]![col]!)) best = r;
    [m[col], m[best]] = [m[best]!, m[col]!];
    const pivot = m[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = m[r]![col]! / pivot;
      for (let k = col; k <= n; k++) m[r]![k]! -= f * m[col]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = m[r]![n]!;
    for (let k = r + 1; k < n; k++) sum -= m[r]![k]! * x[k]!;
    x[r] = sum / m[r]![r]!;
  }
  return x;
}

export function inverseKinematics(
  kernel: KernelWorld,
  multibody: Multibody,
  link: { row: number },
  target: IkTarget,
  options: IkOptions,
): IkResult {
  const { links } = describe(kernel, multibody),
    rows = [multibody.root.row, ...links.map((l) => l.body)],
    end = rows.indexOf(link.row);
  if (end < 1) throw new RangeError('Inverse kinematics needs a link of this multibody other than its root.');
  if (!target.position && !target.rotation)
    throw new RangeError('An inverse kinematics target needs a position, a rotation, or both.');
  const {
    point = [0, 0, 0],
    damping = 0.05,
    iterations = 100,
    positionTolerance = 1e-4,
    rotationTolerance = 1e-3,
    maxStep = 0.3,
  } = options;
  if (!(damping > 0) || !(iterations >= 1) || !(maxStep > 0))
    throw new RangeError('IK damping, iterations and maxStep must be above 0.');
  const path: number[] = [];
  for (let at = end; at > 0; at = links[at - 1]!.parent) path.unshift(at);
  const states = links.map((l) => measure(kernel, l)),
    goalRotation = target.rotation ? qnorm([...target.rotation] as Q) : null;
  const errors = (): { e: number[]; position: number; rotation: number; poses: { p: V; q: Q }[] } => {
    const poses = forward(kernel, links, states, multibody.root.row),
      tip = poses[end]!,
      reach = add(tip.p, qrot(tip.q, point)),
      e: number[] = [];
    let position = 0,
      rotation = 0;
    if (target.position) {
      const d = sub(target.position, reach);
      e.push(...d);
      position = Math.hypot(...d);
    }
    if (goalRotation) {
      const d = toVector(qmul(goalRotation, qconj(tip.q)));
      e.push(...d);
      rotation = Math.hypot(...d);
    }
    return { e, position, rotation, poses };
  };
  let now = errors(),
    step = 0;
  const done = (): boolean =>
    (!target.position || now.position < positionTolerance) && (!goalRotation || now.rotation < rotationTolerance);
  for (; step < iterations && !done(); step++) {
    const tip = now.poses[end]!,
      reach = add(tip.p, qrot(tip.q, point)),
      columns: number[][] = [],
      owners: { link: number; kind: 'offset' | 'angle' | 'turn'; axis: number; slot: number }[] = [];
    for (const i of path) {
      const l = links[i - 1]!,
        parent = now.poses[l.parent]!,
        frame = qmul(parent.q, l.frameA),
        anchor = add(parent.p, qrot(parent.q, l.anchorA));
      l.linear.forEach((k, n) => {
        const axis = qrot(frame, unit[k]!),
          col: number[] = [];
        if (target.position) col.push(...axis);
        if (goalRotation) col.push(0, 0, 0);
        columns.push(col);
        owners.push({ link: i - 1, kind: 'offset', axis: k, slot: n });
      });
      l.angular.forEach((k) => {
        const axis = qrot(frame, unit[k]!),
          col: number[] = [];
        if (target.position) col.push(...cross(axis, sub(reach, anchor)));
        if (goalRotation) col.push(...axis);
        columns.push(col);
        owners.push({ link: i - 1, kind: l.angular.length === 1 ? 'angle' : 'turn', axis: k, slot: 0 });
      });
    }
    const rowsN = now.e.length,
      jjt = Array.from({ length: rowsN }, (_, r) =>
        Array.from(
          { length: rowsN },
          (_, s) => columns.reduce((sum, col) => sum + col[r]! * col[s]!, 0) + (r === s ? damping * damping : 0),
        ),
      ),
      y = solve(jjt, now.e),
      delta = columns.map((col) => col.reduce((sum, v, r) => sum + v * y[r]!, 0)),
      biggest = Math.max(...delta.map(Math.abs)),
      scale = biggest > maxStep ? maxStep / biggest : 1;
    delta.forEach((d, n) => {
      const o = owners[n]!,
        l = links[o.link]!,
        state = states[o.link]!,
        move = d * scale;
      if (o.kind === 'offset') {
        const [low, high] = l.limits[o.axis] ?? [-Infinity, Infinity];
        state.offsets[o.slot] = Math.min(high, Math.max(low, state.offsets[o.slot]! + move));
      } else if (o.kind === 'angle') {
        const [low, high] = l.limits[3 + o.axis] ?? [-Infinity, Infinity];
        state.angle = Math.min(high, Math.max(low, state.angle + move));
      } else {
        const v: V = [0, 0, 0];
        v[o.axis] = move;
        state.rel = qnorm(qmul(fromVector(v), state.rel));
      }
    });
    now = errors();
  }
  place(kernel, multibody, links, states);
  if (!Number.isFinite(now.position) || !Number.isFinite(now.rotation))
    throw new MargoError('failed', 'Inverse kinematics went out of range; give it a target the tree can approach.');
  return { converged: done(), iterations: step, positionError: now.position, rotationError: now.rotation };
}
