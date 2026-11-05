// Mesh housekeeping: baking poses against hand-worked results, group merging, round trips and draw-mode conversion.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bakeMorphTargets,
  bakeSkin,
  computeTangents,
  deinterleaveAttributes,
  estimateMemory,
  interleaveAttributes,
  mergeGroups,
  triangleFanToTriangles,
  triangleStripToTriangles,
} from '../dist/utils.js';
import { boxGeometry } from '../dist/index.js';
import { close, vertexCount } from './support/mesh-checks.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const scale = (x, y, z) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];

const single = () => ({
  positions: Float32Array.of(1, 2, 3),
  normals: Float32Array.of(0, 0, 1),
  uvs: Float32Array.of(0, 0),
  indices: new Uint32Array(0),
});

test('bakeMorphTargets adds weighted differences and renormalizes', () => {
  const mesh = { ...single(), tangents: Float32Array.of(1, 0, 0, -1) },
    baked = bakeMorphTargets(
      mesh,
      [{ positions: [1, 0, 0], normals: [1, 0, 0], tangents: [0, 1, 0] }, { positions: [0, 10, 0] }],
      [1, 0.5],
    );
  assert.deepEqual([...baked.positions], [2, 7, 3]);
  close(baked.normals[0], Math.SQRT1_2, 1e-6, 'nx');
  close(baked.normals[2], Math.SQRT1_2, 1e-6, 'nz');
  close(baked.tangents[1], Math.SQRT1_2, 1e-6, 'ty');
  assert.equal(baked.tangents[3], -1, 'the sign is not morphed');
  assert.deepEqual([...mesh.positions], [1, 2, 3], 'input stays');
  assert.deepEqual([...bakeMorphTargets(mesh, [{ positions: [9, 9, 9] }], [0]).positions], [1, 2, 3]);
});

test('bakeSkin blends joints, with zero weights left in place and weights normalized', () => {
  const mesh = single(),
    matrices = [...translate(10, 0, 0), ...translate(0, 20, 0)],
    half = bakeSkin(mesh, { joints: [0, 1, 0, 0], weights: [2, 2, 0, 0], matrices });
  assert.deepEqual([...half.positions], [6, 12, 3]);
  const none = bakeSkin(mesh, { joints: [0, 0, 0, 0], weights: [0, 0, 0, 0], matrices });
  assert.deepEqual([...none.positions], [1, 2, 3]);
  // Weight zero on a joint past the end is fine: nothing reads it.
  const unused = bakeSkin(mesh, { joints: [0, 99, 0, 0], weights: [1, 0, 0, 0], matrices });
  assert.deepEqual([...unused.positions], [11, 2, 3]);
});

test('bakeSkin normals use the inverse transpose, and a mirror keeps them facing out', () => {
  const mesh = {
      ...single(),
      normals: Float32Array.of(Math.SQRT1_2, Math.SQRT1_2, 0),
      tangents: Float32Array.of(Math.SQRT1_2, -Math.SQRT1_2, 0, 1),
    },
    skin = (matrix) => ({ joints: [0, 0, 0, 0], weights: [1, 0, 0, 0], matrices: matrix }),
    stretched = bakeSkin(mesh, skin(scale(2, 1, 1)));
  // Squashed along the stretched axis: (1/2, 1, 0) made unit.
  const size = Math.hypot(0.5, 1);
  close(stretched.normals[0], 0.5 / size, 1e-6, 'nx');
  close(stretched.normals[1], 1 / size, 1e-6, 'ny');
  const t = Math.hypot(2, 1);
  close(stretched.tangents[0], 2 / t, 1e-6, 'tangent follows the matrix');
  assert.equal(stretched.tangents[3], 1);
  const mirrored = bakeSkin(mesh, skin(scale(-1, 1, 1)));
  close(mirrored.normals[0], -Math.SQRT1_2, 1e-6, 'mirror nx');
  close(mirrored.normals[1], Math.SQRT1_2, 1e-6, 'mirror ny');
});

test('an identity pose changes nothing', () => {
  const box = computeTangents(boxGeometry()),
    count = vertexCount(box),
    baked = bakeSkin(box, {
      joints: new Uint8Array(count * 4),
      weights: Float32Array.from({ length: count * 4 }, (_, i) => (i % 4 ? 0 : 1)),
      matrices: identity,
    });
  assert.deepEqual(baked.positions, box.positions);
  for (let i = 0; i < box.normals.length; i++) close(baked.normals[i], box.normals[i], 1e-6, 'normal');
  assert.deepEqual(baked.groups, box.groups);
});

test('mergeGroups makes one draw per material, in first-seen order, leaving loose triangles last', () => {
  const mesh = {
      ...single(),
      indices: Uint32Array.from({ length: 18 }, (_, i) => i),
      groups: [
        { start: 9, count: 3, materialIndex: 0 },
        { start: 0, count: 3, materialIndex: 1 },
        { start: 3, count: 3, materialIndex: 0 },
        { start: 12, count: 3, materialIndex: 1 },
      ],
    },
    merged = mergeGroups(mesh);
  assert.deepEqual(merged.groups, [
    { start: 0, count: 6, materialIndex: 1 },
    { start: 6, count: 6, materialIndex: 0 },
  ]);
  assert.deepEqual([...merged.indices], [0, 1, 2, 12, 13, 14, 3, 4, 5, 9, 10, 11, 6, 7, 8, 15, 16, 17]);
  assert.deepEqual([...mesh.indices].slice(0, 3), [0, 1, 2]);
  assert.equal(mergeGroups(single()).groups, undefined);
});

test('mergeGroups refuses groups that overlap or split triangles', () => {
  const mesh = { ...single(), indices: new Uint32Array(9) };
  assert.throws(
    () =>
      mergeGroups({
        ...mesh,
        groups: [
          { start: 0, count: 6, materialIndex: 0 },
          { start: 3, count: 3, materialIndex: 1 },
        ],
      }),
    /overlap/,
  );
  assert.throws(() => mergeGroups({ ...mesh, groups: [{ start: 1, count: 3, materialIndex: 0 }] }), /whole triangles/);
  assert.throws(() => mergeGroups({ ...mesh, groups: [{ start: 6, count: 6, materialIndex: 0 }] }), /whole triangles/);
});

test('interleave and deinterleave are a round trip', () => {
  const box = boxGeometry(),
    packed = interleaveAttributes([
      { array: box.positions, size: 3 },
      { array: box.normals, size: 3 },
      { array: box.uvs, size: 2 },
    ]);
  assert.equal(packed.stride, 8);
  assert.deepEqual(packed.offsets, [0, 3, 6]);
  assert.deepEqual([...packed.buffer.subarray(8, 11)], [...box.positions.subarray(3, 6)]);
  const [positions, normals, uvs] = deinterleaveAttributes(packed.buffer, [3, 3, 2]);
  assert.deepEqual(positions, box.positions);
  assert.deepEqual(normals, box.normals);
  assert.deepEqual(uvs, box.uvs);
  assert.throws(() => interleaveAttributes([]), /at least one/);
  assert.throws(() => interleaveAttributes([{ array: [1], size: 0 }]), /integer/);
  assert.throws(
    () =>
      interleaveAttributes([
        { array: [1, 2, 3], size: 3 },
        { array: [1, 2, 3, 4], size: 2 },
      ]),
    /counts differ/,
  );
  assert.throws(() => deinterleaveAttributes([1, 2, 3], [2]), /whole vertices/);
  assert.throws(() => deinterleaveAttributes([1], [0]), /integer/);
});

test('estimateMemory sums the bytes of each array', () => {
  const box = computeTangents(boxGeometry()),
    memory = estimateMemory(box);
  assert.equal(memory.positions, box.positions.byteLength);
  assert.equal(memory.tangents, box.tangents.byteLength);
  assert.equal(
    memory.total,
    box.positions.byteLength +
      box.normals.byteLength +
      box.uvs.byteLength +
      box.tangents.byteLength +
      box.indices.byteLength,
  );
  assert.equal(estimateMemory(single()).tangents, 0);
});

test('strips keep one winding, drop stitching triangles and restart', () => {
  assert.deepEqual([...triangleStripToTriangles([0, 1, 2, 3, 4])], [0, 1, 2, 1, 3, 2, 2, 3, 4]);
  assert.deepEqual([...triangleStripToTriangles(4)], [0, 1, 2, 1, 3, 2]);
  // Two strips stitched by repeats: the second keeps its winding because the count carries on.
  assert.deepEqual([...triangleStripToTriangles([0, 1, 2, 3, 3, 4, 4, 5, 6, 7])], [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]);
  assert.deepEqual([...triangleStripToTriangles([0, 1, 2, 0xffffffff, 3, 4, 5])], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...triangleStripToTriangles([0, 1])], []);
  assert.deepEqual([...triangleStripToTriangles(0)], []);
  assert.throws(() => triangleStripToTriangles(-1), /count/);
});

test('fans share their first vertex, drop degenerate triangles and restart', () => {
  assert.deepEqual([...triangleFanToTriangles([0, 1, 2, 3])], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...triangleFanToTriangles(4)], [0, 1, 2, 0, 2, 3]);
  assert.deepEqual([...triangleFanToTriangles([0, 1, 1, 2])], [0, 1, 2]);
  assert.deepEqual([...triangleFanToTriangles([0, 1, 2, 0xffffffff, 5, 6, 7])], [0, 1, 2, 5, 6, 7]);
  assert.throws(() => triangleFanToTriangles(1.5), /count/);
});

test('invalid input is refused with the fix in the message', () => {
  const mesh = single();
  assert.throws(() => bakeMorphTargets(mesh, [{}], []), /one per target/);
  assert.throws(() => bakeMorphTargets(mesh, [{}], [NaN]), /finite/);
  assert.throws(() => bakeMorphTargets(mesh, [{ positions: [1] }], [1]), /to match the vertices/);
  const skin = { joints: [0, 0, 0, 0], weights: [1, 0, 0, 0], matrices: identity };
  assert.throws(() => bakeSkin(mesh, { ...skin, joints: [0] }), /to match the vertices/);
  assert.throws(() => bakeSkin(mesh, { ...skin, matrices: [1] }), /16 values/);
  assert.throws(() => bakeSkin(mesh, { ...skin, weights: [-1, 0, 0, 0] }), />= 0/);
  assert.throws(() => bakeSkin(mesh, { ...skin, joints: [5, 0, 0, 0] }), /outside 1 matrices/);
});
