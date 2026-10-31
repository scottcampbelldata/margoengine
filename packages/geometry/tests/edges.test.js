import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import { readFileSync } from 'node:fs';
import {
  boxGeometry,
  coneGeometry,
  cylinderGeometry,
  edgesGeometry,
  icosahedronGeometry,
  planeGeometry,
  sphereGeometry,
  toNonIndexed,
} from '../dist/index.js';

const vectors = JSON.parse(
  readFileSync(new URL('./fixtures/edges-vectors.json', import.meta.url), 'utf8'),
).edgesGeometry;

const mesh = (positions, indices) => ({
  positions: Float32Array.from(positions),
  normals: new Float32Array(0),
  uvs: new Float32Array(0),
  indices: Uint32Array.from(indices),
});
const point = (data, i) => [data.positions[i * 3], data.positions[i * 3 + 1], data.positions[i * 3 + 2]];
const segmentsOf = (data, pairs) => {
  const out = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const a = point(data, pairs[i]),
      b = point(data, pairs[i + 1]);
    out.push(compare(a, b) <= 0 ? [a, b] : [b, a]);
  }
  return out.sort((s, t) => compare(s[0], t[0]) || compare(s[1], t[1]));
};
// Sorting at 1e-5 resolution so float noise does not reorder equal points.
const compare = (a, b) => {
  for (let k = 0; k < 3; k++) {
    const d = Math.round(a[k] * 1e5) - Math.round(b[k] * 1e5);
    if (d) return d;
  }
  return 0;
};
const totalLength = (data, pairs) => {
  let sum = 0;
  for (let i = 0; i < pairs.length; i += 2) {
    const a = point(data, pairs[i]),
      b = point(data, pairs[i + 1]);
    sum += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return sum;
};

function check(name, data, angle) {
  const want = vectors[name],
    pairs = edgesGeometry(data, angle);
  assert.ok(pairs instanceof Uint32Array, name);
  assert.equal(pairs.length % 2, 0, name);
  for (const i of pairs) assert.ok(i < data.positions.length / 3, `${name}: index in range`);
  assert.equal(pairs.length / 2, want.edges, `${name}: edge count`);
  assert.ok(Math.abs(totalLength(data, pairs) - want.totalLength) < 1e-5, `${name}: total length`);
  if (want.segments) {
    const got = segmentsOf(data, pairs),
      expected = want.segments
        .map(([a, b]) => (compare(a, b) <= 0 ? [a, b] : [b, a]))
        .sort((s, t) => compare(s[0], t[0]) || compare(s[1], t[1]));
    got.forEach((segment, i) =>
      segment.forEach((p, j) =>
        p.forEach((v, k) => assert.ok(Math.abs(v - expected[i][j][k]) < 1e-5, `${name}: segment ${i}`)),
      ),
    );
  }
}

test('feature edges match the recorded vectors', () => {
  const box = boxGeometry(1, 1, 1);
  check('box 1x1x1 segs 2 default angle', boxGeometry(1, 1, 1, 2, 2, 2));
  check('box 1x1x1 angle 89', box, 89);
  check('box 1x1x1 angle 90', box, 90);
  check('box 1x1x1 angle 91', box, 91);
  check('angle 180', box, 180);
  check('sphere 32x16 angle 20', sphereGeometry(1, 32, 16), 20);
  check('sphere 8x6 angle 1', sphereGeometry(1, 8, 6), 1);
  check('plane 3x3 grid', planeGeometry(1, 1, 3, 3));
  check('angle 0', planeGeometry(1, 1, 2, 2), 0);
  check('cylinder 24 angle 30', cylinderGeometry(1, 1, 1, 24), 30);
  check('cylinder 16 angle 20', cylinderGeometry(1, 1, 1, 16), 20);
  check('cylinder 16 angle 30', cylinderGeometry(1, 1, 1, 16), 30);
  check('cone 8 angle 1', coneGeometry(1, 2, 8), 1);
  check('icosahedron non-indexed angle 1', toNonIndexed(icosahedronGeometry(1, 0)), 1);
});

test('seam copies within 1e-4 pair up', () => {
  // Two faces sharing the x axis edge, about 89.998 degrees apart; the second face's copies are 3e-5 off.
  const t = (89.998 * Math.PI) / 180,
    e = 3e-5,
    data = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1 + e, e, 0, e, 0, e, 0, -Math.cos(t), Math.sin(t)], [0, 1, 2, 3, 4, 5]);
  // Normals: +z, and one turned 89.998 degrees from it about the x axis.
  assert.equal(edgesGeometry(data, 1).length / 2, vectors['seam within 1e-4 pairs up'].edges1);
  assert.equal(edgesGeometry(data, 90).length / 2, vectors['seam within 1e-4 pairs up'].edges90);
  assert.equal(edgesGeometry(data, 91).length / 2, vectors['seam within 1e-4 pairs up'].edges91);
});

test('degenerate faces are skipped and odd input never throws', () => {
  const data = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0], [0, 1, 2, 1, 3, 2]);
  assert.equal(edgesGeometry(data).length / 2, vectors['degenerate triangle skipped'].edges);
  assert.equal(edgesGeometry(mesh([], [])).length, 0);
  // Angles that are not numbers give no creases; boundaries stay.
  assert.equal(edgesGeometry(data, Number.NaN).length / 2, 3);
});

test('non-manifold fan: a repeated direction is ignored, the opposite one closes the edge', () => {
  // Three faces on the edge 0-1: the first two run 0 -> 1, the third 1 -> 0.
  const data = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1], [0, 1, 2, 0, 1, 3, 1, 0, 4]);
  const pairs = edgesGeometry(data);
  assert.equal(pairs.length / 2, vectors['three faces on one edge (non-manifold fan)'].edges);
  assert.ok(
    Math.abs(totalLength(data, pairs) - vectors['three faces on one edge (non-manifold fan)'].totalLength) < 1e-5,
  );
});

test('closed meshes have no boundary edges and reading uses positions and indices only', () => {
  const sphere = sphereGeometry(1, 128, 64),
    cpu = cpuTimer(),
    pairs = edgesGeometry(
      { positions: sphere.positions, normals: sphere.positions, uvs: new Float32Array(0), indices: sphere.indices },
      30,
    );
  assert.equal(pairs.length, 0, 'a smooth closed sphere has no feature edges');
  assert.ok(cpu() < 150, 'linear time on 8,385 vertices');
  // Threshold 0 returns every welded edge of a closed box once: 12 cube edges + 6 face diagonals.
  assert.equal(edgesGeometry(boxGeometry(1, 1, 1), 0).length / 2, 18);
});

// Hand-built meshes (one vertex grid per face, copies at the shared edges), independent of the primitives module.
function faceGrids(faces, n) {
  const P = [],
    I = [];
  for (const [o, u, w] of faces) {
    const base = P.length / 3;
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) for (let k = 0; k < 3; k++) P.push(o[k] + (u[k] * i) / n + (w[k] * j) / n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = base + j * (n + 1) + i,
          c = a + n + 1;
        I.push(a, a + 1, c + 1, a, c + 1, c);
      }
  }
  return mesh(P, I);
}
const h = 0.5,
  cube = (n) =>
    faceGrids(
      [
        [
          [h, -h, -h],
          [0, 1, 0],
          [0, 0, 1],
        ],
        [
          [-h, -h, -h],
          [0, 0, 1],
          [0, 1, 0],
        ],
        [
          [-h, h, -h],
          [0, 0, 1],
          [1, 0, 0],
        ],
        [
          [-h, -h, -h],
          [1, 0, 0],
          [0, 0, 1],
        ],
        [
          [-h, -h, h],
          [1, 0, 0],
          [0, 1, 0],
        ],
        [
          [-h, -h, -h],
          [0, 1, 0],
          [1, 0, 0],
        ],
      ],
      n,
    );

test('hand-built boxes and grid match the recorded vectors', () => {
  check('box 1x1x1 segs 2 default angle', cube(2));
  for (const angle of [89, 90, 91]) check(`box 1x1x1 angle ${angle}`, cube(1), angle);
  check('angle 180', cube(1), 180);
  check(
    'plane 3x3 grid',
    faceGrids(
      [
        [
          [-h, -h, 0],
          [1, 0, 0],
          [0, 1, 0],
        ],
      ],
      3,
    ),
  );
  assert.equal(edgesGeometry(cube(1), 0).length / 2, 18, 'threshold 0: every welded edge once');
});
