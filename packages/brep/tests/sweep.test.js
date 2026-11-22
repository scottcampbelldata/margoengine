// Sweeps of a profile along lines and arcs, against closed forms: Pappus and Guldin for volume and area (the profile's
// area or perimeter times the length of the path its centroid follows), the centroid and inertia of a part torus, a
// circle swept once round a circle against the torus primitive, a STEP round trip, and the sweeps that must be refused
// (corners, arcs tighter than the profile, paths whose pieces would carry the profile into each other).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const { bodiesFromSTEP, bodiesToSTEP, checkBody, cylinder, massProperties, meshBodies, sweep, torus, validateBody } =
  model;
const mm = 0.001;
const P = (x, y, z) => [x * mm, y * mm, z * mm];

function close(actual, expected, what, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1e-300),
    `${what}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / Math.abs(expected)})`,
  );
}

/** A circle of radius r (mm) about c in the plane across n, starting along x. */
function disc(c, n, r, x) {
  const s = P(c[0] + r * x[0], c[1] + r * x[1], c[2] + r * x[2]);
  return { name: 'prof', start: s, normal: n, segments: [{ kind: 'arc', to: s, center: P(...c) }] };
}

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

test('sweep: a circle along a line is the cylinder', () => {
  const s = sweep('s', disc([0, 0, 0], [0, 0, 1], 1, [1, 0, 0]), {
    name: 'path',
    start: P(0, 0, 0),
    segments: [{ kind: 'line', to: P(0, 0, 10) }],
  });
  clean(s);
  const m = massProperties(s),
    c = massProperties(cylinder('c', 1 * mm, 10 * mm));
  close(m.volume, 10 * Math.PI * mm ** 3, 'volume');
  close(m.area, (20 * Math.PI + 2 * Math.PI) * mm ** 2, 'area');
  m.centroid.forEach((x, k) => assert.ok(Math.abs(x - c.centroid[k]) <= 1e-12 * mm, `centroid ${k}`));
  m.inertia.forEach((x, k) => assert.ok(Math.abs(x - c.inertia[k]) <= 1e-12 * c.inertia[0], `inertia ${k}`));
  assert.deepEqual(
    s.faces.map((f) => [f.name, f.surface.kind]),
    [
      ['s/face:p0/e0', 'cylinder'],
      ['s/face:start', 'plane'],
      ['s/face:end', 'plane'],
    ],
  );
});

test('sweep: a circle along a quarter circle is a quarter torus (Pappus, its centroid and inertia)', () => {
  const R = 10,
    r = 1,
    th = Math.PI / 2,
    s = sweep('s', disc([R, 0, 0], [0, 1, 0], r, [1, 0, 0]), {
      name: 'path',
      start: P(R, 0, 0),
      segments: [{ kind: 'arc', to: P(0, R, 0), center: P(0, 0, 0) }],
    });
  clean(s);
  const m = massProperties(s),
    V = th * Math.PI * r * r * R,
    // Integrals of rho^2 and rho^3 over the profile disc, rho = R + s.
    I2 = Math.PI * r * r * R * R + (Math.PI * r ** 4) / 4,
    I3 = Math.PI * r * r * R ** 3 + (3 * Math.PI * R * r ** 4) / 4,
    cx = (I2 * Math.sin(th)) / V,
    cy = (I2 * (1 - Math.cos(th))) / V;
  close(V, 5 * Math.PI ** 2, 'the harness case O_sweep_arc');
  close(m.volume, V * mm ** 3, 'volume');
  close(m.area, (2 * Math.PI * r * R * th + 2 * Math.PI * r * r) * mm ** 2, 'area');
  close(m.centroid[0], cx * mm, 'centroid x');
  close(m.centroid[1], cy * mm, 'centroid y');
  assert.ok(Math.abs(m.centroid[2]) <= 1e-12 * mm, 'centroid z');
  // Izz about the axis is th times the integral of rho^3; moved to the centroid.
  close(m.inertia[2], (th * I3 - V * (cx * cx + cy * cy)) * mm ** 5, 'Izz');
});

test('sweep: a square along a half turn, and a circle once round a circle equal to the torus primitive', () => {
  const sq = {
    name: 'sq',
    start: P(9, 0, -1),
    normal: [0, 1, 0],
    segments: [
      { kind: 'line', to: P(11, 0, -1) },
      { kind: 'line', to: P(11, 0, 1) },
      { kind: 'line', to: P(9, 0, 1) },
      { kind: 'line', to: P(9, 0, -1) },
    ],
  };
  const half = sweep('h', sq, {
    name: 'path',
    start: P(10, 0, 0),
    segments: [{ kind: 'arc', to: P(-10, 0, 0), center: P(0, 0, 0), axis: [0, 0, 1] }],
  });
  clean(half);
  const mh = massProperties(half);
  close(mh.volume, 4 * 10 * Math.PI * mm ** 3, 'half turn volume');
  // Inner and outer half cylinders, top and bottom half annuli, two end squares.
  close(mh.area, (Math.PI * 2 * (9 + 11) + Math.PI * (121 - 81) + 8) * mm ** 2, 'half turn area');
  assert.deepEqual(half.faces.map((f) => f.surface.kind).sort(), [
    'cylinder',
    'cylinder',
    'plane',
    'plane',
    'plane',
    'plane',
  ]);
  const ring = sweep('r', disc([10, 0, 0], [0, 1, 0], 1, [1, 0, 0]), {
      name: 'path',
      start: P(10, 0, 0),
      segments: [{ kind: 'arc', to: P(10, 0, 0), center: P(0, 0, 0), axis: [0, 0, 1] }],
    }),
    t = massProperties(torus('t', 10 * mm, 1 * mm)),
    mr = massProperties(ring);
  clean(ring);
  assert.equal(ring.faces.length, 1);
  close(mr.volume, t.volume, 'ring volume');
  close(mr.area, t.area, 'ring area');
  mr.inertia.slice(0, 3).forEach((x, k) => close(x, t.inertia[k], `ring inertia ${k}`));
});

test('sweep: a pipe along a line, a bend and a line; a closed stadium ring', () => {
  const pipe = sweep('p', disc([0, 0, 0], [0, 0, 1], 1, [1, 0, 0]), {
    name: 'path',
    start: P(0, 0, 0),
    segments: [
      { kind: 'line', to: P(0, 0, 10) },
      { kind: 'arc', to: P(5, 0, 15), center: P(5, 0, 10) },
      { kind: 'line', to: P(15, 0, 15) },
    ],
  });
  clean(pipe);
  const L = 20 + (5 * Math.PI) / 2,
    mp = massProperties(pipe);
  close(mp.volume, Math.PI * L * mm ** 3, 'pipe volume');
  close(mp.area, (2 * Math.PI * L + 2 * Math.PI) * mm ** 2, 'pipe area');
  assert.equal(pipe.faces.filter((f) => f.surface.kind === 'torus').length, 1);
  const stadium = sweep('st', disc([0, 0, 0], [0, 0, 1], 1, [1, 0, 0]), {
    name: 'path',
    start: P(0, 0, 0),
    segments: [
      { kind: 'line', to: P(0, 0, 10) },
      { kind: 'arc', to: P(3, 0, 10), center: P(1.5, 0, 10), axis: [0, 1, 0] },
      { kind: 'line', to: P(3, 0, 0) },
      { kind: 'arc', to: P(0, 0, 0), center: P(1.5, 0, 0), axis: [0, 1, 0] },
    ],
  });
  clean(stadium);
  assert.equal(stadium.faces.length, 4, 'a ring: no end faces');
  const ms = massProperties(stadium),
    Ls = 20 + 3 * Math.PI;
  close(ms.volume, Math.PI * Ls * mm ** 3, 'stadium volume');
  close(ms.area, 2 * Math.PI * Ls * mm ** 2, 'stadium area');
  // Torus faces swept part way round with their tube whole: the regression for the seam cut on such faces (they
  // threw "no circle round its torus's tube cuts it open" before).
  assert.equal(stadium.faces.filter((f) => f.surface.kind === 'torus').length, 2);
});

test('sweep: STEP round trip of a bent pipe', () => {
  const s = sweep('s', disc([10, 0, 0], [0, 1, 0], 1, [1, 0, 0]), {
      name: 'path',
      start: P(10, 0, 0),
      segments: [{ kind: 'arc', to: P(0, 10, 0), center: P(0, 0, 0) }],
    }),
    read = bodiesFromSTEP(parseSTEP(new TextEncoder().encode(bodiesToSTEP([s]))));
  assert.deepEqual(read.problems, []);
  const [back] = read.bodies;
  assert.deepEqual(validateBody(back), []);
  assert.deepEqual(checkBody(back), []);
  close(massProperties(back).volume, 5 * Math.PI ** 2 * mm ** 3, 'volume read back', 1e-9);
});

test('sweep: corners, tight arcs, crossings and misplaced profiles are refused by name', () => {
  const d = disc([0, 0, 0], [0, 0, 1], 1, [1, 0, 0]),
    up = { kind: 'line', to: P(0, 0, 10) };
  assert.throws(
    () => sweep('s', d, { name: 'path', start: P(0, 0, 0), segments: [up, { kind: 'line', to: P(10, 0, 10) }] }),
    /path path turns a corner at/,
  );
  assert.throws(
    () =>
      sweep('s', d, {
        name: 'path',
        start: P(0, 0, 0),
        segments: [up, { kind: 'arc', to: P(1.6, 0, 10), center: P(0.8, 0, 10), axis: [0, 1, 0] }],
      }),
    /arc p1 \(radius .*\) curves tighter than the profile reaches towards its axis/,
  );
  // Up, over, down past the start, back under and up again into the first piece.
  assert.throws(
    () =>
      sweep('s', d, {
        name: 'path',
        start: P(0, 0, 0),
        segments: [
          up,
          { kind: 'arc', to: P(3, 0, 10), center: P(1.5, 0, 10), axis: [0, 1, 0] },
          { kind: 'line', to: P(3, 0, -5) },
          { kind: 'arc', to: P(0, 0, -5), center: P(1.5, 0, -5), axis: [0, 1, 0] },
          { kind: 'line', to: P(0, 0, 5) },
        ],
      }),
    /pieces .* and .* come within twice the profile's reach of each other .*: the sweep could cross itself/,
  );
  assert.throws(
    () => sweep('s', disc([0, 0, 0], [1, 0, 0], 1, [0, 1, 0]), { name: 'path', start: P(0, 0, 0), segments: [up] }),
    /must lie across the path's tangent at its start/,
  );
  assert.throws(
    () => sweep('s', disc([0, 0, 1], [0, 0, 1], 1, [1, 0, 0]), { name: 'path', start: P(0, 0, 0), segments: [up] }),
    /must lie in the plane through the path's start/,
  );
  assert.throws(
    () =>
      sweep('s', d, {
        name: 'path',
        start: P(0, 0, 0),
        segments: [{ kind: 'arc', to: P(0, 0, 0), center: P(5, 0, 0) }],
      }),
    /needs an axis/,
  );
});
