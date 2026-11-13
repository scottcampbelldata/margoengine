// STEP import of swept surfaces of general curves (ISO 10303-42 surface_of_linear_extrusion and
// surface_of_revolution of B-spline curves and ellipses, as public CAD files write them): the modeler takes each as
// the exact B-spline surface it sweeps. Fixtures: a body exported here with one analytic surface rewritten as the
// swept surface that traces it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const { bodiesFromSTEP, bodiesToSTEP, checkBody, cylinder, massProperties, sphere } = model;
const mm = 0.001,
  close = (a, b, rel, what) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${what}: ${a} against ${b}`),
  real = (x) => (Number.isInteger(x) ? `${x}.` : String(x)),
  pt = (p) => `CARTESIAN_POINT('',(${p.map(real).join(',')}))`;

/**
 * The STEP text with its one entity of type `kind` replaced by `make(ids)`'s first entity, its other entities added
 * with ids from 900000 (`make` gets a function handing out those ids, and returns entity bodies in id order).
 */
function rewrite(text, kind, make) {
  const lines = text.split('\n'),
    at = lines.findIndex((l) => new RegExp(`^#\\d+=${kind}\\(`).test(l));
  assert.ok(at >= 0, `no ${kind} in the export`);
  const id = /^#(\d+)=/.exec(lines[at])[1];
  let next = 900000;
  const extra = [],
    add = (body) => {
      const n = next++;
      extra.push(`#${n}=${body};`);
      return `#${n}`;
    };
  lines[at] = `#${id}=${make(add)};`;
  const end = lines.lastIndexOf('ENDSEC;');
  lines.splice(end, 0, ...extra);
  return lines.join('\n');
}

/** A whole circle of radius r about z at height z0, as a rational quadratic B-spline curve entity. */
function ringCurve(add, r, z0) {
  const w = Math.SQRT1_2,
    xy = [
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
      [0, -1],
      [1, -1],
      [1, 0],
    ],
    pts = xy.map(([x, y]) => add(pt([r * x, r * y, z0]))),
    ws = xy.map((_, k) => real(k % 2 ? w : 1));
  return add(
    `(BOUNDED_CURVE()B_SPLINE_CURVE(2,(${pts.join(',')}),.CIRCULAR_ARC.,.T.,.F.)` +
      `B_SPLINE_CURVE_WITH_KNOTS((3,2,2,2,3),(0.,0.25,0.5,0.75,1.),.UNSPECIFIED.)` +
      `CURVE()GEOMETRIC_REPRESENTATION_ITEM()` +
      `RATIONAL_B_SPLINE_CURVE((${ws.join(',')}))REPRESENTATION_ITEM(''))`,
  );
}

function imported(text) {
  const r = bodiesFromSTEP(parseSTEP(text));
  assert.deepEqual(r.problems, []);
  assert.equal(r.bodies.length, 1);
  return r.bodies[0];
}

test('STEP import: a B-spline circle or an ellipse extruded along its axis is the side of a cylinder', () => {
  const r = 5 * mm,
    h = 10 * mm,
    text = bodiesToSTEP([cylinder('c', r, h)]),
    up = (add) => add(`VECTOR('',${add("DIRECTION('',(0.,0.,1.))")},1.)`);
  const viaSpline = rewrite(
      text,
      'CYLINDRICAL_SURFACE',
      (add) => `SURFACE_OF_LINEAR_EXTRUSION('',${ringCurve(add, r, 0)},${up(add)})`,
    ),
    viaEllipse = rewrite(text, 'CYLINDRICAL_SURFACE', (add) => {
      const place = add(
        `AXIS2_PLACEMENT_3D('',${add(pt([0, 0, -3 * mm]))},` +
          `${add("DIRECTION('',(0.,0.,1.))")},${add("DIRECTION('',(1.,0.,0.))")})`,
      );
      return `SURFACE_OF_LINEAR_EXTRUSION('',${add(`ELLIPSE('',${place},${real(r)},${real(r)})`)},${up(add)})`;
    });
  for (const [what, t] of [
    ['B-spline circle', viaSpline],
    ['ellipse', viaEllipse],
  ]) {
    const body = imported(t),
      side = body.faces.find((f) => f.surface.kind !== 'plane');
    assert.equal(side.surface.kind, 'spline', what);
    assert.deepEqual(checkBody(body), [], what);
    const m = massProperties(body);
    close(m.volume, Math.PI * r * r * h, 1e-9, `${what} volume`);
    close(m.area, 2 * Math.PI * r * (r + h), 1e-9, `${what} area`);
  }
});

test('STEP import: a B-spline half circle turned round its diameter is a sphere', () => {
  const r = 4 * mm,
    text = bodiesToSTEP([sphere('s', r)]),
    w = Math.SQRT1_2,
    // From the south pole to the north through (r, 0, 0), in the x z plane: two rational quadratic quarter arcs.
    arc = [
      [0, 0, -r, 1],
      [r, 0, -r, w],
      [r, 0, 0, 1],
      [r, 0, r, w],
      [0, 0, r, 1],
    ],
    t = rewrite(text, 'SPHERICAL_SURFACE', (add) => {
      const pts = arc.map((q) => add(pt(q.slice(0, 3)))),
        curve = add(
          `(BOUNDED_CURVE()B_SPLINE_CURVE(2,(${pts.join(',')}),.CIRCULAR_ARC.,.F.,.F.)` +
            `B_SPLINE_CURVE_WITH_KNOTS((3,2,3),(0.,0.5,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()` +
            `RATIONAL_B_SPLINE_CURVE((${arc.map((q) => real(q[3])).join(',')}))REPRESENTATION_ITEM(''))`,
        ),
        axis = add(`AXIS1_PLACEMENT('',${add(pt([0, 0, 0]))},${add("DIRECTION('',(0.,0.,1.))")})`);
      return `SURFACE_OF_REVOLUTION('',${curve},${axis})`;
    }),
    body = imported(t);
  assert.ok(body.faces.every((f) => f.surface.kind === 'spline'));
  assert.deepEqual(checkBody(body), []);
  const m = massProperties(body);
  close(m.volume, (4 / 3) * Math.PI * r ** 3, 1e-9, 'sphere volume');
  close(m.area, 4 * Math.PI * r * r, 1e-9, 'sphere area');
});

test('a point projected onto a spline sphere from a hint at its pole lands on the point, whichever meridian it is on', () => {
  // A half circle turned round its diameter, as revolvedSurface makes it: u turns, v runs pole to pole. At a pole u
  // means nothing, so a hint there (an edge's first point, at the pole) gives no meridian to start down: from the hint's
  // u, Gauss-Newton ran down the wrong one and stopped at the pole, up to 1.5 mm off a point 1.5 mm up a 4 mm sphere.
  const r = 4 * mm,
    w = Math.SQRT1_2,
    arc = [
      [0, -r, 1],
      [r, -r, w],
      [r, 0, 1],
      [r, r, w],
      [0, r, 1],
    ],
    ring = [
      [1, 0, 1],
      [1, 1, w],
      [0, 1, 1],
      [-1, 1, w],
      [-1, 0, 1],
      [-1, -1, w],
      [0, -1, 1],
      [1, -1, w],
      [1, 0, 1],
    ],
    points = [],
    weights = [];
  for (const [radius, z, wv] of arc)
    for (const [a, b, wr] of ring) {
      points.push([radius * a, radius * b, z]);
      weights.push(wv * wr);
    }
  const s = model.surfaceEvaluator({
    kind: 'spline',
    uClosed: true,
    vClosed: false,
    degrees: [2, 2],
    counts: [9, 5],
    knots: [
      [0, 0.25, 0.5, 0.75, 1],
      [0, 0.5, 1],
    ],
    multiplicities: [
      [3, 2, 2, 2, 3],
      [3, 2, 3],
    ],
    points,
    weights,
  });
  for (const hint of [0, 0.25, 0.5, 0.75, 0.96875])
    for (const lat of [-1.5, -1.4, -1.2, -0.8])
      for (const lon of [0, 1.1, 2.5, 4]) {
        const p = [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)],
          [u, v] = s.parameters(p, [hint, 0]),
          q = s.at(u, v);
        assert.ok(
          Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-12,
          `hint u ${hint}, latitude ${lat}, longitude ${lon}: (${u}, ${v})`,
        );
      }
});

test('a B-spline profile hooking back near its end, extruded: its edges lie on its face, found from any start', () => {
  // A cubic profile from (0, 0) that dips 0.3 um below its start and comes back within 1 um of it by a sixth of the
  // way along, swept 5 mm up (writers make such hooks where a fillet's profile meets a flat). The samples' Gauss-Newton
  // stopped on the hook's near side (0.8 um off the point at the profile's end) or held at the end (4 um off), and
  // validateBody then reported edges lying on the face as off it.
  const { Body, Edge, Face, Vertex, validateBody } = model,
    s = 1e-5,
    h = 5 * mm,
    profile = [
      [0, 0],
      [0, -1],
      [1, 4],
      [3, 13],
    ].map(([x, y]) => [x * s, y * s]),
    at = (t, z) => {
      const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
      return [...[0, 1].map((k) => b.reduce((a, w, i) => a + w * profile[i][k], 0)), z];
    },
    surface = {
      kind: 'spline',
      degrees: [3, 1],
      counts: [4, 2],
      knots: [
        [0, 1],
        [0, h],
      ],
      multiplicities: [
        [4, 4],
        [2, 2],
      ],
      points: [...profile.map(([x, y]) => [x, y, 0]), ...profile.map(([x, y]) => [x, y, h])],
    },
    S = model.surfaceEvaluator(surface);
  for (const z of [0, h / 2, h])
    for (let i = 0; i <= 8; i++) {
      const p = at(i / 8, z),
        [u, v] = S.parameters(p),
        q = S.at(u, v);
      assert.ok(Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < 1e-15, `t ${i / 8}, z ${z}: (${u}, ${v})`);
    }
  // The face as a sheet: the profile at the foot and at the top, and the two rulings.
  const body = new Body('hook', 'sheet'),
    shell = body.shell(),
    v00 = new Vertex('v00', at(0, 0)),
    v10 = new Vertex('v10', at(1, 0)),
    v01 = new Vertex('v01', at(0, h)),
    v11 = new Vertex('v11', at(1, h)),
    curve = (z) => ({
      kind: 'spline',
      degrees: [3],
      counts: [4],
      knots: [[0, 1]],
      multiplicities: [[4, 4]],
      points: profile.map(([x, y]) => [x, y, z]),
    }),
    up = (name, a, b) => new Edge(name, { kind: 'line', origin: a.point, direction: [0, 0, 1] }, a, b),
    loop = shell.add(new Face('hook/face', surface, true)).loop();
  loop.use(new Edge('foot', curve(0), v00, v10), true);
  loop.use(up('right', v10, v11), true);
  loop.use(new Edge('top', curve(h), v01, v11), false);
  loop.use(up('left', v00, v01), false);
  assert.deepEqual(validateBody(body), []);
});
