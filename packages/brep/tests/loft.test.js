// Lofts through closed planar sections, against closed forms: the prismatoid formula h/6 (A0 + 4 Am + A1), exact for
// ruled spans between parallel sections (squares to squares, turned or not; a circle of arcs to a square, its middle
// section's area by Gauss-Legendre over its exact rational parameterisation), a circle to a circle against the cone
// primitive, two equal circles offset sideways (Cavalieri: area times height), three sections meeting in a crease, a
// STEP round trip, and the lofts that must be refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const { bodiesFromSTEP, bodiesToSTEP, checkBody, cone, loft, massProperties, meshBodies, validateBody } = model;
const mm = 0.001;

function close(actual, expected, what, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1e-300),
    `${what}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / Math.abs(expected)})`,
  );
}

/** A square of half side s (mm) about the z axis at height z, turned by `turn`. */
function square(s, z, turn = 0) {
  const c = Math.cos(turn),
    si = Math.sin(turn),
    p = (x, y) => [(x * c - y * si) * mm, (x * si + y * c) * mm, z * mm];
  return {
    name: `square${z}`,
    start: p(-s, -s),
    normal: [0, 0, 1],
    segments: [
      { kind: 'line', to: p(s, -s) },
      { kind: 'line', to: p(s, s) },
      { kind: 'line', to: p(-s, s) },
      { kind: 'line', to: p(-s, -s) },
    ],
  };
}
/** A circle of radius r at height z about (cx, 0), as one arc. */
const circle = (r, z, cx = 0) => ({
  name: `circle${z}`,
  start: [(cx + r) * mm, 0, z * mm],
  normal: [0, 0, 1],
  segments: [{ kind: 'arc', to: [(cx + r) * mm, 0, z * mm], center: [cx * mm, 0, z * mm] }],
});
/** A circle of radius r at height z as four quarter arcs from the angle -3 pi / 4 (matching a square's corners). */
function quarters(r, z) {
  const p = (t) => [r * Math.cos(t) * mm, r * Math.sin(t) * mm, z * mm],
    t0 = (-3 * Math.PI) / 4;
  return {
    name: `quarters${z}`,
    start: p(t0),
    normal: [0, 0, 1],
    segments: [0, 1, 2, 3].map((j) => ({ kind: 'arc', to: p(t0 + ((j + 1) * Math.PI) / 2), center: [0, 0, z * mm] })),
  };
}
const shoelace = (pts) =>
  pts.reduce((a, p, k) => a + (p[0] * pts[(k + 1) % pts.length][1] - pts[(k + 1) % pts.length][0] * p[1]) / 2, 0);
const corners = (p) => [p.start, ...p.segments.slice(0, -1).map((s) => s.to)].map((q) => [q[0] / mm, q[1] / mm]);


/** Valid by both checks, and a closed outward mesh. */
function clean(body) {
  assert.deepEqual(validateBody(body), []);
  assert.deepEqual(checkBody(body), []);
  assert.equal(body.kind, 'solid');
  const { meshes } = meshBodies([body], { deflection: 1e-6, angle: 0.1 }),
    [mesh] = meshes;
  assert.deepEqual(mesh.failures, []);
  const p = mesh.positions,
    t = mesh.indices,
    ids = new Map(),
    weld = (i) => {
      const key = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    },
    directed = new Map();
  let volume = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    const w = [t[k], t[k + 1], t[k + 2]].map(weld);
    for (const [x, y] of [
      [w[0], w[1]],
      [w[1], w[2]],
      [w[2], w[0]],
    ])
      directed.set(`${x},${y}`, (directed.get(`${x},${y}`) ?? 0) + 1);
  }
  let open = 0;
  for (const [key, count] of directed) {
    const [x, y] = key.split(',');
    if (count !== 1 || directed.get(`${y},${x}`) !== 1) open++;
  }
  assert.equal(open, 0, 'mesh closed');
  const exact = massProperties(body).volume;
  assert.ok(Math.abs(volume - exact) <= 2e-3 * exact, `mesh volume ${volume} vs ${exact}`);
}

test('loft: a square to a smaller square is the prismatoid (the harness case O_loft)', () => {
  const l = loft('l', [square(5, 0), square(3, 10)]);
  clean(l);
  close(massProperties(l).volume, (1960 / 3) * mm ** 3, 'volume');
  assert.deepEqual(
    l.faces.map((f) => f.surface.kind),
    ['plane', 'plane', 'plane', 'plane', 'plane', 'plane'],
  );
  // Slant faces: trapezoids of parallel sides 10 and 6, slant height sqrt(10^2 + 2^2).
  close(massProperties(l).area, (100 + 36 + 4 * 8 * Math.hypot(10, 2)) * mm ** 2, 'area');
});

test('loft: a square to a turned square, ruled by bilinear faces, is the prismatoid', () => {
  const a = square(5, 0),
    b = square(3, 10, Math.PI / 6),
    mid = corners(a).map((q, k) => [(q[0] + corners(b)[k][0]) / 2, (q[1] + corners(b)[k][1]) / 2]),
    l = loft('l', [a, b]);
  clean(l);
  close(massProperties(l).volume, (10 / 6) * (100 + 4 * shoelace(mid) + 36) * mm ** 3, 'volume');
  assert.equal(l.faces.filter((f) => f.surface.kind === 'spline').length, 4);
});

test('loft: circle to circle is the frustum; equal circles offset sideways keep area times height', () => {
  const f = loft('f', [circle(5, 0), circle(2, 12)]),
    c = massProperties(cone('c', 5 * mm, 2 * mm, 12 * mm)),
    m = massProperties(f);
  clean(f);
  assert.equal(f.faces[0].surface.kind, 'cone');
  close(m.volume, c.volume, 'frustum volume');
  close(m.area, c.area, 'frustum area');
  m.inertia.forEach((x, k) => assert.ok(Math.abs(x - c.inertia[k]) <= 1e-12 * c.inertia[0], `inertia ${k}`));
  const o = loft('o', [circle(2, 0), circle(2, 10, 3)]);
  clean(o);
  assert.equal(o.faces[0].surface.kind, 'spline');
  close(massProperties(o).volume, Math.PI * 4 * 10 * mm ** 3, 'oblique cylinder volume', 1e-12);
  // Its centroid moves sideways with the sections: half the offset.
  close(massProperties(o).centroid[0], 1.5 * mm, 'oblique centroid x', 1e-12);
});

test('loft: a circle of four arcs to a square, ruled by rational faces', () => {
  // The middle section is (C(u) + L(u)) / 2 for each quarter arc C (rational quadratic, weight cos 45 degrees) and
  // square side L at the same parameter; its area by Gauss-Legendre (16 points on 64 pieces a side).
  const G = (() => {
    const n = 16,
      x = [],
      w = [];
    for (let i = 1; i <= n; i++) {
      let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5)),
        dp = 0;
      for (let k = 0; k < 100; k++) {
        let p0 = 1,
          p1 = z;
        for (let j = 2; j <= n; j++) [p0, p1] = [p1, ((2 * j - 1) * z * p1 - (j - 1) * p0) / j];
        dp = (n * (z * p1 - p0)) / (z * z - 1);
        const dz = p1 / dp;
        z -= dz;
        if (Math.abs(dz) < 1e-16) break;
      }
      x.push(z);
      w.push(2 / ((1 - z * z) * dp * dp));
    }
    return { x, w };
  })();
  const r = 5,
    s = 3,
    w = Math.cos(Math.PI / 4),
    t0 = (-3 * Math.PI) / 4,
    sq = [
      [-s, -s],
      [s, -s],
      [s, s],
      [-s, s],
    ];
  // [[x, dx/du], [y, dy/du]] of the middle section along quarter j.
  const mid = (j, u) => {
    const a = t0 + (j * Math.PI) / 2,
      P = [a, a + Math.PI / 4, a + Math.PI / 2].map((t, i) => [
        (i === 1 ? r / w : r) * Math.cos(t),
        (i === 1 ? r / w : r) * Math.sin(t),
      ]),
      b = [(1 - u) ** 2, 2 * u * (1 - u) * w, u * u],
      db = [-2 * (1 - u), 2 * (1 - 2 * u) * w, 2 * u],
      d = b[0] + b[1] + b[2],
      dd = db[0] + db[1] + db[2],
      N = [0, 1].map((c) => b[0] * P[0][c] + b[1] * P[1][c] + b[2] * P[2][c]),
      dN = [0, 1].map((c) => db[0] * P[0][c] + db[1] * P[1][c] + db[2] * P[2][c]),
      A = sq[j],
      B = sq[(j + 1) % 4];
    return [0, 1].map((c) => [
      (N[c] / d + A[c] + (B[c] - A[c]) * u) / 2,
      ((dN[c] * d - N[c] * dd) / (d * d) + B[c] - A[c]) / 2,
    ]);
  };
  let Am = 0;
  for (let j = 0; j < 4; j++)
    for (let p = 0; p < 64; p++)
      for (let i = 0; i < 16; i++) {
        const [[x, dx], [y, dy]] = mid(j, (p + (G.x[i] + 1) / 2) / 64);
        Am += ((G.w[i] / 2 / 64) * (x * dy - y * dx)) / 2;
      }
  const l = loft('l', [quarters(r, 0), square(s, 10)]);
  clean(l);
  assert.equal(l.faces.filter((f) => f.surface.kind === 'spline' && f.surface.weights).length, 4);
  close(massProperties(l).volume, (10 / 6) * (Math.PI * r * r + 4 * Am + 4 * s * s) * mm ** 3, 'volume', 1e-13);
});

test('loft: three sections meet in a crease (each span ruled on its own)', () => {
  const l = loft('l', [square(5, 0), square(3, 10), square(4, 15)]);
  clean(l);
  close(massProperties(l).volume, (1960 / 3 + (5 / 3) * (36 + 64 + 48)) * mm ** 3, 'volume');
  assert.equal(l.faces.length, 10);
  assert.ok(l.faces.some((f) => f.name === 'l/face:s1/e2'));
});

test('loft: STEP round trip of ruled spline faces', () => {
  const l = loft('l', [quarters(5, 0), square(3, 10)]),
    read = bodiesFromSTEP(parseSTEP(new TextEncoder().encode(bodiesToSTEP([l]))));
  assert.deepEqual(read.problems, []);
  const [back] = read.bodies;
  assert.deepEqual(validateBody(back), []);
  assert.deepEqual(checkBody(back), []);
  close(massProperties(back).volume, massProperties(l).volume, 'volume read back', 1e-9);
});

test('loft: mismatched, overlapping, twisted and bent sections are refused', () => {
  assert.throws(() => loft('l', [square(5, 0)]), /at least two sections/);
  assert.throws(() => loft('l', [square(5, 0), circle(2, 10)]), /as many segments each: square0 has 4, circle10 1/);
  // A square tilted through the first one's plane.
  const tilted = {
    name: 'tilted',
    start: [-5 * mm, -5 * mm, 3 * mm],
    normal: [0, 1, 1],
    segments: [
      { kind: 'line', to: [5 * mm, -5 * mm, 3 * mm] },
      { kind: 'line', to: [5 * mm, 5 * mm, -7 * mm] },
      { kind: 'line', to: [-5 * mm, 5 * mm, -7 * mm] },
      { kind: 'line', to: [-5 * mm, -5 * mm, 3 * mm] },
    ],
  };
  assert.throws(() => loft('l', [square(5, 0), tilted]), /are not apart: each must lie beyond the other's plane/);
  assert.throws(
    () => loft('l', [square(5, 0), square(5, 10, Math.PI)]),
    /square0 and square10 twist against each other: the faces between them would cross/,
  );
  const bent = square(3, 10);
  bent.segments = [bent.segments[0], { kind: 'line', to: [3 * mm, 3 * mm, 11 * mm] }, ...bent.segments.slice(2)];
  assert.throws(() => loft('l', [square(5, 0), bent]), /profile square10 is not planar/);
});
