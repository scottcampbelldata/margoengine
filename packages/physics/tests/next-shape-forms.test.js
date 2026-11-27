// The other ways Rapier builds a collider or changes its size: a capsule along X or Z or from two end points, a tetrahedron,
// and the setters of a radius, a half height and half extents, each against a closed form and, where Rapier's JavaScript has
// the shape, against Rapier (`tests/oracle.js`, as a black box).
import assert from 'node:assert/strict';
import test from 'node:test';
import { RapierPhysics } from './oracle.js';
import { Physics } from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

const warn = console.warn;
console.warn = () => {};
await Promise.all([Physics.load(), RapierPhysics.load()]);
console.warn = warn;

const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);
const floor = (physics) =>
  physics.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [50, 0.5, 50] },
  });
const settle = (physics, steps = 180) => {
  for (let i = 0; i < steps; i++) physics.step();
};

test('a capsule along X or Z lies on its side: it rests a radius above the floor and reaches its length along that axis', () => {
  for (const axis of ['x', 'z']) {
    const physics = new Physics(null);
    floor(physics);
    const body = physics.addBody(null, {
      position: [0, 1, 0],
      colliders: { shape: 'capsule', halfHeight: 0.8, radius: 0.25, axis },
    });
    settle(physics);
    near(body.position[1], 0.25, 4e-3, `${axis}: resting on its side, a radius up`);
    const reach = axis === 'x' ? [1, 0, 0] : [0, 0, 1];
    const from = reach.map((v) => -5 * v);
    from[1] = body.position[1];
    const hit = physics.raycast(from, reach, { maxDistance: 10 });
    near(hit.distance, 5 - (0.8 + 0.25), 0.02, `${axis}: its end is half a height and a radius along ${axis}`);
    const box = body.colliders[0].aabb();
    near(box.max[axis === 'x' ? 0 : 2] - box.min[axis === 'x' ? 0 : 2], 2 * (0.8 + 0.25), 0.02, `${axis}: its box`);
    physics.dispose();
  }
});

test("a capsule from two end points is the segment grown by a radius, as Rapier's capsule_from_endpoints", () => {
  const a = [1, 0.5, 0],
    b = [1, 0.5, 3],
    radius = 0.3;
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const body = physics.addBody(null, { type: 'fixed', colliders: { shape: 'capsule', a, b, radius } });
  physics.step();
  // A ray across its middle meets the cylinder part; one along its axis meets the cap.
  near(physics.raycast([-2, 0.5, 1.5], [1, 0, 0]).distance, 3 - radius, 1e-3, 'across the middle');
  near(physics.raycast([1, 0.5, -3], [0, 0, 1]).distance, 3 - radius, 1e-3, 'along the axis, the cap');
  // The segment is slanted too: its volume is the cylinder and the two half balls, whatever its direction.
  const slanted = physics.addBody(null, {
    colliders: { shape: 'capsule', a: [0, 0, 0], b: [1, 2, 2], radius, density: 1000 },
  });
  const length = 3;
  near(
    slanted.colliders[0].volume(),
    Math.PI * radius * radius * length + (4 / 3) * Math.PI * radius ** 3,
    1e-6,
    'volume',
  );
  near(slanted.colliders[0].halfHeight(), length / 2, 1e-6, 'half height');
  void body;
  physics.dispose();
  assert.throws(
    () => new Physics(null).addBody(null, { colliders: { shape: 'capsule', a, b: a, radius } }),
    /two different points/,
  );
});

test("a tetrahedron is the convex hull of its four points, with the volume abs(det) / 6, and rests as Rapier's hull of them does", () => {
  const points = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  const worlds = [new Physics(null), new RapierPhysics(null)].map((physics, i) => {
    floor(physics);
    const body = physics.addBody(null, {
      position: [0, 0.5, 0],
      colliders:
        i === 0
          ? { shape: 'tetrahedron', a: points[0], b: points[1], c: points[2], d: points[3], density: 6000 }
          : { shape: 'convexHull', points: points.flat(), density: 6000 },
    });
    return { physics, body };
  });
  const [own, rapier] = worlds;
  near(own.body.colliders[0].volume(), 1 / 6, 1e-6, 'volume of the corner tetrahedron');
  near(own.body.mass, 1000, 1e-2, 'mass');
  for (const { physics } of worlds) settle(physics, 240);
  near(
    own.body.position[1],
    rapier.body.position[1],
    0.02,
    "comes to rest where Rapier's hull of the same points does",
  );
  // A ray through the slanted face x + y + z = 1 from far along (1, 1, 1): it meets the face at the centroid.
  const hit = own.physics.raycast(
    [5, 5, 5].map((v, k) => v + own.body.position[k]),
    [-1, -1, -1].map((v) => v / Math.sqrt(3)),
    { maxDistance: 20 },
  );
  assert.ok(hit, 'a hit');
  assert.throws(
    () =>
      new Physics(null).addBody(null, {
        colliders: { shape: 'tetrahedron', a: [0, 0, 0], b: [1, 0, 0], c: [0, 1, 0], d: [1, 1, 0] },
      }),
    rigidCoded,
  );
  for (const { physics } of worlds) physics.dispose();
});

test('setRadius, setHalfHeight and setHalfExtents resize a collider in place, keep its place and its turn, and the mass follows', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  const ball = physics.addBody(null, { colliders: { shape: 'sphere', radius: 0.5, density: 1000 } });
  ball.colliders[0].setRadius(1);
  near(ball.colliders[0].radius(), 1, 1e-6, 'radius');
  near(ball.mass, (4 / 3) * Math.PI * 1000, 1, 'a ball twice as wide weighs eight times as much');
  const lying = physics.addBody(null, {
    colliders: { shape: 'capsule', halfHeight: 0.5, radius: 0.2, axis: 'x', offset: [0.3, 0, 0] },
  });
  const before = lying.colliders[0].rotationWrtParent();
  lying.colliders[0].setHalfHeight(1.5).setRadius(0.4);
  assert.deepEqual(lying.colliders[0].rotationWrtParent(), before, 'it still lies along X');
  near(lying.colliders[0].translationWrtParent().x, 0.3, 1e-6, 'and where it was');
  near(lying.colliders[0].halfHeight(), 1.5, 1e-6, 'half height');
  near(lying.colliders[0].radius(), 0.4, 1e-6, 'radius');
  const crate = physics.addBody(null, {
    colliders: { shape: 'box', halfExtents: [1, 1, 1], borderRadius: 0.1, density: 100 },
  });
  crate.colliders[0].setHalfExtents([2, 1, 0.5]);
  assert.deepEqual(
    Object.values(crate.colliders[0].halfExtents()).map((v) => Math.round(v * 1000) / 1000),
    [2, 1, 0.5],
  );
  near(crate.colliders[0].borderRadius(), 0.1, 1e-6, 'the border stays');
  assert.throws(() => ball.colliders[0].setHalfExtents([1, 1, 1]), /box collider/);
  assert.throws(() => crate.colliders[0].setRadius(1), /no radius/);
  assert.throws(() => ball.colliders[0].setRadius(-1), /positive/);
  physics.dispose();
});
