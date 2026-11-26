// The ship solver's coupling checks (SEA-09): `ShipSolver` holding a KVLCC2 model hull through `bodyForces` as it turns under
// its rudder and screw, held to the harness: the same track at 24, 30 and 60 frames a second, and a seek equal to a continuous
// run.
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { KVLCC2_L7, ShipSolver } from '../../dist/ship.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();

const make = (rate = { num: 24, den: 1 }) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    M = KVLCC2_L7,
    body = physics.addBody(null, {
      position: [0, 0, 0],
      linearVelocity: [1.18, 0, 0],
      colliders: { shape: 'box', halfExtents: [M.length / 2, M.draught, M.beam / 2], mass: 1025 * M.volume },
    }),
    ships = new ShipSolver(),
    world = new PhysicsWorld({ rate })
      .add(new RigidSolver(), { physics })
      .add(ships, { ships: [{ row: body.row, model: M, rudderRate: 0.2 }] })
      .couple(['ship', 'rigid'], 'staggered');
  ships.control(0).revolutions = 12;
  ships.control(0).rudder = 0.6;
  return world;
};

test('ShipSolver: the same track at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('ShipSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
