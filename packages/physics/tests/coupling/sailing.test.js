// The sailing solver's coupling checks (SEA-09): `SailingSolver` holding a yacht's hull through `bodyForces` in a wind,
// held to the harness (the same sail at 24, 30 and 60 frames a second, a seek equal to a continuous run), and the yacht
// driven by a cloth sail of AERO-02's `SailForce` lashed to its mast, the sail's load moving the hull and the hull's speed
// taking the sail's wind away.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { SailingSolver } from '../../dist/ship.js';
import { SailForce, SoftBodies, SoftBodyDesc } from '../../dist/soft.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const hull = {
  length: 11.9,
  beam: 3.18,
  draught: 0.4,
  volume: 6.05,
  waterplane: 26.8,
  lcb: 6.44,
  lcf: 6.82,
  prismatic: 0.56,
  midship: 0.72,
  keel: { draught: 2.3, volume: 0.25, root: 1.6, tip: 0.9, thickness: 0.12, centre: 0.9 },
  rudder: { area: 0.9, chord: 0.6, thickness: 0.12 },
};
const rig = { I: 16.2, J: 5.1, P: 16.7, E: 5.6, boom: 1.8, freeboard: 1, mass: 6200, metacentricHeight: 2.5 };

const make = (rate = { num: 24, den: 1 }) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
    body = physics.addBody(null, {
      linearVelocity: [3, 0, 0],
      enabledRotations: [true, true, false],
      colliders: { shape: 'box', halfExtents: [6, 2, 1.6], mass: 6200 },
    }),
    sailing = new SailingSolver(),
    world = new PhysicsWorld({ rate })
      .add(new RigidSolver(), { physics })
      .add(sailing, { yachts: [{ row: body.row, hull, rig }], wind: [0, 0, -6] })
      .couple(['sailing', 'rigid'], 'staggered');
  sailing.control(0).heading = 0;
  return world;
};

test('SailingSolver: the same sail at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('SailingSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test("SailingSolver with AERO-02's SailForce: a cloth sail on the mast drives the hull, and the hull's speed eases the sail", async () => {
  const run = async (water) => {
    const physics = new Physics(null, { fixedTimestep: 1 / 60, gravity: [0, 0, 0] }),
      body = physics.addBody(null, {
        enabledRotations: [true, true, false],
        colliders: { shape: 'box', halfExtents: [6, 2, 1.6], mass: 6200 },
      }),
      soft = await SoftBodies.attach(physics),
      // A square sail 6 m by 8 m across the hull at its mast, its head and foot lashed to the yard and boom.
      nu = 4,
      nv = 5,
      cloth = soft.create(SoftBodyDesc.cloth([0, 2, -3], [0, 0, 6 / (nu - 1)], [0, 8 / (nv - 1), 0], nu, nv)),
      wind = [8, 0, 0];
    for (let i = 0; i < nu; i++) {
      cloth.attachParticle(i * nv, body);
      cloth.attachParticle(i * nv + nv - 1, body);
    }
    const sail = new SailForce(physics, cloth, { wind, grid: [nu, nv], chord: 'u' }),
      world = new PhysicsWorld({ rate: { num: 60, den: 1 } }).add(new RigidSolver(), { physics });
    if (water) {
      const sailing = new SailingSolver();
      world
        .add(sailing, { yachts: [{ row: body.row, hull, metacentricHeight: 2.5 }] })
        .couple(['sailing', 'rigid'], 'staggered');
      sailing.control(0).heading = 0;
    }
    for (let t = 1; t <= 60 * 40; t++) world.advance(t);
    return { speed: body.linearVelocity[0], sail };
  };
  const sailed = await run(true),
    free = await run(false);
  // Running before an 8 m/s wind, the hull sails at a steady speed below the wind's: the sail's push met by the water's
  // drag, the apparent wind falling as the hull speeds up. Without the water the same sail drives it faster still.
  assert.ok(sailed.speed > 0.5 && sailed.speed < 8, `${sailed.speed}`);
  assert.ok(free.speed > sailed.speed, `${free.speed} against ${sailed.speed} with the water`);
  assert.ok(sailed.sail.force[0] > 0);
});
