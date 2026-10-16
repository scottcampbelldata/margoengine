// Proof for @margoengine/machinery CAD import: vertex welding looks corners up in a numeric hash table instead of
// building a string key per corner, part fingerprints copy rows without subarray views, and the CRC walks bytes by index.
// Only src/cad-parser.ts is loaded: the package index also pulls in worker and wasm URLs the harness cannot build.
// Run: node examples/package-benchmarks/proofs/machinery.proof.js [ref] [pin]
// Pinned: f05414a against f47ff3f, the commit that recorded results/machinery.json, so the run never depends on today's tree.
import assert from 'node:assert/strict';
import { refs, versions, time, record } from './compare.js';

const { ref, pin } = refs('f05414a', 'f47ff3f'),
  { baseline, candidate } = await versions('machinery', ref, 'src/cad-parser.ts', pin);
// A torus with flat-shaded quads split into triangles, like a tessellated machined ring exported from CAD.
function torus(major, minor) {
  const triangles = [],
    at = (i, j) => {
      const u = (i / major) * Math.PI * 2,
        v = (j / minor) * Math.PI * 2,
        r = 2 + 0.6 * Math.cos(v);
      return [Math.fround(r * Math.cos(u)), Math.fround(0.6 * Math.sin(v)), Math.fround(r * Math.sin(u))];
    };
  for (let i = 0; i < major; i++)
    for (let j = 0; j < minor; j++) {
      const a = at(i, j),
        b = at(i + 1, j),
        c = at(i + 1, j + 1),
        d = at(i, j + 1);
      triangles.push([a, c, b], [a, d, c]);
    }
  return triangles;
}
function binarySTL(triangles) {
  const bytes = new Uint8Array(84 + triangles.length * 50),
    view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((triangle, face) =>
    triangle.forEach((p, i) =>
      p.forEach((value, axis) => view.setFloat32(84 + face * 50 + 12 + i * 12 + axis * 4, value, true)),
    ),
  );
  return bytes;
}
const asciiSTL = (triangles) =>
  `solid part\n${triangles.map((t) => `facet normal 0 0 1\nouter loop\n${t.map((p) => `vertex ${p.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid part`;
// An OBJ assembly: 40 identical bolt-head hexagons (concave-safe n-gons go through the same welding) in separate groups.
const obj =
  'v 0 0 0\nv 2 0 0\nv 2 1 0\nv 1 1 0\nv 1 2 0\nv 0 2 0\n' +
  Array.from({ length: 40 }, (_, i) => `g part${i}\nf 1 2 3 4 5 6\nf -6 -5 -4 -3 -2 -1`).join('\n');
const same = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert.equal(actual[i].name, expected[i].name);
    assert.deepEqual(actual[i].geometry.vertices, expected[i].geometry.vertices);
    assert.deepEqual(actual[i].geometry.indices, expected[i].geometry.indices);
    const fa = baseline.fingerprint(expected[i].geometry),
      fb = candidate.fingerprint(actual[i].geometry);
    assert.deepEqual(fb, fa);
    assert.equal(candidate.hash(fb), baseline.hash(fa));
  }
};
const cube = (() => {
  const p = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    quads = [
      [0, 3, 2, 1],
      [4, 5, 6, 7],
      [0, 1, 5, 4],
      [2, 3, 7, 6],
      [1, 2, 6, 5],
      [0, 4, 7, 3],
    ];
  return quads.flatMap(([a, b, c, d]) => [
    [p[a], p[b], p[c]],
    [p[a], p[c], p[d]],
  ]);
})();
// 131,072 triangles (393,216 corners, 311,312 welded vertices, so the weld table grows several times) is a detailed
// single part; 8,192 triangles is a small one.
const large = binarySTL(torus(256, 256)),
  small = binarySTL(torus(64, 64)),
  text = asciiSTL(torus(24, 12)),
  progressA = [],
  progressB = [];
same(
  candidate.parseCADGeometry(large, 'stl', (value) => progressB.push(value)),
  baseline.parseCADGeometry(large, 'stl', (value) => progressA.push(value)),
);
assert.deepEqual(progressB, progressA);
assert.ok(progressA.length > 5);
same(candidate.parseCADGeometry(small.buffer, 'stl'), baseline.parseCADGeometry(small.buffer, 'stl'));
same(candidate.parseCADGeometry(text, 'stl'), baseline.parseCADGeometry(text, 'stl'));
same(candidate.parseCADGeometry(obj, 'obj'), baseline.parseCADGeometry(obj, 'obj'));
for (const { parseCADGeometry } of [baseline, candidate]) {
  // Edge cases from tests/modern.test.js: shared corners weld, hard edges stay split, degenerate and collapsing triangles throw.
  const square = parseCADGeometry(
    asciiSTL([
      [
        [0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      [
        [0, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    ]),
    'stl',
  )[0].geometry;
  assert.equal(square.vertices.length / 6, 4);
  assert.equal(square.indices.length, 6);
  const box = parseCADGeometry(binarySTL(cube), 'stl')[0].geometry;
  assert.equal(box.vertices.length / 6, 24);
  assert.equal(box.indices.length, 36);
  assert.throws(
    () =>
      parseCADGeometry(
        asciiSTL([
          [
            [0, 0, 0],
            [0, 0, 0],
            [1, 0, 0],
          ],
        ]),
        'stl',
      ),
    { name: 'RangeError', message: 'Degenerate CAD triangle' },
  );
  assert.throws(
    () =>
      parseCADGeometry(
        asciiSTL([
          [
            [0, 0, 0],
            [0.000001, 0, 0],
            [0, 1, 0],
          ],
        ]),
        'stl',
      ),
    { name: 'RangeError', message: 'Triangle collapses at CAD welding tolerance' },
  );
  assert.throws(() => parseCADGeometry('v 0 0 0\nf 1 2 3', 'obj'));
  assert.throws(
    () =>
      parseCADGeometry(
        asciiSTL([
          [
            [0, 0, 0],
            [1e39, 0, 0],
            [0, 1, 0],
          ],
        ]),
        'stl',
      ),
    { name: 'RangeError' },
  );
  // Negative zero and values that round to the same 1e-5 cell must weld exactly as before.
  const near = parseCADGeometry(
    asciiSTL([
      [
        [-0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      [
        [0.000001, -0.000001, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    ]),
    'stl',
  )[0].geometry;
  assert.equal(near.vertices.length / 6, 4);
}
same(
  candidate.parseCADGeometry(
    asciiSTL([
      [
        [-0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      [
        [0.000001, -0.000001, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    ]),
    'stl',
  ),
  baseline.parseCADGeometry(
    asciiSTL([
      [
        [-0, 0, 0],
        [1, 0, 0],
        [1, 1, 0],
      ],
      [
        [0.000001, -0.000001, 0],
        [1, 1, 0],
        [0, 1, 0],
      ],
    ]),
    'stl',
  ),
);

const cases = [],
  geometry = baseline.parseCADGeometry(large, 'stl')[0].geometry,
  print = baseline.fingerprint(geometry);
cases.push({
  case: 'parse binary STL, 131,072 triangles',
  ...time(
    () => baseline.parseCADGeometry(large, 'stl'),
    () => candidate.parseCADGeometry(large, 'stl'),
    4,
  ),
});
cases.push({
  case: 'parse binary STL, 8,192 triangles',
  ...time(
    () => baseline.parseCADGeometry(small, 'stl'),
    () => candidate.parseCADGeometry(small, 'stl'),
  ),
});
// Fingerprint and hash run once per part when an assembly is deduplicated.
cases.push({
  case: 'fingerprint, 131,072 triangles',
  ...time(
    () => baseline.fingerprint(geometry),
    () => candidate.fingerprint(geometry),
    4,
  ),
});
cases.push({
  case: 'hash, 131,072 triangle fingerprint',
  ...time(
    () => baseline.hash(print),
    () => candidate.hash(print),
  ),
});
await record(
  'machinery',
  ref,
  cases,
  'CAD parser only (src/cad-parser.ts): welding compares the six rounded values as numbers in an open-addressed table instead of a Map keyed by a joined string; fingerprint and hash use indexed loops.',
  pin,
);
