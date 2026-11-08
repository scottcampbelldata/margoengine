// A collider of the own solver. Reads only, so it may use `Math`: nothing here can change a step.
import { MargoError } from '@margoengine/math/errors';
import { COLLIDER_OFF, COLLIDER_SENSOR, type KernelWorld } from '../kernel.js';
import type { ColliderShape } from '../collider.js';
import type { PhysicsBody } from './body.js';

/** A cell coordinate, checked: a whole number in 32 bits. */
function cell(value: number): number {
  if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31)
    throw new RangeError(`A voxel cell coordinate is a whole number in 32 bits (got ${value}); pass cell numbers, not metres.`);
  return value;
}

/** A collider on a {@link PhysicsBody}: what `body.colliders` hands you. */
export class PhysicsCollider {
  private removed = false;
  /** @internal Whether this collider asks for contact and intersection events: a pair says so when either side does. */
  emits = true;
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
  /**
   * Radius of a sphere around {@link PhysicsCollider.translationWrtParent} that holds the shape: the radius of a sphere, the
   * reach of a capsule, the corner distance of a box, the rim's distance of a cylinder or cone plus its border. Null for the
   * other shapes, which would have to walk their geometry, as on the Rapier entry.
   */
  get boundingRadius(): number | null {
    const { colliderA, colliderB, colliderC } = this.columns(),
      a = this.handle;
    if (this.shape === 'box') return Math.hypot(colliderA[a], colliderB[a], colliderC[a]);
    if (this.shape === 'capsule') return colliderA[a] + colliderB[a];
    if (this.shape === 'cylinder' || this.shape === 'cone') return Math.hypot(colliderA[a], colliderB[a]) + colliderC[a];
    return this.shape === 'sphere' ? colliderA[a] : null;
  }
  isSensor(): boolean {
    return (this.columns().colliderFlags[this.handle] & COLLIDER_SENSOR) !== 0;
  }
  /** A sensor sees overlaps and pushes nothing. What it touched ends as what it was, and starts again as what it is. */
  setSensor(sensor: boolean): this {
    this.setBit(COLLIDER_SENSOR, sensor);
    return this;
  }
  isEnabled(): boolean {
    return (this.columns().colliderFlags[this.handle] & COLLIDER_OFF) === 0;
  }
  /** A disabled collider touches nothing; it keeps its place on the body, and its mass. */
  setEnabled(enabled: boolean): this {
    this.setBit(COLLIDER_OFF, !enabled);
    return this;
  }
  private setBit(bit: number, on: boolean): void {
    const flags = this.columns().colliderFlags[this.handle];
    this.kernel.setColliderState(this.handle, on ? flags | bit : flags & ~bit);
  }
  density(): number {
    return this.columns().colliderDensity[this.handle];
  }
  /** Kilograms a cubic metre; the body's mass, centre and inertia are worked out again at once. */
  setDensity(density: number): this {
    if (!(density >= 0) || density === Infinity)
      throw new RangeError('Collider density must be a finite number of at least 0; pass kilograms a cubic metre.');
    this.columns().colliderDensity[this.handle] = density;
    this.kernel.updateMass(this.body.row);
    return this;
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
  /** Radius of a sphere, capsule, cylinder or cone. */
  radius(): number {
    return this.columns().colliderA[this.handle];
  }
  /** Half the length along Y of a capsule, cylinder or cone. */
  halfHeight(): number {
    return this.columns().colliderB[this.handle];
  }
  /** Border radius of a cylinder or cone, 0 for a sharp one (Rapier's `roundRadius`). */
  borderRadius(): number {
    return this.shape === 'cylinder' || this.shape === 'cone' ? this.columns().colliderC[this.handle] : 0;
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
  collisionGroups(): number {
    return this.columns().colliderGroups[this.handle];
  }
  /** Packed interaction groups, see `collisionGroups` from this package. */
  setCollisionGroups(groups: number): this {
    this.columns().colliderGroups[this.handle] = groups;
    this.reach();
    return this;
  }
  solverGroups(): number {
    return this.columns().colliderSolverGroups[this.handle];
  }
  /** Packed solver groups: pairs whose groups do not meet are detected and fire events, and are not solved. */
  setSolverGroups(groups: number): this {
    this.columns().colliderSolverGroups[this.handle] = groups;
    this.reach();
    return this;
  }
  /**
   * `voxels` shape: fills or empties cell (x, y, z) in place, growing the grid for a cell outside it, and keeps the
   * contacts of every other cell. A dynamic body's mass follows at once (Rapier's follows at the next step).
   * @throws RangeError for a cell that is not three whole numbers, or on another shape.
   */
  setVoxel(x: number, y: number, z: number, filled: boolean): this {
    this.columns();
    this.kernel.setVoxel(this.handle, cell(x), cell(y), cell(z), filled);
    return this;
  }
  /**
   * `voxels` shape: makes this grid and `other` aware of each other's cells along their shared border, so a body crosses
   * it without catching on the seam. `sx`, `sy` and `sz` are the cells `other` is shifted by.
   */
  combineVoxelStates(other: PhysicsCollider, sx = 0, sy = 0, sz = 0): this {
    this.columns();
    other.columns();
    this.kernel.combineVoxels(this.handle, other.handle, [cell(sx), cell(sy), cell(sz)]);
    return this;
  }
  /** `voxels` shape: tells a coupled neighbour that cell (x, y, z) of this grid changed. */
  propagateVoxelChange(other: PhysicsCollider, x: number, y: number, z: number, sx = 0, sy = 0, sz = 0): this {
    this.columns();
    other.columns();
    this.kernel.propagateVoxel(this.handle, other.handle, [cell(x), cell(y), cell(z)], [cell(sx), cell(sy), cell(sz)]);
    return this;
  }
  private reach(): void {
    this.kernel.touchCollider(this.handle);
    this.wake();
  }
}
