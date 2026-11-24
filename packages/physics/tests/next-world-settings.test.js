// World settings beyond the contact solver's first seven: the share of joint impulses carried between steps, one linear speed cap
// for the whole world, and a contact stiffness of its own for contacts with fixed bodies.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

test('a world speed cap holds every dynamic body, and a body cap below it still wins', async () => {
  await Physics.load();
  const physics = new Physics(null);
  physics.setSolver({ maxLinearSpeed: 5 });
  assert.equal(physics.solver.maxLinearSpeed, 5);
  const fast = physics.addBody(null, { position: [0, 1000, 0], colliders: { shape: 'sphere', radius: 0.1 } });
  const capped = physics.addBody(null, {
    position: [10, 1000, 0],
    colliders: { shape: 'sphere', radius: 0.1 },
    maxLinearSpeed: 2,
  });
  for (let i = 0; i < 120; i++) physics.step();
  near(Math.abs(fast.linearVelocity[1]), 5, 1e-3, 'the world cap');
  near(Math.abs(capped.linearVelocity[1]), 2, 1e-3, 'the lower body cap');
  physics.setSolver({ maxLinearSpeed: 0 });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(Math.abs(fast.linearVelocity[1]) > 10, 'no cap with 0');
  assert.throws(() => physics.setSolver({ maxLinearSpeed: -1 }), RangeError);
  physics.dispose();
});

function rest(settings) {
  const physics = new Physics(null);
  physics.setSolver(settings);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [20, 0.5, 20] },
  });
  const lower = physics.addBody(null, {
    position: [0, 0.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1000 },
  });
  const upper = physics.addBody(null, {
    position: [0, 1.5, 0],
    colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5], density: 1000 },
  });
  for (let i = 0; i < 300; i++) physics.step();
  const out = { floor: 0.5 - lower.position[1], between: lower.position[1] + 1 - upper.position[1] };
  physics.dispose();
  return out;
}

test('static contact softness sets the stiffness of contacts with fixed bodies apart from those between moving ones', async () => {
  await Physics.load();
  const soft = rest({ contactHertz: 4, contactDamping: 1 }),
    mixed = rest({ contactHertz: 4, contactDamping: 1, staticContactHertz: 120, staticContactDamping: 10 }),
    stiff = rest({});
  assert.ok(soft.floor > 0.01, `soft contacts sink into the floor: ${soft.floor}`);
  assert.ok(mixed.floor < 0.002, `a stiff floor holds: ${mixed.floor}`);
  near(mixed.floor, stiff.floor, 0.001, 'as the all-stiff world does');
  assert.ok(mixed.between > 0.005, `while the contact between the boxes stays soft: ${mixed.between}`);
  near(mixed.between, soft.between, 0.01, 'near the all-soft world');
  const physics = new Physics(null);
  assert.equal(physics.solver.staticContactHertz, 0, 'off by default: contacts use contactHertz');
  assert.throws(() => physics.setSolver({ staticContactHertz: -1 }), RangeError);
  physics.dispose();
});

function swing(settings) {
  const physics = new Physics(null);
  physics.setSolver(settings);
  const wall = physics.addBody(null, { type: 'fixed' });
  const bar = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  physics.addJoint(wall, bar, { type: 'revolute', axis: [0, 0, 1], limits: [-0.3, 1.2], anchorB: [-1, 0, 0] });
  let lowest = Infinity,
    sum = 0;
  for (let i = 0; i < 240; i++) {
    physics.step();
    lowest = Math.min(lowest, bar.position[1]);
    sum += bar.position[1];
  }
  physics.dispose();
  return { lowest, sum };
}

test('the joint warm start share is read back, and with none a swing that meets its limit still stops there, by a different path', async () => {
  await Physics.load();
  const warm = swing({}),
    cold = swing({ warmStartJoints: 0 });
  for (const run of [warm, cold]) near(run.lowest, -Math.sin(0.3), 0.02, 'stopped by the limit at -0.3 rad');
  assert.notEqual(warm.sum, cold.sum, 'the carried impulses change the path');
  const physics = new Physics(null);
  assert.equal(physics.solver.warmStartJoints, 1);
  physics.setSolver({ warmStartJoints: 0.5 });
  assert.equal(physics.solver.warmStartJoints, 0.5);
  assert.throws(() => physics.setSolver({ warmStartJoints: 2 }), RangeError);
  physics.dispose();
});

test('wakeUpAll wakes every sleeper at once', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const bodies = [0, 1, 2].map((i) =>
    physics.addBody(null, { position: [i * 5, 0.1, 0], colliders: { shape: 'sphere', radius: 0.1 } }),
  );
  bodies.forEach((body) => body.sleep());
  physics.step();
  assert.ok(bodies.every((body) => body.sleeping));
  physics.wakeUpAll();
  assert.ok(bodies.every((body) => !body.sleeping));
  physics.dispose();
});
