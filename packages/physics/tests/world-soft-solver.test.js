// The soft kernel as a framework solver: coupled soft before rigid, a world steps a cloth with a box on it to the bits Physics
// gives stepped alone, the soft bodies step once a tick (the Physics attachment's own step does nothing in a world), and the
// held forces it leaves on the bodies are state a snapshot carries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../dist/world.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

/** A cloth pinned at its corners and a box dropped on it. */
async function scene() {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    soft = await SoftBodies.attach(physics),
    n = 8;
  const cloth = soft.create(
    SoftBodyDesc.cloth([-0.35, 1, -0.35], [0.1, 0, 0], [0, 0, 0.1], n, n).setPinnedParticles([
      0,
      n - 1,
      (n - 1) * n,
      n * n - 1,
    ]),
  );
  const box = physics.addBody(null, {
    position: [0.02, 1.3, -0.01],
    colliders: { shape: 'box', halfExtents: [0.08, 0.08, 0.08], mass: 2 },
  });
  return { physics, soft, cloth, box };
}

/** A world of the scene's rigid and soft solvers, soft stepping before rigid. */
function world(s, rate = { num: 60, den: 1 }) {
  return new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics: s.physics })
    .add(new SoftSolver(), { soft: s.soft })
    .couple(['soft', 'rigid'], 'staggered');
}

test('coupled soft before rigid, a world steps a cloth and a box to the bits Physics gives alone, each once a tick', async () => {
  const alone = await scene(),
    inWorld = await scene();
  for (let i = 0; i < 90; i++) alone.physics.step();
  world(inWorld).advance(90);
  assert.equal(inWorld.physics.stepCount, 90);
  // Nothing steps twice: the Physics attachment's own soft step does nothing in a world, and the solver steps once a tick.
  assert.equal(inWorld.soft.steps, 90);
  assert.equal(alone.soft.steps, 90);
  assert.equal(inWorld.soft.hash(), alone.soft.hash());
  assert.equal(inWorld.physics.kernel.hash, alone.physics.kernel.hash);
  assert.deepEqual(inWorld.box.position, alone.box.position);
  assert.ok(inWorld.box.position[1] < 1.3, 'the box came down onto the cloth');
});

test('a snapshot carries the forces the soft step left on the bodies: a restored run goes on bit for bit', async () => {
  const continuous = await scene(),
    seeking = await scene();
  const a = world(continuous),
    b = world(seeking);
  a.advance(60);
  b.advance(30);
  const saved = b.takeSnapshot();
  b.advance(45);
  b.restoreSnapshot(saved.bytes);
  assert.equal(b.hash(), saved.hash);
  b.advance(60);
  assert.equal(b.hash(), a.hash());
  assert.equal(seeking.soft.hash(), continuous.soft.hash());
  assert.deepEqual(seeking.box.position, continuous.box.position);
});

test('a SoftSolver refuses what is not a SoftBodies, and a step that is not its Physics step', async () => {
  assert.throws(() => new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new SoftSolver(), {}), /SoftBodies/);
  const s = await scene(),
    solver = new SoftSolver();
  world({ physics: s.physics, soft: s.soft }); // drives s.soft
  const w = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(solver, { soft: s.soft });
  assert.throws(
    () => solver.step({ tick: 0, level: 0, seed: 1, inputs: new Map(), cell: [0, 0, 0] }, 1 / 120),
    /1\/60|0\.01666/,
  );
  assert.ok(w);
});
