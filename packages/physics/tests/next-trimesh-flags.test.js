// Trimesh creation flags: clean-up steps (checked on the mesh the kernel is given, by what a ray and a fall find) and
// ORIENTED point queries (checked against the closed form of a cube).
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/next.js';
import { cleanTrimesh } from '../dist/next.js';

const warn = console.warn;
console.warn = () => {};
await Physics.load();
console.warn = warn;

// A unit cube of side 2 centred on the origin, outward counter-clockwise.
const cube = {
  vertices: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1],
  indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5],
};

test('an oriented mesh finds a point inside, and projects out of it', () => {
  const physics = new Physics(null, { gravity: [0, 0, 0] });
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', ...cube, oriented: true } });
  physics.addBody(null, { type: 'fixed', position: [10, 0, 0], colliders: { shape: 'trimesh', ...cube } });
  physics.step();
  assert.equal(physics.intersectPoint([0.2, 0.3, -0.4]).length, 1, 'inside the oriented cube only');
  assert.equal(physics.intersectPoint([10.2, 0.3, -0.4]).length, 0, 'a plain mesh holds no point');
  assert.equal(physics.intersectPoint([3, 0, 0]).length, 0);
  const inside = physics.projectPoint([0.2, 0.3, -0.4], { solid: true });
  assert.equal(inside.inside, true);
  assert.equal(inside.distance, 0);
  const surface = physics.projectPoint([0.2, 0.3, 0.4], { solid: false });
  assert.ok(Math.abs(surface.point[1] - 1) < 1e-4 || Math.abs(surface.point[0] - 1) < 1e-4 || Math.abs(surface.point[2] - 1) < 1e-4, `${surface.point}`);
  assert.equal(surface.inside, true);
  // A solid ray from inside hits at 0; one from outside meets the face.
  const ray = physics.raycast([0, 0, 0], [1, 0, 0]);
  assert.equal(ray.distance, 0);
  assert.ok(Math.abs(physics.raycast([-5, 0.1, 0.1], [1, 0, 0]).distance - 4) < 1e-5);
  physics.dispose();
});

test('merging joins vertices at one position, and the flags drop what they name', () => {
  const doubled = {
    // Two triangles of a square that do not share their seam vertices, plus a repeat of the first, a sliver and a line.
    vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]),
    indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 2, 1, 0, 6, 7, 8, 0, 0, 1]),
  };
  const merged = cleanTrimesh(doubled.vertices, doubled.indices, { mergeDuplicateVertices: true });
  assert.equal(merged.vertices.length / 3, 7, 'the two seam vertices join: 9 positions, 2 repeated');
  const degenerate = cleanTrimesh(doubled.vertices, doubled.indices, { deleteDegenerateTriangles: true });
  assert.deepEqual(Array.from(degenerate.indices), [0, 1, 2, 3, 4, 5, 2, 1, 0], 'the collinear triangle and the repeated corner go');
  const duplicates = cleanTrimesh(doubled.vertices, doubled.indices, { mergeDuplicateVertices: true, deleteDuplicateTriangles: true, deleteDegenerateTriangles: true });
  assert.equal(duplicates.indices.length / 3, 2, 'the square keeps two triangles; the repeat of the first and the sliver go');
  const fan = { vertices: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1]), indices: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 1, 4, 0, 1, 5]) };
  assert.equal(cleanTrimesh(fan.vertices, fan.indices, { deleteBadTopologyTriangles: true }).indices.length / 3, 2, 'four triangles on one edge: two stay');
  assert.deepEqual(Array.from(cleanTrimesh(fan.vertices, fan.indices, {}).indices), Array.from(fan.indices), 'no flag, no change');
  assert.throws(() => cleanTrimesh(Float32Array.of(0, 0, 0), Uint32Array.of(0, 0, 5), {}), /out of range/);
});

test('a mesh made with clean-up flags works as a floor, and one that loses every triangle is refused', () => {
  const physics = new Physics(null);
  physics.addBody(null, {
    type: 'fixed',
    colliders: {
      shape: 'trimesh',
      vertices: [-3, 0, -3, -3, 0, 3, 3, 0, -3, 3, 0, 3, -3, 0, -3],
      indices: [0, 1, 2, 2, 1, 3, 0, 1, 2, 4, 4, 4],
      mergeDuplicateVertices: true,
      deleteDuplicateTriangles: true,
      deleteDegenerateTriangles: true,
    },
  });
  const ball = physics.addBody(null, { position: [0.2, 2, 0.1], colliders: { shape: 'sphere', radius: 0.5 } });
  for (let i = 0; i < 180; i++) physics.step();
  assert.ok(Math.abs(ball.position[1] - 0.5) < 0.01, `${ball.position[1]}`);
  assert.throws(
    () => physics.addBody(null, { type: 'fixed', colliders: { shape: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2], deleteDegenerateTriangles: true } }),
    /dropped by its clean-up flags/,
  );
  physics.dispose();
});
