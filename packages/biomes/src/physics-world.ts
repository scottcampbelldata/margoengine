import { MargoError } from '@margoengine/math/errors';
import type * as PhysicsWorld from '@margoengine/physics/world';

type PhysicsWorldModule = typeof PhysicsWorld;

let loaded: PhysicsWorldModule | undefined;

/**
 * Loads `@margoengine/physics/world` on first use. The solvers' `load()` calls it, so a page that only reads the
 * biomes entry never fetches the physics world, and the solver's helpers (`world()`) are there once one exists.
 */
export async function loadPhysicsWorld(): Promise<PhysicsWorldModule> {
  loaded ??= await import('@margoengine/physics/world');
  return loaded;
}

/** The physics world helpers a loaded solver uses: memory sharing, region words and the kernel stack size. */
export function world(): PhysicsWorldModule {
  if (!loaded)
    throw new MargoError('state', 'The physics world is not loaded; create the solver with its async load().');
  return loaded;
}
