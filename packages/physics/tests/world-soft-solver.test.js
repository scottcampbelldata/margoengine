// The soft kernel as a framework solver: coupled soft before rigid, a world steps a cloth with a box on it to the bits Physics
// gives stepped alone, the soft bodies step once a tick (the Physics attachment's own step does nothing in a world), its pushes
// on the bodies go through the `bodyImpulses` and `bodyForces` ports and hold for one step only, and a snapshot restores.
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

test('the push on a body goes through the ports: the cloth holds the box up with a force over each step, none left between', async () => {
  const s = await scene(),
    solver = new SoftSolver(),
    w = new PhysicsWorld({ rate: { num: 60, den: 1 } })
      .add(new RigidSolver(), { physics: s.physics })
      .add(solver, { soft: s.soft })
      .couple(['soft', 'rigid'], 'staggered');
  w.advance(120);
  const [, forces] = solver.exportPorts(120),
    words = new Float64Array(
      forces.region.memory?.buffer ?? w.memory.buffer,
      forces.region.byteOffset,
      forces.region.byteLength / 8,
    ),
    up = words[s.box.row * 6 + 1];
  // Resting on the cloth, the 2 kg box is held up by about its weight through the step.
  assert.ok(up > 0.5 * 2 * 9.81 && up < 2 * 2 * 9.81, `the force holding it up: ${up} N`);
  const c = s.physics.kernel.columns;
  assert.equal(c.forceY[s.box.row], 0, 'between ticks no force is left on the body');
  // Physics stepped alone takes off exactly what its f32 force columns took too: taking off the f64 force left its rounding
  // behind, a stray force that grew a little every step the cloth held the box.
  const alone = await scene();
  for (let i = 0; i < 120; i++) alone.physics.step();
  const a = alone.physics.kernel.columns;
  assert.deepEqual(
    [a.forceX[alone.box.row], a.forceY[alone.box.row], a.forceZ[alone.box.row]],
    [0, 0, 0],
    'stepped alone, no force is left on the body either',
  );
});

test('a snapshot taken between ticks restores into a run that goes on bit for bit', async () => {
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
