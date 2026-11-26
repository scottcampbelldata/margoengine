// The bubbles' coupling checks (FW-4): `BubbleSolver` fed by a `ShipSolver`'s propeller race (SEA-09: `shipAeration` from
// its `wash`, carried by its `water`), held to the harness: the same plume at 24, 30 and 60 frames a second, a seek equal
// to a continuous run, and the effect both ways: a faster screw takes in more air, and the bubbles' foam reaches a foam
// field.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { BubbleSolver, shipAeration } from '../../dist/bubbles.js';
import { KVLCC2_L7, ShipSolver } from '../../dist/ship.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { effectBothWays, frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

const make = (rate = { num: 24, den: 1 }, { revolutions = 12, foam } = {}) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, -9.81, 0] }),
    M = KVLCC2_L7,
    body = physics.addBody(null, {
      position: [0, 0, 0],
      linearVelocity: [1.18, 0, 0],
      gravityScale: 0,
      colliders: { shape: 'box', halfExtents: [M.length / 2, M.draught, M.beam / 2], mass: 1025 * M.volume },
    }),
    ships = new ShipSolver(),
    bubbles = new BubbleSolver(),
    world = new PhysicsWorld({ rate, gravity: [0, -9.81, 0] })
      .add(new RigidSolver(), { physics })
      .add(ships, { ships: [{ row: body.row, model: M, rudderRate: 0.2 }] })
      .add(bubbles, { sources: shipAeration(ships), water: ships.water, capacity: 40000, ...(foam ? { foam } : {}) })
      // The bubbles read the ship's races where its last step left them: they step after it, in its group.
      .couple(['ship', 'rigid', 'bubbles'], 'staggered');
  ships.control(0).revolutions = revolutions;
  world.probe = { bubbles };
  return world;
};

test('BubbleSolver: the same plume at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('BubbleSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test("BubbleSolver: a faster screw takes in more air, and the bubbles' foam reaches the foam field", () => {
  let laid = 0;
  effectBothWays(
    // Side 0 pushes from the ship (a faster screw), side 1 from the bubbles (a foam field to lay into); -1 is neither.
    (side) => {
      const counter = { laid: 0, addFoam: () => counter.laid++ },
        world = make(
          { num: 24, den: 1 },
          { revolutions: side === 0 ? 18 : 12, ...(side === 1 ? { foam: counter } : {}) },
        );
      world.counter = counter;
      return world;
    },
    (world, side) => {
      if (side === 1) laid = Math.max(laid, world.counter.laid);
      return side === 0 ? world.probe.bubbles.ledger().taken : world.counter.laid;
    },
    { frames: 96 },
  );
  assert.ok(laid > 0, 'foam was laid');
});
