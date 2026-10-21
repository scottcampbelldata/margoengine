import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const {
  Body,
  Edge,
  Face,
  Vertex,
  boolean,
  box,
  cylinder,
  fillet,
  frameOf,
  massProperties,
  revolve,
  sphere,
  torus,
  validateBody,
} = model;
const mm = 0.001,
  close = (actual, expected, what, tolerance = 1e-9) =>
    assert.ok(
      Math.abs(actual - expected) <= tolerance * Math.max(Math.abs(expected), 1e-30),
      `${what}: ${actual} vs ${expected}`,
    );

/** Volume, area, centroid and inertia against expected values (mm units in, metres compared). */
function expect(body, { volume, area, centroid, inertia }, tolerance) {
  const m = massProperties(body);
  if (volume !== undefined) close(m.volume, volume * mm ** 3, 'volume', tolerance);
  if (area !== undefined) close(m.area, area * mm ** 2, 'area', tolerance);
  if (centroid)
    centroid.forEach((x, k) =>
      assert.ok(Math.abs(m.centroid[k] - x * mm) <= 1e-12, `centroid ${k}: ${m.centroid[k]} vs ${x * mm}`),
    );
  if (inertia)
    inertia.forEach((x, k) => {
      if (x === 0) assert.ok(Math.abs(m.inertia[k]) <= 1e-9 * Math.abs(m.inertia[0]), `inertia ${k}: ${m.inertia[k]}`);
      else close(m.inertia[k], x * mm ** 5, `inertia ${k}`, tolerance);
    });
  return m;
}

test('mass properties: box, cylinder, sphere and torus to their closed forms', () => {
  // A 10 x 20 x 30 box off the origin: inertia (b^2 + c^2) V / 12 and so on, no products.
  const [a, b, c] = [10, 20, 30],
    V = a * b * c;
  expect(box('b', [a * mm, b * mm, c * mm], frameOf([5 * mm, -7 * mm, 2 * mm], [0, 0, 1], [1, 0, 0])), {
    volume: V,
    area: 2 * (a * b + b * c + c * a),
    centroid: [5 + a / 2, -7 + b / 2, 2 + c / 2],
    inertia: [(V * (b * b + c * c)) / 12, (V * (a * a + c * c)) / 12, (V * (a * a + b * b)) / 12, 0, 0, 0],
  });
  // A cylinder of radius 5, height 10 (two planar caps, a side with its seam line).
  const r = 5,
    h = 10,
    Vc = Math.PI * r * r * h;
  expect(cylinder('c', r * mm, h * mm), {
    volume: Vc,
    area: 2 * Math.PI * r * r + 2 * Math.PI * r * h,
    centroid: [0, 0, h / 2],
    inertia: [(Vc * (3 * r * r + h * h)) / 12, (Vc * (3 * r * r + h * h)) / 12, (Vc * r * r) / 2, 0, 0, 0],
  });
  // A whole sphere and a whole torus: faces with no loops.
  const Vs = (4 / 3) * Math.PI * 125;
  expect(sphere('s', 5 * mm), {
    volume: Vs,
    area: 4 * Math.PI * 25,
    centroid: [0, 0, 0],
    inertia: [0.4 * Vs * 25, 0.4 * Vs * 25, 0.4 * Vs * 25, 0, 0, 0],
  });
  expect(torus('t', 10 * mm, 3 * mm), {
    volume: 2 * Math.PI ** 2 * 10 * 9,
    area: 4 * Math.PI ** 2 * 30,
    centroid: [0, 0, 0],
  });
});

test('mass properties: a cone ring, a hemisphere over its pole, a box with a hole, a rounded box', () => {
  // A ring revolved from (2, 0) (6, 0) (4, 8) (2, 8) in (x, z): a cylinder inside, a cone outside, annular ends.
  // Pappus: V = pi * integral over z of (x_out^2 - 2^2) with x_out = 6 - z / 4, which is pi * 512 / 3.
  const ring = revolve(
    'k',
    {
      name: 'p',
      start: [2 * mm, 0, 0],
      normal: [0, -1, 0],
      segments: [
        { kind: 'line', to: [6 * mm, 0, 0], name: 'bottom' },
        { kind: 'line', to: [4 * mm, 0, 8 * mm], name: 'cone' },
        { kind: 'line', to: [2 * mm, 0, 8 * mm], name: 'top' },
        { kind: 'line', to: [2 * mm, 0, 0], name: 'bore' },
      ],
    },
    { origin: [0, 0, 0], direction: [0, 0, 1] },
  );
  expect(ring, {
    volume: (Math.PI * 512) / 3,
    area: 32 * Math.PI + 12 * Math.PI + 32 * Math.PI + 10 * Math.PI * Math.sqrt(68),
  });
  // The upper half of a sphere of radius 5, cut by a box: the sphere face keeps its north pole, bounded by the equator.
  const half = boolean(
    'h',
    'intersect',
    sphere('s', 5 * mm),
    box('b', [20 * mm, 20 * mm, 10 * mm], frameOf([-10 * mm, -10 * mm, 0], [0, 0, 1], [1, 0, 0])),
  );
  expect(half, { volume: (2 / 3) * Math.PI * 125, area: 3 * Math.PI * 25, centroid: [0, 0, (3 * 5) / 8] }, 1e-8);
  // A 20 x 20 x 10 block with a through hole of radius 3.
  const holed = boolean(
    'p',
    'subtract',
    box('b', [20 * mm, 20 * mm, 10 * mm]),
    cylinder('h', 3 * mm, 20 * mm, frameOf([10 * mm, 10 * mm, -5 * mm], [0, 0, 1], [1, 0, 0])),
  );
  expect(holed, {
    volume: 4000 - Math.PI * 90,
    area: 2 * (400 - 9 * Math.PI) + 4 * 200 + 2 * Math.PI * 3 * 10,
    centroid: [10, 10, 5],
  });
  // A 10 mm cube with every edge rounded to 2: core, slabs, quarter cylinders and a ball's worth of corners.
  const cube = () => box('a', [10 * mm, 10 * mm, 10 * mm]),
    k = 6;
  expect(
    fillet(
      'rb',
      cube(),
      cube().edges.map((e) => e.name),
      2 * mm,
    ),
    {
      volume: k ** 3 + 6 * 2 * k * k + 3 * Math.PI * 4 * k + (4 / 3) * Math.PI * 8,
      area: 6 * k * k + (12 * (Math.PI * 2 * k)) / 2 + 4 * Math.PI * 4,
      centroid: [5, 5, 5],
    },
  );
});

test('mass properties: a sphere cut through its poles, its loop along both pole lines or round past one', () => {
  // A ball of radius 10 cut by planes through its axis: the sphere face's loop runs along the line of each pole, towards
  // -u' at the north and +u' at the south, by the wedge between the meridians (half a turn for a hemisphere).
  const r = 10,
    V = (4 / 3) * Math.PI * r ** 3,
    at = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]),
    cut = (op, size, frame) =>
      boolean(
        'c',
        op,
        sphere('s', r * mm),
        box(
          'b',
          size.map((x) => x * mm),
          frame,
        ),
      );
  for (const [side, x] of [
    [1, 0],
    [-1, -20],
  ]) {
    const half = cut('intersect', [20, 30, 30], at(x, -15, -15));
    assert.deepEqual(validateBody(half), []);
    expect(half, { volume: V / 2, area: 3 * Math.PI * r * r, centroid: [(side * 3 * r) / 8, 0, 0] }, 1e-12);
    // The same half as a pocket in the block, its sphere face reversed (u mirrored).
    const block = box('b', [20 * mm, 30 * mm, 30 * mm], at(x, -15, -15));
    expect(boolean('p', 'subtract', block, sphere('s', r * mm)), { volume: 18000 - V / 2 }, 1e-12);
  }
  // A quarter (two planes through the poles) and the three quarters left when it is taken away.
  expect(
    cut('intersect', [20, 20, 30], at(0, 0, -15)),
    { volume: V / 4, area: 2 * Math.PI * r * r, centroid: [(3 * r) / 8, (3 * r) / 8, 0] },
    1e-12,
  );
  expect(cut('subtract', [20, 20, 30], at(0, 0, -15)), { volume: (3 * V) / 4, area: 4 * Math.PI * r * r }, 1e-12);
  // A corner off the top (x, y >= 0 above z = 5) or the bottom: the loop runs through one pole and round the sphere
  // once, the face keeping the other pole.
  const corner = (Math.PI * 25 * (3 * r - 5)) / 3 / 4;
  for (const z of [5, -25]) expect(cut('subtract', [20, 20, 20], at(0, 0, z)), { volume: V - corner }, 1e-12);
});

test('mass properties: a sphere cut through one pole at a slant, its loop meeting the pole off a meridian', () => {
  // A ball of radius 10 cut by a plane through its north pole, the plane's normal n tilted t from the axis: the sphere
  // face's loop is a circle from the pole round to it again, so its u' drifts on the way in and out, and the pole's line
  // runs between the meridians the circle leaves and reaches the pole along, not those of the samples beside it. The cap
  // on the +n side has height h = r (1 - cos t), volume pi h^2 (3r - h) / 3, its centroid 3 (2r - h)^2 / (4 (3r - h))
  // along n.
  const r = 10,
    V = (4 / 3) * Math.PI * r ** 3;
  for (const t of [0.3, 0.785, 1.047]) {
    const n = [Math.sin(t), 0, Math.cos(t)],
      x = [Math.cos(t), 0, -Math.sin(t)],
      o = [0, 0, r].map((p, k) => (p - 20 * x[k] - 20 * [0, 1, 0][k]) * mm),
      cut = (op) => boolean('c', op, sphere('s', r * mm), box('b', [40 * mm, 40 * mm, 40 * mm], frameOf(o, n, x))),
      h = r * (1 - Math.cos(t)),
      cap = (Math.PI * h * h * (3 * r - h)) / 3,
      along = (3 * (2 * r - h) ** 2) / (4 * (3 * r - h)),
      disc = Math.PI * h * (2 * r - h),
      top = cut('intersect');
    assert.deepEqual(validateBody(top), []);
    expect(top, { volume: cap, area: 2 * Math.PI * r * h + disc, centroid: n.map((c) => c * along) }, 1e-12);
    expect(
      cut('subtract'),
      {
        volume: V - cap,
        area: 4 * Math.PI * r * r - 2 * Math.PI * r * h + disc,
        centroid: n.map((c) => (-c * along * cap) / (V - cap)),
      },
      1e-12,
    );
  }
});

/**
 * A cylinder of radius r, height h as an importer may hand it over: its side in three faces (the front half; the back
 * half below and above a middle arc), that arc `off` outside the side and the top vertex at u = pi `miss` along the top
 * off the line up to it, each within its tolerance. The side's faces still cover the whole side, so the volume is
 * pi r^2 h.
 */
function imported(r, h, off, miss) {
  const body = new Body('part', 'solid'),
    shell = body.shell(),
    side = { kind: 'cylinder', frame: frameOf([0, 0, 0], [0, 0, 1], [1, 0, 0]), radius: r },
    ring = (z, radius) => ({ kind: 'circle', frame: frameOf([0, 0, z], [0, 0, 1], [1, 0, 0]), radius }),
    at = (radius, u, z) => [radius * Math.cos(u), radius * Math.sin(u), z],
    tolerance = 2 * Math.max(off, miss),
    b0 = new Vertex('b0', at(r, 0, 0)),
    b1 = new Vertex('b1', at(r, Math.PI, 0)),
    m0 = new Vertex('m0', at(r + off, 0, h / 2), tolerance),
    m1 = new Vertex('m1', at(r + off, Math.PI, h / 2), tolerance),
    t0 = new Vertex('t0', at(r, 0, h)),
    t1 = new Vertex('t1', at(r, Math.PI + miss / r, h), tolerance),
    line = (name, a, b, to = b.point) => {
      const d = to.map((x, k) => x - a.point[k]),
        l = Math.hypot(...d);
      return new Edge(name, { kind: 'line', origin: a.point, direction: d.map((x) => x / l) }, a, b, true, tolerance);
    },
    front0 = new Edge('bottom-front', ring(0, r), b0, b1),
    back0 = new Edge('bottom-back', ring(0, r), b1, b0),
    front1 = new Edge('top-front', ring(h, r), t0, t1),
    back1 = new Edge('top-back', ring(h, r), t1, t0),
    middle = new Edge('middle', ring(h / 2, r + off), m1, m0, true, tolerance),
    low0 = line('low0', b0, m0),
    high0 = line('high0', m0, t0),
    low1 = line('low1', b1, m1),
    high1 = line('high1', m1, t1, at(r, Math.PI, h));
  const face = (name, surface, uses) => {
    const loop = shell.add(new Face(name, surface, true)).loop();
    for (const [e, forward] of uses) loop.use(e, forward);
  };
  face('front', side, [
    [front0, true],
    [low1, true],
    [high1, true],
    [front1, false],
    [high0, false],
    [low0, false],
  ]);
  face('back-low', side, [
    [back0, true],
    [low0, true],
    [middle, false],
    [low1, false],
  ]);
  face('back-high', side, [
    [middle, true],
    [high0, true],
    [back1, false],
    [high1, false],
  ]);
  face('top', { kind: 'plane', frame: frameOf([0, 0, h], [0, 0, 1], [1, 0, 0]) }, [
    [front1, true],
    [back1, true],
  ]);
  face('bottom', { kind: 'plane', frame: frameOf([0, 0, 0], [0, 0, -1], [1, 0, 0]) }, [
    [back0, false],
    [front0, false],
  ]);
  return body;
}

test('mass properties: imported edges a little off their faces, however the faces are split', () => {
  // The middle arc 0.1 um outside the side moves round it faster than its foot, and the top vertex 10 nm off its line
  // leaves the front and back-high loops open there. Both once made a face's integrals depend on where its inner
  // integral starts (the front's at the bottom, back-high's at the middle): 8.6e-6 of the volume in all.
  const [r, h] = [2, 10];
  for (const [off, miss] of [
    [1e-7, 0],
    [0, 1e-8],
    [1e-7, 1e-8],
  ]) {
    const part = imported(r * mm, h * mm, off, miss),
      volume = Math.PI * r * r * h;
    assert.deepEqual(validateBody(part), []);
    expect(part, { volume, area: 2 * Math.PI * r * r + 2 * Math.PI * r * h, centroid: [0, 0, h / 2] }, 1e-12);
    // A drill that misses the part: the Boolean joins the side's three faces into one and the volume stays (Jubilee
    // body 121's thread crest, 35 half turns joined, came out 2e-5 of the part larger).
    const drilled = boolean(
      'd',
      'subtract',
      part,
      cylinder('h', mm, 20 * mm, frameOf([10 * mm, 0, -5 * mm], [0, 0, 1], [1, 0, 0])),
    );
    assert.equal(drilled.faces.length, 3);
    expect(drilled, { volume }, 1e-12);
  }
});
