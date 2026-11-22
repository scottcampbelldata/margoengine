// STEP import of swept surfaces read as analytic ones, and of offsets of them. A face's sense and an offset's distance
// are given against STEP's own normal, Su x Sv of the surface's parameters: a line turned round an axis running down
// it, or a circle swept against its turn, has the normal into the cylinder, which the modeler's cylinder (normal out)
// must turn. Before, such a face came out silently inside out: massProperties and checkBody integrate the surface as it
// is and do not notice, but its mesh is wound inward and encloses a negative volume. Fixtures: a body exported here
// with one surface rewritten as the surface that traces it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP } from '../dist/index.js';

const { bodiesFromSTEP, bodiesToSTEP, checkBody, cylinder, massProperties, meshBodies } = model;
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
  vec = (add, d) => add(`VECTOR('',${dir(add, d)},1.)`),
  revolvedLine = (add, at, d) =>
    `SURFACE_OF_REVOLUTION('',${add(`LINE('',${add(pt(at))},${vec(add, d)})`)},${add(`AXIS1_PLACEMENT('',${add(pt([0, 0, 0]))},${dir(add, [0, 0, 1])})`)})`,
  extrudedCircle = (add, r, d) =>
    `SURFACE_OF_LINEAR_EXTRUSION('',${add(`CIRCLE('',${add(`AXIS2_PLACEMENT_3D('',${add(pt([0, 0, 0]))},${dir(add, [0, 0, 1])},${dir(add, [1, 0, 0])})`)},${real(r)})`)},${vec(add, d)})`;

const read = (text) => bodiesFromSTEP(parseSTEP(text));
function imported(text) {
  const r = read(text);
  assert.deepEqual(r.problems, []);
  assert.equal(r.bodies.length, 1);
  return { body: r.bodies[0] };
}
/** The face normal (out of the solid) of a plane face. */
const planeNormal = (f) => f.surface.frame.z.map((x) => (f.sense ? x : -x));

const r = 5 * mm,
  h = 10 * mm,
  d = 1 * mm;

test('STEP import: a plane turned from a line running out from its axis faces against the axis, as STEP says', () => {
  // ISO's normal of a surface of revolution is the turn's way across the line's: for a line running out from the axis
  // at right angles, down the axis. The +z cap as such a plane, its face against that normal (same_sense false), faces
  // up; it was read as a plane facing up with its face turned, facing down into the solid (mass and checks unchanged).
  const text = bodiesToSTEP([cylinder('c', r, h)]),
    plane = text.split('\n').find((l) => l.includes("ADVANCED_FACE('c/face:+z'")),
    id = /,#(\d+),\.T\.\);$/.exec(plane)[1],
    { body } = imported(rewrite(text, `#${id}`, (add) => revolvedLine(add, [r / 2, 0, h], [1, 0, 0]), false)),
    top = body.faces.find((f) => f.surface.kind === 'plane' && Math.abs(f.surface.frame.origin[2] - h) < 1e-12);
  assert.deepEqual(planeNormal(top), [0, 0, 1]);
  const inward = imported(rewrite(text, `#${id}`, (add) => revolvedLine(add, [r / 2, 0, h], [-1, 0, 0]), true)).body,
    top2 = inward.faces.find((f) => f.surface.kind === 'plane' && Math.abs(f.surface.frame.origin[2] - h) < 1e-12);
  assert.deepEqual(planeNormal(top2), [0, 0, 1]);
});

test('STEP import: a cylinder from a line turned or a circle swept against STEP normal has its face turned back out', () => {
  const text = bodiesToSTEP([cylinder('c', r, h)]);
  for (const [what, make, up] of [
    ['line up the axis', (add) => revolvedLine(add, [r, 0, 0], [0, 0, 1]), true],
    ['line down the axis', (add) => revolvedLine(add, [r, 0, 0], [0, 0, -1]), false],
    ['circle swept up', (add) => extrudedCircle(add, r, [0, 0, 1]), true],
    ['circle swept down', (add) => extrudedCircle(add, r, [0, 0, -1]), false],
  ]) {
    // STEP's normal points into the cylinder for the down cases: the side's face (out of the solid) is against it.
    const { body } = imported(rewrite(text, 'CYLINDRICAL_SURFACE', make, up)),
      side = body.faces.find((f) => f.surface.kind === 'cylinder');
    assert.equal(side.sense, true, what);
    assert.deepEqual(checkBody(body), [], what);
  }
});

test('STEP import: an offset of a swept surface read as a cylinder moves along STEP normal, in or out', () => {
  // A cylinder of radius r written as the offset by d of a surface of radius r + d whose STEP normal points in (or of
  // radius r - d pointing out). Before, the offset moved along the modeler cylinder's normal: radius r + 2 d.
  const text = bodiesToSTEP([cylinder('c', r, h)]);
  for (const [what, make] of [
    ['line down the axis at r + d', (add) => revolvedLine(add, [r + d, 0, 0], [0, 0, -1])],
    ['line up the axis at r - d', (add) => revolvedLine(add, [r - d, 0, 0], [0, 0, 1])],
    ['circle of r + d swept down', (add) => extrudedCircle(add, r + d, [0, 0, -1])],
    ['circle of r - d swept up', (add) => extrudedCircle(add, r - d, [0, 0, 1])],
  ]) {
    const inward = what.includes('+ d'),
      { body } = imported(
        rewrite(text, 'CYLINDRICAL_SURFACE', (add) => `OFFSET_SURFACE('',${add(make(add))},${real(d)},.F.)`, !inward),
      ),
      side = body.faces.find((f) => f.surface.kind === 'cylinder');
    assert.ok(Math.abs(side.surface.radius - r) < 1e-15, `${what}: radius ${side.surface.radius}`);
    assert.equal(side.sense, true, what);
    const m = massProperties(body);
    assert.ok(Math.abs(m.volume - Math.PI * r * r * h) < 1e-12 * Math.PI * r * r * h, `${what}: volume ${m.volume}`);
  }
});

/** The signed volume a body's meshes enclose: positive when they are wound outward. */
function meshVolume(body) {
  let volume = 0;
  for (const m of meshBodies([body], { deflection: 1e-7 }).meshes) {
    assert.deepEqual(m.failures, []);
    const at = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [at(m.indices[t]), at(m.indices[t + 1]), at(m.indices[t + 2])];
      volume +=
        (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
        6;
    }
  }
  return volume;
}

test('STEP import: a solid with a side swept against STEP normal meshes to its own volume, not a negative one', () => {
  // The side of a cylinder (z from 0 to h) as a line turned round z running down the axis, or a circle swept down: its
  // face was read inside out, its mesh wound inward. The side carries 2/3 of the divergence integral and the top cap
  // 1/3, so that mesh enclosed -V / 3; massProperties gave V either way.
  const text = bodiesToSTEP([cylinder('c', r, h)]),
    volume = Math.PI * r * r * h;
  for (const [what, make, sense] of [
    ['line down the axis', (add) => revolvedLine(add, [r, 0, 0], [0, 0, -1]), false],
    ['circle swept down', (add) => extrudedCircle(add, r, [0, 0, -1]), false],
    ['line up the axis', (add) => revolvedLine(add, [r, 0, 0], [0, 0, 1]), true],
  ]) {
    const { body } = imported(rewrite(text, 'CYLINDRICAL_SURFACE', make, sense)),
      v = meshVolume(body);
    assert.ok(Math.abs(massProperties(body).volume - volume) < 1e-12 * volume, `${what}: mass volume`);
    assert.ok(v > 0, `${what}: mesh volume ${v}`);
    assert.ok(Math.abs(v - volume) < 1e-3 * volume, `${what}: mesh volume ${v} vs ${volume}`);
  }
});

test('STEP import: a rectangular trimmed surface with one sense false faces against its basis surface, as STEP says', () => {
  // ISO 10303-42: usense and vsense say whether the trimmed surface's parameters run with its basis surface's; where
  // exactly one runs against, its normal (Su x Sv) is the basis surface's turned, and the face's same_sense is given
  // against that. The side of a cylinder written on a trimmed copy of it: with one sense false its face (out of the
  // solid) is against the trimmed normal. Before, the senses were ignored and that face came out inside out (its mesh
  // wound inward); massProperties integrated it as it was and still gave V.
  const text = bodiesToSTEP([cylinder('c', r, h)]),
    line = text.split('\n').find((l) => l.includes('=CYLINDRICAL_SURFACE(')),
    basis = /^#\d+=(.*);$/.exec(line)[1],
    volume = Math.PI * r * r * h;
  for (const [us, vs] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]) {
    const what = `usense ${us}, vsense ${vs}`,
      flag = (b) => (b ? '.T.' : '.F.'),
      trimmed = (add) =>
        `RECTANGULAR_TRIMMED_SURFACE('',${add(basis)},0.,${real(2 * Math.PI)},0.,${real(h)},${flag(us)},${flag(vs)})`,
      { body } = imported(rewrite(text, 'CYLINDRICAL_SURFACE', trimmed, us === vs)),
      side = body.faces.find((f) => f.surface.kind === 'cylinder');
    assert.equal(side.sense, true, what);
    assert.deepEqual(checkBody(body), [], what);
    assert.ok(Math.abs(massProperties(body).volume - volume) < 1e-12 * volume, `${what}: mass volume`);
    const v = meshVolume(body);
    assert.ok(Math.abs(v - volume) < 1e-3 * volume, `${what}: mesh volume ${v} vs ${volume}`);
  }
});

test('STEP import: a plane trimmed with one sense false faces against the plane; a trimmed offset moves with it', () => {
  // The top cap on a trimmed plane with usense false: its STEP normal is down, so the cap (facing up, out of the
  // solid) has same_sense false.
  const text = bodiesToSTEP([cylinder('c', r, h)]),
    cap = text.split('\n').find((l) => l.includes("ADVANCED_FACE('c/face:+z'")),
    id = /,#(\d+),\.T\.\);$/.exec(cap)[1],
    plane = /^#\d+=(.*);$/.exec(text.split('\n').find((l) => l.startsWith(`#${id}=`)))[1],
    trimmed = (add) =>
      `RECTANGULAR_TRIMMED_SURFACE('',${add(plane)},${real(-r)},${real(r)},${real(-r)},${real(r)},.F.,.T.)`,
    { body } = imported(rewrite(text, `#${id}`, trimmed, false)),
    top = body.faces.find((f) => f.surface.kind === 'plane' && f.surface.frame.origin[2] > h / 2);
  assert.deepEqual(planeNormal(top), [0, 0, 1]);
  assert.deepEqual(checkBody(body), []);
  assert.ok(meshVolume(body) > 0);
  // The side as the offset by d of a cylinder of radius r + d trimmed with vsense false (its normal in): the offset
  // moves along the trimmed normal, in, to radius r. Before, it moved out, to r + 2 d.
  const side = text.split('\n').find((l) => l.includes('=CYLINDRICAL_SURFACE(')),
    wider = /^#\d+=(.*);$/.exec(side)[1].replace(/,([0-9.eE+-]+)\)$/, `,${real(r + d)})`),
    offset = (add) =>
      `OFFSET_SURFACE('',${add(`RECTANGULAR_TRIMMED_SURFACE('',${add(wider)},0.,${real(2 * Math.PI)},0.,${real(h)},.T.,.F.)`)},${real(d)},.F.)`,
    moved = imported(rewrite(text, 'CYLINDRICAL_SURFACE', offset, false)).body,
    tube = moved.faces.find((f) => f.surface.kind === 'cylinder');
  assert.ok(Math.abs(tube.surface.radius - r) < 1e-15, `radius ${tube.surface.radius}`);
  assert.equal(tube.sense, true);
  const volume = Math.PI * r * r * h;
  assert.ok(Math.abs(massProperties(moved).volume - volume) < 1e-12 * volume, `volume ${massProperties(moved).volume}`);
  assert.ok(meshVolume(moved) > 0);
});
