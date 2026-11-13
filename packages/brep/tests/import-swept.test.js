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
