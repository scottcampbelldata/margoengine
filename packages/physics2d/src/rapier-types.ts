/** Structural Rapier 2D contracts keep the optional peer out of the emitted declaration graph.
 * Native `@dimforge/rapier2d-compat` objects satisfy these protocols; use the vendor types for raw access.
 */
interface Vector2D {
  x: number;
  y: number;
}
interface Shape2D {
  readonly type: number;
}
interface Ray2D {
  origin: Vector2D;
  dir: Vector2D;
}
export interface Collider2D {
  readonly handle: number;
  readonly shape: Shape2D;
  isSensor(): boolean;
  parent(): RigidBody2D | null;
  translation(): Vector2D;
  rotation(): number;
  setSensor(sensor: boolean): void;
  setFriction(value: number): void;
  setRestitution(value: number): void;
  setCollisionGroups(groups: number): void;
  setEnabled(enabled: boolean): void;
}
export interface ColliderDesc2D {
  shape: Shape2D;
  setTranslation(x: number, y: number): ColliderDesc2D;
  setRotation(angle: number): ColliderDesc2D;
  setFriction(value: number): ColliderDesc2D;
  setRestitution(value: number): ColliderDesc2D;
  setDensity(density: number): ColliderDesc2D;
  setMass(mass: number): ColliderDesc2D;
  setSensor(sensor: boolean): ColliderDesc2D;
  setActiveCollisionTypes(types: number): ColliderDesc2D;
  setCollisionGroups(groups: number): ColliderDesc2D;
  setSolverGroups(groups: number): ColliderDesc2D;
  setActiveEvents(events: number): ColliderDesc2D;
}
export interface RigidBody2D {
  readonly handle: number;
  translation(): Vector2D;
  rotation(): number;
  linvel(): Vector2D;
  angvel(): number;
  setTranslation(position: Vector2D, wakeUp: boolean): void;
  setRotation(angle: number, wakeUp: boolean): void;
  setNextKinematicTranslation(position: Vector2D): void;
  setNextKinematicRotation(angle: number): void;
  setLinvel(velocity: Vector2D, wakeUp: boolean): void;
  setAngvel(velocity: number, wakeUp: boolean): void;
  addForce(force: Vector2D, wakeUp: boolean): void;
  addTorque(torque: number, wakeUp: boolean): void;
  applyImpulse(impulse: Vector2D, wakeUp: boolean): void;
  applyTorqueImpulse(torque: number, wakeUp: boolean): void;
  isSleeping(): boolean;
  wakeUp(): void;
  mass(): number;
  setGravityScale(scale: number, wakeUp: boolean): void;
}
interface RigidBodyDesc2D {
  setTranslation(x: number, y: number): RigidBodyDesc2D;
  setRotation(angle: number): RigidBodyDesc2D;
  setLinvel(x: number, y: number): RigidBodyDesc2D;
  setAngvel(velocity: number): RigidBodyDesc2D;
  setLinearDamping(damping: number): RigidBodyDesc2D;
  setAngularDamping(damping: number): RigidBodyDesc2D;
  setGravityScale(scale: number): RigidBodyDesc2D;
  setCcdEnabled(enabled: boolean): RigidBodyDesc2D;
  setCanSleep(enabled: boolean): RigidBodyDesc2D;
  lockRotations(): RigidBodyDesc2D;
}
export interface JointData2D {
  jointType: number;
}
export interface ImpulseJoint2D {
  readonly handle: number;
  setContactsEnabled(enabled: boolean): void;
}
export interface UnitImpulseJoint2D extends ImpulseJoint2D {
  setLimits(min: number, max: number): void;
  configureMotorVelocity(velocity: number, factor: number): void;
  configureMotorPosition(position: number, stiffness: number, damping: number): void;
  setMotorMaxForce(maxForce: number): void;
}
/** Rapier's kinematic character controller: configure once, then compute a movement per step. */
export interface KinematicCharacterController2D {
  computeColliderMovement(
    collider: Collider2D,
    desired: Vector2D,
    flags?: number,
    groups?: number,
    predicate?: (collider: Collider2D) => boolean,
  ): void;
  computedMovement(): Vector2D;
  computedGrounded(): boolean;
  numComputedCollisions(): number;
  setUp(up: Vector2D): void;
  setSlideEnabled(enabled: boolean): void;
  setMaxSlopeClimbAngle(angle: number): void;
  setMinSlopeSlideAngle(angle: number): void;
  enableAutostep(maxHeight: number, minWidth: number, includeDynamicBodies: boolean): void;
  enableSnapToGround(distance: number): void;
  setApplyImpulsesToDynamicBodies(enabled: boolean): void;
  setCharacterMass(mass: number): void;
}
export interface EventQueue2D {
  drainCollisionEvents(callback: (colliderA: number, colliderB: number, started: boolean) => void): void;
  free(): void;
}
type QueryArgs2D = [
  flags?: number,
  groups?: number,
  excludeCollider?: Collider2D,
  excludeBody?: RigidBody2D,
  predicate?: (collider: Collider2D) => boolean,
];
/** The Rapier world: bodies, colliders, joints, controllers and scene queries. */
export interface World2D {
  gravity: Vector2D;
  timestep: number;
  step(queue?: EventQueue2D): void;
  free(): void;
  createRigidBody(desc: RigidBodyDesc2D): RigidBody2D;
  createCollider(desc: ColliderDesc2D, body?: RigidBody2D): Collider2D;
  createImpulseJoint(desc: JointData2D, bodyA: RigidBody2D, bodyB: RigidBody2D, wakeUp: boolean): ImpulseJoint2D;
  createCharacterController(offset: number): KinematicCharacterController2D;
  getCollider(handle: number): Collider2D;
  removeRigidBody(body: RigidBody2D): void;
  removeCollider(collider: Collider2D, wakeUp: boolean): void;
  removeImpulseJoint(joint: ImpulseJoint2D, wakeUp: boolean): void;
  removeCharacterController(controller: KinematicCharacterController2D): void;
  castRayAndGetNormal(
    ray: Ray2D,
    maxDistance: number,
    solid: boolean,
    ...filter: QueryArgs2D
  ): { collider: Collider2D; timeOfImpact: number; normal: Vector2D } | null;
  castShape(
    position: Vector2D,
    rotation: number,
    velocity: Vector2D,
    shape: Shape2D,
    targetDistance: number,
    maxDistance: number,
    stopAtPenetration: boolean,
    ...filter: QueryArgs2D
  ): { collider: Collider2D; time_of_impact: number; witness1: Vector2D; normal1: Vector2D } | null;
  intersectionsWithPoint(point: Vector2D, callback: (collider: Collider2D) => boolean, ...filter: QueryArgs2D): void;
  intersectionsWithShape(
    position: Vector2D,
    rotation: number,
    shape: Shape2D,
    callback: (collider: Collider2D) => boolean,
    ...filter: QueryArgs2D
  ): void;
}
/** The initialized Rapier 2D namespace. Only the surface this package uses is required. */
export interface RapierModule2D {
  World: new (gravity: Vector2D) => World2D;
  EventQueue: new (autoDrain: boolean) => EventQueue2D;
  Ray: new (origin: Vector2D, direction: Vector2D) => Ray2D;
  ColliderDesc: {
    cuboid(hx: number, hy: number): ColliderDesc2D;
    ball(radius: number): ColliderDesc2D;
    capsule(halfHeight: number, radius: number): ColliderDesc2D;
    segment(a: Vector2D, b: Vector2D): ColliderDesc2D;
    polyline(vertices: Float32Array, indices?: Uint32Array | null): ColliderDesc2D;
    convexHull(points: Float32Array): ColliderDesc2D | null;
    convexDecomposition(vertices: Float32Array, indices: Uint32Array): ColliderDesc2D | null;
  };
  RigidBodyDesc: {
    dynamic(): RigidBodyDesc2D;
    fixed(): RigidBodyDesc2D;
    kinematicPositionBased(): RigidBodyDesc2D;
    kinematicVelocityBased(): RigidBodyDesc2D;
  };
  JointData: {
    fixed(anchorA: Vector2D, frameA: number, anchorB: Vector2D, frameB: number): JointData2D;
    revolute(anchorA: Vector2D, anchorB: Vector2D): JointData2D;
    prismatic(anchorA: Vector2D, anchorB: Vector2D, axis: Vector2D): JointData2D;
    rope(length: number, anchorA: Vector2D, anchorB: Vector2D): JointData2D;
    spring(restLength: number, stiffness: number, damping: number, anchorA: Vector2D, anchorB: Vector2D): JointData2D;
  };
  QueryFilterFlags: Record<'EXCLUDE_SENSORS' | 'EXCLUDE_FIXED' | 'EXCLUDE_KINEMATIC' | 'EXCLUDE_DYNAMIC', number>;
  ActiveCollisionTypes: { ALL: number };
  ActiveEvents: { COLLISION_EVENTS: number };
}
