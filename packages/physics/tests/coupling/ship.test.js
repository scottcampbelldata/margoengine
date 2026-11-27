// The ship solver's coupling checks (SEA-09): `ShipSolver` holding a KVLCC2 model hull through `bodyForces` as it turns under
// its rudder and screw, held to the harness: the same track at 24, 30 and 60 frames a second, and a seek equal to a continuous
// run; and driving through pack ice (ICE-04), each pushing the other.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { KVLCC2_L7, ShipSolver } from '../../dist/ship.js';
import { PackIceSolver } from '../../dist/pack-ice.js';
import { PhysicsWorld, RigidSolver, worldMemory } from '../../dist/world.js';
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

test('ShipSolver with PackIceSolver: a ship drives through floes, each pushing the other, momentum equal and opposite', async () => {
  const speed = 1.18,
    run = async (floes) => {
      const pack = await PackIceSolver.load({ rigid: true }),
        world = new PhysicsWorld({ rate: { num: 60, den: 1 }, memory: worldMemory(false) }),
        physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0], arena: world.arena }),
        M = KVLCC2_L7,
        body = physics.addBody(null, {
          position: [0, 0, 0],
          linearVelocity: [speed, 0, 0],
          colliders: { shape: 'box', halfExtents: [M.length / 2, M.draught, M.beam / 2], mass: 1025 * M.volume },
        }),
        ships = new ShipSolver();
      world
        .add(new RigidSolver(), { physics })
        .add(ships, { ships: [{ row: body.row, model: M }] })
        .add(pack, {
          restitution: 0,
          friction: 0,
          seaLevel: 0,
          icebreaking: false,
          airSkinDrag: 0,
          airEdgeDrag: 0,
          waterSkinDrag: 0,
          waterEdgeDrag: 0,
          vessels: [{ bodyRow: body.row, length: M.length, beam: M.beam }],
          floes,
        })
        .couple(['ship', 'pack-ice', 'rigid'], 'staggered');
      ships.control(0).revolutions = ships.revolutionsFor(0, speed);
      let impulse = 0;
      for (let t = 1; t <= 60 * 6; t++) {
        world.advance(t);
        impulse += pack.vesselImpulse(body.row).linear[0];
      }
      return { pack, body, ships, impulse };
    };
  // Floes 0.5 m across and 0.3 m thick lie ahead of the bow, 2 m to 4 m out; an empty sea for the same run.
  const ice = await run([4, 5.5, 7].map((x) => ({ position: [x, 0], velocity: [0, 0], radius: 0.5, thickness: 0.3 }))),
    clear = await run([{ position: [0, 40], velocity: [0, 0], radius: 0.5, thickness: 0.3 }]);
  // The floes slow the ship, and the ship drives them on ahead: the ice's impulse on the hull is what the floes gained.
  assert.ok(
    ice.body.linearVelocity[0] < clear.body.linearVelocity[0] - 1e-3,
    `${ice.body.linearVelocity} ${clear.body.linearVelocity}`,
  );
  let gained = 0;
  for (let i = 0; i < 3; i++) {
    const f = ice.pack.sample(i);
    gained += 917 * f.volume * f.velocity[0];
  }
  assert.ok(
    gained > 0 && ice.impulse < 0 && Math.abs(gained + ice.impulse) <= 1e-3 * gained,
    `${gained} ${ice.impulse}`,
  );
});
