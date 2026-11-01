// autoLOD, hierarchicalLOD, LOD.fromModel and gltf-pro's MSFT_lod reading. Draw counts on a real GPU: auto-check.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../../core/dist/extension.js';
import { LOD } from '@margoengine/lod';
import { autoLOD, creased, hierarchicalLOD } from '@margoengine/lod/auto';

const sphere = (segments) => {
  const positions = [],
    normals = [],
    indices = [];
  for (let y = 0; y <= segments; y++)
    for (let x = 0; x <= segments; x++) {
      const a = (x / segments) * Math.PI * 2,
        b = (y / segments) * Math.PI,
        p = [Math.cos(a) * Math.sin(b), Math.cos(b), Math.sin(a) * Math.sin(b)];
      positions.push(...p);
      normals.push(...p);
    }
  for (let y = 0; y < segments; y++)
    for (let x = 0; x < segments; x++) {
      const i = y * (segments + 1) + x,
        j = i + segments + 1;
      indices.push(i, i + 1, j, i + 1, j + 1, j);
    }
  return { positions, normals, indices };
};

test('creased keeps a hard edge and smooths a soft one', () => {
  // Two triangles meeting at a right angle along the edge 0-1.
  const vertices = [
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    hard = creased(vertices, [0, 1, 2, 1, 0, 3], 60),
    soft = creased(vertices, [0, 1, 2, 1, 0, 3], 120),
    normal = (g, i) => [g.vertices[i * 6 + 3], g.vertices[i * 6 + 4], g.vertices[i * 6 + 5]];
  assert.deepEqual(normal(hard, 0), [0, 0, 1]);
  assert.deepEqual(normal(hard, 3), [0, 1, 0]);
  const s = normal(soft, 0);
  assert.ok(Math.abs(s[1] - s[2]) < 1e-6 && s[1] > 0.7, `the shared corner bends: ${s}`);
});

test('LOD.fromModel maps screen coverage to levels and adds a hiding level', () => {
  const added = [],
    system = {
      add(anchor, levels, options) {
        added.push({ anchor, levels, options });
        return added.at(-1);
      },
    };
  const [a, b, c] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  LOD.fromModel(system, {
    lods: [
      { node: a, levels: [a, b, c], screenCoverage: [0.5, 0.2, 0.01] },
      { node: b, levels: [b, c] },
    ],
  });
  assert.deepEqual(
    added[0].levels.map((l) => [l.object?.id ?? null, l.screen]),
    [
      ['a', undefined],
      ['b', 0.5],
      ['c', 0.2],
      [null, 0.01],
    ],
  );
  assert.deepEqual(added[1].levels[1].screen, 0.25, 'the default without coverage');
  assert.equal(added[1].levels.length, 2);
});

test('autoLOD refuses a mesh with no geometry and honours an aborted signal', async () => {
  const mesh = { check() {}, geometry: undefined, id: 0 };
  await assert.rejects(autoLOD({}, mesh), TypeError);
  const signal = AbortSignal.abort(new Error('stop'));
  const withGeometry = { ...mesh, geometry: box(1, 1, 1) };
  await assert.rejects(autoLOD({}, withGeometry, { signal }), /stop/);
  await assert.rejects(autoLOD({}, withGeometry, { ratios: [0.5], screens: [0.1, 0.2] }), RangeError);
});

test('hierarchicalLOD validates its options and needs meshes', async () => {
  await assert.rejects(hierarchicalLOD({}, [], { cell: 0 }), RangeError);
  await assert.rejects(hierarchicalLOD({}, [], { cell: 1, ratio: 2 }), RangeError);
  await assert.rejects(hierarchicalLOD({}, [], { cell: 1 }), /at least one/);
});

test('a real sphere: autoLOD levels hold fewer triangles each', async () => {
  const { meshLODChain, polygonMeshFromTriangles } = await import('@margoengine/mesh-edit/modeling'),
    s = sphere(16),
    chain = meshLODChain(polygonMeshFromTriangles({ positions: s.positions, indices: s.indices }).mesh, {
      ratios: [0.5, 0.25],
    });
  assert.ok(chain[0].triangles.after < s.indices.length / 3);
  assert.ok(chain[1].triangles.after < chain[0].triangles.after);
});
