// The pair queries between two colliders: the contact one holds with another, and the overlap of a sensor, each as of the last step and
// against Rapier 2D's `contact_pair` and `intersection_pair` where it is named (RAPIER2D_MODULE).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);
const path = process.env.RAPIER2D_MODULE;
const skip = path ? false : 'not run: RAPIER2D_MODULE names no Rapier 2D module';

function scene() {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, -10] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5],
    colliders: { shape: 'box', width: 20, height: 1 },
  });
  const crate = physics.addBody(null, {
    position: [0, 0.5],
    canSleep: false,
    colliders: { shape: 'box', width: 1, height: 1 },
  });
  const zone = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0.5],
    colliders: { shape: 'box', width: 4, height: 4, sensor: true },
  });
  const far = physics.addBody(null, {
    type: 'fixed',
    position: [50, 0.5],
    colliders: { shape: 'box', width: 1, height: 1, sensor: true },
  });
  for (let i = 0; i < 60; i++) physics.step();
  return {
    physics,
    floor,
    crate,
    zone,
    far,
    f: floor.colliders[0],
    c: crate.colliders[0],
    z: zone.colliders[0],
    n: far.colliders[0],
  };
}

test('contactPair gives the contact between two colliders, or null where there is none', () => {
  const { physics, f, c, z, n } = scene();
  const pair = physics.contactPair(c, f);
  assert.ok(pair && pair.touching && pair.solverActive, 'the crate rests on the floor');
  near(pair.normal[1], -1, 1e-4, 'the normal from the crate to the floor points down');
  assert.ok(pair.points.length >= 1 && pair.points.length <= 2);
  assert.equal(physics.contactPair(f, c).normal[1] > 0.99, true, 'and the other way up');
  assert.ok(pair.impulse > 0, "it carries the crate's weight");
  assert.equal(physics.contactPair(f, n), null, 'a far collider has no contact with the floor');
  assert.equal(physics.contactPair(z, c)?.solverActive ?? false, false, 'a sensor pushes nothing');
});

test('intersectionPair and intersectionPairsWith report what a sensor senses', () => {
  const { physics, f, c, z, n } = scene();
  assert.equal(physics.intersectionPair(z, c), true, 'the zone senses the crate');
  assert.equal(physics.intersectionPair(c, z), true, 'in either order');
  assert.equal(physics.intersectionPair(c, f), false, 'two solid colliders have no intersection pair');
  assert.equal(physics.intersectionPair(n, c), false, 'a sensor far off senses nothing');
  const sensed = physics.intersectionPairsWith(z);
  // The floor is inside the zone too, but two fixed bodies never pair.
  assert.equal(sensed.length, 1, 'the zone senses the crate');
  assert.ok(sensed.includes(c) && !sensed.includes(f));
  assert.ok(physics.intersectionPairsWith(c).includes(z));
  assert.equal(physics.intersectionPairsWith(n).length, 0);
});

test('the pair queries agree with Rapier 2D on the same scene', { skip }, async () => {
  const R = (await import(pathToFileURL(resolve(path)).href)).default;
  await R.init();
  const w = new R.World({ x: 0, y: -10 });
  const floor = w.createCollider(
    R.ColliderDesc.cuboid(10, 0.5),
    w.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5)),
  );
  const crate = w.createCollider(
    R.ColliderDesc.cuboid(0.5, 0.5),
    w.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.5).setCanSleep(false)),
  );
  const zone = w.createCollider(
    R.ColliderDesc.cuboid(2, 2).setSensor(true),
    w.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, 0.5)),
  );
  const far = w.createCollider(
    R.ColliderDesc.cuboid(0.5, 0.5).setSensor(true),
    w.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(50, 0.5)),
  );
  for (let i = 0; i < 60; i++) w.step();
  const { physics, f, c, z, n } = scene();
  let touching = false;
  w.contactPair(crate, floor, (manifold) => (touching = manifold.numContacts() > 0));
  assert.equal(touching, physics.contactPair(c, f)?.touching ?? false, 'crate and floor touch in both');
  assert.equal(w.intersectionPair(zone, crate), physics.intersectionPair(z, c), 'zone senses crate in both');
  assert.equal(w.intersectionPair(far, crate), physics.intersectionPair(n, c), 'far zone does not, in both');
  assert.equal(w.intersectionPair(crate, floor), physics.intersectionPair(c, f), 'two solids have none in both');
});
