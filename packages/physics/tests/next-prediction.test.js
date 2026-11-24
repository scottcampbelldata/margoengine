// The prediction distance: contacts are made inside it and not beyond, and it can be set per world.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

/** The contact points of a ball `gap` metres above a floor, after one step with no gravity. */
const points = (gap, prediction) => {
  const physics = new Physics(null, {
    gravity: [0, 0, 0],
    ...(prediction === undefined ? {} : { predictionDistance: prediction }),
  });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  physics.addBody(null, { position: [0, 0.5 + gap, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  physics.step();
  const { pairContacts } = physics.kernel.columns;
  let count = 0;
  for (let row = 0; row < pairContacts.length && row < 4; row++) count += pairContacts[row];
  physics.dispose();
  return count;
};

test('contacts are made inside the prediction distance and not beyond it', () => {
  assert.equal(points(0.03), 1, 'the default is 0.04 m');
  assert.equal(points(0.2), 0);
  assert.equal(points(0.08, 0.1), 1, 'a larger distance reaches further');
  assert.equal(points(0.12, 0.1), 0);
  assert.equal(points(0.03, 0.01), 0, 'a smaller one reaches less');
  assert.equal(points(0.005, 0.01), 1);
  assert.equal(points(0.0005, 0), 0, 'with 0, only what overlaps');
});

test('the distance can be set after bodies exist, and is checked', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  assert.ok(Math.abs(physics.predictionDistance - 0.04) < 1e-7);
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  physics.addBody(null, { position: [0, 0.58, 0], colliders: { shape: 'sphere', radius: 0.5 } });
  physics.step();
  // A pair whose boxes no longer meet is dropped, and its row is left as it was: count only the pairs there are.
  const rows = () =>
    physics.kernel.pairCount ? [...physics.kernel.columns.pairContacts.slice(0, 4)].reduce((a, b) => a + b, 0) : 0;
  assert.equal(rows(), 0, 'an 8 cm gap is out of the default reach');
  physics.predictionDistance = 0.1;
  physics.step();
  assert.equal(rows(), 1, 'and inside 10 cm');
  physics.predictionDistance = 0.02;
  physics.step();
  assert.equal(rows(), 0);
  assert.throws(() => (physics.predictionDistance = -1), /prediction distance/);
  assert.throws(() => (physics.predictionDistance = Number.NaN), /prediction distance/);
  physics.dispose();
});
