// The voxel builders, the mesh reads and the mesh converter (Rapier's `voxels_from_points`, `voxelized_mesh`,
// `CONNECTED_COMPONENTS`, `HALF_EDGE_TOPOLOGY` and `MeshConverter`), each against a closed form.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Physics,
  convertMesh,
  meshConnectedComponents,
  meshHalfEdges,
  voxelizedMesh,
  voxelsFromPoints,
} from '../dist/index.js';
// Bad input to a body, collider, shape, query or mesh is a coded MargoError linking its help entry (Part 1, item 3).
const rigidCoded = (error) =>
  error?.name === 'MargoError' &&
  error.code === 'unsupported' &&
  /See https:..margoengine.com.errors#physics-(bodies|meshes)$/.test(error.message);

await Physics.load();
const near = (a, b, tolerance, message) =>
  assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} is not within ${tolerance} of ${b}`);

/** A closed box mesh from `lo` to `hi`: eight vertices, twelve triangles, wound outwards. */
function box(lo, hi) {
  const v = [];
  for (let i = 0; i < 8; i++) v.push(i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]);
  const f = [
    [0, 2, 1],
    [1, 2, 3], // z low
    [4, 5, 6],
    [5, 7, 6], // z high
    [0, 1, 4],
    [1, 5, 4], // y low
    [2, 6, 3],
    [3, 6, 7], // y high
    [0, 4, 2],
    [2, 4, 6], // x low
    [1, 3, 5],
    [3, 7, 5], // x high
  ];
  return { vertices: Float32Array.from(v), indices: Uint32Array.from(f.flat()) };
}

test('voxelsFromPoints gives each cell that holds a point once, sorted, with negative coordinates and a size per axis', () => {
  const { cells, size } = voxelsFromPoints(
    [0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 1.5, 0.2, 0.3, -0.1, 0.5, 0.5, 2.5, 0.5, -0.5],
    [1, 1, 1],
  );
  assert.deepEqual([...cells], [-1, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, -1]);
  assert.deepEqual(size, [1, 1, 1]);
  const scaled = voxelsFromPoints([0.1, 0.1, 0.1, 0.4, 0.9, 0.2, 0.6, 0.1, 0.1], [0.5, 1, 1]);
  assert.deepEqual([...scaled.cells], [0, 0, 0, 1, 0, 0]);
  assert.throws(() => voxelsFromPoints([0, 0], 1), /whole points/);
  assert.throws(() => voxelsFromPoints([0, 0, 0], 0), /positive/);
  // They make a voxel collider: a ball falls and rests on the cell they name.
  const physics = new Physics(null);
  const grid = voxelsFromPoints([0.5, 0.5, 0.5, 1.5, 0.5, 0.5], 1);
  physics.addBody(null, { type: 'fixed', colliders: { shape: 'voxels', cells: grid.cells, size: grid.size } });
  const ball = physics.addBody(null, { position: [0.5, 3, 0.5], colliders: { shape: 'sphere', radius: 0.25 } });
  for (let i = 0; i < 240; i++) physics.step();
  near(ball.position[1], 1.25, 0.01, 'the ball rests on the top of the cell');
  physics.dispose();
});

test('voxelizedMesh: the surface of a closed box is the cells it crosses, and filling it gives them all', () => {
  const { vertices, indices } = box([0.5, 0.5, 0.5], [3.5, 3.5, 3.5]);
  const surface = voxelizedMesh(vertices, indices, 1, 'surface');
  assert.equal(surface.cells.length / 3, 64 - 8, 'a 4 by 4 by 4 block less the 2 by 2 by 2 inside');
  const filled = voxelizedMesh(vertices, indices, 1, 'filled');
  assert.equal(filled.cells.length / 3, 64, 'the whole block');
  // An open mesh encloses nothing: filling it adds no cell.
  const quad = voxelizedMesh(
    [0.5, 0.5, 0.5, 3.5, 0.5, 0.5, 3.5, 3.5, 0.5, 0.5, 3.5, 0.5],
    [0, 1, 2, 0, 2, 3],
    1,
    'filled',
  );
  assert.equal(quad.cells.length / 3, 16, 'one layer of 4 by 4');
  // A finer grid: a box from 0.25 to 3.75 m in cells of 0.5 m spans 8 per side, 8^3 = 512 filled and 8^3 - 6^3 = 296 on the surface.
  const fine = box([0.25, 0.25, 0.25], [3.75, 3.75, 3.75]);
  assert.equal(voxelizedMesh(fine.vertices, fine.indices, 0.5, 'filled').cells.length / 3, 512);
  assert.equal(voxelizedMesh(fine.vertices, fine.indices, 0.5, 'surface').cells.length / 3, 296);
  assert.throws(() => voxelizedMesh(vertices, [0, 1, 99], 1), /outside/);
  assert.deepEqual([...voxelizedMesh([], [], 1).cells], []);
});

test('connected components name the triangles that share a vertex, in the order of their first triangle', () => {
  // A quad (two triangles), a lone triangle, and a second quad.
  const { component, count } = meshConnectedComponents([0, 1, 2, 2, 1, 3, 4, 5, 6, 7, 8, 9, 9, 8, 10]);
  assert.equal(count, 3);
  assert.deepEqual([...component], [0, 0, 1, 2, 2]);
  assert.deepEqual(meshConnectedComponents([]).count, 0);
});

test('half edges: a closed box has a twin for every one, and a quad has boundary edges and one pair of twins', () => {
  const { indices } = box([0, 0, 0], [1, 1, 1]);
  const closed = meshHalfEdges(indices);
  assert.ok(
    [...closed.twin].every((t) => t !== 0xffffffff),
    'every edge of a closed mesh has a twin',
  );
  for (let h = 0; h < closed.twin.length; h++) {
    assert.equal(closed.twin[closed.twin[h]], h, 'a twin of a twin is itself');
    assert.equal(closed.vertex[closed.twin[h]], closed.vertex[closed.next[h]], 'the twin starts where the edge ends');
    assert.equal(closed.face[closed.next[h]], closed.face[h]);
    assert.equal(closed.next[closed.next[closed.next[h]]], h, 'three half edges round a triangle');
  }
  const open = meshHalfEdges([0, 1, 2, 2, 1, 3]);
  assert.equal([...open.twin].filter((t) => t !== 0xffffffff).length, 2, 'the diagonal and no other');
});

test('a trimesh reads its components and half edges when it was made to', () => {
  const physics = new Physics(null);
  const body = physics.addBody(null, {
    type: 'fixed',
    colliders: {
      shape: 'trimesh',
      vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 0, 0, 6, 0, 0, 5, 0, 1],
      indices: [0, 2, 1, 3, 5, 4],
      connectedComponents: true,
      halfEdgeTopology: true,
    },
  });
  assert.equal(body.colliders[0].connectedComponents().count, 2);
  assert.equal(body.colliders[0].halfEdgeTopology().twin.length, 6);
  const plain = physics.addBody(null, {
    type: 'fixed',
    colliders: { shape: 'trimesh', vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 2, 1] },
  });
  assert.throws(() => plain.colliders[0].connectedComponents(), /connectedComponents: true/);
  assert.throws(() => plain.colliders[0].halfEdgeTopology(), /halfEdgeTopology: true/);
  physics.dispose();
});

test('convertMesh picks a collider for a mesh: itself, its hull, its box and its oriented box', () => {
  // A 4 by 2 by 1 box turned 30 degrees about z and moved to (5, 1, 2).
  const { vertices, indices } = box([-2, -1, -0.5], [2, 1, 0.5]);
  const c = Math.cos(Math.PI / 6),
    s = Math.sin(Math.PI / 6);
  const moved = Float32Array.from({ length: vertices.length }, (_, i) => vertices[i]);
  for (let i = 0; i < vertices.length; i += 3) {
    const [x, y, z] = [vertices[i], vertices[i + 1], vertices[i + 2]];
    moved[i] = c * x - s * y + 5;
    moved[i + 1] = s * x + c * y + 1;
    moved[i + 2] = z + 2;
  }
  assert.equal(convertMesh(moved, indices, 'trimesh').shape, 'trimesh');
  const flagged = convertMesh(moved, indices, 'trimesh', { trimesh: { oriented: true, mergeDuplicateVertices: true } });
  assert.equal(flagged.oriented, true, 'a trimesh carries its flags');
  assert.equal(convertMesh(moved, indices, 'convexHull', { borderRadius: 0.1 }).borderRadius, 0.1, 'a round hull');
  assert.throws(() => convertMesh(moved, indices, 'convexHull', { borderRadius: -1 }), rigidCoded);
  const hull = convertMesh(moved, indices, 'convexHull');
  assert.equal(hull.shape, 'convexHull');
  assert.equal(hull.points.length, 24);
  const aabb = convertMesh(moved, indices, 'aabb');
  near(aabb.halfExtents[0], 2 * c + 1 * s, 1e-4, 'the axis-aligned box is wider than the box');
  near(aabb.offset[0], 5, 1e-4, 'and centred on it');
  const obb = convertMesh(moved, indices, 'obb');
  const half = [...obb.halfExtents].sort((a, b) => a - b);
  near(half[0], 0.5, 1e-3, 'the thin side');
  near(half[1], 1, 1e-3, 'the middle side');
  near(half[2], 2, 1e-3, 'the long side');
  near(obb.offset[0], 5, 1e-3, 'centre x');
  near(obb.offset[1], 1, 1e-3, 'centre y');
  near(obb.offset[2], 2, 1e-3, 'centre z');
  // As a collider it weighs what the box does: 8 cubic metres of density 1.
  const physics = new Physics(null);
  const body = physics.addBody(null, { colliders: { ...obb, density: 1 } });
  near(body.colliders[0].volume(), 8, 1e-2, 'the volume of the oriented box');
  physics.dispose();
  assert.throws(() => convertMesh([], [], 'obb'), /at least one triangle/);
});
