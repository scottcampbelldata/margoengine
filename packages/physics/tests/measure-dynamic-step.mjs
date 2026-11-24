// Measures the dynamic-crate climb on both solvers: node tests/measure-dynamic-step.mjs
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';
await Promise.all([Physics.load(), RapierPhysics.load()]);
const radius = 0.3, halfHeight = 0.4;
const climb = (World, includeDynamicBodies) => {
  const physics = new World(null);
  physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [20, 0.5, 20] } });
  physics.addBody(null, { position: [1.2, 0.1, 0], type: 'dynamic', colliders: { shape: 'box', halfExtents: [0.5, 0.1, 5], mass: 500 } });
  const walker = physics.addBody(null, { type: 'kinematicPosition', position: [0, halfHeight + radius + 0.02, 0], colliders: { shape: 'capsule', halfHeight, radius } });
  const controller = physics.createCharacterController(walker, { autostep: { maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies } });
  let peak = 0;
  for (let i = 0; i < 30; i++) { physics.step ? physics.step() : physics.update(1 / 60); controller.move([0.05, -0.05, 0]); peak = Math.max(peak, walker.position[1]); }
  physics.dispose();
  return peak;
};
for (const [name, World] of [['own', Physics], ['rapier', RapierPhysics]])
  console.log(name, 'include', climb(World, true).toFixed(3), 'exclude', climb(World, false).toFixed(3), 'rest', (halfHeight + radius + 0.02).toFixed(3));
