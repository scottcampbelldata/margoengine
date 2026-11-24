import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPrimitiveMesh } from '@margoengine/mesh-edit';
import { subdivideMesh } from '@margoengine/mesh-edit/modeling';

// Fixtures: closed boxes, an open plane, an n-gon cylinder, a wedge, a seamed UV strip, a folded strip.
const strip = () => ({
  vertices: [[0, 0, 0], [1, 0, 0], [2, 0, 0.5], [0, 1, 0], [1, 1, 0], [2, 1, 0.5], [0, 2, 0], [1, 2, 0], [2, 2, 0.5]],
  faces: [
    { id: 'a', vertices: [0, 1, 4, 3], uv: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] },
    { id: 'b', vertices: [1, 2, 5, 4], uv: [[0.6, 0], [1, 0], [1, 0.5], [0.6, 0.5]] },
    { id: 'c', vertices: [3, 4, 7, 6], uv: [[0, 0.5], [0.5, 0.5], [0.5, 1], [0, 1]] },
    { id: 'd', vertices: [4, 5, 8, 7], uv: [[0.5, 0.5], [1, 0.5], [1, 1], [0.5, 1]] },
  ],
});
const fixtures = [
  ['cube', () => createPrimitiveMesh('cube', 'box')],
  ['plane', () => createPrimitiveMesh('plane', 'p')],
  ['cylinder', () => createPrimitiveMesh('cylinder', 'c')],
  ['wedge', () => createPrimitiveMesh('wedge', 'w')],
  ['strip', strip],
];
const variants = [
  { levels: 1 },
  { levels: 2, uv: 'linear' },
  { levels: 3, boundary: 'pinned' },
  { levels: 2, uv: 'smooth', boundary: 'smooth' },
];

function resultBytes(result) {
  const { mesh } = result;
  const floats = new Float64Array(mesh.vertices.flat().concat(mesh.faces.flatMap((face) => face.uv.flat())));
  return Buffer.concat([
    Buffer.from(floats.buffer),
    Buffer.from(JSON.stringify([mesh.faces.map((f) => [f.id, f.vertices]), result.faceMap, result.createdVertices])),
  ]);
}

function run(build, options) {
  let id = 0;
  return subdivideMesh(build(), { ...options, createId: () => `n${id++}` });
}

test('subdivision parses no edge IDs back into numbers', () => {
  const split = String.prototype.split;
  let parses = 0;
  String.prototype.split = function (...args) {
    if (args[0] === ':') parses++;
    return split.apply(this, args);
  };
  try {
    run(() => createPrimitiveMesh('cube', 'box'), { levels: 3 });
  } finally {
    String.prototype.split = split;
  }
  // Parent: 1260 parses of canonical "a:b" edge IDs across three levels (edge points, incidences, seams, other()).
  assert.equal(parses, 0);
});

test('20 subdivisions retain every output byte from the parent', () => {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const [, build] of fixtures)
    for (const options of variants) {
      const out = resultBytes(run(build, options));
      bytes += out.length;
      hash.update(out);
    }
  assert.equal(bytes, 482650);
  assert.equal(hash.digest('hex'), 'ce11636eb6f157726d6ec7155b57c1d390d10f9563b38ba7c30bc73d7d2433b1');
});
