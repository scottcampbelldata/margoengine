import assert from 'node:assert/strict';
import test from 'node:test';
import { createPrimitiveMesh, extrudeMeshFace, deleteMeshComponents } from '@margoengine/mesh-edit';
import { subdivideMesh, weldMeshVertices } from '@margoengine/mesh-edit/modeling';
import { paintMeshWeights, VertexGroups } from '@margoengine/mesh-edit/weights';

let next = 0;
const createId = () => `w${next++}`;

test('groups hold named weights; zero removes an entry', () => {
  const groups = new VertexGroups(4);
  groups.add('hip');
  groups.set('arm', 2, 0.5);
  assert.deepEqual(groups.names, ['hip', 'arm']);
  assert.equal(groups.get('arm', 2), 0.5);
  assert.equal(groups.get('arm', 1), 0);
  assert.equal(groups.get('leg', 1), 0);
  assert.deepEqual([...groups.weights('arm')], [0, 0, 0.5, 0]);
  groups.set('arm', 2, 0);
  assert.deepEqual(groups.toJSON().groups.arm, []);
  groups.rename('hip', 'pelvis');
  assert.deepEqual(groups.names, ['pelvis', 'arm']);
  assert.equal(groups.remove('arm'), true);
  assert.equal(groups.remove('arm'), false);
  assert.equal(groups.has('pelvis'), true);
});

test('weights survive an extrude: kept vertices keep theirs, new ones take their neighbors', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    groups = new VertexGroups(cube.vertices.length);
  cube.vertices.forEach((_, v) => {
    groups.set('all', v, 0.75);
  });
  groups.set('one', 0, 1);
  const edit = extrudeMeshFace(cube, cube.faces[0].id, 0.25, { createId }),
    after = groups.remap(edit);
  assert.equal(after.vertexCount, edit.mesh.vertices.length);
  for (let v = 0; v < after.vertexCount; v++) assert.equal(after.get('all', v), 0.75);
  for (const v of edit.vertexMap[0]) assert.equal(after.get('one', v), 1);
});

test('weights survive subdivision: edge points blend their ends', () => {
  const plane = createPrimitiveMesh('plane', 'tile'),
    groups = new VertexGroups(plane.vertices.length);
  const corner = 0;
  groups.set('tip', corner, 1);
  const edit = subdivideMesh(plane, { createId }),
    after = groups.remap(edit);
  const values = [...after.weights('tip')];
  assert.ok(
    values.some((x) => x > 0 && x < 1),
    'a blended weight exists',
  );
  assert.equal(after.get('tip', edit.vertexMap[corner][0]), 1);
});

test('weights survive delete and weld, and a stale map is refused', () => {
  const cube = createPrimitiveMesh('cube', 'box'),
    groups = new VertexGroups(cube.vertices.length);
  cube.vertices.forEach((_, v) => {
    groups.set('all', v, 1);
  });
  const edit = deleteMeshComponents(cube, { mode: 'face', faces: [cube.faces[0].id] }),
    after = groups.remap(edit);
  assert.equal(after.vertexCount, edit.mesh.vertices.length);
  assert.ok([...after.weights('all')].every((x) => x === 1));
  const grown = extrudeMeshFace(cube, cube.faces[0].id, 0.25, { createId });
  assert.throws(() => groups.remap(grown).remap(grown), TypeError);
  const pair = {
      vertices: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1e-7],
        [-1, 0, 0],
        [-1, 0, 1],
      ],
      faces: [
        {
          id: 'a',
          vertices: [0, 2, 1],
          uv: [
            [0, 0],
            [1, 1],
            [1, 0],
          ],
        },
        {
          id: 'b',
          vertices: [3, 4, 5],
          uv: [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        },
      ],
    },
    welding = new VertexGroups(6);
  welding.set('g', 0, 1);
  const welded = weldMeshVertices(pair, { distance: 1e-3 }),
    merged = welding.remap(welded),
    v = welded.vertexMap[0][0];
  // Two inputs joined: one had weight 1, one had none, so the mean is one half.
  assert.equal(merged.get('g', v), 0.5);
});

test('skin attributes: strongest joints, normalized, in order', () => {
  const groups = new VertexGroups(3);
  groups.set('a', 0, 0.2);
  groups.set('b', 0, 0.6);
  groups.set('c', 0, 0.1);
  groups.set('d', 0, 0.05);
  groups.set('e', 0, 0.05);
  groups.set('a', 1, 1);
  const { joints, weights, influences, unweighted } = groups.skinAttributes();
  assert.equal(influences, 4);
  assert.deepEqual([...joints.slice(0, 4)], [1, 0, 2, 3]);
  assert.ok(Math.abs(weights.slice(0, 4).reduce((a, b) => a + b) - 1) < 1e-6);
  assert.ok(Math.abs(weights[0] - 0.6 / 0.95) < 1e-6);
  assert.deepEqual([...joints.slice(4, 8)], [0, 0, 0, 0]);
  assert.equal(weights[4], 1);
  assert.deepEqual(unweighted, [2]);
  assert.equal(weights[8], 1);
  const named = groups.skinAttributes({ influences: 1, joints: { a: 7, b: 9, c: 1, d: 2, e: 3 } });
  assert.equal(named.joints[0], 9);
  assert.throws(() => groups.skinAttributes({ joints: { a: 1 } }), RangeError);
  assert.throws(() => groups.skinAttributes({ influences: 9 }), RangeError);
});

test('normalize makes each vertex sum to 1 and leaves empty vertices empty', () => {
  const groups = new VertexGroups(3);
  groups.set('a', 0, 0.5);
  groups.set('b', 0, 0.5);
  groups.set('a', 1, 0.2);
  groups.set('b', 1, 0.2);
  groups.normalize([1]);
  assert.equal(groups.get('a', 1), 0.5);
  groups.set('a', 0, 0.1);
  groups.normalize();
  assert.ok(Math.abs(groups.get('a', 0) + groups.get('b', 0) - 1) < 1e-12);
  assert.equal(groups.get('a', 2), 0);
});

test('JSON round trip', () => {
  const groups = new VertexGroups(5);
  groups.set('a', 1, 0.25);
  groups.set('b', 4, 1);
  const copy = VertexGroups.fromJSON(JSON.parse(JSON.stringify(groups)));
  assert.deepEqual(copy.toJSON(), groups.toJSON());
  assert.throws(() => VertexGroups.fromJSON(null), TypeError);
  assert.throws(() => VertexGroups.fromJSON({ vertexCount: 1, groups: { a: [[3, 1]] } }), RangeError);
});

function sheet() {
  let mesh = createPrimitiveMesh('plane', 'tile');
  for (let i = 0; i < 3; i++) mesh = subdivideMesh(mesh, { createId }).mesh;
  return mesh;
}

test('the brush paints inside its radius with falloff, and modes combine', () => {
  const mesh = sheet(),
    groups = new VertexGroups(mesh.vertices.length),
    touched = paintMeshWeights(groups, mesh, 'g', { center: [0, 0, 0], radius: 0.3 });
  assert.ok(touched.length > 4);
  mesh.vertices.forEach((p, v) => {
    const d = Math.hypot(...p);
    if (d >= 0.3) assert.equal(groups.get('g', v), 0);
    if (d === 0) assert.equal(groups.get('g', v), 1);
  });
  const middle = mesh.vertices.findIndex((p) => Math.hypot(...p) > 0.1 && Math.hypot(...p) < 0.2);
  assert.ok(groups.get('g', middle) > 0 && groups.get('g', middle) < 1);
  const center = mesh.vertices.findIndex((p) => Math.hypot(...p) === 0);
  paintMeshWeights(groups, mesh, 'g', {
    center: [0, 0, 0],
    radius: 0.05,
    mode: 'subtract',
    value: 0.25,
    falloff: 'constant',
  });
  assert.equal(groups.get('g', center), 0.75);
  paintMeshWeights(groups, mesh, 'g', {
    center: [0, 0, 0],
    radius: 0.05,
    mode: 'add',
    value: 0.5,
    falloff: 'constant',
  });
  assert.equal(groups.get('g', center), 1);
  paintMeshWeights(groups, mesh, 'g', {
    center: [0, 0, 0],
    radius: 0.05,
    value: 0,
    strength: 0.5,
    falloff: 'constant',
  });
  assert.equal(groups.get('g', center), 0.5);
});

test('smooth mode softens a hard edge, and normalize keeps sums at one', () => {
  const mesh = sheet(),
    groups = new VertexGroups(mesh.vertices.length);
  mesh.vertices.forEach((p, v) => {
    groups.set('left', v, p[0] < 0 ? 1 : 0);
    groups.set('right', v, p[0] < 0 ? 0 : 1);
  });
  paintMeshWeights(groups, mesh, 'left', { center: [0, 0, 0], radius: 0.4, mode: 'smooth', falloff: 'constant' });
  const soft = [...groups.weights('left')].filter((x) => x > 0.01 && x < 0.99);
  assert.ok(soft.length > 4);
  const touched = paintMeshWeights(groups, mesh, 'left', {
    center: [0, 0, 0],
    radius: 0.2,
    value: 0.9,
    normalize: true,
  });
  for (const v of touched) assert.ok(Math.abs(groups.get('left', v) + groups.get('right', v) - 1) < 1e-9);
});

test('bad input rejects with the fix in the message', () => {
  const mesh = sheet(),
    groups = new VertexGroups(mesh.vertices.length),
    brush = { center: [0, 0, 0], radius: 1 };
  assert.throws(() => new VertexGroups(-1), RangeError);
  assert.throws(() => groups.set('', 0, 1), TypeError);
  assert.throws(() => groups.set('a', 9999, 1), RangeError);
  assert.throws(() => groups.set('a', 0, 2), RangeError);
  groups.add('a');
  groups.add('b');
  assert.throws(() => groups.rename('none', 'x'), RangeError);
  assert.throws(() => groups.rename('a', 'b'), RangeError);
  assert.throws(() => paintMeshWeights(new VertexGroups(1), mesh, 'a', brush), RangeError);
  assert.throws(() => paintMeshWeights(groups, mesh, '', brush), TypeError);
  assert.throws(() => paintMeshWeights(groups, mesh, 'a', { ...brush, center: [0] }), TypeError);
  assert.throws(() => paintMeshWeights(groups, mesh, 'a', { ...brush, radius: 0 }), RangeError);
  assert.throws(() => paintMeshWeights(groups, mesh, 'a', { ...brush, value: 2 }), RangeError);
  assert.throws(() => paintMeshWeights(groups, mesh, 'a', { ...brush, strength: 2 }), RangeError);
  assert.throws(() => paintMeshWeights(groups, mesh, 'a', { ...brush, mode: 'blur' }), TypeError);
  assert.throws(() => paintMeshWeights(groups, mesh, 'a', { ...brush, falloff: 'hard' }), TypeError);
});
