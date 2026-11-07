// `@margoengine/physics/next`: the own solver while it is built. A preview entry, removed when it becomes the root.
export { KernelWorld, loadKernel } from './kernel.js';
export { Physics } from './next/physics.js';
export { PhysicsBody } from './next/body.js';
export { PhysicsCollider } from './next/collider.js';
export { PhysicsJoint } from './next/joint.js';
export type { ConeJointOptions, NextJointOptions } from './next/joint.js';
export type { ContactForceEvent, PhysicsEventMap, PhysicsOptions } from './next/physics.js';
export type { BodyOptions, BodyType } from './body.js';
export type { JointDof, JointOptions, JointType, MotorOptions, RotationMotorOptions } from './joints.js';
export type { ColliderOptions, ShapeOptions } from './shapes.js';
export type {
  KernelBodyKind,
  KernelColliderOptions,
  KernelColumn,
  KernelCombine,
  KernelContact,
  KernelContactPoint,
  KernelLoadOptions,
  KernelShape,
} from './kernel.js';
