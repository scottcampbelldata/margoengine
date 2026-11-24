// STEP import of offsets of B-spline surfaces (ISO 10303-42 offset_surface): fitted as a bicubic B-spline within
// 1e-7 m of the offset, noted in ImportedBodies.notes with its error, and refused where the offset turns inside out.
// Before, a face on one made its body fail. Fixtures: a body exported here with one surface rewritten as the surface
// that traces it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const { bodiesFromSTEP, bodiesToSTEP, checkBody, cylinder, massProperties, sphere } = model;
const mm = 0.001,
  real = (x) => (Number.isInteger(x) ? `${x}.` : String(x)),
  pt = (p) => `CARTESIAN_POINT('',(${p.map(real).join(',')}))`;

/**
 * The STEP text with its entity `#id` (or its one entity of type `kind`) replaced by `make(add)`, the new entities `add`
 * hands out ids for added from 900000; `sense` sets the same_sense of the face on it.
 */
function rewrite(text, kind, make, sense) {
  const lines = text.split('\n'),
    at = lines.findIndex((l) => l.startsWith(`${kind}=`) || l.includes(`=${kind}(`));
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
  if (sense !== undefined) {
    const face = lines.findIndex((l) => l.includes('ADVANCED_FACE') && l.endsWith(`,#${id},.T.);`));
    assert.ok(face >= 0, `no face on #${id}`);
    lines[face] = lines[face].replace(/\.T\.\);$/, sense ? '.T.);' : '.F.);');
  }
  lines.splice(lines.lastIndexOf('ENDSEC;'), 0, ...extra);
  return lines.join('\n');
}

const dir = (add, d) => add(`DIRECTION('',(${d.map(real).join(',')}))`),
  vec = (add, d) => add(`VECTOR('',${dir(add, d)},1.)`);

/** A whole circle of radius r about z at height 0, counter-clockwise about z, as a rational quadratic B-spline. */
function ringCurve(add, r) {
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
    pts = xy.map(([x, y]) => add(pt([r * x, r * y, 0]))),
    ws = xy.map((_, k) => real(k % 2 ? w : 1));
  return add(
    `(BOUNDED_CURVE()B_SPLINE_CURVE(2,(${pts.join(',')}),.CIRCULAR_ARC.,.T.,.F.)` +
      `B_SPLINE_CURVE_WITH_KNOTS((3,2,2,2,3),(0.,0.25,0.5,0.75,1.),.UNSPECIFIED.)` +
      `CURVE()GEOMETRIC_REPRESENTATION_ITEM()` +
      `RATIONAL_B_SPLINE_CURVE((${ws.join(',')}))REPRESENTATION_ITEM(''))`,
  );
}

const read = (text) => bodiesFromSTEP(parseSTEP(text));
function imported(text) {
  const r = read(text);
  assert.deepEqual(r.problems, []);
  assert.equal(r.bodies.length, 1);
  return { body: r.bodies[0], notes: r.notes };
}

const r = 5 * mm,
  h = 10 * mm,
  d = 1 * mm;

test('STEP import: an offset of a B-spline is fitted within 1e-7 m, its error noted; a flat one exactly', () => {
  // The side of a cylinder of radius r as the offset by d of a B-spline ring of radius r - d swept up (its normal out),
  // and by d of one of r + d swept down (in). The fit lies within its noted error of the circle, so the volume within
  // that error times the side's area.
  const text = bodiesToSTEP([cylinder('c', r, h)]),
    side = 2 * Math.PI * r * h;
  for (const [what, ring, up] of [
    ['out', r - d, true],
    ['in', r + d, false],
  ]) {
    const { body, notes } = imported(
        rewrite(
          text,
          'CYLINDRICAL_SURFACE',
          (add) =>
            `OFFSET_SURFACE('',${add(`SURFACE_OF_LINEAR_EXTRUSION('',${ringCurve(add, ring)},${vec(add, [0, 0, up ? 1 : -1])})`)},${real(d)},.F.)`,
          up,
        ),
      ),
      fitted = body.faces.find((f) => f.surface.kind === 'spline');
    assert.equal(notes.length, 1, what);
    const error = Number(/fitted within (\S+) m/.exec(notes[0].note)[1]);
    assert.ok(error > 0 && error <= 1e-7, `${what}: ${notes[0].note}`);
    assert.equal(fitted.surface.degrees.join(), '3,3', what);
    assert.deepEqual(checkBody(body), [], what);
    const m = massProperties(body);
    assert.ok(Math.abs(m.volume - Math.PI * r * r * h) <= side * error * 1.01, `${what}: volume ${m.volume}`);
  }
  // A flat B-spline (a bilinear patch over the -z cap's plane, its normal down) moved by d down and back: a cubic holds
  // a plane exactly.
  const cap = text.split('\n').find((l) => l.includes("ADVANCED_FACE('c/face:-z'")),
    id = /,#(\d+),\.T\.\);$/.exec(cap)[1],
    s = 2 * r,
    corners = [
      [-s, s, d],
      [-s, -s, d],
      [s, s, d],
      [s, -s, d],
    ],
    { body, notes } = imported(
      rewrite(text, `#${id}`, (add) => {
        const p = corners.map((c) => add(pt(c))),
          patch = add(
            `B_SPLINE_SURFACE_WITH_KNOTS('',1,1,((${p[0]},${p[1]}),(${p[2]},${p[3]})),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.)`,
          );
        return `OFFSET_SURFACE('',${patch},${real(d)},.F.)`;
      }),
    );
  // Su x Sv of that patch: u along +x, v along -y, so down; the offset by d down lies on z = 0.
  const flat = body.faces.find((f) => f.surface.kind === 'spline');
  assert.ok(flat.surface.points.every((q) => Math.abs(q[2]) < 1e-18), 'the fitted plane lies on z = 0');
  assert.match(notes[0].note, /fitted within/);
  assert.ok(Number(/fitted within (\S+) m/.exec(notes[0].note)[1]) < 1e-15);
  const m = massProperties(body);
  assert.ok(Math.abs(m.volume - Math.PI * r * r * h) < 1e-12 * Math.PI * r * r * h, `flat: volume ${m.volume}`);
});

test('STEP import: an offset of a B-spline sphere is fitted round its poles; one past its centre is refused', () => {
  // A sphere of radius r as the offset by d of a B-spline sphere of r - d (a half circle turned round its diameter:
  // poles where Su x Sv vanishes, its normal there the limit beside them).
  const text = bodiesToSTEP([sphere('s', r)]),
    w = Math.SQRT1_2,
    sphereOf = (add, q) => {
      const arc = [
          [0, 0, -q, 1],
          [q, 0, -q, w],
          [q, 0, 0, 1],
          [q, 0, q, w],
          [0, 0, q, 1],
        ],
        pts = arc.map((c) => add(pt(c.slice(0, 3)))),
        curve = add(
          `(BOUNDED_CURVE()B_SPLINE_CURVE(2,(${pts.join(',')}),.CIRCULAR_ARC.,.F.,.F.)` +
            `B_SPLINE_CURVE_WITH_KNOTS((3,2,3),(0.,0.5,1.),.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()` +
            `RATIONAL_B_SPLINE_CURVE((${arc.map((c) => real(c[3])).join(',')}))REPRESENTATION_ITEM(''))`,
        );
      return add(`SURFACE_OF_REVOLUTION('',${curve},${add(`AXIS1_PLACEMENT('',${add(pt([0, 0, 0]))},${dir(add, [0, 0, 1])})`)})`);
    },
    { body, notes } = imported(
      rewrite(text, 'SPHERICAL_SURFACE', (add) => `OFFSET_SURFACE('',${sphereOf(add, r - d)},${real(d)},.F.)`),
    ),
    error = Number(/fitted within (\S+) m/.exec(notes[0].note)[1]);
  assert.ok(error > 0 && error <= 1e-7, notes[0].note);
  const m = massProperties(body);
  assert.ok(Math.abs(m.volume - (4 / 3) * Math.PI * r ** 3) <= 4 * Math.PI * r * r * error * 1.01, `volume ${m.volume}`);
  // Moved in by 2 r, past its centre: the offset turns inside out, and the body is left out with the reason.
  const past = read(rewrite(text, 'SPHERICAL_SURFACE', (add) => `OFFSET_SURFACE('',${sphereOf(add, r)},${real(-2 * r)},.F.)`));
  assert.equal(past.bodies[0], undefined);
  assert.match(past.problems[0].problem, /turns inside out/);
});
