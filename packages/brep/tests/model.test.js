import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const { revolve, bodiesToSTEP, box, cylinder, extrude, frameOf, History, meshBodies, sphere, torus, validateBody } =
  model;

/** Volume, area and open edges of a mesh in metres, vertices joined where positions are equal. */
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

/** Meshes one body finely and checks it is closed, outward, and of the expected volume and area. */
function solid(body, volume, area) {
  assert.deepEqual(validateBody(body), []);
  const { meshes } = meshBodies([body], { deflection: 1e-6, angle: 0.1 }),
    [mesh] = meshes,
    r = measure(mesh);
  assert.deepEqual(mesh.failures, []);
  assert.equal(r.open, 0, 'closed');
  assert.ok(Math.abs(r.volume - volume) <= 2e-3 * volume, `volume ${r.volume} vs ${volume}`);
  assert.ok(Math.abs(r.area - area) <= 2e-3 * area, `area ${r.area} vs ${area}`);
}

test('modeler: box, cylinder, sphere and torus are valid closed solids of the right size', () => {
  solid(box('box', [0.01, 0.02, 0.03]), 6e-6, 2.2e-3);
  solid(cylinder('cyl', 0.005, 0.008), Math.PI * 25e-6 * 0.008, Math.PI * (2 * 0.005 * 0.008 + 2 * 25e-6));
  solid(sphere('ball', 0.01), (4 / 3) * Math.PI * 1e-6, 4 * Math.PI * 1e-4);
  solid(torus('ring', 0.02, 0.005), 2 * Math.PI ** 2 * 0.02 * 25e-6, 4 * Math.PI ** 2 * 0.02 * 0.005);
});

test('modeler: an extruded slot (lines and arcs) and an oblique prism', () => {
  // A 20 mm x 10 mm slot: two straight sides and two half-circle ends of radius 5 mm, 4 mm tall.
  const slot = extrude(
    'slot',
    {
      name: 'sketch',
      start: [0, -0.005, 0],
      normal: [0, 0, 1],
      segments: [
        { kind: 'line', to: [0.02, -0.005, 0], name: 'low' },
        { kind: 'arc', to: [0.02, 0.005, 0], center: [0.02, 0, 0], name: 'right' },
        { kind: 'line', to: [0, 0.005, 0], name: 'high' },
        { kind: 'arc', to: [0, -0.005, 0], center: [0, 0, 0], name: 'left' },
      ],
    },
    [0, 0, 0.004],
  );
  const area2d = 0.02 * 0.01 + Math.PI * 25e-6,
    perimeter = 0.04 + 2 * Math.PI * 0.005;
  solid(slot, area2d * 0.004, 2 * area2d + perimeter * 0.004);
  // A clockwise triangle extruded along a slant: the volume is base times height either way round.
  const prism = extrude(
    'prism',
    {
      name: 'tri',
      start: [0, 0, 0],
      normal: [0, 0, 1],
      segments: [
        { kind: 'line', to: [0, 0.01, 0] },
        { kind: 'line', to: [0.01, 0, 0] },
        { kind: 'line', to: [0, 0, 0] },
      ],
    },
    [0.003, 0.002, 0.01],
  );
  assert.deepEqual(validateBody(prism), []);
  const r = measure(meshBodies([prism], { deflection: 1e-6 }).meshes[0]);
  assert.equal(r.open, 0);
  assert.ok(Math.abs(r.volume - 5e-5 * 0.01) < 1e-12, `prism volume ${r.volume}`);
});

test('modeler: persistent names reach the mesh and the history, and STEP round trips keep them', () => {
  const history = new History(),
    b = box('base', [0.01, 0.01, 0.01], frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]), history);
  assert.deepEqual(history.generatedFrom('base/profile/+x'), ['base/face:+x']);
  assert.deepEqual(history.resolve('base/face:+x'), ['base/face:+x']);
  const { meshes, faceName } = meshBodies([b]),
    names = meshes[0].faces.map((f) => faceName(f.id)).sort();
  assert.deepEqual(names, [
    'base/face:+x',
    'base/face:+y',
    'base/face:+z',
    'base/face:-x',
    'base/face:-y',
    'base/face:-z',
  ]);
  const model = parseSTEP(bodiesToSTEP([b]));
  assert.deepEqual(
    model.bodies.map((x) => [x.kind, x.name, x.faces.length]),
    [['solid', 'base', 6]],
  );
});

test('modeler: invalid input throws a RangeError that names the problem; validation reports broken topology', () => {
  assert.throws(() => box('b', [0, 1, 1]), { name: 'RangeError', message: /sizes must be positive/ });
  assert.throws(
    () =>
      extrude(
        'open',
        { name: 'p', start: [0, 0, 0], normal: [0, 0, 1], segments: [{ kind: 'line', to: [1, 0, 0] }] },
        [0, 0, 1],
      ),
    { name: 'RangeError', message: /does not end where it starts/ },
  );
  const b = box('broken', [0.01, 0.01, 0.01]);
  // Remove one face: four edges are then used by one loop only.
  b.shells[0].faces.pop();
  const problems = validateBody(b);
  assert.equal(problems.length, 4);
  assert.match(problems[0].problem, /used by 1 face loops/);
});

test('modeler: revolve turns a profile of lines and arcs round an axis (ring, frustum, torus), either way round', () => {
  const axis = { origin: [0, 0, 0], direction: [0, 0, 1] },
    n = [0, 1, 0],
    line = (x, z) => ({ kind: 'line', to: [x * 0.001, 0, z * 0.001] }),
    p = (start, segments, normal = n) => ({
      name: 'p',
      start: [start[0] * 0.001, 0, start[1] * 0.001],
      normal,
      segments,
    });
  solid(
    revolve('ring', p([2, 0], [line(5, 0), line(5, 3), line(2, 3), line(2, 0)]), axis),
    Math.PI * 21 * 3e-9,
    Math.PI * (2 * 21 + 2 * 5 * 3 + 2 * 2 * 3) * 1e-6,
  );
  solid(
    revolve('cw', p([2, 0], [line(2, 3), line(5, 3), line(5, 0), line(2, 0)], [0, -1, 0]), axis),
    Math.PI * 21 * 3e-9,
    Math.PI * (2 * 21 + 2 * 5 * 3 + 2 * 2 * 3) * 1e-6,
  );
  const frustum = revolve('fr', p([2, 0], [line(5, 0), line(3, 3), line(2, 3), line(2, 0)]), axis);
  assert.deepEqual(
    frustum.faces.map((f) => f.surface.kind),
    ['plane', 'cone', 'plane', 'cylinder'],
  );
  solid(
    frustum,
    ((Math.PI * 3 * (25 + 15 + 9)) / 3 - Math.PI * 12) * 1e-9,
    (Math.PI * (25 - 4) + Math.PI * (9 - 4) + Math.PI * (5 + 3) * Math.hypot(2, 3) + 2 * Math.PI * 2 * 3) * 1e-6,
  );
  const arc = (x, z, cx, cz) => ({ kind: 'arc', to: [x * 0.001, 0, z * 0.001], center: [cx * 0.001, 0, cz * 0.001] });
  solid(
    revolve('t', p([6, 0], [arc(4, 0, 5, 0), arc(6, 0, 5, 0)]), axis),
    2 * Math.PI ** 2 * 5 * 1e-9,
    4 * Math.PI ** 2 * 5 * 1e-6,
  );
  assert.throws(() => revolve('x', p([5, 0], [line(5, 3), line(0, 3), line(0, 0), line(5, 0)]), axis), {
    name: 'RangeError',
    message: /touches the axis/,
  });
});

/** A sheet of one plane face bounded by a 1 mm circle through one vertex. */
function disc() {
  const body = new model.Body('disc', 'sheet'),
    face = body.shell().add(new model.Face('face', { kind: 'plane', frame: frameOf([0, 0, 0], [0, 0, 1]) }, true)),
    vertex = new model.Vertex('vertex', [0.001, 0, 0]);
  face
    .loop()
    .use(
      new model.Edge('edge', { kind: 'circle', frame: frameOf([0, 0, 0], [0, 0, 1]), radius: 0.001 }, vertex, vertex),
      true,
    );
  return body;
}

test('modeler: validation sees points, frames and faces moved in place after an earlier check', () => {
  // What validation keeps per edge between calls (end parameters, vertex distances, measured surfaces) must follow the
  // numbers, not only which arrays hold them: the API lets callers move points and frames in place.
  const moved = disc();
  assert.deepEqual(validateBody(moved), []);
  moved.vertices[0].point[2] = 0.001;
  assert.ok(validateBody(moved).some(({ problem }) => problem.includes('off the curve')));
  const imported = model.bodiesFromSTEP(parseSTEP(bodiesToSTEP([disc()]))).bodies[0];
  assert.deepEqual(validateBody(imported), []);
  imported.faces[0].surface.frame.origin[2] = 0.001;
  assert.ok(validateBody(imported).some(({ problem }) => problem.includes('off the surface')));
  const swung = disc();
  assert.deepEqual(validateBody(swung), []);
  swung.edges[0].curve.frame.origin[2] = 0.001;
  assert.ok(validateBody(swung).some(({ problem }) => problem.includes('off the surface')));
});

test('modeler: a spline projection converges where the surface partials nearly align', () => {
  // Su and Sv are 1e-7 from parallel at the start, so a step's linear part is tiny while the surface's curvature still
  // carries the foot a long way: stopping on it left the point 1e-6 m off the surface it lies on.
  const points = Array.from({ length: 3 }, (_, j) =>
      Array.from({ length: 3 }, (_, i) => [i + j - 2, (i - 1) * 1e-7, 4 * (i === 2) + 4 * (j === 2) - 2 * i * j]),
    ).flat(),
    surface = model.surfaceEvaluator({
      kind: 'spline',
      degrees: [2, 2],
      counts: [3, 3],
      points,
      knots: [
        [0, 1],
        [0, 1],
      ],
      multiplicities: [
        [3, 3],
        [3, 3],
      ],
    }),
    point = [0, 1e-12, 1e-6],
    at = surface.at(...surface.parameters(point, [0.5, 0.5]));
  assert.ok(Math.hypot(...point.map((x, k) => x - at[k])) < 1e-9);
});

test('modeler: a spline projection past both bounds reaches the nearest place along one edge', () => {
  // A leaning bilinear patch, S = u (1, 0, 0) + v (1, 1, 0): past the corner (1, 0) the free step leaves both bounds
  // from anywhere, so a foot clamped to both stayed at the corner though the nearest place lies along v = 0. Jubilee
  // body 128's edge runs 5.8 nm past a spline's corner, where its foot lies 4e-7 in u from the corner.
  const surface = model.surfaceEvaluator({
    kind: 'spline',
    degrees: [1, 1],
    counts: [2, 2],
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [2, 1, 0],
    ],
    knots: [
      [0, 1],
      [0, 1],
    ],
    multiplicities: [
      [2, 2],
      [2, 2],
    ],
  });
  for (const [point, u] of [
    [[0.8, -0.5, 0], 0.8],
    [[1 - 4e-7, -5.8e-7, 0], 1 - 4e-7],
  ])
    for (const hint of [[0.5, 0.5], [1, 0], undefined]) {
      const uv = surface.parameters(point, hint);
      assert.ok(Math.abs(uv[0] - u) < 1e-12 && uv[1] === 0, `${point} from ${hint}: ${uv}`);
    }
});

test('modeler: frames from axes of any finite size', () => {
  // Directions are dimensionless: lengths square without overflow or underflow at any finite size.
  for (const size of [1e200, 1e-200, 1e-160, 1e160]) {
    assert.deepEqual(frameOf([0, 0, 0], [size, 0, 0]).z, [1, 0, 0]);
    const z = frameOf([0, 0, 0], [0, size, size]).z;
    assert.ok(z[0] === 0 && Math.abs(z[1] - Math.SQRT1_2) < 1e-15 && Math.abs(z[2] - Math.SQRT1_2) < 1e-15, `${z}`);
  }
});
