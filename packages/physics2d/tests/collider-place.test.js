// A collider moved and turned on its body after it is made (C2-08, Rapier's `setTranslationWrtParent` and
// `setRotationWrtParent`): rays meet it where it went, the body's centre of mass follows, the reads give the new place,
// and a bad place or a removed collider is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

test('a collider moved and turned on its body is met where it went, and the reads follow', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const body = physics.addBody(null, {
      type: 'fixed',
      position: [0, 0],
      colliders: { shape: 'box', width: 2, height: 0.2 },
    }),
    [c] = body.colliders;
  const down = (x) => physics.raycast([x, -5], [0, 1], { maxDistance: 20 });
  assert.ok(Math.abs(down(0).distance - 4.9) < 1e-4);
  c.setTranslationWrtParent([3, 0]);
  assert.equal(down(0), null, 'the old place is empty');
  assert.ok(Math.abs(down(3).distance - 4.9) < 1e-4);
  assert.deepEqual(c.translationWrtParent(), [3, 0]);
  // Back, and turned a quarter: the bar stands 2 tall, its top 1 above the body (y grows downward).
  c.setTranslationWrtParent([0, 0]);
  c.setRotationWrtParent(Math.PI / 2);
  assert.ok(Math.abs(down(0).distance - 4) < 1e-4, `${down(0)?.distance}`);
  assert.equal(down(0.5), null, 'and 0.2 wide');
  assert.ok(Math.abs(c.rotationWrtParent() - Math.PI / 2) < 1e-12);
  assert.ok(Math.abs(c.rotation() - Math.PI / 2) < 1e-12);
  physics.dispose();
});

test("a dynamic body's centre of mass follows its moved collider, and bad places are refused", () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 100, gravity: [0, 0] });
  const body = physics.addBody(null, { position: [500, 500], colliders: { shape: 'circle', radius: 50 } }),
    [c] = body.colliders;
  c.setTranslationWrtParent([30, -40]);
  // Spun about its centre of mass, the body's origin turns about the moved circle's centre (530, 460): a quarter turn takes
  // the origin's offset from it, (-30, 40), to (-40, -30), so the origin goes to (490, 430).
  body.angularVelocity = Math.PI / 2;
  physics.step();
  for (let i = 1; i < 60; i++) physics.step();
  const [x, y] = body.position;
  assert.ok(Math.abs(x - 490) < 0.01 && Math.abs(y - 430) < 0.01, `origin at ${x}, ${y}`);
  assert.throws(() => c.setTranslationWrtParent([Number.NaN, 0]), RangeError);
  assert.throws(() => c.setRotationWrtParent(Infinity), RangeError);
  physics.removeCollider(c);
  assert.throws(() => c.setRotationWrtParent(1), /was removed/);
  physics.dispose();
});
