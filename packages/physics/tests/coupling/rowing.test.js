// The rowing solver's coupling checks (SEA-09): `RowingSolver` driving a single scull through `bodyForces`, held to the
// harness: the same row at 24, 30 and 60 frames a second, a seek equal to a continuous run, and the boat's speed feeding
// back into the blades' forces.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../../dist/index.js';
import { RowingSolver } from '../../dist/ship.js';
import { PhysicsWorld, RigidSolver } from '../../dist/world.js';
import { frameRateIndependent, seekEqualsContinuous } from './harness.js';

await Physics.load();
const DEG = Math.PI / 180;

const make = (rate = { num: 24, den: 1 }, speed = 4) => {
  const physics = new Physics(null, { fixedTimestep: 1 / 240, gravity: [0, 0, 0] }),
    body = physics.addBody(null, {
      linearVelocity: [speed, 0, 0],
      enabledRotations: [false, true, false],
      colliders: { shape: 'box', halfExtents: [4, 0.2, 0.2], mass: 103 },
    }),
    rowing = new RowingSolver(),
    world = new PhysicsWorld({ rate })
      .add(new RigidSolver(), { physics })
      .add(rowing, {
        boats: [
          {
            row: body.row,
            oars: [
              { pin: [0, 0.2, 0.8], side: 1, outboard: 1.8, area: 0.08 },
              { pin: [0, 0.2, -0.8], side: -1, outboard: 1.8, area: 0.08 },
            ],
            crew: 85,
            drag: 3.2,
          },
        ],
        level: 2,
      })
      .couple(['rowing', 'rigid'], 'staggered');
  Object.assign(rowing.control(0), { rate: 32, drive: 0.9, catchAngle: -60 * DEG, finishAngle: 40 * DEG });
  return Object.assign(world, { rowing, body });
};

test('RowingSolver: the same row at 24, 30 and 60 frames a second', () => frameRateIndependent(make));
test('RowingSolver: a seek equals a continuous run', () => seekEqualsContinuous(() => make()));
test('RowingSolver: the blades drive the boat, and the boat moving faster through the water takes less from them', () => {
  const slow = make({ num: 60, den: 1 }, 2),
    fast = make({ num: 60, den: 1 }, 6);
  let pushSlow = 0,
    pushFast = 0;
  for (let f = 1; f <= 30; f++) {
    slow.advance(f);
    fast.advance(f);
    pushSlow += slow.rowing.status(0).propulsion;
    pushFast += fast.rowing.status(0).propulsion;
  }
  // In the first half second of the drive the slow boat is pushed on and the fast one less so.
  assert.ok(pushSlow > 0 && pushSlow > pushFast, `${pushSlow} ${pushFast}`);
  assert.ok(slow.body.linearVelocity[0] > 2);
});
