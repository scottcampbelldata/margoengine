// Mesh files to colliders: binary and ASCII STL and OBJ, welded, fanned and checked, and a trimesh or a hull of them in a world.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { meshFileCollider, parseOBJ, parseSTL } from '../dist/meshfiles.js';

// A unit cube from 0 to 1, as 12 triangles (counter-clockwise from outside).
const corners = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
];
const quads = [
  [0, 3, 2, 1],
  [4, 5, 6, 7],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [1, 2, 6, 5],
  [3, 0, 4, 7],
];
const triangles = quads.flatMap(([a, b, c, d]) => [
  [a, b, c],
  [a, c, d],
]);

function asciiSTL() {
  const facets = triangles.map(
    (t) =>
      `facet normal 0 0 0\n outer loop\n${t.map((i) => `  vertex ${corners[i].join(' ')}`).join('\n')}\n endloop\nendfacet`,
  );
  return `solid cube\n${facets.join('\n')}\nendsolid cube\n`;
}
function binarySTL() {
  const buffer = new ArrayBuffer(84 + triangles.length * 50),
    view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((t, k) =>
    t.forEach((i, v) => corners[i].forEach((x, c) => view.setFloat32(84 + k * 50 + 12 + v * 12 + c * 4, x, true))),
  );
  return buffer;
}
const obj = `# a cube\n${corners.map((c) => `v ${c.join(' ')}`).join('\n')}\n${quads.map((q) => `f ${q.map((i) => `${i + 1}//1`).join(' ')}`).join('\n')}\n`;

test('STL, binary and ASCII, and OBJ read into the same welded cube', () => {
  for (const [name, mesh] of [
    ['ascii STL', parseSTL(asciiSTL())],
    ['binary STL', parseSTL(binarySTL())],
    ['OBJ with quads', parseOBJ(obj)],
  ]) {
    assert.equal(mesh.vertices.length, 24, `${name}: 8 vertices`);
    assert.equal(mesh.indices.length, 36, `${name}: 12 triangles`);
  }
  // Negative indices count from the end.
  const back = parseOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n');
  assert.deepEqual([...back.indices], [0, 1, 2]);
});

test('files that cannot be read say what to pass', () => {
  assert.throws(() => parseSTL('solid empty\nendsolid\n'), RangeError);
  assert.throws(() => parseOBJ('v 0 0 0\nf 1 2 3\n'), /vertex 2/);
  assert.throws(() => parseOBJ('# nothing\n'), RangeError);
});

test('a cube file is a collider: a trimesh a ray meets at its top, a hull that falls and rests on a floor', async () => {
  await Physics.load();
  const physics = new Physics(null);
  physics.addBody(null, { type: 'fixed', position: [0, 0, 0], colliders: meshFileCollider(binarySTL()) });
  physics.step();
  const hit = physics.raycast([0.5, 3, 0.5], [0, -1, 0]);
  assert.ok(hit, 'the ray meets the file');
  assert.ok(Math.abs(hit.distance - 2) < 1e-4, `the top at y 1: ${hit.distance}`);
  physics.dispose();
  const world = new Physics(null);
  world.addBody(null, {
    type: 'fixed',
    position: [0, -0.5, 0],
    colliders: { shape: 'box', halfExtents: [10, 0.5, 10] },
  });
  const crate = world.addBody(null, {
    position: [0, 2, 0],
    colliders: { ...meshFileCollider(obj, { shape: 'convexHull' }), density: 100 },
  });
  for (let i = 0; i < 240; i++) world.step();
  // The hull's origin is the cube's corner, so the body rests with its corner 0 above the floor: its lowest point is the floor.
  assert.ok(Math.abs(crate.position[1]) < 0.02, `rests on its bottom face: ${crate.position[1]}`);
  world.dispose();
});

test('the solver build is a hash of its kernel source, known once it is loaded', async () => {
  await Physics.load();
  assert.match(Physics.kernelBuild, /^[0-9a-f]{64}$/);
});
