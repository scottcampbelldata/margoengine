// Contact skin and soft CCD: a skin lifts what rests by it, as on Rapier; soft CCD reaches contacts a body's own motion does
// not.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics as RapierPhysics } from '../dist/index.js';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

test('a body rests a skin above what it lies on, the sum of both skins, as on Rapier', () => {
  const rest = (skins) =>
    [new Physics(null), new RapierPhysics(null)].map((physics) => {
      physics.addBody(null, { type: 'fixed', position: [0, -0.5, 0], colliders: { shape: 'box', halfExtents: [10, 0.5, 10], contactSkin: skins[0] } });
      const ball = physics.addBody(null, { position: [0, 1.5, 0], colliders: { shape: 'sphere', radius: 0.5, contactSkin: skins[1] } });
      for (let i = 0; i < 300; i++) physics.step();
      const y = ball.position[1];
      physics.dispose();
      return y;
    });
  for (const skins of [[0, 0], [0, 0.04], [0.03, 0.02]]) {
    const [own, rapier] = rest(skins);
    assert.ok(Math.abs(own - (0.5 + skins[0] + skins[1])) < 0.005, `own ${own} for ${skins}`);
    assert.ok(Math.abs(own - rapier) < 0.01, `${own} vs Rapier ${rapier} for ${skins}`);
  }
});

test('a skin is read back, changed after the fact and checked', () => {
  const physics = new Physics(null);
  const [piece] = physics.addBody(null, { colliders: { shape: 'sphere', radius: 1, contactSkin: 0.05 } }).colliders;
  assert.ok(Math.abs(piece.contactSkin() - 0.05) < 1e-7);
  piece.setContactSkin(0);
  assert.equal(piece.contactSkin(), 0);
  assert.throws(() => piece.setContactSkin(-1), /contact skin/);
  physics.dispose();
});

test('soft CCD gives a body contacts at a distance its motion does not reach', () => {
  const contacts = (softCcdPrediction) => {
    const physics = new Physics(null, { gravity: [0, 0, 0] });
    physics.addBody(null, { type: 'fixed', position: [1.3, 0, 0], colliders: { shape: 'box', halfExtents: [0.5, 2, 2] } });
    physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5 }, softCcdPrediction });
    physics.step();
    const count = physics.kernel.columns.pairContacts.slice(0, physics.kernel.pairCount ? 8 : 0).reduce((a, b) => a + b, 0);
    physics.dispose();
    return count;
  };
  // The ball's surface is 0.3 from the wall: past the world's own margin, inside a prediction of 0.5.
  assert.equal(contacts(0), 0);
  assert.equal(contacts(0.5), 1);
  const physics = new Physics(null);
  const body = physics.addBody(null);
  assert.equal(body.softCcdPrediction, 0);
  assert.throws(() => (body.softCcdPrediction = -1), /softCcdPrediction/);
  physics.dispose();
});
