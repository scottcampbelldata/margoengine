// Built-in primitives from first principles: closed solids have no boundary edges and face outward, normals are unit,
// areas and volumes match the analytic shapes, UVs follow the documented conventions, and the recorded metrics hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  boxGeometry,
  planeGeometry,
  circleGeometry,
  ringGeometry,
  cylinderGeometry,
  coneGeometry,
  sphereGeometry,
  capsuleGeometry,
  torusGeometry,
  torusKnotGeometry,
  latheGeometry,
  tubeGeometry,
  polyhedronGeometry,
  tetrahedronGeometry,
  octahedronGeometry,
  icosahedronGeometry,
  dodecahedronGeometry,
  LineCurve3,
} from '../dist/index.js';
import * as primitivesEntry from '../dist/primitives.js';
import {
  assertNormalsAgreeWithWinding,
  assertValid,
  close,
  cross,
  dot,
  length,
  point,
  signedVolume,
  surfaceArea,
  vertexCount,
  watertight,
} from './support/mesh-checks.js';

const minus = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const normal = (d, i) => [d.normals[i * 3], d.normals[i * 3 + 1], d.normals[i * 3 + 2]];
const uv = (d, i) => [d.uvs[i * 2], d.uvs[i * 2 + 1]];
const finite = (d, label) => {
  for (const key of ['positions', 'normals', 'uvs'])
    for (const x of d[key]) assert.ok(Number.isFinite(x), `${label} finite ${key}`);
  for (const i of d.indices) assert.ok(i < vertexCount(d), `${label} index in range`);
};
const degenerate = (d) => {
  let n = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const a = point(d, d.indices[t]);
    if (length(cross(minus(point(d, d.indices[t + 1]), a), minus(point(d, d.indices[t + 2]), a))) < 1e-12) n++;
  }
  return n;
};
/** Every triangle of a solid that is star-shaped around the origin turns counter-clockwise seen from outside. */
const assertOutwardTriangles = (d, label) => {
  for (let t = 0; t < d.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => point(d, d.indices[t + k])),
      n = cross(minus(b, a), minus(c, a));
    if (length(n) < 1e-12) continue;
    const centroid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    assert.ok(dot(n, centroid) > 0, `${label}: triangle ${t / 3} is clockwise from outside`);
  }
};
const findVertex = (d, p, n, label) => {
  for (let i = 0; i < vertexCount(d); i++)
    if (length(minus(point(d, i), p)) < 1e-5 && (!n || length(minus(normal(d, i), n)) < 1e-5)) return i;
  assert.fail(`${label}: no vertex at ${p}${n ? ` with normal ${n}` : ''}`);
};

// Recorded metrics (vectors measured from the previous implementation; layout-free): name, function, arguments,
// vertex count, index count (null where the layout is a free choice), area, signed volume, [count, materialIndex] per
// group. The torus knot and tube are left out: their ring rotation (frame) is a free choice that moves area and volume.
const RECORDED = [
  [
    'box defaults',
    boxGeometry,
    [],
    24,
    36,
    6,
    1,
    [
      [6, 0],
      [6, 1],
      [6, 2],
      [6, 3],
      [6, 4],
      [6, 5],
    ],
  ],
  [
    'box',
    boxGeometry,
    [1, 2, 3, 2, 1, 3],
    52,
    132,
    22,
    6,
    [
      [18, 0],
      [18, 1],
      [36, 2],
      [36, 3],
      [12, 4],
      [12, 5],
    ],
  ],
  [
    'box segmented',
    boxGeometry,
    [2, 1, 1.5, 3, 2, 4],
    94,
    312,
    13,
    3,
    [
      [48, 0],
      [48, 1],
      [72, 2],
      [72, 3],
      [36, 4],
      [36, 5],
    ],
  ],
  [
    'box fractional segments',
    boxGeometry,
    [1, 1, 1, 2.7, 0.2, -3],
    32,
    60,
    6,
    1,
    [
      [6, 0],
      [6, 1],
      [12, 2],
      [12, 3],
      [12, 4],
      [12, 5],
    ],
  ],
  ['plane defaults', planeGeometry, [], 4, 6, 1, 0, []],
  ['plane', planeGeometry, [2, 3, 2, 3], 12, 36, 6, 0, []],
  ['circle defaults', circleGeometry, [], 34, 96, 3.121445, 0, []],
  ['circle', circleGeometry, [1.5, 7, 0.3, 4], 9, 21, 4.259069, 0, []],
  ['circle clamp', circleGeometry, [1, 1], 5, 9, 1.299038, 0, []],
  ['circle zero radius', circleGeometry, [0], 34, 96, 0, 0, []],
  ['ring defaults', ringGeometry, [], 66, 192, 2.341084, 0, []],
  ['ring', ringGeometry, [0.3, 1.2, 7, 2, 0.2, 5], 24, 84, 3.095243, 0, []],
  ['ring zero', ringGeometry, [0, 0], 66, 192, 0, 0, []],
  [
    'cylinder defaults',
    cylinderGeometry,
    [],
    196,
    384,
    12.515987,
    3.121445,
    [
      [192, 0],
      [96, 1],
      [96, 2],
    ],
  ],
  [
    'cylinder',
    cylinderGeometry,
    [0.5, 1, 2, 7, 2, false, 0.1, 5],
    54,
    126,
    10.406236,
    2.674901,
    [
      [84, 0],
      [21, 1],
      [21, 2],
    ],
  ],
  [
    'cylinder closed',
    cylinderGeometry,
    [1, 1, 2, 32, 3],
    262,
    768,
    18.789084,
    6.24289,
    [
      [576, 0],
      [96, 1],
      [96, 2],
    ],
  ],
  ['cylinder open', cylinderGeometry, [1, 1, 1, 16, 3, true], 68, 288, 6.24289, 2.040978, [[288, 0]]],
  [
    'cylinder half',
    cylinderGeometry,
    [1, 1, 1, 8, 1, false, 0, 3.141592653589793],
    52,
    96,
    6.182912,
    1.530734,
    [
      [48, 0],
      [24, 1],
      [24, 2],
    ],
  ],
  [
    'cylinder zero height',
    cylinderGeometry,
    [1, 1, 0],
    196,
    384,
    6.24289,
    0,
    [
      [192, 0],
      [96, 1],
      [96, 2],
    ],
  ],
  ['cone zero height open', cylinderGeometry, [0, 1, 0, 8, 1, true], 18, 24, 2.828427, 0, [[24, 0]]],
  [
    'cone defaults',
    coneGeometry,
    [],
    131,
    192,
    7.546528,
    1.040482,
    [
      [96, 0],
      [96, 2],
    ],
  ],
  [
    'cone',
    coneGeometry,
    [1, 2, 6, 2],
    34,
    72,
    9.136425,
    1.732051,
    [
      [54, 0],
      [18, 2],
    ],
  ],
  [
    'cone closed',
    coneGeometry,
    [1, 3, 32, 2],
    164,
    384,
    13.035316,
    3.121445,
    [
      [288, 0],
      [96, 2],
    ],
  ],
  ['sphere defaults', sphereGeometry, [], 561, 2880, 12.465694, 4.121942, []],
  ['sphere', sphereGeometry, [1, 8, 6], 63, 240, 11.525754, 3.518611, []],
  ['sphere fine', sphereGeometry, [1.5, 24, 12], 325, 1584, 27.872417, 13.738114, []],
  ['sphere partial', sphereGeometry, [1.2, 7, 5, 0.1, 5, 0.2, 2.5], 48, 210, 12.625303, 4.67192, []],
  [
    'sphere top cap',
    sphereGeometry,
    [1, 12, 6, 0, 6.283185307179586, 0, 1.5707963267948966],
    91,
    396,
    6.088642,
    1.965926,
    [],
  ],
  ['sphere band', sphereGeometry, [1, 12, 6, 0, 3.141592653589793, 0.3, 1], 91, 432, 2.139657, 0.707168, []],
  ['sphere clamp', sphereGeometry, [1, 1, 1], 12, 18, 5.809475, 0.866025, []],
  ['capsule defaults', capsuleGeometry, [], null, null, 17.829439, 6.456129, []],
  ['capsule', capsuleGeometry, [0.5, 1, 3, 6, 2], null, null, 5.768811, 1.053525, []],
  ['capsule fine', capsuleGeometry, [0.5, 1, 16, 64, 2], null, null, 6.27562, 1.305637, []],
  ['capsule zero', capsuleGeometry, [0, 0], null, null, 0, 0, []],
  ['capsule negative height', capsuleGeometry, [1, -2, 2, 6], null, null, 10.574491, 2.956796, []],
  ['torus defaults', torusGeometry, [], 637, 3456, 15.583757, 3.007323, []],
  ['torus', torusGeometry, [1, 0.3, 5, 9, 5], 60, 270, 8.537923, 1.015744, []],
  ['torus closed', torusGeometry, [1, 0.3, 16, 48], 833, 4608, 11.746586, 1.726279, []],
  ['torus knot zero', torusKnotGeometry, [0], 585, 3072, 0, 0, []],
  ['lathe defaults', latheGeometry, [], 39, 144, 2.159061, 0.25, []],
  [
    'lathe',
    latheGeometry,
    [
      [
        [0.2, -1],
        [1, -0.5],
        [0.8, 0.5],
        [0.3, 1],
      ],
      7,
      0.2,
      5,
    ],
    32,
    126,
    8.97187,
    2.60994,
    [],
  ],
  [
    'lathe phi clamp',
    latheGeometry,
    [
      [
        [0, -1],
        [1, 0],
        [0, 1],
      ],
      8,
      0,
      10,
    ],
    27,
    96,
    8.336086,
    1.885618,
    [],
  ],
  ['plane segments 0', planeGeometry, [1, 1, 0], 4, 6, 1, 0, []],
  ['plane segments -2', planeGeometry, [1, 1, -2], 4, 6, 1, 0, []],
  ['plane segments 0.5', planeGeometry, [1, 1, 0.5], 4, 6, 1, 0, []],
  ['tetrahedron r1 d0 default', tetrahedronGeometry, [1, 0, undefined], 12, 12, 4.618802, 0.5132, []],
  ['tetrahedron r1 d1 default', tetrahedronGeometry, [1, 1, undefined], 48, 48, 8.450238, 1.821367, []],
  ['tetrahedron r1.5 d2 default', tetrahedronGeometry, [1.5, 2, undefined], 108, 108, 23.456722, 9.919927, []],
  ['tetrahedron r1 d3 default', tetrahedronGeometry, [1, 3, undefined], 192, 192, 11.059198, 3.28996, []],
  ['tetrahedron r1 d0 true', tetrahedronGeometry, [1, 0, true], 12, 12, 4.618802, 0.5132, []],
  ['tetrahedron r1 d2 false', tetrahedronGeometry, [1, 2, false], 108, 108, 10.42521, 2.939238, []],
  ['octahedron r1 d0 default', octahedronGeometry, [1, 0, undefined], 24, 24, 6.928203, 1.333333, []],
  ['octahedron r1 d1 default', octahedronGeometry, [1, 1, undefined], 96, 96, 10.417751, 2.942809, []],
  ['octahedron r1.5 d2 default', octahedronGeometry, [1.5, 2, undefined], 216, 216, 25.921205, 12.053075, []],
  ['octahedron r1 d3 default', octahedronGeometry, [1, 3, undefined], 384, 384, 11.946654, 3.819487, []],
  ['octahedron r1 d0 true', octahedronGeometry, [1, 0, true], 24, 24, 6.928203, 1.333333, []],
  ['octahedron r1 d2 false', octahedronGeometry, [1, 2, false], 216, 216, 11.520535, 3.571281, []],
  ['icosahedron r1 d0 default', icosahedronGeometry, [1, 0, undefined], 60, 60, 9.574541, 2.53615, []],
  ['icosahedron r1 d1 default', icosahedronGeometry, [1, 1, undefined], 240, 240, 11.665931, 3.658712, []],
  ['icosahedron r1.5 d2 default', icosahedronGeometry, [1.5, 2, undefined], 540, 540, 27.338946, 13.302198, []],
  ['icosahedron r1 d3 default', icosahedronGeometry, [1, 3, undefined], 960, 960, 12.329063, 4.047005, []],
  ['icosahedron r1 d0 true', icosahedronGeometry, [1, 0, true], 60, 60, 9.574541, 2.53615, []],
  ['icosahedron r1 d2 false', icosahedronGeometry, [1, 2, false], 540, 540, 12.150642, 3.941392, []],
  ['dodecahedron r1 d0 default', dodecahedronGeometry, [1, 0, undefined], 108, 108, 10.514622, 2.785164, []],
  ['dodecahedron r1 d1 default', dodecahedronGeometry, [1, 1, undefined], 432, 432, 11.989221, 3.774066, []],
  ['dodecahedron r1.5 d2 default', dodecahedronGeometry, [1.5, 2, undefined], 972, 972, 27.677013, 13.486878, []],
  ['dodecahedron r1 d3 default', dodecahedronGeometry, [1, 3, undefined], 1728, 1728, 12.41522, 4.078689, []],
  ['dodecahedron r1 d0 true', dodecahedronGeometry, [1, 0, true], 108, 108, 10.514622, 2.785164, []],
  ['dodecahedron r1 d2 false', dodecahedronGeometry, [1, 2, false], 972, 972, 12.300895, 3.996112, []],
];

test('recorded counts, areas, volumes and groups hold', () => {
  for (const [name, fn, args, vertices, indices, area, volume, groups] of RECORDED) {
    const g = fn(...args),
      tol = (x) => 1e-5 * Math.max(1, Math.abs(x));
    if (vertices !== null) assert.equal(vertexCount(g), vertices, `${name} vertices`);
    if (indices !== null) assert.equal(g.indices.length, indices, `${name} indices`);
    close(surfaceArea(g), area, tol(area), `${name} area`);
    close(signedVolume(g), volume, tol(volume), `${name} volume`);
    assert.deepEqual(
      (g.groups ?? []).map((x) => [x.count, x.materialIndex]),
      groups,
      `${name} groups`,
    );
    let start = 0;
    for (const x of g.groups ?? []) {
      assert.equal(x.start, start, `${name} group start`);
      start += x.count;
    }
  }
});

test('segment counts reject non-finite values and floor then clamp finite ones', () => {
  const makers = [
    (n) => boxGeometry(1, 1, 1, n, n, n),
    (n) => planeGeometry(1, 1, n, n),
    (n) => circleGeometry(1, n),
    (n) => ringGeometry(0.5, 1, n, n),
    (n) => cylinderGeometry(1, 1, 1, n, n),
    (n) => coneGeometry(1, 1, n, n),
    (n) => sphereGeometry(1, n, n),
    (n) => capsuleGeometry(1, 1, n, n, n),
    (n) => torusGeometry(1, 0.4, n, n),
    (n) => torusKnotGeometry(1, 0.4, n, n),
    (n) => latheGeometry(undefined, n),
    (n) => tubeGeometry(new LineCurve3([0, 0, 0], [0, 1, 0]), n, 0.1, n),
  ];
  for (const make of makers) {
    for (const bad of [NaN, Infinity, -Infinity]) assert.throws(() => make(bad), RangeError);
    const least = make(1);
    for (const n of [0, -2, 0.5]) assert.deepEqual(make(n), least);
    assert.deepEqual(make(4.9), make(4));
  }
  assert.equal(vertexCount(circleGeometry(1, 0)), 5, 'circle minimum is 3 segments');
  assert.equal(vertexCount(sphereGeometry(1, 0, 0)), 4 * 3, 'sphere minimum is 3 x 2');
  for (const bad of [NaN, Infinity]) assert.throws(() => icosahedronGeometry(1, bad, false), RangeError);
  for (const n of [-1, -2, 0.5]) assert.deepEqual(icosahedronGeometry(1, n, false), icosahedronGeometry(1, 0, false));
  assert.deepEqual(icosahedronGeometry(1, 2.7), icosahedronGeometry(1, 2), 'detail is floored');
});

test('cylinder and cone counts: side grid, one centre per cap segment, a single triangle per apex quad', () => {
  for (const [rs, hs] of [
    [8, 1],
    [5, 3],
  ]) {
    const side = (rs + 1) * (hs + 1),
      cap = 2 * rs + 1,
      closed = cylinderGeometry(1, 0.5, 2, rs, hs);
    assert.equal(vertexCount(closed), side + 2 * cap);
    assert.equal(closed.indices.length, 6 * rs * hs + 2 * 3 * rs);
    assert.deepEqual(
      closed.groups.map((g) => g.materialIndex),
      [0, 1, 2],
    );
    const open = cylinderGeometry(1, 1, 1, rs, hs, true);
    assert.equal(vertexCount(open), side);
    assert.deepEqual(
      open.groups.map((g) => g.materialIndex),
      [0],
    );
    const cone = coneGeometry(1, 2, rs, hs);
    assert.equal(vertexCount(cone), side + cap);
    assert.equal(cone.indices.length, 6 * rs * hs - 3 * rs + 3 * rs);
    assert.deepEqual(
      cone.groups.map((g) => g.materialIndex),
      [0, 2],
    );
    assert.equal(degenerate(cone), 0, 'no slivers at the apex');
    assert.deepEqual(cone, cylinderGeometry(0, 1, 2, rs, hs));
  }
});

test('sphere and capsule counts: one triangle per pole quad, both on partial bands', () => {
  const full = sphereGeometry(1, 10, 6);
  assert.equal(vertexCount(full), 11 * 7);
  assert.equal(full.indices.length, 6 * 10 * 6 - 6 * 10);
  assert.equal(degenerate(full), 0);
  assert.equal(sphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).indices.length, 6 * 60 - 3 * 10);
  assert.equal(sphereGeometry(1, 10, 6, 0, Math.PI * 2, 0.4, Math.PI).indices.length, 6 * 60 - 3 * 10);
  assert.equal(sphereGeometry(1, 10, 6, 0, Math.PI * 2, 0.4, 1).indices.length, 6 * 60);
  for (const [cs, rs, hs] of [
    [4, 8, 1],
    [3, 6, 2],
  ]) {
    const g = capsuleGeometry(0.5, 1, cs, rs, hs),
      rows = 2 * cs + hs;
    assert.equal(vertexCount(g), (rows + 1) * (rs + 1));
    assert.equal(g.indices.length, 6 * rows * rs - 6 * rs);
    assert.equal(degenerate(g), 0);
  }
});

// Centre line length of the (2, 3) knot on a torus of major radius R, for the tube's 2 pi t L area and pi t^2 L volume.
const knotLength = (R) => {
  let L = 0,
    prev = null;
  for (let i = 0; i <= 20000; i++) {
    const s = (i / 20000) * 4 * Math.PI,
      w = 1.5 * s,
      c = [(R / 2) * (2 + Math.cos(w)) * Math.cos(s), (R / 2) * (2 + Math.cos(w)) * Math.sin(s), (R / 2) * Math.sin(w)];
    if (prev) L += length(minus(c, prev));
    prev = c;
  }
  return L;
};

const solids = () => {
  const r = 0.8,
    L = knotLength(1),
    icosaEdge = r / Math.sin((2 * Math.PI) / 5),
    dodecaEdge = (4 * r) / (Math.sqrt(3) * (1 + Math.sqrt(5))),
    tetraEdge = r * Math.sqrt(8 / 3),
    unitCircle = Array.from({ length: 65 }, (_, i) => [Math.sin((i / 64) * Math.PI), -Math.cos((i / 64) * Math.PI)]);
  // name, mesh, analytic area, analytic volume, relative tolerance, star-shaped around the origin, Euler characteristic
  return [
    ['box', boxGeometry(1, 2, 3, 2, 3, 4), 22, 6, 1e-6, true, 2],
    ['sphere', sphereGeometry(r, 128, 64), 4 * Math.PI * r * r, (4 / 3) * Math.PI * r ** 3, 2e-3, true, 2],
    [
      'cylinder',
      cylinderGeometry(r, r, 2, 256, 3),
      2 * Math.PI * r * 2 + 2 * Math.PI * r * r,
      Math.PI * r * r * 2,
      2e-4,
      true,
      2,
    ],
    [
      'frustum',
      cylinderGeometry(0.4, r, 1, 256),
      Math.PI * (0.4 + r) * Math.hypot(r - 0.4, 1) + Math.PI * (0.16 + r * r),
      (Math.PI / 3) * (0.16 + 0.4 * r + r * r),
      2e-4,
      true,
      2,
    ],
    [
      'cone',
      coneGeometry(r, 1.5, 256, 2),
      Math.PI * r * Math.hypot(r, 1.5) + Math.PI * r * r,
      (Math.PI / 3) * r * r * 1.5,
      2e-4,
      true,
      2,
    ],
    [
      'capsule',
      capsuleGeometry(r, 1, 32, 128, 2),
      2 * Math.PI * r + 4 * Math.PI * r * r,
      Math.PI * r * r + (4 / 3) * Math.PI * r ** 3,
      2e-3,
      true,
      2,
    ],
    ['torus', torusGeometry(1, 0.3, 64, 256), 4 * Math.PI ** 2 * 0.3, 2 * Math.PI ** 2 * 0.09, 2e-3, false, 0],
    ['torus knot', torusKnotGeometry(1, 0.1, 1024, 96), 2 * Math.PI * 0.1 * L, Math.PI * 0.01 * L, 2e-3, false, 0],
    ['lathe', latheGeometry(unitCircle, 128), 4 * Math.PI, (4 / 3) * Math.PI, 2e-3, true, 2],
    [
      'tetrahedron',
      tetrahedronGeometry(r),
      Math.sqrt(3) * tetraEdge ** 2,
      tetraEdge ** 3 / (6 * Math.SQRT2),
      1e-6,
      true,
      2,
    ],
    ['octahedron', octahedronGeometry(r), 4 * Math.sqrt(3) * r * r, (4 / 3) * r ** 3, 1e-6, true, 2],
    [
      'icosahedron',
      icosahedronGeometry(r),
      5 * Math.sqrt(3) * icosaEdge ** 2,
      (5 / 12) * (3 + Math.sqrt(5)) * icosaEdge ** 3,
      1e-6,
      true,
      2,
    ],
    [
      'dodecahedron',
      dodecahedronGeometry(r),
      3 * Math.sqrt(25 + 10 * Math.sqrt(5)) * dodecaEdge ** 2,
      ((15 + 7 * Math.sqrt(5)) / 4) * dodecaEdge ** 3,
      1e-6,
      true,
      2,
    ],
    ['geodesic', icosahedronGeometry(r, 16), 4 * Math.PI * r * r, (4 / 3) * Math.PI * r ** 3, 2e-3, true, 2],
  ];
};

test('closed primitives have no boundary edges, face outward and match the analytic area and volume', () => {
  for (const [name, g, area, volume, rel, star, euler] of solids()) {
    assertValid(g, name);
    assert.equal(watertight(g, name).euler, euler, `${name} Euler characteristic`);
    assertNormalsAgreeWithWinding(g, name);
    if (star) assertOutwardTriangles(g, name);
    close(surfaceArea(g), area, area * rel, `${name} area`);
    close(signedVolume(g), volume, volume * rel, `${name} volume`);
  }
});

test('flat primitives face +z, wind counter-clockwise and cover the analytic area', () => {
  const flat = [
    ['plane', planeGeometry(2, 3, 4, 5), 6],
    ['circle', circleGeometry(1.5, 512), Math.PI * 2.25],
    ['sector', circleGeometry(1, 512, 0.3, 2), 1],
    ['ring', ringGeometry(0.3, 1.2, 512, 3), Math.PI * (1.44 - 0.09)],
  ];
  for (const [name, g, area] of flat) {
    assertValid(g, name);
    assertNormalsAgreeWithWinding(g, name);
    for (let i = 0; i < vertexCount(g); i++) {
      assert.deepEqual(normal(g, i), [0, 0, 1], `${name} normal`);
      assert.equal(g.positions[i * 3 + 2], 0, `${name} z`);
    }
    close(surfaceArea(g), area, area * 1e-4, `${name} area`);
    for (let t = 0; t < g.indices.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => point(g, g.indices[t + k]));
      assert.ok(cross(minus(b, a), minus(c, a))[2] >= 0, `${name} counter-clockwise`);
    }
    assert.equal(g.groups, undefined);
  }
});

test('box faces map UVs upright and unmirrored seen from outside', () => {
  const g = boxGeometry(2, 4, 6),
    // face normal, a vertex on it, expected uv: u grows to the viewer's right, v grows up (-z on top, +z underneath).
    cases = [
      [
        [1, 0, 0],
        [1, 2, 3],
        [0, 1],
      ],
      [
        [1, 0, 0],
        [1, -2, -3],
        [1, 0],
      ],
      [
        [-1, 0, 0],
        [-1, 2, 3],
        [1, 1],
      ],
      [
        [0, 1, 0],
        [-1, 2, -3],
        [0, 1],
      ],
      [
        [0, 1, 0],
        [1, 2, 3],
        [1, 0],
      ],
      [
        [0, -1, 0],
        [-1, -2, -3],
        [0, 0],
      ],
      [
        [0, -1, 0],
        [1, -2, 3],
        [1, 1],
      ],
      [
        [0, 0, 1],
        [1, 2, 3],
        [1, 1],
      ],
      [
        [0, 0, -1],
        [1, 2, -3],
        [0, 1],
      ],
      [
        [0, 0, -1],
        [-1, -2, -3],
        [1, 0],
      ],
    ];
  for (const [n, p, expected] of cases) assert.deepEqual(uv(g, findVertex(g, p, n, 'box')), expected, `box ${n} ${p}`);
  for (const x of g.groups)
    for (let k = x.start; k < x.start + x.count; k++) {
      const v = g.indices[k],
        axis = [0, 0, 1, 1, 2, 2][x.materialIndex];
      assert.equal(g.normals[v * 3 + axis], x.materialIndex % 2 ? -1 : 1, 'each group holds its own face');
    }
});

test('plane, circle and ring UVs are planar maps', () => {
  const p = planeGeometry(4, 2, 3, 2);
  for (let i = 0; i < vertexCount(p); i++) {
    close(p.uvs[i * 2], p.positions[i * 3] / 4 + 0.5, 1e-6);
    close(p.uvs[i * 2 + 1], p.positions[i * 3 + 1] / 2 + 0.5, 1e-6);
  }
  assert.deepEqual(uv(p, findVertex(p, [-2, 1, 0], null, 'plane')), [0, 1]);
  for (const [g, r] of [
    [circleGeometry(2, 9, 0.5, 3), 2],
    [ringGeometry(0.5, 3, 12, 2), 3],
  ])
    for (let i = 0; i < vertexCount(g); i++) {
      close(g.uvs[i * 2], 0.5 + g.positions[i * 3] / (2 * r), 1e-6);
      close(g.uvs[i * 2 + 1], 0.5 + g.positions[i * 3 + 1] / (2 * r), 1e-6);
    }
  const sector = circleGeometry(1, 4, 0, Math.PI / 2);
  findVertex(sector, [1, 0, 0], null, 'sector starts on +x');
  findVertex(sector, [0, 1, 0], null, 'sector turns toward +y');
});

test('cylinder side: angle from +z toward +x, u from thetaStart, v = 1 on top, slanted unit normals', () => {
  const g = cylinderGeometry(0.5, 1, 2, 4, 1, true);
  assert.deepEqual(uv(g, findVertex(g, [0, 1, 0.5], null, 'top start')), [0, 1]);
  assert.deepEqual(uv(g, findVertex(g, [1, -1, 0], null, 'bottom quarter')), [0.25, 0]);
  const slope = Math.hypot(2, 0.5);
  for (let i = 0; i < vertexCount(g); i++) {
    const p = point(g, i),
      n = normal(g, i);
    close(n[1], 0.5 / slope, 1e-6, 'tilt follows the slope');
    close(n[0] * p[2] - n[2] * p[0], 0, 1e-6, 'normal in the radial plane');
    close(Math.hypot(n[0], n[2]), 2 / slope, 1e-6);
    assert.ok(n[0] * p[0] + n[2] * p[2] > 0, 'points away from the axis');
  }
  const caps = cylinderGeometry(1, 1, 1, 6);
  for (const x of caps.groups.slice(1))
    for (let k = x.start; k < x.start + x.count; k++) {
      const v = caps.indices[k];
      assert.equal(caps.normals[v * 3 + 1], x.materialIndex === 1 ? 1 : -1);
      const [u, w] = uv(caps, v);
      close(Math.hypot(u - 0.5, w - 0.5), Math.hypot(caps.positions[v * 3], caps.positions[v * 3 + 2]) / 2, 1e-6);
    }
});

test('sphere follows its parameterization, with v = 1 at the top', () => {
  const g = sphereGeometry(2, 8, 4);
  for (const [p, u] of [
    [[-2, 0, 0], 0],
    [[0, 0, 2], 0.25],
    [[2, 0, 0], 0.5],
    [[0, 0, -2], 0.75],
    [[-2, 0, 0], 1],
  ])
    assert.ok(
      Array.from({ length: vertexCount(g) }, (_, i) => i).some(
        (i) => length(minus(point(g, i), p)) < 1e-5 && Math.abs(g.uvs[i * 2] - u) < 1e-6 && g.uvs[i * 2 + 1] === 0.5,
      ),
      `sphere u ${u} at ${p}`,
    );
  for (let i = 0; i < vertexCount(g); i++) {
    const y = g.positions[i * 3 + 1] / 2;
    close(g.uvs[i * 2 + 1], 1 - Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI, 1e-6, 'v from height');
    for (let k = 0; k < 3; k++) close(g.normals[i * 3 + k], g.positions[i * 3 + k] / 2, 1e-6, 'radial normal');
  }
  const top = sphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  for (let i = 0; i < vertexCount(top); i++) assert.ok(top.positions[i * 3 + 1] >= -1e-6, 'top hemisphere');
});

test('capsule v follows arc length from the bottom pole; normals are radial from each hemisphere centre', () => {
  const r = 0.5,
    h = 1,
    g = capsuleGeometry(r, h, 6, 12, 3),
    total = Math.PI * r + h;
  for (let i = 0; i < vertexCount(g); i++) {
    const [x, y, z] = point(g, i),
      n = normal(g, i),
      centre = Math.max(-h / 2, Math.min(h / 2, y)),
      offset = [x, y - centre, z];
    close(length(offset), r, 1e-6, 'on the capsule');
    for (let k = 0; k < 3; k++) close(n[k], offset[k] / r, 1e-6, 'radial normal');
    const arc =
      y < -h / 2
        ? r * Math.acos(Math.min(1, -(y + h / 2) / r))
        : y > h / 2
          ? (Math.PI / 2) * r + h + r * Math.asin(Math.min(1, (y - h / 2) / r))
          : (Math.PI / 2) * r + y + h / 2;
    close(g.uvs[i * 2 + 1], arc / total, 1e-5, 'v is arc length');
  }
  close(Math.max(...g.positions.filter((_, i) => i % 3 === 1)), h / 2 + r, 1e-7);
  assert.deepEqual(capsuleGeometry(1, -2, 2, 6), capsuleGeometry(1, 0, 2, 6), 'negative height counts as 0');
});

test('torus and torus knot follow their centre lines', () => {
  const t = torusGeometry(2, 0.5, 6, 12, Math.PI);
  for (let i = 0; i < vertexCount(t); i++) {
    const [x, y, z] = point(t, i),
      ring = Math.hypot(x, y),
      centre = [(2 * x) / ring, (2 * y) / ring, 0];
    close(Math.hypot(ring - 2, z), 0.5, 1e-6, 'on the tube');
    for (let k = 0; k < 3; k++) close(t.normals[i * 3 + k], (point(t, i)[k] - centre[k]) / 0.5, 1e-5, 'torus normal');
    assert.ok(y >= -1e-6, 'half arc from +x toward +y');
  }
  const R = 1.4,
    tube = 0.25,
    along = 40,
    around = 7,
    k = torusKnotGeometry(R, tube, along, around, 3, 2),
    curve = (s) => {
      const w = (2 / 3) * s;
      return [
        (R / 2) * (2 + Math.cos(w)) * Math.cos(s),
        (R / 2) * (2 + Math.cos(w)) * Math.sin(s),
        (R / 2) * Math.sin(w),
      ];
    };
  for (let i = 0; i <= along; i++) {
    const s = (i / along) * 3 * 2 * Math.PI,
      c = curve(s),
      tangent = minus(curve(s + 1e-6), c),
      ring = [];
    for (let j = 0; j < vertexCount(k); j++) if (Math.abs(k.uvs[j * 2] - i / along) < 1e-6) ring.push(j);
    assert.equal(ring.length, around + 1);
    for (const j of ring) {
      const d = minus(point(k, j), c);
      close(length(d), tube, 1e-5, 'ring radius');
      close(dot(d, tangent) / length(tangent), 0, 1e-4, 'ring perpendicular to the curve');
      for (let q = 0; q < 3; q++) close(k.normals[j * 3 + q], d[q] / tube, 1e-4, 'outward normal');
    }
  }
});

test('lathe sweeps from +z toward +x with unit normals from the profile', () => {
  const g = latheGeometry(
    [
      [1, 0],
      [1, 1],
      [0.5, 2],
    ],
    4,
  );
  assert.deepEqual(uv(g, findVertex(g, [0, 0, 1], null, 'lathe start')), [0, 0]);
  assert.deepEqual(uv(g, findVertex(g, [1, 0, 0], null, 'lathe quarter')), [0.25, 0]);
  assert.deepEqual(uv(g, findVertex(g, [0, 2, 0.5], null, 'lathe top')), [0, 1]);
  const l = Math.hypot(1, 0.5);
  findVertex(g, [0, 0, 1], [0, 0, 1], 'first point takes the first segment normal');
  findVertex(g, [0, 2, 0.5], [0, 0.5 / l, 1 / l], 'last point takes the last segment normal');
  // The middle point: the length-weighted sum of its segments' normals (1, 0) and (1, 0.5).
  const m = Math.hypot(2, 0.5);
  findVertex(g, [0, 1, 1], [0, 0.5 / m, 2 / m], 'interior normal');
  for (let i = 0; i < vertexCount(g); i++) close(length(normal(g, i)), 1, 1e-6);
  assert.deepEqual(latheGeometry(undefined, 8, 0, 10), latheGeometry(undefined, 8, 0, 2 * Math.PI), 'clamped to 2 pi');
  assert.throws(
    () => latheGeometry([[1, 0]]),
    (e) => e instanceof RangeError && /pass at least two/.test(e.message),
  );
});

test('tube rings sit on the path at the given radius', () => {
  const g = tubeGeometry(new LineCurve3([0, 0, 0], [0, 2, 0]), 4, 0.3, 6);
  for (let i = 0; i < vertexCount(g); i++) {
    const [x, y, z] = point(g, i);
    close(Math.hypot(x, z), 0.3, 1e-6);
    close(y, g.uvs[i * 2] * 2, 1e-6, 'ring at the arc-length step');
    close(g.normals[i * 3 + 1], 0, 1e-6);
  }
  assert.ok(signedVolume(g) > 0, 'open tube wound outward');
});

test('polyhedra: outward whatever the table winding, geodesic subdivision on the sphere, flat or radial normals', () => {
  const octa = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1],
    faces = [0, 2, 4, 0, 4, 3, 0, 3, 5, 0, 5, 2, 1, 4, 2, 1, 3, 4, 1, 5, 3, 1, 2, 5],
    reversed = faces.map((_, i) => faces[i - (i % 3) + [0, 2, 1][i % 3]]);
  for (const detail of [0, 1, 3]) {
    const a = polyhedronGeometry(octa, faces, 1.2, detail),
      b = polyhedronGeometry(octa, reversed, 1.2, detail);
    for (const g of [a, b]) {
      assert.equal(vertexCount(g), 8 * (detail + 1) ** 2 * 3);
      assert.deepEqual(
        Array.from(g.indices),
        Array.from({ length: vertexCount(g) }, (_, i) => i),
      );
      // Splitting every edge into n = detail + 1 parts gives 8 n^2 faces on 4 n^2 + 2 distinct vertices.
      assert.equal(watertight(g, 'octahedron').V, 4 * (detail + 1) ** 2 + 2);
      assertOutwardTriangles(g, 'octahedron');
      assertNormalsAgreeWithWinding(g, 'octahedron');
      for (let i = 0; i < vertexCount(g); i++) close(length(point(g, i)), 1.2, 1e-6, 'on the sphere');
    }
    close(signedVolume(b), signedVolume(a), 1e-9);
  }
  assert.throws(
    () => tetrahedronGeometry(1, 0, 1),
    (e) => e instanceof TypeError && /smoothing/.test(e.message),
  );
  for (const fn of [tetrahedronGeometry, octahedronGeometry, icosahedronGeometry, dodecahedronGeometry]) {
    const v = fn(1, 2).uvs.filter((_, i) => i % 2 === 1);
    assert.ok(Math.min(...v) >= 0 && Math.max(...v) <= 1);
  }
});

test('polyhedron UVs are a spherical map with v = 1 at +y and continuous u inside each triangle', () => {
  const g = icosahedronGeometry(1, 3);
  for (let t = 0; t < vertexCount(g); t += 3) {
    const us = [0, 1, 2].map((k) => g.uvs[(t + k) * 2]);
    assert.ok(Math.max(...us) - Math.min(...us) < 0.3, `triangle ${t / 3} u spans ${us}`);
    for (let k = 0; k < 3; k++) {
      const [x, y, z] = point(g, t + k);
      if (Math.hypot(x, z) < 1e-6) continue; // a pole corner borrows its triangle's azimuth
      close(g.uvs[(t + k) * 2 + 1], 0.5 + Math.asin(Math.max(-1, Math.min(1, y))) / Math.PI, 1e-6);
      const raw = 0.5 + Math.atan2(z, -x) / (2 * Math.PI);
      close((((g.uvs[(t + k) * 2] - raw) % 1) + 1.5) % 1, 0.5, 1e-5, 'u is the azimuth up to a whole turn');
    }
  }
  const o = octahedronGeometry(1);
  for (let i = 0; i < vertexCount(o); i++) {
    const [x, , z] = point(o, i);
    if (Math.hypot(x, z) > 1e-9) continue;
    const t = i - (i % 3),
      others = [t, t + 1, t + 2].filter((j) => j !== i),
      mean = (o.uvs[others[0] * 2] + o.uvs[others[1] * 2]) / 2;
    assert.ok(Math.abs(o.uvs[i * 2] - mean) < 0.2, 'a pole corner takes its triangle azimuth');
  }
});

test('zero sizes stay finite', () => {
  for (const [name, g] of [
    ['circle 0', circleGeometry(0)],
    ['ring 0/0', ringGeometry(0, 0)],
    ['ring 0.5/0', ringGeometry(0.5, 0)],
    ['cylinder h0', cylinderGeometry(1, 1, 0)],
    ['cone h0', coneGeometry(1, 0)],
    ['capsule 0/0', capsuleGeometry(0, 0)],
    ['torus knot 0', torusKnotGeometry(0)],
    ['box 0', boxGeometry(0, 1, 1)],
    ['sphere 0', sphereGeometry(0)],
  ])
    finite(g, name);
  const flat = cylinderGeometry(0, 1, 0, 8, 1, true);
  for (let i = 0; i < vertexCount(flat); i++) assert.deepEqual(normal(flat, i), [0, 1, 0]);
  const down = cylinderGeometry(1, 0, 0, 8, 1, true);
  for (let i = 0; i < vertexCount(down); i++) assert.deepEqual(normal(down, i), [0, -1, 0]);
  const band = cylinderGeometry(1, 1, 0, 8, 1, true);
  for (let i = 0; i < vertexCount(band); i++)
    for (let k = 0; k < 3; k++) close(band.normals[i * 3 + k], band.positions[i * 3 + k], 1e-6, 'horizontal radial');
  const box = boxGeometry(0, 1, 1);
  for (let i = 0; i < vertexCount(box); i++) close(length(normal(box, i)), 1, 1e-6);
});

test('the primitives entry carries the polyhedra but not the extras', () => {
  for (const name of ['boxGeometry', 'tubeGeometry', 'icosahedronGeometry', 'polyhedronGeometry'])
    assert.equal(typeof primitivesEntry[name], 'function');
  assert.equal(primitivesEntry.roundedBoxGeometry, undefined);
  assert.equal(primitivesEntry.parametricGeometry, undefined);
});
