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

/** A fixed floor (a box 20 by 2, top face at y 1) and a ball of radius 0.5 to cast at it. */
function floorScene() {
  const physics = new Physics2D(null, { pixelsPerMeter: 1, gravity: [0, 0] });
  const floor = physics.addBody(null, {
    type: 'fixed',
    position: [0, 0],
    colliders: { shape: 'box', width: 20, height: 2 },
  });
  return { physics, floor };
}
const ball = { shape: 'circle', radius: 0.5 };

test('a shape cast stops targetDistance short, gives the closest points of both shapes and says how it ended', () => {
  const { physics, floor } = floorScene();
  const touch = physics.castShape(ball, [0, 5], [0, -1], 20);
  near(touch.distance, 3.5, 1e-3, 'distance to touch');
  near(touch.gap, 0, 1e-3, 'gap at touch');
  assert.equal(touch.status, 'converged');
  assert.equal(touch.body, floor);
  const short = physics.castShape(ball, [0, 5], [0, -1], 20, undefined, 0, { targetDistance: 0.25 });
  near(short.distance, 3.25, 1e-3, 'stops 0.25 short');
  near(short.gap, 0.25, 1e-3, 'the gap is the target distance');
  // The closest points: the ball's underside 0.25 over the floor's top face.
  near(short.witnessA[1], 1.25, 1e-3, 'witness on the ball');
  near(short.witnessB[1], 1, 1e-3, 'witness on the floor');
  near(short.witnessA[0], 0, 1e-3, 'straight under it');
  assert.deepEqual(short.normalA, [0, -1], 'the ball faces down toward the floor');
  assert.deepEqual(short.normalB, [0, 1], 'the floor faces up toward the ball');
  assert.deepEqual(short.normal, short.normalB);
  assert.deepEqual(short.point, short.witnessB, 'point is the witness on the collider met');
  assert.equal(
    physics.castShape(ball, [0, 5], [0, -1], 3.2, undefined, 0, { targetDistance: 0.25 }),
    null,
    'too short to get that close',
  );
  assert.throws(() => physics.castShape(ball, [0, 5], [0, -1], 20, undefined, 0, { targetDistance: -1 }), RangeError);
  physics.dispose();
});

test('a cast that does not stop at penetration ignores a collider it overlaps and is leaving', () => {
  const { physics } = floorScene();
  // The ball is sunk 0.3 into the floor: centre 1.2 (the top face is at 1, the ball's radius 0.5).
  const sunk = [0, 1.2];
  const into = (options) => physics.castShape(ball, sunk, [0, -1], 20, undefined, 0, options);
  const out = (options) => physics.castShape(ball, sunk, [0, 1], 20, undefined, 0, options);
  for (const options of [{}, { stopAtPenetration: false }]) {
    const hit = into(options);
    assert.equal(hit.distance, 0, 'sinking deeper meets it at once');
    assert.equal(hit.status, 'penetrating');
    near(hit.gap, -0.3, 1e-3, 'by how deep it is');
  }
  assert.equal(out({}).distance, 0, 'by default it stops at the overlap even leaving it');
  assert.equal(out({ stopAtPenetration: false }), null, 'with the option off, leaving it is not a hit');
  physics.dispose();
});

test('projectPoint with solid off puts a point inside a collider on its nearest surface point', () => {
  const { physics, floor } = floorScene();
  const solid = physics.projectPoint([0.5, 0.2]);
  assert.ok(solid.inside && solid.distance === 0, 'solid by default: a point inside is its own projection');
  const hollow = physics.projectPoint([0.5, 0.2], undefined, false);
  assert.ok(hollow.inside && hollow.body === floor, 'still inside');
  near(hollow.point[0], 0.5, 1e-4, 'x');
  near(hollow.point[1], 1, 1e-4, 'the top face is 0.8 above the point, the bottom 1.2');
  near(hollow.distance, 0.8, 1e-4, 'the way to the surface');
  physics.dispose();
});

test('shape cast and point projection agree with Rapier 2D: target distance, stop at penetration and a hollow projection', {
  skip,
}, () => {
  const { physics } = floorScene();
  const world = new R.World({ x: 0, y: 0 });
  world.createCollider(R.ColliderDesc.cuboid(10, 1), world.createRigidBody(R.RigidBodyDesc.fixed()));
  world.step();
  const shape = new R.Ball(0.5);
  for (const [from, dir, target, stop] of [
    [[0, 5], [0, -1], 0, true],
    [[0, 5], [0, -1], 0.25, true],
    [[3, 4], [-0.6, -0.8], 0.1, true],
    [[0, 1.2], [0, 1], 0, true],
    [[0, 1.2], [0, 1], 0, false],
    [[0, 1.2], [0, -1], 0, false],
    [[0, 5], [0, 1], 0, true],
  ]) {
    const mine = physics.castShape(ball, from, dir, 20, undefined, 0, {
      targetDistance: target,
      stopAtPenetration: stop,
    });
    const theirs = world.castShape({ x: from[0], y: from[1] }, 0, { x: dir[0], y: dir[1] }, shape, target, 20, stop);
    const label = `from ${from} along ${dir} target ${target} stop ${stop}`;
    assert.equal(mine === null, theirs === null, `${label}: a hit or not`);
    if (mine) near(mine.distance, theirs.time_of_impact, 1e-3, label);
  }
  const rapier = new R.World({ x: 0, y: 0 });
  rapier.createCollider(R.ColliderDesc.cuboid(10, 1), rapier.createRigidBody(R.RigidBodyDesc.fixed()));
  rapier.step();
  for (const solid of [true, false]) {
    const mine = physics.projectPoint([0.5, 0.7], undefined, solid);
    const theirs = rapier.projectPoint({ x: 0.5, y: 0.7 }, solid);
    near(mine.point[0], theirs.point.x, 1e-4, `x with solid ${solid}`);
    near(mine.point[1], theirs.point.y, 1e-4, `y with solid ${solid}`);
    assert.equal(mine.inside, theirs.isInside);
  }
});
