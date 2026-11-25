// Sewing loose faces into solids: the six faces of a cube, exactly and across a 0.1 micrometre gap; a gap past the
// tolerance left open and reported, never a solid; faces given the wrong way round turned over; one edge against two
// split; three faces on one edge refused; curved faces (a cylinder's side and caps); and trimmed IGES faces read from
// a file and sewn. Every volume against its closed form.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseIGES } from '../dist/index.js';
import { writeIGES } from './iges-writer.js';

const { Body, Edge, Face, Vertex, bodiesFromSTEP, checkBody, frameOf, massProperties, sew, validateBody } = model;
const mm = 0.001;

/**
 * A loose planar face through `corners` (mm, counter-clockwise seen from outside) with its own vertices and line
 * edges; `inward` builds it the wrong way round (its normal and loop reversed).
 */
function quad(name, corners, inward = false) {
  const pts = corners.map((c) => c.map((x) => x * mm)),
    sub = (a, b) => a.map((x, k) => x - b[k]),
    cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
    n = cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])),
    len = Math.hypot(...n),
    normal = n.map((x) => (inward ? -x : x) / len),
    face = new Face(name, { kind: 'plane', frame: frameOf(pts[0], normal, sub(pts[1], pts[0])) }, true),
    vs = pts.map((p, k) => new Vertex(`${name}/v${k}`, p)),
    edges = pts.map((p, k) => {
      const q = pts[(k + 1) % pts.length],
        d = sub(q, p),
        l = Math.hypot(...d);
      return new Edge(
        `${name}/e${k}`,
        { kind: 'line', origin: p, direction: d.map((x) => x / l) },
        vs[k],
        vs[(k + 1) % pts.length],
      );
    }),
    loop = face.loop();
  if (inward) for (let k = edges.length - 1; k >= 0; k--) loop.use(edges[k], false);
  else for (const e of edges) loop.use(e, true);
  return face;
}

/** The six faces of [0, a]^3 (mm), the top moved up by `lift`; names of faces to build the wrong way round. */
function cubeFaces(a = 10, lift = 0, inward = []) {
  const t = a + lift,
    faces = [
      [
        '-z',
        [
          [0, 0, 0],
          [0, a, 0],
          [a, a, 0],
          [a, 0, 0],
        ],
      ],
      [
        '+z',
        [
          [0, 0, t],
          [a, 0, t],
          [a, a, t],
          [0, a, t],
        ],
      ],
      [
        '-y',
        [
          [0, 0, 0],
          [a, 0, 0],
          [a, 0, a],
          [0, 0, a],
        ],
      ],
      [
        '+y',
        [
          [0, a, 0],
          [0, a, a],
          [a, a, a],
          [a, a, 0],
        ],
      ],
      [
        '-x',
        [
          [0, 0, 0],
          [0, 0, a],
          [0, a, a],
          [0, a, 0],
        ],
      ],
      [
        '+x',
        [
          [a, 0, 0],
          [a, a, 0],
          [a, a, a],
          [a, 0, a],
        ],
      ],
    ];
  return faces.map(([n, c]) => quad(n, c, inward.includes(n)));
}

function close(actual, expected, what, tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.abs(expected),
    `${what}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / Math.abs(expected)})`,
  );
}

/** A box's closed forms (mm): volume, area, centroid, moments about the centroid. */
function boxMass(a, b, c) {
  const V = a * b * c;
  return {
    V,
    A: 2 * (a * b + b * c + c * a),
    centroid: [a / 2, b / 2, c / 2],
    I: [(V * (b * b + c * c)) / 12, (V * (a * a + c * c)) / 12, (V * (a * a + b * b)) / 12],
  };
}

function expectBox(body, [a, b, c], tolerance) {
  const m = massProperties(body),
    x = boxMass(a, b, c);
  close(m.volume, x.V * mm ** 3, 'volume', tolerance);
  close(m.area, x.A * mm ** 2, 'area', tolerance);
  x.centroid.forEach((v, k) => assert.ok(Math.abs(m.centroid[k] - v * mm) <= tolerance * a * mm, `centroid ${k}`));
  const trace = (x.I[0] + x.I[1] + x.I[2]) * mm ** 5;
  x.I.forEach((v, k) =>
    assert.ok(Math.abs(m.inertia[k] - v * mm ** 5) <= tolerance * trace, `inertia ${k}: ${m.inertia[k]}`),
  );
  for (let k = 3; k < 6; k++) assert.ok(Math.abs(m.inertia[k]) <= tolerance * trace, `product ${k}: ${m.inertia[k]}`);
}

test('sew: the six loose faces of a cube close into a solid, exactly', () => {
  const faces = cubeFaces(),
    before = faces.map((f) => f.loops[0].coedges.map((c) => c.edge.coedges.length).join()),
    r = sew('cube', faces, 1e-6);
  assert.equal(r.closed, true);
  assert.equal(r.body.kind, 'solid');
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.open, []);
  assert.deepEqual(r.flipped, []);
  assert.equal(r.joined.length, 12);
  assert.equal(r.merged.length, 8);
  // Gaps only of rounding (the projections onto the other curve).
  for (const j of r.joined) assert.ok(j.gap <= 1e-15, `gap ${j.gap}`);
  assert.deepEqual([r.body.faces.length, r.body.edges.length, r.body.vertices.length], [6, 12, 8]);
  assert.deepEqual(validateBody(r.body), []);
  assert.deepEqual(checkBody(r.body), []);
  expectBox(r.body, [10, 10, 10], 1e-13);
  // The loose faces are as they were.
  assert.deepEqual(
    faces.map((f) => f.loops[0].coedges.map((c) => c.edge.coedges.length).join()),
    before,
  );
});

test('sew: a 0.1 micrometre gap closes within the tolerance and is reported; past the tolerance it stays open', () => {
  // The top face 1e-7 m up: its four edges meet the sides' top edges 1e-7 m away.
  const lift = 1e-4,
    r = sew('cube', cubeFaces(10, lift), 1e-6);
  assert.equal(r.closed, true);
  assert.deepEqual(validateBody(r.body), []);
  assert.deepEqual(checkBody(r.body), []);
  const gaps = r.joined.filter((j) => j.gap > 1e-12).map((j) => j.gap);
  assert.equal(gaps.length, 4);
  for (const g of gaps) close(g, lift * mm, 'gap', 1e-6);
  assert.equal(r.merged.filter((m) => m.gap > 1e-12).length, 4);
  // Edges and vertices hold the gap as their tolerance.
  for (const j of r.joined) {
    const e = r.body.edges.find((x) => x.name === j.edges[0]);
    assert.ok(e.tolerance >= j.gap, `${e.name}: tolerance ${e.tolerance} for a gap of ${j.gap}`);
  }
  // The sides reach the top face's edges: a box 10 x 10 x (10 + lift) with its top edges where the top face put them.
  close(massProperties(r.body).volume, 100 * (10 + lift) * mm ** 3, 'volume', 1e-12);

  // A 10 micrometre gap with a 1 micrometre tolerance: a sheet, its eight edges along the gap reported open with the
  // distance across it, and never a solid.
  const far = sew('cube', cubeFaces(10, 0.01), 1e-6);
  assert.equal(far.closed, false);
  assert.equal(far.body.kind, 'sheet');
  assert.equal(far.open.length, 8);
  for (const o of far.open) close(o.gap, 0.01 * mm, `open ${o.edge}`, 1e-6);
  // Its other edges are joined.
  assert.equal(far.joined.length, 8);
});

test('sew: faces given the wrong way round are turned over, and an inside-out shell faces out', () => {
  const r = sew('cube', cubeFaces(10, 0, ['+z', '-x']), 1e-6);
  assert.equal(r.closed, true);
  assert.deepEqual([...r.flipped].sort(), ['+z', '-x'].sort());
  assert.deepEqual(checkBody(r.body), []);
  expectBox(r.body, [10, 10, 10], 1e-13);
  const all = ['-z', '+z', '-y', '+y', '-x', '+x'],
    out = sew('cube', cubeFaces(10, 0, all), 1e-6);
  assert.equal(out.closed, true);
  assert.deepEqual([...out.flipped].sort(), [...all].sort());
  assert.deepEqual(checkBody(out.body), []);
  close(massProperties(out.body).volume, 1000 * mm ** 3, 'volume', 1e-13);
});

test('sew: one edge against two is split where the other face has a vertex', () => {
  // The -y side in two halves (x 0 to 4, 4 to 10): the bottom's and top's edges along y = 0 each meet two edges.
  const faces = cubeFaces().filter((f) => f.name !== '-y');
  faces.push(
    quad('-y0', [
      [0, 0, 0],
      [4, 0, 0],
      [4, 0, 10],
      [0, 0, 10],
    ]),
    quad('-y1', [
      [4, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [4, 0, 10],
    ]),
  );
  const r = sew('cube', faces, 1e-6);
  assert.equal(r.closed, true, JSON.stringify(r.problems));
  assert.deepEqual(
    r.split.map((s) => s.into.length),
    [2, 2],
  );
  assert.deepEqual([r.body.faces.length, r.body.edges.length, r.body.vertices.length], [7, 15, 10]);
  assert.deepEqual(checkBody(r.body), []);
  expectBox(r.body, [10, 10, 10], 1e-13);
});

test('sew: three faces on one edge are refused, and no faces or a bad tolerance throw', () => {
  // Two cubes' faces sharing the plane x = 10 would be fine as a sheet; a fin on a cube's edge is not manifold.
  const fin = quad('fin', [
      [10, 0, 10],
      [10, 10, 10],
      [15, 10, 15],
      [15, 0, 15],
    ]),
    r = sew('cube', [...cubeFaces(), fin], 1e-6);
  assert.equal(r.closed, false);
  assert.equal(r.body.kind, 'sheet');
  assert.ok(r.problems.some((p) => /lies along 2 other edges/.test(p.problem)));
  assert.throws(() => sew('x', [], 1e-6), { name: 'RangeError' });
  for (const t of [0, -1, NaN, Infinity]) assert.throws(() => sew('x', cubeFaces(), t), { name: 'RangeError' });
});

test('sew: a cylinder from its loose side and caps; bodies as input', () => {
  // Side: a cylinder face with its own seam line (used both ways) and two circles; caps: discs with their own circles,
  // their vertices at the seam's ends.
  const r = 4 * mm,
    h = 6 * mm,
    axis = frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]),
    top = frameOf([0, 0, h], [0, 0, 1], [1, 0, 0]),
    circle = (name, frame, at) => new Edge(name, { kind: 'circle', frame, radius: r }, at, at),
    side = new Face('side', { kind: 'cylinder', frame: axis, radius: r }, true),
    s0 = new Vertex('s0', [r, 0, 0]),
    s1 = new Vertex('s1', [r, 0, h]),
    seam = new Edge('seam', { kind: 'line', origin: [r, 0, 0], direction: [0, 0, 1] }, s0, s1),
    loop = side.loop();
  loop.use(circle('low', axis, s0), true);
  loop.use(seam, true);
  loop.use(circle('high', top, s1), false);
  loop.use(seam, false);
  const disc = (name, frame, normal, forward) => {
    const f = new Face(name, { kind: 'plane', frame: frameOf(frame.origin, normal, [1, 0, 0]) }, true),
      v = new Vertex(`${name}/v`, [r, 0, frame.origin[2]]);
    f.loop().use(circle(`${name}/c`, frame, v), forward);
    return f;
  };
  const bottom = disc('bottom', axis, [0, 0, -1], false),
    cap = disc('top', top, [0, 0, 1], true),
    sheet = new Body('loose', 'sheet');
  for (const f of [side, bottom, cap]) sheet.shell().add(f);
  const sewn = sew('cyl', [sheet], 1e-6);
  assert.equal(sewn.closed, true, JSON.stringify(sewn.problems));
  assert.deepEqual(checkBody(sewn.body), []);
  close(massProperties(sewn.body).volume, Math.PI * r * r * h, 'volume', 1e-13);
  close(massProperties(sewn.body).area, 2 * Math.PI * r * (r + h), 'area', 1e-13);
});

test('sew: trimmed IGES faces (144) of a cube read as loose faces and sew into a solid', () => {
  // Each face a trimmed surface: a bilinear B-spline plane (128) bounded by a model-space loop of four lines (102 of
  // 110s, through a curve on surface 142). The file holds no topology: six separate faces.
  const list = [],
    add = (e) => {
      list.push(e);
      return { ref: list.length - 1 };
    },
    a = 10;
  for (const [, c] of [
    [
      '-z',
      [
        [0, 0, 0],
        [0, a, 0],
        [a, a, 0],
        [a, 0, 0],
      ],
    ],
    [
      '+z',
      [
        [0, 0, a],
        [a, 0, a],
        [a, a, a],
        [0, a, a],
      ],
    ],
    [
      '-y',
      [
        [0, 0, 0],
        [a, 0, 0],
        [a, 0, a],
        [0, 0, a],
      ],
    ],
    [
      '+y',
      [
        [0, a, 0],
        [0, a, a],
        [a, a, a],
        [a, a, 0],
      ],
    ],
    [
      '-x',
      [
        [0, 0, 0],
        [0, 0, a],
        [0, a, a],
        [0, a, 0],
      ],
    ],
    [
      '+x',
      [
        [a, 0, 0],
        [a, a, 0],
        [a, a, a],
        [a, 0, a],
      ],
    ],
  ]) {
    // Corners p00, p10, p01, p11 of the patch: u along the first side, v along the last (outward normal Su x Sv).
    const [p0, p1, p2, p3] = c,
      surface = add({
        type: 128,
        params: [1, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1, 1, ...p0, ...p1, ...p3, ...p2, 0, 1, 0, 1],
        status: '00010000',
      }),
      lines = c.map((p, k) => add({ type: 110, params: [...p, ...c[(k + 1) % 4]], status: '00010000' })),
      loop = add({ type: 102, params: [4, ...lines], status: '00010000' }),
      bound = add({ type: 142, params: [0, surface, 0, loop, 2], status: '00010000' });
    add({ type: 144, params: [surface, 1, 0, bound] });
  }
  const step = parseIGES(writeIGES(list)),
    read = bodiesFromSTEP(step),
    faces = read.bodies.filter(Boolean).flatMap((b) => b.faces);
  assert.equal(faces.length, 6);
  const r = sew('cube', faces, 1e-6);
  assert.equal(r.closed, true, JSON.stringify(r.problems));
  assert.deepEqual(checkBody(r.body), []);
  close(massProperties(r.body).volume, 1000 * mm ** 3, 'volume', 1e-12);
  close(massProperties(r.body).area, 600 * mm ** 2, 'area', 1e-12);
});

test('sew: an edge and a face within the tolerance are dropped; vertices chained past it are refused', () => {
  // The +x face with an extra corner 0.01 micrometre from (10, 0, 0): the edge between them drops, the cube closes.
  const faces = cubeFaces().filter((f) => f.name !== '+x');
  faces.push(
    quad('+x', [
      [10, 0, 0],
      [10, 10, 0],
      [10, 10, 10],
      [10, 0, 10],
      [10, 0, 1e-5],
    ]),
  );
  // And a sliver face 0.01 micrometre across, inside the tolerance everywhere.
  faces.push(
    quad('sliver', [
      [3, 3, 3],
      [3 + 1e-5, 3, 3],
      [3 + 1e-5, 3 + 1e-5, 3],
      [3, 3 + 1e-5, 3],
    ]),
  );
  const r = sew('cube', faces, 1e-6);
  assert.equal(r.closed, true, JSON.stringify(r.problems));
  assert.ok(r.dropped.includes('+x/e4'));
  assert.ok(r.dropped.includes('sliver'));
  assert.equal(r.body.faces.length, 6);
  assert.deepEqual(checkBody(r.body), []);
  expectBox(r.body, [10, 10, 10], 1e-12);
  // Four corners 0.9 micrometre apart in a row, each within the tolerance of the next: 1.35 micrometres from where
  // they would meet, past the tolerance.
  const row = [0, 1, 2, 3].map((k) =>
      quad(`q${k}`, [
        [k * 9e-4, 0, 0],
        [k * 9e-4 + 5, -5 - k, 0],
        [k * 9e-4 + 5, -5 - k, 5],
        [k * 9e-4, 0, 5],
      ]),
    ),
    chained = sew('row', row, 1e-6);
  assert.equal(chained.closed, false);
  assert.ok(
    chained.problems.some((p) => /spread .* more than the tolerance/.test(p.problem)),
    JSON.stringify(chained.problems),
  );
});

test('sew: closed shells nested in others are sorted into cavities and solids inside them', () => {
  const B = (n, o, s) =>
    model.box(
      n,
      [s * mm, s * mm, s * mm],
      frameOf(
        o.map((x) => x * mm),
        [0, 0, 1],
        [1, 0, 0],
      ),
    );
  const expectSorted = (r, kinds, volume) => {
    assert.equal(r.closed, true, JSON.stringify(r.problems));
    assert.equal(r.body.kind, 'solid');
    assert.deepEqual(r.problems, []);
    assert.deepEqual(checkBody(r.body), []);
    assert.deepEqual(
      r.body.shells.map((s) => (s.outer ? `cavity of ${r.body.shells.indexOf(s.outer)}` : 'solid')),
      kinds,
    );
    const v = massProperties(r.body).volume;
    assert.ok(Math.abs(v - volume * mm ** 3) <= 1e-12 * volume * mm ** 3, `volume ${v / mm ** 3} vs ${volume}`);
  };
  // A box in a box: the inner one's faces turned to face into the cavity (all six reported flipped).
  const cavity = sew('s', [B('a', [0, 0, 0], 20), B('b', [5, 5, 5], 10)], 1e-9);
  expectSorted(cavity, ['solid', 'cavity of 0'], 8000 - 1000);
  assert.equal(cavity.flipped.length, 6);
  // A whole sphere (a face with no edges) as the cavity.
  expectSorted(
    sew('s', [B('a', [0, 0, 0], 20), model.sphere('b', 5 * mm, frameOf([10 * mm, 10 * mm, 10 * mm], [0, 0, 1]))], 1e-9),
    ['solid', 'cavity of 0'],
    8000 - (4 / 3) * Math.PI * 125,
  );
  // A solid inside a cavity inside a solid; two cavities side by side; two solids apart.
  expectSorted(
    sew('s', [B('a', [0, 0, 0], 30), B('b', [5, 5, 5], 20), B('c', [10, 10, 10], 10)], 1e-9),
    ['solid', 'cavity of 0', 'solid'],
    27000 - 8000 + 1000,
  );
  expectSorted(
    sew('s', [B('a', [0, 0, 0], 30), B('b', [2, 2, 2], 10), B('c', [15, 15, 15], 10)], 1e-9),
    ['solid', 'cavity of 0', 'cavity of 0'],
    27000 - 2000,
  );
  expectSorted(sew('s', [B('a', [0, 0, 0], 10), B('b', [20, 0, 0], 10)], 1e-9), ['solid', 'solid'], 2000);
});
