// `@margoengine/physics/next`: the own solver while it is built. A preview entry, removed when it becomes the root.
export { KernelWorld, loadKernel } from './kernel.js';
export { Physics } from './next/physics.js';
export { PhysicsBody } from './next/body.js';
export { PhysicsCollider } from './next/collider.js';
export type { PhysicsEventMap, PhysicsOptions } from './next/physics.js';
export type { BodyOptions, BodyType } from './body.js';
export type { ColliderOptions, ShapeOptions } from './shapes.js';
export type {
  KernelBodyKind,
  KernelColliderOptions,
  KernelColumn,
  KernelLoadOptions,
  KernelShape,
} from './kernel.js';
