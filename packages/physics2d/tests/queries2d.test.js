// Scene queries beyond the first hit: every hit along a ray, nearest first, and filters that leave one collider out. The ray's hits
// are held to closed forms, and to Rapier 2D where it is named (RAPIER2D_MODULE, as in oracle-rapier.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Physics2D } from '../dist/index.js';

const path = process.env.RAPIER2D_MODULE;
const skip = path ? false : 'not run: RAPIER2D_MODULE names no Rapier 2D module';
let R;
if (path) {
  R = (await import(pathToFileURL(resolve(path)).href)).default;
  await R.init();
}
await Physics2D.load();
const near = (actual, expected, bound, message) =>
  assert.ok(Math.abs(actual - expected) <= bound, `${message}: ${actual} is not within ${bound} of ${expected}`);

/** Three unit circles at x 5, 10 and 15 on the ray's line, and one off it. */
function scene() {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const bodies = [5, 10, 15].map((x) =>
    physics.addBody(null, { type: 'fixed', position: [x, 0], colliders: { shape: 'circle', radius: 1 } }),
  );
  physics.addBody(null, { type: 'fixed', position: [8, 6], colliders: { shape: 'circle', radius: 1 } });
  physics.step();
  return { physics, bodies };
}

test('raycastAll lists every collider the ray meets, nearest first, with the point and normal of each', () => {
  const { physics, bodies } = scene();
  const hits = physics.raycastAll([0, 0], [1, 0]);
  assert.equal(hits.length, 3);
  [4, 9, 14].forEach((d, i) => {
    near(hits[i].distance, d, 1e-4, `distance of hit ${i}`);
    near(hits[i].point[0], d, 1e-4, `point of hit ${i}`);
    near(hits[i].normal[0], -1, 1e-4, `normal of hit ${i}`);
    assert.equal(hits[i].body, bodies[i]);
  });
  assert.equal(physics.raycast([0, 0], [1, 0]).body, bodies[0], 'raycast is the first of them');
  assert.equal(physics.raycastAll([0, 0], [1, 0], { maxDistance: 10 }).length, 2, 'maxDistance cuts the list');
  assert.equal(physics.raycastAll([0, 0], [0, 1]).length, 0, 'a ray that meets nothing lists nothing');
  assert.throws(() => physics.raycastAll([0, 0], [0, 0]), RangeError);
});

test("excludeCollider leaves one collider out of a query and keeps the body's others", () => {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const body = physics.addBody(null, { type: 'fixed', position: [5, 0] });
  const near1 = body.addCollider({ shape: 'circle', radius: 1 }),
    far = body.addCollider({ shape: 'circle', radius: 1, offset: [4, 0] });
  physics.step();
  assert.equal(physics.raycast([0, 0], [1, 0]).collider, near1, 'the near collider is hit first');
  assert.equal(
    physics.raycast([0, 0], [1, 0], { excludeCollider: near1 }).collider,
    far,
    'without it the ray goes on to the other',
  );
  assert.equal(physics.raycast([0, 0], [1, 0], { exclude: body }), null, 'excluding the body excludes both');
  assert.equal(physics.overlapPoint([5, 0], { excludeCollider: near1 }).length, 0);
  assert.equal(physics.overlapPoint([9, 0], { excludeCollider: near1 }).length, 1);
  assert.equal(physics.raycastAll([0, 0], [1, 0], { excludeCollider: far }).length, 1);
});

test('raycastAll agrees with Rapier 2D: the same hits in the same order on a random scene', { skip }, () => {
  let s = 11;
  const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const world = new R.World({ x: 0, y: 0 });
  for (let i = 0; i < 25; i++) {
    const x = next() * 40,
      y = (next() - 0.5) * 20,
      r = 0.5 + next();
    physics.addBody(null, { type: 'fixed', position: [x, y], colliders: { shape: 'circle', radius: r } });
    const body = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(x, y));
    world.createCollider(R.ColliderDesc.ball(r), body);
  }
  physics.step();
  world.step();
  for (let k = 0; k < 20; k++) {
    const angle = (next() - 0.5) * 0.6,
      dir = [Math.cos(angle), Math.sin(angle)],
      mine = physics.raycastAll([0, 0], dir).map((h) => h.distance),
      theirs = [];
    world.intersectionsWithRay(new R.Ray({ x: 0, y: 0 }, { x: dir[0], y: dir[1] }), 1e3, true, (hit) => {
      theirs.push(hit.timeOfImpact);
      return true;
    });
    theirs.sort((a, b) => a - b);
    assert.equal(mine.length, theirs.length, `hits of ray ${k}`);
    mine.forEach((d, i) => near(d, theirs[i], 1e-3, `distance ${i} of ray ${k}`));
  }
});
