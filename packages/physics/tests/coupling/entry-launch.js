import { EntrySolver } from '../../dist/entry.js';
import { Physics } from '../../dist/index.js';
import { SpectralSea, WakeSolver } from '../../dist/sea.js';
import { HullSolver, SEA_WATER } from '../../dist/seakeeping.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';
import { vHull } from './sections.js';

/** A small coated launch hull crossing its own resolved wake. */
export function makeEntryLaunch({ observed = true, probeMesh, shared = false, pressure = false, mass = 9 } = {}) {
  const mesh = vHull(Math.PI / 5, 0.18, 1);
  // The section fixture points its normals inward. The launch uses an outward-wound hull.
  for (let i = 0; i < mesh.indices.length; i += 3) {
    [mesh.indices[i + 1], mesh.indices[i + 2]] = [mesh.indices[i + 2], mesh.indices[i + 1]];
  }
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(shared) });
  const physics = new Physics(null, { fixedTimestep: 1 / 60, arena: world.arena });
  const vessel = physics.addBody(null, {
    position: [-0.5, 0.36, 0],
    linearVelocity: [0.8, -4, 0],
    enabledRotations: [false, false, false],
    colliders: { shape: 'box', halfExtents: [0.5, 0.065, 0.18], mass },
  });
  const bodies = [];
  let probe;
  if (probeMesh) {
    probe = physics.addBody(null, {
      position: [1.4, 0.3, 0],
      linearVelocity: [0, -4, 0],
      colliders: { shape: 'sphere', radius: 0.05, mass: 1.1 },
    });
    bodies.push({ row: probe.row, mesh: probeMesh });
  }
  if (observed) bodies.push({ row: vessel.row, mesh, contactAngle: 160, effectsOnly: true });
  const hull = new HullSolver('hull', { minimumRadius: 0.12 });
  const wake = new WakeSolver('wake', hull.wakeSourceField);
  const sea = new SpectralSea({
    waves: {
      frequencies: Float64Array.of(0.1, 0.2, 0.4),
      directions: Float64Array.of(0, Math.PI),
      energy: new Float64Array(6),
      depth: 2,
      density: SEA_WATER,
    },
    patches: [wake],
  });
  const entry = new EntrySolver('entry', { cavityPressure: pressure });
  if (pressure) hull.connectEntryCavity(entry.cavityPressureField);
  world
    .add(new RigidSolver(), { physics })
    .add(hull, {
      hulls: [{ row: vessel.row, mesh }],
      sea,
      radiation: false,
      rollDamping: false,
      greenWater: false,
    })
    .add(wake, { cells: [40, 40], cellSize: 0.15, depth: 2, waterBelow: true })
    .add(entry, { bodies, sea })
    .couple(pressure ? ['entry', 'hull', 'wake', 'rigid'] : ['hull', 'wake', 'entry', 'rigid'], 'staggered');
  return { world, physics, vessel, probe, sea, wake, entry, hull };
}
