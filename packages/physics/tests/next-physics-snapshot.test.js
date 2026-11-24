// takeSnapshot and restoreSnapshot of a Physics (Rapier's takeSnapshot / restoreSnapshot): going back and on again gives the
// same bits, handles and userData stay, and a world with other bodies than the snapshot's is refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

function scene() {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const balls = [0, 1, 2].map((k) =>
    physics.addBody(null, {
      position: [k * 0.4, 2 + k, 0],
      userData: `ball${k}`,
      colliders: { shape: 'sphere', radius: 0.3 },
    }),
  );
  return { physics, balls };
}

test('stepping on from a restored snapshot gives the same bits, and the handles and userData stay', () => {
  const { physics, balls } = scene();
  for (let i = 0; i < 30; i++) physics.step();
  const snapshot = physics.takeSnapshot();
  const hash = physics.kernel.hash;
  for (let i = 0; i < 90; i++) physics.step();
  const first = balls.map((ball) => Array.from(ball.position));
  assert.notEqual(physics.kernel.hash, hash);
  physics.restoreSnapshot(snapshot);
  assert.equal(physics.kernel.hash, hash, 'back to the very bytes');
  balls[0].setPosition([5, 5, 5]);
  physics.restoreSnapshot(snapshot);
  for (let i = 0; i < 90; i++) physics.step();
  assert.deepEqual(
    balls.map((ball) => Array.from(ball.position)),
    first,
    'the same run again',
  );
  assert.deepEqual(
    balls.map((ball) => ball.userData),
    ['ball0', 'ball1', 'ball2'],
  );
  physics.dispose();
});

test('a world with another body or collider than the snapshot is refused and left as it is', () => {
  const { physics, balls } = scene();
  physics.step();
  const snapshot = physics.takeSnapshot();
  const extra = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.1 } });
  const hash = physics.kernel.hash;
  assert.throws(() => physics.restoreSnapshot(snapshot), /other bodies, colliders or joints/);
  assert.equal(physics.kernel.hash, hash, 'nothing changed');
  physics.removeBody(extra);
  physics.removeBody(balls[2]);
  assert.throws(() => physics.restoreSnapshot(snapshot), /other bodies, colliders or joints/);
  assert.throws(
    () => physics.restoreSnapshot({ ...snapshot, bytes: new Uint8Array(16) }),
    /other bodies|not a snapshot/,
  );
  physics.dispose();
});
