import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { parseCAD } from '../dist/index.js';

async function headless(capacity = 64) {
  return new Engine(
    { width: 8, height: 8, clientWidth: 8, clientHeight: 8 },
    await TransformStore.create(capacity),
    { backend: 'webgl2', add() {}, remove() {}, render() {}, dispose() {} },
    undefined,
    null,
  );
}
/** World-space triangles of a parsed part as rounded [x, y, z] triples. */
function corners(mesh) {
  const { vertices, indices } = mesh.geometry;
  return Array.from(indices, (i) => [0, 1, 2].map((a) => Math.round(vertices[i * 6 + a] * 1000) / 1000));
}
const box = (name, x) =>
  [
    `o ${name}`,
    ...[
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ].map(([px, py, pz]) => `v ${px * 0.5 + x} ${py * 0.5} ${pz * 0.5}`),
    ...[
      [1, 4, 3, 2],
      [5, 6, 7, 8],
      [1, 2, 6, 5],
      [4, 8, 7, 3],
      [1, 5, 8, 4],
      [2, 3, 7, 6],
    ].map((f) => `f ${f.map((i) => i - 9).join(' ')}`),
  ].join('\n');

test('OBJ quads and triangles skip contour triangulation: 30,000 boxes (180,000 quads) load inside the work budget', async () => {
  const engine = await headless();
  try {
    const parts = Array.from({ length: 30_000 }, (_, i) => box(`part-${i}`, i * 0.75)),
      model = parseCAD(engine, `${parts.join('\n')}\n`, 'obj');
    assert.equal(model.meshes.length, 30_000);
    assert.ok(model.meshes.every((mesh) => mesh.geometry.indices.length === 36));
  } finally {
    engine.dispose();
  }
});

test('OBJ faces with five or more corners still spend the 10,000,000 contour work budget', async () => {
  const engine = await headless(),
    sides = 4096,
    ring = Array.from({ length: sides }, (_, i) => {
      const angle = (2 * Math.PI * i) / sides;
      return `v ${Math.cos(angle) * 10} ${Math.sin(angle) * 10} 0`;
    }),
    face = `f ${Array.from({ length: sides }, (_, i) => i + 1).join(' ')}`;
  try {
    assert.throws(() => parseCAD(engine, [...ring, ...Array.from({ length: 200 }, () => face)].join('\n'), 'obj'), {
      name: 'RangeError',
      message: 'Text total work budget exceeded',
    });
    // A pentagon still goes through contour triangulation and covers its whole area (shoelace area 5).
    const { vertices, indices } = parseCAD(engine, 'v 0 0 0\nv 2 0 0\nv 3 1 0\nv 1 2 0\nv -1 1 0\nf 1 2 3 4 5\n', 'obj')
      .meshes[0].geometry;
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => [vertices[indices[i + k] * 6], vertices[indices[i + k] * 6 + 1]]);
      area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    }
    assert.ok(Math.abs(area - 5) < 1e-6, `pentagon area ${area}`);
  } finally {
    engine.dispose();
  }
});

test('an OBJ triangle keeps its corners; a quad splits along its inside diagonal and keeps its winding', async () => {
  const engine = await headless(),
    load = (text) => parseCAD(engine, text, 'obj').meshes[0];
  try {
    assert.deepEqual(corners(load('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')), [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]);
    assert.deepEqual(
      corners(load('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n')),
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
        [0, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
      'a convex quad splits along its first diagonal',
    );
    // Reflex corner at the fourth vertex: the first diagonal would lie outside, so the quad splits along the second.
    assert.deepEqual(corners(load('v 0 0 0\nv 2 0 0\nv 2 2 0\nv 1.5 0.5 0\nf 1 2 3 4\n')), [
      [0, 0, 0],
      [2, 0, 0],
      [1.5, 0.5, 0],
      [2, 0, 0],
      [2, 2, 0],
      [1.5, 0.5, 0],
    ]);
    const flipped = load('v 0 0 0\nv 0 1 0\nv 1 1 0\nv 1 0 0\nf 1 2 3 4\n').geometry;
    assert.equal(flipped.indices.length, 6);
    assert.ok(
      Array.from({ length: flipped.vertices.length / 6 }, (_, i) => flipped.vertices[i * 6 + 5]).every((z) => z < 0),
      'a clockwise quad keeps its -z normal',
    );
    assert.equal(
      load('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0.5 0.5 0\nf 1 2 3 4\n').geometry.indices.length,
      3,
      'a quad with a straight corner keeps its one non-empty half',
    );
    assert.throws(() => load('v 0 0 0\nv 1 1 0\nv 1 0 0\nv 0 1 0\nf 1 2 3 4\n'), {
      message: 'OBJ quad crosses itself; split it into two triangles',
    });
    assert.throws(() => load('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 1\nf 1 2 3 4\n'), { message: 'Nonplanar OBJ face' });
    assert.throws(() => load('v 0 0 0\nv 1 0 0\nv 2 0 0\nf 1 2 3\n'), { message: 'Degenerate OBJ face' });
  } finally {
    engine.dispose();
  }
});
