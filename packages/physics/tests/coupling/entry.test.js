// Water entry's coupling checks (SEA-14): `EntrySolver` beside `RigidSolver`, held to the harness. A ball dropped in leaves
// the same state at 24, 30 and 60 frames a second, a seek equals a continuous run, and the effect runs both ways: a
// faster ball makes a different entry, and the water slows the ball.
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { EntrySolver } from '../../dist/entry.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

/** A sphere of radius R as a UV mesh wound outward. */
function sphereMesh(R, nu = 24, nv = 12) {
  const vertices = [],
    indices = [];
  for (let j = 0; j <= nv; j++)
    for (let i = 0; i <= nu; i++) {
      const th = (Math.PI * j) / nv,
        ph = (2 * Math.PI * i) / nu;
      vertices.push(R * Math.sin(th) * Math.cos(ph), R * Math.cos(th), R * Math.sin(th) * Math.sin(ph));
    }
  const at = (i, j) => j * (nu + 1) + i;
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      if (j > 0) indices.push(at(i, j), at(i + 1, j), at(i + 1, j + 1));
      if (j < nv - 1) indices.push(at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  return { vertices, indices };
}

const make = (rate = { num: 24, den: 1 }, { speed = 9, density = 1025 } = {}) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 240, gravity: [0, -9.81, 0] }),
    R = 0.05,
    ball = physics.addBody(null, {
      position: [0, 0.3, 0],
      linearVelocity: [1, -speed, 0],
      colliders: { shape: 'sphere', radius: R, mass: 3 * 1025 * (4 / 3) * Math.PI * R ** 3 },
    }),
    entry = new EntrySolver(),
    world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] })
      .add(new RigidSolver(), { physics })
      .add(entry, { bodies: [{ row: ball.row, mesh: sphereMesh(R) }], sea: { elevation: () => 0, density }, level: 2 })
      .couple(['entry', 'rigid'], 'staggered');
  world.probe = { entry, ball };
  return world;
};

test('EntrySolver: the same entry at 24, 30 and 60 frames a second', () => frameRateIndependent(make, { seconds: 1 }));
test('EntrySolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('EntrySolver: a faster ball makes a different entry, and denser water slows the ball more', () =>
  effectBothWays(
    // Side 0 pushes the ball (faster), side 1 the water (denser); -1 is neither.
    (side) => make({ num: 24, den: 1 }, side === 0 ? { speed: 12 } : side === 1 ? { density: 1400 } : {}),
    (world, side) =>
      side === 0
        ? JSON.stringify(world.probe.entry.splashes().map((e) => e.speed.toFixed(6)))
        : world.probe.ball.linearVelocity[1],
  ));
