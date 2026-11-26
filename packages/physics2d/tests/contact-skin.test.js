// Contact skin (C2-13, Rapier's `setContactSkin`): a collider rests its skin off what it touches, the sum of the two
// colliders' skins, set when it is made or after, in world units at any pixelsPerMeter; a bad skin is refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

/** Where a 0.5 unit box comes to rest on a floor whose top is at y 0 (y grows downward), with these skins. */
function restY({ boxSkin = 0, floorSkin = 0, setAfter = false, ppm = 1 } = {}) {
  const physics = new Physics2D(null, { pixelsPerMeter: ppm, gravity: [0, 9.81 * ppm] });
  physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5],
    colliders: { shape: 'box', width: 20, height: 1, contactSkin: floorSkin },
  });
  const sprite = { x: 0, y: -1, rotation: 0 },
    body = physics.addBody(sprite, {
      colliders: { shape: 'box', width: 0.5, height: 0.5, ...(setAfter ? {} : { contactSkin: boxSkin }) },
    });
  if (setAfter) body.colliders[0].setContactSkin(boxSkin);
  for (let i = 0; i < 180; i++) physics.step();
  physics.sync(1);
  physics.dispose();
  return sprite.y;
}

test('a box rests the sum of the two colliders skins above the floor, set when made or after', () => {
  const plain = restY();
  assert.ok(Math.abs(plain + 0.25) < 0.006, `plain ${plain}`);
  for (const [boxSkin, floorSkin, setAfter] of [
    [0.05, 0, false],
    [0.03, 0.02, false],
    [0.05, 0, true],
  ]) {
    const gap = plain - restY({ boxSkin, floorSkin, setAfter });
    assert.ok(Math.abs(gap - (boxSkin + floorSkin)) < 0.002, `skins ${boxSkin} + ${floorSkin}: ${gap} higher`);
  }
});

test('the skin reads back in world units at any pixelsPerMeter, and a bad skin is refused', () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 100 });
  const [c] = physics.addBody(null, { colliders: { shape: 'circle', radius: 20, contactSkin: 5 } }).colliders;
  assert.ok(Math.abs(c.contactSkin() - 5) < 1e-5, `${c.contactSkin()}`);
  c.setContactSkin(2);
  assert.ok(Math.abs(c.contactSkin() - 2) < 1e-5);
  assert.throws(() => c.setContactSkin(-1), RangeError);
  assert.throws(() => c.setContactSkin(Number.NaN), RangeError);
  assert.throws(
    () => physics.addBody(null, { colliders: { shape: 'circle', radius: 1, contactSkin: Infinity } }),
    RangeError,
  );
  physics.dispose();
});
