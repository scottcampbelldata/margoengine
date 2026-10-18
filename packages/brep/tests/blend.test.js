import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../dist/index.js';

const { boolean, box, chamfer, cylinder, fillet, frameOf, History, meshBodies, validateBody } = model;

const mm = 0.001,
  at = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]),
  cube = () => box('a', [10 * mm, 10 * mm, 10 * mm]);

/** Volume (mm^3) and open edges of a body's meshes, vertices joined where positions are equal. */
function measure(body) {
  let volume = 0,
    open = 0;
  for (const m of meshBodies([body], { deflection: 1e-7 }).meshes) {
    assert.deepEqual(m.failures, []);
    const p = m.positions,
      t = m.indices,
      ids = new Map(),
      directed = new Map(),
      weld = (i) => {
        const key = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
        if (!ids.has(key)) ids.set(key, ids.size);
        return ids.get(key);
      };
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
    for (const [key, n] of directed) {
      const [x, y] = key.split(',');
      if (n !== 1 || directed.get(`${y},${x}`) !== 1) open++;
    }
  }
  return { volume: volume / mm ** 3, open };
}

function solid(body, volume, tolerance = 1e-4) {
  assert.deepEqual(validateBody(body), []);
  const r = measure(body);
  assert.equal(r.open, 0, 'closed');
  if (volume !== undefined)
    assert.ok(Math.abs(r.volume - volume) <= tolerance * volume, `volume ${r.volume} vs ${volume}`);
  return r;
}

const parallel = ['a/edge:+z:-y', 'a/edge:+z:+y', 'a/edge:-z:-y', 'a/edge:-z:+y'];

test('fillets and chamfers: one edge, and four parallel edges of a box, to their exact volumes', () => {
  const r = 2;
  solid(fillet('f', cube(), ['a/edge:+z:-y'], r * mm), 1000 - (4 - Math.PI) * 10);
  solid(chamfer('c', cube(), ['a/edge:+z:-y'], r * mm), 1000 - 2 * 10);
  solid(fillet('f4', cube(), parallel, r * mm), 10 * (100 - 4 * (4 - Math.PI)));
  solid(chamfer('c4', cube(), parallel, r * mm), 10 * (100 - 4 * 2));
});

test('fillets: a concave edge adds material; a box with every edge rounded has sphere corners', () => {
  // An L block (20 x 10 x 5 below, 10 x 10 x 10 above): its inner edge rounded fills in (1 - pi/4) r^2 per length.
  const L = boolean(
      'L',
      'union',
      box('low', [20 * mm, 10 * mm, 5 * mm]),
      box('high', [10 * mm, 10 * mm, 15 * mm], at(0, 0, 0)),
    ),
    inner = L.edges.find(
      (e) =>
        e.curve.kind === 'line' &&
        [e.start, e.end].every((v) => Math.abs(v.point[0] - 10 * mm) < 1e-12 && Math.abs(v.point[2] - 5 * mm) < 1e-12),
    );
  solid(fillet('fl', L, [inner.name], 2 * mm), 2000 + (4 - Math.PI) * 10);
  // A 10 mm cube, radius 2: a core, slabs on the faces, quarter cylinders on the edges and a ball at the corners.
  const r = 2,
    c = 10 - 2 * r,
    rounded = fillet(
      'rb',
      cube(),
      cube().edges.map((e) => e.name),
      r * mm,
    );
  solid(rounded, c ** 3 + 6 * r * c * c + 3 * Math.PI * r * r * c + (4 / 3) * Math.PI * r ** 3);
  const kinds = rounded.faces.map((f) => f.surface.kind);
  assert.deepEqual(
    [
      kinds.filter((k) => k === 'plane').length,
      kinds.filter((k) => k === 'cylinder').length,
      kinds.filter((k) => k === 'sphere').length,
    ],
    [6, 12, 8],
  );
});

test('fillets: two rounded edges meeting at a corner meet at a mitre; names and history', () => {
  const history = new History(),
    body = fillet('m', cube(), ['a/edge:+z:-y', 'a/edge:+z:+x'], 2 * mm, { history });
  solid(body);
  assert.ok(body.faces.some((f) => f.name === 'm:a/edge:+z:-y/face:round'));
  assert.ok(body.faces.some((f) => f.name === 'm:a/edge:+z:+x/face:round'));
  // The top face is still the top face.
  assert.deepEqual(history.resolve('a/face:+z'), ['a/face:+z']);
});

test('fillets and chamfers on full circles: a boss top, a hole rim, and a boss meeting a plate', () => {
  const r = 1,
    area = r * r * (1 - Math.PI / 4),
    // The rounding's cross-section has its centroid this far from the corner, along both faces (Pappus gives volumes).
    offset = (r * (5 / 6 - Math.PI / 4)) / (1 - Math.PI / 4),
    up = (x, y, z) => frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]),
    topCircle = (b, z) =>
      b.edges.find((e) => e.curve.kind === 'circle' && Math.abs(e.curve.frame.origin[2] - z * mm) < 1e-12).name,
    can = () => cylinder('c', 5 * mm, 10 * mm),
    plate = () =>
      boolean(
        'plate',
        'subtract',
        box('b', [20 * mm, 20 * mm, 10 * mm]),
        cylinder('h', 3 * mm, 20 * mm, up(10, 10, -5)),
      );
  solid(fillet('bf', can(), [topCircle(can(), 10)], r * mm), Math.PI * 250 - area * 2 * Math.PI * (5 - offset));
  solid(chamfer('bc', can(), [topCircle(can(), 10)], r * mm), Math.PI * 250 - 0.5 * 2 * Math.PI * (5 - r / 3));
  solid(
    fillet('hf', plate(), [topCircle(plate(), 10)], r * mm),
    4000 - Math.PI * 90 - area * 2 * Math.PI * (3 + offset),
  );
  // A countersink.
  solid(
    chamfer('hc', plate(), [topCircle(plate(), 10)], r * mm),
    4000 - Math.PI * 90 - 0.5 * 2 * Math.PI * (3 + r / 3),
  );
  const bossed = boolean(
    'pb',
    'union',
    box('b', [20 * mm, 20 * mm, 10 * mm]),
    cylinder('c', 3 * mm, 5 * mm, up(10, 10, 10)),
  );
  solid(fillet('jf', bossed, [topCircle(bossed, 10)], r * mm), 4000 + Math.PI * 45 + area * 2 * Math.PI * (3 + offset));
});

test('fillets and chamfers: what is not supported throws a RangeError that names the edge', () => {
  assert.throws(() => fillet('x', cube(), ['a/edge:nope'], 1 * mm), {
    name: 'RangeError',
    message: /no edge a\/edge:nope/,
  });
  assert.throws(() => fillet('x', cube(), ['a/edge:+z:-y'], 0), {
    name: 'RangeError',
    message: /radius must be positive/,
  });
  // A cylinder's seam lies between its side face and itself.
  const can = cylinder('c', 5 * mm, 10 * mm);
  assert.throws(() => fillet('x', can, [can.edges.find((e) => e.curve.kind === 'line').name], 1 * mm), {
    name: 'RangeError',
    message: /an edge between two faces/,
  });
});
