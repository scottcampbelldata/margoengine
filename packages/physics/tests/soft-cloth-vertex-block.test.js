// Vertex block descent for cloth (`setSolver('vertex-block')` on a body of edges, Chen et al. 2024): the edges are springs
// of each particle's Newton block on the step's incremental potential. A strip of the default fabric hangs to the sag its
// measured stiffness gives (Irvine's elastic cable, the same bar the edge solver meets), a soft edge rings at its own frequency,
// a run replays bit for bit, and a body can be moved onto the solver and off it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { FABRICS, fabricTensileStiffness, SoftBodies, SoftBodyDesc, SoftBodyMaterial } from '../dist/soft.js';

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

test("a strip of the default fabric on vertex blocks sags as an elastic cable of the fabric's measured stiffness", async () => {
  // As the edge solver's test: a 1 m strip of cotton shirting pinned at both ends, its warp along the span, settled for ten
  // seconds; Irvine's shallow elastic cable gives d = L (3 w L / (64 EA))^(1/3) with w / EA = rho_A g / K. Within 1 percent.
  const physics = new Physics(null),
    soft = await SoftBodies.attach(physics),
    nu = 21,
    l = 0.05,
    span = (nu - 1) * l,
    cloth = soft.create(
      SoftBodyDesc.cloth([0, 1, 0], [l, 0, 0], [0, 0, l], nu, 2)
        .setPinnedParticles([0, 1, (nu - 1) * 2, (nu - 1) * 2 + 1])
        .setSolver('vertex-block'),
    );
  assert.equal(cloth.solver, 'vertex-block');
  for (let i = 0; i < 600; i++) physics.step();
  const sag = 1 - cloth.particlePosition(((nu - 1) / 2) * 2)[1],
    stiffness = fabricTensileStiffness(FABRICS.cottonShirting.tensile.warp),
    expected = span * Math.cbrt((3 * FABRICS.cottonShirting.arealDensity * 9.81 * span) / (64 * stiffness));
  near(sag, expected, 0.01 * expected, 'the mid-span sag');
});

test('a soft edge on vertex blocks rings at its natural frequency', async () => {
  // A 1 kg particle on a 4 Hz edge from a pin, pulled 5 cm along it and let go in no gravity: its period is 0.25 s.
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    soft = await SoftBodies.attach(physics),
    rope = soft.create(
      SoftBodyDesc.rope([0, 0, 0], [1, 0, 0], 2, { bending: false })
        .setPinnedParticles([0])
        .setParticleMass(1)
        .setMaterial(SoftBodyMaterial.uniform(4, 0))
        .setSolver('vertex-block'),
    );
  rope.setParticlePosition(1, [1.05, 0, 0]);
  const crossings = [];
  let last = 0.05;
  for (let i = 1; i <= 240; i++) {
    physics.step();
    const x = rope.particlePosition(1)[0] - 1;
    if (last > 0 && x <= 0) crossings.push(i / 60 - x / (x - last) / 60);
    last = x;
  }
  assert.ok(crossings.length >= 3, `${crossings.length} crossings`);
  const period = (crossings.at(-1) - crossings[0]) / (crossings.length - 1);
  near(period, 0.25, 0.005, 'period');
});

test('a cloth on vertex blocks replays bit for bit, and moves between solvers', async () => {
  const run = async () => {
    const physics = new Physics(null),
      soft = await SoftBodies.attach(physics),
      cloth = soft.create(
        SoftBodyDesc.cloth([0, 2, 0], [0.1, 0, 0], [0, 0, 0.1], 10, 10)
          .setPinnedParticles([0, 9])
          .setSolver('vertex-block'),
      );
    for (let i = 0; i < 90; i++) physics.step();
    return { soft, physics, cloth, hash: soft.hash() };
  };
  const a = await run(),
    b = await run();
  assert.equal(a.hash, b.hash);
  // Off the block solver and back: the edges go back to the sweep and the exact solve, and the cloth carries on.
  a.cloth.setSolver('constraints');
  for (let i = 0; i < 30; i++) a.physics.step();
  a.cloth.setSolver('vertex-block');
  for (let i = 0; i < 30; i++) a.physics.step();
  const p = a.cloth.particlePositions();
  assert.ok(p.every(Number.isFinite));
  assert.equal(a.cloth.solver, 'vertex-block');
});
