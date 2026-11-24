// A multibody's own API: its links by index and body, the joint between two bodies, and the switch for contacts inside the tree.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';

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
