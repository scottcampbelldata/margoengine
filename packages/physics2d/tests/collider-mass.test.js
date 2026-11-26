// A collider's mass set after it is made (C2-10, Rapier's `setMass` and `setMassProperties`): a set mass holds whatever the
// outline and is shared by area across a collider's shapes; given properties set the body's mass and centre of mass and
// move with the collider; `setDensity` goes back; bad values and a removed collider are refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

test('setMass gives the collider its own mass, which holds through setShape, and setDensity takes it back', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const body = physics.addBody(null, { colliders: { shape: 'box', width: 1, height: 1, density: 2 } }),
    [c] = body.colliders;
  assert.ok(Math.abs(c.mass() - 2) < 1e-5 && Math.abs(body.mass - 2) < 1e-5);
  c.setMass(5);
  assert.ok(Math.abs(c.mass() - 5) < 1e-5 && Math.abs(body.mass - 5) < 1e-5, `${body.mass}`);
  c.setShape({ shape: 'circle', radius: 1 });
  assert.ok(Math.abs(body.mass - 5) < 1e-5, 'the set mass holds through a new outline');
  c.setDensity(2);
  assert.ok(Math.abs(body.mass - 2 * Math.PI) < 1e-4, `back to the density: ${body.mass}`);
  // A mass given when it is made holds through a new outline too.
  const other = physics.addBody(null, { colliders: { shape: 'circle', radius: 0.5, mass: 3 } });
  other.colliders[0].setShape({ shape: 'box', width: 3, height: 3 });
  assert.ok(Math.abs(other.mass - 3) < 1e-5, `${other.mass}`);
  physics.dispose();
});

test('a collider of several shapes shares a set mass by area', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  // An L of a 2 x 1 and a 1 x 1 part, as two kernel shapes.
  const body = physics.addBody(null, {
      colliders: {
        shape: 'compound',
        shapes: [
          { shape: 'box', width: 2, height: 1, offset: [0, 0] },
          { shape: 'box', width: 1, height: 1, offset: [0.5, 1] },
        ],
      },
    }),
    [c] = body.colliders;
  c.setMass(6);
  assert.ok(Math.abs(body.mass - 6) < 1e-4, `${body.mass}`);
  // 4 kg on the 2 m^2 part at (0, 0) and 2 kg on the 1 m^2 part at (0.5, 1): the centre at (1/6, 1/3).
  const [x, y] = body.centerOfMass;
  assert.ok(Math.abs(x - 1 / 6) < 1e-4 && Math.abs(y - 1 / 3) < 1e-4, `${x}, ${y}`);
  physics.dispose();
});

test('setMassProperties sets the mass and centre, which move with the collider, and bad values are refused', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 100, gravity: [0, 0] });
  const body = physics.addBody(null, { colliders: { shape: 'circle', radius: 50, offset: [100, 0] } }),
    [c] = body.colliders;
  // 4 kg at (20, 0) in the collider's frame: (120, 0) on the body.
  c.setMassProperties(4, [20, 0], 1000);
  assert.ok(Math.abs(body.mass - 4) < 1e-5);
  let [x, y] = body.centerOfMass;
  assert.ok(Math.abs(x - 120) < 1e-3 && Math.abs(y) < 1e-3, `${x}, ${y}`);
  // Turned a quarter on the body, the centre goes with it: (100, 20).
  c.setRotationWrtParent(Math.PI / 2);
  [x, y] = body.centerOfMass;
  assert.ok(Math.abs(x - 100) < 1e-3 && Math.abs(y - 20) < 1e-3, `${x}, ${y}`);
  for (const bad of [() => c.setMass(-1), () => c.setMass(Number.NaN), () => c.setMassProperties(1, [0, 0], -1)])
    assert.throws(bad, RangeError);
  physics.removeCollider(c);
  assert.throws(() => c.setMass(1), /was removed/);
  physics.dispose();
});
