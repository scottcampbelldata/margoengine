import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, orient3d, parseSTEP } from '../dist/index.js';

const {
  boolean,
  bodiesToSTEP,
  box,
  curveEvaluator,
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
  at = (x, y, z, axis = [0, 0, 1], dir = [1, 0, 0]) => frameOf([x * mm, y * mm, z * mm], axis, dir),
  // An 80 mm box's frame, tilted, with its -z face 2 mm below the origin: that face crosses a torus about z obliquely.
  tilted = (() => {
    const f = frameOf([0, 0, 0], [0.3, 0.1, 1], [1, 0, 0]),
      o = [0, 1, 2].map((k) => (-40 * f.x[k] - 40 * f.y[k] - 2 * f.z[k]) * mm);
    return frameOf(o, f.z, f.x);
  })();

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
  const cap = boolean('cap', 'intersect', ball(), block()),
    rest = boolean('rest', 'subtract', ball(), block());
  solid(cap, capVolume, 2 * Math.PI * 10 * h + disc);
  solid(rest, (4 / 3) * Math.PI * 1000 - capVolume, 4 * Math.PI * 100 - 2 * Math.PI * 10 * h + disc);
  // As other readers expect it: the rest goes round its sphere, so its face is cut open by a seam edge from pole to
  // pole, used once each way; the cap goes round nothing and is written as it is.
  const written = bodiesToSTEP([rest]),
    seam = written.match(/#(\d+)=EDGE_CURVE\('s\/face:surface\/edge:seam:0',(#\d+),(#\d+),/);
  assert.ok(seam, 'a seam edge');
  for (const sense of ['T', 'F']) assert.ok(written.includes(`ORIENTED_EDGE('',*,*,#${seam[1]},.${sense}.)`));
  assert.match(written, new RegExp(`${seam[2]}=VERTEX_POINT\\('s/face:surface/vertex:pole:-'`));
  assert.match(written, new RegExp(`${seam[3]}=VERTEX_POINT\\('s/face:surface/vertex:pole:\\+'`));
  assert.deepEqual(
    parseSTEP(written).bodies.map((x) => [x.kind, x.faces.length]),
    [['solid', 2]],
  );
  assert.doesNotMatch(bodiesToSTEP([cap]), /edge:seam/);
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

test('STEP export: a traced loop is written in pieces that turn half a turn at most', () => {
  // A torus less the tilted box keeps one traced loop, a closed edge. OpenCascade's default GProp integrates each edge
  // with a fixed number of points and read it 3% too large written as one edge.
  const cut = boolean('s', 'subtract', torus('t', 20 * mm, 5 * mm), box('b', [80 * mm, 80 * mm, 80 * mm], tilted)),
    [loop] = cut.edges;
  assert.equal(cut.edges.length, 1);
  assert.ok(loop.closed && loop.curve.kind === 'spline');
  const written = bodiesToSTEP([cut]),
    points = new Map(
      [...written.matchAll(/#(\d+)=CARTESIAN_POINT\('',\(([^)]*)\)\)/g)].map((m) => [
        m[1],
        m[2].split(',').map(Number),
      ]),
    ),
    vertices = new Map(
      [...written.matchAll(/#(\d+)=VERTEX_POINT\('[^']*',#(\d+)\)/g)].map((m) => [m[1], points.get(m[2])]),
    ),
    pieces = [...written.matchAll(/=EDGE_CURVE\('([^']*)',#(\d+),#(\d+),#\d+,\.([TF])\.\)/g)];
  assert.ok(pieces.length > 1 && pieces.every((m) => m[1] === loop.name));
  // Each piece's turn: the angles between tangents sampled along the loop's curve between its vertices.
  const c = curveEvaluator(loop.curve),
    angle = (a, b) =>
      Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b))));
  for (const [, , start, end, sense] of pieces) {
    const [from, to] = sense === 'T' ? [start, end] : [end, start],
      t0 = c.parameter(vertices.get(from));
    let t1 = c.parameter(vertices.get(to)),
      turn = 0;
    if (t1 <= t0) t1 += c.period;
    for (let k = 1; k <= 200; k++)
      turn += angle(c.at(t0 + ((t1 - t0) * (k - 1)) / 200).slice(3), c.at(t0 + ((t1 - t0) * k) / 200).slice(3));
    assert.ok(turn <= Math.PI + 0.01, `a piece turns ${turn.toFixed(3)} rad`);
  }
  assert.deepEqual(
    parseSTEP(written).bodies.map((x) => [x.kind, x.faces.length]),
    [['solid', 2]],
  );
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

test('Booleans where the surfaces touch tangentially: two equal cylinders crossed, a hole touching a drill wall', () => {
  // Two equal cylinders at right angles touch where their curves cross: union, common part (the Steinmetz solid,
  // 16 r^3 / 3) and difference to their closed forms.
  const r = 10,
    length = 60,
    rod = Math.PI * r * r * length,
    steinmetz = (16 * r ** 3) / 3,
    volume = (b) => model.massProperties(b).volume / mm ** 3,
    a = () => cylinder('a', r * mm, length * mm, at(0, 0, -30)),
    b = () => cylinder('b', r * mm, length * mm, at(-30, 0, 0, [1, 0, 0], [0, 1, 0]));
  for (const [op, want] of [
    ['union', 2 * rod - steinmetz],
    ['intersect', steinmetz],
    ['subtract', rod - steinmetz],
  ]) {
    const out = boolean('y', op, a(), b());
    assert.deepEqual(validateBody(out), []);
    assert.ok(Math.abs(volume(out) - want) <= 1e-7 * want, `${op}: ${volume(out)} vs ${want}`);
  }
  // A slanted 0.5 mm hole whose axis passes 1 mm from a 1.5 mm drill's touches the drill wall from inside at one
  // point, where the two windows it cuts in the wall meet and their curve crosses itself. Whatever way the hole's seam
  // faces, the block keeps 8000 less the drill and the part of the hole outside it (that part by quadrature over the
  // hole's section: inside the drill a chord of 2 sqrt(2.25 - x^2) / cos a).
  const slant = 0.2,
    dir = [0, Math.cos(slant), -Math.sin(slant)],
    n = 1000;
  let shared = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const rho = (0.5 * (i + 0.5)) / n,
        x = 1 + rho * Math.cos((2 * Math.PI * (j + 0.5)) / n);
      shared += ((2 * Math.sqrt(Math.max(0, 2.25 - x * x))) / Math.cos(slant)) * rho * (0.5 / n) * ((2 * Math.PI) / n);
    }
  const want = 8000 - Math.PI * 2.25 * 20 - ((Math.PI * 0.25 * 20) / Math.cos(slant) - shared);
  for (const seam of [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0.2, 1],
  ]) {
    const block = box('k', [20 * mm, 20 * mm, 20 * mm], at(-10, -10, -10)),
      hole = cylinder('s', 0.5 * mm, 40 * mm, frameOf([1 * mm, -20 * dir[1] * mm, -20 * dir[2] * mm], dir, seam)),
      drill = cylinder('h', 1.5 * mm, 40 * mm, at(0, 0, -20)),
      out = boolean('d', 'subtract', boolean('p', 'subtract', block, hole), drill);
    assert.deepEqual(validateBody(out), []);
    assert.ok(Math.abs(volume(out) - want) <= 1e-6 * want, `seam ${seam}: ${volume(out)} vs ${want}`);
  }
});

test('Booleans where the surfaces touch along a line: a drill as wide as a rib', () => {
  // A 3 mm drill through a 3 mm rib grazes both its walls along a line: the rib is left two halves meeting along those
  // lines. Standing on a base, the drill goes on into it and touches the corners where the walls meet the base's top.
  // Whichever way the drill's seam faces (along a line it grazes, or not), union, common part and difference come to
  // their closed forms.
  const volume = (b) => model.massProperties(b).volume / mm ** 3,
    disk = Math.PI * 2.25,
    rib = () => box('r', [3 * mm, 20 * mm, 10 * mm], at(-1.5, -10, 0)),
    tee = () => boolean('t', 'union', box('b', [20 * mm, 20 * mm, 10 * mm], at(-10, -10, -10)), rib());
  for (const seam of [
    [1, 0, 0],
    [0.6, 0.8, 0],
  ])
    for (const [part, size, through] of [
      [rib, 600, 10],
      [tee, 4600, 20],
    ])
      for (const [op, want] of [
        ['union', size + (40 - through) * disk],
        ['intersect', through * disk],
        ['subtract', size - through * disk],
      ]) {
        const out = boolean('c', op, part(), cylinder('h', 1.5 * mm, 40 * mm, at(0, 0, -20, [0, 0, 1], seam)));
        assert.deepEqual(validateBody(out), []);
        assert.ok(Math.abs(volume(out) - want) <= 1e-9 * want, `${op} seam ${seam}: ${volume(out)} vs ${want}`);
      }
});

test('Booleans where the surfaces come within the tolerance of touching: cut as if they touched', () => {
  // Surfaces closer than the Booleans' tolerance (1e-6 of the model, about 21 nm here) touch. A drill as wide as a rib,
  // 0.1 nm off centre, stops 0.1 nm short of one wall and dips 0.1 nm into the other: on its own, on a base, and on a
  // base with 3 mm fillets where the walls meet it. The drill touches each fillet at a point, where wall and fillet
  // meet; the surfaces curve apart every way there, so 0.1 nm into a fillet is a loop a micrometre across that is only a
  // touch. Either way off centre, whichever way the seam faces, union, common part and difference come to the closed
  // forms of the drill on centre.
  const volume = (b) => model.massProperties(b).volume / mm ** 3,
    disk = Math.PI * 2.25,
    rib = () => box('r', [3 * mm, 20 * mm, 10 * mm], at(-1.5, -10, 0)),
    tee = () => boolean('t', 'union', box('b', [20 * mm, 20 * mm, 10 * mm], at(-10, -10, -10)), rib()),
    rounded = () => model.fillet('f', tee(), ['r/edge:-z:-x', 'r/edge:-z:+x'], 3 * mm);
  for (const off of [1e-7, -1e-7])
    for (const seam of [
      [1, 0, 0],
      [0.6, 0.8, 0],
    ])
      for (const [part, size, through] of [
        [rib, 600, 10],
        [tee, 4600, 20],
        [rounded, 4600 + 360 * (1 - Math.PI / 4), 20],
      ])
        for (const [op, want] of [
          ['union', size + (40 - through) * disk],
          ['intersect', through * disk],
          ['subtract', size - through * disk],
        ]) {
          const out = boolean('c', op, part(), cylinder('h', 1.5 * mm, 40 * mm, at(off, 0, -20, [0, 0, 1], seam)));
          assert.deepEqual(validateBody(out), []);
          assert.ok(
            Math.abs(volume(out) - want) <= 1e-9 * want,
            `${op} ${off} seam ${seam}: ${volume(out)} vs ${want}`,
          );
        }
  // 30 and 100 nm off centre, past the tolerance: the circles the drill leaves in the rib's top and bottom faces pass
  // that far inside the edges along the wall it falls short of, and it cuts a sliver that deep out of the other wall (a
  // circular segment of height |off|). The faces' points inside are taken away from their edges, and a point of the
  // base's sliver, no thicker than the tolerance, is settled by rays. On the base the drill is whole; with the fillets,
  // the sliver below z = 3 lies in the fillet but for sqrt(6 d - d^2) under the fillet at depth d (quadrature).
  const r = 1.5,
    segment = (h) => r * r * Math.acos((r - h) / r) - (r - h) * Math.sqrt(2 * r * h - h * h),
    under = (h) => {
      let sum = 0;
      for (let k = 0; k < 2000; k++) {
        const f = ((k + 0.5) / 2000) * (Math.PI / 2),
          [s, c] = [Math.sin(f), Math.cos(f)],
          d = h * s * s;
        sum += 4 * h * s * c * Math.sqrt(2 * r * h * c * c - (h * c * c) ** 2) * Math.sqrt(6 * d - d * d);
      }
      return (sum * Math.PI) / 2 / 2000;
    };
  for (const off of [3e-5, -3e-5, 1e-4, -1e-4])
    for (const seam of [
      [1, 0, 0],
      [0.6, 0.8, 0],
    ])
      for (const [part, size, base, filleted] of [
        [rib, 600, 0, false],
        [tee, 4600, 10, false],
        [rounded, 4600 + 360 * (1 - Math.PI / 4), 10, true],
      ]) {
        const h = Math.abs(off),
          common = base * disk + 10 * (disk - segment(h)) + (filleted ? 3 * segment(h) - under(h) : 0);
        for (const [op, want] of [
          ['union', size + 40 * disk - common],
          ['intersect', common],
          ['subtract', size - common],
        ]) {
          const out = boolean('c', op, part(), cylinder('h', 1.5 * mm, 40 * mm, at(off, 0, -20, [0, 0, 1], seam)));
          assert.deepEqual(validateBody(out), []);
          assert.ok(
            Math.abs(volume(out) - want) <= 1e-9 * want,
            `${op} ${off} seam ${seam}: ${volume(out)} vs ${want}`,
          );
        }
      }
  // The slanted hole 1 nm and 10 nm either side of touching the drill wall: the two windows it cuts in the wall, or the
  // one window they make, pass a few micrometres from crossing at the touch, and are cut as if they crossed there. 30,
  // 50 and 100 nm either side, past the tolerance, their curves are followed round where they turn, about 10 um apart
  // there, without stepping from one onto the other. The block keeps what the quadrature gives for the hole's axis that
  // far off.
  const slant = 0.2,
    dir = [0, Math.cos(slant), -Math.sin(slant)],
    n = 1000,
    kept = (x0) => {
      let shared = 0;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) {
          const rho = (0.5 * (i + 0.5)) / n,
            x = x0 + rho * Math.cos((2 * Math.PI * (j + 0.5)) / n);
          shared +=
            ((2 * Math.sqrt(Math.max(0, 2.25 - x * x))) / Math.cos(slant)) * rho * (0.5 / n) * ((2 * Math.PI) / n);
        }
      return 8000 - Math.PI * 2.25 * 20 - ((Math.PI * 0.25 * 20) / Math.cos(slant) - shared);
    };
  for (const off of [1e-6, -1e-6, 1e-5, -1e-5, 3e-5, -3e-5, 5e-5, -5e-5, 1e-4, -1e-4]) {
    const want = kept(1 + off);
    for (const seam of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0.2, 1],
    ]) {
      const block = box('k', [20 * mm, 20 * mm, 20 * mm], at(-10, -10, -10)),
        hole = cylinder(
          's',
          0.5 * mm,
          40 * mm,
          frameOf([(1 + off) * mm, -20 * dir[1] * mm, -20 * dir[2] * mm], dir, seam),
        ),
        drill = cylinder('h', 1.5 * mm, 40 * mm, at(0, 0, -20)),
        out = boolean('d', 'subtract', boolean('p', 'subtract', block, hole), drill);
      assert.deepEqual(validateBody(out), []);
      assert.ok(Math.abs(volume(out) - want) <= 1e-6 * want, `${off} seam ${seam}: ${volume(out)} vs ${want}`);
    }
  }
});

test('Booleans: what is not supported yet throws a RangeError', () => {
  // A box whose face runs through a torus's axis cuts the torus round its tube, in two circles: a loop round a torus's
  // tube is not supported yet.
  assert.throws(
    () =>
      boolean('h', 'intersect', torus('t', 20 * mm, 5 * mm), box('b', [60 * mm, 60 * mm, 60 * mm], at(0, -30, -30))),
    { name: 'RangeError', message: /round a torus's tube/ },
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
