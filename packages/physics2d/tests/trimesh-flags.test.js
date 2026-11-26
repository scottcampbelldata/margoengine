// Rapier's triangle mesh flags on a 2D trimesh: fixInternalEdges joins the triangles into one solid for contacts, so a box
// slides over the edges they share (in Rapier 2D the flag changes nothing: the same box catches there with it or without
// it); the clean-up flags leave out what they name, in Rapier's order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Physics2D } from '../dist/index.js';

await Physics2D.load();

/** A strip 1000 px long and 100 px deep, its top at y 0 (y is down), cut into 40 triangles with slanted cuts. */
const strip = () => {
  const vertices = [],
    indices = [];
  for (let i = 0; i <= 20; i++) vertices.push([i * 50, 0], [i * 50, 100]);
  for (let i = 0; i < 20; i++) {
    const [a, b, c, d] = [2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 3];
    indices.push(a, b, c, b, d, c);
  }
  return { vertices, indices };
};

const slide = (fixInternalEdges) => {
  const physics = new Physics2D(null, { pixelsPerMeter: 100 });
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', ...strip(), friction: 0, fixInternalEdges } });
  const box = physics.addBody(null, {
    position: [30, -10],
    linearVelocity: [200, 0],
    canSleep: false,
    colliders: { shape: 'box', width: 20, height: 20, friction: 0 },
  });
  let slowest = Infinity,
    rose = 0,
    turned = 0;
  for (let i = 0; i < 120 && box.position[0] < 950; i++) {
    physics.step();
    slowest = Math.min(slowest, box.linearVelocity[0]);
    rose = Math.max(rose, -box.linearVelocity[1]);
    turned = Math.max(turned, Math.abs(box.rotation));
  }
  physics.dispose();
  return { slowest, rose, turned };
};

test('fixInternalEdges lets a box slide over the seams of a trimesh without catching, and without it the box catches', () => {
  const joined = slide(true);
  assert.ok(joined.slowest > 199.8, `slowed to ${joined.slowest} px/s`);
  assert.ok(joined.rose < 1, `rose at ${joined.rose} px/s`);
  assert.ok(joined.turned < 0.05, `turned ${joined.turned} rad`);
  const plain = slide(false);
  assert.ok(plain.slowest < 180 || plain.rose > 10 || plain.turned > 0.1, JSON.stringify(plain));
});

const shapesOf = (options) => {
  const physics = new Physics2D(null);
  const body = physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', ...options } });
  const count = body.colliders[0].shapes.length;
  physics.dispose();
  return count;
};

test('the clean-up flags leave out duplicate, degenerate and badly joined triangles, and merging finds duplicates by position', () => {
  const square = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  // The same triangle twice in another order, and again through copies of its vertices.
  const twice = { vertices: square, indices: [0, 1, 2, 2, 0, 1, 0, 2, 3] };
  assert.equal(shapesOf(twice), 3);
  assert.equal(shapesOf({ ...twice, deleteDuplicateTriangles: true }), 2);
  const copies = { vertices: [...square, [0, 0], [10, 0], [10, 10]], indices: [0, 1, 2, 4, 5, 6] };
  assert.equal(shapesOf({ ...copies, deleteDuplicateTriangles: true }), 2);
  assert.equal(shapesOf({ ...copies, mergeDuplicateVertices: true, deleteDuplicateTriangles: true }), 1);
  // A flat triangle collides along its line unless it is deleted.
  const flat = { vertices: [...square, [20, 0]], indices: [0, 1, 2, 0, 1, 4] };
  assert.equal(shapesOf(flat), 2);
  assert.equal(shapesOf({ ...flat, deleteDegenerateTriangles: true }), 1);
  // Three triangles on the edge from (0, 0) to (10, 10): the third is left out.
  const fan = { vertices: [...square, [20, 5]], indices: [0, 1, 2, 0, 2, 3, 0, 4, 2] };
  assert.equal(shapesOf(fan), 3);
  assert.equal(shapesOf({ ...fan, deleteBadTopologyTriangles: true }), 2);
});

test('a flat triangle alone is a segment a ball lands on, and with deleteDegenerateTriangles nothing is left', () => {
  const physics = new Physics2D(null);
  const line = {
    shape: 'trimesh',
    vertices: [
      [-50, 0],
      [0, 0],
      [50, 0],
    ],
    indices: [0, 1, 2],
  };
  physics.addBody(null, { type: 'fixed', position: [0, 100], colliders: line });
  const ball = physics.addBody(null, { position: [0, 50], colliders: { shape: 'circle', radius: 5 } });
  for (let i = 0; i < 120; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 95) < 1, `the ball rests at ${ball.position[1]}`);
  assert.throws(() => physics.addBody(null, { colliders: { ...line, deleteDegenerateTriangles: true } }), RangeError);
  physics.dispose();
});
