// A generic joint's coupled axes (Rapier's `coupled_axes`): the listed axes share one limit on their combined measure, the
// distance in their plane for sliding axes and the swing angle for the two turning axes across the joint's X.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

function world(joint, setup) {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const wall = physics.addBody(null, { type: 'fixed' });
  const body = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.2, mass: 1 } });
  physics.addJoint(wall, body, joint);
  setup(body);
  return { physics, body };
}

test('coupled sliding axes limit their combined distance: a rod in a round hole slides along its length and stays inside the radius', async () => {
  await Physics.load();
  const joint = {
    type: 'generic',
    locked: ['angX', 'angY', 'angZ'],
    coupled: ['linY', 'linZ'],
    limits: { linY: [0, 0.5] },
  };
  const { physics, body } = world(joint, (b) => b.setLinearVelocity([2, 3, 4]));
  for (let i = 0; i < 60; i++) physics.step();
  // X is free: a second at 2 m/s. Y and Z were pushed along (3, 4) and stop where their distance is 0.5: (0.3, 0.4).
  near(body.position[0], 2, 0.05, 'free along X');
  near(body.position[1], 0.3, 0.01, 'Y at the edge of the circle');
  near(body.position[2], 0.4, 0.01, 'Z at the edge of the circle');
  physics.dispose();
  // Inside the circle nothing holds it.
  const inside = world(joint, (b) => b.setLinearVelocity([0, 0.1, 0.1]));
  for (let i = 0; i < 60; i++) inside.physics.step();
  near(inside.body.position[1], 0.1, 0.005, 'free inside, Y');
  near(inside.body.position[2], 0.1, 0.005, 'free inside, Z');
  inside.physics.dispose();
  // Each axis alone is not coupled: with Y and Z limited apart the body leaves by the corner of a square.
  const square = world(
    { type: 'generic', locked: ['angX', 'angY', 'angZ'], limits: { linY: [-0.5, 0.5], linZ: [-0.5, 0.5] } },
    (b) => b.setLinearVelocity([0, 3, 4]),
  );
  for (let i = 0; i < 60; i++) square.physics.step();
  near(square.body.position[1], 0.5, 0.01, 'a square limit holds Y at 0.5');
  near(square.body.position[2], 0.5, 0.01, 'and Z at 0.5, 0.7 from the middle');
  square.physics.dispose();
});

test('a coupled limit with a minimum keeps the body out of the middle: an annulus', async () => {
  await Physics.load();
  const { physics, body } = world(
    {
      type: 'generic',
      locked: ['linX', 'angX', 'angY', 'angZ'],
      coupled: ['linY', 'linZ'],
      limits: { linY: [0.3, 0.5] },
    },
    (b) => {
      b.setPosition([0, 0.4, 0]);
      b.setLinearVelocity([0, -3, 0]);
    },
  );
  for (let i = 0; i < 60; i++) physics.step();
  near(Math.hypot(body.position[1], body.position[2]), 0.3, 0.01, 'stopped at the inner edge');
  physics.dispose();
});

test('coupled turning axes limit the swing across X as one angle, as a cone does', async () => {
  await Physics.load();
  const { physics, body } = world(
    {
      type: 'generic',
      locked: ['linX', 'linY', 'linZ', 'angX'],
      coupled: ['angY', 'angZ'],
      limits: { angY: [0, 0.5] },
    },
    (b) => b.setAngularVelocity([0, 3, 4]),
  );
  for (let i = 0; i < 90; i++) physics.step();
  // A swing of 0.5 rad along (0, 3, 4) / 5: the quaternion's vector part is sin(0.25) along that direction.
  const q = body.rotation,
    s = Math.sin(0.25);
  near(q[0], 0, 0.01, 'no twist');
  near(q[1], 0.6 * s, 0.01, 'Y part of the swing');
  near(q[2], 0.8 * s, 0.01, 'Z part of the swing');
  physics.dispose();
});

test('coupled axes refuse what they cannot be, and say what to pass', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const a = physics.addBody(null, { type: 'fixed' });
  const b = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.2 } });
  const add = (options) => physics.addJoint(a, b, { type: 'generic', ...options });
  assert.throws(() => add({ coupled: ['linY'], limits: { linY: [0, 1] } }), /two or three/);
  assert.throws(() => add({ coupled: ['linY', 'angY'], limits: { linY: [0, 1] } }), /one kind/);
  assert.throws(() => add({ coupled: ['angX', 'angY'], limits: { angX: [0, 1] } }), /angY and angZ/);
  assert.throws(() => add({ coupled: ['linY', 'linZ'], locked: ['linY'] }), /locked/);
  assert.throws(() => add({ coupled: ['linY', 'linZ'], limits: { linZ: [0, 1] } }), /linY/);
  assert.throws(() => add({ coupled: ['linY', 'linZ'], limits: { linY: [-1, 1] } }), /0 or more/);
  assert.throws(() => add({ coupled: ['angY', 'angZ'], limits: { angY: [0.1, 1] } }), /min of 0/);
  physics.dispose();
});
