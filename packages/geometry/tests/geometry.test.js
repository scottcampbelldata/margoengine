import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { Geometry } from '@margoengine/core';
import * as G from '../dist/index.js';

const {
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
  tetrahedronGeometry,
  octahedronGeometry,
  icosahedronGeometry,
  dodecahedronGeometry,
  latheGeometry,
  shapeGeometry,
  extrudeGeometry,
  tubeGeometry,
  Shape,
  Path,
  LineCurve,
  LineCurve3,
  ArcCurve,
  EllipseCurve,
  QuadraticBezierCurve,
  QuadraticBezierCurve3,
  CubicBezierCurve,
  CubicBezierCurve3,
  CatmullRomCurve3,
  SplineCurve,
  triangulate,
  triangulateShape,
  shapeArea,
  isClockWise,
  mergeGeometries,
  mergeVertices,
  computeVertexNormals,
  computeTangents,
  toNonIndexed,
  applyMatrix4,
  center,
  computeBoundingBox,
  computeBoundingSphere,
  edgesGeometry,
  wireframe,
  loopSubdivide,
  toGeometry,
} = G;

// ---------- helpers ----------

const vcount = (d) => d.positions.length / 3;
const tris = (d) => d.indices.length / 3;
const P = (d, i) => [d.positions[i * 3], d.positions[i * 3 + 1], d.positions[i * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(...a);
const close = (a, b, tol, msg) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);

function surfaceArea(d) {
  let s = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const a = P(d, d.indices[t]),
      b = P(d, d.indices[t + 1]),
      c = P(d, d.indices[t + 2]);
    s += len(cross(sub(b, a), sub(c, a))) / 2;
  }
  return s;
}
function signedVolume(d) {
  let v = 0;
  for (let t = 0; t < d.indices.length; t += 3)
    v += dot(P(d, d.indices[t]), cross(P(d, d.indices[t + 1]), P(d, d.indices[t + 2]))) / 6;
  return v;
}
/** Welds by position (independent of the package's mergeVertices), drops collapsed triangles, then requires every
 * directed edge to appear once with its reverse appearing once: closed, manifold, consistently wound. */
function assertWatertight(d, label) {
  const keys = new Map(),
    id = [];
  for (let i = 0; i < vcount(d); i++) {
    const k = P(d, i)
      .map((x) => Math.round(x * 1e4))
      .join(',');
    if (!keys.has(k)) keys.set(k, keys.size);
    id.push(keys.get(k));
  }
  const directed = new Map();
  let kept = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const w = [id[d.indices[t]], id[d.indices[t + 1]], id[d.indices[t + 2]]];
    if (w[0] === w[1] || w[1] === w[2] || w[0] === w[2]) continue;
    kept++;
    for (let k = 0; k < 3; k++) {
      const e = `${w[k]}>${w[(k + 1) % 3]}`;
      directed.set(e, (directed.get(e) ?? 0) + 1);
    }
  }
  assert.ok(kept > 0, `${label}: no triangles`);
  for (const [e, n] of directed) {
    assert.equal(n, 1, `${label}: directed edge ${e} used ${n} times`);
    const [a, b] = e.split('>');
    assert.equal(directed.get(`${b}>${a}`), 1, `${label}: edge ${e} has no opposite (open or inconsistently wound)`);
  }
  const V = keys.size,
    E = directed.size / 2,
    F = kept;
  return { V, E, F, euler: V - E + F };
}
function assertUnitNormals(d, label, tol = 1e-5) {
  for (let i = 0; i < vcount(d); i++)
    close(Math.hypot(d.normals[i * 3], d.normals[i * 3 + 1], d.normals[i * 3 + 2]), 1, tol, `${label} normal ${i}`);
}
function assertUVRange(d, label, lo = 0, hi = 1) {
  assert.equal(d.uvs.length, vcount(d) * 2, `${label} uv length`);
  for (const u of d.uvs) assert.ok(u >= lo - 1e-6 && u <= hi + 1e-6, `${label} uv ${u} outside [${lo}, ${hi}]`);
}
function assertValid(d, label) {
  assert.ok(
    d.positions instanceof Float32Array &&
      d.normals instanceof Float32Array &&
      d.uvs instanceof Float32Array &&
      d.indices instanceof Uint32Array,
    `${label} types`,
  );
  assert.equal(d.normals.length, d.positions.length);
  assert.equal(d.indices.length % 3, 0);
  for (const i of d.indices) assert.ok(i < vcount(d), `${label} index in range`);
  for (const x of d.positions) assert.ok(Number.isFinite(x), `${label} finite positions`);
}
/** Normals point roughly the same way as the geometric face normal of the triangles that use them. */
function assertNormalsAgreeWithWinding(d, label) {
  let bad = 0,
    total = 0;
  for (let t = 0; t < d.indices.length; t += 3) {
    const [a, b, c] = [d.indices[t], d.indices[t + 1], d.indices[t + 2]],
      n = cross(sub(P(d, b), P(d, a)), sub(P(d, c), P(d, a)));
    if (len(n) < 1e-9) continue;
    for (const v of [a, b, c]) {
      total++;
      if (dot(n, [d.normals[v * 3], d.normals[v * 3 + 1], d.normals[v * 3 + 2]]) <= 0) bad++;
    }
  }
  assert.equal(bad, 0, `${label}: ${bad}/${total} corner normals oppose the winding`);
}
const square = (s, cx = 0, cy = 0) => [
  [cx - s, cy - s],
  [cx + s, cy - s],
  [cx + s, cy + s],
  [cx - s, cy + s],
];
const shapeFrom = (outer, holes = []) => {
  const sh = new Shape(outer);
  sh.holes = holes.map((h) => new Path(h));
  return sh;
};
const triArea2D = (pts, idx) => {
  let s = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = pts[idx[t]],
      b = pts[idx[t + 1]],
      c = pts[idx[t + 2]];
    s += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return s;
};

// ---------- vertex and index counts against the Three.js formulas ----------

test('box counts match Three.js for segmented boxes, with six groups', () => {
  for (const [w, h, d] of [
    [1, 1, 1],
    [2, 3, 4],
    [5, 1, 2],
  ]) {
    const g = boxGeometry(1, 2, 3, w, h, d);
    const faces = [
      [d, h],
      [d, h],
      [w, d],
      [w, d],
      [w, h],
      [w, h],
    ];
    assert.equal(
      vcount(g),
      faces.reduce((s, [a, b]) => s + (a + 1) * (b + 1), 0),
    );
    assert.equal(
      g.indices.length,
      faces.reduce((s, [a, b]) => s + a * b * 6, 0),
    );
    assert.deepEqual(
      g.groups.map((x) => x.materialIndex),
      [0, 1, 2, 3, 4, 5],
    );
    assert.equal(
      g.groups.reduce((s, x) => s + x.count, 0),
      g.indices.length,
    );
  }
});

test('plane, circle and ring counts match Three.js', () => {
  const p = planeGeometry(2, 3, 4, 5);
  assert.equal(vcount(p), 5 * 6);
  assert.equal(p.indices.length, 4 * 5 * 6);
  const c = circleGeometry(1, 24);
  assert.equal(vcount(c), 24 + 2);
  assert.equal(c.indices.length, 24 * 3);
  assert.equal(vcount(circleGeometry(1, 1)), 3 + 2, 'circle clamps to 3 segments');
  const r = ringGeometry(0.5, 1, 20, 3);
  assert.equal(vcount(r), 21 * 4);
  assert.equal(r.indices.length, 20 * 3 * 6);
});

test('cylinder and cone counts match Three.js including open ends and the cone apex', () => {
  const r = 16,
    h = 3,
    cyl = cylinderGeometry(1, 2, 3, r, h);
  assert.equal(vcount(cyl), (r + 1) * (h + 1) + 2 * (2 * r + 1));
  assert.equal(cyl.indices.length, r * h * 6 + 2 * r * 3);
  assert.deepEqual(
    cyl.groups.map((g) => g.materialIndex),
    [0, 1, 2],
  );
  const open = cylinderGeometry(1, 1, 1, r, h, true);
  assert.equal(vcount(open), (r + 1) * (h + 1));
  assert.equal(open.indices.length, r * h * 6);
  const cone = coneGeometry(1, 2, r, h);
  assert.equal(vcount(cone), (r + 1) * (h + 1) + 2 * r + 1);
  assert.equal(cone.indices.length, r * h * 6 - r * 3 + r * 3, 'apex row drops one triangle per quad, one cap');
  const partial = cylinderGeometry(1, 1, 1, 8, 1, false, 0, Math.PI);
  assert.equal(vcount(partial), 9 * 2 + 2 * 17);
});

test('sphere counts match Three.js, including partial theta ranges', () => {
  const full = sphereGeometry(1, 32, 16);
  assert.equal(vcount(full), 33 * 17);
  assert.equal(full.indices.length, 32 * 16 * 6 - 2 * 32 * 3, 'poles have one triangle per quad');
  const cap = sphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  assert.equal(cap.indices.length, 12 * 6 * 6 - 12 * 3, 'only the top pole collapses');
  const band = sphereGeometry(1, 12, 6, 0, Math.PI, 0.3, 1);
  assert.equal(band.indices.length, 12 * 6 * 6);
  assert.equal(vcount(sphereGeometry(1, 1, 1)), 4 * 3, 'clamps to 3 x 2 segments');
});

test('capsule, torus and torus knot counts match Three.js', () => {
  const cap = capsuleGeometry(0.5, 2, 5, 12, 3);
  assert.equal(vcount(cap), (2 * 5 + 3 + 1) * 13);
  assert.equal(cap.indices.length, (2 * 5 + 3) * 12 * 6);
  const t = torusGeometry(1, 0.3, 10, 30);
  assert.equal(vcount(t), 11 * 31);
  assert.equal(t.indices.length, 10 * 30 * 6);
  const k = torusKnotGeometry(1, 0.3, 80, 9, 3, 5);
  assert.equal(vcount(k), 81 * 10);
  assert.equal(k.indices.length, 80 * 9 * 6);
});

test('polyhedra counts follow faces * (detail + 1)^2 * 3 non-indexed vertices', () => {
  for (const [fn, faces] of [
    [tetrahedronGeometry, 4],
    [octahedronGeometry, 8],
    [icosahedronGeometry, 20],
    [dodecahedronGeometry, 36],
  ]) {
    for (const detail of [0, 1, 3]) {
      const g = fn(1, detail);
      assert.equal(vcount(g), faces * (detail + 1) ** 2 * 3, `${fn.name} detail ${detail}`);
      assert.equal(g.indices.length, vcount(g));
    }
  }
});

test('polyhedron LODs can share smooth normals while preserving default shading and geometry', () => {
  for (const fn of [tetrahedronGeometry, octahedronGeometry, icosahedronGeometry, dodecahedronGeometry]) {
    for (const detail of [0, 1]) {
      const original = fn(0.65, detail),
        smooth = fn(0.65, detail, true),
        flat = fn(0.65, detail, false);
      for (const key of ['positions', 'uvs', 'indices']) assert.deepEqual(smooth[key], original[key]);
      assert.deepEqual(original.normals, detail ? smooth.normals : flat.normals);
      assert.notDeepEqual(flat.normals, smooth.normals);
      for (let i = 0; i < smooth.positions.length; i += 3) {
        const length = Math.hypot(...smooth.positions.subarray(i, i + 3));
        close(length, 0.65, 1e-6);
        for (let k = 0; k < 3; k++) close(smooth.normals[i + k], smooth.positions[i + k] / length, 1e-6);
      }
      for (let i = 0; i < flat.normals.length; i += 9) {
        assert.deepEqual(flat.normals.slice(i, i + 3), flat.normals.slice(i + 3, i + 6));
        assert.deepEqual(flat.normals.slice(i, i + 3), flat.normals.slice(i + 6, i + 9));
      }
    }
    assert.throws(() => fn(1, 0, 'smooth'), /smoothing/);
  }
});

test('lathe and tube counts match Three.js', () => {
  const pts = Array.from({ length: 7 }, (_, i) => [Math.sin((i / 6) * Math.PI) + 0.1, i / 6 - 0.5]);
  const l = latheGeometry(pts, 20);
  assert.equal(vcount(l), 21 * 7);
  assert.equal(l.indices.length, 20 * 6 * 6);
  const curve = new CatmullRomCurve3([
    [0, 0, 0],
    [1, 1, 0],
    [2, 0, 1],
    [3, 1, 1],
  ]);
  const tube = tubeGeometry(curve, 40, 0.2, 6);
  assert.equal(vcount(tube), 41 * 7);
  assert.equal(tube.indices.length, 40 * 6 * 6);
});

test('shape and extrude counts match Three.js formulas', () => {
  const sh = shapeFrom(square(2), [square(0.5, -1, -1), square(0.5, 1, 1)]);
  const flat = shapeGeometry(sh);
  assert.equal(vcount(flat), 12);
  assert.equal(tris(flat), 12 - 2 + 2 * 2, 'n - 2 + 2h triangles');
  const n = 12,
    F = tris(flat);
  const plain = extrudeGeometry(sh, { bevelEnabled: false, steps: 3, depth: 2 });
  assert.equal(vcount(plain), 3 * (2 * F + 2 * n * 3));
  const bevel = extrudeGeometry(sh, { steps: 2, bevelSegments: 4 });
  assert.equal(vcount(bevel), 3 * (2 * F + 2 * n * (2 + 2 * 4)));
  assert.deepEqual(
    bevel.groups.map((g) => g.materialIndex),
    [0, 1],
  );
  assert.equal(bevel.groups[0].count, 2 * F * 3);
});

// ---------- exact agreement with a real Three.js build (tests/fixtures/three-reference.json) ----------

const reference = JSON.parse(await readFile(new URL('./fixtures/three-reference.json', import.meta.url), 'utf8'));
const refShape = () => {
  const s = new Shape([
      [-2, -1],
      [2, -1],
      [2, 1.5],
      [-2, 1.5],
    ]),
    h = new Path();
  h.absarc(-0.8, 0.2, 0.4, 0, Math.PI * 2, true);
  s.holes.push(
    h,
    new Path([
      [0.5, -0.5],
      [1.5, -0.5],
      [1.5, 0.5],
      [0.5, 0.5],
    ]),
  );
  return s;
};
const refPoints = [
  [0, 0, 0],
  [1, 2, 0],
  [1.2, 2.1, 0.3],
  [3, 1, 1],
  [4, 4, 2],
];
const assertArrayClose = (actual, expected, tol, label) => {
  assert.equal(actual.length, expected.length, `${label} length`);
  let worst = 0,
    at = -1;
  for (let i = 0; i < actual.length; i++) {
    const d = Math.abs(actual[i] - expected[i]);
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  assert.ok(worst <= tol, `${label}: max difference ${worst} at ${at}`);
};

test(`primitives match Three.js r${reference.three} vertex for vertex`, () => {
  const ours = {
    box: boxGeometry(1, 2, 3, 2, 1, 3),
    plane: planeGeometry(2, 3, 2, 3),
    circle: circleGeometry(1.5, 7, 0.3, 4),
    ring: ringGeometry(0.3, 1.2, 7, 2, 0.2, 5),
    cylinder: cylinderGeometry(0.5, 1, 2, 7, 2, false, 0.1, 5),
    cone: coneGeometry(1, 2, 6, 2),
    sphere: sphereGeometry(1, 8, 6),
    spherePartial: sphereGeometry(1.2, 7, 5, 0.1, 5, 0.2, 2.5),
    capsule: capsuleGeometry(0.5, 1, 3, 6, 2),
    torus: torusGeometry(1, 0.3, 5, 9, 5),
    torusKnot: torusKnotGeometry(1, 0.3, 12, 5, 2, 3),
    tetrahedron: tetrahedronGeometry(1, 1),
    octahedron: octahedronGeometry(1.5, 0),
    icosahedron: icosahedronGeometry(1, 1),
    dodecahedron: dodecahedronGeometry(1, 0),
    lathe: latheGeometry(
      [
        [0.2, -1],
        [1, -0.5],
        [0.8, 0.5],
        [0.3, 1],
      ],
      7,
      0.2,
      5,
    ),
    tube: tubeGeometry(new CatmullRomCurve3(refPoints), 10, 0.2, 5, false),
    shape: shapeGeometry(refShape(), 6),
    extrude: extrudeGeometry(refShape(), {
      curveSegments: 6,
      depth: 0.5,
      bevelSegments: 2,
      bevelThickness: 0.1,
      bevelSize: 0.05,
    }),
    extrudeFlat: extrudeGeometry(refShape(), { curveSegments: 6, depth: 0.7, steps: 2, bevelEnabled: false }),
  };
  assert.deepEqual(Object.keys(ours).sort(), Object.keys(reference.primitives).sort());
  for (const [name, g] of Object.entries(ours)) {
    const r = reference.primitives[name];
    assert.equal(vcount(g), r.vertices, `${name} vertex count`);
    assert.deepEqual([...g.indices], r.index ?? Array.from({ length: r.vertices }, (_, i) => i), `${name} indices`);
    assertArrayClose(g.positions, r.positions, 1e-5, `${name} positions`);
    assertArrayClose(g.uvs, r.uvs, 1e-5, `${name} uvs`);
    assert.deepEqual(
      (g.groups ?? []).map((x) => [x.start, x.count, x.materialIndex]),
      r.groups,
      `${name} groups`,
    );
    if (name === 'lathe') {
      // Three.js leaves the last profile normal unnormalized; directions must still agree.
      for (let i = 0; i < r.vertices; i++) {
        const a = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]],
          b = r.normals.slice(i * 3, i * 3 + 3);
        close(dot(a, b) / len(b), 1, 1e-4, `lathe normal ${i}`);
      }
    } else assertArrayClose(g.normals, r.normals, 1e-5, `${name} normals`);
  }
});

test(`curves and Frenet frames match Three.js r${reference.three}`, () => {
  const c = (closed, type) => new CatmullRomCurve3(refPoints, closed, type);
  const flat = (list) => list.flat();
  assertArrayClose(
    flat(c(false, 'centripetal').getPoints(12)),
    flat(reference.curves.centripetal),
    1e-5,
    'centripetal',
  );
  assertArrayClose(flat(c(false, 'chordal').getPoints(12)), flat(reference.curves.chordal), 1e-5, 'chordal');
  assertArrayClose(flat(c(false, 'catmullrom').getPoints(12)), flat(reference.curves.catmullrom), 1e-5, 'uniform');
  assertArrayClose(flat(c(true, 'centripetal').getPoints(12)), flat(reference.curves.closed), 1e-5, 'closed');
  assertArrayClose(flat(c(false, 'centripetal').getSpacedPoints(12)), flat(reference.curves.spaced), 1e-5, 'spaced');
  assertArrayClose(
    flat(new EllipseCurve(1, 2, 3, 1.5, 0.3, 4, true, 0.4).getPoints(10)),
    flat(reference.curves.ellipse),
    1e-5,
    'ellipse',
  );
  const path = new Path()
    .moveTo(0, 0)
    .lineTo(1, 0)
    .quadraticCurveTo(2, 0, 2, 1)
    .bezierCurveTo(2, 2, 1, 2, 0, 2)
    .splineThru([
      [-1, 1],
      [0, 0],
    ]);
  assertArrayClose(flat(path.getPoints(5)), flat(reference.curves.pathPoints), 1e-5, 'path');
  const f = c(false, 'centripetal').computeFrenetFrames(8, false);
  for (const k of ['tangents', 'normals', 'binormals'])
    assertArrayClose(flat(f[k]), flat(reference.curves.frames[k]), 1e-5, `frames ${k}`);
  const fc = c(true, 'centripetal').computeFrenetFrames(8, true);
  for (const k of ['normals', 'binormals'])
    assertArrayClose(flat(fc[k]), flat(reference.curves.framesClosed[k]), 1e-5, `closed frames ${k}`);
});

// ---------- closed solids: watertight and outward ----------

const solids = () => [
  ['box', boxGeometry(1, 2, 3), 6],
  ['box segmented', boxGeometry(2, 1, 1.5, 3, 2, 4), 3],
  ['sphere', sphereGeometry(1.5, 24, 12), (4 / 3) * Math.PI * 1.5 ** 3],
  ['torus', torusGeometry(1, 0.3, 16, 48), 2 * Math.PI ** 2 * 1 * 0.3 ** 2],
  ['torus knot', torusKnotGeometry(1, 0.2, 128, 12), null],
  ['capsule', capsuleGeometry(0.5, 1, 16, 64, 2), Math.PI * 0.25 * 1 + (4 / 3) * Math.PI * 0.125],
  ['cylinder', cylinderGeometry(1, 1, 2, 32, 3), Math.PI * 2],
  ['cone', coneGeometry(1, 3, 32, 2), Math.PI],
  ['tetrahedron', tetrahedronGeometry(1, 0), null],
  ['tetrahedron detail 2', tetrahedronGeometry(1, 2), null],
  ['octahedron', octahedronGeometry(2, 0), (4 / 3) * 8],
  ['octahedron detail 3', octahedronGeometry(1, 3), null],
  ['icosahedron', icosahedronGeometry(1, 0), null],
  ['icosahedron detail 4', icosahedronGeometry(1, 4), null],
  ['dodecahedron', dodecahedronGeometry(1, 0), null],
  ['dodecahedron detail 1', dodecahedronGeometry(1, 1), null],
];

test('closed primitives are watertight, genus correct and wound outward', () => {
  for (const [name, g, volume] of solids()) {
    assertValid(g, name);
    const { euler } = assertWatertight(g, name);
    const isTorus = name.startsWith('torus');
    assert.equal(euler, isTorus ? 0 : 2, `${name} Euler characteristic`);
    const v = signedVolume(g);
    assert.ok(v > 0, `${name} signed volume ${v} must be positive`);
    if (volume) close(v, volume, volume * 0.03, `${name} volume`);
    assertNormalsAgreeWithWinding(g, name);
  }
});

test('polyhedra with detail converge to the sphere volume', () => {
  const v = signedVolume(icosahedronGeometry(1, 8));
  close(v, (4 / 3) * Math.PI, ((0.02 * 4) / 3) * Math.PI);
});

test('extruded shapes with holes are watertight and outward, with and without bevel', () => {
  const outer = new Shape();
  outer.absarc(0, 0, 2, 0, Math.PI * 2, false);
  const hole = new Path();
  hole.absarc(0.6, 0, 0.5, 0, Math.PI * 2, true);
  const hole2 = new Path(square(0.3, -0.8, 0.2));
  outer.holes.push(hole, hole2);
  const star = new Shape(
    Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 ? 0.5 : 1.2,
        a = (i / 10) * Math.PI * 2;
      return [r * Math.cos(a), r * Math.sin(a)];
    }),
  );
  const cases = [
    [
      'disk with holes, no bevel',
      extrudeGeometry(outer, { bevelEnabled: false, depth: 0.5, steps: 2 }),
      (Math.PI * 4 - Math.PI * 0.25 - 0.36) * 0.5,
    ],
    [
      'disk with holes, bevel',
      extrudeGeometry(outer, { depth: 0.5, bevelThickness: 0.1, bevelSize: 0.05, bevelSegments: 3 }),
      null,
    ],
    [
      'star, bevel',
      extrudeGeometry(star, { depth: 0.3, bevelSegments: 2, bevelThickness: 0.1, bevelSize: 0.05 }),
      null,
    ],
    [
      'two shapes',
      extrudeGeometry([shapeFrom(square(0.5)), shapeFrom(square(0.5, 3, 0))], { bevelEnabled: false, depth: 1 }),
      2,
    ],
  ];
  for (const [name, g, volume] of cases) {
    assertValid(g, name);
    assertWatertight(g, name);
    const v = signedVolume(g);
    assert.ok(v > 0, `${name} signed volume ${v}`);
    if (volume) close(v, volume, volume * 0.02, `${name} volume`);
    assertUnitNormals(g, name);
    assertNormalsAgreeWithWinding(g, name);
  }
});

test('extrude orientation is independent of contour and hole winding', () => {
  const ccwOuter = square(1),
    cwOuter = square(1).reverse(),
    ccwHole = square(0.3),
    cwHole = square(0.3).reverse();
  const volumes = [
    [ccwOuter, ccwHole],
    [ccwOuter, cwHole],
    [cwOuter, ccwHole],
    [cwOuter, cwHole],
  ].map(([o, h]) => {
    const g = extrudeGeometry(shapeFrom(o, [h]), { bevelEnabled: false, depth: 1 });
    assertWatertight(g, 'winding case');
    return signedVolume(g);
  });
  for (const v of volumes) close(v, 4 - 0.36, 1e-5);
});

test('extrude along a 3D path is watertight and keeps outward winding', () => {
  const path = new CatmullRomCurve3([
    [0, 0, 0],
    [2, 1, 0],
    [4, 0, 1],
    [6, 1, 2],
  ]);
  const sh = new Shape();
  sh.absarc(0, 0, 0.25, 0, Math.PI * 2, false);
  const g = extrudeGeometry(sh, { extrudePath: path, steps: 60, bevelEnabled: true, curveSegments: 8 });
  assert.equal(
    vcount(g),
    3 * (2 * 14 + 2 * 16 * 60),
    'bevel is forced off along a path; the near-duplicate closing point of the circle is dropped',
  );
  assertWatertight(g, 'path extrude');
  const v = signedVolume(g),
    expected = Math.PI * 0.25 ** 2 * path.getLength();
  assert.ok(v > 0, 'outward');
  close(v, expected, expected * 0.05, 'swept volume ~ area * length');
});

test('closed tube along a closed curve is watertight', () => {
  const loop = new CatmullRomCurve3(
    [
      [1, 0, 0],
      [0, 1, 0.3],
      [-1, 0, 0],
      [0, -1, -0.3],
    ],
    true,
  );
  const g = tubeGeometry(loop, 64, 0.1, 8, true);
  assertWatertight(g, 'closed tube');
  assert.ok(signedVolume(g) > 0);
  assertUnitNormals(g, 'tube');
  assertUVRange(g, 'tube');
});

// ---------- normals and UVs ----------

test('every primitive has unit normals that agree with its winding', () => {
  const all = [
    ['plane', planeGeometry(2, 2, 3, 3)],
    ['circle', circleGeometry(1, 16, 0.2, 4)],
    ['ring', ringGeometry(0.3, 1, 16, 2)],
    [
      'lathe',
      latheGeometry(
        [
          [0.2, -1],
          [1, -0.5],
          [0.8, 0.5],
          [0.3, 1],
        ],
        16,
      ),
    ],
    ['shape', shapeGeometry(shapeFrom(square(1), [square(0.2)]))],
    ['open cone', coneGeometry(1, 1, 12, 2, true)],
    ['partial sphere', sphereGeometry(1, 16, 8, 0.3, 2, 0.4, 1.5)],
    ...solids().map((s) => s.slice(0, 2)),
  ];
  for (const [name, g] of all) {
    assertUnitNormals(g, name);
    assertNormalsAgreeWithWinding(g, name);
  }
});

test('sphere normals are radial and lathe normals face outward from the axis', () => {
  const s = sphereGeometry(2, 12, 8);
  for (let i = 0; i < vcount(s); i++) {
    const p = P(s, i);
    for (let k = 0; k < 3; k++) close(s.normals[i * 3 + k], p[k] / 2, 1e-5);
  }
  const l = latheGeometry(
    [
      [1, -1],
      [1, 1],
    ],
    8,
  );
  for (let i = 0; i < vcount(l); i++) {
    const p = P(l, i);
    close(l.normals[i * 3] * p[0] + l.normals[i * 3 + 2] * p[2], 1, 1e-5);
  }
});

test('UVs are in [0, 1] where Three.js normalizes them', () => {
  for (const [name, g] of [
    ['box', boxGeometry(1, 1, 1, 2, 3, 4)],
    ['plane', planeGeometry(3, 1, 2, 2)],
    ['circle', circleGeometry(2, 9)],
    ['ring', ringGeometry(0.2, 2, 10, 3)],
    ['cylinder', cylinderGeometry(1, 0.5, 2, 9, 2)],
    ['torus', torusGeometry()],
    ['torus knot', torusKnotGeometry()],
    ['lathe', latheGeometry()],
    ['tube', tubeGeometry(new LineCurve3([0, 0, 0], [0, 0, 1]), 4, 0.1, 5)],
  ])
    assertUVRange(g, name);
  // Sphere and capsule shift the pole row by half a segment, exactly like Three.js.
  assertUVRange(sphereGeometry(1, 16, 8), 'sphere', -0.5 / 16, 1 + 0.5 / 16);
  assertUVRange(capsuleGeometry(1, 1, 4, 10), 'capsule', -0.5 / 10, 1 + 0.5 / 10);
  // Polyhedra: v in [0, 1], u in [0, 1.2] after the Three.js seam correction.
  for (const g of [icosahedronGeometry(1, 2), dodecahedronGeometry(1, 0), octahedronGeometry(1, 1)]) {
    for (let i = 0; i < vcount(g); i++) {
      assert.ok(g.uvs[i * 2 + 1] >= -1e-6 && g.uvs[i * 2 + 1] <= 1 + 1e-6);
      assert.ok(g.uvs[i * 2] >= -1e-6 && g.uvs[i * 2] <= 1.2 + 1e-6);
    }
  }
});

test('box and plane UVs follow the Three.js layout', () => {
  const p = planeGeometry(2, 2, 1, 1);
  assert.deepEqual([...p.positions.slice(0, 3)], [-1, 1, 0]);
  assert.deepEqual([...p.uvs.slice(0, 2)], [0, 1]);
  const b = boxGeometry(2, 2, 2);
  assert.deepEqual([...b.positions.slice(0, 3)], [1, 1, 1], '+x face starts at (1, 1, 1) like Three.js');
  assert.deepEqual([...b.normals.slice(0, 3)], [1, 0, 0]);
});

// ---------- triangulation ----------

const triangulatedArea = (contour, holes = []) => {
  const r = triangulateShape(contour, holes);
  return triArea2D([...r.contour, ...r.holes.flat()], r.indices);
};

test('triangulated area equals polygon area minus holes', () => {
  const outer = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2,
      r = 3 + Math.sin(a * 5) * 0.8;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  const holes = [
    square(0.4, 0.5, 0.5),
    square(0.3, -1, -0.5),
    Array.from({ length: 12 }, (_, i) => [
      -0.2 + 0.4 * Math.cos((i / 12) * Math.PI * 2),
      1.4 + 0.4 * Math.sin((i / 12) * Math.PI * 2),
    ]),
  ];
  const expected = Math.abs(shapeArea(outer)) - holes.reduce((s, h) => s + Math.abs(shapeArea(h)), 0);
  close(triangulatedArea(outer, holes), expected, 1e-9);
  close(
    triangulatedArea(
      outer.slice().reverse(),
      holes.map((h) => h.slice().reverse()),
    ),
    expected,
    1e-9,
    'reversed rings',
  );
  close(
    triangulatedArea(
      outer,
      holes.map((h, i) => (i % 2 ? h.slice().reverse() : h)),
    ),
    expected,
    1e-9,
    'mixed hole orientation',
  );
});

test('triangulation always emits counter-clockwise triangles', () => {
  const pts = [
    [0, 0],
    [4, 0],
    [4, 3],
    [2, 1],
    [0, 3],
  ];
  for (const ring of [pts, pts.slice().reverse()]) {
    const idx = triangulate(ring.flat());
    for (let t = 0; t < idx.length; t += 3) assert.ok(triArea2D(ring, idx.slice(t, t + 3)) > 0);
    close(triArea2D(ring, idx), Math.abs(shapeArea(ring)), 1e-12);
  }
});

test('triangulation is robust to collinear points, duplicates and closing points', () => {
  const collinear = [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [3, 1],
    [3, 2],
    [2, 2],
    [1, 2],
    [0, 2],
    [0, 1],
    [0, 0],
  ];
  close(triangulatedArea(collinear), 6, 1e-12);
  const dupes = [
    [0, 0],
    [0, 0],
    [2, 0],
    [2, 0],
    [2, 2],
    [1, 2],
    [1, 2],
    [0, 2],
  ];
  close(triangulatedArea(dupes), 4, 1e-12);
  const holeOnCollinear = [
    [0, 0],
    [2, 0],
    [4, 0],
    [4, 4],
    [2, 4],
    [0, 4],
  ];
  close(
    triangulatedArea(holeOnCollinear, [
      [
        [1, 1],
        [1, 3],
        [3, 3],
        [3, 1],
        [1, 1],
      ],
    ]),
    12,
    1e-12,
  );
  // A concave comb with many reflex vertices.
  const comb = [
    [0, 0],
    [10, 0],
    [10, 3],
  ];
  for (let x = 9; x >= 1; x -= 2) comb.push([x, 3], [x - 0.5, 1], [x - 1, 3]);
  comb.push([0, 3]);
  close(triangulatedArea(comb), Math.abs(shapeArea(comb)), 1e-9);
});

test('degenerate polygons produce zero area rather than failing', () => {
  assert.deepEqual(triangulate([0, 0, 1, 1, 2, 2, 3, 3]), [], 'all collinear');
  assert.deepEqual(triangulate([0, 0, 1, 1]), [], 'two points');
  assert.deepEqual(triangulate([]), []);
  close(
    triangulatedArea([
      [0, 0],
      [1, 0],
      [1, 0],
      [0, 0],
    ]),
    0,
    1e-12,
  );
  // Hole touching the outer boundary at a vertex.
  close(
    triangulatedArea(square(2), [
      [
        [-2, -2],
        [0, -1],
        [-1, 0],
      ],
    ]),
    16 - 1.5,
    1e-9,
  );
});

test('triangulation of a large noisy polygon with holes stays exact', () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const outer = Array.from({ length: 300 }, (_, i) => {
    const a = (i / 300) * Math.PI * 2,
      r = 10 + rnd() * 2;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  const holes = [];
  for (let k = 0; k < 6; k++) {
    const cx = Math.cos(k) * 5,
      cy = Math.sin(k) * 5;
    holes.push(
      Array.from({ length: 20 }, (_, i) => {
        const a = (-i / 20) * Math.PI * 2,
          r = 1 + rnd() * 0.3;
        return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
      }),
    );
  }
  const expected = Math.abs(shapeArea(outer)) - holes.reduce((s, h) => s + Math.abs(shapeArea(h)), 0);
  close(triangulatedArea(outer, holes), expected, 1e-7);
  const n = 300 + 6 * 20;
  assert.equal(triangulateShape(outer, holes).indices.length / 3, n - 2 + 2 * 6);
});

test('isClockWise and shapeArea follow Three.js ShapeUtils', () => {
  close(shapeArea(square(1)), 4, 0);
  assert.equal(isClockWise(square(1)), false);
  assert.equal(isClockWise(square(1).reverse()), true);
});

test('shape geometry area matches the shape minus holes and faces +z', () => {
  const sh = new Shape();
  sh.absellipse(0, 0, 2, 1, 0, Math.PI * 2, false, 0);
  const h = new Path();
  h.absarc(0.5, 0, 0.3, 0, Math.PI * 2, false);
  sh.holes.push(h);
  const g = shapeGeometry(sh, 64);
  close(surfaceArea(g), Math.PI * 2 - Math.PI * 0.09, 0.01);
  for (let t = 0; t < g.indices.length; t += 3)
    assert.ok(
      cross(sub(P(g, g.indices[t + 1]), P(g, g.indices[t])), sub(P(g, g.indices[t + 2]), P(g, g.indices[t])))[2] >= 0,
    );
});

// ---------- curves ----------

test('curve lengths match analytic values', () => {
  close(new LineCurve([0, 0], [3, 4]).getLength(), 5, 1e-12);
  close(new LineCurve3([1, 2, 3], [4, 6, 15]).getLength(), 13, 1e-9);
  close(new ArcCurve(0, 0, 2).getLength(), 4 * Math.PI, 4 * Math.PI * 1e-4, 'circle circumference');
  close(new ArcCurve(0, 0, 1, 0, Math.PI / 2).getLength(), Math.PI / 2, 1e-4, 'quarter arc');
  close(new ArcCurve(0, 0, 1, 0, Math.PI / 2, true).getLength(), 1.5 * Math.PI, 1e-3, 'clockwise is the long way');
  // Ellipse perimeter by Ramanujan II.
  const a = 3,
    b = 1,
    h = ((a - b) / (a + b)) ** 2,
    ramanujan = Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
  close(new EllipseCurve(0, 0, a, b).getLength(), ramanujan, ramanujan * 1e-4, 'ellipse');
  // A straight Bezier is a line.
  close(new CubicBezierCurve3([0, 0, 0], [1, 1, 1], [2, 2, 2], [3, 3, 3]).getLength(), Math.sqrt(27), 1e-6);
  close(new QuadraticBezierCurve([0, 0], [1, 0], [2, 0]).getLength(), 2, 1e-9);
  // Parabola y = x^2 on [0, 1]: (2 sqrt5 + asinh 2) / 4.
  close(new QuadraticBezierCurve([0, 0], [0.5, 0], [1, 1]).getLength(), (2 * Math.sqrt(5) + Math.asinh(2)) / 4, 1e-5);
  const path = new Path().moveTo(0, 0).lineTo(2, 0).lineTo(2, 3);
  close(path.getLength(), 5, 1e-12, 'path');
  const shape = new Shape(square(1));
  shape.closePath();
  close(shape.getLength(), 8, 1e-12, 'closed square path');
});

test('arc-length parameterization spaces points evenly', () => {
  const curve = new CubicBezierCurve([0, 0], [0, 3], [4, -2], [5, 1]);
  const pts = curve.getSpacedPoints(20),
    total = curve.getLength();
  for (let i = 1; i < pts.length; i++)
    close(
      Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]),
      total / 20,
      (total / 20) * 0.02,
      'chord of an equal-arc step',
    );
  assert.deepEqual(curve.getPointAt(0), curve.getPoint(0));
  const end = curve.getPointAt(1);
  close(end[0], 5, 1e-9);
  close(end[1], 1, 1e-9);
  assert.equal(curve.getPoints(7).length, 8);
  const arc = new ArcCurve(0, 0, 1);
  const q = arc.getPointAt(0.25);
  close(q[0], 0, 1e-3);
  close(q[1], 1, 1e-3);
});

test('Bezier and Catmull-Rom curves interpolate their endpoints and control points', () => {
  const q3 = new QuadraticBezierCurve3([0, 0, 0], [1, 2, 0], [2, 0, 4]).getPoint(0.5);
  assert.deepEqual(q3, [1, 1, 1]);
  const c2 = new CubicBezierCurve([0, 0], [1, 1], [2, 1], [3, 0]).getPoint(0.5);
  assert.deepEqual(c2, [1.5, 0.75]);
  const pts = [
    [0, 0, 0],
    [1, 2, 0],
    [3, 1, 1],
    [4, 4, 2],
    [6, 0, 1],
  ];
  for (const type of ['centripetal', 'chordal', 'catmullrom', 'uniform']) {
    const c = new CatmullRomCurve3(pts, false, type);
    for (let i = 0; i < pts.length; i++)
      c.getPoint(i / (pts.length - 1)).forEach((x, k) => close(x, pts[i][k], 1e-9, `${type} knot ${i}`));
    const closed = new CatmullRomCurve3(pts, true, type);
    for (let i = 0; i < pts.length; i++)
      closed.getPoint(i / pts.length).forEach((x, k) => close(x, pts[i][k], 1e-9, `${type} closed knot ${i}`));
    closed.getPoint(1).forEach((x, k) => close(x, pts[0][k], 1e-9, 'closed loop returns to start'));
  }
  const spline = new SplineCurve([
    [0, 0],
    [1, 1],
    [2, 0],
  ]);
  assert.deepEqual(spline.getPoint(0.5), [1, 1]);
});

test('centripetal Catmull-Rom avoids the cusp a uniform spline makes on uneven spacing', () => {
  // Classic case: uniform overshoots near a short segment, centripetal stays closer to the polyline.
  const pts = [
    [0, 0, 0],
    [1, 0, 0],
    [1.05, 0.05, 0],
    [2, 3, 0],
  ];
  const maxDev = (type) => {
    const c = new CatmullRomCurve3(pts, false, type);
    let m = 0;
    for (let i = 0; i <= 200; i++) {
      const p = c.getPoint(i / 200);
      m = Math.max(m, -p[1]);
    }
    return m;
  };
  assert.ok(maxDev('centripetal') <= maxDev('catmullrom') + 1e-12);
});

test('Frenet frames are orthonormal and right-handed, and closed frames meet', () => {
  const helix = new CatmullRomCurve3(
    Array.from({ length: 20 }, (_, i) => [Math.cos(i * 0.6), Math.sin(i * 0.6), i * 0.2]),
  );
  const loop = new CatmullRomCurve3(
    [
      [1, 0, 0],
      [0, 1, 0.5],
      [-1, 0, 0],
      [0, -1, -0.5],
    ],
    true,
  );
  for (const [curve, closed] of [
    [helix, false],
    [loop, true],
    [new LineCurve3([0, 0, 0], [0, 0, 5]), false],
  ]) {
    const f = curve.computeFrenetFrames(50, closed);
    assert.equal(f.tangents.length, 51);
    for (let i = 0; i <= 50; i++) {
      const T = f.tangents[i],
        N = f.normals[i],
        B = f.binormals[i];
      for (const v of [T, N, B]) close(len(v), 1, 1e-9);
      close(dot(T, N), 0, 1e-9);
      close(dot(T, B), 0, 1e-9);
      close(dot(N, B), 0, 1e-9);
      close(dot(cross(T, N), B), 1, 1e-9, 'right-handed');
    }
    if (closed) close(dot(f.normals[0], f.normals[50]), 1, 1e-4, 'closed frames line up');
  }
});

test('Path builders match Three.js point sampling', () => {
  const p = new Path();
  p.moveTo(0, 0)
    .lineTo(1, 0)
    .quadraticCurveTo(2, 0, 2, 1)
    .bezierCurveTo(2, 2, 1, 2, 0, 2)
    .splineThru([
      [-1, 1],
      [0, 0],
    ]);
  assert.equal(p.curves.length, 4);
  const pts = p.getPoints(6);
  // line: 2 points, quadratic: 6 more, cubic: 6 more, spline (3 points): 18 more.
  assert.equal(pts.length, 2 + 6 + 6 + 18);
  assert.deepEqual(pts.at(-1), [0, 0]);
  assert.equal(
    new Path().moveTo(5, 0).absarc(0, 0, 1, 0, Math.PI, false).curves.length,
    1,
    'a bare moveTo adds no curve, as in Three.js',
  );
  const arc = new Path().moveTo(4, 0).lineTo(5, 0).absarc(0, 0, 1, 0, Math.PI, false);
  assert.equal(arc.curves.length, 3, 'absarc adds a connecting line when the pen is elsewhere');
  const rel = new Path().moveTo(1, 1);
  rel.arc(1, 0, 1, Math.PI, 0, true);
  assert.deepEqual(
    rel.curves[0].getPoint(0).map((x) => Math.round(x * 1e9) / 1e9),
    [1, 1],
  );
  assert.equal(p.getSpacedPoints(10).length, 11);
});

// ---------- utilities ----------

test('tangents are unit, orthogonal to normals, with valid handedness', () => {
  for (const [name, g] of [
    ['sphere', sphereGeometry(1, 16, 8)],
    ['box', boxGeometry(1, 2, 3, 2, 2, 2)],
    ['torus', torusGeometry()],
    ['knot', torusKnotGeometry(1, 0.3, 64, 8)],
    ['capsule', capsuleGeometry()],
  ]) {
    const t = computeTangents(g).tangents;
    assert.equal(t.length, vcount(g) * 4);
    for (let i = 0; i < vcount(g); i++) {
      const T = [t[i * 4], t[i * 4 + 1], t[i * 4 + 2]],
        N = [g.normals[i * 3], g.normals[i * 3 + 1], g.normals[i * 3 + 2]];
      close(len(T), 1, 1e-5, `${name} tangent length`);
      close(dot(T, N), 0, 1e-5, `${name} tangent orthogonal`);
      assert.ok(t[i * 4 + 3] === 1 || t[i * 4 + 3] === -1, `${name} handedness`);
    }
  }
});

test('tangents follow +u and the handedness flips with mirrored UVs', () => {
  const plane = computeTangents(planeGeometry(2, 2, 2, 2));
  for (let i = 0; i < vcount(plane); i++) assert.deepEqual([...plane.tangents.slice(i * 4, i * 4 + 4)], [1, 0, 0, 1]);
  const mirrored = planeGeometry(2, 2);
  for (let i = 0; i < mirrored.uvs.length; i += 2) mirrored.uvs[i] = 1 - mirrored.uvs[i];
  const m = computeTangents(mirrored);
  for (let i = 0; i < vcount(m); i++) {
    close(m.tangents[i * 4], -1, 1e-6);
    assert.equal(m.tangents[i * 4 + 3], -1);
  }
  // On a sphere the tangent follows increasing u and the bitangent (w * N x T) increasing v.
  const s = sphereGeometry(1, 16, 8),
    st = computeTangents(s).tangents;
  for (let i = 0; i < vcount(s); i++) {
    const u = s.uvs[i * 2],
      v = s.uvs[i * 2 + 1],
      phi = u * Math.PI * 2,
      y = P(s, i)[1];
    if (Math.abs(y) > 0.99) continue;
    close(
      dot([st[i * 4], st[i * 4 + 1], st[i * 4 + 2]], [Math.sin(phi), 0, Math.cos(phi)]),
      1,
      0.05,
      'tangent along +u',
    );
    assert.equal(st[i * 4 + 3], 1);
    void v;
  }
});

test('merging preserves vertex counts, area and groups', () => {
  const a = boxGeometry(1, 1, 1),
    b = applyMatrix4(sphereGeometry(1, 12, 6), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]),
    c = torusGeometry();
  const m = mergeGeometries([a, b, c]);
  assert.equal(vcount(m), vcount(a) + vcount(b) + vcount(c));
  assert.equal(m.indices.length, a.indices.length + b.indices.length + c.indices.length);
  close(surfaceArea(m), surfaceArea(a) + surfaceArea(b) + surfaceArea(c), 1e-6);
  assert.equal(m.groups.length, 6, 'box groups are kept');
  const grouped = mergeGeometries([a, b, c], true);
  assert.deepEqual(
    grouped.groups.map((g) => [g.start, g.count, g.materialIndex]),
    [
      [0, 36, 0],
      [36, b.indices.length, 1],
      [36 + b.indices.length, c.indices.length, 2],
    ],
  );
  assert.equal(
    mergeGeometries([computeTangents(a), b]).tangents,
    undefined,
    'tangents dropped when not on every input',
  );
  assert.equal(mergeGeometries([computeTangents(a), computeTangents(b)]).tangents.length, (vcount(a) + vcount(b)) * 4);
});

test('welding merges seams and duplicates, preserves area, and respects tolerance', () => {
  const s = sphereGeometry(1, 16, 8);
  const welded = mergeVertices(s, { positionOnly: true });
  assert.equal(vcount(welded), 16 * 7 + 2, 'seam and poles collapse');
  close(surfaceArea(welded), surfaceArea(s), 1e-6);
  assertWatertight(welded, 'welded sphere');
  const attr = mergeVertices(s);
  assert.equal(vcount(attr), vcount(s), 'with UVs compared, seam and pole vertices stay apart');
  const ico = icosahedronGeometry(1, 2),
    wi = mergeVertices(ico, { positionOnly: true });
  assert.equal(vcount(wi), 10 * 9 + 2, 'icosphere detail 2 has 10 * (d+1)^2 + 2 vertices');
  close(surfaceArea(wi), surfaceArea(ico), 1e-6);
  // Tolerance: points 1e-3 apart merge only with a large enough tolerance, even across cell boundaries.
  const pair = {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.0004, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(18),
    uvs: new Float32Array(12),
    indices: new Uint32Array([0, 1, 2, 3, 4, 5]),
  };
  assert.equal(vcount(mergeVertices(pair, { tolerance: 1e-4 })), 4);
  assert.equal(vcount(mergeVertices(pair, { tolerance: 1e-3 })), 3);
  const removed = mergeVertices(pair, { tolerance: 1e-3, removeDegenerate: true });
  assert.equal(tris(removed), 2, 'nothing degenerate here');
  const collapse = mergeVertices(
    { ...pair, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0.00001, 0, 0, 0, 1, 0]) },
    { tolerance: 1e-4, removeDegenerate: true },
  );
  assert.equal(tris(collapse), 1);
});

test('angle-weighted vertex normals reproduce analytic normals', () => {
  const s = mergeVertices(sphereGeometry(1, 32, 16), { positionOnly: true });
  const n = computeVertexNormals(s);
  for (let i = 0; i < vcount(n); i++)
    close(dot(P(n, i), [n.normals[i * 3], n.normals[i * 3 + 1], n.normals[i * 3 + 2]]), 1, 0.002);
  // Angle weighting: a cube corner shared by faces with different triangle counts still gets the diagonal.
  const box = mergeVertices(boxGeometry(2, 2, 2, 1, 3, 2), { positionOnly: true });
  const bn = computeVertexNormals(box);
  for (let i = 0; i < vcount(bn); i++) {
    const p = P(bn, i);
    if (p.every((x) => Math.abs(Math.abs(x) - 1) < 1e-6))
      close(
        dot(
          p.map((x) => x / Math.sqrt(3)),
          [bn.normals[i * 3], bn.normals[i * 3 + 1], bn.normals[i * 3 + 2]],
        ),
        1,
        1e-6,
        'corner normal is the diagonal',
      );
  }
  assertUnitNormals(bn, 'box normals');
});

test('toNonIndexed expands corners and keeps area', () => {
  const g = computeTangents(torusGeometry(1, 0.4, 6, 10)),
    n = toNonIndexed(g);
  assert.equal(vcount(n), g.indices.length);
  assert.deepEqual([...n.indices.slice(0, 6)], [0, 1, 2, 3, 4, 5]);
  assert.equal(n.tangents.length, g.indices.length * 4);
  close(surfaceArea(n), surfaceArea(g), 1e-6);
});

test('applyMatrix4 transforms normals by the inverse-transpose and keeps solids outward', () => {
  const s = sphereGeometry(1, 16, 8);
  const m = [2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
  const t = applyMatrix4(s, m);
  for (let i = 0; i < vcount(t); i++) {
    const p = sub(P(t, i), [1, 2, 3]),
      grad = [p[0] / 4, p[1] / 0.25, p[2]],
      l = len(grad);
    if (l < 1e-6) continue;
    close(
      dot(
        grad.map((x) => x / l),
        [t.normals[i * 3], t.normals[i * 3 + 1], t.normals[i * 3 + 2]],
      ),
      1,
      1e-4,
      'ellipsoid normal is the gradient',
    );
  }
  close(signedVolume(t), ((4 / 3) * Math.PI * signedVolume(s)) / ((4 / 3) * Math.PI), 0.05);
  const mirror = applyMatrix4(computeTangents(boxGeometry()), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.ok(signedVolume(mirror) > 0, 'mirrored solid stays outward');
  assertNormalsAgreeWithWinding(mirror, 'mirror');
  assert.equal(mirror.tangents[3], -1, 'mirrored tangent sign flips');
  assert.throws(() => applyMatrix4(s, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]), /singular/);
  // Rotation keeps normals unit and orthogonal to tangents.
  const c = Math.cos(0.7),
    sn = Math.sin(0.7),
    rot = applyMatrix4(computeTangents(torusGeometry()), [c, sn, 0, 0, -sn, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  for (let i = 0; i < vcount(rot); i++)
    close(
      dot(
        [rot.tangents[i * 4], rot.tangents[i * 4 + 1], rot.tangents[i * 4 + 2]],
        [rot.normals[i * 3], rot.normals[i * 3 + 1], rot.normals[i * 3 + 2]],
      ),
      0,
      1e-5,
    );
});

test('bounds and center', () => {
  const b = applyMatrix4(boxGeometry(2, 4, 6), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, -1, 2, 1]);
  assert.deepEqual(computeBoundingBox(b), { min: [4, -3, -1], max: [6, 1, 5] });
  const sphere = computeBoundingSphere(b);
  assert.deepEqual(sphere.center, [5, -1, 2]);
  close(sphere.radius, Math.sqrt(1 + 4 + 9), 1e-6);
  const c = center(b);
  assert.deepEqual(computeBoundingBox(c), { min: [-1, -2, -3], max: [1, 2, 3] });
  assert.equal(c.groups.length, 6);
  const s = computeBoundingSphere(sphereGeometry(3, 16, 8));
  close(s.radius, 3, 1e-5);
});

test('edges geometry keeps only crease and boundary edges', () => {
  const box = boxGeometry(1, 1, 1, 2, 2, 2);
  assert.equal(edgesGeometry(box).length / 2, 12 * 2, '12 cube edges, each split in two');
  assert.equal(edgesGeometry(sphereGeometry(1, 32, 16), 20).length, 0, 'smooth sphere has no creases above 20 degrees');
  assert.equal(edgesGeometry(planeGeometry(1, 1, 3, 3)).length / 2, 12, 'only the boundary of a flat grid');
  assert.equal(edgesGeometry(cylinderGeometry(1, 1, 1, 24), 30).length / 2, 48, 'two rim circles');
  const pairs = edgesGeometry(box);
  for (let i = 0; i < pairs.length; i += 2) close(len(sub(P(box, pairs[i]), P(box, pairs[i + 1]))), 0.5, 1e-6);
});

test('wireframe lists each triangle edge once', () => {
  const p = planeGeometry(1, 1, 3, 2);
  assert.equal(wireframe(p).length / 2, 3 * 3 + 2 * 4 + 3 * 2, 'horizontal + vertical + diagonal edges');
  const ico = mergeVertices(icosahedronGeometry(1, 0), { positionOnly: true });
  assert.equal(wireframe(ico).length / 2, 30);
});

test('Loop subdivision quadruples faces, stays watertight and converges toward a sphere', () => {
  const ico = icosahedronGeometry(1, 0);
  const once = loopSubdivide(ico, 1);
  assert.equal(tris(once), 80);
  assert.equal(vcount(mergeVertices(once, { positionOnly: true })), 12 + 30, 'V + E distinct positions');
  assert.ok(vcount(once) < tris(ico) * 3, 'corners sharing position and UV are shared');
  const twice = loopSubdivide(ico, 2);
  assert.equal(tris(twice), 320);
  const { euler } = assertWatertight(twice, 'loop');
  assert.equal(euler, 2);
  assert.ok(signedVolume(twice) > 0);
  assertUnitNormals(twice, 'loop');
  const r = [...Array(vcount(twice)).keys()].map((i) => len(P(twice, i))),
    mean = r.reduce((s, x) => s + x, 0) / r.length;
  for (const x of r) close(x, mean, 0.03 * mean, 'roughly spherical');
  // Open meshes keep their boundary on the plane and inside the outline.
  const plane = loopSubdivide(planeGeometry(2, 2, 2, 2), 2);
  for (let i = 0; i < vcount(plane); i++) {
    close(P(plane, i)[2], 0, 1e-9);
    assert.ok(Math.abs(P(plane, i)[0]) <= 1 + 1e-9);
  }
  close(surfaceArea(plane), 4, 1, 'boundary rule shrinks only the corners');
  // An index past the vertices is a named error (it used to surface as a TypeError from inside the edge table).
  const bad = { ...planeGeometry(1, 1, 1, 1) };
  bad.indices = Uint32Array.from([0, 1, 9]);
  assert.throws(() => loopSubdivide(bad, 1), {
    name: 'RangeError',
    message: 'loopSubdivide: index 9 is past the 4 vertices',
  });
});

// ---------- core interop ----------

test('toGeometry output is accepted by core Geometry with interleaved position and normal', () => {
  for (const g of [
    boxGeometry(1, 2, 3, 2, 2, 2),
    sphereGeometry(),
    torusKnotGeometry(),
    icosahedronGeometry(1, 2),
    extrudeGeometry(shapeFrom(square(1), [square(0.3)])),
  ]) {
    const core = toGeometry(g);
    assert.ok(core instanceof Geometry);
    assert.equal(core.vertices.length, vcount(g) * 6);
    assert.deepEqual([...core.indices], [...g.indices]);
    for (let i = 0; i < vcount(g); i++)
      for (let k = 0; k < 3; k++) {
        assert.equal(core.vertices[i * 6 + k], g.positions[i * 3 + k]);
        assert.equal(core.vertices[i * 6 + 3 + k], g.normals[i * 3 + k]);
      }
    const s = computeBoundingSphere(g),
      box = computeBoundingBox(g);
    for (let k = 0; k < 3; k++) close(core.bounds[k], (box.min[k] + box.max[k]) / 2, 1e-5);
    close(core.bounds[3], s.radius, 1e-5);
  }
});

// ---------- packaging ----------

test('module is side-effect free, SSR safe and small', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.sideEffects, false);
  assert.equal(pkg.name, '@margoengine/geometry');
  const source = await readFile(new URL('../dist/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(window|document|navigator|Worker|GPUBufferUsage)\b/, 'no browser globals anywhere');
  assert.doesNotMatch(source, /[\u2013\u2014]/, 'no en or em dashes');
  const gz = gzipSync(source).length;
  assert.ok(gz < 20 * 1024, `gzip ${gz}`);
});

test('consumers tree-shake to what they import', async (t) => {
  const { build } = await import('vite');
  const entry = new URL('../dist/index.js', import.meta.url).pathname;
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises'),
    { tmpdir } = await import('node:os'),
    { join } = await import('node:path');
  const folder = await mkdtemp(join(tmpdir(), 'margoengine-geometry-shake-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  let n = 0;
  const bundle = async (code) => {
    const file = join(folder, `entry${n++}.js`);
    await writeFile(file, code);
    const out = await build({
      root: folder,
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        minify: true,
        lib: { entry: file, formats: ['es'], fileName: 'entry' },
        rollupOptions: { external: [/margoengine-core/] },
      },
    });
    return (Array.isArray(out) ? out[0] : out).output[0].code;
  };
  const all = await bundle(`export * from ${JSON.stringify(entry)};`);
  const box = await bundle(`export {boxGeometry, toGeometry} from ${JSON.stringify(entry)};`);
  assert.ok(gzipSync(box).length < 1500, `box-only gzip ${gzipSync(box).length}`);
  assert.ok(gzipSync(box).length * 8 < gzipSync(all).length, 'box alone is a small fraction of the package');
  assert.doesNotMatch(box, /Catmull|steiner/, 'curves and the triangulator are dropped');
});
