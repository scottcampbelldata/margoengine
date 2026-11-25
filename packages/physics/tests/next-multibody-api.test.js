// A multibody's own API: its links by index and body, the joint between two bodies, and the switch for contacts inside the tree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics, coupleDofs } from '../dist/index.js';

function tree(physics) {
  const root = physics.addBody(null, { type: 'fixed', colliders: { shape: 'sphere', radius: 0.5 } });
  const first = physics.addBody(null, { position: [0, -1, 0], colliders: { shape: 'sphere', radius: 0.05, mass: 1 } });
  const second = physics.addBody(null, { position: [0, -2, 0], colliders: { shape: 'sphere', radius: 0.05, mass: 1 } });
  const outsider = physics.addBody(null, {
    position: [3, 0, 0],
    colliders: { shape: 'sphere', radius: 0.05, mass: 1 },
  });
  const multibody = physics.addMultibody(root, [
    { body: first, joint: { type: 'spherical', anchorB: [0, 1, 0] } },
    { body: second, parent: first, joint: { type: 'spherical', anchorB: [0, 1, 0] } },
  ]);
  return { root, first, second, outsider, multibody };
}

test('a multibody reads its root, links, count and the joint between two bodies', async () => {
  await Physics.load();
  const physics = new Physics(null);
  const { root, first, second, outsider, multibody } = tree(physics);
  assert.equal(multibody.root, root);
  assert.equal(multibody.links.length, 2);
  assert.equal(multibody.numLinks, 3);
  assert.deepEqual(multibody.attachedBodies(), [root, first, second]);
  assert.equal(multibody.linkIndex(root), 0);
  assert.equal(multibody.linkIndex(first), 1);
  assert.equal(multibody.linkIndex(second), 2);
  assert.equal(multibody.linkIndex(outsider), -1);
  assert.equal(multibody.bodyAt(2), second);
  assert.equal(multibody.bodyAt(3), undefined);
  assert.equal(multibody.links[0].body, first);
  assert.equal(multibody.links[0].parent, root);
  assert.equal(multibody.links[0].joint.type, 'spherical');
  assert.equal(multibody.jointBetween(root, first), multibody.links[0].joint);
  assert.equal(multibody.jointBetween(second, first), multibody.links[1].joint);
  assert.equal(multibody.jointBetween(root, second), undefined);
  assert.equal(multibody.dof, 6);
  assert.equal(multibody.valid, true);
  multibody.remove();
  assert.equal(multibody.valid, false);
  physics.dispose();
});

test('self contacts off: two bodies of one tree that overlap pass through each other, and on they push apart', async () => {
  await Physics.load();
  // A fixed root sphere and a link 0.5 from its centre, joined through a middle link: not neighbours, so the joints leave their
  // contact alone. Both joints turn about one point 0.4 below the root's centre, off the line of the contact.
  function overlapping(selfContacts) {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    const root = physics.addBody(null, { type: 'fixed', colliders: { shape: 'sphere', radius: 0.5 } });
    const middle = physics.addBody(null, {
      position: [0, -1.4, 0],
      colliders: { shape: 'sphere', radius: 0.05, mass: 1 },
    });
    const far = physics.addBody(null, {
      position: [-0.3, -0.4, 0],
      colliders: { shape: 'sphere', radius: 0.5, mass: 1 },
    });
    const multibody = physics.addMultibody(root, [
      { body: middle, joint: { type: 'spherical', anchorA: [0, -0.4, 0], anchorB: [0, 1, 0] } },
      { body: far, parent: middle, joint: { type: 'spherical', anchorA: [0, 1, 0], anchorB: [0.3, 0, 0] } },
    ]);
    assert.equal(multibody.selfContacts, true);
    multibody.selfContacts = selfContacts;
    assert.equal(multibody.selfContacts, selfContacts);
    for (let i = 0; i < 60; i++) physics.step();
    const x = far.position[0];
    physics.dispose();
    return x;
  }
  assert.ok(Math.abs(overlapping(false) + 0.3) < 1e-3, 'off: nothing pushes it');
  assert.ok(Math.abs(overlapping(true) + 0.3) > 0.05, 'on: the root pushes it away');
});

test('a loop closed by an ordinary joint between a tree link and a fixed body holds its closure while the four-bar moves', async () => {
  await Physics.load();
  const physics = new Physics(null);
  // Ground joints at (0, 0) and (1, -1.6); three unit links: ends at A, B and C = the second ground joint.
  const A = [0.6, -0.8, 0],
    B = [1.6, -0.8, 0],
    C = [1, -1.6, 0];
  const root = physics.addBody(null, { type: 'fixed' });
  const post = physics.addBody(null, { type: 'fixed', position: C });
  const body = (at) => physics.addBody(null, { position: at, colliders: { shape: 'sphere', radius: 0.05, mass: 1 } });
  const [a, b, c] = [body(A), body(B), body(C)];
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], 0];
  const hinge = (parent, child) => ({
    type: 'revolute',
    axis: [0, 0, 1],
    anchorA: [0, 0, 0],
    anchorB: sub(parent, child),
  });
  const multibody = physics.addMultibody(root, [
    { body: a, joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [0, 0, 0], anchorB: sub([0, 0, 0], A) } },
    { body: b, parent: a, joint: hinge(A, B) },
    { body: c, parent: b, joint: hinge(B, C) },
  ]);
  assert.equal(multibody.links.length, 3);
  // The chain is held at its joints by the tree; the loop is closed at c's origin by an ordinary joint to the post.
  physics.addJoint(post, c, { type: 'revolute', axis: [0, 0, 1] });
  a.setAngularVelocity([0, 0, 0.3]);
  let worst = 0;
  for (let i = 0; i < 180; i++) {
    physics.step();
    const [x, y] = c.position;
    worst = Math.max(worst, Math.hypot(x - C[0], y - C[1]));
  }
  assert.ok(worst < 2e-3, `the loop stays closed to 2 mm: ${worst}`);
  assert.ok(Number.isFinite(a.position[0]) && Math.abs(a.position[0]) < 3, 'and nothing blows up');
  physics.dispose();
});

test('two hinge coordinates of a tree are coupled: q_a + ratio q_b holds, and the tree keeps its joints', async () => {
  await Physics.load();
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const root = physics.addBody(null, { type: 'fixed' });
  const link = (x) =>
    physics.addBody(null, { position: [x, 0, 0], colliders: { shape: 'box', halfExtents: [0.4, 0.1, 0.1], mass: 1 } });
  const [a, b] = [link(0), link(3)];
  const multibody = physics.addMultibody(root, [
    { body: a, joint: { type: 'revolute', axis: [0, 0, 1] } },
    { body: b, parent: root, joint: { type: 'revolute', axis: [0, 0, 1], anchorA: [3, 0, 0] } },
  ]);
  coupleDofs(physics, multibody, a, b, { ratio: 2 });
  a.setAngularVelocity([0, 0, 1]);
  for (let i = 0; i < 90; i++) physics.step();
  const [qa, qb] = multibody.coordinates();
  assert.ok(Math.abs(qa + 2 * qb) < 1e-3, `q_a + 2 q_b stays 0: ${qa} ${qb}`);
  assert.ok(Math.abs(qa) > 0.5, `and the pair really turned: ${qa}`);
  assert.ok(Math.abs(a.position[0]) < 1e-3 && Math.abs(b.position[0] - 3) < 1e-3, 'each link stays on its hinge');
  // A link that does not hang from the root has no DOF of its own to couple.
  const chain = new Physics(null, { gravity: [0, 0, 0] });
  const base = chain.addBody(null, { type: 'fixed' });
  const first = chain.addBody(null, { position: [1, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  const second = chain.addBody(null, { position: [2, 0, 0], colliders: { shape: 'sphere', radius: 0.1, mass: 1 } });
  const tall = chain.addMultibody(base, [
    { body: first, joint: { type: 'revolute', axis: [0, 0, 1], anchorB: [-1, 0, 0] } },
    { body: second, joint: { type: 'revolute', axis: [0, 0, 1], anchorB: [-1, 0, 0] } },
  ]);
  assert.throws(() => coupleDofs(chain, tall, first, second), TypeError);
  chain.dispose();
  assert.throws(() => coupleDofs(physics, multibody, a, root), TypeError);
  physics.dispose();
});
