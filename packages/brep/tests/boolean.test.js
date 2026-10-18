import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, orient3d, parseSTEP } from '../dist/index.js';

const {
  boolean,
  bodiesToSTEP,
  box,
  curveSurfaceCrossings,
  cylinder,
  frameOf,
  History,
  meshBodies,
  sphere,
  torus,
  validateBody,
} = model;

const mm = 0.001,
  at = (x, y, z, axis = [0, 0, 1], dir = [1, 0, 0]) => frameOf([x * mm, y * mm, z * mm], axis, dir);

/** Volume, area and open edges of every mesh of a body (a cut can leave several solids), vertices joined where equal. */
function measureAll(body, options = { deflection: 1e-6, angle: 0.1 }) {
  if (!body.faces.length) return { volume: 0, area: 0, open: 0 };
  const total = { volume: 0, area: 0, open: 0 };
  for (const mesh of meshBodies([body], options).meshes) {
    assert.deepEqual(mesh.failures, []);
    const r = measure(mesh);
    total.volume += r.volume;
    total.area += r.area;
    total.open += r.open;
  }
  return total;
}

/** Volume, area and open edges of a mesh, vertices joined where positions are equal. */
function measure(m) {
  const p = m.positions,
    t = m.indices,
    ids = new Map(),
    weld = (i) => {
      const key = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    },
    directed = new Map();
  let volume = 0,
    area = 0;
  for (let k = 0; k < t.length; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
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
  return { volume, area, open };
}

/** Checks a Boolean result is a valid closed solid of the expected volume and area (mm^3, mm^2). */
function solid(body, volume, area) {
  assert.deepEqual(validateBody(body), []);
  const [mesh] = meshBodies([body], { deflection: 1e-6, angle: 0.1 }).meshes,
    r = measure(mesh);
  assert.deepEqual(mesh.failures, []);
  assert.equal(r.open, 0, 'closed');
  assert.ok(Math.abs(r.volume / mm ** 3 - volume) <= 1e-3 * volume, `volume ${r.volume / mm ** 3} vs ${volume}`);
  assert.ok(Math.abs(r.area / mm ** 2 - area) <= 1e-3 * area, `area ${r.area / mm ** 2} vs ${area}`);
}

test('Booleans: two overlapping boxes unite, subtract and intersect exactly', () => {
  // 10 mm cubes, the second moved 5 mm along each axis: they share a 5 mm cube.
  const a = () => box('a', [10 * mm, 10 * mm, 10 * mm]),
    b = () => box('b', [10 * mm, 10 * mm, 10 * mm], at(5, 5, 5));
  solid(boolean('u', 'union', a(), b()), 1875, 1050);
  solid(boolean('s', 'subtract', a(), b()), 875, 600);
  solid(boolean('i', 'intersect', a(), b()), 125, 150);
});

test('Booleans: a hole through a box, a boss on it, a spherical pocket, and two holes one after another', () => {
  const block = () => box('a', [10 * mm, 10 * mm, 10 * mm]),
    r = 2.5;
  solid(
    boolean('hole', 'subtract', block(), cylinder('c', r * mm, 20 * mm, at(5, 5, -5))),
    1000 - Math.PI * r * r * 10,
    600 - 2 * Math.PI * r * r + 2 * Math.PI * r * 10,
  );
  solid(
    boolean('boss', 'union', block(), cylinder('c', r * mm, 10 * mm, at(5, 5, 5))),
    1000 + Math.PI * r * r * 5,
    600 + 2 * Math.PI * r * 5,
  );
  // A 4 mm ball centred on the top face leaves a hemispherical pocket.
  solid(
    boolean('pocket', 'subtract', block(), sphere('s', 4 * mm, at(5, 5, 10))),
    1000 - (2 / 3) * Math.PI * 64,
    600 - Math.PI * 16 + 2 * Math.PI * 16,
  );
  const once = boolean(
      'h1',
      'subtract',
      box('a', [20 * mm, 10 * mm, 10 * mm]),
      cylinder('c1', 2 * mm, 20 * mm, at(5, 5, -5)),
    ),
    twice = boolean('h2', 'subtract', once, cylinder('c2', 3 * mm, 20 * mm, at(14, 5, -5)));
  solid(twice, 2000 - Math.PI * (4 + 9) * 10, 1000 - 2 * Math.PI * (4 + 9) + 2 * Math.PI * (2 + 3) * 10);
});

test('Booleans: a sphere cut by a plane keeps its cap or the rest; a cavity is a second shell, written as a void', () => {
  // A 10 mm ball against a block from x = 3 mm: the cap is 7 mm high, its flat face of radius^2 = 100 - 9.
  const ball = () => sphere('s', 10 * mm),
    block = () => box('b', [30 * mm, 40 * mm, 40 * mm], at(3, -20, -20)),
    h = 7,
    capVolume = (Math.PI * h * h * (30 - h)) / 3,
    disc = Math.PI * 91;
  solid(boolean('cap', 'intersect', ball(), block()), capVolume, 2 * Math.PI * 10 * h + disc);
  solid(
    boolean('rest', 'subtract', ball(), block()),
    (4 / 3) * Math.PI * 1000 - capVolume,
    4 * Math.PI * 100 - 2 * Math.PI * 10 * h + disc,
  );
  const hollow = boolean(
    'hollow',
    'subtract',
    box('a', [10 * mm, 10 * mm, 10 * mm]),
    box('b', [5 * mm, 5 * mm, 5 * mm], at(2.5, 2.5, 2.5)),
  );
  assert.equal(hollow.shells.length, 2);
  assert.equal(hollow.shells.filter((s) => s.outer).length, 1);
  solid(hollow, 875, 750);
  assert.match(bodiesToSTEP([hollow]), /BREP_WITH_VOIDS\('hollow'/);
  assert.deepEqual(
    parseSTEP(bodiesToSTEP([hollow])).bodies.map((x) => [x.kind, x.faces.length]),
    [['solid', 12]],
  );
});

test('Booleans: names survive, splits and new edges are recorded, and STEP keeps the names', () => {
  const history = new History(),
    result = boolean(
      'drill',
      'subtract',
      box('a', [10 * mm, 10 * mm, 10 * mm]),
      cylinder('c', 2.5 * mm, 20 * mm, at(5, 5, -5)),
      { history },
    );
  assert.deepEqual(result.faces.map((f) => f.name).sort(), [
    'a/face:+x',
    'a/face:+y',
    'a/face:+z',
    'a/face:-x',
    'a/face:-y',
    'a/face:-z',
    'c/face:side',
  ]);
  // The top face is still itself (now with a hole); the drill's end caps are gone; the hole's rims are new edges.
  assert.deepEqual(history.resolve('a/face:+z'), ['a/face:+z']);
  assert.deepEqual(history.resolve('c/face:+z'), []);
  assert.deepEqual(history.generatedFrom('c/face:side').sort(), [
    'drill/edge:a/face:+z|c/face:side#0',
    'drill/edge:a/face:-z|c/face:side#0',
  ]);
  const { meshes, faceName } = meshBodies([result]);
  assert.deepEqual(
    [...new Set(meshes[0].faces.map((f) => faceName(f.id)))].sort(),
    result.faces.map((f) => f.name).sort(),
  );
});

test('Booleans on curved pairs (traced curves): intersect + subtract = A, and union = A + B - intersect', () => {
  // Pairs no closed form covers: their curves are traced; volumes must add up across the four operations.
  const tilted = (() => {
    const f = frameOf([0, 0, 0], [0.3, 0.1, 1], [1, 0, 0]),
      o = [0, 1, 2].map((k) => (-40 * f.x[k] - 40 * f.y[k] - 2 * f.z[k]) * mm);
    return frameOf(o, f.z, f.x);
  })();
  // [label, A, B, exact volume of A, of B] (mm^3).
  const pairs = [
    [
      'skew pin through a bar',
      () => cylinder('bar', 20 * mm, 100 * mm, at(0, 0, -50)),
      () => cylinder('pin', 8 * mm, 120 * mm, at(-50, 3, -25, [1, 0, 0.5])),
      Math.PI * 400 * 100,
      Math.PI * 64 * 120,
    ],
    [
      'tee',
      () => cylinder('bar', 20 * mm, 100 * mm, at(0, 0, -50)),
      () => cylinder('pin', 10 * mm, 60 * mm, at(0, 0, 0, [1, 0, 0])),
      Math.PI * 400 * 100,
      Math.PI * 100 * 60,
    ],
    [
      'oblique plane through a torus',
      () => torus('t', 20 * mm, 5 * mm),
      () => box('b', [80 * mm, 80 * mm, 80 * mm], tilted),
      2 * Math.PI ** 2 * 20 * 25,
      80 ** 3,
    ],
    [
      'cylinder through a torus tube',
      () => torus('t', 20 * mm, 5 * mm),
      () => cylinder('c', 3 * mm, 40 * mm, at(20, 1, -20)),
      2 * Math.PI ** 2 * 20 * 25,
      Math.PI * 9 * 40,
    ],
    [
      'sphere through a cylinder wall',
      () => cylinder('c', 10 * mm, 40 * mm, at(0, 0, -20)),
      () => sphere('s', 6 * mm, at(9, 2, 3)),
      Math.PI * 100 * 40,
      (4 / 3) * Math.PI * 216,
    ],
    [
      'two spheres',
      () => sphere('a', 10 * mm),
      () => sphere('b', 8 * mm, at(9, 3, 2)),
      (4 / 3) * Math.PI * 1000,
      (4 / 3) * Math.PI * 512,
    ],
  ];
  for (const [label, A, B, va, vb] of pairs) {
    const ops = Object.fromEntries(
        [
          ['u', 'union', A, B],
          ['i', 'intersect', A, B],
          ['s', 'subtract', A, B],
          ['t', 'subtract', B, A],
        ].map(([k, op, x, y]) => [k, boolean(k, op, x(), y())]),
      ),
      v = Object.fromEntries(
        Object.entries(ops).map(([k, b]) => {
          const r = measureAll(b, { deflection: 1e-6 });
          return [k, { ...r, volume: r.volume / mm ** 3 }];
        }),
      );
    for (const [k, b] of Object.entries(ops)) {
      assert.deepEqual(validateBody(b), [], `${label} ${k}`);
      assert.equal(v[k].open, 0, `${label} ${k} closed`);
    }
    // Within 0.1% of the exact volumes (the meshes' own chord error is up to about 0.05% here); a piece kept or
    // dropped wrongly is far more.
    assert.ok(Math.abs(v.i.volume + v.s.volume - va) <= 1e-3 * va, `${label}: intersect + subtract vs A`);
    assert.ok(Math.abs(v.i.volume + v.t.volume - vb) <= 1e-3 * vb, `${label}: intersect + (B - A) vs B`);
    assert.ok(
      Math.abs(v.u.volume - (va + vb - v.i.volume)) <= 1e-3 * (va + vb),
      `${label}: union vs A + B - intersect`,
    );
  }
});

test('Booleans: coaxial surfaces meet in exact circles (a napkin ring, a torus cut across its axis)', () => {
  // A 10 mm ball less a 3 mm bore through its centre: the napkin ring, (4/3) pi h^3 with h the half height.
  const h = Math.sqrt(100 - 9);
  const ring = boolean(
    'ring',
    'subtract',
    sphere('s', 10 * mm),
    cylinder('c', 3 * mm, 40 * mm, at(-20, 0, 0, [1, 0, 0])),
  );
  const cut = ring.faces
    .flatMap((f) => f.loops.flatMap((l) => l.coedges.map((c) => c.edge)))
    .filter((e) => e.name.startsWith('ring/edge:'));
  assert.ok(cut.length && cut.every((e) => e.curve.kind === 'circle'));
  const r = measureAll(ring);
  assert.equal(r.open, 0);
  assert.ok(Math.abs(r.volume / mm ** 3 - (4 / 3) * Math.PI * h ** 3) <= 1e-3 * (4 / 3) * Math.PI * h ** 3);
  // The half of a torus (major 20, minor 5) below its middle plane.
  const half = measureAll(
    boolean('half', 'intersect', torus('t', 20 * mm, 5 * mm), box('b', [60 * mm, 60 * mm, 30 * mm], at(-30, -30, -30))),
  );
  assert.ok(
    Math.abs(half.volume / mm ** 3 - Math.PI ** 2 * 20 * 25) <= 1e-3 * Math.PI ** 2 * 20 * 25,
    `${half.volume / mm ** 3}`,
  );
});

test('Booleans: faces on one plane, edges along edges and vertices on faces (the usual CAD cases)', () => {
  const cube = (n, x, y, z, sx, sy, sz) => box(n, [sx * mm, sy * mm, sz * mm], at(x, y, z));
  // [label, result, volume mm^3, vertices, edges, faces]
  const cases = [
    [
      'side by side, overlapping',
      () => boolean('u', 'union', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 5, 0, 0, 10, 10, 10)),
      1500,
      8,
      12,
      6,
    ],
    [
      'face to face',
      () => boolean('f', 'union', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 10, 0, 0, 10, 10, 10)),
      2000,
      8,
      12,
      6,
    ],
    [
      'the shared part',
      () => boolean('i', 'intersect', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 5, 0, 0, 10, 10, 10)),
      500,
      8,
      12,
      6,
    ],
    [
      'the rest',
      () => boolean('s', 'subtract', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 5, 0, 0, 10, 10, 10)),
      500,
      8,
      12,
      6,
    ],
    [
      'a box on a box',
      () => boolean('st', 'union', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 2, 2, 10, 6, 6, 5)),
      1180,
      16,
      24,
      11,
    ],
    [
      'a pocket flush with the top',
      () => boolean('p', 'subtract', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 2, 2, 5, 6, 6, 5)),
      820,
      16,
      24,
      11,
    ],
    [
      'a slot through, flush on three sides',
      () => boolean('sl', 'subtract', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 2, 0, 5, 6, 10, 5)),
      700,
      16,
      24,
      10,
    ],
    [
      'the same box twice',
      () => boolean('same', 'union', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 0, 0, 0, 10, 10, 10)),
      1000,
      8,
      12,
      6,
    ],
    [
      'a pipe: a bore as long as the bar',
      () => boolean('pipe', 'subtract', cylinder('c', 5 * mm, 10 * mm), cylinder('h', 3 * mm, 10 * mm)),
      Math.PI * 16 * 10,
      4,
      6,
      4,
    ],
  ];
  for (const [label, make, volume, v, e, f] of cases) {
    const body = make(),
      r = measureAll(body);
    assert.deepEqual(validateBody(body), [], label);
    assert.equal(r.open, 0, `${label}: closed`);
    assert.ok(
      Math.abs(r.volume / mm ** 3 - volume) <= 1e-3 * volume,
      `${label}: volume ${r.volume / mm ** 3} vs ${volume}`,
    );
    // Faces on one surface are one face again, and edges split along their length are one edge.
    assert.deepEqual([body.vertices.length, body.edges.length, body.faces.length], [v, e, f], label);
  }
  // The united boxes keep the names of the faces they came from.
  const united = boolean('u', 'union', cube('a', 0, 0, 0, 10, 10, 10), cube('b', 5, 0, 0, 10, 10, 10));
  assert.deepEqual(united.faces.map((x) => x.name).sort(), [
    'a/face:+y',
    'a/face:+z',
    'a/face:-x',
    'a/face:-y',
    'a/face:-z',
    'b/face:+x',
  ]);
});

test('Booleans: what is not supported yet throws a RangeError that says so', () => {
  // Two equal cylinders at right angles touch tangentially where their curves cross.
  assert.throws(
    () =>
      boolean(
        'y',
        'union',
        cylinder('a', 10 * mm, 60 * mm, at(0, 0, -30)),
        cylinder('b', 10 * mm, 60 * mm, at(-30, 0, 0, [1, 0, 0])),
      ),
    { name: 'RangeError', message: /touch tangentially/ },
  );
});

test('exact predicates and crossings: orient3d is exact; crossings closer than any sampling are both found', () => {
  assert.equal(orient3d([0, 0, 0], [1, 0, 0], [0, 1, 0], [0.3, 0.3, 0]), 0);
  assert.ok(orient3d([0, 0, 0], [1, 0, 0], [0, 1, 0], [0.3, 0.3, 2 ** -70]) < 0);
  assert.ok(orient3d([0, 0, 0], [1, 0, 0], [0, 1, 0], [0.3, 0.3, -(2 ** -70)]) > 0);
  // Large coordinates: the plane x + y + z = 3e15 through three points, a fourth an ulp off it.
  const big = 1e15;
  assert.equal(
    orient3d([big, big, big], [big + 2, big - 1, big - 1], [big - 1, big + 2, big - 1], [big + 1, big + 1, big - 2]),
    0,
  );
  // A line passing 1 nm inside a 10 mm ball crosses it twice, 2 * sqrt(2 * 10 mm * 1 nm) = 8.9 um apart.
  const ball = { kind: 'sphere', frame: frameOf([0, 0, 0], [0, 0, 1]), radius: 0.01 },
    line = { kind: 'line', origin: [-0.02, 0.01 - 1e-9, 0], direction: [1, 0, 0] },
    ts = curveSurfaceCrossings(line, ball, 0, 0.04);
  assert.equal(ts.length, 2);
  const half = Math.sqrt(0.01 ** 2 - (0.01 - 1e-9) ** 2);
  assert.ok(Math.abs(ts[0] - (0.02 - half)) < 1e-12 && Math.abs(ts[1] - (0.02 + half)) < 1e-12, `${ts}`);
});
