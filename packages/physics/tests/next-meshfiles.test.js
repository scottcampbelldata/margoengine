// Mesh files to colliders: binary and ASCII STL and OBJ, welded, fanned and checked, and a trimesh or a hull of them in a world.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Physics } from '../dist/index.js';
import { meshFileCollider, parseDAE, parseOBJ, parseSTL } from '../dist/meshfiles.js';

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

/** The cube as Collada: the corners in centimetres, a polylist of quads, Z up, and a node that lifts it 100 cm along Z. */
function collada({ lift = '', mode = 'polylist' } = {}) {
  const flat = corners.map((c) => c.map((v) => v * 100).join(' ')).join(' ');
  const faces =
    mode === 'polylist'
      ? `<polylist count="6"><input semantic="VERTEX" source="#cube-vertices" offset="0"/><vcount>4 4 4 4 4 4</vcount><p>${quads.map((q) => q.join(' ')).join(' ')}</p></polylist>`
      : `<triangles count="12"><input semantic="VERTEX" source="#cube-vertices" offset="0"/><input semantic="NORMAL" source="#n" offset="1"/><p>${triangles.map((t) => t.map((i) => `${i} 0`).join(' ')).join(' ')}</p></triangles>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="centimeter" meter="0.01"/><up_axis>Z_UP</up_axis></asset>
  <library_geometries><geometry id="cube"><mesh>
    <source id="cube-positions"><float_array id="cube-array" count="24">${flat}</float_array><technique_common><accessor source="#cube-array" count="8" stride="3"/></technique_common></source>
    <vertices id="cube-vertices"><input semantic="POSITION" source="#cube-positions"/></vertices>
    ${faces}
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="scene"><node id="n"><matrix sid="transform">1 0 0 0 0 1 0 0 0 0 1 ${lift || 0} 0 0 0 1</matrix><instance_geometry url="#cube"/></node></visual_scene></library_visual_scenes>
</COLLADA>`;
}

test('Collada reads into the same welded cube: polylists and triangles, centimetres to metres, Z up to Y up, and the node moves it', () => {
  for (const mode of ['polylist', 'triangles']) {
    const mesh = parseDAE(collada({ mode }));
    assert.equal(mesh.vertices.length / 3, 8, `${mode}: eight welded corners`);
    assert.equal(mesh.indices.length / 3, 12, `${mode}: twelve triangles`);
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.vertices.length; i += 3)
      for (let k = 0; k < 3; k++) {
        low[k] = Math.min(low[k], mesh.vertices[i + k]);
        high[k] = Math.max(high[k], mesh.vertices[i + k]);
      }
    assert.deepEqual(
      low.map((v) => Math.round(v * 1e4) / 1e4),
      [0, 0, -1],
      `${mode}: a metre cube from the corners given in centimetres; Y was Z's partner, so it hangs below`,
    );
    assert.deepEqual(
      high.map((v) => Math.round(v * 1e4) / 1e4 + 0),
      [1, 1, 0],
      `${mode}: and its far corner`,
    );
  }
  // The node's 100 cm lift along Z is 1 m along Y after the turn.
  const lifted = parseDAE(collada({ lift: 100 }));
  assert.ok(Math.abs(Math.min(...lifted.vertices.filter((_, i) => i % 3 === 1)) - 1) < 1e-5, 'the cube is a metre up');
  assert.throws(() => parseDAE('<notcollada/>'), /not a Collada file/);
  assert.throws(() => parseDAE('<COLLADA><asset/></COLLADA>'), /no triangle/);
});

test('a Collada file is a collider the format is found for: a trimesh a ray meets, a hull that rests', () => {
  const file = collada({ lift: 0 });
  const options = meshFileCollider(file);
  assert.equal(options.shape, 'trimesh', 'found by its COLLADA element');
  assert.equal(meshFileCollider(file, { shape: 'convexHull' }).shape, 'convexHull');
});
