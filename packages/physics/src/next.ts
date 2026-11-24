// `@margoengine/physics/next`: the own solver while it is built. A preview entry, removed when it becomes the root.
export { KernelWorld, loadKernel, trianglesAcross } from './kernel.js';
export { ContactModification, Physics } from './next/physics.js';
export { PhysicsBody } from './next/body.js';
export { PhysicsCollider } from './next/collider.js';
export { PhysicsJoint } from './next/joint.js';
export { collisionGroups } from './shapes.js';
export { buildHull as convexHull } from './next/hull.js';
export { cleanTrimesh } from './next/mesh-clean.js';
export type { MeshCleanOptions } from './next/mesh-clean.js';
export type { HullFaces } from './next/hull.js';
export type { ConeJointOptions, NextJointOptions } from './next/joint.js';
export type {
  CollisionEvent,
  CollisionEventType,
  ColliderDistance,
  ContactForceEvent,
  ContactManifold,
  PhysicsEventMap,
  PhysicsOptions,
  PhysicsRaycastOptions,
  QueryFilter,
  RaycastHit,
} from './next/physics.js';
export type { BodyOptions, BodyType } from './body.js';
export type { JointDof, JointOptions, JointType, MotorOptions, RotationMotorOptions } from './joints.js';
export type { ColliderOptions, CollisionPairKind, ShapeOptions } from './shapes.js';
export type {
  KernelBodyKind,
  KernelColliderOptions,
  KernelColumn,
  KernelDistance,
  KernelManifold,
  KernelCombine,
  KernelContact,
  KernelContactPoint,
  KernelLoadOptions,
  KernelRayHit,
  KernelShape,
  KernelTrimeshOptions,
} from './kernel.js';
