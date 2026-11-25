// Cones, frustums and revolved profiles that touch the axis, against closed forms: volume, area, centroid and the
// inertia tensor; the cone cut by planes in an ellipse, a parabola and a hyperbola; a STEP round trip, also with the
// apex written as a VERTEX_LOOP; and the profiles revolve must refuse.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const {
  bodiesFromSTEP,
  bodiesToSTEP,
  boolean,
  box,
  checkBody,
  cone,
  cylinder,
  frameOf,
  massProperties,
  meshBodies,
  revolve,
  sphere,
  validateBody,
} = model;
const mm = 0.001;

function close(actual, expected, what, tolerance) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1e-300),
    `${what}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / Math.abs(expected)})`,
  );
}

/**
 * The closed forms of a frustum about z, radius r0 at z = 0 and r1 at z = h (either may be 0), in mm: by discs,
 * V = pi integral r^2, Izz = pi/2 integral r^4, Ixx about the base = integral (pi r^4 / 4 + pi r^2 z^2), with
 * r = r0 + a z.
 */
function frustum(r0, r1, h) {
  const a = (r1 - r0) / h,
    s2 = r0 * r0 + r0 * r1 + r1 * r1,
    s4 = r0 ** 4 + r0 ** 3 * r1 + r0 * r0 * r1 * r1 + r0 * r1 ** 3 + r1 ** 4,
    V = (Math.PI * h * s2) / 3,
    zc = (h * (r0 * r0 + 2 * r0 * r1 + 3 * r1 * r1)) / (4 * s2),
    side = Math.PI * (r0 + r1) * Math.hypot(h, r1 - r0),
    izz = (Math.PI * h * s4) / 10,
    ixxBase = izz / 2 + Math.PI * ((r0 * r0 * h ** 3) / 3 + (r0 * a * h ** 4) / 2 + (a * a * h ** 5) / 5),
    ixx = ixxBase - V * zc * zc;
  return {
    volume: V,
    area: side + Math.PI * (r0 * r0 + r1 * r1),
    centroid: [0, 0, zc],
    inertia: [ixx, ixx, izz, 0, 0, 0],
  };
}

/** Mass properties (mm in) against expected values, relative to `tolerance`; products against the trace. */
function expectMass(body, { volume, area, centroid, inertia }, tolerance = 1e-12, at = [0, 0, 0]) {
  const m = massProperties(body),
    size = Math.cbrt(volume);
  close(m.volume, volume * mm ** 3, 'volume', tolerance);
  close(m.area, area * mm ** 2, 'area', tolerance);
  centroid.forEach((x, k) =>
    assert.ok(
      Math.abs(m.centroid[k] - (x + at[k]) * mm) <= tolerance * size * mm,
      `centroid ${k}: ${m.centroid[k]} vs ${(x + at[k]) * mm}`,
    ),
  );
  const trace = (inertia[0] + inertia[1] + inertia[2]) * mm ** 5;
  inertia.forEach((x, k) =>
    assert.ok(
      Math.abs(m.inertia[k] - x * mm ** 5) <= tolerance * trace,
      `inertia ${k}: ${m.inertia[k]} vs ${x * mm ** 5}`,
    ),
  );
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

test('cone: a cone and a frustum to their closed forms, with an apex vertex and discs', () => {
  const c = cone('c', 5 * mm, 0, 12 * mm);
  clean(c);
  assert.deepEqual(
    c.faces.map((f) => [f.name, f.surface.kind]),
    [
      ['c/face:-z', 'plane'],
      ['c/face:side', 'cone'],
    ],
  );
  // One circle and the side's seam, which ends at the apex: two vertices.
  assert.deepEqual(c.edges.map((e) => e.curve.kind).sort(), ['circle', 'line']);
  assert.equal(c.vertices.length, 2);
  expectMass(c, frustum(5, 0, 12));
  const f = cone('f', 5 * mm, 2 * mm, 12 * mm);
  clean(f);
  assert.deepEqual(
    f.faces.map((x) => x.surface.kind),
    ['plane', 'cone', 'plane'],
  );
  expectMass(f, frustum(5, 2, 12));
  // Upside down (the apex at the frame's origin), and equal radii (a cylinder).
  const v = cone('v', 0, 4 * mm, 9 * mm);
  clean(v);
  expectMass(v, frustum(0, 4, 9));
  const cyl = cone('y', 3 * mm, 3 * mm, 7 * mm);
  assert.deepEqual(
    cyl.faces.map((x) => x.surface.kind),
    ['plane', 'cylinder', 'plane'],
  );
  expectMass(cyl, frustum(3, 3, 7));
});

test('cone: moved and turned frames, and 1 km from the origin', () => {
  // The axis along x: Ixx and Izz trade places; the centroid moves with the frame.
  const exact = frustum(5, 2, 12),
    at = [3, -4, 7],
    turned = cone('t', 5 * mm, 2 * mm, 12 * mm, frameOf([3 * mm, -4 * mm, 7 * mm], [1, 0, 0], [0, 1, 0]));
  clean(turned);
  expectMass(
    turned,
    {
      ...exact,
      centroid: [exact.centroid[2], 0, 0],
      inertia: [exact.inertia[2], exact.inertia[0], exact.inertia[0], 0, 0, 0],
    },
    1e-12,
    at,
  );
  // An awkward axis: the volume, area and principal moments do not change.
  const axis = [1, 2, -2].map((x) => x / 3),
    tilted = cone('w', 5 * mm, 2 * mm, 12 * mm, frameOf([0, 0, 0], axis));
  clean(tilted);
  const m = massProperties(tilted);
  close(m.volume, exact.volume * mm ** 3, 'tilted volume', 1e-12);
  close(m.area, exact.area * mm ** 2, 'tilted area', 1e-12);
  const I = m.inertia,
    J = [
      [I[0], I[3], I[5]],
      [I[3], I[1], I[4]],
      [I[5], I[4], I[2]],
    ],
    axial = axis.reduce((s, a, i) => s + a * axis.reduce((t, b, j) => t + J[i][j] * b, 0), 0);
  close(axial, exact.inertia[2] * mm ** 5, 'moment about the axis', 1e-12);
  close(I[0] + I[1] + I[2], (2 * exact.inertia[0] + exact.inertia[2]) * mm ** 5, 'trace', 1e-12);
  // 1 km off: the volume holds to 1e-9 (stage 0a's invariance bar), and the body is valid.
  const far = cone('k', 5 * mm, 0, 12 * mm, frameOf([1000, 1000, 1000], [0, 0, 1], [1, 0, 0]));
  assert.deepEqual(validateBody(far), []);
  assert.deepEqual(checkBody(far), []);
  close(massProperties(far).volume, frustum(5, 0, 12).volume * mm ** 3, 'volume 1 km away', 1e-9);
});

test('cone: revolve closes a profile touching the axis with an apex, a pole or a disc', () => {
  const axis = { origin: [0, 0, 0], direction: [0, 0, 1] },
    line = (x, z, name) => ({ kind: 'line', to: [x * mm, 0, z * mm], name }),
    arc = (x, z, cx, cz, clockwise) => ({
      kind: 'arc',
      to: [x * mm, 0, z * mm],
      center: [cx * mm, 0, cz * mm],
      clockwise,
    }),
    p = (start, segments, normal = [0, 1, 0]) => ({
      name: 'p',
      start: [start[0] * mm, 0, start[1] * mm],
      normal,
      segments,
    });
  // The harness's cone profile: from the axis out, up to the apex, down the axis.
  const c = revolve('c', p([0, 0], [line(5, 0), line(0, 12), line(0, 0)]), axis);
  clean(c);
  expectMass(c, frustum(5, 0, 12));
  // The same run the other way, with the normal reversed: the same solid.
  const back = revolve('b', p([0, 0], [line(0, 12), line(5, 0), line(0, 0)], [0, -1, 0]), axis);
  clean(back);
  expectMass(back, frustum(5, 0, 12));
  // A rectangle on the axis: a cylinder with two discs.
  const cyl = revolve('y', p([0, 0], [line(4, 0), line(4, 6), line(0, 6), line(0, 0)]), axis);
  clean(cyl);
  assert.deepEqual(
    cyl.faces.map((f) => f.surface.kind),
    ['plane', 'cylinder', 'plane'],
  );
  expectMass(cyl, frustum(4, 4, 6));
  // A half circle and the axis: a whole sphere, one face with no edges, as the sphere primitive.
  const r = 6,
    ball = revolve('s', p([0, -r], [arc(0, r, 0, 0), line(0, -r)]), axis);
  clean(ball);
  assert.equal(ball.faces.length, 1);
  assert.equal(ball.edges.length, 0);
  const I = (2 / 5) * ((4 / 3) * Math.PI * r ** 3) * r * r;
  expectMass(ball, {
    volume: (4 / 3) * Math.PI * r ** 3,
    area: 4 * Math.PI * r * r,
    centroid: [0, 0, 0],
    inertia: [I, I, I, 0, 0, 0],
  });
  const primitive = massProperties(sphere('q', r * mm));
  close(massProperties(ball).volume, primitive.volume, 'as the primitive', 1e-14);
  // A quarter circle, a disc and the axis: a hemisphere over its pole. Centroid 3r/8 up; about the base Ixx = 2/5 m r^2.
  const hemi = revolve('h', p([0, 0], [line(r, 0), arc(0, r, 0, 0, true), line(0, 0)]), axis),
    Vh = (2 / 3) * Math.PI * r ** 3,
    zc = (3 * r) / 8,
    Ib = (2 / 5) * Vh * r * r;
  clean(hemi);
  expectMass(hemi, {
    volume: Vh,
    area: 3 * Math.PI * r * r,
    centroid: [0, 0, zc],
    inertia: [Ib - Vh * zc * zc, Ib - Vh * zc * zc, Ib, 0, 0, 0],
  });
  // A sphere cap under a cone (an ice-cream cone): apex at the bottom, the cap's pole at the top.
  const R = 3,
    H = 4,
    cream = revolve('i', p([0, 0], [line(R, H), arc(0, H + R, 0, H, true), line(0, 0)]), axis);
  clean(cream);
  // Cone R, H plus a hemisphere of R on top; areas pi R s and 2 pi R^2.
  close(
    massProperties(cream).volume,
    ((Math.PI * R * R * H) / 3 + (2 / 3) * Math.PI * R ** 3) * mm ** 3,
    'volume',
    1e-12,
  );
  close(massProperties(cream).area, (Math.PI * R * Math.hypot(R, H) + 2 * Math.PI * R * R) * mm ** 2, 'area', 1e-12);
});

test('cone: revolve refuses profiles that cross the axis or pinch on it', () => {
  const axis = { origin: [0, 0, 0], direction: [0, 0, 1] },
    line = (x, z) => ({ kind: 'line', to: [x * mm, 0, z * mm] }),
    arc = (x, z, cx, cz, clockwise) => ({
      kind: 'arc',
      to: [x * mm, 0, z * mm],
      center: [cx * mm, 0, cz * mm],
      clockwise,
    }),
    p = (start, segments) => ({ name: 'p', start: [start[0] * mm, 0, start[1] * mm], normal: [0, 1, 0], segments });
  // Across the axis.
  assert.throws(() => revolve('x', p([-2, 0], [line(5, 0), line(5, 3), line(-2, 3), line(-2, 0)]), axis), {
    name: 'RangeError',
    message: /crosses the axis/,
  });
  // A triangle touching the axis at one corner only: two cones would meet in the apex alone.
  assert.throws(() => revolve('x', p([0, 5], [line(5, 0), line(5, 10), line(0, 5)]), axis), {
    name: 'RangeError',
    message: /touches the axis .* with no segment along it/,
  });
  // A disc and a cone meeting at a point of the axis, with no axis segment between them.
  assert.throws(() => revolve('x', p([0, 0], [line(5, 0), line(5, 5), line(0, 0)]), axis), {
    name: 'RangeError',
    message: /with no segment along it/,
  });
  // An arc centred on the axis that turns past it.
  assert.throws(() => revolve('x', p([0, 0], [line(3, 0), arc(0, -3, 0, 0, true), line(0, 0)]), axis), {
    name: 'RangeError',
    message: /crosses the axis/,
  });
  // An arc off the axis that reaches it.
  assert.throws(() => revolve('x', p([0, 0], [arc(0, 4, 2, 2, true), line(0, 0)]), axis), {
    name: 'RangeError',
    message: /an arc reaches the axis/,
  });
  // The whole profile on the axis.
  assert.throws(() => revolve('x', p([0, 0], [line(0, 3), line(0, 0)]), axis), { name: 'RangeError' });
  for (const [r0, r1, h] of [
    [-1, 0, 5],
    [0, 0, 5],
    [2, 1, 0],
    [2, 1, -1],
    [2, NaN, 3],
    [Infinity, 1, 3],
  ])
    assert.throws(() => cone('k', r0, r1, h), { name: 'RangeError', message: /cone radii/ });
});

test('cone: cut by planes in an ellipse, a parabola and a hyperbola, to closed forms', () => {
  // The cone of radius R at z = 0 and apex at z = H; k = R / H. In apex coordinates z' = H - z the cone is
  // x^2 + y^2 = (k z')^2.
  const R = 5,
    H = 12,
    k = R / H,
    c = () => cone('c', R * mm, 0, H * mm),
    /** A 60 mm box with its -z face on the plane through `o` (mm) with unit normal `n`, standing on the n side. */
    halfSpace = (o, n, x) => {
      const f = frameOf(
          o.map((v) => v * mm),
          n,
          x,
        ),
        corner = [0, 1, 2].map((i) => o[i] * mm - 30 * mm * (f.x[i] + f.y[i]));
      return box('h', [60 * mm, 60 * mm, 60 * mm], frameOf(corner, f.z, f.x));
    },
    check = (body, volume, curve) => {
      assert.deepEqual(validateBody(body), []);
      assert.deepEqual(checkBody(body), []);
      close(massProperties(body).volume, volume * mm ** 3, 'volume', 1e-10);
      assert.ok(
        body.edges.some((e) => e.curve.kind === curve),
        `a ${curve} edge`,
      );
    };
  // Ellipse: the plane z' = m x + c0 below the apex; the apex side is a cone on an elliptical base:
  // V = (1/3) A d with the base A = pi k^2 c0^2 sqrt(1 + m^2) / (1 - k^2 m^2)^(3/2), d = c0 / sqrt(1 + m^2).
  const m = 0.6,
    c0 = 6,
    nE = [m, 0, 1].map((v) => v / Math.hypot(m, 1));
  check(
    boolean('e', 'intersect', c(), halfSpace([0, 0, H - c0], nE, [1, 0, -m])),
    (Math.PI * k * k * c0 ** 3) / (3 * (1 - k * k * m * m) ** 1.5),
    'spline',
  );
  // Hyperbola: the plane x = d along the axis. Slices are circular segments r^2 acos(d/r) - d sqrt(r^2 - d^2) with
  // r = k z', so V = (1/k) [R^3/3 acos(d/R) - 2/3 d R S + d^3/3 ln((R + S)/d)], S = sqrt(R^2 - d^2).
  const d = 2,
    S = Math.sqrt(R * R - d * d);
  check(
    boolean('h', 'intersect', c(), halfSpace([d, 0, 0], [1, 0, 0], [0, 1, 0])),
    ((R ** 3 / 3) * Math.acos(d / R) - (2 / 3) * d * R * S + (d ** 3 / 3) * Math.log((R + S) / d)) / k,
    'spline',
  );
  // Parabola: the plane x = r - e (r = k z' at each slice) along a generator. The side x <= r - e away from the apex
  // has slices r^2 acos((e - r)/r) - (e - r) sqrt(2 e r - e^2) from r = e/2 to R; with W = 2 e R - e^2,
  // V = (1/k) [R^3/3 acos((e - R)/R) - (1/(24 e^2)) (2/5 W^(5/2) + 4/3 e^2 W^(3/2) + 2 e^4 W^(1/2))
  //            - (1/(4 e^2)) (2/3 e^2 W^(3/2) - 2/5 W^(5/2))].
  const e = 2,
    W = 2 * e * R - e * e,
    nP = [-1, 0, -k].map((v) => v / Math.hypot(1, k));
  check(
    boolean('p', 'intersect', c(), halfSpace([k * H - e, 0, 0], nP, [0, 1, 0])),
    ((R ** 3 / 3) * Math.acos((e - R) / R) -
      (1 / (24 * e * e)) * ((2 / 5) * W ** 2.5 + (4 / 3) * e * e * W ** 1.5 + 2 * e ** 4 * W ** 0.5) -
      (1 / (4 * e * e)) * ((2 / 3) * e * e * W ** 1.5 - (2 / 5) * W ** 2.5)) /
      k,
    'spline',
  );
  // And a Boolean with a cone on both sides: a frustum cut from a cylinder leaves a countersunk hole.
  const block = cylinder('b', 8 * mm, 10 * mm),
    sink = cone('s', 2 * mm, 6 * mm, 4 * mm, frameOf([0, 0, 6 * mm], [0, 0, 1], [1, 0, 0])),
    drilled = boolean('d', 'subtract', block, sink);
  assert.deepEqual(validateBody(drilled), []);
  close(massProperties(drilled).volume, (Math.PI * 64 * 10 - frustum(2, 6, 4).volume) * mm ** 3, 'countersink', 1e-12);
});

test('cone: STEP round trip, and an apex written as a VERTEX_LOOP', () => {
  const exact = frustum(5, 0, 12),
    step = bodiesToSTEP([cone('c', 5 * mm, 0, 12 * mm)]),
    read = bodiesFromSTEP(parseSTEP(new TextEncoder().encode(step)));
  assert.deepEqual(read.problems, []);
  const [back] = read.bodies;
  assert.deepEqual(validateBody(back), []);
  assert.deepEqual(checkBody(back), []);
  expectMass(back, exact);
  // The same file with the side face bounded by its base circle and a VERTEX_LOOP at the apex (as some exporters
  // write it): the apex is the surface's own, and the solid reads the same.
  const lines = step.split('\n'),
    seam = lines.find((l) => l.includes("EDGE_CURVE('c/edge:side'")),
    apex = /EDGE_CURVE\('[^']*',#\d+,#(\d+)/.exec(seam)[1],
    loop = lines.find((l) => /EDGE_LOOP\('',\(#\d+,#\d+,#\d+\)\)/.test(l)),
    side = lines.find((l) => l.includes("ADVANCED_FACE('c/face:side'")),
    edited = lines
      .flatMap((l) => {
        if (l === loop) return [l.replace(/\(#(\d+),#\d+,#\d+\)/, '(#$1)')];
        if (l === side)
          return [
            `#900001=VERTEX_LOOP('',#${apex});`,
            "#900002=FACE_BOUND('',#900001,.T.);",
            l.replace("',(#", "',(#900002,#"),
          ];
        return [l];
      })
      .join('\n');
  assert.ok(seam && loop && side);
  assert.match(edited, /VERTEX_LOOP/);
  const again = bodiesFromSTEP(parseSTEP(new TextEncoder().encode(edited)));
  assert.deepEqual(again.problems, []);
  const [vl] = again.bodies;
  assert.deepEqual(validateBody(vl), []);
  assert.deepEqual(checkBody(vl), []);
  expectMass(vl, exact);
});
