// The world's lists of bodies, colliders and joints, and several worlds side by side in one Wasm instance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

test('a world lists its bodies, colliders and joints, and a removed one leaves the lists', () => {
  const physics = new Physics2D(null),
    a = physics.addBody(null, { type: 'fixed', colliders: { shape: 'box', width: 10, height: 10 } }),
    b = physics.addBody(null, {
      position: [20, 0],
      colliders: [
        { shape: 'circle', radius: 3 },
        { shape: 'box', width: 4, height: 4, offset: [8, 0] },
      ],
    }),
    joint = physics.addJoint(a, b, { type: 'revolute' });
  assert.equal(physics.bodyCount, 2);
  assert.deepEqual(physics.getBodies(), [a, b]);
  assert.equal(physics.colliderCount, 3);
  assert.deepEqual(physics.getColliders(), [...a.colliders, ...b.colliders]);
  assert.equal(physics.jointCount, 1);
  assert.deepEqual(physics.getJoints(), [joint]);
  physics.removeBody(b);
  assert.deepEqual(physics.getBodies(), [a]);
  assert.equal(physics.colliderCount, 1);
  assert.deepEqual(physics.getColliders(), [...a.colliders]);
  assert.equal(physics.jointCount, 0, 'the joint went with its body');
  physics.dispose();
});

test('two worlds in one instance step side by side and share nothing', () => {
  const fast = new Physics2D(null, { gravity: [0, 400] }),
    slow = new Physics2D(null, { gravity: [0, 40], name: 'slow' }),
    drop = (physics) => physics.addBody(null, { position: [0, 0], colliders: { shape: 'circle', radius: 1 } }),
    a = drop(fast),
    b = drop(slow);
  // A wall only the slow world has: the fast world's body does not feel it.
  slow.addBody(null, { type: 'fixed', position: [0, 400], colliders: { shape: 'box', width: 1000, height: 20 } });
  for (let i = 0; i < 120; i++) {
    fast.step();
    slow.step();
  }
  assert.ok(a.position[1] > 400, `fell through where the other world has a floor: ${a.position[1]}`);
  assert.ok(
    b.position[1] < 400 && b.position[1] > 0,
    `the slow world's body is on its own floor or falling: ${b.position[1]}`,
  );
  assert.equal(fast.bodyCount, 1);
  assert.equal(slow.bodyCount, 2);
  assert.equal(fast.name, 'physics2d');
  assert.equal(slow.name, 'slow');
  slow.dispose();
  fast.step();
  assert.ok(a.position[1] > 400, 'the other world goes on after one is disposed');
  fast.dispose();
});
