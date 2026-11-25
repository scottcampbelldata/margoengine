/// <reference lib="esnext.disposable" preserve="true" />
// The own solver behind the names `Physics` has today. On the step path: no `Math`, tests/step-path.test.js holds that.
import { DEFAULT_GRAVITY } from '@margoengine/math/gravity';
import { MargoError } from '@margoengine/math/errors';
import { filmSteps } from './film.js';
import type { EngineKernel, EnginePlugin, Mesh } from '@margoengine/core';
import type { BodyOptions, BodyType } from './body.js';
import {
  COLLIDER_OFF,
  COLLIDER_MODIFY,
  COLLIDER_SENSOR,
  EVENT_COLLIDER,
  EVENT_REMOVED,
  EVENT_SENSOR,
  KernelWorld,
  kernelBuild,
  kernelVariant,
  loadKernel,
  PAIR_IS_PART,
  PAIR_TOUCHING,
  QUERY_EXCLUDE_DYNAMIC,
  QUERY_EXCLUDE_FIXED,
  QUERY_EXCLUDE_KINEMATIC,
  QUERY_EXCLUDE_SENSORS,
  QUERY_EXCLUDE_SOLIDS,
  QUERY_ONLY_DYNAMIC,
  QUERY_NO_GROUPS,
  QUERY_WIDE_GROUPS,
  QUERY_GROUPS_OR,
  QUERY_ONLY_FIXED,
  QUERY_ONLY_KINEMATIC,
  type KernelRayHit,
  type KernelManifold,
  type KernelShapeCastHit,
  type KernelLoadOptions,
  type KernelShape,
  type KernelSolverOptions,
  type KernelParticleViews,
  type KernelSoftContacts,
  type KernelTriangleViews,
  type KernelFaceContacts,
  combineRule,
} from './kernel.js';
import { mixCoefficients } from './combine.js';
import { writeGroups } from './groups.js';
import { groupWords } from './shapes.js';
import { meshRuntime, Mesh as CoreMesh } from '@margoengine/core/extension';
import { multiplyMatrices } from '@margoengine/math/mat4';
import { checkVec, multiplyQuat, rotateVec, type Quat, type Vec3 } from './math.js';
import { matrixRotation, worldMatrix } from './transform.js';
import type { ModelLike, ModelPrimitiveLike } from '../../shared/model.js';
import { colliderGeometry } from './mesh-fit.js';
import type { ColliderOptions, ColliderSettings, InteractionGroups, ShapeOptions } from './shapes.js';
import { PhysicsBody, checkRotation, type BodyOwner } from './body.js';
import { PhysicsCollider, featureAt, type Feature, type FeatureType } from './collider.js';
import { CharacterController, type CharacterControllerOptions } from './character.js';
import { DynamicCharacter, type DynamicCharacterOptions } from './dynamic-character.js';
import { type Multibody, buildMultibody, clearMultibody, type MultibodyLinkOptions } from './multibody.js';
import { debugLines, type DebugLines, type DebugRenderOptions } from './debug.js';
import { type NextJointOptions, type PhysicsJoint, createJoint } from './joints.js';
import {
  PI,
  cosine,
  kernelCollider,
  multiply,
  queryParts,
  queryShape,
  root,
  shapeServed,
  turn,
  type HullRows,
} from './kernel-shapes.js';
import { MeshSync, meshPose } from './sync.js';

/** Options for creating a Physics world; every field has a default. */
export interface PhysicsOptions {
  /** Default `DEFAULT_GRAVITY` of `@margoengine/math/gravity`, [0, -9.81, 0]. */
  gravity?: Vec3;
  /** Seconds per physics step (default 1/60). */
  fixedTimestep?: number;
  /** Most steps per frame; extra time is dropped so a slow frame cannot snowball (default 4). Ignored in film mode. */
  maxSubsteps?: number;
  /**
   * Film mode (default false): `update` runs every step it owes, however long the frame was, and keeps the fraction of a step
   * it cannot yet run, so no time is ever dropped and a shot never runs in silent slow motion. `maxSubsteps` is not used. Use
   * {@link Physics.advance} to put the world at an exact frame of a shot, whatever the frame rate it is rendered at.
   */
  film?: boolean;
  /** Interpolate rendered transforms between the last two steps (default true). */
  interpolate?: boolean;
  /** Multiplies frame time, for slow motion (default 1). */
  timeScale?: number;
  /** Start paused (default false). */
  paused?: boolean;
  /** Equal pieces each step is split into; forces reach every piece and impulses land once (default 8). */
  substeps?: number;
  /** Solver passes in each substep (default 2). */
  iterations?: number;
  /** The old name of `substeps`, kept for one release. */
  solverIterations?: number;
  /** Plugin name (default 'physics'). */
  name?: string;
  /**
   * Decides each candidate pair of bodies; false lets them pass through each other and keeps their sensor events quiet,
   * true solves them, and `'noForces'` (Rapier's hook answering with no solver flags) finds their contacts and fires their
   * events but pushes nothing.
   */
  contactFilter?: (a: PhysicsBody, b: PhysicsBody) => boolean | 'noForces';
  /**
   * Decides each candidate pair with a sensor in it, as Rapier's `filterIntersectionPair`: false lets them pass and keeps their
   * intersection events quiet. Left out, `contactFilter` decides those pairs too. A collider can leave a hook out with
   * `activeHooks`.
   */
  intersectionFilter?: (a: PhysicsBody, b: PhysicsBody) => boolean;
  /**
   * Called for each touching pair that has a collider with `modifyContacts` set, after its friction and bounce are set and
   * before it is solved, each step: change its friction, restitution and normal, or clear its contacts (a one-way platform,
   * a slippery patch). The object is reused, so keep what you need, not the object.
   */
  contactModifier?: (contact: ContactModification) => void;
  /** How far apart two shapes may be, in metres, and still have contacts made (default 0.04), Rapier's `predictionDistance`. */
  predictionDistance?: number;
  /**
   * How many of your length units make a metre's worth of scale (default 1): 100 for a world in centimetres, 0.001 for one
   * in kilometres, Rapier's `lengthUnit`. The tolerances of the solver (contact reach, allowed penetration, the fastest a
   * depth is pushed out, the sleep speed) follow it; gravity, sizes and masses are yours to give in the same unit.
   * `predictionDistance` and `setSolver` given after it replace what it set.
   */
  lengthUnit?: number;
}

/** One contact point of a pair shown to the modifier: where it presses on each body, and how far apart the surfaces are. */
export class ContactPointModification {
  /** @internal */
  constructor(
    private readonly kernel: KernelWorld,
    private readonly row: number,
    private readonly at: number,
  ) {}
  /** Where the point is on the first body, from its centre of mass and in the body's frame. */
  get anchorA(): [number, number, number] {
    const c = this.kernel.columns;
    return [c.contactAnchorAX[this.at]!, c.contactAnchorAY[this.at]!, c.contactAnchorAZ[this.at]!];
  }
  set anchorA(value: Vec3) {
    checkVec(value, 'Contact anchor');
    const c = this.kernel.columns;
    [c.contactAnchorAX[this.at], c.contactAnchorAY[this.at], c.contactAnchorAZ[this.at]] = value;
  }
  /** Where the point is on the second body, from its centre of mass and in the body's frame. */
  get anchorB(): [number, number, number] {
    const c = this.kernel.columns;
    return [c.contactAnchorBX[this.at]!, c.contactAnchorBY[this.at]!, c.contactAnchorBZ[this.at]!];
  }
  set anchorB(value: Vec3) {
    checkVec(value, 'Contact anchor');
    const c = this.kernel.columns;
    [c.contactAnchorBX[this.at], c.contactAnchorBY[this.at], c.contactAnchorBZ[this.at]] = value;
  }
  /**
   * How far apart the surfaces are along the normal at this point: negative when they overlap. The solver reads where the
   * point is on each body, not a stored distance, so setting this moves the point on the second body along the normal by the
   * difference: a smaller distance presses harder, a larger one lets go.
   */
  get distance(): number {
    return this.kernel.columns.contactSeparation[this.at]!;
  }
  set distance(value: number) {
    if (!Number.isFinite(value))
      throw new RangeError(`A contact distance is a finite number of metres (got ${value}).`);
    const c = this.kernel.columns,
      row = this.row,
      body = c.colliderBody[c.pairB[row]!]!,
      shift = value - c.contactSeparation[this.at]!,
      n = [c.pairNormalX[row]! * shift, c.pairNormalY[row]! * shift, c.pairNormalZ[row]! * shift] as const,
      // The shift into the second body's frame: the inverse of its turn.
      local = turn(
        [-c.rotationX[body]!, -c.rotationY[body]!, -c.rotationZ[body]!, c.rotationW[body]!],
        [n[0], n[1], n[2]],
      );
    c.contactAnchorBX[this.at]! += local[0];
    c.contactAnchorBY[this.at]! += local[1];
    c.contactAnchorBZ[this.at]! += local[2];
    c.contactSeparation[this.at] = value;
  }
}

/** A touching pair shown to `PhysicsOptions.contactModifier`, valid only inside the call. */
export class ContactModification {
  /** @internal */
  row = 0;
  /** @internal */
  colliderA!: PhysicsCollider;
  /** @internal */
  colliderB!: PhysicsCollider;
  /** @internal */
  constructor(private readonly kernel: KernelWorld) {}
  /** The pair's first collider; normals run from it to {@link ContactModification.colliderB}. */
  get first(): PhysicsCollider {
    return this.colliderA;
  }
  /** The pair's second collider. */
  get second(): PhysicsCollider {
    return this.colliderB;
  }
  /** Coulomb friction of the pair, from the colliders' own and their combine rules; set it to override. */
  get friction(): number {
    return this.kernel.columns.pairFriction[this.row];
  }
  set friction(value: number) {
    if (!(value >= 0) || !Number.isFinite(value))
      throw new RangeError(`Friction must be finite and not negative (got ${value}).`);
    this.kernel.columns.pairFriction[this.row] = value;
  }
  /** Restitution of the pair; set it to override. */
  get restitution(): number {
    return this.kernel.columns.pairRestitution[this.row];
  }
  set restitution(value: number) {
    if (!(value >= 0 && value <= 1)) throw new RangeError(`Restitution must be from 0 to 1 (got ${value}).`);
    this.kernel.columns.pairRestitution[this.row] = value;
  }
  /**
   * The velocity the second collider's surface moves relative to the first's, in world space (default zero): a conveyor
   * belt. Friction brings the bodies' sliding to it, so a box on a belt is carried at the belt's speed. Only its part along
   * the contact's surface counts, and it lasts for this step: set it each time the modifier is called.
   */
  get surfaceVelocity(): [number, number, number] {
    const c = this.kernel.columns;
    return [c.pairSurfaceX[this.row], c.pairSurfaceY[this.row], c.pairSurfaceZ[this.row]];
  }
  set surfaceVelocity(value: Vec3) {
    checkVec(value, 'Surface velocity');
    const c = this.kernel.columns;
    [c.pairSurfaceX[this.row], c.pairSurfaceY[this.row], c.pairSurfaceZ[this.row]] = value;
  }
  /** How many contact points the pair has. */
  get contactCount(): number {
    return this.kernel.columns.pairContacts[this.row];
  }
  /** The unit contact normal in world space, from the first collider to the second. */
  get normal(): [number, number, number] {
    const c = this.kernel.columns;
    return [c.pairNormalX[this.row], c.pairNormalY[this.row], c.pairNormalZ[this.row]];
  }
  set normal(value: Vec3) {
    checkVec(value, 'Contact normal');
    const squared = value[0] * value[0] + value[1] * value[1] + value[2] * value[2],
      length = root(squared);
    if (!(squared > 1e-12)) throw new RangeError('A contact normal needs a direction; pass a vector of some length.');
    const c = this.kernel.columns;
    [c.pairNormalX[this.row], c.pairNormalY[this.row], c.pairNormalZ[this.row]] = [
      value[0] / length,
      value[1] / length,
      value[2] / length,
    ];
  }
  /** Drops every contact of the pair for this step: the bodies pass through each other and push nothing. */
  clear(): void {
    this.kernel.columns.pairContacts[this.row] = 0;
  }
  /**
   * A word the modifier keeps with the pair, as Rapier's persistent manifold `user_data`: 0 when the pair is made, and it stays
   * for as long as the pair does (a contact that is cleared or leaves does not reset it). A whole number from 0 to 4,294,967,295.
   */
  get userData(): number {
    return this.kernel.columns.pairUser[this.row]!;
  }
  set userData(value: number) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new RangeError(`A pair's user data is a whole number from 0 to 4294967295 (got ${value}); pass one.`);
    this.kernel.columns.pairUser[this.row] = value;
  }
  /**
   * Contact point `k` of the pair, for edits of its anchors and distance (Rapier's solver contact `point` and `dist`). The
   * object is a view of the kernel's row, valid inside the call.
   * @throws RangeError for a point the pair does not have.
   */
  point(k: number): ContactPointModification {
    if (!Number.isInteger(k) || k < 0 || k >= this.contactCount)
      throw new RangeError(
        `This pair has ${this.contactCount} contact points; pass k from 0 to ${this.contactCount - 1}.`,
      );
    return new ContactPointModification(this.kernel, this.row, this.row * 4 + k);
  }
  /**
   * Makes the collider `platform` a one-way platform: contacts whose normal, taken from the platform to the other collider,
   * lies within `angle` radians (default a quarter turn: the half space above it) of `direction` stay, and the rest are
   * dropped. A body rising through the underside meets nothing, and standing on top it rests.
   * @throws RangeError when `platform` is neither collider of the pair.
   */
  oneWay(platform: PhysicsCollider, direction: Vec3, angle = PI / 2): void {
    checkVec(direction, 'Platform direction');
    if (platform !== this.colliderA && platform !== this.colliderB)
      throw new RangeError('That collider is not in this pair; pass colliderA or colliderB of the contact.');
    const [nx, ny, nz] = this.normal,
      sign = platform === this.colliderA ? 1 : -1,
      squared = direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2],
      length = root(squared);
    if (!(squared > 0)) throw new RangeError('A platform direction needs some length.');
    const along = (sign * (nx * direction[0] + ny * direction[1] + nz * direction[2])) / length;
    if (along < cosine(angle)) this.clear();
  }
}

/** A world as {@link Physics.takeSnapshot} took it: the kernel's bytes, and which bodies, colliders and joints it held. */
export interface PhysicsSnapshot {
  readonly bytes: Uint8Array;
  readonly bodies: readonly (readonly [number, number])[];
  readonly colliders: readonly (readonly [number, number])[];
  readonly joints: readonly number[];
}

/** Kind of collision event: `contactstart` and `contactend` for solid contacts, `intersectionstart` and `intersectionend` for sensors. */
export type CollisionEventType = 'contactstart' | 'contactend' | 'intersectionstart' | 'intersectionend';
/** Two colliders began or stopped touching. */
export interface CollisionEvent {
  type: CollisionEventType;
  bodyA: PhysicsBody;
  bodyB: PhysicsBody;
  meshA: Mesh | null;
  meshB: Mesh | null;
  colliderA: PhysicsCollider;
  colliderB: PhysicsCollider;
  /** True when either collider is a sensor (intersection events). */
  sensor: boolean;
  /**
   * True on an end event that came because a collider, or its body, was removed (Rapier's `CollisionEventFlags::REMOVED`).
   * It is delivered at the end of the next step.
   */
  removed?: boolean;
}

/** A pair's force over a step as the solver gave it: the sum of its contacts' impulses and the strongest one. */
interface ForceSum {
  impulse: number;
  x: number;
  y: number;
  z: number;
  max: number;
  mx: number;
  my: number;
  mz: number;
}

/** How hard two colliders pressed on each other in the last step. Only the own solver has this event. */
export interface ContactForceEvent {
  type: 'contactforce';
  bodyA: PhysicsBody;
  bodyB: PhysicsBody;
  meshA: Mesh | null;
  meshB: Mesh | null;
  colliderA: PhysicsCollider;
  colliderB: PhysicsCollider;
  /** The normal impulse of the whole step, in newton seconds. */
  impulse: number;
  /** `impulse` over the step's length, in newtons. A box at rest on a floor reads its weight. */
  force: number;
  /** The sum of the pair's contact forces, normal and friction, in newtons, world space (Rapier's `totalForce`). */
  totalForce: [number, number, number];
  /** The length of `totalForce`, in newtons (Rapier's `totalForceMagnitude`). */
  totalForceMagnitude: number;
  /** The strongest single contact's force in newtons (Rapier's `maxForceMagnitude`). */
  maxForceMagnitude: number;
  /** The direction of that contact's force, a unit vector (Rapier's `maxForceDirection`). */
  maxForceDirection: [number, number, number];
}

/** Events a Physics world emits, keyed by event name. `touching` and `contactPoints` read contacts after a step. */
export interface PhysicsEventMap {
  contactstart: CollisionEvent;
  contactend: CollisionEvent;
  intersectionstart: CollisionEvent;
  intersectionend: CollisionEvent;
  /** After each step that has a listener, once for each pair of colliders that pressed on each other. */
  contactforce: ContactForceEvent;
  /** Before each fixed step, with the step length. Drive kinematic bodies here. */
  beforestep: number;
  afterstep: number;
  /** After a step in which a joint with break limits broke: once for that joint, with its bodies. */
  jointbreak: JointBreakEvent;
  /** After a step in which a body left the numbers and was taken out of the world (the `quarantine` solver option): once for it. */
  quarantine: QuarantineEvent;
}

/** A body taken out of the world for leaving the numbers: at rest, disabled, where its last good step ended. */
export interface QuarantineEvent {
  type: 'quarantine';
  body: PhysicsBody;
}

/** A joint that broke under its load. */
export interface JointBreakEvent {
  type: 'jointbreak';
  joint: PhysicsJoint;
  bodyA: PhysicsBody;
  bodyB: PhysicsBody;
}

/** Which colliders a scene query sees: the root entry's names, plus Rapier's flags the root does not name. */
export interface QueryFilter {
  /**
   * Interaction groups of the query: packed (see `collisionGroups`), or 32 bits wide with a test mode (see `interactionGroups`); a
   * collider is seen when the groups meet, both ways for `and` and either way for `or` against a collider that asks for it too.
   */
  groups?: number | InteractionGroups;
  /** Leave out every collider of this body. */
  exclude?: PhysicsBody;
  /** Leave out this one collider. */
  excludeCollider?: PhysicsCollider;
  excludeSensors?: boolean;
  /** Leave out colliders that are not sensors. */
  excludeSolids?: boolean;
  excludeFixed?: boolean;
  excludeKinematic?: boolean;
  excludeDynamic?: boolean;
  /** See only colliders of dynamic bodies; with other `only` flags, any of the kinds named. */
  onlyDynamic?: boolean;
  onlyKinematic?: boolean;
  onlyFixed?: boolean;
  /** Return false to skip a collider. */
  predicate?: (body: PhysicsBody, collider: PhysicsCollider) => boolean;
}
/** Options of `Physics.raycast` and `raycastAll`: the query filter plus a distance limit and solid starts. */
export interface PhysicsRaycastOptions extends QueryFilter {
  /** Default unbounded. */
  maxDistance?: number;
  /** A ray that starts inside a shape hits it at distance 0 (default true); false: where it leaves, the normal facing the ray. */
  solid?: boolean;
}
/** A query hit: the body and collider, and its mesh. */
export interface Hit {
  body: PhysicsBody;
  mesh: Mesh | null;
  collider: PhysicsCollider;
}
/** A ray hit: the body, its mesh and the collider, how far along the ray, the point and the surface normal. */
export interface RaycastHit {
  body: PhysicsBody;
  mesh: Mesh | null;
  collider: PhysicsCollider;
  distance: number;
  point: [number, number, number];
  /** Outward surface normal, world space; zero for a hit at distance 0 inside a solid shape. */
  normal: [number, number, number];
  /** The kind of feature of the collider the hit is on (a ray's hit; not set on a shape cast's). */
  readonly featureType?: FeatureType;
  /** That feature's number, in Margo's numbering (see `PhysicsCollider.featureAt` rules in the README); `undefined` when 'unknown'. */
  readonly featureId?: number | undefined;
}

/** Options of `Physics.shapeCast`: the query filter plus Rapier's `ShapeCastOptions`. */
export interface PhysicsShapeCastOptions extends QueryFilter {
  /** Default unbounded. */
  maxDistance?: number;
  /** Stop this far short of touching (default 0). */
  targetDistance?: number;
  /** A cast that starts in contact hits at distance 0 even when it moves out (default true); false lets such a cast go on. */
  stopAtPenetration?: boolean;
  /** A hit at the start gets its normal and points (default true); false leaves them zero. */
  computeImpactGeometryOnPenetration?: boolean;
}
/** A shape cast's first touch: the ray hit's fields on the collider hit, plus the point and normal on the cast shape. */
export interface ShapeCastHit extends RaycastHit {
  queryPoint: [number, number, number];
  queryNormal: [number, number, number];
}
/** The point of a collider nearest a query point, whether the query point is inside it, and how far it is. */
/** A contact manifold between a collider and a query shape (see {@link Physics.colliderShapeContacts}): normal from the collider to the shape. */
export interface ShapeContactManifold {
  /** The pair's friction and restitution: what the solver mixed for it, or the colliders' by their combine rules. */
  friction?: number;
  restitution?: number;
  normal: [number, number, number];
  /** Up to four points: where each side's surface is, how far apart they are (negative when they overlap) and an id that stays with the feature. */
  points: {
    pointA: [number, number, number];
    pointB: [number, number, number];
    separation: number;
    id: number;
    /** The normal impulse the solver last gave this point (its last substep), 0 for a contact the world does not hold. */
    normalImpulse: number;
    /** The friction impulse the solver last gave it, along the pair's surface. */
    tangentImpulse: [number, number, number];
  }[];
}

/** What {@link Physics.contactPair} returns for one part of a pair: the normal from the first collider to the second. */
export interface ContactManifold extends Omit<ShapeContactManifold, 'points'> {
  /** The normal in the first collider's frame, and the reverse of it (the normal the second sees) in the second's. */
  localNormalA: [number, number, number];
  localNormalB: [number, number, number];
  /** The sub-shape of each collider the manifold is on: a compound's child index or a mesh's triangle (a height field's triangle, a voxel grid's cell); undefined for a plain shape. */
  subShapeA?: number;
  subShapeB?: number;
  points: (ShapeContactManifold['points'][number] & {
    /** The point in each collider's own frame. */
    localPointA: [number, number, number];
    localPointB: [number, number, number];
    /** What the solver reads for the point, as Rapier's solver contact: the pair's friction and restitution and its surface velocity. */
    friction: number;
    restitution: number;
    tangentVelocity: [number, number, number];
  })[];
}

/** What {@link Physics.colliderDistance} returns. */
export interface ColliderDistance {
  /** 0 when the colliders overlap. */
  distance: number;
  pointA: [number, number, number];
  pointB: [number, number, number];
}

/** The closest point of a collider to a query point: where it is, whether the query point lies inside it, and how far. */
export interface PointProjection {
  body: PhysicsBody;
  mesh: Mesh | null;
  collider: PhysicsCollider;
  point: [number, number, number];
  inside: boolean;
  distance: number;
  /** The kind of feature of the collider the point lies on. */
  readonly featureType: FeatureType;
  /** That feature's number, in Margo's numbering; `undefined` when 'unknown'. */
  readonly featureId: number | undefined;
}

// gltf/pbr models (shared/model.js): skinned and morphed primitives are read in their bind pose; an instanced
// primitive gives one collider per drawn instance.
export type { ModelLike, ModelPrimitiveLike };
/** Options for `Physics.addModel`: body options plus how the model's triangles become colliders. */
export interface ModelBodyOptions extends Omit<BodyOptions, 'colliders' | 'position' | 'rotation'> {
  /**
   * Collider per primitive (and per instance of an instanced primitive). Default 'trimesh' for fixed and kinematic
   * bodies, 'convexHull' for dynamic ones (a trimesh has no volume, so it gives a dynamic body no mass).
   * 'convexDecomposition' splits each concave primitive into convex pieces, for dynamic bodies that must keep holes.
   */
  shape?: 'trimesh' | 'convexHull' | 'convexDecomposition';
  /** One body per glTF node that has primitives (true), or one body on `model.root` holding every collider (false, default). */
  perNode?: boolean;
  /** Return false to leave a primitive out, for example Blender objects tagged `collider = 0`. */
  filter?: (primitive: ModelPrimitiveLike) => boolean;
  /** Material, mass, sensor, group and event settings for every collider. */
  collider?: Omit<ColliderSettings, 'offset' | 'rotation'>;
}

/** @internal A helper that steps, syncs and is disposed with a world. */
export interface PhysicsAttachment {
  beforeStep?(dt: number): void;
  /** After the step, its events and `afterstep` listeners included: what an attachment held for the step comes off here. */
  afterStep?(dt: number): void;
  afterSync?(): void;
  bodyRemoved?(body: PhysicsBody): void;
  dispose(): void;
}

/** No row: the end of a pair list, and a filter word that leaves nothing out. */
const NONE = 0xffffffff;
const byDistance = (a: RaycastHit, b: RaycastHit): number => a.distance - b.distance;
const noop = (): void => {};
// Set.forEach with the event as thisArg calls listeners without allocating a closure or a snapshot array.
function callListener(this: never, listener: (event: never) => void): void {
  listener(this);
}
const attachmentSync = (attachment: PhysicsAttachment): void => attachment.afterSync?.();
const ascending = (x: number, y: number): number => x - y;
const bits = (enabled: readonly [boolean, boolean, boolean]): number =>
  (enabled[0] ? 0 : 1) | (enabled[1] ? 0 : 2) | (enabled[2] ? 0 : 4);

/**
 * Rigid-body physics on Margo's own solver as a Margo Engine plugin. The same names as `Physics` from the root entry, with
 * a fixed timestep, an accumulator and interpolation. Bodies fall, turn, collide, sleep and hold joints; a call that needs
 * queries throws `unsupported`. A preview, removed when it becomes the root.
 */
export class Physics implements EnginePlugin, BodyOwner {
  readonly name: string;
  fixedTimestep: number;
  maxSubsteps: number;
  /** Film mode: `update` drops no time (see {@link PhysicsOptions.film}). */
  film: boolean;
  interpolate: boolean;
  timeScale: number;
  paused: boolean;
  /** Fixed steps taken since creation. */
  stepCount = 0;
  private world: KernelWorld | null;
  private hasModifier = false;
  private engine: EngineKernel | null = null;
  private accumulator = 0;
  private lastAlpha = 1;
  private disposed = false;
  private readonly controllers = new Set<CharacterController>();
  private readonly dynamicCharacters = new Set<DynamicCharacter>();
  private readonly followers = new Set<PhysicsBody>();
  private readonly parentScratch = new Float64Array(16);
  private readonly parentRotation = [0, 0, 0, 1];
  private readonly meshes: MeshSync;
  private readonly bodies = new Set<PhysicsBody>();
  private readonly byBodyRow = new Map<number, PhysicsBody>();
  /** Pair rows of one `contactPoints` call, kept between calls. */
  private readonly rowScratch: number[] = [];
  private readonly joints = new Set<PhysicsJoint>();
  private readonly multibodies = new Set<Multibody>();
  private readonly byMesh = new Map<Mesh, PhysicsBody>();
  private readonly byRow = new Map<number, PhysicsCollider>();
  // A hull's rows stay for the world's life, so colliders built from the same points share one.
  private readonly hullRows = new Map<string, number>();
  private readonly hulls: HullRows = {
    addHull: (vertices, faces) => {
      const key = JSON.stringify([vertices, faces]);
      let row = this.hullRows.get(key);
      if (row === undefined) {
        row = this.kernel.addHull(vertices, faces);
        this.hullRows.set(key, row);
      }
      return row;
    },
    hullVolume: (row) => this.kernel.columns.hullVolume[row],
    addTrimesh: (vertices, indices, fixInternalEdges, oriented, deformable, solid) =>
      this.kernel.addTrimesh(vertices, indices, { fixInternalEdges, oriented, deformable, solid }),
    addHeightfield: (rows, columns, heights, scale, fixInternalEdges, cellStatus) =>
      this.kernel.addHeightfield(rows, columns, heights, [scale[0], scale[1], scale[2]], {
        fixInternalEdges,
        cellStatus,
      }),
    addVoxels: (cells, size) => this.kernel.addVoxels(cells, [size[0], size[1], size[2]]),
  };
  /** Colliders removed since the last step's events: a stop marked `removed` still names them. */
  private readonly retired = new Map<number, PhysicsCollider>();
  private readonly attachments = new Set<PhysicsAttachment>();
  private readonly listeners = new Map<keyof PhysicsEventMap, Set<(event: never) => void>>();
  // Gathered into a reused array; a step run from inside a listener gathers into its own.
  private readonly eventBuffer: (CollisionEvent | ContactForceEvent)[] = [];
  private dispatching = false;

  /**
   * The build of the solver this package carries: the hash of the kernel's source its Wasm was made from, 64 hex digits, the same in
   * every browser and equal exactly when the kernel is. Record it with a replay to know which solver made it.
   * @throws MargoError (`state`) before `Physics.load()` has finished.
   */
  static get kernelBuild(): string {
    const build = kernelBuild();
    if (!build) throw new MargoError('state', 'The solver is not loaded yet; await Physics.load() first.');
    return build;
  }
  /**
   * Which build of the solver is loaded: `'simd'` (with Wasm SIMD) or `'scalar'` (for engines without it); both step a world to the same bits. Left
   * blank before `Physics.load()` has finished.
   */
  static get kernelVariant(): string {
    return kernelVariant();
  }
  /**
   * Gets the solver ready, once per app: compiling it is asynchronous, so `new Physics(engine)` can stay synchronous.
   * Later calls resolve at once, calls made during a load share it, and a failed load is tried again by the next call.
   * @example await Physics.load();
   * const physics = new Physics(engine);
   * @throws AbortError (the signal's reason) when `signal` aborts first.
   */
  static async load(options: KernelLoadOptions = {}): Promise<void> {
    await loadKernel(options);
  }
  /** Creates the Physics on `engine` (preferred over the constructor). */
  static attach(engine: EngineKernel, options: PhysicsOptions = {}): Physics {
    return new Physics(engine, options);
  }
  /**
   * @throws MargoError (`state`) before {@link Physics.load} has finished.
   * @throws MargoError (`unsupported`) for an option the own solver does not hold yet.
   */
  constructor(engine: EngineKernel | null, options: PhysicsOptions = {}) {
    if ('rapier' in options) throw new TypeError('The own solver takes no rapier option; leave it out.');
    this.name = options.name ?? 'physics';
    this.fixedTimestep = options.fixedTimestep ?? 1 / 60;
    this.maxSubsteps = options.maxSubsteps ?? 4;
    this.film = options.film ?? false;
    this.interpolate = options.interpolate ?? true;
    this.timeScale = options.timeScale ?? 1;
    this.paused = options.paused ?? false;
    if (!(this.fixedTimestep > 0 && this.fixedTimestep <= 1))
      throw new RangeError('fixedTimestep must be in (0, 1] seconds');
    if (!Number.isInteger(this.maxSubsteps) || this.maxSubsteps < 1)
      throw new RangeError('maxSubsteps must be a positive integer');
    const gravity = options.gravity ?? DEFAULT_GRAVITY;
    checkVec(gravity, 'Gravity');
    this.world = new KernelWorld();
    this.world.setGravity(...gravity);
    const filter = options.contactFilter,
      sensorFilter = options.intersectionFilter;
    if (filter || sensorFilter)
      this.world.contactFilter = (a, b) => {
        const first = this.byRow.get(a)!,
          second = this.byRow.get(b)!,
          decide = (first.isSensor() || second.isSensor() ? sensorFilter : undefined) ?? filter;
        return decide ? decide(first.body, second.body) : true;
      };
    this.unitBase = {
      solver: this.world.solver,
      prediction: this.world.predictionDistance,
      sleepEnergy: this.world.sleepEnergy,
      sleepTime: this.world.sleepTime,
    };
    if (options.lengthUnit !== undefined) this.lengthUnit = options.lengthUnit;
    if (options.predictionDistance !== undefined) this.world.setPredictionDistance(options.predictionDistance);
    const modifier = options.contactModifier;
    if (modifier) {
      const world = this.world,
        view = new ContactModification(world);
      this.hasModifier = true;
      world.setContactModifier((row) => {
        const c = world.columns,
          a = this.byRow.get(c.pairA[row]),
          b = this.byRow.get(c.pairB[row]);
        if (!a || !b) return;
        view.row = row;
        view.colliderA = a;
        view.colliderB = b;
        modifier(view);
      });
    }
    const substeps = options.substeps ?? options.solverIterations;
    if (substeps !== undefined) this.world.substeps = substeps;
    if (options.iterations !== undefined) this.world.iterations = options.iterations;
    this.meshes = new MeshSync(this.world, (body) => this.removeBody(body));
    if (engine)
      try {
        engine.use(this);
      } catch (error) {
        this.dispose();
        throw error;
      }
  }

  /** The kernel's world: its columns, `hash`, `snapshot` and `restore`. A preview; it may change while the solver is built. */
  get kernel(): KernelWorld {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    return this.world!;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  private readonly unitBase: {
    solver: Required<KernelSolverOptions>;
    prediction: number;
    sleepEnergy: number;
    sleepTime: number;
  };
  private unit = 1;
  /** The length unit the tolerances follow, 1 for metres; see {@link PhysicsOptions.lengthUnit}. */
  get lengthUnit(): number {
    return this.unit;
  }
  set lengthUnit(unit: number) {
    if (!(unit > 0) || !Number.isFinite(unit))
      throw new RangeError(
        `lengthUnit must be a finite number above 0: 1 for metres, 100 for centimetres (got ${unit}).`,
      );
    const kernel = this.kernel,
      { solver, prediction, sleepEnergy, sleepTime } = this.unitBase;
    this.unit = unit;
    kernel.setPredictionDistance(prediction * unit);
    kernel.setSolver({
      contactMaxPush: solver.contactMaxPush * unit,
      allowedPenetration: solver.allowedPenetration * unit,
      jointMaxPush: solver.jointMaxPush * unit,
    });
    // A body sleeps under this kinetic energy per unit of mass, which is a speed squared.
    kernel.setSleep(sleepEnergy * unit * unit, sleepTime);
    for (const body of this.bodies) if (body.type === 'dynamic') kernel.wake(body.row);
  }
  /** How far apart two shapes may be, in metres, and still have contacts made (default 0.04). */
  get predictionDistance(): number {
    return this.kernel.predictionDistance;
  }
  set predictionDistance(distance: number) {
    this.kernel.setPredictionDistance(distance);
  }
  get gravity(): [number, number, number] {
    return this.kernel.gravity;
  }
  set gravity(value: Vec3) {
    checkVec(value, 'Gravity');
    const kernel = this.kernel,
      old = kernel.gravity;
    kernel.setGravity(value[0], value[1], value[2]);
    // A sleeper would float in the old field: wake it.
    if (old[0] !== value[0] || old[1] !== value[1] || old[2] !== value[2])
      for (const body of this.bodies) if (body.type === 'dynamic') kernel.wake(body.row);
  }
  /** Interpolation factor used by the last `update`: leftover accumulator time over the step length, 0..1. */
  get alpha(): number {
    return this.lastAlpha;
  }
  /** Leftover simulation time in seconds, less than one step. */
  get pendingTime(): number {
    return this.accumulator;
  }
  /** Equal pieces each step is split into (default 8). */
  get substeps(): number {
    return this.kernel.substeps;
  }
  set substeps(substeps: number) {
    this.kernel.substeps = substeps;
  }
  /** How long the phases of the last step took in milliseconds, Rapier's `timingStep` and the others; see {@link KernelWorld.timing}. */
  get timing(): KernelWorld['timing'] {
    return this.kernel.timing;
  }
  /** What work the last step did (awake bodies, islands, pairs, contact points solved, ...), whole numbers that do not depend on the machine; see {@link KernelWorld.counts}. */
  get counts(): KernelWorld['counts'] {
    return this.kernel.counts;
  }
  /** How many continuous-collision passes a step may make, Rapier's `maxCcdSubsteps`: 0 turns CCD off for the world; see {@link KernelWorld.maxCcdSubsteps}. */
  get maxCcdSubsteps(): number {
    return this.kernel.maxCcdSubsteps;
  }
  set maxCcdSubsteps(substeps: number) {
    this.kernel.maxCcdSubsteps = substeps;
  }
  /** The solver settings (contact stiffness, allowed penetration, joint shares); see {@link KernelWorld.setSolver}. */
  get solver(): Required<KernelSolverOptions> {
    return this.kernel.solver;
  }
  /** Tunes the solver from the next step on; leave out what stays. Wakes every dynamic body, so a sleeper meets the new settings. */
  setSolver(options: KernelSolverOptions): this {
    this.kernel.setSolver(options);
    for (const body of this.bodies) if (body.type === 'dynamic') this.kernel.wake(body.row);
    return this;
  }
  /** Solver passes in each substep (default 2). */
  get iterations(): number {
    return this.kernel.iterations;
  }
  set iterations(iterations: number) {
    this.kernel.iterations = iterations;
  }
  /** The old name of {@link Physics.substeps}, kept for one release. */
  get solverIterations(): number {
    return this.substeps;
  }
  set solverIterations(passes: number) {
    this.substeps = passes;
  }
  /**
   * Calls `visit` with each body the last step worked on: the dynamic bodies that are awake and the kinematic ones that
   * moved, in the solver's order. Sleeping and fixed bodies are left out, as Rapier's `forEachActiveRigidBody` leaves them.
   * The list is taken first, so `visit` may change the world; a body it removes is skipped.
   */
  forEachActiveBody(visit: (body: PhysicsBody) => void): void {
    const kernel = this.kernel,
      rows = Array.from(kernel.columns.awake.subarray(0, kernel.awakeCount));
    for (const row of rows) {
      const body = this.byBodyRow.get(row);
      if (body?.valid) visit(body);
    }
  }
  /** How many colliders the world holds. */
  get colliderCount(): number {
    return this.byRow.size;
  }
  get bodyCount(): number {
    return this.bodies.size - (this.anchorBody ? 1 : 0);
  }

  // Engine plugin hooks.
  setup(engine: EngineKernel): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    if (this.engine && this.engine !== engine)
      throw new MargoError('attached', 'Physics is attached to another engine; create one Physics per engine.');
    this.engine = engine;
  }
  /** Steps after the frame's animation and the plugins that move bodies from it (core's `late`): a hit box is on the pose drawn. */
  readonly late = true;
  onPreUpdate(delta: number): void {
    this.update(delta);
  }

  /** Advances the accumulator by `delta` seconds, runs whole fixed steps, then writes interpolated poses to meshes. Returns the number of steps. */
  update(delta: number): number {
    if (this.disposed) return 0;
    if (!Number.isFinite(delta) || delta < 0)
      throw new RangeError('delta must be a finite, non-negative number of seconds');
    let steps = 0;
    if (!this.paused) {
      const dt = this.fixedTimestep;
      this.accumulator += delta * this.timeScale;
      while (this.accumulator + dt * 1e-6 >= dt && (this.film || steps < this.maxSubsteps)) {
        this.step();
        this.accumulator -= dt;
        steps++;
      }
      if (this.accumulator >= dt) this.accumulator %= dt;
      if (this.accumulator < 0) this.accumulator = 0;
      this.lastAlpha = this.interpolate ? this.accumulator / dt : 1;
    }
    this.sync();
    return steps;
  }

  /**
   * Puts the world at frame `frame` of a shot rendered at `rate` frames a second: it has then taken exactly
   * `floor(frame * stepsPerSecond / rate)` steps in all, worked out in integers, whatever calls brought it there, so a shot
   * rendered at 24, 30 or 60 frames a second, at the 24000/1001 of broadcast film, or resumed from a restored snapshot, is the
   * same simulation. The fraction of a step left over is the interpolation `alpha` the meshes are written at. Returns the steps
   * taken. A world already past that frame cannot go back and throws; restore a snapshot instead.
   * @param rate Frames a second as a whole number (24) or the ratio `{num, den}` of two (`{num: 24000, den: 1001}`).
   * @throws MargoError code `state` when the world has taken more steps than that frame allows.
   * @throws RangeError for a frame that is not a non-negative whole number, a rate that is not whole numbers above 0, or a
   * `fixedTimestep` that is not one over a whole number of steps a second (film needs a step that divides the second).
   */
  advance(frame: number, rate: number | { num: number; den: number }): number {
    if (this.disposed) return 0;
    const { steps: target, left } = filmSteps(frame, rate, this.fixedTimestep);
    if (this.stepCount > target)
      throw new MargoError(
        'state',
        `Physics has taken ${this.stepCount} steps and frame ${frame} is step ${target}; a world cannot go back. Restore a snapshot from before the frame.`,
      );
    let taken = 0;
    if (!this.paused) {
      while (this.stepCount < target) {
        this.step();
        taken++;
      }
      this.accumulator = left * this.fixedTimestep;
      this.lastAlpha = this.interpolate ? left : 1;
    }
    this.sync();
    return taken;
  }

  /** Runs exactly one fixed step. Does not touch meshes; call `sync()` to write them. */
  step(): void {
    const kernel = this.kernel,
      dt = this.fixedTimestep;
    this.emit('beforestep', dt);
    if (this.disposed) return;
    this.followers.forEach(this.followMesh);
    this.attachments.forEach(this.attachmentStep);
    kernel.step(dt);
    this.stepCount++;
    this.dispatch(dt);
    this.reportBreaks();
    this.reportQuarantine();
    this.emit('afterstep', dt);
    this.attachments.forEach(this.attachmentAfter);
  }
  private readonly attachmentAfter = (attachment: PhysicsAttachment): void =>
    attachment.afterStep?.(this.fixedTimestep);
  /**
   * Finds what touches what in the world as it stands, with no dynamics: the broad and narrow phases run and `contactstart`,
   * `contactend`, `intersectionstart` and `intersectionend` fire for what began or ended, as in Rapier's `CollisionPipeline`. No body
   * moves, speeds stay, nothing falls asleep and `stepCount` does not change; `contactPair`, `touching` and `contactPoints` then
   * answer for the poses as they stand. Kinematic targets and impulses wait for the next step.
   */
  detectCollisions(): void {
    this.live();
    this.kernel.detect();
    this.dispatch(0);
  }
  private readonly followMesh = (body: PhysicsBody): void => {
    if (body.type !== 'kinematicPosition') return;
    const mesh = body.mesh as CoreMesh;
    try {
      mesh.check();
    } catch {
      this.removeBody(body);
      return;
    }
    const runtime = meshRuntime(mesh),
      m = worldMatrix(runtime.engine.store, runtime.id, this.parentScratch),
      q = this.parentRotation;
    matrixRotation(m, q);
    body.setNextPosition([m[12]!, m[13]!, m[14]!]);
    body.setNextRotation(q as unknown as Quat);
  };
  private reported = 0;
  private reportQuarantine(): void {
    const kernel = this.kernel;
    if (kernel.quarantinedCount === this.reported) return;
    this.reported = kernel.quarantinedCount;
    for (const row of kernel.quarantinedBodies()) {
      const body = this.byBodyRow.get(row);
      if (body && !this.quarantinedBodies.has(body)) {
        this.quarantinedBodies.add(body);
        this.emit('quarantine', { type: 'quarantine', body });
      }
    }
  }
  private readonly quarantinedBodies = new Set<PhysicsBody>();
  /** The bodies taken out of the world for leaving the numbers (the `quarantine` solver option), in the order it happened. */
  get quarantined(): readonly PhysicsBody[] {
    return [...this.quarantinedBodies];
  }
  private reportBreaks(): void {
    let found: PhysicsJoint[] | null = null;
    for (const joint of this.joints)
      if (joint.watched && !joint.reported && joint.broken) {
        joint.reported = true;
        (found ??= []).push(joint);
      }
    if (found)
      for (const joint of found)
        this.emit('jointbreak', { type: 'jointbreak', joint, bodyA: joint.bodyA, bodyB: joint.bodyB });
  }
  private readonly attachmentStep = (attachment: PhysicsAttachment): void =>
    attachment.beforeStep?.(this.fixedTimestep);
  /** Reads what the step found into events, then calls listeners: one may change the world, so nothing is read after one runs. */
  private dispatch(dt: number): void {
    const outer = this.dispatching,
      events = outer ? [] : this.eventBuffer;
    this.gatherEvents(events);
    this.gatherForces(events, dt);
    this.dispatching = true;
    try {
      for (let i = 0; i < events.length; i++) this.emit(events[i].type, events[i] as never);
    } finally {
      this.dispatching = outer;
      events.length = 0;
    }
  }
  private gatherEvents(events: (CollisionEvent | ContactForceEvent)[]): void {
    const kernel = this.kernel,
      words = kernel.columns.events,
      count = kernel.eventCount;
    for (let i = 0; i < count; i++) {
      const first = words[2 * i],
        colliderA = this.byRow.get(first & EVENT_COLLIDER) ?? this.retired.get(first & EVENT_COLLIDER),
        colliderB =
          this.byRow.get(words[2 * i + 1] & EVENT_COLLIDER) ?? this.retired.get(words[2 * i + 1] & EVENT_COLLIDER);
      if (!colliderA || !colliderB || !(colliderA.emits || colliderB.emits)) continue;
      const sensor = (first & EVENT_SENSOR) !== 0,
        started = first >>> 31 !== 0,
        bodyA = colliderA.body,
        bodyB = colliderB.body;
      events.push({
        type: sensor ? (started ? 'intersectionstart' : 'intersectionend') : started ? 'contactstart' : 'contactend',
        bodyA,
        bodyB,
        meshA: bodyA.mesh,
        meshB: bodyB.mesh,
        colliderA,
        colliderB,
        sensor,
        ...(words[2 * i + 1] & EVENT_REMOVED ? { removed: true } : {}),
      });
    }
    this.retired.clear();
    kernel.clearEvents();
  }
  private gatherForces(events: (CollisionEvent | ContactForceEvent)[], dt: number): void {
    if (!this.listeners.get('contactforce')?.size) return;
    const kernel = this.kernel,
      c = kernel.columns,
      { solvePairs, pairA, pairB, pairFlags } = kernel.columns,
      count = kernel.solvingPairs;
    // A mesh pair is solved as one part a triangle: its event sums them, as one pair of colliders felt one push.
    let meshed: Map<number, ForceSum> | null = null;
    for (let i = 0; i < count; i++) {
      const row = solvePairs[i];
      if (!(pairFlags[row] & PAIR_IS_PART)) continue;
      meshed ??= new Map();
      const key = pairA[row] * 0x400000 + pairB[row],
        sum = meshed.get(key) ?? { impulse: 0, x: 0, y: 0, z: 0, max: 0, mx: 0, my: 0, mz: 0 };
      this.addForce(sum, row, c);
      meshed.set(key, sum);
    }
    for (let i = 0; i < count; i++) {
      const row = solvePairs[i],
        key = pairA[row] * 0x400000 + pairB[row];
      let sum: ForceSum;
      if (meshed && pairFlags[row] & PAIR_IS_PART) {
        sum = meshed.get(key) ?? { impulse: 0, x: 0, y: 0, z: 0, max: 0, mx: 0, my: 0, mz: 0 };
        // The first part of the pair speaks; the rest are in its sum.
        meshed.delete(key);
      } else this.addForce((sum = { impulse: 0, x: 0, y: 0, z: 0, max: 0, mx: 0, my: 0, mz: 0 }), row, c);
      const impulse = sum.impulse,
        colliderA = this.byRow.get(pairA[row]),
        colliderB = this.byRow.get(pairB[row]);
      if (!(impulse > 0) || !colliderA || !colliderB) continue;
      if (!(colliderA.forceEvents || colliderB.forceEvents)) continue;
      const threshold =
        colliderA.forceThreshold > colliderB.forceThreshold ? colliderA.forceThreshold : colliderB.forceThreshold;
      if (impulse / dt <= threshold) continue;
      const bodyA = colliderA.body,
        bodyB = colliderB.body,
        peak = root(sum.mx * sum.mx + sum.my * sum.my + sum.mz * sum.mz);
      events.push({
        type: 'contactforce',
        bodyA,
        bodyB,
        meshA: bodyA.mesh,
        meshB: bodyB.mesh,
        colliderA,
        colliderB,
        impulse,
        force: impulse / dt,
        totalForce: [sum.x / dt, sum.y / dt, sum.z / dt],
        totalForceMagnitude: root(sum.x * sum.x + sum.y * sum.y + sum.z * sum.z) / dt,
        maxForceMagnitude: sum.max / dt,
        maxForceDirection: peak > 0 ? [sum.mx / peak, sum.my / peak, sum.mz / peak] : [0, 0, 0],
      });
    }
  }
  /**
   * Adds a solved pair row to a force sum: its normal impulse over the step, its contacts' pushes (along the normal and
   * along the surface, as the last substep gave them) scaled so their normal parts add up to that impulse, and the
   * strongest of them.
   */
  private addForce(sum: ForceSum, row: number, c: KernelWorld['columns']): void {
    const first = row * 4,
      points = c.pairContacts[row],
      nx = c.pairNormalX[row],
      ny = c.pairNormalY[row],
      nz = c.pairNormalZ[row];
    let pressed = 0;
    for (let k = 0; k < points; k++) pressed += c.contactNormalImpulse[first + k];
    const impulse = c.pairForce[row],
      scale = pressed > 0 ? impulse / pressed : 0;
    sum.impulse += impulse;
    for (let k = 0; k < points; k++) {
      const at = first + k,
        pn = c.contactNormalImpulse[at],
        x = (nx * pn + c.contactTangentX[at]) * scale,
        y = (ny * pn + c.contactTangentY[at]) * scale,
        z = (nz * pn + c.contactTangentZ[at]) * scale,
        size = root(x * x + y * y + z * z);
      sum.x += x;
      sum.y += y;
      sum.z += z;
      if (size > sum.max) [sum.max, sum.mx, sum.my, sum.mz] = [size, x, y, z];
    }
  }

  /** Writes body poses to their meshes, interpolated by `alpha` between the last two steps. Allocates nothing. */
  sync(alpha = this.lastAlpha): void {
    if (this.disposed) return;
    if (!Number.isFinite(alpha))
      throw new RangeError('Interpolation alpha must be a finite number; pass a value from 0 to 1.');
    this.meshes.write(!this.interpolate || alpha > 1 ? 1 : alpha < 0 ? 0 : alpha);
    this.attachments.forEach(attachmentSync);
  }

  /**
   * Creates a rigid body, optionally driving `mesh`. Physics works in world space: the body starts at the mesh's world
   * pose, and each frame the interpolated world pose is written to the mesh's position and rotation (relative to its
   * parent for a child mesh, using the parent's current world transform, so there is no frame of lag). Scale is never
   * written.
   * @throws MargoError (`unsupported`) for an option the own solver does not hold yet.
   */
  addBody(mesh: Mesh | null, options: BodyOptions = {}): PhysicsBody {
    const kernel = this.kernel,
      type: BodyType = options.type ?? 'dynamic';
    if (!['dynamic', 'fixed', 'kinematicPosition', 'kinematicVelocity'].includes(type))
      throw new TypeError(`Unknown body type ${type}; use dynamic, fixed, kinematicPosition or kinematicVelocity.`);
    if (mesh && this.byMesh.has(mesh))
      throw new MargoError('state', 'This mesh already has a physics body; remove it first or use the existing body.');
    if (options.follow) {
      if (type !== 'kinematicPosition')
        throw new TypeError("A body with follow must be a 'kinematicPosition' body; the mesh is what moves it.");
      if (!(mesh instanceof CoreMesh)) throw new TypeError('A body with follow needs a core Mesh to follow.');
    }
    const start = mesh ? meshPose(mesh, this.engine) : null,
      position = options.position ?? start?.position ?? [0, 0, 0],
      rotation: Quat = options.rotation ?? start?.rotation ?? [0, 0, 0, 1];
    checkVec(position, 'Position');
    checkRotation(rotation);
    if (options.linearVelocity) checkVec(options.linearVelocity, 'linearVelocity');
    if (options.angularVelocity) checkVec(options.angularVelocity, 'angularVelocity');
    const row = kernel.addBody(type),
      body = new PhysicsBody(this, row, mesh, type),
      columns = kernel.columns;
    kernel.setPose(row, position, rotation);
    if (options.linearVelocity) body.setLinearVelocity(options.linearVelocity);
    if (options.angularVelocity) body.setAngularVelocity(options.angularVelocity);
    if (options.linearDamping !== undefined) columns.linearDamping[row] = options.linearDamping;
    if (options.angularDamping !== undefined) columns.angularDamping[row] = options.angularDamping;
    if (options.maxLinearSpeed !== undefined) body.maxLinearSpeed = options.maxLinearSpeed;
    if (options.maxAngularSpeed !== undefined) body.maxAngularSpeed = options.maxAngularSpeed;
    if (options.gravityScale !== undefined) columns.gravityScale[row] = options.gravityScale;
    if (options.dominance !== undefined) columns.dominance[row] = options.dominance;
    if (options.canSleep !== undefined) kernel.setCanSleep(row, options.canSleep);
    if (options.ccd) kernel.setCcd(row, true);
    if (options.softCcdPrediction !== undefined) body.softCcdPrediction = options.softCcdPrediction;
    if (options.additionalMass !== undefined) columns.additionalMass[row] = options.additionalMass;
    const angular = options.lockRotations ? 7 : options.enabledRotations ? bits(options.enabledRotations) : 0,
      linear = options.lockTranslations ? 7 : options.enabledTranslations ? bits(options.enabledTranslations) : 0;
    kernel.setLocks(row, { linear, angular });
    body.userData = options.userData;
    body.fitScale = start?.fitScale;
    // A pose taken from the mesh is already on the mesh; writing it back would only round a child's transform.
    if (mesh && !options.position && !options.rotation) body.dirty = false;
    this.bodies.add(body);
    this.byBodyRow.set(row, body);
    if (options.follow) {
      body.follow = true;
      this.followers.add(body);
    } else this.meshes.add(body);
    if (mesh) this.byMesh.set(mesh, body);
    const colliders =
      options.colliders === undefined
        ? mesh
          ? [{ shape: 'box' } as ColliderOptions]
          : []
        : Array.isArray(options.colliders)
          ? options.colliders
          : [options.colliders as ColliderOptions];
    try {
      for (const collider of colliders) this.addCollider(body, collider);
    } catch (error) {
      this.removeBody(body);
      throw error;
    }
    kernel.updateMass(row);
    if (options.sleeping) kernel.sleep(row);
    return body;
  }

  /** The body of a mesh, if it has one. */
  bodyOf(mesh: Mesh): PhysicsBody | undefined {
    return this.byMesh.get(mesh);
  }
  /** The body a collider or its handle belongs to. */
  bodyOfCollider(collider: PhysicsCollider | number): PhysicsBody | undefined {
    return this.byRow.get(typeof collider === 'number' ? collider : collider.handle)?.body;
  }
  /** True when the own solver holds this shape. */
  supportsShape(shape: ShapeOptions['shape']): boolean {
    return shapeServed(shape);
  }
  getBodies(): PhysicsBody[] {
    return [...this.bodies].filter((body) => body !== this.anchorBody);
  }

  /** The fixed body at the origin that free colliders sit on; made with the first one, and counted as no body of the caller's. */
  private anchorBody: PhysicsBody | null = null;
  private anchor(): PhysicsBody {
    return (this.anchorBody ??= this.addBody(null, { type: 'fixed', colliders: [] }));
  }
  /**
   * Adds a collider that belongs to no body of yours (Rapier's `createCollider` with no parent), in world coordinates: `position` and
   * `rotation` in its options are the world's. It sits on a fixed body at the origin the world keeps for them, so it is fixed,
   * pushes dynamic bodies and has no mass of its own to give; `collider.parent` is null and `collider.free` is true.
   * @throws MargoError (`disposed`) on a disposed world.
   */
  addFreeCollider(options: ColliderOptions): PhysicsCollider {
    this.live();
    const collider = this.addCollider(this.anchor(), options);
    collider.free = true;
    return collider;
  }
  /** @internal use `body.addCollider`. */
  addCollider(body: PhysicsBody, options: ColliderOptions): PhysicsCollider {
    const { mesh } = body,
      fitted =
        (options.shape === 'box' && !options.halfExtents) ||
        (options.shape === 'sphere' && options.radius === undefined) ||
        (options.shape === 'convexHull' && !options.points && !options.geometry) ||
        (options.shape === 'trimesh' && !options.vertices && !options.geometry),
      fit =
        mesh && fitted
          ? colliderGeometry(mesh, body.fitScale)
          : {
              geometry: null,
              scale: mesh ? ([mesh.scale.x, mesh.scale.y, mesh.scale.z] as const) : ([1, 1, 1] as const),
            };
    if (body.fitScale && mesh?.geometry) fit.scale = body.fitScale;
    const { name, shape, size, parts, data, options: placed } = kernelCollider(options, fit, this.hulls),
      row = parts
        ? this.kernel.addCompound(body.row, parts, placed)
        : this.kernel.addCollider(body.row, shape as KernelShape, size, placed),
      collider = new PhysicsCollider(this.kernel, row, body, name);
    if (parts && 'fixInternalEdges' in options && options.fixInternalEdges) this.kernel.fixCompoundEdges(row);
    if (options.collisionGroups !== undefined) writeGroups(this.kernel, row, options.collisionGroups, false);
    if (options.solverGroups !== undefined) writeGroups(this.kernel, row, options.solverGroups, true);
    if (options.sensor || options.enabled === false)
      this.kernel.setColliderState(
        row,
        (options.sensor ? COLLIDER_SENSOR : 0) | (options.enabled === false ? COLLIDER_OFF : 0),
      );
    collider.data = data;
    collider.reshape = (next) => this.reshapeCollider(body, collider, next);
    collider.userData = options.userData;
    collider.emits = options.events ?? true;
    collider.forceEvents = options.contactForceEvents ?? true;
    collider.forceThreshold = options.contactForceThreshold ?? 0;
    // A round triangle meets what it touches a border away: its contacts are made with that skin, its queries with the border.
    const skin = (options.contactSkin ?? 0) + (options.shape === 'triangle' ? (placed.border ?? 0) : 0);
    if (skin > 0) collider.setContactSkin(skin);
    if (options.contactForceThreshold !== undefined)
      collider.setContactForceEventThreshold(options.contactForceThreshold);
    if (options.activeCollisionTypes) collider.setActiveCollisionTypes(options.activeCollisionTypes);
    if (options.activeHooks) collider.setActiveHooks(options.activeHooks);
    if (options.massProperties && !options.massless) {
      const own = options.massProperties;
      collider.setMassProperties(own.mass, own.centerOfMass, own.principalInertia, own.inertiaFrame);
    }
    if (options.modifyContacts) {
      if (!this.hasModifier)
        throw new MargoError('state', 'modifyContacts needs a contactModifier: pass one in the Physics options.');
      this.kernel.setColliderState(row, this.kernel.columns.colliderFlags[row] | COLLIDER_MODIFY);
    }
    body.colliders.push(collider);
    this.byRow.set(row, collider);
    return collider;
  }
  /** @internal use `collider.setShape`. */
  private reshapeCollider(body: PhysicsBody, collider: PhysicsCollider, options: ColliderOptions): void {
    const { mesh } = body,
      fitted =
        (options.shape === 'box' && !options.halfExtents) ||
        (options.shape === 'sphere' && options.radius === undefined) ||
        (options.shape === 'convexHull' && !options.points && !options.vertices && !options.geometry),
      fit =
        mesh && fitted
          ? colliderGeometry(mesh, body.fitScale)
          : {
              geometry: null,
              scale: mesh ? ([mesh.scale.x, mesh.scale.y, mesh.scale.z] as const) : ([1, 1, 1] as const),
            };
    if (body.fitScale && mesh?.geometry) fit.scale = body.fitScale;
    const { name, shape, size, parts, options: placed } = kernelCollider(options, fit, this.hulls);
    if (parts)
      throw new MargoError(
        'unsupported',
        'A collider cannot become a compound; remove it and add a compound collider to the body.',
      );
    const row = collider.handle;
    this.kernel.setColliderShape(row, shape as KernelShape, size);
    this.kernel.setColliderPose(row, placed.position ?? [0, 0, 0], placed.rotation ?? [0, 0, 0, 1]);
    if (placed.border) this.kernel.setColliderBorder(row, placed.border);
    if (options.shape === 'triangle') collider.setContactSkin((options.contactSkin ?? 0) + (placed.border ?? 0));
    if (options.mass !== undefined || options.density !== undefined || options.massless) {
      this.kernel.columns.colliderDensity[row] = placed.density ?? 0;
      this.kernel.updateMass(body.row);
    }
    collider.shape = name;
  }
  /** @internal use `body.removeCollider`. */
  removeCollider(body: PhysicsBody, collider: PhysicsCollider): void {
    const index = body.colliders.indexOf(collider);
    if (index < 0)
      throw new MargoError('state', 'Collider does not belong to this body; pass a collider from body.colliders.');
    body.colliders.splice(index, 1);
    this.byRow.delete(collider.handle);
    this.retired.set(collider.handle, collider);
    this.kernel.removeCollider(collider.handle);
    collider.markRemoved();
  }

  /** Removes a body with its colliders and joints. */
  removeBody(body: PhysicsBody, options: { keepColliders?: boolean } = {}): void {
    if (!this.bodies.has(body)) return;
    if (options.keepColliders) this.freeColliders(body);
    for (const attachment of [...this.attachments]) attachment.bodyRemoved?.(body);
    for (const multibody of this.multibodies)
      if (multibody.root === body || multibody.links.some((link) => link.body === body))
        this.removeMultibody(multibody);
    for (const joint of this.joints) if (joint.bodyA === body || joint.bodyB === body) this.removeJoint(joint);
    for (const collider of body.colliders) {
      this.byRow.delete(collider.handle);
      this.retired.set(collider.handle, collider);
    }
    this.bodies.delete(body);
    this.byBodyRow.delete(body.row);
    this.followers.delete(body);
    this.meshes.remove(body);
    if (body.mesh) this.byMesh.delete(body.mesh);
    this.kernel.removeBody(body.row);
    body.markRemoved();
  }
  /** @internal use `body.joints()`. */
  jointsOf(body: PhysicsBody): PhysicsJoint[] {
    return [...this.joints].filter((joint) => joint.bodyA === body || joint.bodyB === body);
  }
  /** Hands a body's colliders to the world, where they stay at the poses they have now, as free colliders. */
  private freeColliders(body: PhysicsBody): void {
    const anchor = this.anchor(),
      position = body.position,
      rotation = body.rotation;
    for (const collider of body.colliders) {
      const local = collider.translationWrtParent(),
        turn = collider.rotationWrtParent(),
        offset = rotateVec(rotation, [local.x, local.y, local.z]);
      this.kernel.moveCollider(
        collider.handle,
        anchor.row,
        [position[0] + offset[0], position[1] + offset[1], position[2] + offset[2]],
        multiplyQuat(rotation, [turn.x, turn.y, turn.z, turn.w]),
      );
      collider.reparent(anchor);
      collider.free = true;
      anchor.colliders.push(collider);
    }
    body.colliders.length = 0;
  }
  /** @internal use `body.setTranslation` and the like: the mesh follows at the next sync. */
  moved(body: PhysicsBody): void {
    this.meshes.mark(body);
  }
  owns(body: PhysicsBody): boolean {
    return this.bodies.has(body);
  }
  /** @internal Registers a helper that steps and syncs with the world. */
  attach(attachment: PhysicsAttachment): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    this.attachments.add(attachment);
  }
  /** @internal Unregisters a helper; returns false when it was not attached. */
  detach(attachment: PhysicsAttachment): boolean {
    return this.attachments.delete(attachment);
  }

  /** Subscribes to step and contact events. Returns an unsubscribe function. */
  on<K extends keyof PhysicsEventMap>(type: K, listener: (event: PhysicsEventMap[K]) => void): () => void {
    if (this.disposed) return noop;
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
    };
  }
  private emit<K extends keyof PhysicsEventMap>(type: K, event: PhysicsEventMap[K]): void {
    // Listeners removed during dispatch are skipped; listeners added during dispatch also run for this event.
    this.listeners.get(type)?.forEach(callListener, event);
  }

  /**
   * Colliders for a whole glTF model (gltf/pbr `PBRModel`, or a @margoengine/materials mesh) in one call: one collider
   * per primitive (per instance for instanced primitives), built from its triangles with every node, instance and scale
   * transform of the hierarchy applied. By default one body on `model.root` holds them all (a level, or a prop that
   * moves as one); `perNode: true` gives each node with primitives its own body instead (hits and events then report
   * that node, and dynamic nodes move on their own). Returns the new bodies; after an error none are kept.
   */
  addModel(model: ModelLike, options: ModelBodyOptions = {}): PhysicsBody[] {
    const { shape: requested, perNode = false, filter, collider = {}, ...bodyOptions } = options;
    const type: BodyType = bodyOptions.type ?? 'dynamic',
      shape = requested ?? (type === 'dynamic' ? 'convexHull' : 'trimesh');
    if (shape !== 'trimesh' && shape !== 'convexHull' && shape !== 'convexDecomposition')
      throw new TypeError(
        `Model colliders must be 'trimesh', 'convexHull' or 'convexDecomposition', not ${String(shape)}; choose one of them.`,
      );
    if (!model?.root || !Array.isArray(model.primitives))
      throw new TypeError('addModel needs a gltf/pbr model (root and primitives)');
    const groups = new Map<Mesh, ModelPrimitiveLike[]>();
    for (const primitive of model.primitives) {
      if (filter && !filter(primitive)) continue;
      const anchor = perNode ? primitive.node : model.root;
      let list = groups.get(anchor);
      if (!list) groups.set(anchor, (list = []));
      list.push(primitive);
    }
    const created: PhysicsBody[] = [],
      anchorMatrix = new Float64Array(16),
      nodeMatrix = new Float64Array(16),
      instanceMatrix = new Float64Array(16),
      q = [0, 0, 0, 1];
    try {
      for (const [anchor, primitives] of groups) {
        anchor.check();
        const anchorRuntime = meshRuntime(anchor);
        worldMatrix(anchorRuntime.engine.store, anchorRuntime.id, anchorMatrix);
        matrixRotation(anchorMatrix, q);
        // Body space = world space under the inverse of the anchor's rigid pose (position and rotation; scale is baked in).
        const px = anchorMatrix[12],
          py = anchorMatrix[13],
          pz = anchorMatrix[14],
          qx = q[0],
          qy = q[1],
          qz = q[2],
          qw = q[3];
        const r00 = 1 - 2 * (qy * qy + qz * qz),
          r10 = 2 * (qx * qy + qw * qz),
          r20 = 2 * (qx * qz - qw * qy);
        const r01 = 2 * (qx * qy - qw * qz),
          r11 = 1 - 2 * (qx * qx + qz * qz),
          r21 = 2 * (qy * qz + qw * qx);
        const r02 = 2 * (qx * qz + qw * qy),
          r12 = 2 * (qy * qz - qw * qx),
          r22 = 1 - 2 * (qx * qx + qy * qy);
        const colliders: ColliderOptions[] = [];
        for (const primitive of primitives) {
          const node = meshRuntime(primitive.node),
            v = primitive.vertices,
            count = v.length / 20,
            instances = primitive.instances;
          worldMatrix(node.engine.store, node.id, nodeMatrix);
          for (let k = 0; k < (instances ? instances.count : 1); k++) {
            const m = instances
                ? multiplyMatrices(nodeMatrix, instances.data.subarray(k * 24, k * 24 + 16), instanceMatrix)
                : nodeMatrix,
              points = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
              const x = v[i * 20],
                y = v[i * 20 + 1],
                z = v[i * 20 + 2];
              const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - px,
                wy = m[1] * x + m[5] * y + m[9] * z + m[13] - py,
                wz = m[2] * x + m[6] * y + m[10] * z + m[14] - pz;
              points[i * 3] = r00 * wx + r10 * wy + r20 * wz;
              points[i * 3 + 1] = r01 * wx + r11 * wy + r21 * wz;
              points[i * 3 + 2] = r02 * wx + r12 * wy + r22 * wz;
            }
            colliders.push(
              shape === 'convexHull'
                ? { ...collider, shape, points }
                : { ...collider, shape, vertices: points, indices: primitive.indices },
            );
          }
        }
        created.push(
          this.addBody(anchor, { ...bodyOptions, type, position: [px, py, pz], rotation: [qx, qy, qz, qw], colliders }),
        );
        // The pose came from the mesh: nothing to write back until the body moves.
        created[created.length - 1]!.dirty = false;
      }
    } catch (error) {
      for (const body of created) this.removeBody(body);
      throw error;
    }
    return created;
  }

  /**
   * Connects two bodies with a fixed, spherical, revolute or prismatic joint. Anchors are in each body's local frame.
   * @throws MargoError (`state`) unless both bodies belong to this world and are two bodies.
   * @throws MargoError (`unsupported`) for a kind the own solver does not hold yet.
   */
  addJoint(bodyA: PhysicsBody, bodyB: PhysicsBody, options: NextJointOptions): PhysicsJoint {
    if (!this.bodies.has(bodyA) || !this.bodies.has(bodyB))
      throw new MargoError(
        'state',
        'Both bodies must belong to this physics world; add them with physics.addBody first.',
      );
    if (bodyA === bodyB)
      throw new MargoError('state', 'A joint needs two different bodies; pass bodyA and bodyB that are not the same.');
    const joint = createJoint(this, bodyA, bodyB, options);
    this.joints.add(joint);
    return joint;
  }
  /**
   * Holds a tree of bodies to reduced coordinates, Rapier's multibody joints: the `root` and `links`, each link a body, the body
   * it hangs from (default the link before it) and a joint of locks (`fixed`, `revolute`, `prismatic`, `spherical` or
   * `generic`) between them. The joints are made here and are ordinary joints too, with their limits and motors; the tree
   * holds them exactly, so they cannot drift open and a branch is as stiff as a chain.
   * @throws MargoError (`state`) for a body in another multibody, a parent not in the tree yet, or a loop.
   * @throws RangeError for a tree with no link.
   */
  addMultibody(root: PhysicsBody, links: readonly MultibodyLinkOptions[]): Multibody {
    for (const body of [
      root,
      ...links.map((link) => link.body),
      ...links.flatMap((link) => (link.parent ? [link.parent] : [])),
    ])
      if (!this.bodies.has(body))
        throw new MargoError(
          'state',
          'Every body of a multibody must belong to this physics world; add it with physics.addBody first.',
        );
    const multibody = buildMultibody(this, root, links);
    this.multibodies.add(multibody);
    return multibody;
  }
  /** @internal use `multibody.remove`. */
  removeMultibody(multibody: Multibody): void {
    if (!this.multibodies.delete(multibody)) return;
    clearMultibody(this.kernel, multibody);
    multibody.markRemoved();
  }
  /** @internal The length of one substep, over which a joint's impulses are taken. */
  get substepLength(): number {
    return this.fixedTimestep / this.kernel.substeps;
  }
  /** @internal */
  holdsMultibody(joint: PhysicsJoint): boolean {
    for (const multibody of this.multibodies) if (multibody.links.some((link) => link.joint === joint)) return true;
    return false;
  }
  /** Wakes every body of the world that sleeps, Rapier's `wake_up_all`. */
  wakeUpAll(): this {
    for (const body of this.bodies) this.kernel.wake(body.row);
    return this;
  }
  /** Every joint in the world, in the order they were added. */
  getJoints(): PhysicsJoint[] {
    return [...this.joints];
  }
  /** How many joints the world holds. */
  get jointCount(): number {
    return this.joints.size;
  }
  /** @internal use `joint.remove`. */
  removeJoint(joint: PhysicsJoint): void {
    if (!this.joints.delete(joint)) return;
    for (const multibody of this.multibodies)
      if (multibody.links.some((link) => link.joint === joint)) this.removeMultibody(multibody);
    this.kernel.removeJoint(joint.row);
    joint.markRemoved();
  }
  /**
   * A kinematic character controller for a `kinematicPosition` body whose first collider is a sphere, box, capsule,
   * cylinder or cone. Call `move` once per fixed step, for example from `beforestep`.
   * @throws MargoError (`state`) unless the body belongs to this world.
   * @throws TypeError unless the body is `kinematicPosition` with a collider.
   */
  createCharacterController(body: PhysicsBody, options: CharacterControllerOptions = {}): CharacterController {
    this.live();
    if (!this.bodies.has(body))
      throw new MargoError('state', 'The body must belong to this physics world; add it with physics.addBody first.');
    const controller = new CharacterController(this, body, options);
    this.controllers.add(controller);
    return controller;
  }
  /** @internal use `controller.dispose`. */
  removeController(controller: CharacterController): void {
    this.controllers.delete(controller);
  }
  /**
   * A controller for a dynamic body that keeps it upright with a stable proportional-derivative torque and walks it at a target velocity
   * over the ground, jumps and rides platforms: a character the solver pushes and knocks about, in place of the kinematic one. Call
   * `update()` once per fixed step, for example from `beforestep`.
   * @throws MargoError (`state`) unless the body belongs to this world.
   * @throws TypeError unless the body is `dynamic` with a collider.
   */
  createDynamicCharacter(body: PhysicsBody, options: DynamicCharacterOptions = {}): DynamicCharacter {
    this.live();
    if (!this.bodies.has(body))
      throw new MargoError('state', 'The body must belong to this physics world; add it with physics.addBody first.');
    const character = new DynamicCharacter(this, body, options);
    this.dynamicCharacters.add(character);
    return character;
  }
  /** @internal use `character.dispose`. */
  removeDynamicCharacter(character: DynamicCharacter): void {
    this.dynamicCharacters.delete(character);
  }
  /** The kernel's filter words for a query filter: flags, groups, collider row and body row to leave out. */
  private filterWords(filter: QueryFilter): [number, number, number, number] {
    let flags = 0;
    if (filter.excludeFixed) flags |= QUERY_EXCLUDE_FIXED;
    if (filter.excludeKinematic) flags |= QUERY_EXCLUDE_KINEMATIC;
    if (filter.excludeDynamic) flags |= QUERY_EXCLUDE_DYNAMIC;
    if (filter.excludeSensors) flags |= QUERY_EXCLUDE_SENSORS;
    if (filter.excludeSolids) flags |= QUERY_EXCLUDE_SOLIDS;
    if (filter.onlyDynamic) flags |= QUERY_ONLY_DYNAMIC;
    if (filter.onlyKinematic) flags |= QUERY_ONLY_KINEMATIC;
    if (filter.onlyFixed) flags |= QUERY_ONLY_FIXED;
    if (filter.groups === undefined) flags |= QUERY_NO_GROUPS;
    let groups = 0xffffffff;
    if (typeof filter.groups === 'number') groups = filter.groups >>> 0;
    else if (filter.groups) {
      const words = groupWords(filter.groups);
      groups = words.packed;
      flags |= QUERY_WIDE_GROUPS | (words.or ? QUERY_GROUPS_OR : 0);
      this.kernel.setQueryGroupsHi(words.hi);
    }
    const collider = filter.excludeCollider ? filter.excludeCollider.handle : NONE;
    const body = filter.exclude ? filter.exclude.row : NONE;
    return [flags, groups, collider, body];
  }
  private rayHit(hit: KernelRayHit): RaycastHit | null {
    const collider = this.byRow.get(hit.collider),
      found = collider
        ? {
            body: collider.body,
            mesh: collider.body.mesh,
            collider,
            distance: hit.distance,
            point: hit.point,
            normal: hit.normal,
          }
        : null;
    return found && collider ? this.withFeatures(found, collider, hit.point) : null;
  }
  /** Gives a hit `featureType` and `featureId`, worked out when first read. */
  private withFeatures<T extends object>(hit: T, collider: PhysicsCollider, point: [number, number, number]): T {
    let found: Feature | null = null;
    const feature = (): Feature => (found ??= featureAt(this.kernel, collider, point));
    return Object.defineProperties(hit, {
      featureType: { get: () => feature().type, enumerable: true },
      featureId: { get: () => feature().id, enumerable: true },
    });
  }
  private passes(hit: RaycastHit, predicate: QueryFilter['predicate']): boolean {
    return !predicate || predicate(hit.body, hit.collider);
  }
  /**
   * The first hit along a ray, or null. Queries see the poses of the last step, as Rapier's do.
   * @throws RangeError for an origin or direction that is not three finite numbers, or a zero direction.
   */
  raycast(origin: Vec3, direction: Vec3, options: PhysicsRaycastOptions = {}): RaycastHit | null {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    const max = options.maxDistance ?? Infinity,
      solid = options.solid ?? true,
      words = this.filterWords(options);
    if (options.predicate) {
      let best: RaycastHit | null = null;
      for (const raw of this.kernel.raycastAll(origin, direction, max, solid, ...words)) {
        const hit = this.rayHit(raw);
        if (hit && this.passes(hit, options.predicate) && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    }
    const raw = this.kernel.raycast(origin, direction, max, solid, ...words);
    return raw ? this.rayHit(raw) : null;
  }
  /**
   * Every hit along a ray, nearest first: one a collider. Return false from `options.stop` to end the list there.
   * @throws RangeError for an origin or direction that is not three finite numbers, or a zero direction.
   */
  raycastAll(
    origin: Vec3,
    direction: Vec3,
    options: PhysicsRaycastOptions & { stop?: (hit: RaycastHit) => boolean } = {},
  ): RaycastHit[] {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
    const hits: RaycastHit[] = [];
    for (const raw of this.kernel.raycastAll(
      origin,
      direction,
      options.maxDistance ?? Infinity,
      options.solid ?? true,
      ...this.filterWords(options),
    )) {
      const hit = this.rayHit(raw);
      if (hit && this.passes(hit, options.predicate)) hits.push(hit);
    }
    hits.sort(byDistance);
    if (options.stop) for (let i = 0; i < hits.length; i++) if (!options.stop(hits[i]!)) return hits.slice(0, i + 1);
    return hits;
  }
  private castHit(hit: KernelShapeCastHit): ShapeCastHit | null {
    const collider = this.byRow.get(hit.collider);
    return collider
      ? {
          body: collider.body,
          mesh: collider.body.mesh,
          collider,
          distance: hit.distance,
          point: hit.point,
          normal: hit.normal,
          queryPoint: hit.queryPoint,
          queryNormal: hit.queryNormal,
        }
      : null;
  }
  private live(): void {
    if (this.disposed) throw new MargoError('disposed', 'Physics is disposed; create a new Physics.');
  }
  /**
   * Sweeps a convex shape (sphere, box, capsule, cylinder, cone or convexHull, with its size given) from `position` and
   * `rotation` along `direction` and returns the first collider it touches, or null. `distance` is along the direction's
   * unit. Queries see the poses of the last step, as Rapier's do.
   * @throws RangeError for a position, rotation or direction that is not finite, or a zero direction; MargoError
   * `unsupported` for another query shape.
   */
  shapeCast(
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat,
    direction: Vec3,
    options: PhysicsShapeCastOptions = {},
  ): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    checkVec(direction, 'Cast direction');
    this.live();
    const parts = queryParts(shape);
    if (parts) {
      // A compound is cast piece by piece: the first touch is the nearest of its pieces'.
      let best: ShapeCastHit | null = null;
      for (const part of parts) {
        const moved = turn(rotation, part.offset),
          hit = this.shapeCast(
            part.shape,
            [position[0] + moved[0], position[1] + moved[1], position[2] + moved[2]],
            multiply(rotation, part.rotation),
            direction,
            options,
          );
        if (hit && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    }
    const query = queryShape(shape, this.hulls),
      cast = {
        max: options.maxDistance ?? Infinity,
        target: options.targetDistance ?? 0,
        stop: options.stopAtPenetration ?? true,
        geometry: options.computeImpactGeometryOnPenetration ?? true,
      },
      words = this.filterWords(options);
    if (options.predicate) {
      let best: ShapeCastHit | null = null;
      for (const raw of this.kernel.shapeCastAll(query, position, rotation, direction, cast, ...words)) {
        const hit = this.castHit(raw);
        if (hit && options.predicate(hit.body, hit.collider) && (!best || hit.distance < best.distance)) best = hit;
      }
      return best;
    }
    const raw = this.kernel.shapeCast(query, position, rotation, direction, cast, ...words);
    return raw ? this.castHit(raw) : null;
  }
  /**
   * Sweeps a convex shape that moves and turns, as Rapier's `cast_shape_nonlinear`: the shape starts at `position` and
   * `rotation`; its `centerOfMass` (in its own frame, default its origin) travels at `linearVelocity` while it turns about
   * that point at `angularVelocity` (a rotation vector in radians a second), for up to `endTime` seconds. The first collider it
   * comes within `targetDistance` of is the hit, and `distance` is a time in seconds. A start in contact is a hit at 0 when
   * `stopAtPenetration` (the default), and otherwise only if the shape is moving into the collider. Found by conservative
   * advancement (Mirtich 1996; van den Bergen 2004), so no touch within the time is skipped.
   * @throws RangeError for a number that is not finite or an end time below 0; MargoError `unsupported` for a compound query
   * shape or a `predicate`.
   */
  shapeCastNonlinear(
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat,
    motion: { linearVelocity: Vec3; angularVelocity: Vec3; centerOfMass?: Vec3 },
    endTime: number,
    options: Omit<PhysicsShapeCastOptions, 'maxDistance'> = {},
  ): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    checkVec(motion.linearVelocity, 'Linear velocity');
    checkVec(motion.angularVelocity, 'Angular velocity');
    const center = motion.centerOfMass ?? [0, 0, 0];
    checkVec(center, 'Center of mass');
    if (!(endTime >= 0) || !Number.isFinite(endTime))
      throw new RangeError(
        `The end time is 0 or more seconds and finite (got ${endTime}); pass how long the shape moves.`,
      );
    this.live();
    if (queryParts(shape) || options.predicate)
      throw new MargoError(
        'unsupported',
        'A turning cast takes one convex shape and no predicate; cast a compound piece by piece, or filter with the query options.',
      );
    const raw = this.kernel.shapeCastTurning(
      queryShape(shape, this.hulls),
      position,
      rotation,
      { center, linear: motion.linearVelocity, angular: motion.angularVelocity },
      endTime,
      {
        max: endTime,
        target: options.targetDistance ?? 0,
        stop: options.stopAtPenetration ?? true,
        geometry: options.computeImpactGeometryOnPenetration ?? true,
      },
      ...this.filterWords(options),
    );
    return raw ? this.castHit(raw) : null;
  }
  /**
   * The point on any collider nearest `point`, or null when no collider is seen. Inside a shape with `solid` true (the
   * default) the point itself; with `solid` false the nearest point of its surface. Inside, `inside` is true and
   * `distance` 0 either way, as on the root entry.
   * @throws RangeError for a point that is not three finite numbers.
   */
  projectPoint(point: Vec3, options: QueryFilter & { solid?: boolean } = {}): PointProjection | null {
    checkVec(point, 'Point');
    this.live();
    const solid = options.solid ?? true,
      words = this.filterWords(options);
    const raws = options.predicate
      ? this.kernel.projectPointAll(point, solid, ...words)
      : [this.kernel.projectPoint(point, solid, ...words)];
    let best: PointProjection | null = null;
    for (const raw of raws) {
      const collider = raw && this.byRow.get(raw.collider);
      if (!raw || !collider || (options.predicate && !options.predicate(collider.body, collider))) continue;
      const distance = raw.inside ? 0 : raw.distance,
        hit = this.withFeatures(
          {
            body: collider.body,
            mesh: collider.body.mesh,
            collider,
            point: raw.point,
            inside: raw.inside,
            distance,
          },
          collider,
          raw.point,
        ) as PointProjection;
      if (!best || distance < best.distance || (distance === best.distance && hit.inside && !best.inside)) best = hit;
    }
    return best;
  }
  /**
   * The bodies whose colliders hold `point`, in the order they were added. A trimesh or height field holds no point.
   * @throws RangeError for a point that is not three finite numbers.
   */
  intersectPoint(point: Vec3, options: QueryFilter = {}): PhysicsBody[] {
    checkVec(point, 'Point');
    this.live();
    return this.bodiesOf(this.kernel.intersectPoint(point, ...this.filterWords(options)), options.predicate);
  }
  /**
   * The bodies whose colliders overlap a convex shape (as `shapeCast` takes) at `position` and `rotation`, in the order
   * they were added.
   * @throws RangeError for a position or rotation that is not finite; MargoError `unsupported` for another query shape.
   */
  intersectShape(
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat = [0, 0, 0, 1],
    options: QueryFilter = {},
  ): PhysicsBody[] {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    this.live();
    const parts = queryParts(shape);
    if (parts) {
      const found = new Set<PhysicsBody>();
      for (const part of parts) {
        const moved = turn(rotation, part.offset);
        for (const body of this.intersectShape(
          part.shape,
          [position[0] + moved[0], position[1] + moved[1], position[2] + moved[2]],
          multiply(rotation, part.rotation),
          options,
        ))
          found.add(body);
      }
      // In the order the bodies were added, as every query lists them.
      return [...this.bodies].filter((body) => found.has(body));
    }
    const query = queryShape(shape, this.hulls);
    return this.bodiesOf(
      this.kernel.intersectShape(query, position, rotation, ...this.filterWords(options)),
      options.predicate,
    );
  }
  /**
   * The bodies whose colliders' boxes meet the box from `min` to `max`, in the order they were added. A collider's box is
   * tight to its shape at its pose of the last step (see {@link PhysicsCollider.aabb}).
   * @throws RangeError for a box that is not finite or has a `min` over its `max`.
   */
  intersectAabb(min: Vec3, max: Vec3, options: QueryFilter = {}): PhysicsBody[] {
    checkVec(min, 'Box min');
    checkVec(max, 'Box max');
    this.live();
    return this.bodiesOf(this.kernel.intersectAabb(min, max, ...this.filterWords(options)), options.predicate);
  }
  /**
   * The contact manifolds of two colliders within `prediction` metres of touching (default 0), whether or not their bodies
   * touch in the world: one for two convex colliders, one a pair of children for a compound, one a triangle or cell for a
   * mesh. Normals run from `a` to `b`. A mesh's triangles give their own normals, without the seam smoothing of
   * `fixInternalEdges`.
   * @throws RangeError for a collider that was removed or a prediction below 0.
   */
  contactPair(a: PhysicsCollider, b: PhysicsCollider, prediction = 0): ContactManifold[] {
    this.live();
    const first = this.rowOf(a),
      second = this.rowOf(b),
      stored = this.storedContacts(first, second),
      friction = stored?.friction ?? this.mixed(first, second, false),
      restitution = stored?.restitution ?? this.mixed(first, second, true);
    const surface = this.pairSurface(first, second);
    return this.kernel.pairContacts(first, second, prediction).map((m) => {
      const manifold = this.manifold(m, stored?.points);
      return {
        ...this.localize(manifold, a, b, m, { friction, restitution, surface }),
      };
    });
  }
  /** The surface velocity a stored pair holds, or zero. */
  private pairSurface(a: number, b: number): [number, number, number] {
    const kernel = this.kernel,
      c = kernel.columns;
    for (let row = kernel.firstPair(a); row !== NONE; row = kernel.nextPair(row, a))
      if ((c.pairA[row] === a && c.pairB[row] === b) || (c.pairA[row] === b && c.pairB[row] === a))
        return [c.pairSurfaceX[row]!, c.pairSurfaceY[row]!, c.pairSurfaceZ[row]!];
    return [0, 0, 0];
  }
  /** A manifold with its normal and points also in each collider's frame, its sub-shapes and what the solver reads for each point. */
  private localize(
    manifold: ShapeContactManifold,
    a: PhysicsCollider,
    b: PhysicsCollider,
    raw: KernelManifold,
    solver: { friction: number; restitution: number; surface: [number, number, number] },
  ): ContactManifold {
    const frame = (collider: PhysicsCollider) => {
        const p = collider.translation(),
          q = collider.rotation();
        return { p: [p.x, p.y, p.z] as Vec3, q: [-q.x, -q.y, -q.z, q.w] as Quat };
      },
      into = (f: { p: Vec3; q: Quat }, v: Vec3, point: boolean): [number, number, number] => {
        const r = turn(f.q, point ? [v[0] - f.p[0], v[1] - f.p[1], v[2] - f.p[2]] : [v[0], v[1], v[2]]);
        return [r[0], r[1], r[2]];
      },
      fa = frame(a),
      fb = frame(b),
      n = manifold.normal,
      reverse: Vec3 = [-n[0], -n[1], -n[2]];
    return {
      ...manifold,
      friction: solver.friction,
      restitution: solver.restitution,
      localNormalA: into(fa, n, false),
      localNormalB: into(fb, reverse, false),
      ...(raw.subA === null ? {} : { subShapeA: raw.subA }),
      ...(raw.subB === null ? {} : { subShapeB: raw.subB }),
      points: manifold.points.map((p) => ({
        ...p,
        localPointA: into(fa, p.pointA, true),
        localPointB: into(fb, p.pointB, true),
        friction: solver.friction,
        restitution: solver.restitution,
        tangentVelocity: solver.surface,
      })),
    };
  }
  /** A manifold of the kernel in this entry's names, with the impulses a stored pair holds for its points. */
  private manifold(
    m: KernelManifold,
    held?: Map<number, { normalImpulse: number; tangentImpulse: [number, number, number] }>,
  ): ShapeContactManifold {
    return {
      normal: m.normal,
      points: m.points.map((p) => ({
        pointA: p.onA,
        pointB: p.onB,
        separation: p.separation,
        id: p.id,
        normalImpulse: held?.get(p.id)?.normalImpulse ?? 0,
        tangentImpulse: held?.get(p.id)?.tangentImpulse ?? [0, 0, 0],
      })),
    };
  }
  /** What the solver holds for the pair of two colliders in the world: its mixed friction and restitution and each contact's impulses. */
  private storedContacts(a: number, b: number) {
    const kernel = this.kernel,
      c = kernel.columns;
    for (let row = kernel.firstPair(a); row !== NONE; row = kernel.nextPair(row, a)) {
      if (!((c.pairA[row] === a && c.pairB[row] === b) || (c.pairA[row] === b && c.pairB[row] === a))) continue;
      const points = new Map<number, { normalImpulse: number; tangentImpulse: [number, number, number] }>();
      for (let part = row; part !== NONE; part = c.pairChild[part])
        for (let k = 0; k < c.pairContacts[part]; k++) {
          const at = part * 4 + k;
          points.set(c.contactId[at], {
            normalImpulse: c.contactNormalImpulse[at],
            tangentImpulse: [c.contactTangentX[at], c.contactTangentY[at], c.contactTangentZ[at]],
          });
        }
      return { friction: c.pairFriction[row], restitution: c.pairRestitution[row], points };
    }
    return null;
  }
  /** The friction or restitution two colliders make by their combine rules (the higher rule of the two decides). */
  private mixed(a: number, b: number, restitution: boolean): number {
    const c = this.kernel.columns,
      values = restitution ? c.colliderRestitution : c.colliderFriction,
      ruleA = combineRule(c.colliderCombine[a], restitution),
      ruleB = combineRule(c.colliderCombine[b], restitution),
      rule = ruleA > ruleB ? ruleA : ruleB,
      [x, y] = [values[a], values[b]];
    return mixCoefficients(x, y, rule);
  }
  /**
   * Whether two colliders overlap now, whether or not their bodies touch in the world. Sensors count.
   * @throws RangeError for a collider that was removed.
   */
  intersectionPair(a: PhysicsCollider, b: PhysicsCollider): boolean {
    this.live();
    return this.kernel.pairIntersects(this.rowOf(a), this.rowOf(b));
  }
  /**
   * How far apart two colliders are, with the nearest point on each; 0 when they overlap. Null when none can be read (a
   * half space against a mesh).
   * @throws RangeError for a collider that was removed.
   */
  colliderDistance(a: PhysicsCollider, b: PhysicsCollider): ColliderDistance | null {
    this.live();
    return this.kernel.pairDistance(this.rowOf(a), this.rowOf(b));
  }
  /**
   * A ray against one collider, as Rapier's `collider.castRay`: the hit or null. `maxDistance` defaults to unbounded and
   * `solid` to true.
   * @throws RangeError for an origin or direction that is not three finite numbers, a zero direction or a removed collider.
   */
  raycastCollider(
    collider: PhysicsCollider,
    origin: Vec3,
    direction: Vec3,
    options: { maxDistance?: number; solid?: boolean } = {},
  ): RaycastHit | null {
    checkVec(origin, 'Ray origin');
    checkVec(direction, 'Ray direction');
    this.live();
    const raw = this.kernel.colliderRay(
      this.rowOf(collider),
      origin,
      direction,
      options.maxDistance ?? Infinity,
      options.solid ?? true,
    );
    return raw ? this.rayHit(raw) : null;
  }
  /**
   * The point of one collider nearest `point`, as Rapier's `collider.projectPoint`: inside, with `solid` true (the default)
   * the point itself. Null when nothing can be projected (a mesh holds no inside).
   * @throws RangeError for a point that is not three finite numbers or a removed collider.
   */
  projectPointOnCollider(
    collider: PhysicsCollider,
    point: Vec3,
    options: { solid?: boolean } = {},
  ): { point: [number, number, number]; inside: boolean; distance: number } | null {
    checkVec(point, 'Point');
    this.live();
    const raw = this.kernel.colliderProject(this.rowOf(collider), point, options.solid ?? true);
    return raw ? { point: raw.point, inside: raw.inside, distance: raw.inside ? 0 : raw.distance } : null;
  }
  /**
   * Whether `point` is inside one collider, as Rapier's `collider.containsPoint`; a mesh or height field holds no point.
   * @throws RangeError for a point that is not three finite numbers or a removed collider.
   */
  colliderContainsPoint(collider: PhysicsCollider, point: Vec3): boolean {
    return this.projectPointOnCollider(collider, point, { solid: true })?.inside ?? false;
  }
  /**
   * A shape cast against one collider, as Rapier's `collider.castShape`, with the options of `shapeCast`.
   * @throws RangeError for a pose or direction that is not finite, a removed collider; MargoError `unsupported` for a query shape the solver does not hold.
   */
  castShapeAtCollider(
    collider: PhysicsCollider,
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat,
    direction: Vec3,
    options: PhysicsShapeCastOptions = {},
  ): ShapeCastHit | null {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    checkVec(direction, 'Cast direction');
    this.live();
    const query = queryShape(shape, this.hulls),
      raw = this.kernel.colliderShapeCast(this.rowOf(collider), query, position, rotation, direction, {
        max: options.maxDistance ?? Infinity,
        target: options.targetDistance ?? 0,
        stop: options.stopAtPenetration ?? true,
        geometry: options.computeImpactGeometryOnPenetration ?? true,
      });
    return raw ? this.castHit(raw) : null;
  }
  /**
   * The contacts of a batch of soft body particles with the colliders of this world, one call a step: for each particle of
   * radius r moving from one position to another, up to `k` colliders (the deepest first), each as a plane (the point on its
   * surface and the normal out of it) with the depth to it (negative: a gap still open, listed when within `margin` past the
   * radius), the velocity of the surface there (a rigid body's, and a deformable mesh's vertices') and the time of the touch.
   * Every shape is met, a fast particle is swept so it never tunnels, sensors and disabled colliders never are, and
   * `groups` (one packed word for all, or one each in `views.groups`) and the query flags are honoured. With `dt` (the step's
   * seconds) every collider is met along its own linear and angular motion over the step, so a fast bat or a spinning paddle
   * cannot pass a particle. `exclude` leaves a body
   * out, such as the rigid frame of the soft body itself. Returns arrays with `k` slots a particle; a slot without a contact
   * has `collider` 0xffffffff, and a collider row maps to a body through `body` and `colliderOf`.
   */
  softContacts(
    views: KernelParticleViews,
    k = 1,
    options: { groups?: number; exclude?: PhysicsBody; flags?: number; dt?: number } = {},
  ): KernelSoftContacts {
    return this.kernel.softContacts(views, k, {
      dt: options.dt,
      flags: options.flags,
      groups: options.groups,
      excludeBody: options.exclude ? options.exclude.row : undefined,
    });
  }
  /**
   * The contacts of a batch of soft body triangles with the colliders of this world, one call a step, for what the particles'
   * contacts cannot hold: a body smaller than the spacing of the corners, or a thin one lying between them. Each triangle,
   * thickened by `thickness` on both sides, is met as its corners move from `from` to `to` (nine numbers a triangle each), the
   * first touch found so a fast triangle never passes a thin body; up to `k` contacts a triangle, the deepest first, each a
   * point on the collider's surface with the normal out of it, the weights of the triangle's corners at the point facing it,
   * the depth (negative: a gap still open, listed when within `margin` past the thickness) and the velocity of the surface
   * there. With `dt` each collider is met along its own motion over the step. Groups, flags and `exclude` work as in
   * {@link Physics.softContacts}; half spaces and sensors are left out. A slot without a contact has `collider` 0xffffffff.
   */
  softFaceContacts(
    views: KernelTriangleViews,
    k = 1,
    options: { groups?: number; exclude?: PhysicsBody; flags?: number; dt?: number } = {},
  ): KernelFaceContacts {
    return this.kernel.softFaceContacts(views, k, {
      dt: options.dt,
      flags: options.flags,
      groups: options.groups,
      excludeBody: options.exclude ? options.exclude.row : undefined,
    });
  }
  /** The collider a {@link Physics.softContacts} slot names by its row, or undefined for no contact. */
  colliderOf(row: number): PhysicsCollider | undefined {
    return this.byRow.get(row);
  }
  /**
   * Whether a convex shape overlaps one collider, as Rapier's `collider.intersectsShape`.
   * @throws RangeError for a pose that is not finite or a removed collider; MargoError `unsupported` for a query shape the solver does not hold.
   */
  colliderIntersectsShape(
    collider: PhysicsCollider,
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat = [0, 0, 0, 1],
  ): boolean {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    this.live();
    return this.kernel.colliderOverlaps(this.rowOf(collider), queryShape(shape, this.hulls), position, rotation);
  }
  /** Every collider in the world, in the order their rows were made, as Rapier's `forEachCollider` visits them. */
  getColliders(): PhysicsCollider[] {
    return [...this.byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, collider]) => collider);
  }
  /**
   * The colliders `collider` touches as of the last step, with solid contact (neither side a sensor): Rapier's
   * `contactPairsWith`.
   * @throws RangeError for a collider that was removed.
   */
  contactPairsWith(collider: PhysicsCollider): PhysicsCollider[] {
    return this.touchingWith(collider, false);
  }
  /**
   * The colliders `collider` overlaps as of the last step where one of the two is a sensor: Rapier's `intersectionPairsWith`.
   * @throws RangeError for a collider that was removed.
   */
  intersectionPairsWith(collider: PhysicsCollider): PhysicsCollider[] {
    return this.touchingWith(collider, true);
  }
  private touchingWith(collider: PhysicsCollider, sensors: boolean): PhysicsCollider[] {
    this.live();
    const self = this.rowOf(collider),
      kernel = this.kernel,
      c = kernel.columns,
      found: PhysicsCollider[] = [];
    for (let row = kernel.firstPair(self); row !== NONE; row = kernel.nextPair(row, self)) {
      if (!(c.pairFlags[row] & PAIR_TOUCHING)) continue;
      const other = this.byRow.get(c.pairA[row] === self ? c.pairB[row] : c.pairA[row]);
      if (other && (collider.isSensor() || other.isSensor()) === sensors) found.push(other);
    }
    return found.sort((a, b) => a.handle - b.handle);
  }
  /**
   * The contact manifolds of a collider and a convex query shape at a pose within `prediction` metres of touching (default
   * 0), normals from the collider to the shape: Rapier's `contactShape`.
   * @throws RangeError for a collider that was removed, a pose that is not finite or a prediction below 0; MargoError `unsupported` for a query shape the solver does not hold.
   */
  contactShape(
    collider: PhysicsCollider,
    shape: ShapeOptions,
    position: Vec3,
    rotation: Quat = [0, 0, 0, 1],
    prediction = 0,
  ): ShapeContactManifold[] {
    checkVec(position, 'Shape position');
    checkRotation(rotation);
    this.live();
    return this.kernel
      .colliderShapeContacts(this.rowOf(collider), queryShape(shape, this.hulls), position, rotation, prediction)
      .map((m) => this.manifold(m));
  }
  /**
   * Casts a collider, with its own shape and pose, along `direction` against one other collider: Rapier's `castCollider`.
   * `distance` is along the direction's unit. Returns the touch of the two, or null.
   * @throws RangeError for a collider that was removed or a direction that is not finite and nonzero.
   */
  castColliderOnto(
    moving: PhysicsCollider,
    target: PhysicsCollider,
    direction: Vec3,
    options: PhysicsShapeCastOptions = {},
  ): ShapeCastHit | null {
    checkVec(direction, 'Cast direction');
    this.live();
    const raw = this.kernel.colliderCastCollider(this.rowOf(moving), this.rowOf(target), direction, {
      max: options.maxDistance ?? Infinity,
      target: options.targetDistance ?? 0,
      stop: options.stopAtPenetration ?? true,
      geometry: options.computeImpactGeometryOnPenetration ?? true,
    });
    return raw ? this.castHit(raw) : null;
  }
  /**
   * Casts a collider along `direction` against the rest of the world (the colliders of other bodies the filter lets
   * through) and returns the nearest touch, or null.
   */
  castCollider(moving: PhysicsCollider, direction: Vec3, options: PhysicsShapeCastOptions = {}): ShapeCastHit | null {
    let best: ShapeCastHit | null = null;
    for (const target of this.getColliders()) {
      if (target.body === moving.body || (options.exclude !== undefined && options.exclude === target.body)) continue;
      if (options.predicate && !options.predicate(target.body, target)) continue;
      const hit = this.castColliderOnto(moving, target, direction, {
        ...options,
        maxDistance: best ? best.distance : options.maxDistance,
      });
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }
  /** A collider's row, for the kernel; refuses what is not this world's. */
  private rowOf(collider: PhysicsCollider): number {
    if (!collider.valid || this.byRow.get(collider.handle) !== collider)
      throw new RangeError(
        'That collider was removed or belongs to another world; pass a collider from body.colliders.',
      );
    return collider.handle;
  }
  private bodiesOf(rows: readonly number[], predicate: QueryFilter['predicate']): PhysicsBody[] {
    const found = new Set<PhysicsBody>();
    for (const row of rows) {
      const collider = this.byRow.get(row);
      if (collider && (!predicate || predicate(collider.body, collider))) found.add(collider.body);
    }
    return [...found];
  }
  /**
   * Whether two bodies' colliders touch as of the last step. A point still ahead of a moving body does not count. It walks
   * only the pairs of `a`'s colliders and allocates nothing.
   */
  touching(a: PhysicsBody, b: PhysicsBody): boolean {
    const { kernel } = this,
      c = kernel.columns,
      { colliders } = a;
    for (let i = 0; i < colliders.length; i++) {
      const self = colliders[i].handle;
      for (let row = kernel.firstPair(self); row !== NONE; row = kernel.nextPair(row, self)) {
        if (this.bodyOfCollider(c.pairA[row] === self ? c.pairB[row] : c.pairA[row]) !== b) continue;
        // A mesh or compound pair keeps its points on its parts, one row each down the pairChild chain.
        for (let part = row; part !== NONE; part = c.pairChild[part])
          for (let at = part * 4; at < part * 4 + c.pairContacts[part]; at++)
            if (c.contactSeparation[at] <= 0 || c.contactNormalImpulse[at] > 0) return true;
      }
    }
    return false;
  }

  /**
   * Where the solver pushes on this body as of the last step: one world position [x, y, z] per contact point, so a box
   * flat on a floor has its four corners. A point two colliders share comes once for each. It walks only the pairs of the
   * body's colliders and their mesh parts, in the order of their rows, and allocates only what it returns.
   */
  contactPoints(body: PhysicsBody): [number, number, number][] {
    const points: [number, number, number][] = [],
      { kernel } = this,
      c = kernel.columns,
      { colliders } = body,
      rows = this.rowScratch;
    rows.length = 0;
    for (let i = 0; i < colliders.length; i++) {
      const self = colliders[i].handle;
      for (let row = kernel.firstPair(self); row !== NONE; row = kernel.nextPair(row, self))
        for (let part = row; part !== NONE; part = c.pairChild[part]) if (c.pairContacts[part] !== 0) rows.push(part);
    }
    rows.sort(ascending);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let at = row * 4; at < row * 4 + c.pairContacts[row]; at++)
        if (c.contactSeparation[at] <= 0 || c.contactNormalImpulse[at] > 0)
          points.push([c.contactX[at], c.contactY[at], c.contactZ[at]]);
    }
    rows.length = 0;
    return points;
  }

  /**
   * The whole world as one copy, for {@link Physics.restoreSnapshot} (Rapier's `takeSnapshot`): every body, collider, joint,
   * contact, warm start and sleep timer, so stepping on from a restore gives the same bits as the first time. It holds the
   * kernel's rows, not the JavaScript objects: the handles, `userData`, meshes, controllers and listeners you hold stay what
   * they are, and a restore needs the same bodies, colliders and joints to exist as when the snapshot was taken.
   */
  takeSnapshot(): PhysicsSnapshot {
    this.live();
    const c = this.kernel.columns;
    return {
      bytes: this.kernel.snapshot(),
      bodies: [...this.bodies].map((body) => [body.row, c.generation[body.row]!] as const),
      colliders: [...this.byRow.keys()].map((row) => [row, c.colliderGeneration[row]!] as const),
      joints: [...this.joints].map((joint) => joint.row),
    };
  }
  /**
   * Puts the world back as {@link Physics.takeSnapshot} found it. The bodies, colliders and joints must be the ones that were
   * there: one added or removed since is named in the error, and nothing changes.
   * @throws MargoError (`state`) when the bodies, colliders or joints are not the snapshot's.
   * @throws RangeError for bytes that are not a snapshot of this kernel.
   */
  restoreSnapshot(snapshot: PhysicsSnapshot): this {
    this.live();
    const c = this.kernel.columns,
      same = (now: readonly (readonly [number, number])[], then: readonly (readonly [number, number])[]): boolean =>
        now.length === then.length &&
        now.every(([row, generation]) => then.some((t) => t[0] === row && t[1] === generation));
    if (
      !same(
        [...this.bodies].map((body) => [body.row, c.generation[body.row]!] as const),
        snapshot.bodies,
      ) ||
      !same(
        [...this.byRow.keys()].map((row) => [row, c.colliderGeneration[row]!] as const),
        snapshot.colliders,
      ) ||
      this.joints.size !== snapshot.joints.length ||
      ![...this.joints].every((joint) => snapshot.joints.includes(joint.row))
    )
      throw new MargoError(
        'state',
        'The world has other bodies, colliders or joints than the snapshot: restore it before adding or removing any, or take a new snapshot.',
      );
    this.kernel.restore(snapshot.bytes);
    for (const body of this.bodies) this.meshes.mark(body);
    this.retired.clear();
    return this;
  }
  /**
   * Rapier's debug lines: `vertices` (x, y, z, two vertices a segment) and `colors` (r, g, b, a a vertex) for the collider
   * outlines, joints and last-step contact points of the world, and with `boxes` the box around each collider. Draw them with
   * `@margoengine/lines`: `new Line({mode: 'segments', positions: vertices, colors})`. Reads the poses of the last step.
   */
  debugRender(options: DebugRenderOptions = {}): DebugLines {
    return debugLines(this.kernel, this.bodies, this.joints, options);
  }

  /** Frees every body and the world. Detaches from the engine if attached. */
  dispose(): void {
    if (this.disposed) return;
    const engine = this.engine,
      // The scene this world is in, not the active one: a world in a second scene is disposed while another is active.
      scene = engine && !engine.disposed ? engine.sceneOf(this) : undefined;
    if (scene) {
      // removePlugin calls back into dispose() after unregistering.
      try {
        scene.removePlugin(this.name);
        return;
      } catch {
        /* engine is tearing down; free below */
      }
    }
    for (const controller of [...this.controllers]) controller.dispose();
    for (const character of [...this.dynamicCharacters]) character.dispose();
    for (const attachment of [...this.attachments]) attachment.dispose();
    for (const joint of [...this.joints]) this.removeJoint(joint);
    for (const body of [...this.bodies]) this.removeBody(body);
    this.listeners.clear();
    this.disposed = true;
    this.engine = null;
    this.world = null;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {
    this.dispose();
  }
}
