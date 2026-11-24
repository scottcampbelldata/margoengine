// Dynamics of a multibody in its joint coordinates: the mass matrix, the Jacobian of a point of a link, inverse dynamics (the
// torques that give chosen joint accelerations) and forward dynamics (the accelerations that torques give). It reads the tree as
// the kernel holds it and runs between steps, never inside one, so it may use `Math`.
//
// Inverse dynamics is the recursive Newton-Euler method of Walker and Orin, "Efficient Dynamic Computer Simulation of Robotic
// Mechanisms", J. Dyn. Sys. Meas. Control 104(3), 1982, and Luh, Walker and Paul, "On-Line Computational Scheme for Mechanical
// Manipulators", J. Dyn. Sys. Meas. Control 102(2), 1980: velocities and accelerations of every link from the root out (in world
// coordinates, from each link's centre of mass), the force and torque each link needs, and the joint torques from the leaves in as
// the projection of those wrenches on the joint axes. The mass matrix is the one the composite rigid body algorithm gives
// (Featherstone, "Rigid Body Dynamics Algorithms", Springer 2008, chapter 6), H = sum of J^T M J over the links with J the
// Jacobian of a link's centre of mass and M its mass and inertia, built from the same Jacobians; forward dynamics solves
// H qdd = tau - bias, with bias the torques of inverse dynamics at zero acceleration (Featherstone, section 6.1). The root is the
// frame of the tree: its own motion is not a coordinate, so the tree is treated as hanging from a root that does not accelerate.
import { multiplyQuaternions, rotateByQuaternion } from '@margoengine/math/quat';
import type { Vec3 } from './math.js';
import type { PhysicsBody } from './body.js';
import type { KernelWorld } from './kernel.js';
import { describe, poseOf } from './kinematics.js';
import type { Multibody } from './multibody.js';

type V = [number, number, number];
type Q = [number, number, number, number];

const unit: readonly V[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const add = (a: Vec3, b: Vec3): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): V => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const qmul = (a: Q, b: Q): Q => multiplyQuaternions(a, b) as Q;
const qrot = (q: Q, v: Vec3): V => rotateByQuaternion(v, q) as V;

/** What the tree looks like now: every body's centre, mass and world inertia, and each coordinate's axis and pivot. */
interface Tree {
  /** Root first. */
  centre: V[];
  mass: number[];
  /** The inertia tensor in world axes, row-major. */
  inertia: number[][][];
  /** The point each link turns about (its anchor on the body), and the parent of each link (-1 for the root). */
  pivot: V[];
  parent: number[];
  /** The point of its parent a link is joined at. */
  joint: V[];
  /** Per link: its coordinates, each with a world axis and whether it is a turn. */
  coords: { axis: V; turn: boolean; index: number }[][];
  count: number;
}

function inertiaWorld(body: PhysicsBody): number[][] {
  const [ix, iy, iz] = body.principalInertia,
    frame = qmul(body.rotation as Q, body.inertiaFrame as Q),
    axes = unit.map((e) => qrot(frame, e)),
    moments = [ix, iy, iz],
    out = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
  for (let k = 0; k < 3; k++)
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r]![c]! += moments[k]! * axes[k]![r]! * axes[k]![c]!;
  return out;
}
const times = (m: number[][], v: Vec3): V => [
  dot(m[0]! as unknown as Vec3, v),
  dot(m[1]! as unknown as Vec3, v),
  dot(m[2]! as unknown as Vec3, v),
];

function read(kernel: KernelWorld, multibody: Multibody): Tree {
  const { links } = describe(kernel, multibody),
    bodies = [multibody.root, ...multibody.links.map((link) => link.body)],
    tree: Tree = {
      centre: [],
      mass: [],
      inertia: [],
      pivot: [],
      parent: [-1],
      joint: [[0, 0, 0]],
      coords: [[]],
      count: 0,
    };
  bodies.forEach((body, i) => {
    const pose = poseOf(kernel, body.row),
      local = body.centerOfMass;
    tree.centre.push(add(pose.p, qrot(pose.q, local)));
    tree.mass.push(i === 0 ? 0 : body.mass);
    tree.inertia.push(inertiaWorld(body));
    if (i === 0) tree.pivot.push(pose.p);
  });
  for (const link of links) {
    const parent = poseOf(kernel, link.parentBody),
      body = poseOf(kernel, link.body),
      frame = qmul(parent.q, link.frameA),
      list: Tree['coords'][number] = [];
    tree.parent.push(link.parent);
    tree.joint.push(add(parent.p, qrot(parent.q, link.anchorA)));
    tree.pivot.push(add(body.p, qrot(body.q, link.anchorB)));
    for (const k of link.linear) list.push({ axis: qrot(frame, unit[k]!), turn: false, index: tree.count++ });
    for (const k of link.angular) list.push({ axis: qrot(frame, unit[k]!), turn: true, index: tree.count++ });
    tree.coords.push(list);
  }
  return tree;
}

/** Whether link `ancestor` is `link` or one of the links it hangs from. */
function above(tree: Tree, ancestor: number, link: number): boolean {
  for (let i = link; i > 0; i = tree.parent[i]!) if (i === ancestor) return true;
  return false;
}

/** The 6 by dof Jacobian of a point `p` (world) of link `link`: rows vx vy vz wx wy wz. */
function jacobianOf(tree: Tree, link: number, point: Vec3): number[][] {
  const rows = Array.from({ length: 6 }, () => new Array<number>(tree.count).fill(0));
  for (let l = 1; l < tree.parent.length; l++) {
    if (!above(tree, l, link)) continue;
    for (const c of tree.coords[l]!) {
      const linear = c.turn ? cross(c.axis, sub(point, tree.pivot[l]!)) : c.axis;
      for (let r = 0; r < 3; r++) rows[r]![c.index] = linear[r]!;
      if (c.turn) for (let r = 0; r < 3; r++) rows[3 + r]![c.index] = c.axis[r]!;
    }
  }
  return rows;
}

/** Solves the symmetric positive definite system a x = b by Cholesky. */
function cholesky(a: number[][], b: number[]): number[] {
  const n = b.length,
    l = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++)
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!;
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!;
      if (i === j) {
        if (!(sum > 0))
          throw new RangeError('The mass matrix is not positive definite: a link has no mass or inertia; give every link a collider with a density, or call setMassProperties on it.');
        l[i]![j] = Math.sqrt(sum);
      } else l[i]![j] = sum / l[j]![j]!;
    }
  const y = new Array<number>(n).fill(0),
    x = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = b[i]!;
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!;
    y[i] = sum / l[i]![i]!;
  }
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!;
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!;
    x[i] = sum / l[i]![i]!;
  }
  return x;
}

/** The joint-space mass matrix, dof by dof (symmetric positive definite). */
export function massMatrix(kernel: KernelWorld, multibody: Multibody): number[][] {
  const tree = read(kernel, multibody),
    h = Array.from({ length: tree.count }, () => new Array<number>(tree.count).fill(0));
  for (let b = 1; b < tree.parent.length; b++) {
    const j = jacobianOf(tree, b, tree.centre[b]!);
    for (let r = 0; r < tree.count; r++) {
      const wr: V = [j[3]![r]!, j[4]![r]!, j[5]![r]!],
        iw = times(tree.inertia[b]!, wr);
      for (let c = 0; c < tree.count; c++) {
        const vr: V = [j[0]![r]!, j[1]![r]!, j[2]![r]!],
          vc: V = [j[0]![c]!, j[1]![c]!, j[2]![c]!],
          wc: V = [j[3]![c]!, j[4]![c]!, j[5]![c]!];
        h[r]![c]! += tree.mass[b]! * dot(vr, vc) + dot(iw, wc);
      }
    }
  }
  return h;
}

/** The Jacobian of a point of a link (in the link's frame): six rows (the point's velocity, then the link's spin) by dof columns. */
export function jacobian(kernel: KernelWorld, multibody: Multibody, link: PhysicsBody, point: Vec3): number[][] {
  const bodies = [multibody.root, ...multibody.links.map((l) => l.body)],
    at = bodies.indexOf(link);
  if (at < 0) throw new RangeError('That link is not in this tree; pass a body that was given to physics.addMultibody.');
  const tree = read(kernel, multibody),
    pose = poseOf(kernel, link.row);
  return jacobianOf(tree, at, add(pose.p, qrot(pose.q, point)));
}

/** Torques of the joints for joint accelerations `qdd` at the tree's coordinates and speeds, under `gravity`. */
export function inverseDynamics(
  kernel: KernelWorld,
  multibody: Multibody,
  speeds: readonly number[],
  qdd: readonly number[],
  gravity: Vec3,
): number[] {
  const tree = read(kernel, multibody),
    n = tree.parent.length,
    omega: V[] = [[0, 0, 0]],
    alpha: V[] = [[0, 0, 0]],
    velocity: V[] = [[0, 0, 0]],
    accel: V[] = [[0, 0, 0]],
    force: V[] = [[0, 0, 0]],
    torque: V[] = [[0, 0, 0]];
  for (let i = 1; i < n; i++) {
    const p = tree.parent[i]!,
      anchor = tree.joint[i]!,
      pivot = tree.pivot[i]!;
    let slide: V = [0, 0, 0],
      slideSpeed: V = [0, 0, 0],
      slideAccel: V = [0, 0, 0],
      spin: V = [0, 0, 0],
      spinAccel: V = [0, 0, 0];
    for (const c of tree.coords[i]!) {
      const speed = speeds[c.index]!,
        acc = qdd[c.index]!;
      if (c.turn) {
        spin = add(spin, scale(c.axis, speed));
        spinAccel = add(spinAccel, scale(c.axis, acc));
      } else {
        slideSpeed = add(slideSpeed, scale(c.axis, speed));
        slideAccel = add(slideAccel, scale(c.axis, acc));
      }
    }
    // The offset along the sliding axes: the pivot's distance from the anchor.
    slide = sub(pivot, anchor);
    const w = add(omega[p]!, spin),
      a = add(add(alpha[p]!, spinAccel), cross(omega[p]!, spin)),
      arm = sub(anchor, tree.centre[p]!),
      vAnchor = add(velocity[p]!, cross(omega[p]!, arm)),
      aAnchor = add(add(accel[p]!, cross(alpha[p]!, arm)), cross(omega[p]!, cross(omega[p]!, arm))),
      vPivot = add(add(vAnchor, slideSpeed), cross(omega[p]!, slide)),
      aPivot = add(
        add(add(aAnchor, slideAccel), scale(cross(omega[p]!, slideSpeed), 2)),
        add(cross(alpha[p]!, slide), cross(omega[p]!, cross(omega[p]!, slide))),
      ),
      r = sub(tree.centre[i]!, pivot);
    omega.push(w);
    alpha.push(a);
    velocity.push(add(vPivot, cross(w, r)));
    accel.push(add(add(aPivot, cross(a, r)), cross(w, cross(w, r))));
    force.push(scale(sub(accel[i]!, gravity), tree.mass[i]!));
    const iw = times(tree.inertia[i]!, w);
    torque.push(add(times(tree.inertia[i]!, a), cross(w, iw)));
  }
  const tau = new Array<number>(tree.count).fill(0);
  for (let b = 1; b < n; b++) {
    const j = jacobianOf(tree, b, tree.centre[b]!);
    for (let c = 0; c < tree.count; c++)
      tau[c]! +=
        j[0]![c]! * force[b]![0] +
        j[1]![c]! * force[b]![1] +
        j[2]![c]! * force[b]![2] +
        j[3]![c]! * torque[b]![0] +
        j[4]![c]! * torque[b]![1] +
        j[5]![c]! * torque[b]![2];
  }
  return tau;
}

/** The joint accelerations that `torques` give, at the tree's coordinates and speeds, under `gravity`. */
export function forwardDynamics(
  kernel: KernelWorld,
  multibody: Multibody,
  speeds: readonly number[],
  torques: readonly number[],
  gravity: Vec3,
): number[] {
  const zero = new Array<number>(torques.length).fill(0),
    bias = inverseDynamics(kernel, multibody, speeds, zero, gravity),
    h = massMatrix(kernel, multibody);
  return cholesky(
    h,
    torques.map((t, i) => t - bias[i]!),
  );
}
