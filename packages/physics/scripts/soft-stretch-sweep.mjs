// Reproduces the rope-stretch comparison of docs/whitepaper/claims.md: a 3.8 m rope pinned at the top, rigid edges, carrying a
// 16 kg crate on its last particle, hung for five seconds, across solver settings and particle masses. A rope that does not
// stretch is 3.8 m from the pin to its end at every setting (the closed form: an inextensible rope under a load).
// Run after `npm run build:packages`: node packages/physics/scripts/soft-stretch-sweep.mjs
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;
const rows = [];
for (const [iterations, substeps, particleMass] of [
  [1, 4, 0.01],
  [2, 8, 0.01],
  [8, 8, 0.01],
  [2, 16, 0.01],
  [2, 8, 0.5],
  [4, 4, 0.1],
]) {
  const physics = new Physics(null, {});
  const soft = await SoftBodies.attach(physics, { iterations, substeps });
  const crate = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], density: 250 },
  });
  const rope = soft.create(
    SoftBodyDesc.rope([0, 6, 0], [0, 2.2, 0], 20, { bending: false })
      .setPinnedParticles([0])
      .setParticleMass(particleMass)
      .setLinearDamping(1)
      .setParticleRadius(0.01),
  );
  rope.attachParticle(19, crate);
  for (let i = 0; i < 300; i++) physics.step();
  const end = rope.particlePosition(19);
  rows.push({
    iterations,
    substeps,
    'particle kg': particleMass,
    'mass ratio': Math.round(crate.mass / particleMass),
    'pin to end (m)': Math.hypot(end[0], 6 - end[1], end[2]).toFixed(3),
  });
}
console.table(rows);
