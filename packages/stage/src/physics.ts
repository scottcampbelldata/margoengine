import type { Mesh } from '@margoengine/core';
import type {
  BodyOptions,
  ColliderOptions,
  ColliderSettings,
  Physics,
  PhysicsBody,
  PhysicsOptions,
} from '@margoengine/physics';
import type { Stage } from './index.js';
import { optionalPackage, stageSignal } from './feature.js';
import { fault } from '../../shared/errors.js';

/** Options for `addPhysics`: the `Physics` options, and a signal for the load. */
export interface AddPhysicsOptions extends PhysicsOptions {
  /** Cancels the load; the stage's disposal cancels it too. */
  signal?: AbortSignal;
}
/** Options for `addBody`: the `physics.addBody` options plus settings for the collider it picks. */
export interface AddBodyOptions extends BodyOptions {
  /** Friction, restitution, density and so on of the collider picked for the mesh. Ignored with `colliders`. */
  collider?: ColliderSettings;
}

const worlds = new WeakMap<Stage, Promise<Physics>>();

async function createWorld(stage: Stage, options: PhysicsOptions): Promise<Physics> {
  const { Physics } = await optionalPackage(
    '@margoengine/physics',
    () => import('@margoengine/physics'),
    stage.signal,
  );
  await Physics.load({ signal: stage.signal });
  return Physics.attach(stage.engine, options);
}

/**
 * The stage's physics world, made on the first call: imports `@margoengine/physics`, runs `Physics.load()` and attaches
 * the world, which then steps with the frame loop. Later calls return the same world. Rejects with
 * `Install <package>` when one is missing, with AbortError when `signal` aborts or the stage is disposed first, and with
 * `state` when options are passed once the world exists: change those on the world.
 * @example const physics = await addPhysics(stage, { gravity: [0, -3.7, 0] });
 */
export async function addPhysics(stage: Stage, { signal, ...options }: AddPhysicsOptions = {}): Promise<Physics> {
  const abort = stageSignal(stage, signal);
  abort.throwIfAborted();
  let world = worlds.get(stage);
  // A world disposed by the caller is gone for good; the next call makes a new one.
  if (world && (await world.catch(() => null))?.isDisposed) world = undefined;
  if (world && Object.keys(options).length)
    throw fault('state', 'Physics exists on this stage: pass its options on the first call or set them on the world');
  if (!world) {
    const made = createWorld(stage, options);
    worlds.set(stage, (world = made));
    made.catch(() => {
      if (worlds.get(stage) === made) worlds.delete(stage);
    });
  }
  const physics = await world;
  abort.throwIfAborted();
  return physics;
}

/** The collider a mesh gets when the caller names none: the simplest shape that fits it, sized from its geometry. */
function fitted(mesh: Mesh | null, dynamic: boolean): ColliderOptions['shape'] | undefined {
  const geometry = mesh?.geometry;
  if (!geometry) return undefined;
  const v = geometry.vertices,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 6)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], v[i + axis]);
      max[axis] = Math.max(max[axis], v[i + axis]);
    }
  const center = min.map((value, axis) => (value + max[axis]) / 2),
    radius = (max[0] - min[0]) / 2,
    slack = 1e-4 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  // Bit per corner of the bounding box: a box has vertices on all eight, a wedge only on some.
  let corners = 0,
    onCorners = true,
    round = max.every((value, axis) => Math.abs(value - min[axis] - radius * 2) <= slack * 2);
  for (let i = 0; i < v.length && (onCorners || round); i += 6) {
    let squared = 0,
      corner = 0;
    for (let axis = 0; axis < 3; axis++) {
      const value = v[i + axis];
      squared += (value - center[axis]) ** 2;
      if (Math.abs(value - max[axis]) <= slack) corner |= 1 << axis;
      else if (Math.abs(value - min[axis]) > slack) onCorners = false;
    }
    corners |= 1 << corner;
    if (Math.abs(Math.sqrt(squared) - radius) > slack) round = false;
  }
  const { x, y, z } = mesh!.scale;
  if (onCorners && corners === 0xff) return 'box';
  if (round && Math.abs(x) === Math.abs(y) && Math.abs(y) === Math.abs(z)) return 'sphere';
  return dynamic ? 'convexHull' : 'trimesh';
}

/**
 * Gives a stage mesh a rigid body and a collider, loading physics on the first call (see `addPhysics`). Without
 * `colliders` the shape comes from the geometry: a box, a sphere, otherwise a convex hull for a dynamic body and the
 * exact triangles for a fixed or kinematic one. A mesh without geometry, such as a model's root, gets a box around what
 * it holds. Rejects as `addPhysics` does, and as `physics.addBody` does for a mesh with a body already.
 * @example const body = await addBody(stage, stage.sphere({ position: [0, 5, 0] }), { collider: { restitution: 0.6 } });
 */
export async function addBody(
  stage: Stage,
  mesh: Mesh | null,
  { collider, ...options }: AddBodyOptions = {},
): Promise<PhysicsBody> {
  const physics = await addPhysics(stage);
  if (options.colliders) return physics.addBody(mesh, options);
  const shape = fitted(mesh, (options.type ?? 'dynamic') === 'dynamic');
  return physics.addBody(mesh, {
    ...options,
    ...((shape ?? collider) && { colliders: { shape: shape ?? 'box', ...collider } as ColliderOptions }),
  });
}
