// A multibody's implicit motors and pinned joints (src/multibody.ts setImplicitMotors, pinJoint; kernel/src/multibody.rs):
// a stiff chain of motor springs stays stable held in the tree's solve where the joint passes let it run away, and the
// methods refuse what they cannot hold.
// (The bending against its closed form is kernel/tests/multibody_chain.rs; the rod built on both is tests/rod.test.js.)
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

await Physics.load();

/** A 1 m chain of `n` capsules along +X from a fixed wall, each joint a rotation motor of bending stiffness 7.7 N m^2. */
function cantilever(implicit, n = 32) {
  const physics = new Physics(null, { gravity: [0, -9.81, 0] });
  const s = Math.SQRT1_2,
    along = [0, 0, -s, s],
    l = 1 / n,
    wall = physics.addBody(null, { type: 'fixed', colliders: [] });
  const links = Array.from({ length: n }, (_, i) =>
    physics.addBody(null, {
      position: [(i + 0.5) * l, 0, 0],
      rotation: along,
      canSleep: false,
      colliders: { shape: 'capsule', halfHeight: l / 2, radius: 0.01, density: 1000 },
    }),
  );
  const tree = physics.addMultibody(
    wall,
    links.map((body, i) => ({
      body,
      joint: { type: 'spherical', anchorA: i === 0 ? [0, 0, 0] : [0, l / 2, 0], anchorB: [0, -l / 2, 0] },
    })),
  );
  tree.selfContacts = false;
  tree.links.forEach((link, i) =>
    link.joint.setRotationMotor(i === 0 ? along : [0, 0, 0, 1], {
      stiffness: ((i === 0 ? 2 : 1) * 7.7) / l,
      damping: (0.02 * 7.7) / l,
      model: 'force',
    }),
  );
  if (implicit) tree.setImplicitMotors(links);
  return { physics, tree, links, wall };
}

test('a stiff chain of motor springs held in the tree settles where its springs balance', () => {
  // 32 links at 7.7 N m^2: in the joint passes, a joint at a time, this chain runs away; held in the tree it settles.
  const held = cantilever(true);
  for (let i = 0; i < 600; i++) held.physics.step(1 / 60);
  const last = held.links.at(-1);
  assert.ok(Math.abs(last.linearVelocity[1]) < 1e-3, `the tip still moves at ${last.linearVelocity[1]} m/s`);
  assert.ok(last.position[1] < 0 && last.position[1] > -0.2, `the tip stands at ${last.position[1]} m`);
  assert.equal(held.tree.implicitMotors(last), true);
  held.physics.dispose();
});

test('setImplicitMotors and pinJoint refuse what they cannot hold', () => {
  const { physics, tree, links, wall } = cantilever(true, 4);
  assert.throws(
    () => tree.setImplicitMotors(wall),
    (error) => error.code === 'state' && /link of this multibody/.test(error.message),
  );
  // A joint inside the tree is not a pin to a body outside it.
  assert.throws(
    () => tree.pinJoint(tree.links[1].joint),
    (error) => error.code === 'state' && /outside it/.test(error.message),
  );
  const post = physics.addBody(null, { type: 'fixed', position: [1, 0, 0], colliders: [] });
  const slider = physics.addJoint(post, links[3], { type: 'prismatic', axis: [1, 0, 0] });
  assert.throws(
    () => tree.pinJoint(slider),
    (error) => error.code === 'state' && /sliding axes/.test(error.message),
  );
  const pin = physics.addJoint(post, links[3], { type: 'spherical', anchorB: [0, 1 / 8, 0] });
  assert.throws(() => tree.pinJoint(pin, true, { stiffness: -1 }), { code: 'unsupported' });
  tree.pinJoint(pin, true, { stiffness: 1e5, damping: 10 });
  for (let i = 0; i < 60; i++) physics.step(1 / 60);
  physics.dispose();
});
