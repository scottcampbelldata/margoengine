import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../../packages/physics/dist/index.js';

let initialized;
const queryMarkers = 16;
export async function createWorkload(count = 80) {
  if (!Number.isInteger(count) || count < 80 || count > 528)
    throw new RangeError('Physics workload count must be 80..528');
  const started = performance.now();
  // Rapier is optional and initialized once; a rejected initialization can be retried.
  try {
    await (initialized ??= RAPIER.init());
  } catch (error) {
    initialized = undefined;
    throw error;
  }
  const initializedAt = performance.now(),
    initializationElapsedMilliseconds = initializedAt - started;
  let physics = new Physics(null, { rapier: RAPIER, fixedTimestep: 1 / 60, maxSubsteps: 4, interpolate: false });
  const points = new Float32Array(count * 4),
    bodyCount = count - queryMarkers,
    columns = Math.ceil(Math.sqrt(bodyCount)),
    rows = Math.ceil(bodyCount / columns),
    extent = Math.max(columns, rows) * 0.22 + 1;
  let bodies = [],
    disposed = false,
    time = 0,
    nextImpulse = 0.25,
    impulseCursor = 0,
    frames = 0,
    fixedSteps = 1,
    contactStarts = 0,
    impulses = 0,
    resets = 0,
    raycasts = 0,
    queryHits = 0,
    sleepingBodies = 0,
    stepCpuMilliseconds = 0,
    queryCpuMilliseconds = 0;
  const lastContact = new Float64Array(bodyCount).fill(-Infinity);
  physics.on('contactstart', ({ bodyA, bodyB }) => {
    contactStarts++;
    for (const body of [bodyA, bodyB]) if (Number.isInteger(body.userData)) lastContact[body.userData] = time;
  });
  try {
    physics.addBody(null, {
      type: 'fixed',
      position: [0, -0.5, 0],
      colliders: { shape: 'box', halfExtents: [extent, 0.5, extent], friction: 0.8 },
    });
    for (let i = 0; i < bodyCount; i++)
      bodies.push(
        physics.addBody(null, {
          position: [
            ((i % columns) - (columns - 1) / 2) * 0.4,
            0.7 + (i % 4) * 0.3,
            (Math.floor(i / columns) - (rows - 1) / 2) * 0.4,
          ],
          lockRotations: true,
          linearDamping: 0.3,
          userData: i,
          colliders: { shape: 'box', halfExtents: [0.11, 0.11, 0.11], restitution: 0.3, friction: 0.7 },
        }),
      );
    physics.step();
  } catch (error) {
    physics.dispose();
    throw error;
  }
  const paint = () => {
    sleepingBodies = 0;
    for (let i = 0; i < bodyCount; i++) {
      const body = bodies[i],
        position = body.position;
      if (body.sleeping) sleepingBodies++;
      if (position[1] < -1 || Math.abs(position[0]) > extent || Math.abs(position[2]) > extent) {
        position[0] = ((i % columns) - (columns - 1) / 2) * 0.4;
        position[1] = 1.5;
        position[2] = (Math.floor(i / columns) - (rows - 1) / 2) * 0.4;
        body.setPosition(position).setLinearVelocity([0, 0, 0]);
        resets++;
      }
      points.set(
        [position[0], position[1], position[2], time - lastContact[i] < 0.25 ? 1 : body.sleeping ? 2 : 0],
        i * 4,
      );
    }
    const start = performance.now();
    queryHits = 0;
    for (let i = 0; i < queryMarkers; i++) {
      const x = ((i % 4) - 1.5) * extent * 0.45 + Math.sin(time) * 0.15,
        z = (Math.floor(i / 4) - 1.5) * extent * 0.45,
        hit = physics.raycast([x, 6, z], [0, -1, 0], { maxDistance: 8 });
      raycasts++;
      points.set(hit ? [hit.point[0], hit.point[1] + 0.15, hit.point[2], 2] : [x, -0.25, z, 3], (i + bodyCount) * 4);
      if (hit) queryHits++;
    }
    queryCpuMilliseconds = performance.now() - start;
  };
  try {
    paint();
  } catch (error) {
    physics.dispose();
    throw error;
  }
  const setupCpuMilliseconds = performance.now() - initializedAt,
    setupElapsedMilliseconds = performance.now() - started;
  return {
    points,
    get physics() {
      return physics;
    },
    get bodies() {
      return bodies;
    },
    bounds: { min: [-extent, -0.3, -extent], max: [extent, 3.2, extent] },
    description:
      'Real Rapier fixed steps simulate rotation-locked 0.22-meter cubes on a ground collider. Staggered impulses keep contacts active; amber means a recent contact, purple a sleeping body or a downward ray hit, and red a missed query. Sixteen markers show actual ray-hit positions.',
    step(delta) {
      if (disposed) return;
      if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) throw new RangeError('Invalid physics frame delta');
      time += delta;
      frames++;
      const start = performance.now();
      if (time >= nextImpulse) {
        for (let i = 0; i < Math.ceil(bodyCount / 16); i++) {
          const index = impulseCursor++ % bodyCount;
          bodies[index].applyImpulse([0.0007 * Math.sin(index), 0.022, 0.0007 * Math.cos(index)]);
          impulses++;
        }
        nextImpulse += 0.25;
      }
      physics.update(delta);
      fixedSteps = physics.stepCount;
      stepCpuMilliseconds = performance.now() - start;
      paint();
    },
    details: () => ({
      dynamicBodies: bodyCount,
      fixedBodies: 1,
      queryMarkers,
      frames,
      fixedSteps,
      contactStarts,
      impulses,
      resets,
      raycasts,
      queryHits,
      sleepingBodies,
      initializationElapsedMilliseconds,
      setupElapsedMilliseconds,
      setupCpuMilliseconds,
      stepCpuMilliseconds,
      queryCpuMilliseconds,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      physics.dispose();
      physics = bodies = null;
    },
  };
}
