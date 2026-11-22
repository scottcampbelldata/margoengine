// Face offset, shell and draft on curved analytic faces (cylinder, cone, sphere, torus), against closed forms and the
// primitives they must equal: an offset cylinder, sphere, torus or frustum is the primitive of the new size; a hollow
// sphere, a thick pipe and cups by the difference of two primitives; a drafted cylinder is the frustum; a drafted hole
// widens along the pull. Offsets that would change the topology are refused by name.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const {
  box,
  boolean,
  checkBody,
  cone,
  cylinder,
  draft,
  frameOf,
  massProperties,
  offsetFaces,
  shell,
  sphere,
  sweep,
  torus,
  validateBody,
} = model;
const mm = 0.001;

function close(actual, expected, what, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1e-300),
    `${what}: ${actual} vs ${expected} (relative ${Math.abs(actual - expected) / Math.abs(expected)})`,
  );
}

/** Valid, and its volume, area, centroid and inertia those of `expected` (a primitive or closed forms). */
function same(body, expected) {
  assert.deepEqual(validateBody(body), []);
  assert.deepEqual(checkBody(body), []);
  const m = massProperties(body),
    e = expected.volume !== undefined && expected.inertia ? expected : massProperties(expected);
  close(m.volume, e.volume, 'volume');
  if (e.area !== undefined) close(m.area, e.area, 'area');
  const size = Math.cbrt(e.volume);
  e.centroid.forEach((x, k) =>
    assert.ok(Math.abs(m.centroid[k] - x) <= 1e-12 * size, `centroid ${k}: ${m.centroid[k]} vs ${x}`),
  );
  const trace = e.inertia[0] + e.inertia[1] + e.inertia[2];
  e.inertia.forEach((x, k) =>
    assert.ok(Math.abs(m.inertia[k] - x) <= 1e-12 * trace, `inertia ${k}: ${m.inertia[k]} vs ${x}`),
  );
}

const named = (body, end) => body.faces.find((f) => f.name.endsWith(end)).name;

/**
 * The volume of the torus about z (major R, minor r, centred at the origin) on the side y >= d of the plane y = d
 * (|d| < R - r): over its tube's disc, rho (pi - 2 asin(d / rho)) for the arc of each circle about z past the plane.
 * 24-point Gauss-Legendre across the disc's radius, 512 steps round it (exact for the smooth periodic integrand).
 */
function torusPast(R, r, d) {
  const x = [
      0.0640568928626056, 0.1911188674736163, 0.3150426796961634, 0.4337935076260451, 0.5454214713888395,
      0.6480936519369755, 0.7401241915785544, 0.8200019859739029, 0.8864155270044011, 0.9382745520027328,
      0.9747285559713095, 0.9951872199970214,
    ],
    w = [
      0.1279381953467522, 0.1258374563468283, 0.1216704729278034, 0.1155056680537256, 0.1074442701159656,
      0.0976186521041139, 0.0861901615319533, 0.0733464814110803, 0.0592985849154368, 0.0442774388174198,
      0.0285313886289337, 0.0123412297999872,
    ],
    m = 512;
  let v = 0;
  for (let i = 0; i < x.length; i++)
    for (const sign of [1, -1]) {
      const s = ((1 + sign * x[i]) / 2) * r;
      for (let j = 0; j < m; j++) {
        const rho = R + s * Math.cos((2 * Math.PI * j) / m);
        v += ((w[i] * r) / 2) * s * ((2 * Math.PI) / m) * rho * (Math.PI - 2 * Math.asin(d / rho));
      }
    }
  return v;
}

test('offset: a cylinder, sphere, torus and frustum offset are the primitives of the new size', () => {
  const c = cylinder('c', 5 * mm, 20 * mm);
  same(offsetFaces('o', c, [named(c, 'side')], 1 * mm), cylinder('e', 6 * mm, 20 * mm));
  same(offsetFaces('o', c, [named(c, '+z')], 2 * mm), cylinder('e', 5 * mm, 22 * mm));
  same(
    offsetFaces('o', c, [named(c, 'side'), named(c, '-z')], -1 * mm),
    cylinder('e', 4 * mm, 19 * mm, frameOf([0, 0, 1 * mm], [0, 0, 1])),
  );
  const s = sphere('s', 5 * mm);
  same(offsetFaces('o', s, [s.faces[0].name], 1 * mm), sphere('e', 6 * mm));
  const t = torus('t', 10 * mm, 3 * mm);
  same(offsetFaces('o', t, [t.faces[0].name], -1 * mm), torus('e', 10 * mm, 2 * mm));
  // The frustum's side moves 1 out square to itself: its radius at every height grows by 1 / cos of its slope.
  const k = cone('k', 5 * mm, 2 * mm, 12 * mm),
    grow = Math.hypot(12, 3) / 12;
  same(offsetFaces('o', k, [named(k, 'side')], 1 * mm), cone('e', (5 + grow) * mm, (2 + grow) * mm, 12 * mm));
});

test('shell: a hollow sphere, a thick pipe, and cups out and in', () => {
  const R = 5,
    r = 4,
    hollow = shell('h', sphere('s', R * mm), [], -1 * mm);
  assert.equal(hollow.shells.length, 2, 'a cavity');
  same(hollow, {
    volume: (4 / 3) * Math.PI * (R ** 3 - r ** 3) * mm ** 3,
    area: 4 * Math.PI * (R * R + r * r) * mm ** 2,
    centroid: [0, 0, 0],
    inertia: [0, 1, 2].map(() => (8 / 15) * Math.PI * (R ** 5 - r ** 5) * mm ** 5).concat([0, 0, 0]),
  });
  const c = cylinder('c', 5 * mm, 20 * mm),
    pipe = shell('p', c, [named(c, '-z'), named(c, '+z')], -1 * mm),
    h = 20,
    V = Math.PI * (25 - 16) * h,
    Izz = (Math.PI * h * (5 ** 4 - 4 ** 4)) / 2,
    // About a diameter through the centroid: (V / 12) (3 (R^2 + r^2) + h^2).
    Ixx = (V / 12) * (3 * (25 + 16) + h * h);
  same(pipe, {
    volume: V * mm ** 3,
    area: (2 * Math.PI * (5 + 4) * h + 2 * Math.PI * (25 - 16)) * mm ** 2,
    centroid: [0, 0, 10 * mm],
    inertia: [Ixx * mm ** 5, Ixx * mm ** 5, Izz * mm ** 5, 0, 0, 0],
  });
  const out = shell('o', c, [named(c, '+z')], 1 * mm),
    inn = shell('i', c, [named(c, '+z')], -1 * mm);
  for (const b of [out, inn]) {
    assert.deepEqual(validateBody(b), []);
    assert.deepEqual(checkBody(b), []);
  }
  close(massProperties(out).volume, (Math.PI * 36 * 21 - Math.PI * 25 * 20) * mm ** 3, 'cup out');
  close(massProperties(inn).volume, (Math.PI * 25 * 20 - Math.PI * 16 * 19) * mm ** 3, 'cup in');
});

test('offset: a quarter torus swept along an arc, its tube thinned; its end moved off the axis cuts the tube anew', () => {
  const ring = (r) => ({
      name: 'p',
      start: [11 * mm, 0, 0],
      normal: [0, 1, 0],
      segments: [{ kind: 'arc', to: [11 * mm, 0, 0], center: [10 * mm, 0, 0] }],
    }),
    q = sweep('q', ring(1), {
      name: 'path',
      start: [10 * mm, 0, 0],
      segments: [{ kind: 'arc', to: [0, 10 * mm, 0], center: [0, 0, 0] }],
    }),
    thin = offsetFaces('o', q, [q.faces.find((f) => f.surface.kind === 'torus').name], -0.5 * mm);
  assert.deepEqual(checkBody(thin), []);
  close(massProperties(thin).volume, (Math.PI / 2) * Math.PI * 0.25 * 10 * mm ** 3, 'thin quarter torus');
  // The end plane (y = 0, facing -y) moved 1 mm out, off the axis, cuts the torus in a curve that is no circle: the
  // edge is the plane's and the torus's own intersection, traced. Before, the offset refused it. The body gains the
  // half of the torus's slab -1 mm < y < 0 with x > 0.
  const longer = offsetFaces('o', q, ['q/face:start'], 1 * mm),
    slab = torusPast(10 * mm, 1 * mm, -1 * mm) - torusPast(10 * mm, 1 * mm, 0);
  assert.deepEqual(checkBody(longer), []);
  assert.equal(longer.edges.find((e) => e.name === 'q/edge:section:0:e0').curve.kind, 'spline');
  close(massProperties(longer).volume, (Math.PI / 2) * Math.PI * 10 * mm ** 3 + slab / 2, 'longer quarter torus', 1e-7);
});

test('offset, shell and draft: a torus and a frustum cut in half by a Boolean through their axis', () => {
  // A plane through a torus's axis meets it in two circles and through a cone's in two lines: the Boolean traced them
  // as splines, which every offset refused ("is a spline; offsets support lines and circles"). Now its edges are the
  // circles and lines, and an edge whose faces move apart into a curve that is no line or circle is traced anew.
  const R = 10 * mm,
    r = 3 * mm,
    half = boolean(
      'h',
      'subtract',
      torus('t', R, r),
      box('b', [30 * mm, 15 * mm, 10 * mm], frameOf([-15 * mm, 0, -5 * mm], [0, 0, 1], [1, 0, 0])),
    ),
    tube = half.faces.find((f) => f.surface.kind === 'torus').name,
    cuts = half.faces.filter((f) => f.surface.kind === 'plane').map((f) => f.name),
    exact = Math.PI ** 2 * R * r * r;
  assert.deepEqual(
    half.edges.map((e) => [e.curve.kind, e.curve.radius]),
    [
      ['circle', r],
      ['circle', r],
    ],
  );
  close(massProperties(half).volume, exact, 'half torus');
  const valid = (body) => {
    assert.deepEqual(checkBody(body), []);
    return massProperties(body).volume;
  };
  // The tube thinned is the half torus of the smaller tube.
  close(valid(offsetFaces('o', half, [tube], -1 * mm)), Math.PI ** 2 * R * 4 * mm * mm, 'thinner tube');
  // The cut planes moved 1 mm out, off the axis: torus past y = -1 mm.
  close(valid(offsetFaces('o', half, cuts, 1 * mm)), torusPast(R, r, -1 * mm), 'planes moved out', 1e-9);
  // Hollowed 0.5 mm inside (a closed cavity: the torus of minor 2.5 mm past y = 0.5 mm), and walled 0.5 mm outside.
  close(valid(shell('s', half, [], -0.5 * mm)), exact - torusPast(R, 2.5 * mm, 0.5 * mm), 'hollow', 1e-9);
  close(valid(shell('s', half, [], 0.5 * mm)), torusPast(R, 3.5 * mm, -0.5 * mm) - exact, 'walled', 1e-9);
  // The cut planes drafted 0.1 rad about the x axis: turned through it, the torus maps onto itself, so the volume stays.
  close(
    valid(draft('d', half, cuts, { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], 0.1)),
    exact,
    'drafted',
    1e-9,
  );
  // A frustum (radii 5 and 2 mm, 8 mm tall) cut through its axis: its side thinned by 0.5 mm moves both radii by
  // 0.5 / cos(angle); it shells and drafts.
  const turn = [Math.cos(0.5), Math.sin(0.5), 0],
    frustum = boolean(
      'f',
      'subtract',
      cone('c', 5 * mm, 2 * mm, 8 * mm),
      box(
        'b',
        [30 * mm, 15 * mm, 30 * mm],
        frameOf([-15 * mm * turn[0], -15 * mm * turn[1], -15 * mm], [0, 0, 1], turn),
      ),
    ),
    side = frustum.faces.find((f) => f.surface.kind === 'cone').name,
    k = (0.5 * mm) / Math.cos(Math.atan(3 / 8)),
    halfFrustum = (a, b) => (Math.PI * 8 * mm * (a * a + a * b + b * b)) / 6;
  assert.deepEqual(
    frustum.edges.filter((e) => e.curve.kind !== 'line' && e.curve.kind !== 'circle'),
    [],
  );
  close(valid(offsetFaces('o', frustum, [side], -0.5 * mm)), halfFrustum(5 * mm - k, 2 * mm - k), 'thinner frustum');
  assert.ok(valid(shell('s', frustum, [], -0.5 * mm)) > 0);
  assert.ok(valid(draft('d', frustum, [side], { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], 0.1)) > 0);
});
test('draft: a drafted cylinder is the frustum; a drafted hole widens along the pull', () => {
  const a = (5 * Math.PI) / 180,
    c = cylinder('c', 5 * mm, 10 * mm),
    d = draft('d', c, [named(c, 'side')], { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], a);
  same(d, cone('e', 5 * mm, (5 - 10 * Math.tan(a)) * mm, 10 * mm));
  assert.equal(d.faces.find((f) => f.name.endsWith('side')).surface.kind, 'cone');
  // About a neutral plane half way up: the frustum widens below it.
  same(
    draft('d', c, [named(c, 'side')], { origin: [0, 0, 5 * mm], normal: [0, 0, 1] }, [0, 0, 1], a),
    cone('e', (5 + 5 * Math.tan(a)) * mm, (5 - 5 * Math.tan(a)) * mm, 10 * mm),
  );
  // Zero is the identity (a cone of no slope).
  same(draft('d', c, [named(c, 'side')], { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], 0), c);
  const block = boolean(
      'p',
      'subtract',
      box('a', [20 * mm, 20 * mm, 10 * mm]),
      cylinder('h', 4 * mm, 12 * mm, frameOf([10 * mm, 10 * mm, -1 * mm], [0, 0, 1])),
    ),
    hole = block.faces.find((f) => f.surface.kind === 'cylinder').name,
    drafted = draft('d', block, [hole], { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], a),
    r1 = 4 + 10 * Math.tan(a);
  assert.deepEqual(checkBody(drafted), []);
  close(
    massProperties(drafted).volume,
    (4000 - (Math.PI * 10 * (16 + 4 * r1 + r1 * r1)) / 3) * mm ** 3,
    'drafted hole',
  );
  // Offset into the material, the hole grows.
  assert.deepEqual(checkBody(offsetFaces('o', block, [hole], -1 * mm)), []);
  close(
    massProperties(offsetFaces('o', block, [hole], -1 * mm)).volume,
    (4000 - Math.PI * 25 * 10) * mm ** 3,
    'hole offset',
  );
});

test('offset and draft refuse curved faces that would vanish, and drafts of an axis off the pull', () => {
  const c = cylinder('c', 5 * mm, 20 * mm);
  assert.throws(() => offsetFaces('o', c, [named(c, 'side')], -5 * mm), {
    name: 'RangeError',
    message: /face c\/face:side would shrink to nothing/,
  });
  const t = torus('t', 10 * mm, 3 * mm);
  assert.throws(() => offsetFaces('o', t, [t.faces[0].name], 7 * mm), {
    name: 'RangeError',
    message: /would shrink to nothing/,
  });
  assert.throws(() => shell('h', sphere('s', 5 * mm), [], -5 * mm), {
    name: 'RangeError',
    message: /would shrink to nothing/,
  });
  const lying = cylinder('x', 5 * mm, 10 * mm, frameOf([0, 0, 0], [1, 0, 0]));
  assert.throws(() => draft('d', lying, ['x/face:side'], { origin: [0, 0, 0], normal: [0, 0, 1] }, [0, 0, 1], 0.1), {
    name: 'RangeError',
    message: /x\/face:side is a cylinder whose axis does not run along the pull/,
  });
});
