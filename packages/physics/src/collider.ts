// A collider of the own solver. Reads only, so it may use `Math`: nothing here can change a step.
import { MargoError } from '@margoengine/math/errors';
import {
  COLLIDER_MODIFY,
  COLLIDER_NO_CONTACT_FILTER,
  COLLIDER_NO_INTERSECTION_FILTER,
  COLLIDER_OFF,
  COLLIDER_SENSOR,
  COLLIDER_TYPES,
  COLLIDER_TYPES_SHIFT,
  QUERY_NO_GROUPS,
  type KernelWorld,
  combineBits,
  combineRule,
  combines,
} from './kernel.js';
import type { CollisionPairKind, CombineRule, ColliderOptions, InteractionGroups, ShapeOptions } from './shapes.js';
import { readGroups, writeGroups } from './groups.js';
import { meshConnectedComponents, meshHalfEdges, type HalfEdgeTopology } from './mesh-tools.js';
import { checkVec, type Quat, type Vec3 } from './math.js';
import type { PhysicsBody } from './body.js';

/** What a collider is, as named in its options. */
export type ColliderShape = ShapeOptions['shape'];
/** A cell coordinate, checked: a whole number in 32 bits. */
function cell(value: number): number {
  if (!Number.isInteger(value) || value < -(2 ** 31) || value >= 2 ** 31)
    throw new RangeError(
      `A voxel cell coordinate is a whole number in 32 bits (got ${value}); pass cell numbers, not metres.`,
    );
  return value;
}

const COMBINES: readonly CombineRule[] = combines;
const PAIR_KINDS: readonly CollisionPairKind[] = [
  'dynamicDynamic',
  'dynamicKinematic',
  'dynamicFixed',
  'kinematicKinematic',
  'kinematicFixed',
  'fixedFixed',
];
/** The bits a kernel collider holds for the kinds it takes part in: each one that differs from the default. */
export function pairKindBits(kinds: readonly CollisionPairKind[]): number {
  let wanted = 0;
  for (const kind of kinds) {
    const at = PAIR_KINDS.indexOf(kind);
    if (at < 0)
      throw new RangeError(
        `Unknown collision pair kind ${String(kind)}; use dynamicDynamic, dynamicKinematic, dynamicFixed, kinematicKinematic, kinematicFixed or fixedFixed.`,
      );
    wanted |= 1 << at;
  }
  return ((wanted ^ 7) << COLLIDER_TYPES_SHIFT) & COLLIDER_TYPES;
}

/** Product of two quaternions [x, y, z, w]: `b` first, then `a`. */
function multiplyQuat(a: Quat, b: Quat): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/** A vector turned by a unit quaternion. */
function rotateByQuat(q: Quat, v: Vec3): [number, number, number] {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]),
    ty = 2 * (q[2] * v[0] - q[0] * v[2]),
    tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + (q[1] * tz - q[2] * ty),
    v[1] + q[3] * ty + (q[2] * tx - q[0] * tz),
    v[2] + q[3] * tz + (q[0] * ty - q[1] * tx),
  ];
}

/** A collider on a {@link PhysicsBody}: what `body.colliders` hands you. */
export class PhysicsCollider {
  private removed = false;
  /** Anything you want to find again from an event, a query or a contact: the `userData` option, free to change. */
  userData: unknown;
  /** @internal Whether this collider asks for contact and intersection events: a pair says so when either side does. */
  emits = true;
  /** @internal Whether this collider asks for contact-force events, and the force in newtons a pair must pass. */
  forceEvents = true;
  /** @internal */
  forceThreshold = 0;
  /** @internal The points (and indices) of a convex hull or triangle mesh. */
  data?: { vertices: Float32Array; indices?: Uint32Array; reads?: { components: boolean; halfEdges: boolean } };
  /** @internal */
  constructor(
    private readonly kernel: KernelWorld,
    /** The number that names this collider in its world, for use as a key. */
    readonly handle: number,
    /** The body this collider belongs to. */
    readonly body: PhysicsBody,
    /** What it is, as named in its options. */
    public shape: ColliderShape,
  ) {}
  /** @internal Set by the world: rebuilds this collider's shape from options. */
  reshape: ((options: ColliderOptions) => void) | null = null;
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
    if (this.shape === 'cylinder' || this.shape === 'cone')
      return Math.hypot(colliderA[a], colliderB[a]) + colliderC[a];
    return this.shape === 'sphere' ? colliderA[a] : null;
  }
  /**
   * The box of the collider's shape at its body's pose as of the last step, tight and with no margin: `{min, max}`. A
   * half space is as large as the world.
   */
  aabb(): { min: [number, number, number]; max: [number, number, number] } {
    this.columns();
    const box = this.kernel.colliderAabb(this.handle);
    if (!box) throw new MargoError('state', 'Collider is not in the world yet; step the world once after adding it.');
    return { min: box[0], max: box[1] };
  }
  /**
   * The box that holds the collider's shape now and at the world pose `nextPosition` and `nextRotation` (default: the pose it
   * has), as Rapier's `compute_swept_aabb`: the two tight boxes merged. A shape's box between the two poses can be larger than
   * this when it turns on the way; the box of a straight move is exact.
   * @throws RangeError for a position or rotation that is not finite, or a rotation that is not a unit quaternion.
   * @throws MargoError (`state`) for a collider not in the world yet.
   */
  sweptAabb(nextPosition: Vec3, nextRotation?: Quat): { min: [number, number, number]; max: [number, number, number] } {
    checkVec(nextPosition, 'Next position');
    const c = this.columns(),
      h = this.handle,
      now = this.aabb(),
      body = this.body.row,
      localQ: Quat = [
        c.colliderRotationX[h]!,
        c.colliderRotationY[h]!,
        c.colliderRotationZ[h]!,
        c.colliderRotationW[h]!,
      ],
      localP: Vec3 = [c.colliderX[h]!, c.colliderY[h]!, c.colliderZ[h]!],
      current: Quat = [c.rotationX[body]!, c.rotationY[body]!, c.rotationZ[body]!, c.rotationW[body]!],
      worldQ = nextRotation ?? multiplyQuat(current, localQ);
    if (worldQ.length !== 4 || !worldQ.every(Number.isFinite) || Math.abs(Math.hypot(...worldQ) - 1) > 1e-3)
      throw new RangeError('The next rotation is a unit quaternion [x, y, z, w]; pass one.');
    // The body's pose that puts the collider at the given pose: its turn is the collider's less the collider's own, and its
    // place the collider's less the collider's offset turned by it.
    const bodyQ = multiplyQuat(worldQ, [-localQ[0], -localQ[1], -localQ[2], localQ[3]]),
      offset = rotateByQuat(bodyQ, localP),
      next = this.kernel.colliderAabbAt(
        h,
        [nextPosition[0] - offset[0], nextPosition[1] - offset[1], nextPosition[2] - offset[2]],
        bodyQ,
      );
    if (!next) throw new MargoError('state', 'Collider is not in the world yet; step the world once after adding it.');
    return {
      min: [Math.min(now.min[0], next[0][0]), Math.min(now.min[1], next[0][1]), Math.min(now.min[2], next[0][2])],
      max: [Math.max(now.max[0], next[1][0]), Math.max(now.max[1], next[1][1]), Math.max(now.max[2], next[1][2])],
    };
  }
  /**
   * The box the collider is held in for contacts, as Rapier's `compute_collision_aabb`: its box (which already holds the contact
   * skin, as the shape is that much thicker) grown on every side by `prediction` (default the world's prediction distance).
   * @throws RangeError for a prediction that is negative or not finite.
   * @throws MargoError (`state`) for a collider not in the world yet.
   */
  collisionAabb(prediction?: number): { min: [number, number, number]; max: [number, number, number] } {
    const margin = prediction ?? this.kernel.predictionDistance;
    if (!(margin >= 0) || !Number.isFinite(margin))
      throw new RangeError(`A prediction is 0 or more metres and finite (got ${prediction}); pass a few centimetres.`);
    const { min, max } = this.aabb();
    return {
      min: [min[0] - margin, min[1] - margin, min[2] - margin],
      max: [max[0] + margin, max[1] + margin, max[2] + margin],
    };
  }
  /**
   * Gives the collider another shape, with its offset and rotation in the body's frame as `options` say (zero and none when
   * it leaves them out). Friction, groups, events and the other settings stay. What it touched ends, and the body's mass is
   * worked out again from its density (`mass` or `density` in `options` replaces it). A compound cannot be made or changed
   * this way: remove the collider and add one.
   * @throws MargoError (`unsupported`, `state`) for a shape the solver does not hold or a collider that was removed.
   */
  setShape(options: ColliderOptions): this {
    this.columns();
    if (!this.reshape) throw new MargoError('state', 'This collider cannot change shape; remove it and add another.');
    this.reshape(options);
    return this;
  }
  /**
   * Sets the radius of a sphere, capsule, cylinder or cone, keeping the rest of its shape and its place in the body (Rapier's
   * `setRadius`); the body's mass is worked out again.
   * @throws RangeError for a radius that is not positive and finite, or a shape that has none.
   */
  setRadius(radius: number): this {
    return this.resize('radius', radius);
  }
  /** Sets the half height of a capsule, cylinder or cone, as {@link PhysicsCollider.setRadius} (Rapier's `setHalfHeight`). */
  setHalfHeight(halfHeight: number): this {
    return this.resize('halfHeight', halfHeight);
  }
  /** Sets the half extents of a box, keeping its border radius and its place in the body (Rapier's `setHalfExtents`). */
  setHalfExtents(halfExtents: Vec3): this {
    checkVec(halfExtents, 'Half extents');
    if (this.shape !== 'box' || !(halfExtents[0] > 0 && halfExtents[1] > 0 && halfExtents[2] > 0))
      throw new RangeError(
        `setHalfExtents takes three positive numbers and a box collider (this is a ${this.shape}); pass [x, y, z].`,
      );
    return this.setShape({ shape: 'box', halfExtents, borderRadius: this.borderRadius(), ...this.placement() });
  }
  private placement(): { offset: Vec3; rotation: [number, number, number, number] } {
    const t = this.translationWrtParent(),
      q = this.rotationWrtParent();
    return { offset: [t.x, t.y, t.z], rotation: [q.x, q.y, q.z, q.w] };
  }
  private resize(what: 'radius' | 'halfHeight', value: number): this {
    if (!(value > 0) || !Number.isFinite(value))
      throw new RangeError(
        `A ${what === 'radius' ? 'radius' : 'half height'} is positive and finite (got ${value}); pass a size in metres.`,
      );
    const place = this.placement();
    switch (this.shape) {
      case 'sphere':
        if (what === 'radius') return this.setShape({ shape: 'sphere', radius: value, ...place });
        break;
      case 'capsule':
        return this.setShape({
          shape: 'capsule',
          halfHeight: what === 'halfHeight' ? value : this.halfHeight(),
          radius: what === 'radius' ? value : this.radius(),
          ...place,
        });
      case 'cylinder':
      case 'cone':
        return this.setShape({
          shape: this.shape,
          halfHeight: what === 'halfHeight' ? value : this.halfHeight(),
          radius: what === 'radius' ? value : this.radius(),
          borderRadius: this.borderRadius(),
          ...place,
        });
    }
    throw new RangeError(
      `A ${this.shape} collider has no ${what === 'radius' ? 'radius' : 'half height'} to set; use setShape.`,
    );
  }
  /** Moves the collider in its body's frame, and works the body's mass out again. */
  setTranslationWrtParent(position: Vec3): this {
    checkVec(position, 'Collider position');
    const c = this.columns(),
      h = this.handle;
    this.kernel.setColliderPose(h, position, [
      c.colliderRotationX[h],
      c.colliderRotationY[h],
      c.colliderRotationZ[h],
      c.colliderRotationW[h],
    ]);
    return this;
  }
  /** Turns the collider in its body's frame by a unit quaternion [x, y, z, w], and works the body's mass out again. */
  setRotationWrtParent(rotation: Quat): this {
    const c = this.columns(),
      h = this.handle;
    this.kernel.setColliderPose(h, [c.colliderX[h], c.colliderY[h], c.colliderZ[h]], rotation);
    return this;
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
  /** The skin in metres around the collider's shape (default 0). */
  contactSkin(): number {
    return this.columns().colliderSkin[this.handle];
  }
  /**
   * Sets the skin: contacts are made and solved as if the shape were this much thicker; two colliders' skins add up. It
   * takes effect at the next step.
   * @throws RangeError for a skin that is negative or not finite.
   */
  setContactSkin(skin: number): this {
    if (!(skin >= 0) || !Number.isFinite(skin))
      throw new RangeError(
        `A contact skin is 0 or more metres and finite (got ${skin}); pass a few centimetres, such as 0.01.`,
      );
    this.columns().colliderSkin[this.handle] = skin;
    this.wake();
    return this;
  }
  /**
   * Which hooks involve this collider, as Rapier's `activeHooks`: `filterContactPairs` and `filterIntersectionPairs` (the
   * world's `contactFilter` is asked about solid pairs, and about pairs with a sensor, when either collider has the
   * flag; both on by default) and `modifyContacts` (off by default).
   */
  activeHooks(): { filterContactPairs: boolean; filterIntersectionPairs: boolean; modifyContacts: boolean } {
    const flags = this.columns().colliderFlags[this.handle];
    return {
      filterContactPairs: (flags & COLLIDER_NO_CONTACT_FILTER) === 0,
      filterIntersectionPairs: (flags & COLLIDER_NO_INTERSECTION_FILTER) === 0,
      modifyContacts: (flags & COLLIDER_MODIFY) !== 0,
    };
  }
  /** Chooses the hooks that involve this collider; what it touched ends and starts again as it is now. */
  setActiveHooks(hooks: {
    filterContactPairs?: boolean;
    filterIntersectionPairs?: boolean;
    modifyContacts?: boolean;
  }): this {
    const was = this.activeHooks(),
      next = { ...was, ...hooks };
    let flags =
      this.columns().colliderFlags[this.handle] &
      ~(COLLIDER_NO_CONTACT_FILTER | COLLIDER_NO_INTERSECTION_FILTER | COLLIDER_MODIFY);
    if (!next.filterContactPairs) flags |= COLLIDER_NO_CONTACT_FILTER;
    if (!next.filterIntersectionPairs) flags |= COLLIDER_NO_INTERSECTION_FILTER;
    if (next.modifyContacts) flags |= COLLIDER_MODIFY;
    this.kernel.setColliderState(this.handle, flags);
    return this;
  }
  /** The kinds of body pair this collider takes part in. */
  activeCollisionTypes(): CollisionPairKind[] {
    const wanted = ((this.columns().colliderFlags[this.handle] & COLLIDER_TYPES) >>> COLLIDER_TYPES_SHIFT) ^ 7;
    return PAIR_KINDS.filter((_, at) => wanted & (1 << at));
  }
  /**
   * Sets the kinds of body pair this collider takes part in (default dynamic with anything). A pair of colliders is made
   * when both want its kind, so `kinematicKinematic` and `fixedFixed` need both colliders to name them. What touched ends,
   * and what overlaps now starts again.
   */
  setActiveCollisionTypes(kinds: readonly CollisionPairKind[]): this {
    const flags = this.columns().colliderFlags[this.handle];
    this.kernel.setColliderState(this.handle, (flags & ~COLLIDER_TYPES) | pairKindBits(kinds));
    return this;
  }
  /** Which events this collider asks for: contact and intersection starts and ends, and contact forces. */
  activeEvents(): { collision: boolean; contactForce: boolean } {
    return { collision: this.emits, contactForce: this.forceEvents };
  }
  /** Chooses the events this collider asks for. A pair speaks when either of its colliders asks. */
  setActiveEvents(events: { collision?: boolean; contactForce?: boolean }): this {
    this.emits = events.collision ?? this.emits;
    this.forceEvents = events.contactForce ?? this.forceEvents;
    return this;
  }
  /** The force in newtons a pair needs to pass before a contact-force event is made (default 0). */
  contactForceEventThreshold(): number {
    return this.forceThreshold;
  }
  /**
   * Sets the force in newtons a pair needs to pass before a contact-force event is made. A pair uses the larger of its two
   * colliders' thresholds.
   * @throws RangeError for a threshold that is negative or not a number.
   */
  setContactForceEventThreshold(threshold: number): this {
    if (!(threshold >= 0))
      throw new RangeError(
        `A contact force threshold is 0 or more newtons (got ${threshold}); pass 0 for every contact or a force such as 10.`,
      );
    this.forceThreshold = threshold;
    return this;
  }
  private setBit(bit: number, on: boolean): void {
    const flags = this.columns().colliderFlags[this.handle];
    this.kernel.setColliderState(this.handle, on ? flags | bit : flags & ~bit);
  }
  /** Centre in world space. */
  translation(): { x: number; y: number; z: number } {
    const local = this.translationWrtParent(),
      p = this.body.position,
      o = rotateBy(this.body.rotation, local.x, local.y, local.z);
    return { x: p[0] + o[0], y: p[1] + o[1], z: p[2] + o[2] };
  }
  /** Rotation in world space. */
  rotation(): { x: number; y: number; z: number; w: number } {
    const a = this.body.rotation,
      b = this.rotationWrtParent(),
      q = [
        a[3] * b.x + a[0] * b.w + a[1] * b.z - a[2] * b.y,
        a[3] * b.y - a[0] * b.z + a[1] * b.w + a[2] * b.x,
        a[3] * b.z + a[0] * b.y - a[1] * b.x + a[2] * b.w,
        a[3] * b.w - a[0] * b.x - a[1] * b.y - a[2] * b.z,
      ];
    return { x: q[0]!, y: q[1]!, z: q[2]!, w: q[3]! };
  }
  /** Packed xyz positions of a trimesh or convex hull, in the collider's frame. */
  vertices(): Float32Array {
    if (!this.data)
      throw new MargoError('state', `A ${this.shape} collider holds no vertices; ask a trimesh or convexHull.`);
    const columns = this.columns(),
      mesh = columns.colliderHull[this.handle]!;
    // A deformable mesh's vertices are the kernel's, as the last step landed them.
    if (this.shape === 'trimesh' && columns.meshFlags[mesh]! & 8) {
      const count = columns.meshVertices[mesh]!,
        first = columns.meshFirstVertex[mesh]!,
        out = new Float32Array(3 * count);
      for (let i = 0; i < count; i++) {
        out[3 * i] = columns.meshVertexX[first + i]!;
        out[3 * i + 1] = columns.meshVertexY[first + i]!;
        out[3 * i + 2] = columns.meshVertexZ[first + i]!;
      }
      return out;
    }
    return this.data.vertices;
  }
  /**
   * Moves the vertices of a `deformable` trimesh to these packed xyz positions (in the collider's frame, as many as it has),
   * as a kinematic body goes to its target: the next step makes its contacts against the surface where it is, each vertex
   * moving at its velocity, so friction carries what lies on it, bounce and the push count its speed, and a surface that
   * moves through a body faster than its radius a step still catches it; the end of that step lands the mesh on these
   * positions with one refit of its tree (every node once, no rebuild), and what rests on it wakes. Call it between steps,
   * as often as every step; queries and `vertices()` see the new positions once the step has run.
   *
   * `velocities` (packed xyz, in the collider's frame, metres a second) are each vertex's velocity over that step; left
   * out, each is the vertex's displacement over the step. `now: true` instead moves the mesh at once, with no velocity (a
   * teleport: a refit, then queries see it): for building a mesh up between steps.
   * @throws RangeError for a count that is not the mesh's, or a position or velocity that is not finite.
   * @throws MargoError code `state` for a collider that is not a trimesh made with `deformable: true`.
   */
  setVertices(positions: ArrayLike<number>, options: { velocities?: ArrayLike<number>; now?: boolean } = {}): void {
    const columns = this.columns(),
      mesh = columns.colliderHull[this.handle]!;
    if (this.shape !== 'trimesh' || !this.data || (columns.meshFlags[mesh]! & 8) === 0)
      throw new MargoError(
        'state',
        `A ${this.shape} collider cannot move its vertices; make a trimesh with deformable: true.`,
      );
    const count = columns.meshVertices[mesh]!,
      first = columns.meshFirstVertex[mesh]!,
      { velocities, now = false } = options;
    if (positions.length !== 3 * count)
      throw new RangeError(
        `This mesh has ${count} vertices and setVertices got ${positions.length / 3}; pass one x, y, z per vertex.`,
      );
    if (velocities && velocities.length !== positions.length)
      throw new RangeError(
        `setVertices got ${velocities.length / 3} velocities for ${count} vertices; pass one x, y, z each.`,
      );
    const dt = this.kernel.stepSeconds,
      target = [columns.meshVertexX, columns.meshVertexY, columns.meshVertexZ],
      speed = (axis: number, i: number): number => (velocities ? velocities[3 * i + axis]! : 0);
    let farthest = 0;
    for (let i = 0; i < count; i++) {
      let d = 0;
      for (let axis = 0; axis < 3; axis++) {
        const p = positions[3 * i + axis]!,
          v = speed(axis, i);
        if (!Number.isFinite(p) || !Number.isFinite(v))
          throw new RangeError(`Vertex ${i} is not finite; pass finite numbers.`);
        const move = p - target[axis]![first + i]!;
        d += move * move;
      }
      if (d > farthest) farthest = d;
    }
    const reach = Math.sqrt(farthest);
    if (now) {
      for (let i = 0; i < count; i++)
        for (let axis = 0; axis < 3; axis++) target[axis]![first + i] = positions[3 * i + axis]!;
      this.kernel.refitCollider(this.handle, reach);
      return;
    }
    for (let i = 0; i < count; i++)
      for (let axis = 0; axis < 3; axis++) {
        const p = positions[3 * i + axis]!;
        target[axis]![first + count + i] = p;
        target[axis]![first + 2 * count + i] = velocities
          ? velocities[3 * i + axis]!
          : (p - target[axis]![first + i]!) / dt;
      }
    this.kernel.aimCollider(this.handle, reach);
  }
  /**
   * The connected components of a trimesh made with `connectedComponents: true` (Rapier's `CONNECTED_COMPONENTS`): one number a
   * triangle, and how many components. @throws MargoError (`state`) for a mesh made without the flag.
   */
  connectedComponents(): { component: Uint32Array; count: number } {
    if (!this.data?.reads?.components)
      throw new MargoError(
        'state',
        'This collider was not made with connectedComponents: true on a trimesh; add the option to read its components.',
      );
    return meshConnectedComponents(this.data.indices!);
  }
  /**
   * The half-edge topology of a trimesh made with `halfEdgeTopology: true` (Rapier's `HALF_EDGE_TOPOLOGY`): the vertex, twin,
   * next half edge and face of each of its three half edges a triangle. @throws MargoError (`state`) for a mesh made without it.
   */
  halfEdgeTopology(): HalfEdgeTopology {
    if (!this.data?.reads?.halfEdges)
      throw new MargoError(
        'state',
        'This collider was not made with halfEdgeTopology: true on a trimesh; add the option to read its half edges.',
      );
    return meshHalfEdges(this.data.indices!);
  }
  /** Triangle indices of a trimesh. */
  indices(): Uint32Array | undefined {
    return this.data?.indices;
  }
  /** Whether a world-space point is inside the shape; a trimesh or height field holds no point. */
  containsPoint(point: { x: number; y: number; z: number }): boolean {
    this.columns();
    return this.kernel
      .intersectPoint([point.x, point.y, point.z], QUERY_NO_GROUPS, 0xffffffff, 0xffffffff, 0xffffffff)
      .includes(this.handle);
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
  /** Border radius of a box, hull, triangle, cylinder or cone, 0 for a sharp one (Rapier's `roundRadius`). */
  borderRadius(): number {
    const c = this.columns();
    return this.shape === 'cylinder' || this.shape === 'cone'
      ? c.colliderC[this.handle]
      : c.colliderBorder[this.handle];
  }
  /**
   * Sets the border radius of a box, convex hull, triangle, cylinder or cone (Rapier's `setRoundRadius`); what it touched
   * ends and the body's mass is worked out again.
   * @throws RangeError for a border that is negative or not finite, or a shape that cannot have one.
   */
  setBorderRadius(border: number): this {
    if (!(border >= 0) || !Number.isFinite(border))
      throw new RangeError(`A border radius is 0 or more and finite (got ${border}); pass 0 for a sharp edge.`);
    const c = this.columns(),
      h = this.handle;
    if (this.shape === 'cylinder' || this.shape === 'cone')
      this.kernel.setColliderShape(h, this.shape, [c.colliderA[h], c.colliderB[h], border]);
    else if (this.shape === 'box' || this.shape === 'convexHull' || this.shape === 'triangle') {
      const before = c.colliderBorder[h];
      this.kernel.setColliderBorder(h, border);
      // A round triangle meets what it touches through a skin of its border.
      if (this.shape === 'triangle') this.setContactSkin(c.colliderSkin[h] - before + border);
    } else
      throw new RangeError(`A ${this.shape} has no border radius; use a box, convexHull, triangle, cylinder or cone.`);
    return this;
  }
  /**
   * Gives the collider mass properties of its own in place of its shape's at its density (Rapier's `setMassProperties`): a
   * mass in kilograms, the centre of mass in the collider's frame, the principal moments of inertia about it and the turn of
   * their axes (default none). The body's mass, centre and inertia are worked out again.
   * @throws RangeError for numbers that cannot be a body's.
   */
  setMassProperties(mass: number, centerOfMass: Vec3, principalInertia: Vec3, inertiaFrame: Quat = [0, 0, 0, 1]): this {
    checkVec(centerOfMass, 'Centre of mass');
    checkVec(principalInertia, 'Principal inertia');
    if (!(mass >= 0) || !Number.isFinite(mass))
      throw new RangeError(`A collider's mass properties need a mass of 0 or more kilograms and finite (got ${mass}).`);
    this.columns();
    this.kernel.setColliderMassProperties(this.handle, mass, centerOfMass, principalInertia, inertiaFrame);
    return this;
  }
  /** Takes the collider's own mass properties off: the shape's at its density count again. */
  clearMassProperties(): this {
    this.columns();
    this.kernel.setColliderMassProperties(this.handle, null, [0, 0, 0], [0, 0, 0], [0, 0, 0, 1]);
    return this;
  }
  /** The volume of the shape in cubic metres, 0 for a surface. */
  volume(): number {
    this.columns();
    return this.kernel.colliderVolume(this.handle);
  }
  /** The mass the collider adds to its body, from its density: volume times density, in kilograms. */
  mass(): number {
    this.columns();
    return this.kernel.colliderMass(this.handle);
  }
  /**
   * Sets the mass by setting the density to mass over volume, so it stays in step with a change of shape; the body's mass,
   * centre and inertia are worked out again.
   * @throws RangeError for a mass that is negative or not finite, or a shape with no volume.
   */
  setMass(mass: number): this {
    if (!(mass >= 0) || !Number.isFinite(mass))
      throw new RangeError(`A collider mass is 0 or more kilograms and finite (got ${mass}); pass a number such as 1.`);
    const volume = this.volume();
    if (!(volume > 0))
      throw new RangeError(
        'A collider with no volume has no mass to set; give the body its mass with setMassProperties.',
      );
    return this.setDensity(mass / volume);
  }
  /** The friction combine rule: how this collider's friction mixes with another's (default 'average'; the higher rule of the two decides). */
  frictionCombineRule(): CombineRule {
    return COMBINES[combineRule(this.columns().colliderCombine[this.handle], false)]!;
  }
  /** Sets the friction combine rule, from the next step on. @throws RangeError for a name that is not a rule. */
  setFrictionCombineRule(rule: CombineRule): this {
    const c = this.columns(),
      at = COMBINES.indexOf(rule);
    if (at < 0)
      throw new RangeError(
        `Unknown combine rule ${String(rule)}; use average, min, multiply, max, clampedSum or geometricMean.`,
      );
    c.colliderCombine[this.handle] = combineBits(at, combineRule(c.colliderCombine[this.handle], true));
    this.wake();
    return this;
  }
  /** The restitution combine rule (default 'average'). */
  restitutionCombineRule(): CombineRule {
    return COMBINES[combineRule(this.columns().colliderCombine[this.handle], true)]!;
  }
  /** Sets the restitution combine rule, from the next step on. @throws RangeError for a name that is not a rule. */
  setRestitutionCombineRule(rule: CombineRule): this {
    const c = this.columns(),
      at = COMBINES.indexOf(rule);
    if (at < 0)
      throw new RangeError(
        `Unknown combine rule ${String(rule)}; use average, min, multiply, max, clampedSum or geometricMean.`,
      );
    c.colliderCombine[this.handle] = combineBits(combineRule(c.colliderCombine[this.handle], false), at);
    this.wake();
    return this;
  }
  /** A height field's cells along z. @throws RangeError for another shape. */
  heightfieldNRows(): number {
    return this.grid().rows;
  }
  /** A height field's cells along x. @throws RangeError for another shape. */
  heightfieldNCols(): number {
    return this.grid().columns;
  }
  /**
   * A height field's heights, column major as it was made (row r, column c at `r + (rows + 1) * c`), as scaled in its frame:
   * with `heightfieldScale()` of [width, 1, depth].
   * @throws RangeError for another shape.
   */
  heightfieldHeights(): Float32Array {
    const { rows, columns } = this.grid(),
      c = this.columns(),
      first = c.meshFirstVertex[c.colliderHull[this.handle]],
      out = new Float32Array((rows + 1) * (columns + 1));
    for (let i = 0; i < out.length; i++) out[i] = c.meshVertexY[first + i];
    return out;
  }
  /** A height field's scale as `[width, 1, depth]`: its heights are read already scaled. @throws RangeError for another shape. */
  heightfieldScale(): [number, number, number] {
    const { rows, columns } = this.grid(),
      c = this.columns(),
      first = c.meshFirstVertex[c.colliderHull[this.handle]],
      last = first + (rows + 1) * (columns + 1) - 1;
    return [c.meshVertexX[last] - c.meshVertexX[first], 1, c.meshVertexZ[last] - c.meshVertexZ[first]];
  }
  /**
   * A height field's cell status, a sum of {@link HeightfieldCell} bits: 0 for a plain cell, as Rapier's `cell_status`.
   * @throws RangeError for another shape, or a cell off the field.
   */
  cellStatus(row: number, column: number): number {
    this.cell(row, column);
    return this.kernel.cellStatus(this.handle, row, column);
  }
  /** Every cell's status, row r of column c at `r + rows * c`, as Rapier's `cells_statuses`. @throws RangeError for another shape. */
  cellStatuses(): Uint8Array {
    const { rows, columns } = this.grid(),
      out = new Uint8Array(rows * columns);
    for (let c = 0; c < columns; c++)
      for (let r = 0; r < rows; r++) out[r + rows * c] = this.kernel.cellStatus(this.handle, r, c);
    return out;
  }
  /**
   * Sets a height field's cell status in place, as Rapier's `set_cell_status`: add {@link HeightfieldCell} bits, `zigzag` to
   * split the cell along its other diagonal, `leftRemoved` and `rightRemoved` to make a hole. Contacts on a removed triangle
   * end and what rests on it wakes.
   * @throws RangeError for another shape, a cell off the field or a status that is not 0 to 7.
   */
  setCellStatus(row: number, column: number, status: number): this {
    this.cell(row, column);
    this.kernel.setCellStatus(this.handle, row, column, status);
    return this;
  }
  private cell(row: number, column: number): void {
    const { rows, columns } = this.grid();
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      column < 0 ||
      row >= rows ||
      column >= columns
    )
      throw new RangeError(
        `Cell (${row}, ${column}) is off this ${rows} by ${columns} height field; pass a row below ${rows} and a column below ${columns}.`,
      );
  }
  private grid(): { rows: number; columns: number } {
    if (this.shape !== 'heightfield') throw new RangeError(`A ${this.shape} is no height field; use a heightfield.`);
    const c = this.columns(),
      row = c.colliderHull[this.handle],
      columns = c.meshColumns[row];
    return { rows: c.meshVertices[row] / (columns + 1) - 1, columns };
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
      throw new RangeError(
        `Restitution must be from 0 to 1, as a contact cannot give back more than it took (got ${restitution}).`,
      );
    this.columns().colliderRestitution[this.handle] = restitution;
    this.wake();
    return this;
  }
  private wake(): void {
    if (this.body.type === 'dynamic') this.kernel.wake(this.body.row);
  }
  /** The packed collision groups: the lower 16 bits of each side, as Rapier's JavaScript build reads them. */
  collisionGroups(): number {
    return this.columns().colliderGroups[this.handle];
  }
  /** The collision groups 32 bits wide, with their test mode, as Rapier's Rust `InteractionGroups`. */
  interactionGroups(): InteractionGroups {
    this.columns();
    return readGroups(this.kernel, this.handle, false);
  }
  /**
   * Sets the collision groups: a packed number (see `collisionGroups` from this package) or 32 bits wide with a test mode
   * (see `interactionGroups`).
   */
  setCollisionGroups(groups: number | InteractionGroups): this {
    this.columns();
    writeGroups(this.kernel, this.handle, groups, false);
    this.reach();
    return this;
  }
  /** The packed solver groups. */
  solverGroups(): number {
    return this.columns().colliderSolverGroups[this.handle];
  }
  /** The solver groups 32 bits wide, with their test mode. */
  solverInteractionGroups(): InteractionGroups {
    this.columns();
    return readGroups(this.kernel, this.handle, true);
  }
  /** Sets the solver groups, packed or wide: pairs whose groups do not meet are detected and fire events, and are not solved. */
  setSolverGroups(groups: number | InteractionGroups): this {
    this.columns();
    writeGroups(this.kernel, this.handle, groups, true);
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

function rotateBy(q: readonly number[], x: number, y: number, z: number): [number, number, number] {
  const [qx, qy, qz, qw] = q as [number, number, number, number],
    tx = 2 * (qy * z - qz * y),
    ty = 2 * (qz * x - qx * z),
    tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

// Features: which vertex, edge or face of a collider a point lies on, for the hits of rays and the points of projections.
// Read from the collider's rows after the query, so a query costs nothing more when nobody asks.

/** What kind of feature a point is on: a corner, an edge between two faces, a face, or none this solver names. */
export type FeatureType = 'vertex' | 'edge' | 'face' | 'unknown';

/** A feature of a collider's shape. `id` is `undefined` for 'unknown'. */
export interface Feature {
  type: FeatureType;
  id: number | undefined;
}

const UNKNOWN: Feature = { type: 'unknown', id: undefined };
/** Most triangles a mesh may have for a hit to be searched among them. */
const SEARCHED_TRIANGLES = 4096;

/** `world`, a point in the world, in a collider's own frame. */
function local(collider: PhysicsCollider, world: Vec3): Vec3 {
  const t = collider.translation(),
    q = collider.rotation(),
    // The conjugate turns a vector back: v + 2 w (u x v) + 2 u x (u x v) with u = -q.xyz.
    v: Vec3 = [world[0] - t.x, world[1] - t.y, world[2] - t.z],
    u: Vec3 = [-q.x, -q.y, -q.z],
    c: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]],
    d: Vec3 = [u[1] * c[2] - u[2] * c[1], u[2] * c[0] - u[0] * c[2], u[0] * c[1] - u[1] * c[0]];
  return [v[0] + 2 * q.w * c[0] + 2 * d[0], v[1] + 2 * q.w * c[1] + 2 * d[1], v[2] + 2 * q.w * c[2] + 2 * d[2]];
}

/**
 * The feature of `collider` that the world point `point` lies on, within a tolerance of 1e-4 of the shape's size.
 *
 * - A box: faces are numbered `2 axis + (point on the low side ? 1 : 0)` over x, y, z; an edge `4 axis + two bits` (the
 *   signs of the other two axes, in axis order) for the axis it runs along; a vertex by three bits, x low to z high.
 * - A convex hull: a face is its row among the hull's faces, a vertex its row, an edge the lower of its two half-edge rows.
 * - A triangle mesh: a face is a triangle's number, as it was given; an edge `3 triangle + side`, a vertex the vertex's number.
 *   Searched among meshes of at most 4096 triangles.
 * - A height field: a face is `2 cell + half` (cell `row + rows column`, half 0 for the lower-row triangle).
 * - Every other shape: unknown.
 */
export function featureAt(kernel: KernelWorld, collider: PhysicsCollider, point: Vec3): Feature {
  if (!collider.valid) return UNKNOWN;
  const c = kernel.columns,
    h = collider.handle,
    p = local(collider, point);
  if (collider.shape === 'box' && c.colliderBorder[h] === 0) {
    const half = [c.colliderA[h], c.colliderB[h], c.colliderC[h]],
      eps = 1e-4 * (1 + Math.max(half[0], half[1], half[2])),
      on: number[] = [];
    for (let axis = 0; axis < 3; axis++) if (Math.abs(p[axis]) >= half[axis] - eps) on.push(axis);
    if (on.length === 3) return { type: 'vertex', id: (p[0] > 0 ? 1 : 0) | (p[1] > 0 ? 2 : 0) | (p[2] > 0 ? 4 : 0) };
    if (on.length === 2) {
      const free = 3 - on[0] - on[1],
        low = (axis: number): number => (p[axis] > 0 ? 1 : 0);
      return { type: 'edge', id: 4 * free + low(on[0]) + 2 * low(on[1]) };
    }
    if (on.length === 1) return { type: 'face', id: 2 * on[0] + (p[on[0]] < 0 ? 1 : 0) };
    return UNKNOWN;
  }
  if (collider.shape === 'convexHull' && c.colliderBorder[h] === 0) {
    const row = c.colliderHull[h],
      vertexRow = c.hullFirstVertex[row],
      faceRow = c.hullFirstFace[row],
      eps = 1e-4 * (1 + c.hullRadius[row]);
    for (let v = 0; v < c.hullVertices[row]; v++) {
      const dx = c.vertexX[vertexRow + v] - p[0],
        dy = c.vertexY[vertexRow + v] - p[1],
        dz = c.vertexZ[vertexRow + v] - p[2];
      if (dx * dx + dy * dy + dz * dz <= eps * eps) return { type: 'vertex', id: v };
    }
    const faces: number[] = [];
    for (let f = 0; f < c.hullFaces[row]; f++) {
      const distance =
        c.faceNormalX[faceRow + f] * p[0] +
        c.faceNormalY[faceRow + f] * p[1] +
        c.faceNormalZ[faceRow + f] * p[2] -
        c.faceOffset[faceRow + f];
      if (Math.abs(distance) <= eps) faces.push(f);
    }
    if (faces.length === 1) return { type: 'face', id: faces[0] };
    if (faces.length >= 2) {
      const edgeRow = c.hullFirstEdge[row];
      for (let e = 0; e < c.hullEdges[row]; e++) {
        const twin = c.edgeTwin[edgeRow + e];
        if (e < twin && faces.includes(c.edgeFace[edgeRow + e]) && faces.includes(c.edgeFace[edgeRow + twin]))
          return { type: 'edge', id: e };
      }
      return { type: 'face', id: faces[0] };
    }
    return UNKNOWN;
  }
  if (collider.shape === 'trimesh') {
    const row = c.colliderHull[h],
      first = c.meshFirstTriangle[row],
      count = c.meshTriangles[row],
      vertices = c.meshFirstVertex[row];
    if (count > SEARCHED_TRIANGLES) return UNKNOWN;
    return nearestTriangle(c, p, first, count, vertices, (t) => [
      c.triangleA[first + t],
      c.triangleB[first + t],
      c.triangleC[first + t],
    ]);
  }
  if (collider.shape === 'heightfield') {
    const row = c.colliderHull[h],
      columns = c.meshColumns[row],
      rows = c.meshVertices[row] / (columns + 1) - 1,
      v0 = c.meshFirstVertex[row],
      stride = rows + 1,
      x0 = c.meshVertexX[v0],
      z0 = c.meshVertexZ[v0],
      dx = (c.meshVertexX[v0 + stride * columns] - x0) / columns,
      dz = (c.meshVertexZ[v0 + rows] - z0) / rows,
      column = Math.min(columns - 1, Math.max(0, Math.floor((p[0] - x0) / dx))),
      r = Math.min(rows - 1, Math.max(0, Math.floor((p[2] - z0) / dz))),
      // The cell's diagonal runs from row r + 1, column c to row r, column c + 1: a point under it is in the first triangle.
      fx = (p[0] - (x0 + column * dx)) / dx,
      fz = (p[2] - (z0 + r * dz)) / dz;
    return { type: 'face', id: 2 * (r + rows * column) + (fx + fz <= 1 ? 0 : 1) };
  }
  return UNKNOWN;
}

/** The triangle of a mesh nearest a point of its frame, as a face, an edge or a vertex when the point is on one. */
function nearestTriangle(
  c: KernelWorld['columns'],
  p: Vec3,
  _first: number,
  count: number,
  vertices: number,
  corners: (t: number) => [number, number, number],
): Feature {
  const eps = 1e-4;
  let best = { distance: Infinity, t: -1, side: -1, corner: -1 };
  for (let t = 0; t < count; t++) {
    const index = corners(t),
      point = index.map(
        (i) => [c.meshVertexX[vertices + i], c.meshVertexY[vertices + i], c.meshVertexZ[vertices + i]] as Vec3,
      );
    const [a, b, d] = point,
      ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      ad: Vec3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]],
      n: Vec3 = [ab[1] * ad[2] - ab[2] * ad[1], ab[2] * ad[0] - ab[0] * ad[2], ab[0] * ad[1] - ab[1] * ad[0]],
      length = Math.hypot(n[0], n[1], n[2]);
    if (!(length > 0)) continue;
    const away = ((p[0] - a[0]) * n[0] + (p[1] - a[1]) * n[1] + (p[2] - a[2]) * n[2]) / length;
    if (Math.abs(away) > eps) continue;
    // Barycentric coordinates of the point's foot in the triangle.
    const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]],
      d00 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2],
      d01 = ab[0] * ad[0] + ab[1] * ad[1] + ab[2] * ad[2],
      d11 = ad[0] * ad[0] + ad[1] * ad[1] + ad[2] * ad[2],
      d20 = ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2],
      d21 = ap[0] * ad[0] + ap[1] * ad[1] + ap[2] * ad[2],
      denominator = d00 * d11 - d01 * d01,
      v = (d11 * d20 - d01 * d21) / denominator,
      w = (d00 * d21 - d01 * d20) / denominator,
      u = 1 - v - w,
      slack = 1e-4;
    if (u < -slack || v < -slack || w < -slack) continue;
    const low = [u, v, w].map((x) => x < slack),
      zeros = low.filter(Boolean).length,
      score = Math.abs(away);
    if (score >= best.distance) continue;
    best = { distance: score, t, side: -1, corner: -1 };
    if (zeros === 2) best.corner = [u, v, w].findIndex((x) => !(x < slack));
    else if (zeros === 1) best.side = low.indexOf(true);
  }
  if (best.t < 0) return UNKNOWN;
  if (best.corner >= 0) return { type: 'vertex', id: corners(best.t)[best.corner] };
  if (best.side >= 0) return { type: 'edge', id: 3 * best.t + best.side };
  return { type: 'face', id: best.t };
}
