// The grid-particle liquid's coupling checks (FLUID-03): `FlipSolver` held to the harness. A dam break gives the same
// state at 24, 30 and 60 frames a second and a seek equal to a continuous run; and `DeckWaterSolver` (a FlipSolver
// riding a hull) couples both ways with the rigid solver: a heavier water load moves a floating hull further, and the
// hull's heel moves the water on its deck.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { DeckWaterSolver, FlipSolver } from '../../dist/flip.js';
import { WakeSolver } from '../../dist/sea.js';
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

/**
 * A box held to a wake's sea, giving the wake its water: a mound of `mound` m in the box, the wake starting with a hump
 * of `hump` m off to one side. No sponge, so the wake keeps every drop it is given.
 */
const boxInWake = (mound, hump) => {
  const liquid = new FlipSolver('liquid', { seaSource: true }),
    wake = new WakeSolver('wake', liquid.seaSourceField),
    sea = {
      elevation: (x, z) => wake.sample(x, z).height,
      water: {
        sample: (x, y, z, _t, o = { velocity: [0, 0, 0], density: 1000, temperature: 288 }) => {
          wake.velocityAt(x, y, z, o.velocity);
          return o;
        },
      },
    },
    world = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] })
      .add(wake, {
        cells: [64, 64],
        cellSize: 0.125,
        density: 1000,
        sponge: 0,
        waterBelow: true,
        initial: (x, z) => [hump * Math.exp(-((x - 1.8) ** 2 + z * z) / 0.1), 0],
      })
      .add(liquid, {
        cells: [16, 6, 16],
        cellSize: 0.1,
        origin: [-0.8, -0.3, -0.8],
        sea,
        blend: 3,
        seaTile: 0.2,
        initial: (x, y, z) => y < 0.3 || (Math.hypot(x - 0.8, z - 0.8) < 0.25 && y < 0.3 + mound),
      });
  world.probe = { liquid, wake };
  return world;
};

test('FlipSolver with seaSource: the box and its wake keep their water between them, to round-off', () => {
  const world = boxInWake(0.1, 0.05),
    { liquid, wake } = world.probe,
    water = () => {
      let v = 0;
      for (const h of wake.heights()) v += h * 0.125 * 0.125;
      return v + (liquid.count * 0.1 ** 3) / 8;
    },
    start = water();
  let given = 0;
  for (let f = 1; f <= 60; f++) {
    world.advance(f);
    const rows = liquid['words'](liquid['seaRegion']);
    for (let i = 4; i < rows.length; i += 5) given += Math.abs(rows[i]);
  }
  assert.ok(given > 1e-4, `the box and the wake trade water (${given} m^3)`);
  assert.ok(Math.abs(water() - start) < 1e-12 * 1000, `${water()} m^3 against ${start}`);
});

test('FlipSolver with seaSource: the box moves the wake, and the wake moves the box', () =>
  effectBothWays(
    // Side 0 pushes from the box (a mound in it), side 1 from the wake (a hump that runs into the box); -1 is neither.
    (side) => boxInWake(side === 0 ? 0.1 : 0, side === 1 ? 0.05 : 0),
    (world, side) => {
      const { liquid, wake } = world.probe;
      if (side === 0) return wake.heights().reduce((a, h) => a + Math.abs(h), 0);
      const p = liquid.positions();
      let x = 0;
      for (let i = 0; i < p.length; i += 3) x += p[i];
      return x;
    },
    { frames: 30 },
  ));

test('FlipSolver with seaSource refuses a rate above the base and tiles under a cell, naming the fix', () => {
  const w = new PhysicsWorld({ rate: { num: 60, den: 1 }, gravity: [0, -9.81, 0] });
  assert.throws(() => w.add(new FlipSolver('a', { seaSource: true }), { cells: [4, 4, 4], rate: 1 }), /rate 0/);
  assert.throws(
    () => w.add(new FlipSolver('b', { seaSource: true }), { cells: [4, 4, 4], cellSize: 0.1, seaTile: 0.05 }),
    /at least a cell/,
  );
});
