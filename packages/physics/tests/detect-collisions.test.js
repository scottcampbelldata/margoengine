// Collision detection without dynamics: the world as it stands is searched for contacts, events fire, and nothing moves.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

const pair = (physics, gap) => {
  const a = physics.addBody(null, { position: [0, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] } }),
    b = physics.addBody(null, {
      position: [1 + gap, 0, 0],
      linearVelocity: [0.25, 0, 0],
      colliders: { shape: 'box', halfExtents: [0.5, 0.5, 0.5] },
    });
  return [a, b];
};

test('detectCollisions finds contacts and fires their events with no step of dynamics', () => {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] }),
    [a, b] = pair(physics, -0.05),
    seen = [];
  physics.on('contactstart', (event) => seen.push(['start', event.bodyA, event.bodyB]));
  physics.on('contactend', (event) => seen.push(['end', event.bodyA, event.bodyB]));
  const before = [a.position, b.position, b.linearVelocity].map((v) => [...v]);
  const steps = physics.stepCount;
  assert.equal(physics.touching(a, b), false, 'nothing has been looked at yet');
  physics.detectCollisions();
  assert.equal(physics.touching(a, b), true, 'the boxes overlap by 5 cm: they touch');
  assert.equal(seen.length, 1, 'one contactstart');
  assert.equal(seen[0][0], 'start');
  assert.ok(physics.contactPair(a.colliders[0], b.colliders[0]), 'the pair has its points');
  assert.deepEqual(
    [a.position, b.position, b.linearVelocity].map((v) => [...v]),
    before,
    'no pose or speed changed, gravity did not act',
  );
  assert.equal(physics.stepCount, steps, 'no step was taken');
  physics.detectCollisions();
  assert.equal(seen.length, 1, 'a second look at the same world has nothing new to tell');
  // Moved apart by hand, the next look ends the contact.
  b.setPosition([5, 0, 0]);
  physics.detectCollisions();
  assert.equal(physics.touching(a, b), false);
  assert.deepEqual(
    seen.map((s) => s[0]),
    ['start', 'end'],
  );
  physics.dispose();
});

test('detectCollisions does not put a sleeper to sleep or wake it, and leaves impulses for the next step', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] }),
    [a, b] = pair(physics, 5);
  a.sleep();
  physics.step();
  assert.equal(a.sleeping, true);
  b.applyImpulse([10, 0, 0]);
  physics.detectCollisions();
  assert.equal(a.sleeping, true, 'the sleeper still sleeps');
  assert.equal(b.linearVelocity[0], 0.25, 'the impulse has not landed yet');
  physics.step();
  assert.ok(b.linearVelocity[0] > 5, 'it lands in the step');
  physics.dispose();
});

test('a world with nothing to detect and a disposed one behave', () => {
  const physics = new Physics(null);
  physics.detectCollisions();
  physics.dispose();
  assert.throws(() => physics.detectCollisions(), { code: 'disposed' });
});
