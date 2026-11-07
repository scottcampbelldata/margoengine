// A collider of the own solver. Reads only, so it may use `Math`: nothing here can change a step.
import { MargoError } from '@margoengine/math/errors';
import type { KernelWorld } from '../kernel.js';
import type { ColliderShape } from '../collider.js';
import type { PhysicsBody } from './body.js';

const notYet = (what: string): MargoError =>
  new MargoError('unsupported', `${what} is not in the own solver yet; use @margoengine/physics.`);

/** A collider on a {@link PhysicsBody}: what `body.colliders` hands you. */
export class PhysicsCollider {
  private removed = false;
  /** @internal */
  constructor(
    private readonly kernel: KernelWorld,
    /** The number that names this collider in its world, for use as a key. */
    readonly handle: number,
    /** The body this collider belongs to. */
    readonly body: PhysicsBody,
    /** What it is, as named in its options. */
    readonly shape: ColliderShape,
  ) {}
  /** False once the collider or its body was removed. */
  get valid(): boolean {
    return !this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  private columns(): KernelWorld['columns'] {
    if (this.removed) throw new MargoError('state', 'Collider was removed; add a new one with body.addCollider.');
    return this.kernel.columns;
  }
  /** Radius of a sphere around {@link PhysicsCollider.translationWrtParent} that holds the shape. */
  get boundingRadius(): number {
    const { colliderA, colliderB, colliderC } = this.columns(),
      a = this.handle;
    if (this.shape === 'box') return Math.hypot(colliderA[a], colliderB[a], colliderC[a]);
    return this.shape === 'capsule' ? colliderA[a] + colliderB[a] : colliderA[a];
  }
  isSensor(): boolean {
    this.columns();
    return false;
  }
  isEnabled(): boolean {
    this.columns();
    return true;
  }
  density(): number {
    return this.columns().colliderDensity[this.handle];
  }
  /** Centre in its body's frame. */
  translationWrtParent(): { x: number; y: number; z: number } {
    const { colliderX, colliderY, colliderZ } = this.columns(),
      a = this.handle;
    return { x: colliderX[a], y: colliderY[a], z: colliderZ[a] };
  }
  /** Rotation in its body's frame. */
  rotationWrtParent(): { x: number; y: number; z: number; w: number } {
    const { colliderRotationX, colliderRotationY, colliderRotationZ, colliderRotationW } = this.columns(),
      a = this.handle;
    return { x: colliderRotationX[a], y: colliderRotationY[a], z: colliderRotationZ[a], w: colliderRotationW[a] };
  }
  /** Half sizes of a box, null on any other shape. */
  halfExtents(): { x: number; y: number; z: number } | null {
    const { colliderA, colliderB, colliderC } = this.columns(),
      a = this.handle;
    return this.shape === 'box' ? { x: colliderA[a], y: colliderB[a], z: colliderC[a] } : null;
  }
  /** Radius of a sphere or capsule. */
  radius(): number {
    return this.columns().colliderA[this.handle];
  }
  /** Half the length along Y of a capsule. */
  halfHeight(): number {
    return this.columns().colliderB[this.handle];
  }
  friction(): number {
    return this.columns().colliderFriction[this.handle];
  }
  /**
   * Sets the friction from the next step on, and wakes the body, as a sleeper would stay on a slope it can no longer hold.
   * @throws RangeError unless `friction` is finite and not negative.
   */
  setFriction(friction: number): this {
    if (!(friction >= 0) || !Number.isFinite(friction))
      throw new RangeError(`Friction must be finite and not negative; 0.5 is a common start (got ${friction}).`);
    this.columns().colliderFriction[this.handle] = friction;
    this.wake();
    return this;
  }
  restitution(): number {
    return this.columns().colliderRestitution[this.handle];
  }
  /**
   * Sets the restitution from the next step on.
   * @throws RangeError unless `restitution` is from 0 to 1.
   */
  setRestitution(restitution: number): this {
    if (!(restitution >= 0 && restitution <= 1))
      throw new RangeError(`Restitution must be from 0 to 1, as a contact cannot give back more than it took (got ${restitution}).`);
    this.columns().colliderRestitution[this.handle] = restitution;
    this.wake();
    return this;
  }
  private wake(): void {
    if (this.body.type === 'dynamic') this.kernel.wake(this.body.row);
  }
  /** Not served yet: throws. */
  collisionGroups(): never {
    throw notYet('collisionGroups');
  }
  /** Not served yet: throws. */
  solverGroups(): never {
    throw notYet('solverGroups');
  }
}
