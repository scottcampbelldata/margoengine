import { MargoError } from '@margoengine/math/errors';
import type { Collider, Rotation, Vector } from './rapier-types.js';
import type { PhysicsBody } from './body.js';
import type { ShapeOptions } from './shapes.js';

/** What a collider is: the `shape` of its options, or `custom` for a hand-built one this package cannot name. */
export type ColliderShape = ShapeOptions['shape'];

/** A collider on a {@link PhysicsBody}: what `body.colliders`, events and query hits hand you. */
export class PhysicsCollider {
  private removed = false;
  /** @internal */
  constructor(
    /** @internal */
    readonly raw: Collider,
    /** The body this collider belongs to. */
    readonly body: PhysicsBody,
    /** What it is, as named in its options. */
    readonly shape: ColliderShape,
  ) {}
  /** The number that names this collider in its world, for use as a key. */
  get handle(): number {
    return this.raw.handle;
  }
  /** False once the collider or its body was removed. */
  get valid(): boolean {
    return !this.removed;
  }
  /** @internal */
  markRemoved(): void {
    this.removed = true;
  }
  private check(): Collider {
    if (this.removed) throw new MargoError('state', 'Collider was removed; add a new one with body.addCollider.');
    return this.raw;
  }

  /**
   * Radius of a sphere around {@link PhysicsCollider.translationWrtParent} that holds the shape: exact for a sphere, the
   * corner distance of a box, capsule, cylinder or cone. Null for the other shapes, which would have to walk their
   * geometry.
   */
  get boundingRadius(): number | null {
    const raw = this.check();
    switch (this.shape) {
      case 'sphere':
        return raw.radius();
      case 'capsule':
        return raw.halfHeight() + raw.radius();
      case 'cylinder':
      case 'cone':
        return Math.hypot(raw.halfHeight(), raw.radius()) + (raw.roundRadius() ?? 0);
      case 'box': {
        const half = raw.halfExtents();
        return half && Math.hypot(half.x, half.y, half.z);
      }
      default:
        return null;
    }
  }

  isSensor(): boolean {
    return this.check().isSensor();
  }
  setSensor(sensor: boolean): this {
    this.check().setSensor(sensor);
    return this;
  }
  isEnabled(): boolean {
    return this.check().isEnabled();
  }
  /** A disabled collider touches nothing and is skipped by queries; it keeps its place on the body. */
  setEnabled(enabled: boolean): this {
    this.check().setEnabled(enabled);
    return this;
  }
  friction(): number {
    return this.check().friction();
  }
  setFriction(friction: number): this {
    this.check().setFriction(friction);
    return this;
  }
  restitution(): number {
    return this.check().restitution();
  }
  setRestitution(restitution: number): this {
    this.check().setRestitution(restitution);
    return this;
  }
  density(): number {
    return this.check().density();
  }
  setDensity(density: number): this {
    this.check().setDensity(density);
    return this;
  }
  mass(): number {
    return this.check().mass();
  }
  collisionGroups(): number {
    return this.check().collisionGroups();
  }
  /** Packed interaction groups, see `collisionGroups` from this package. */
  setCollisionGroups(groups: number): this {
    this.check().setCollisionGroups(groups);
    return this;
  }
  solverGroups(): number {
    return this.check().solverGroups();
  }
  setSolverGroups(groups: number): this {
    this.check().setSolverGroups(groups);
    return this;
  }

  /** Centre in world space. */
  translation(): Vector {
    return this.check().translation();
  }
  /** Rotation in world space. */
  rotation(): Rotation {
    return this.check().rotation();
  }
  /** Centre in its body's frame; null on a collider without a body. */
  translationWrtParent(): Vector | null {
    return this.check().translationWrtParent();
  }
  rotationWrtParent(): Rotation | null {
    return this.check().rotationWrtParent();
  }
  /** Half sizes of a box, null on any other shape. */
  halfExtents(): Vector | null {
    return this.check().halfExtents();
  }
  /** Radius of a sphere, capsule, cylinder or cone. */
  radius(): number {
    return this.check().radius();
  }
  /** Half the length along Y of a capsule, cylinder or cone. */
  halfHeight(): number {
    return this.check().halfHeight();
  }
  /** Border radius of a cylinder or cone, 0 for a sharp one (Rapier's `roundRadius`). */
  borderRadius(): number {
    return this.check().roundRadius() ?? 0;
  }
  /** Packed xyz positions of a trimesh or convex hull. */
  vertices(): Float32Array {
    return this.check().vertices();
  }
  /** Triangle indices of a trimesh. */
  indices(): Uint32Array | undefined {
    return this.check().indices();
  }
  /** Whether a world-space point is inside the shape. */
  containsPoint(point: Vector): boolean {
    return this.check().containsPoint(point);
  }

  /** `voxels` shape: fills or empties one cell in place, keeping the contacts of everything else. */
  setVoxel(x: number, y: number, z: number, filled: boolean): this {
    this.check().setVoxel(x, y, z, filled);
    return this;
  }
  /**
   * `voxels` shape: makes this grid and `other` aware of each other's cells along their shared border, so a body
   * crosses it without catching on the seam. `sx`, `sy` and `sz` are the cells `other` is shifted by.
   */
  combineVoxelStates(other: PhysicsCollider, sx = 0, sy = 0, sz = 0): this {
    this.check().combineVoxelStates(other.check(), sx, sy, sz);
    return this;
  }
  /** `voxels` shape: tells a coupled neighbour that cell (x, y, z) of this grid changed. */
  propagateVoxelChange(other: PhysicsCollider, x: number, y: number, z: number, sx = 0, sy = 0, sz = 0): this {
    this.check().propagateVoxelChange(other.check(), x, y, z, sx, sy, sz);
    return this;
  }
}
