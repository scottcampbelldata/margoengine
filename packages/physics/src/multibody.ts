// A multibody of the own solver: a tree of bodies whose joints the kernel holds in reduced coordinates (kernel/src/multibody.rs).
// This file builds and removes the tree and writes its columns; reading and setting its coordinates and the inverse
// kinematics are in next/kinematics.ts.
import { MargoError } from '@margoengine/math/errors';
import { augmentedMassMatrix, forwardDynamics, inverseDynamics, inverseOf, jacobian, massMatrix } from './dynamics.js';
import type { JointOptions } from './joints.js';
import { JOINT_LOCK, type KernelWorld } from './kernel.js';
import type { PhysicsBody } from './body.js';
import type { Vec3 } from './math.js';
import type { PhysicsJoint } from './joints.js';
import {
  applyDisplacements,
  bodyJacobian,
  coordinates,
  inverseKinematics,
  linkPose,
  jointVelocities,
  setCoordinates,
  type IkOptions,
  type IkResult,
  type IkTarget,
} from './kinematics.js';

/** One link added to a multibody: its body, the body it hangs from, and the joint between them. */
export interface MultibodyLinkOptions {
  body: PhysicsBody;
  /** A body already in the tree (default the link before it, or the root for the first). */
  parent?: PhysicsBody;
  /** `fixed`, `revolute`, `prismatic`, `spherical` or `generic`: the joints that are made of locks. */
  joint: JointOptions;
}

/** A link of a built multibody. */
export interface MultibodyLink {
  readonly body: PhysicsBody;
  readonly parent: PhysicsBody;
  readonly joint: PhysicsJoint;
}

/** What a multibody needs of its world. */
export interface MultibodyOwner {
  readonly kernel: KernelWorld;
  addJoint(bodyA: PhysicsBody, bodyB: PhysicsBody, options: JointOptions): PhysicsJoint;
  removeMultibody(multibody: Multibody): void;
}

const NONE = 0xffffffff;
const TYPES: readonly string[] = ['fixed', 'revolute', 'prismatic', 'spherical', 'generic'];

/**
 * A tree of bodies held to reduced coordinates, Rapier's multibody joints: the joints cannot drift open however long the
 * simulation runs, a branch is solved as exactly as a chain, and what contacts push into one link is shared through the joints
 * the way an articulated body would share it. The root's own motion is free when the root is `dynamic` and carried along when
 * it is `fixed` or kinematic. Build one with `physics.addMultibody`.
 */
export class Multibody {
  private removed = false;
  /** @internal */
  constructor(
    private readonly owner: MultibodyOwner,
    readonly root: PhysicsBody,
    readonly links: readonly MultibodyLink[],
  ) {}
  get valid(): boolean {
    return !this.removed;
  }
  /** How many links the tree has, its root included (Rapier's `num_links`). */
  get numLinks(): number {
    return this.links.length + 1;
  }
  /** Every body of the tree, the root first and the links in the order they were given (Rapier's `attached_bodies`). */
  attachedBodies(): PhysicsBody[] {
    return [this.root, ...this.links.map((link) => link.body)];
  }
  /** A body's place in the tree: 0 for the root, 1 and up for the links in order, -1 for a body that is not in it. */
  linkIndex(body: PhysicsBody): number {
    if (body === this.root) return 0;
    const at = this.links.findIndex((link) => link.body === body);
    return at < 0 ? -1 : at + 1;
  }
  /** The body at a place of {@link Multibody.linkIndex}, or `undefined` past the end. */
  bodyAt(index: number): PhysicsBody | undefined {
    return index === 0 ? this.root : this.links[index - 1]?.body;
  }
  /** The joint that holds two bodies of the tree together, in either order, or `undefined` when none does. */
  jointBetween(a: PhysicsBody, b: PhysicsBody): PhysicsJoint | undefined {
    return this.links.find((link) => (link.body === a && link.parent === b) || (link.body === b && link.parent === a))
      ?.joint;
  }
  /**
   * Whether bodies of the tree may touch one another, Rapier's `set_self_contacts_enabled` (default true). Off, no two bodies of
   * the tree touch, joined or not; on, a joint's own `contactsEnabled` still decides for the pair it holds.
   */
  get selfContacts(): boolean {
    this.check();
    return this.owner.kernel.columns.mbNoSelf[this.root.row] === 0;
  }
  set selfContacts(value: boolean) {
    this.check();
    this.owner.kernel.columns.mbNoSelf[this.root.row] = value ? 0 : 1;
    this.owner.kernel.wake(this.root.row);
  }
  /** Joint speeds the tree has beyond its root's own: the number of values `coordinates()` returns. */
  get dof(): number {
    return coordinates(this.owner.kernel, this).length;
  }
  /**
   * The joint coordinates, link by link in the order given: for each free axis along frame A, the offset in metres; for a joint
   * with one free turning axis, its angle in radians (counted past a whole turn from the angle it started at); for two or three,
   * the rotation vector of frame B in frame A, read at each free axis.
   */
  coordinates(): number[] {
    this.check();
    return coordinates(this.owner.kernel, this);
  }
  /** Puts every link where these coordinates place it, from the root's pose, and wakes the tree. Velocities are kept. */
  setCoordinates(values: readonly number[]): this {
    this.check();
    setCoordinates(this.owner.kernel, this, values);
    return this;
  }
  /** Adds `deltas` to the coordinates, in the order of {@link Multibody.coordinates}, and poses the links; a turn of two or three axes composes. */
  applyDisplacements(deltas: readonly number[]): this {
    this.check();
    applyDisplacements(this.owner.kernel, this, deltas);
    return this;
  }
  /**
   * Where a body of the tree is for the given coordinates (or where its joints are now), as `{position, rotation}` in the
   * world's frame, without moving any body: Rapier's `forward_kinematics_single_link`.
   * @throws RangeError for a body that is not in the tree, or coordinates of the wrong number.
   */
  forwardKinematics(
    body: PhysicsBody,
    coordinates?: readonly number[],
  ): { position: [number, number, number]; rotation: [number, number, number, number] } {
    this.check();
    return linkPose(this.owner.kernel, this, body, coordinates);
  }
  /**
   * The Jacobian of a point of a body (default its origin): six rows, the point's velocity along X, Y, Z then the body's spin about
   * X, Y, Z, each with a column for every coordinate in the order of {@link Multibody.coordinates}; only the joints between the
   * root and the body are nonzero. Rapier's `body_jacobian`.
   * @throws RangeError for a body that is not in the tree, or coordinates of the wrong number.
   */
  bodyJacobian(body: PhysicsBody, point: Vec3 = [0, 0, 0], coordinates?: readonly number[]): number[][] {
    this.check();
    return bodyJacobian(this.owner.kernel, this, body, point, coordinates);
  }
  /** The bodies from the root to `body`, both included: the joints a coordinate of it depends on (Rapier's `kinematic_branch`). */
  kinematicBranch(body: PhysicsBody): PhysicsBody[] {
    this.check();
    const branch: PhysicsBody[] = [];
    for (let at: PhysicsBody | undefined = body; at; at = this.links.find((link) => link.body === at)?.parent) {
      branch.unshift(at);
      if (at === this.root) return branch;
    }
    throw new RangeError('This body is not in the multibody; pass its root or one of its links.');
  }
  /** The speed of each coordinate, in the order of {@link Multibody.coordinates}, in m/s or rad/s. */
  velocities(): number[] {
    this.check();
    return jointVelocities(this.owner.kernel, this);
  }
  /**
   * Moves the joint coordinates so that `link` reaches `target` (Rapier's multibody inverse kinematics): a damped least squares
   * step of the Jacobian over the joints between the root and the link (Buss 2004, section 6), repeated, with hinge limits
   * kept. The links are posed by forward kinematics where it ends; give the tree a step to see the result in contacts.
   * @throws RangeError for a link that is not in this tree, or a target with neither a position nor a rotation.
   */
  inverseKinematics(link: PhysicsBody, target: IkTarget, options: IkOptions = {}): IkResult {
    this.check();
    return inverseKinematics(this.owner.kernel, this, link, target, options);
  }
  /**
   * The mass matrix H in joint coordinates (`dof` by `dof`, symmetric positive definite): the kinetic energy of the tree is
   * half of `velocities()` times H times `velocities()`, each joint's rotor (`joint.setArmature`) on its diagonal. The root is
   * the frame of the tree and is not a coordinate. Needs every link to carry mass and inertia.
   */
  massMatrix(): number[][] {
    this.check();
    return massMatrix(this.owner.kernel, this);
  }
  /**
   * The augmented mass matrix of an implicit step of `h` seconds (Rapier's `augmented_mass`): {@link Multibody.massMatrix}, armature
   * included, plus `h * (c + h * k)` on the diagonal of each coordinate whose axis has a force motor of damping `c` and stiffness
   * `k` (`joint.setDamping`, `setFriction` while under its cap, a `motor` with `model: 'force'`). The kernel takes motors implicitly
   * over each substep, so pass the step over the substeps, `physics.fixedTimestep / physics.kernel.substeps`, to read the matrix
   * a substep solves against.
   * @throws RangeError for an `h` that is not a finite number above 0.
   */
  augmentedMassMatrix(h: number): number[][] {
    this.check();
    if (!(h > 0) || !Number.isFinite(h)) throw new RangeError(`A step must be finite and above 0 (got ${h} s).`);
    return augmentedMassMatrix(this.owner.kernel, this, h);
  }
  /**
   * The inverse of the mass matrix, or of the augmented one of a step of `h` seconds (Rapier's `inv_augmented_mass`): column `j` is
   * the joint accelerations a unit torque on coordinate `j` gives, every other joint free.
   */
  inverseMassMatrix(h?: number): number[][] {
    return inverseOf(h === undefined ? this.massMatrix() : this.augmentedMassMatrix(h));
  }
  /**
   * Each coordinate's inverse inertia, the diagonal of {@link Multibody.inverseMassMatrix}: the acceleration of a joint under a unit
   * torque on it with every other joint free to move, in 1/(kg m²) for a turn and 1/kg for a slide. A joint constraint's effective
   * mass on that axis is its inverse.
   */
  dofInverseInertia(h?: number): number[] {
    return this.inverseMassMatrix(h).map((row, i) => row[i]!);
  }
  /**
   * The Jacobian of a point of a link: six rows (the point's velocity along x, y, z, then the link's angular velocity) by
   * `dof` columns, so the point moves at J times `velocities()`. `point` is in the link's own frame (default its origin).
   * @throws RangeError for a link that is not in this tree.
   */
  jacobian(link: PhysicsBody, point: Vec3 = [0, 0, 0]): number[][] {
    this.check();
    return jacobian(this.owner.kernel, this, link, point);
  }
  /**
   * Inverse dynamics (the recursive Newton-Euler method): the torque of each joint coordinate (newtons for a slide, newton metres
   * for a turn, in the order of `coordinates()`) that gives the joint accelerations `accelerations` (default none) at the tree's
   * present coordinates and speeds, under `gravity` (default the world's). With no accelerations it is what holds the tree still
   * against gravity and the speeds' Coriolis and centrifugal terms, the bias of the equation H qdd + bias = tau.
   */
  inverseDynamics(accelerations?: readonly number[], options: { gravity?: Vec3 } = {}): number[] {
    this.check();
    const dof = this.dof;
    if (accelerations && accelerations.length !== dof)
      throw new RangeError(`Give ${dof} joint accelerations, one for each coordinate.`);
    return inverseDynamics(
      this.owner.kernel,
      this,
      this.velocities(),
      accelerations ?? new Array<number>(dof).fill(0),
      options.gravity ?? this.owner.kernel.gravity,
    );
  }
  /**
   * Forward dynamics: the joint accelerations that `torques` give at the tree's present coordinates and speeds, under `gravity`
   * (default the world's): H qdd = tau - bias.
   */
  forwardDynamics(torques: readonly number[], options: { gravity?: Vec3 } = {}): number[] {
    this.check();
    if (torques.length !== this.dof) throw new RangeError(`Give ${this.dof} joint torques, one for each coordinate.`);
    return forwardDynamics(
      this.owner.kernel,
      this,
      this.velocities(),
      torques,
      options.gravity ?? this.owner.kernel.gravity,
    );
  }
  /**
   * Solves the motors of `link`'s joint to its parent inside the tree's own direct solve, as implicit springs (default off):
   * each one a spring and damper on the joint's coordinate, stepped by backward Euler together with every other link's, so
   * a long, stiff chain of them (a rod, a cable, a tentacle, hair) stays stable at any stiffness and any number of links,
   * where motors solved one joint at a time run away. It takes the motors set with `model: 'force'`, no `maxForce` and no
   * limit on their axis; any other motor of the joint stays with the joint passes. `link` may be an array of links, and
   * `on: false` hands the motors back.
   * @throws MargoError (`state`) for a body that is not a link of this tree (the root has no joint of its own).
   */
  setImplicitMotors(link: PhysicsBody | readonly PhysicsBody[], on = true): this {
    this.check();
    const columns = this.owner.kernel.columns;
    for (const body of Array.isArray(link) ? (link as readonly PhysicsBody[]) : [link as PhysicsBody]) {
      const found = this.links.find((entry) => entry.body === body);
      if (!found)
        throw new MargoError(
          'state',
          'Implicit motors are set on a link of this multibody; pass one of multibody.links[i].body (the root has no joint of its own).',
        );
      columns.jointElastic[found.joint.row] = (columns.jointElastic[found.joint.row] & ~63) | (on ? 63 : 0);
      this.owner.kernel.wake(body.row);
    }
    return this;
  }
  /**
   * Holds a joint from a body of this tree to a body outside it in the tree's own solve, as a stiff spring between its
   * anchors stepped by backward Euler with the tree's springs (default off): the end of a cable pinned to a bollard or a
   * hull, which the joint passes alone, a joint at a time, let open under a stiff rod's pull. The joint keeps its other locks
   * in the joint passes. The other body gets the pin's pull back; `on: false` hands the joint back to the joint passes.
   * `give` lets the pin give way along its link's own +Y axis as a spring (N/m) and damper (N s/m): the half link a rod's
   * pinned end stands for, which stretches with the rest of the rod (default none: stiff every way).
   * @throws MargoError (`state`) for a joint that does not join this tree to a body outside it, or that does not lock all
   * three of its sliding axes; RangeError for a `give` that is not positive and finite.
   */
  pinJoint(joint: PhysicsJoint, on = true, give?: { stiffness: number; damping?: number }): this {
    this.check();
    const columns = this.owner.kernel.columns,
      inTree = new Set(this.attachedBodies());
    if (!joint?.valid || inTree.has(joint.bodyA) === inTree.has(joint.bodyB))
      throw new MargoError(
        'state',
        'A pinned joint joins a body of this multibody to a body outside it; pass such a joint.',
      );
    if ((columns.jointFlags[joint.row] & (JOINT_LOCK * 7)) !== JOINT_LOCK * 7)
      throw new MargoError(
        'state',
        'A pinned joint locks all three sliding axes; lock linX, linY and linZ, or pin with a spherical joint.',
      );
    if (give !== undefined) {
      const damping = give.damping ?? 0;
      if (!(give.stiffness > 0) || !Number.isFinite(give.stiffness) || !(damping >= 0) || !Number.isFinite(damping))
        throw new RangeError(
          'A pin gives way as a spring; pass a positive finite stiffness in N/m and a damping of 0 or more in N s/m.',
        );
      columns.jointStiffness1[joint.row] = give.stiffness;
      columns.jointDamping1[joint.row] = damping;
    }
    columns.jointElastic[joint.row] =
      (columns.jointElastic[joint.row] & ~(64 | 128)) | (on ? 64 : 0) | (on && give !== undefined ? 128 : 0);
    this.owner.kernel.wake(joint.bodyA.row);
    this.owner.kernel.wake(joint.bodyB.row);
    return this;
  }
  /** True when `link`'s joint motors are solved inside the tree (see {@link Multibody.setImplicitMotors}). */
  implicitMotors(link: PhysicsBody): boolean {
    this.check();
    const found = this.links.find((entry) => entry.body === link);
    return found !== undefined && this.owner.kernel.columns.jointElastic[found.joint.row] !== 0;
  }
  /** Releases the tree: the bodies stay, with their joints as ordinary joints that are no longer held to reduced coordinates. */
  remove(): void {
    if (!this.removed) this.owner.removeMultibody(this);
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  private check(): void {
    if (this.removed)
      throw new MargoError('state', 'Multibody was removed; build a new one with physics.addMultibody.');
  }
}

/**
 * Builds the joints and writes the tree into the kernel's columns, parents before children.
 * @throws RangeError or MargoError for a body already in a tree, a parent that is not in this one, or a joint that is not made of
 * locks.
 */
export function buildMultibody(
  owner: MultibodyOwner,
  root: PhysicsBody,
  links: readonly MultibodyLinkOptions[],
): Multibody {
  const { kernel } = owner,
    columns = kernel.columns;
  if (links.length < 1)
    throw new RangeError('A multibody needs at least one link besides its root; pass the bodies that hang from it.');
  const inTree = new Set<PhysicsBody>([root]);
  if (columns.mbRole[root.row] !== 0)
    throw new MargoError('state', 'A body can be in one multibody only; remove the first with multibody.remove().');
  for (const link of links) {
    const parent = link.parent ?? [...inTree].pop()!;
    if (!inTree.has(parent))
      throw new MargoError(
        'state',
        'A link hangs from a body already in the tree; list parents before their children.',
      );
    if (inTree.has(link.body)) throw new MargoError('state', 'A body is in a multibody once; the tree has no loops.');
    if (columns.mbRole[link.body.row] !== 0)
      throw new MargoError('state', 'A body can be in one multibody only; remove the first with multibody.remove().');
    if (!TYPES.includes(link.joint.type))
      throw new TypeError(`A multibody joint is ${TYPES.join(', ')}; got ${String(link.joint.type)}.`);
    inTree.add(link.body);
  }
  const built: MultibodyLink[] = [],
    placed = new Set<PhysicsBody>([root]);
  let last = root;
  try {
    for (const link of links) {
      const parent = link.parent ?? last,
        joint = owner.addJoint(parent, link.body, link.joint);
      built.push({ body: link.body, parent, joint });
      placed.add(link.body);
      last = link.body;
    }
  } catch (error) {
    for (const link of built) link.joint.remove();
    throw error;
  }
  columns.mbRole[root.row] = 1;
  columns.mbRoot[root.row] = root.row;
  columns.mbNext[root.row] = NONE;
  columns.mbJoint[root.row] = NONE;
  columns.mbParent[root.row] = NONE;
  let previous = root;
  for (const link of built) {
    const row = link.body.row;
    columns.mbRole[row] = 2;
    columns.mbRoot[row] = root.row;
    columns.mbNext[row] = NONE;
    columns.mbJoint[row] = link.joint.row;
    columns.mbParent[row] = link.parent.row;
    columns.mbNext[previous.row] = row;
    previous = link.body;
  }
  for (const link of built) kernel.wake(link.body.row);
  kernel.wake(root.row);
  return new Multibody(owner, root, built);
}

/** Clears the tree's columns. */
export function clearMultibody(kernel: KernelWorld, multibody: Multibody): void {
  const columns = kernel.columns;
  for (const body of [multibody.root, ...multibody.links.map((link) => link.body)]) {
    if (!body.valid) continue;
    columns.mbRole[body.row] = 0;
    columns.mbNext[body.row] = NONE;
    columns.mbJoint[body.row] = NONE;
    columns.mbParent[body.row] = NONE;
    columns.mbNoSelf[body.row] = 0;
  }
  for (const link of multibody.links) if (link.joint.valid) columns.jointElastic[link.joint.row] = 0;
}
