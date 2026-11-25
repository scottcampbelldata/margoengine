// A coupling of two joint coordinates of a multibody, at any depth and for sliders: the row is on the two links and their parents, so
// it holds the joints' own coordinates (a relative angle, an offset) and not the bodies' angles in the world.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, coupleDofs } from '../dist/index.js';

const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

test('two sliders are coupled: s_a + s_b stays 0, and equal masses share the speed', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const root = physics.addBody(null, { type: 'fixed' });
  const slider = (y) =>
    physics.addBody(null, { position: [0, y, 0], colliders: { shape: 'box', halfExtents: [0.2, 0.2, 0.2], mass: 1 } });
  const [a, b] = [slider(1), slider(-1)];
  const multibody = physics.addMultibody(root, [
    { body: a, joint: { type: 'prismatic', axis: [1, 0, 0], anchorB: [0, -1, 0] } },
    { body: b, parent: root, joint: { type: 'prismatic', axis: [1, 0, 0], anchorB: [0, 1, 0] } },
  ]);
  coupleDofs(physics, multibody, a, b);
  a.setLinearVelocity([1, 0, 0]);
  for (let i = 0; i < 60; i++) physics.step();
  const [sa, sb] = multibody.coordinates();
  near(sa + sb, 0, 2e-3, 's_a + s_b');
  // The coupling takes a unit impulse from one and gives it to the other: v_a' = 1 - p, v_b' = p, and v_a' + v_b' = 0 gives 0.5.
  near(sa, 0.5, 0.03, 'the first slider after a second at half the speed');
  near(a.linearVelocity[0], 0.5, 0.01, 'its speed');
  near(b.linearVelocity[0], -0.5, 0.01, "and the other's, the other way");
  physics.dispose();
});

test("a coupling between two links three levels deep holds the joints' relative angles while the whole arm turns", async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const root = physics.addBody(null, { type: 'fixed' });
  const link = (x) =>
    physics.addBody(null, { position: [x, 0, 0], colliders: { shape: 'box', halfExtents: [0.4, 0.1, 0.1], mass: 1 } });
  const [l1, l2, l3] = [link(1), link(2), link(3)];
  const hinge = (parent, child) => ({
    type: 'revolute',
    axis: [0, 0, 1],
    anchorA: [0, 0, 0],
    anchorB: [parent - child, 0, 0],
  });
  const multibody = physics.addMultibody(root, [
    { body: l1, joint: hinge(0, 1) },
    { body: l2, parent: l1, joint: hinge(1, 2) },
    { body: l3, parent: l2, joint: hinge(2, 3) },
  ]);
  coupleDofs(physics, multibody, l2, l3, { ratio: 2 });
  // The first link turns the whole arm; the second also turns against the first.
  l1.applyTorqueImpulse([0, 0, 6]);
  l2.applyTorqueImpulse([0, 0, 0.5]);
  let worst = 0,
    moved = 0;
  for (let i = 0; i < 90; i++) {
    physics.step();
    const [q1, q2, q3] = multibody.coordinates();
    worst = Math.max(worst, Math.abs(q2 + 2 * q3));
    moved = Math.max(moved, Math.abs(q1));
  }
  assert.ok(worst < 3e-3, `q2 + 2 q3 holds while the arm turns: ${worst}`);
  assert.ok(moved > 0.3, `and the arm did turn as a whole: ${moved}`);
  physics.dispose();
});

test('a hinge and a slider are coupled through their ratio, and a snapshot carries the row', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const root = physics.addBody(null, { type: 'fixed' });
  const wheel = physics.addBody(null, { position: [0, 0, 0], colliders: { shape: 'sphere', radius: 0.5, mass: 1 } });
  const rack = physics.addBody(null, {
    position: [0, 2, 0],
    colliders: { shape: 'box', halfExtents: [1, 0.1, 0.1], mass: 1 },
  });
  const multibody = physics.addMultibody(root, [
    { body: wheel, joint: { type: 'revolute', axis: [0, 0, 1] } },
    { body: rack, parent: root, joint: { type: 'prismatic', axis: [1, 0, 0], anchorB: [0, -2, 0] } },
  ]);
  // The slide plus 0.5 m for each radian stays what it was: the hinge's angle runs the rack.
  coupleDofs(physics, multibody, rack, wheel, { ratio: 0.5 });
  wheel.setAngularVelocity([0, 0, 2]);
  for (let i = 0; i < 60; i++) physics.step();
  const [angle, slide] = multibody.coordinates();
  near(slide + 0.5 * angle, 0, 3e-3, 'slide + 0.5 angle');
  assert.ok(Math.abs(angle) > 0.2, `the wheel turned: ${angle}`);
  const bytes = physics.kernel.snapshot();
  const before = multibody.coordinates();
  for (let i = 0; i < 30; i++) physics.step();
  physics.kernel.restore(bytes);
  near(multibody.coordinates()[0], before[0], 1e-6, 'restored');
  physics.dispose();
});

test('a coupling refuses a body that is not a hinge or slider link, and a ratio of 0', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const root = physics.addBody(null, { type: 'fixed' });
  const a = physics.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  const b = physics.addBody(null, { position: [2, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  const multibody = physics.addMultibody(root, [
    { body: a, joint: { type: 'revolute', axis: [0, 0, 1], anchorB: [-1, 0, 0] } },
    { body: b, parent: root, joint: { type: 'spherical', anchorB: [-2, 0, 0] } },
  ]);
  assert.throws(() => coupleDofs(physics, multibody, a, root), TypeError);
  assert.throws(() => coupleDofs(physics, multibody, a, b), TypeError);
  assert.throws(() => coupleDofs(physics, multibody, a, a, { ratio: 0 }), RangeError);
  physics.dispose();
});
