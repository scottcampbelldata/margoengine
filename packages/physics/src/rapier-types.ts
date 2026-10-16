/** Structural Rapier contracts keep its optional peer out of the emitted declaration graph.
 * Native Rapier objects satisfy these protocols; consumers can use the vendor types for additional raw APIs.
 */
export interface Vector {
  x: number;
  y: number;
  z: number;
}
export interface Rotation extends Vector {
  w: number;
}
export interface Shape {
  readonly type: number;
}
export interface Ray {
  origin: Vector;
  dir: Vector;
  pointAt(distance: number): Vector;
}

export interface Collider {
  readonly handle: number;
  readonly shape: Shape;
  isValid(): boolean;
  isSensor(): boolean;
  setSensor(sensor: boolean): void;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  parent(): RigidBody | null;
  translation(): Vector;
  translationWrtParent(): Vector | null;
  rotation(): Rotation;
  rotationWrtParent(): Rotation | null;
  setTranslation(position: Vector): void;
  setRotation(rotation: Rotation): void;
  shapeType(): number;
  halfExtents(): Vector | null;
  radius(): number;
  halfHeight(): number;
  vertices(): Float32Array;
  indices(): Uint32Array | undefined;
  density(): number;
  mass(): number;
  friction(): number;
  restitution(): number;
  setFriction(friction: number): void;
  setRestitution(restitution: number): void;
  setCollisionGroups(groups: number): void;
  setSolverGroups(groups: number): void;
}
export interface ColliderDesc {
  shape: Shape;
  setTranslation(x: number, y: number, z: number): ColliderDesc;
  setRotation(rotation: Rotation): ColliderDesc;
  setFriction(value: number): ColliderDesc;
  setRestitution(value: number): ColliderDesc;
  setFrictionCombineRule(rule: number): ColliderDesc;
  setRestitutionCombineRule(rule: number): ColliderDesc;
  setMass(mass: number): ColliderDesc;
  setDensity(density: number): ColliderDesc;
  setSensor(sensor: boolean): ColliderDesc;
  setActiveCollisionTypes(types: number): ColliderDesc;
  setCollisionGroups(groups: number): ColliderDesc;
  setSolverGroups(groups: number): ColliderDesc;
  setActiveEvents(events: number): ColliderDesc;
  setActiveHooks(hooks: number): ColliderDesc;
  setEnabled(enabled: boolean): ColliderDesc;
}
export interface RigidBody {
  readonly handle: number;
  userData?: unknown;
  isValid(): boolean;
  translation(): Vector;
  rotation(): Rotation;
  linvel(): Vector;
  angvel(): Vector;
  setTranslation(position: Vector, wakeUp: boolean): void;
  setRotation(rotation: Rotation, wakeUp: boolean): void;
  setNextKinematicTranslation(position: Vector): void;
  setNextKinematicRotation(rotation: Rotation): void;
  setLinvel(velocity: Vector, wakeUp: boolean): void;
  setAngvel(velocity: Vector, wakeUp: boolean): void;
  addForce(force: Vector, wakeUp: boolean): void;
  addForceAtPoint(force: Vector, point: Vector, wakeUp: boolean): void;
  applyImpulse(impulse: Vector, wakeUp: boolean): void;
  applyImpulseAtPoint(impulse: Vector, point: Vector, wakeUp: boolean): void;
  addTorque(torque: Vector, wakeUp: boolean): void;
  applyTorqueImpulse(torque: Vector, wakeUp: boolean): void;
  resetForces(wakeUp: boolean): void;
  resetTorques(wakeUp: boolean): void;
  isSleeping(): boolean;
  sleep(): void;
  wakeUp(): void;
  mass(): number;
  gravityScale(): number;
  setGravityScale(scale: number, wakeUp: boolean): void;
  isCcdEnabled(): boolean;
  enableCcd(enabled: boolean): void;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  lockRotations(locked: boolean, wakeUp: boolean): void;
  lockTranslations(locked: boolean, wakeUp: boolean): void;
}
export interface RigidBodyDesc {
  setTranslation(x: number, y: number, z: number): RigidBodyDesc;
  setRotation(rotation: Rotation): RigidBodyDesc;
  setLinvel(x: number, y: number, z: number): RigidBodyDesc;
  setAngvel(velocity: Vector): RigidBodyDesc;
  setLinearDamping(damping: number): RigidBodyDesc;
  setAngularDamping(damping: number): RigidBodyDesc;
  setGravityScale(scale: number): RigidBodyDesc;
  setCcdEnabled(enabled: boolean): RigidBodyDesc;
  setCanSleep(enabled: boolean): RigidBodyDesc;
  setSleeping(sleeping: boolean): RigidBodyDesc;
  setDominanceGroup(group: number): RigidBodyDesc;
  setAdditionalMass(mass: number): RigidBodyDesc;
  lockRotations(): RigidBodyDesc;
  lockTranslations(): RigidBodyDesc;
  enabledRotations(x: boolean, y: boolean, z: boolean): RigidBodyDesc;
  enabledTranslations(x: boolean, y: boolean, z: boolean): RigidBodyDesc;
}
export interface JointData {
  jointType: number;
}
export interface ImpulseJoint {
  readonly handle: number;
  isValid(): boolean;
  contactsEnabled(): boolean;
  setContactsEnabled(enabled: boolean): void;
}
export interface UnitImpulseJoint extends ImpulseJoint {
  limitsEnabled(): boolean;
  limitsMin(): number;
  limitsMax(): number;
  setLimits(min: number, max: number): void;
  configureMotorModel(model: number): void;
  configureMotorVelocity(velocity: number, factor: number): void;
  configureMotor(position: number, velocity: number, stiffness: number, damping: number): void;
}
export interface KinematicCharacterController {
  setUp(up: Vector): void;
  setMaxSlopeClimbAngle(angle: number): void;
  setMinSlopeSlideAngle(angle: number): void;
  enableAutostep(maxHeight: number, minWidth: number, includeDynamicBodies: boolean): void;
  enableSnapToGround(distance: number): void;
  setSlideEnabled(enabled: boolean): void;
  setApplyImpulsesToDynamicBodies(enabled: boolean): void;
  setCharacterMass(mass: number): void;
  computeColliderMovement(
    collider: Collider,
    desired: Vector,
    flags?: number,
    groups?: number,
    predicate?: (collider: Collider) => boolean,
  ): void;
  computedMovement(): Vector;
  computedGrounded(): boolean;
  numComputedCollisions(): number;
}
export interface EventQueue {
  drainCollisionEvents(callback: (colliderA: number, colliderB: number, started: boolean) => void): void;
  free(): void;
}
export interface PhysicsHooks {
  filterContactPair(colliderA: number, colliderB: number, bodyA: number, bodyB: number): number | null;
  filterIntersectionPair(colliderA: number, colliderB: number, bodyA: number, bodyB: number): boolean;
}
type QueryArgs = [
  flags?: number,
  groups?: number,
  excludeCollider?: Collider,
  excludeBody?: RigidBody,
  predicate?: (collider: Collider) => boolean,
];
interface RayColliderIntersection {
  collider: Collider;
  timeOfImpact: number;
  normal: Vector;
}
interface ColliderShapeCastHit {
  collider: Collider;
  time_of_impact: number;
  witness1: Vector;
  normal1: Vector;
}
interface PointColliderProjection {
  collider: Collider;
  point: Vector;
  isInside: boolean;
}
export interface World {
  gravity: Vector;
  timestep: number;
  numSolverIterations: number;
  readonly bodies: { len(): number };
  readonly colliders: { len(): number };
  step(queue?: EventQueue, hooks?: PhysicsHooks): void;
  free(): void;
  getRigidBody(handle: number): RigidBody;
  getCollider(handle: number): Collider;
  createRigidBody(desc: RigidBodyDesc): RigidBody;
  removeRigidBody(body: RigidBody): void;
  createCollider(desc: ColliderDesc, body?: RigidBody): Collider;
  removeCollider(collider: Collider, wakeUp: boolean): void;
  createImpulseJoint(desc: JointData, bodyA: RigidBody, bodyB: RigidBody, wakeUp: boolean): ImpulseJoint;
  removeImpulseJoint(joint: ImpulseJoint, wakeUp: boolean): void;
  createCharacterController(offset: number): KinematicCharacterController;
  removeCharacterController(controller: KinematicCharacterController): void;
  castRayAndGetNormal(
    ray: Ray,
    maxDistance: number,
    solid: boolean,
    ...filter: QueryArgs
  ): RayColliderIntersection | null;
  intersectionsWithRay(
    ray: Ray,
    maxDistance: number,
    solid: boolean,
    callback: (result: RayColliderIntersection) => boolean,
    ...filter: QueryArgs
  ): void;
  castShape(
    position: Vector,
    rotation: Rotation,
    velocity: Vector,
    shape: Shape,
    targetDistance: number,
    maxDistance: number,
    stopAtPenetration: boolean,
    ...filter: QueryArgs
  ): ColliderShapeCastHit | null;
  projectPoint(point: Vector, solid: boolean, ...filter: QueryArgs): PointColliderProjection | null;
  intersectionsWithPoint(point: Vector, callback: (collider: Collider) => boolean, ...filter: QueryArgs): void;
  intersectionsWithShape(
    position: Vector,
    rotation: Rotation,
    shape: Shape,
    callback: (collider: Collider) => boolean,
    ...filter: QueryArgs
  ): void;
  intersectionPair(colliderA: Collider, colliderB: Collider): boolean;
  contactPair(
    colliderA: Collider,
    colliderB: Collider,
    callback: (manifold: { numContacts(): number }, flipped: boolean) => void,
  ): void;
  debugRender(): { vertices: Float32Array; colors: Float32Array };
}
/** The initialized Rapier namespace. Only the surface this package uses is required. */
export interface RapierModule {
  World: new (gravity: Vector) => World;
  EventQueue: new (autoDrain: boolean) => EventQueue;
  Ray: new (origin: Vector, direction: Vector) => Ray;
  ColliderDesc: {
    cuboid(x: number, y: number, z: number): ColliderDesc;
    ball(radius: number): ColliderDesc;
    capsule(halfHeight: number, radius: number): ColliderDesc;
    cylinder(halfHeight: number, radius: number): ColliderDesc;
    cone(halfHeight: number, radius: number): ColliderDesc;
    convexHull(points: Float32Array): ColliderDesc | null;
    trimesh(vertices: Float32Array, indices: Uint32Array): ColliderDesc;
    heightfield(rows: number, columns: number, heights: Float32Array, scale: Vector): ColliderDesc;
  };
  RigidBodyDesc: {
    dynamic(): RigidBodyDesc;
    fixed(): RigidBodyDesc;
    kinematicPositionBased(): RigidBodyDesc;
    kinematicVelocityBased(): RigidBodyDesc;
  };
  JointData: {
    fixed(anchorA: Vector, frameA: Rotation, anchorB: Vector, frameB: Rotation): JointData;
    spherical(anchorA: Vector, anchorB: Vector): JointData;
    revolute(anchorA: Vector, anchorB: Vector, axis: Vector): JointData;
    prismatic(anchorA: Vector, anchorB: Vector, axis: Vector): JointData;
  };
  QueryFilterFlags: Record<'EXCLUDE_SENSORS' | 'EXCLUDE_FIXED' | 'EXCLUDE_KINEMATIC' | 'EXCLUDE_DYNAMIC', number>;
  SolverFlags: { COMPUTE_IMPULSE: number };
  MotorModel: Record<'ForceBased' | 'AccelerationBased', number>;
  CoefficientCombineRule: Record<'Average' | 'Min' | 'Multiply' | 'Max', number>;
  ActiveCollisionTypes: { ALL: number };
  ActiveEvents: { COLLISION_EVENTS: number };
  ActiveHooks: Record<'FILTER_CONTACT_PAIRS' | 'FILTER_INTERSECTION_PAIRS', number>;
}
