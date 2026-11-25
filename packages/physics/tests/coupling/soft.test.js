// The soft solver's coupling checks (docs/physics-framework.md, section 10): `SoftSolver` and `RigidSolver` coupled soft before
// rigid, a cloth pinned at its corners with a box dropped on it, held to the harness: the same state at 24, 30 and 60 frames a
// second, and a seek equal to a continuous run. The harness builds its worlds at once and the soft kernel loads with a
// promise, so the scenes are made first and each world takes the next.
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver, SoftSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

async function scene() {
  const physics = new Physics(null, { fixedTimestep: 1 / 60 }),
    soft = await SoftBodies.attach(physics),
    n = 6;
  soft.create(
    SoftBodyDesc.cloth([-0.25, 1, -0.25], [0.1, 0, 0], [0, 0, 0.1], n, n).setPinnedParticles([
      0,
      n - 1,
      (n - 1) * n,
      n * n - 1,
    ]),
  );
  physics.addBody(null, {
    position: [0, 1.25, 0],
    colliders: { shape: 'box', halfExtents: [0.06, 0.06, 0.06], mass: 1 },
  });
  return { physics, soft };
}

const scenes = [];
for (let i = 0; i < 5; i++) scenes.push(await scene());

const make = (rate = { num: 24, den: 1 }) => {
  const { physics, soft } = scenes.shift();
  return new PhysicsWorld({ rate })
    .add(new RigidSolver(), { physics })
    .add(new SoftSolver(), { soft })
    .couple(['soft', 'rigid'], 'staggered');
};

test('SoftSolver: the same cloth and box at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('SoftSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
