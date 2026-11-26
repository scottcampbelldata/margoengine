import { Physics } from '../../dist/index.js';
import { CellMaterial, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { TissueSolver } from '../../dist/tissue.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';

export const step = 1 / 60;
export const length = 0.5;
export const mass = 0.25;
export const elastic = 6000;
export const boneStiffness = 900;
export async function createTissueFixture(sliding, position) {
  const physics = new Physics(null, { gravity: [0, 0, 0], fixedTimestep: step });
  const bone = physics.addBody(null, { type: 'kinematicPosition', position });
  const soft = await SoftBodies.attach(physics, { substeps: 1, iterations: 2 });
  soft.cellDamping = 0;
  const material = Object.assign(new CellMaterial(), {
    youngsModulus: elastic,
    poissonRatio: 0,
    deformationDamping: 0,
  });
  const tissue = soft.create(
    new SoftBodyDesc([
      [0, 0, 0],
      [length, 0, 0],
      [0, length, 0],
      [0, 0, length],
    ])
      .setCells([0, 1, 2, 3], material)
      .setSurface()
      .setSolver('vertex-block')
      .setParticleRadius(0)
      .setPinnedParticles([0, 1, 2])
      .setParticleMass(mass)
      .setLinearDamping(0),
  );
  const binding = {
    tissue,
    particle: 3,
    bone,
    localPoint: [0, 0, length],
    sliding: sliding ? { localNormal: [0, 0, 1], stiffness: boneStiffness, damping: 0 } : undefined,
  };
  const world = new PhysicsWorld({ rate: { num: 60, den: 1 } })
    .add(new RigidSolver(), { physics })
    .add(new TissueSolver(), { soft, bindings: [binding] })
    .couple(['rigid', 'tissue'], 'staggered');
  return { world, tissue, bone, physics };
}
