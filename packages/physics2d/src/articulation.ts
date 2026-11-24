import { MargoError } from '@margoengine/math/errors';
import type { Body2D } from './body.js';
import type { Joint2D, JointOptions2D, MotorOptions2D } from './joint.js';
import type { Physics2D } from './physics.js';
import type { Vec2D } from './shapes.js';

/** One link of an articulation: a body joined to its parent by a revolute or prismatic joint. */
export interface ArticulationLink2D {
  body: Body2D;
  /** Index in the list of the link this one hangs from; -1 or left out for the root. Must come before this link. */
  parent?: number;
  joint: {
    type: 'revolute' | 'prismatic';
    /** The joint's anchor in the parent's frame, world units (default the parent's origin). */
    anchorParent?: Vec2D;
    /** The joint's anchor in this link's frame (default its origin). */
    anchorChild?: Vec2D;
    /** The slide axis in the parent's frame (prismatic only). */
    axis?: Vec2D;
    /** Radians (revolute) or world units (prismatic). */
    limits?: readonly [number, number];
    motor?: MotorOptions2D;
  };
}

/** Where a link is, in world units and radians. */
export interface LinkPose2D {
  position: [number, number];
  rotation: number;
}

const wrap = (angle: number): number => {
  const a = angle % (2 * Math.PI);
  return a > Math.PI ? a - 2 * Math.PI : a < -Math.PI ? a + 2 * Math.PI : a;
};

/** Options of {@link Articulation2D.solveIK}. */
export interface IKOptions2D {
  /** Most iterations (default 64). */
  iterations?: number;
  /** Stop when the point is this close to the target, world units (default 0.01). */
  tolerance?: number;
  /** Damping of the least-squares step: larger is steadier near a straight arm and slower (default 0.5). */
  damping?: number;
}

/**
 * A tree of bodies joined by one-degree-of-freedom joints, with the joint space of the whole made explicit: the joint
 * positions and velocities, motors and limits on each joint, forward kinematics and inverse kinematics. The bodies stay
 * ordinary bodies of the world, and the kernel's joints keep them together: a chain solves exactly (block elimination, the
 * constraint form of Featherstone's articulated-body result: "Rigid Body Dynamics Algorithms", Springer 2008, chapter 7) so a
 * heavy end does not stretch it, and contacts of any link act on the whole.
 * @example
 * const arm = physics.addArticulation(base, [
 *   { body: upper, joint: { type: 'revolute', anchorParent: [0, 0], anchorChild: [-20, 0], limits: [-2, 2] } },
 *   { body: lower, parent: 0, joint: { type: 'revolute', anchorParent: [20, 0], anchorChild: [-20, 0] } },
 * ]);
 * arm.solveIK(1, [20, 0], [60, 10]); // joint positions that put the lower arm's tip there
 */
export class Articulation2D {
  /** The joints, one per link, in link order. */
  readonly joints: Joint2D[] = [];
  private readonly links: Array<{
    link: ArticulationLink2D;
    parent: number;
    anchorParent: Vec2D;
    anchorChild: Vec2D;
    axis: Vec2D;
  }>;
  private removed = false;
  /** @internal */
  constructor(
    private readonly physics: Physics2D,
    readonly root: Body2D,
    links: readonly ArticulationLink2D[],
  ) {
    if (!links.length) throw new TypeError('An articulation needs at least one link; pass the bodies hanging from the root.');
    this.links = links.map((link, i) => {
      const parent = link.parent ?? -1;
      if (!Number.isInteger(parent) || parent < -1 || parent >= i)
        throw new RangeError(`link ${i}: parent must be -1 (the root) or the index of an earlier link, got ${parent}; list parents before children.`);
      const j = link.joint;
      if (j.type !== 'revolute' && j.type !== 'prismatic')
        throw new TypeError(`link ${i}: an articulation joint is revolute or prismatic, got "${(j as { type: string }).type}"; use one of those types.`);
      const raw: Vec2D = j.axis ?? [1, 0];
      const length = Math.hypot(raw[0], raw[1]);
      if (!(length > 0) || !Number.isFinite(length)) throw new RangeError(`link ${i}: the joint axis must be a finite vector that is not zero; try [1, 0].`);
      // The kernel's prismatic joint measures along the unit axis, so the joint space does too.
      const axis: Vec2D = [raw[0] / length, raw[1] / length];
      return { link, parent, anchorParent: j.anchorParent ?? [0, 0], anchorChild: j.anchorChild ?? [0, 0], axis };
    });
    try {
      this.links.forEach(({ link, parent, anchorParent, anchorChild, axis }) => {
        const j = link.joint;
        const options = {
          type: j.type,
          anchorA: anchorParent,
          anchorB: anchorChild,
          ...(j.type === 'prismatic' ? { axis } : {}),
          ...(j.limits ? { limits: j.limits } : {}),
          ...(j.motor ? { motor: j.motor } : {}),
          collide: false,
        } as JointOptions2D;
        this.joints.push(physics.addJoint(parent < 0 ? root : this.links[parent].link.body, link.body, options));
      });
    } catch (error) {
      for (const joint of this.joints) joint.remove();
      throw error;
    }
  }

  /** The number of joints, which is the number of degrees of freedom. */
  get dof(): number {
    return this.links.length;
  }
  private bodyOf(parent: number): Body2D {
    return parent < 0 ? this.root : this.links[parent].link.body;
  }
  private check(): void {
    if (this.removed) throw new MargoError('state', 'Articulation2D was removed; add a new one with Physics2D.addArticulation.');
  }

  /** The joint positions now, in link order: radians for a revolute joint (child turn less parent turn), world units along the axis for a prismatic one. */
  positions(): number[] {
    this.check();
    return this.links.map(({ link, parent, anchorParent, anchorChild, axis }) => {
      const p = this.bodyOf(parent),
        c = link.body;
      if (link.joint.type === 'revolute') return wrap(c.rotation - p.rotation);
      const [pa, ca] = [this.world(p, anchorParent), this.world(c, anchorChild)];
      const u = rotate(axis, p.rotation);
      return u[0] * (ca[0] - pa[0]) + u[1] * (ca[1] - pa[1]);
    });
  }

  /** The joint velocities now: the relative angular speed, or the speed along the axis. */
  velocities(): number[] {
    this.check();
    return this.links.map(({ link, parent, anchorParent, anchorChild, axis }) => {
      const p = this.bodyOf(parent),
        c = link.body;
      if (link.joint.type === 'revolute') return c.angularVelocity - p.angularVelocity;
      const pv = this.pointVelocity(p, anchorParent),
        cv = this.pointVelocity(c, anchorChild);
      const u = rotate(axis, p.rotation);
      return u[0] * (cv[0] - pv[0]) + u[1] * (cv[1] - pv[1]);
    });
  }

  private world(body: Body2D, local: Vec2D): [number, number] {
    const r = rotate(local, body.rotation);
    return [body.position[0] + r[0], body.position[1] + r[1]];
  }
  private pointVelocity(body: Body2D, local: Vec2D): [number, number] {
    const r = rotate(local, body.rotation),
      v = body.linearVelocity,
      w = body.angularVelocity;
    return [v[0] - w * r[1], v[1] + w * r[0]];
  }

  /** Where every link is when the joints are at `q`, from the root's pose now. */
  forwardKinematics(q: readonly number[] = this.positions()): LinkPose2D[] {
    this.check();
    if (q.length !== this.dof) throw new RangeError(`q has ${q.length} values for ${this.dof} joints; pass one value per joint.`);
    const poses: LinkPose2D[] = [];
    const rootPose: LinkPose2D = { position: [...this.root.position], rotation: this.root.rotation };
    this.links.forEach(({ link, parent, anchorParent, anchorChild, axis }, i) => {
      const p = parent < 0 ? rootPose : poses[parent];
      const anchor = rotate(anchorParent, p.rotation);
      const at: [number, number] = [p.position[0] + anchor[0], p.position[1] + anchor[1]];
      if (link.joint.type === 'revolute') {
        const rotation = p.rotation + q[i];
        const arm = rotate(anchorChild, rotation);
        poses.push({ position: [at[0] - arm[0], at[1] - arm[1]], rotation });
      } else {
        const u = rotate(axis, p.rotation);
        const arm = rotate(anchorChild, p.rotation);
        poses.push({ position: [at[0] + u[0] * q[i] - arm[0], at[1] + u[1] * q[i] - arm[1]], rotation: p.rotation });
      }
    });
    return poses;
  }

  /** The world position of `local` (a point in link `link`'s frame) when the joints are at `q`. */
  pointAt(link: number, local: Vec2D, q: readonly number[] = this.positions()): [number, number] {
    this.checkLink(link);
    const pose = this.forwardKinematics(q)[link];
    const r = rotate(local, pose.rotation);
    return [pose.position[0] + r[0], pose.position[1] + r[1]];
  }
  private checkLink(link: number): void {
    if (!Number.isInteger(link) || link < 0 || link >= this.dof) throw new RangeError(`link must be 0 to ${this.dof - 1}, got ${link}; pass an index of this articulation.`);
  }

  /** The 2 by dof Jacobian of the point `local` of link `link`: how it moves, in world units per unit of each joint, at `q`. */
  jacobian(link: number, local: Vec2D, q: readonly number[] = this.positions()): [number[], number[]] {
    this.checkLink(link);
    const jx: number[] = [],
      jy: number[] = [];
    for (let i = 0; i < this.dof; i++) {
      // Central difference of the exact forward kinematics: a revolute joint turns the point, a prismatic one slides it.
      const h = this.links[i].link.joint.type === 'revolute' ? 1e-5 : 1e-4 * (1 + Math.abs(q[i]));
      const [lo, hi] = [q.slice(), q.slice()];
      lo[i] -= h;
      hi[i] += h;
      const [a, b] = [this.pointAt(link, local, lo), this.pointAt(link, local, hi)];
      jx.push((b[0] - a[0]) / (2 * h));
      jy.push((b[1] - a[1]) / (2 * h));
    }
    return [jx, jy];
  }

  /**
   * Joint positions that put the point `local` of link `link` on `target`, by damped least squares from the joints' present
   * positions (Wampler 1986, Nakamura and Hanafusa 1986), kept inside the joints' limits. Returns the positions and whether
   * the point got within `tolerance`; nothing moves until you `setPositions` or `driveTo`.
   */
  solveIK(link: number, local: Vec2D, target: Vec2D, options: IKOptions2D = {}): { q: number[]; reached: boolean; error: number } {
    this.checkLink(link);
    const { iterations = 64, tolerance = 0.01, damping = 0.5 } = options;
    const q = this.positions();
    const limits = this.links.map(({ link: l }) => l.joint.limits);
    let error = Infinity;
    for (let it = 0; it < iterations; it++) {
      const at = this.pointAt(link, local, q);
      const e: [number, number] = [target[0] - at[0], target[1] - at[1]];
      error = Math.hypot(e[0], e[1]);
      if (error <= tolerance) break;
      const [jx, jy] = this.jacobian(link, local, q);
      // dq = J^T (J J^T + lambda^2 I)^-1 e; J J^T is 2 by 2.
      let a = damping * damping,
        b = 0,
        d = damping * damping;
      for (let i = 0; i < this.dof; i++) {
        a += jx[i] * jx[i];
        b += jx[i] * jy[i];
        d += jy[i] * jy[i];
      }
      const det = a * d - b * b;
      const y: [number, number] = [(d * e[0] - b * e[1]) / det, (a * e[1] - b * e[0]) / det];
      // A revolute step is cut to 0.3 rad: the linearisation is only good near the point.
      const steps = jx.map((x, i) => x * y[0] + jy[i] * y[1]);
      // The whole step is shortened, keeping its direction, until no revolute joint turns more than 0.3 rad.
      let biggest = 0;
      steps.forEach((v, i) => {
        if (this.links[i].link.joint.type === 'revolute') biggest = Math.max(biggest, Math.abs(v));
      });
      const scale = biggest > 0.3 ? 0.3 / biggest : 1;
      for (let i = 0; i < this.dof; i++) {
        q[i] += steps[i] * scale;
        const range = limits[i];
        if (range) q[i] = Math.max(range[0], Math.min(range[1], q[i]));
      }
    }
    const at = this.pointAt(link, local, q);
    error = Math.hypot(target[0] - at[0], target[1] - at[1]);
    return { q, reached: error <= tolerance, error };
  }

  /**
   * Puts the links where the joints at `q` would, now: each body is moved (as `teleport` does) and keeps its velocity. The
   * root stays where it is. Joint limits are not applied; give positions inside them.
   */
  setPositions(q: readonly number[]): this {
    this.check();
    const poses = this.forwardKinematics(q);
    this.links.forEach(({ link }, i) => link.body.teleport(poses[i].position, poses[i].rotation));
    return this;
  }

  /** Sets the position motor of every joint toward `q`, with the stiffness and damping given (defaults 200 and 20), so the arm moves there under the physics. */
  driveTo(q: readonly number[], { stiffness = 200, damping = 20, maxForce }: { stiffness?: number; damping?: number; maxForce?: number } = {}): this {
    this.check();
    if (q.length !== this.dof) throw new RangeError(`q has ${q.length} values for ${this.dof} joints; pass one value per joint.`);
    this.joints.forEach((joint, i) => joint.setMotor({ targetPosition: q[i], stiffness, damping, ...(maxForce !== undefined ? { maxForce } : {}) }));
    return this;
  }

  /** Sets one joint's motor. */
  setMotor(joint: number, motor: MotorOptions2D): this {
    this.check();
    this.checkLink(joint);
    this.joints[joint].setMotor(motor);
    return this;
  }
  /** Sets one joint's limits (radians or world units). */
  setLimits(joint: number, min: number, max: number): this {
    this.check();
    this.checkLink(joint);
    this.joints[joint].setLimits(min, max);
    this.links[joint].link.joint.limits = [min, max];
    return this;
  }

  /** Removes the articulation's joints; the bodies stay. */
  remove(): void {
    if (this.removed) return;
    this.removed = true;
    for (const joint of this.joints) joint.remove();
  }
}

function rotate(v: Vec2D, angle: number): [number, number] {
  const c = Math.cos(angle),
    s = Math.sin(angle);
  return [c * v[0] - s * v[1], s * v[0] + c * v[1]];
}
