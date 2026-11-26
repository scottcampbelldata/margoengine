// The grid-particle liquid's coupling checks (FLUID-03): `FlipSolver` held to the harness. A dam break gives the same
// state at 24, 30 and 60 frames a second and a seek equal to a continuous run; and `DeckWaterSolver` (a FlipSolver
// riding a hull) couples both ways with the rigid solver: a heavier water load moves a floating hull further, and the
// hull's heel moves the water on its deck.
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { DeckWaterSolver, FlipSolver } from '../../dist/flip.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

const make = (rate = { num: 24, den: 1 }) =>
  new PhysicsWorld({ rate, gravity: [0, -9.81, 0] }).add(new FlipSolver(), {
    cells: [24, 12, 1],
    cellSize: 0.05,
    initial: (x, y) => x < 0.3 && y < 0.4,
    solids: [{ min: [0.8, 0, 0], max: [0.9, 0.1, 0.05] }],
    rate: 1,
  });

test('FlipSolver: the same dam break at 24, 30 and 60 frames a second', () =>
  frameRateIndependent(make, { seconds: 1 }));
test('FlipSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));

/** A dynamic hull (a light box) with a deck box on it, its water `depth` deep, heeled by `heel` radians at the start. */
const deck = (depth, heel) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -9.81, 0] }),
    hull = physics.addBody(null, {
      position: [0, 0, 0],
      rotation: [Math.sin(heel / 2), 0, 0, Math.cos(heel / 2)],
      colliders: { shape: 'box', halfExtents: [1, 0.5, 0.5], mass: 200 },
    }),
    water = new DeckWaterSolver('deckWater', { inflow: false }),
    world = new PhysicsWorld({ rate: { num: 24, den: 1 }, gravity: [0, -9.81, 0] })
      .add(new RigidSolver(), { physics })
      .add(water, {
        row: hull.row,
        offset: [-1, 0.5, -0.5],
        cells: [10, 6, 5],
        cellSize: 0.2,
        initial: (x, y) => y < depth,
      })
      .couple(['deckWater', 'rigid'], 'staggered');
  world.probe = { hull, water };
  return world;
};

test('DeckWaterSolver: the deck water loads the hull, and the hull moves the deck water', () =>
  effectBothWays(
    // Side 0 pushes from the water (deeper water on deck), side 1 from the hull (a heel); -1 is neither.
    (side) => deck(side === 0 ? 0.5 : 0.3, side === 1 ? 0.2 : 0),
    (world, side) => {
      if (side === 0) return world.probe.hull.linearVelocity[1];
      const p = world.probe.water.positions();
      let z = 0;
      for (let i = 2; i < p.length; i += 3) z += p[i];
      return z;
    },
  ));
