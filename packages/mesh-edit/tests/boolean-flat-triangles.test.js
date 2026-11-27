// Booleans take solids that hold triangles with no area: a cap (three corners in a line) and a needle (two corners in
// one point) are removed first, as Botsch and Kobbelt 2001 remove degenerate faces, and the solid stays closed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { booleanMeshes } from '@margoengine/mesh-edit/modeling';
import { batchBooleanMeshes } from '@margoengine/mesh-edit/boolean-batch';
import { booleanMeshesExact } from '@margoengine/mesh-edit/boolean-exact';
import { assertClosed, ids, volume } from './topology-helpers.js';

const face = (id, vertices) => ({ id, vertices, uv: vertices.map(() => [0, 0]) });
/** The box 0..2 as triangles, from corner `at`. */
function box(at = 0) {
  const vertices = Array.from({ length: 8 }, (_, i) => [at + 2 * (i & 1), at + 2 * ((i >> 1) & 1), at + 2 * (i >> 2)]),
    quads = [
      [0, 2, 3, 1],
      [4, 5, 7, 6],
      [0, 1, 5, 4],
      [2, 6, 7, 3],
      [0, 4, 6, 2],
      [1, 3, 7, 5],
    ];
  return {
    vertices,
    faces: quads.flatMap(([a, b, c, d], i) => [face(`${i}a`, [a, b, c]), face(`${i}b`, [a, c, d])]),
  };
}

/** The box with a point in the middle of the edge 0-1: one side of the edge takes it, the other closes with a cap. */
function capped() {
  const mesh = box(),
    mid = mesh.vertices.push([1, 0, 0]) - 1,
    at = mesh.faces.findIndex((f) => f.vertices.some((v, i) => v === 0 && f.vertices[(i + 1) % 3] === 1)),
    [split] = mesh.faces.splice(at, 1),
    third = split.vertices.find((v) => v !== 0 && v !== 1);
  mesh.faces.push(face('left', [0, mid, third]), face('right', [mid, 1, third]), face('cap', [1, mid, 0]));
  return mesh;
}

/** The box with the corner 1 doubled: the triangles between the two copies have no area. */
function needled() {
  const mesh = box(),
    copy = mesh.vertices.push([2, 0, 0]) - 1,
    users = mesh.faces.filter((f) => f.vertices.includes(1)),
    // The first face of the fan around corner 1 takes the copy; two needles close the gap.
    first = users[0],
    k = first.vertices.indexOf(1),
    next = first.vertices[(k + 1) % 3],
    previous = first.vertices[(k + 2) % 3];
  first.vertices[k] = copy;
  mesh.faces.push(face('n1', [1, next, copy]), face('n2', [previous, 1, copy]));
  return mesh;
}

const closedEdges = (mesh) => {
  const half = new Set(
    mesh.faces.flatMap((f) => f.vertices.map((v, i) => `${v}>${f.vertices[(i + 1) % f.vertices.length]}`)),
  );
  for (const k of half) assert.ok(half.has(k.split('>').reverse().join('>')), `open edge ${k}`);
};

for (const [name, make] of [
  ['a cap', capped],
  ['needles', needled],
]) {
  test(`booleans take a solid with ${name}`, () => {
    const solid = make(),
      before = structuredClone(solid);
    closedEdges(solid);
    const runs = [
      [booleanMeshes(solid, box(1), 'difference', ids()), 'a'],
      [booleanMeshesExact(solid, box(1), 'difference', ids()), 'a'],
      [batchBooleanMeshes([solid, box(1)], 'difference', ids()), 0],
    ];
    for (const [result, first] of runs) {
      assertClosed(result.mesh);
      // 8 less the shared unit cube.
      assert.ok(Math.abs(volume(result.mesh) - 7) < 1e-9, `${volume(result.mesh)}`);
      const names = new Set(solid.faces.map((f) => f.id));
      for (const source of Object.values(result.sources))
        if (source.input === first) assert.ok(names.has(source.face), `source ${source.face}`);
      const map = Array.isArray(result.faceMap) ? result.faceMap[0] : result.faceMap.a;
      assert.deepEqual(Object.keys(map).sort(), [...names].sort());
      assert.deepEqual(map[name === 'a cap' ? 'cap' : 'n1'], []);
    }
    assert.deepEqual(solid, before);
  });
}

test('a chain of caps along one edge, and a flat pocket, come out', () => {
  // Points at 0.5 and 1 on the edge 0-1, closed by two caps that share long edges.
  const mesh = capped(),
    quarter = mesh.vertices.push([0.5, 0, 0]) - 1,
    left = mesh.faces.findIndex((f) => f.id === 'left'),
    [split] = mesh.faces.splice(left, 1),
    [a, mid, third] = split.vertices;
  mesh.faces.push(face('l1', [a, quarter, third]), face('l2', [quarter, mid, third]), face('cap2', [mid, quarter, a]));
  closedEdges(mesh);
  const result = batchBooleanMeshes([mesh], 'union', ids());
  assertClosed(result.mesh);
  assert.ok(Math.abs(volume(result.mesh) - 8) < 1e-9);
});

test('an open solid is still refused', () => {
  const open = capped();
  open.faces = open.faces.filter((f) => f.id !== 'right');
  assert.throws(() => batchBooleanMeshes([open], 'union'), /closed|degenerate/);
  assert.throws(() => booleanMeshes(open, box(1), 'union'), TypeError);
});
