// STEP stages 2 to 4: exact geometry and tessellation, on solids written here from their textbook definitions. Each mesh
// must be closed (every edge used once each way after joining equal positions), wound outward, as close to the true
// surface as the deflection asks, and enclose the solid's volume.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model, parseSTEP, tessellateSTEP, validateSTEP } from '../dist/index.js';

const real = (x) => {
  if (Math.abs(x) < 1e-13) return '0.';
  const s = String(x);
  if (s.includes('e')) {
    const [m, e] = s.split('e');
    return `${m.includes('.') ? m : `${m}.`}E${e}`;
  }
  return s.includes('.') ? s : `${s}.`;
};
const bool = (b) => (b ? '.T.' : '.F.');
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => a.map((c) => c / len(a));

/** A small STEP writer: entities from #100, one part in millimetres and radians. */
class Writer {
  lines = [];
  next = 100;
  add(text) {
    const id = `#${this.next++}`;
    this.lines.push(`${id}=${text};`);
    return id;
  }
  point(p) {
    return this.add(`CARTESIAN_POINT('',(${p.map(real).join(',')}))`);
  }
  direction(d) {
    return this.add(`DIRECTION('',(${d.map(real).join(',')}))`);
  }
  axis(origin, z = [0, 0, 1], x = [1, 0, 0]) {
    return this.add(`AXIS2_PLACEMENT_3D('',${this.point(origin)},${this.direction(z)},${this.direction(x)})`);
  }
  vertex(p) {
    return this.add(`VERTEX_POINT('',${this.point(p)})`);
  }
  line(p, d) {
    return this.add(`LINE('',${this.point(p)},${this.add(`VECTOR('',${this.direction(unit(d))},1.)`)})`);
  }
  circle(center, z, x, r) {
    return this.add(`CIRCLE('',${this.axis(center, z, x)},${real(r)})`);
  }
  edge(v1, v2, curve, sense = true) {
    return this.add(`EDGE_CURVE('',${v1},${v2},${curve},${bool(sense)})`);
  }
  /** An edge loop from [edge, sense] pairs. */
  loop(...oriented) {
    const refs = oriented.map(([e, s]) => this.add(`ORIENTED_EDGE('',*,*,${e},${bool(s)})`));
    return this.add(`EDGE_LOOP('',(${refs.join(',')}))`);
  }
  /** A face from loops (the first is the outer bound). */
  face(loops, surface, sense = true) {
    const bounds = loops.map((l, i) => this.add(`${i ? 'FACE_BOUND' : 'FACE_OUTER_BOUND'}('',${l},.T.)`));
    return this.add(`ADVANCED_FACE('',(${bounds.join(',')}),${surface},${bool(sense)})`);
  }
  /** The whole file: the faces as one closed-shell solid of a part. */
  file(faces) {
    const shell = this.add(`CLOSED_SHELL('',(${faces.join(',')}))`);
    return this.part(this.add(`MANIFOLD_SOLID_BREP('solid',${shell})`), 'ADVANCED_BREP_SHAPE_REPRESENTATION');
  }
  /** The whole file: one body item (a solid, or a tessellated solid) in a representation of the part. */
  part(body, representation) {
    const rep = this.add(`${representation}('',(${body},#12),#10)`);
    this.add(`SHAPE_REPRESENTATION_RELATIONSHIP('','',#13,${rep})`);
    return `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('test solid'),'2;1');
FILE_NAME('solid.stp','2026-10-17T12:00:00',('Margo'),('Margo'),'hand','margo tests','');
FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));
ENDSEC;
DATA;
#1=APPLICATION_CONTEXT('automotive design');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT('S-1','Solid','',(#2));
#4=PRODUCT_DEFINITION_FORMATION('','',#3);
#5=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#6=PRODUCT_DEFINITION('design','',#4,#5);
#7=PRODUCT_DEFINITION_SHAPE('','',#6);
#8=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#9=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));
#10=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#8,#9))REPRESENTATION_CONTEXT('',''));
#11=CARTESIAN_POINT('',(0.,0.,0.));
#12=AXIS2_PLACEMENT_3D('',#11,$,$);
#13=SHAPE_REPRESENTATION('',(#12),#10);
#14=SHAPE_DEFINITION_REPRESENTATION(#7,#13);
${this.lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;
  }
}

/** A polyhedron: vertices, and faces as vertex lists counter-clockwise seen from outside. `flip` faces are written
 * with the plane's normal inward and same_sense false. `surface` may replace a face's plane (for the failure test). */
function polyhedron(vertices, faces, { flip = [], surface = {} } = {}) {
  const w = new Writer(),
    v = vertices.map((p) => w.vertex(p)),
    edges = new Map();
  const shell = faces.map((f, k) => {
    const oriented = f.map((a, i) => {
      const b = f[(i + 1) % f.length],
        key = `${Math.min(a, b)},${Math.max(a, b)}`;
      if (!edges.has(key))
        edges.set(key, { from: a, id: w.edge(v[a], v[b], w.line(vertices[a], sub(vertices[b], vertices[a]))) });
      const e = edges.get(key);
      return [e.id, e.from === a];
    });
    const p0 = vertices[f[0]],
      normal = unit(cross(sub(vertices[f[1]], p0), sub(vertices[f[2]], p0))),
      x = unit(sub(vertices[f[1]], p0)),
      flipped = flip.includes(k),
      plane = surface[k]?.(w, p0) ?? w.add(`PLANE('',${w.axis(p0, flipped ? normal.map((c) => -c) : normal, x)})`);
    return w.face([w.loop(...oriented)], plane, !flipped);
  });
  return w.file(shell);
}

/** A box [0, a] x [0, b] x [0, c]. */
function box(a, b, c, options) {
  const vertices = Array.from({ length: 8 }, (_, i) => [i & 1 ? a : 0, i & 2 ? b : 0, i & 4 ? c : 0]);
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ];
  return polyhedron(vertices, faces, options);
}

const Z = [0, 0, 1],
  X = [1, 0, 0];

/** A cylinder of radius r and height h on z = 0, its side one face closed by a seam line (or two circles, no seam). */
function cylinder(r, h, { seam = true } = {}) {
  const w = new Writer(),
    v0 = w.vertex([r, 0, 0]),
    v1 = w.vertex([r, 0, h]),
    bottom = w.edge(v0, v0, w.circle([0, 0, 0], Z, X, r)),
    top = w.edge(v1, v1, w.circle([0, 0, h], Z, X, r)),
    side = w.add(`CYLINDRICAL_SURFACE('',${w.axis([0, 0, 0])},${real(r)})`);
  let lateral;
  if (seam) {
    const s = w.edge(v0, v1, w.line([r, 0, 0], Z));
    lateral = w.face([w.loop([bottom, true], [s, true], [top, false], [s, false])], side);
  } else lateral = w.face([w.loop([bottom, true]), w.loop([top, false])], side);
  return w.file([
    lateral,
    w.face([w.loop([bottom, false])], w.add(`PLANE('',${w.axis([0, 0, 0])})`), false),
    w.face([w.loop([top, true])], w.add(`PLANE('',${w.axis([0, 0, h])})`)),
  ]);
}

/** A sphere of radius R at the origin: one face bounded by a seam meridian walked both ways, or with no bounds. */
function sphere(R, { bounded = true } = {}) {
  const w = new Writer(),
    surface = w.add(`SPHERICAL_SURFACE('',${w.axis([0, 0, 0])},${real(R)})`);
  if (!bounded) return w.file([w.add(`ADVANCED_FACE('',(),${surface},.T.)`)]);
  const south = w.vertex([0, 0, -R]),
    north = w.vertex([0, 0, R]),
    // The meridian in the xz plane through +x: its frame's y axis is +z.
    seam = w.edge(south, north, w.circle([0, 0, 0], [0, -1, 0], X, R));
  return w.file([w.face([w.loop([seam, true], [seam, false])], surface)]);
}

/** A hemisphere (z >= 0) closed by a disk: the dome is one face bounded by the equator alone. */
function hemisphere(R) {
  const w = new Writer(),
    v = w.vertex([R, 0, 0]),
    equator = w.edge(v, v, w.circle([0, 0, 0], Z, X, R));
  return w.file([
    w.face([w.loop([equator, true])], w.add(`SPHERICAL_SURFACE('',${w.axis([0, 0, 0])},${real(R)})`)),
    w.face([w.loop([equator, false])], w.add(`PLANE('',${w.axis([0, 0, 0])})`), false),
  ]);
}

/** A cone pointing down: base circle of radius R on z = 0, apex at z = -R (half angle 45 degrees), a disk on top. */
function cone(R) {
  const w = new Writer(),
    v0 = w.vertex([R, 0, 0]),
    apex = w.vertex([0, 0, -R]),
    base = w.edge(v0, v0, w.circle([0, 0, 0], Z, X, R)),
    seam = w.edge(v0, apex, w.line([R, 0, 0], [-R, 0, -R])),
    surface = w.add(`CONICAL_SURFACE('',${w.axis([0, 0, 0])},${real(R)},${real(Math.PI / 4)})`);
  return w.file([
    w.face([w.loop([base, false], [seam, true], [seam, false])], surface),
    w.face([w.loop([base, true])], w.add(`PLANE('',${w.axis([0, 0, 0])})`)),
  ]);
}

/**
 * A sector of angle a of that cone (apex at z = -R): its cone face runs down one edge to the apex and up another, closed
 * by an arc of the base; a sector of the top disk and two triangles close it.
 */
function coneSector(R, a) {
  const w = new Writer(),
    O = [0, 0, 0],
    A = [R, 0, 0],
    B = [R * Math.cos(a), R * Math.sin(a), 0],
    P = [0, 0, -R],
    [o, va, vb, apex] = [O, A, B, P].map((q) => w.vertex(q)),
    line = (e0, e1, p0, p1) => w.edge(e0, e1, w.line(p0, sub(p1, p0))),
    arc = w.edge(va, vb, w.circle(O, Z, X, R)),
    oa = line(o, va, O, A),
    ob = line(o, vb, O, B),
    ap = line(va, apex, A, P),
    bp = line(vb, apex, B, P),
    op = line(o, apex, O, P),
    side = [-Math.sin(a), Math.cos(a), 0];
  return w.file([
    w.face([w.loop([oa, true], [arc, true], [ob, false])], w.add(`PLANE('',${w.axis(O)})`)),
    w.face(
      [w.loop([arc, false], [ap, true], [bp, false])],
      w.add(`CONICAL_SURFACE('',${w.axis(O)},${real(R)},${real(Math.PI / 4)})`),
    ),
    w.face([w.loop([op, true], [ap, false], [oa, false])], w.add(`PLANE('',${w.axis(O, [0, -1, 0], X)})`)),
    w.face([w.loop([ob, true], [bp, true], [op, false])], w.add(`PLANE('',${w.axis(O, side, [0, 0, 1])})`)),
  ]);
}

/** A torus (major radius R, minor r) as one face bounded by its two seam circles. */
function torus(R, r) {
  const w = new Writer(),
    v = w.vertex([R + r, 0, 0]),
    outer = w.edge(v, v, w.circle([0, 0, 0], Z, X, R + r)),
    tube = w.edge(v, v, w.circle([R, 0, 0], [0, -1, 0], X, r)),
    surface = w.add(`TOROIDAL_SURFACE('',${w.axis([0, 0, 0])},${real(R)},${real(r)})`);
  return w.file([w.face([w.loop([outer, true], [tube, true], [outer, false], [tube, false])], surface)]);
}

/** The cylinder again with its circles and side as rational B-splines (the standard 9-point circle), not marked closed. */
function nurbsCylinder(r, h) {
  const w = new Writer(),
    s = Math.SQRT1_2,
    ring = [
      [r, 0],
      [r, r],
      [0, r],
      [-r, r],
      [-r, 0],
      [-r, -r],
      [0, -r],
      [r, -r],
      [r, 0],
    ],
    weights = ring.map((_, i) => (i % 2 ? s : 1)),
    knots = '(3,2,2,2,3),(0.,1.,2.,3.,4.)';
  const circle = (z) =>
    w.add(
      `(BOUNDED_CURVE()B_SPLINE_CURVE(2,(${ring.map(([x, y]) => w.point([x, y, z])).join(',')}),.CIRCULAR_ARC.,.F.,.F.)` +
        `B_SPLINE_CURVE_WITH_KNOTS(${knots},.UNSPECIFIED.)CURVE()GEOMETRIC_REPRESENTATION_ITEM()` +
        `RATIONAL_B_SPLINE_CURVE((${weights.map(real).join(',')}))REPRESENTATION_ITEM(''))`,
    );
  const net = ring.map(([x, y]) => `(${w.point([x, y, 0])},${w.point([x, y, h])})`).join(','),
    side = w.add(
      `(BOUNDED_SURFACE()B_SPLINE_SURFACE(2,1,(${net}),.UNSPECIFIED.,.F.,.F.,.F.)` +
        `B_SPLINE_SURFACE_WITH_KNOTS((3,2,2,2,3),(2,2),(0.,1.,2.,3.,4.),(0.,1.),.UNSPECIFIED.)` +
        `GEOMETRIC_REPRESENTATION_ITEM()RATIONAL_B_SPLINE_SURFACE((${weights.map((k) => `(${real(k)},${real(k)})`).join(',')}))` +
        `REPRESENTATION_ITEM('')SURFACE())`,
    );
  const v0 = w.vertex([r, 0, 0]),
    v1 = w.vertex([r, 0, h]),
    bottom = w.edge(v0, v0, circle(0)),
    top = w.edge(v1, v1, circle(h)),
    seam = w.edge(v0, v1, w.line([r, 0, 0], Z));
  return w.file([
    w.face([w.loop([bottom, true], [seam, true], [top, false], [seam, false])], side),
    w.face([w.loop([bottom, false])], w.add(`PLANE('',${w.axis([0, 0, 0])})`), false),
    w.face([w.loop([top, true])], w.add(`PLANE('',${w.axis([0, 0, h])})`)),
  ]);
}

/** The single body's mesh of a one-solid file, tessellated to `deflection` millimetres. */
function mesh(text, deflection = 0.01) {
  const model = parseSTEP(text);
  assert.equal(model.bodies.length, 1);
  return tessellateSTEP(model, { deflection: deflection / 1000 })[0];
}

/** Volume, area, open edges and wrongly wound triangles of a mesh, its vertices joined where positions are equal. */
function measure(m) {
  const ids = new Map(),
    weld = [];
  for (let i = 0; i < m.positions.length / 3; i++) {
    const key = `${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`;
    if (!ids.has(key)) ids.set(key, ids.size);
    weld.push(ids.get(key));
  }
  const at = (i) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]],
    normal = (i) => [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]],
    directed = new Map();
  let volume = 0,
    area = 0,
    backwards = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]],
      pa = at(a),
      n = cross(sub(at(b), pa), sub(at(c), pa));
    volume += dot(pa, cross(at(b), at(c))) / 6;
    area += len(n) / 2;
    const smooth = [0, 1, 2].map((k) => normal(a)[k] + normal(b)[k] + normal(c)[k]);
    if (len(n) > 1e-9 && dot(n, smooth) <= 0) backwards++;
    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = `${weld[x]},${weld[y]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [key, count] of directed) {
    const [x, y] = key.split(',');
    if (count !== 1 || directed.get(`${y},${x}`) !== 1) open++;
  }
  return { volume, area, open, backwards, triangles: m.indices.length / 3 };
}

/** Asserts a closed, outward, failure-free mesh with the expected volume and area (within the deflection's reach). */
function solid(m, volume, area) {
  assert.deepEqual(m.failures, []);
  const r = measure(m);
  assert.equal(r.open, 0, 'every edge is shared by exactly two triangles, once each way');
  assert.equal(r.backwards, 0, 'triangles wind the same way their normals point');
  // An inscribed mesh loses at most about deflection x area of volume.
  assert.ok(
    Math.abs(r.volume - volume) <= m.deflection * area * 1.2 + 1e-6 * volume,
    `volume ${r.volume} vs ${volume}`,
  );
  assert.ok(Math.abs(r.area - area) <= area * 0.01, `area ${r.area} vs ${area}`);
  return r;
}

test('a box: six planes, two triangles each, closed and outward, also with a face written inside out', () => {
  for (const flip of [[], [3]]) {
    const m = mesh(box(10, 20, 30, { flip }));
    const r = solid(m, 6000, 2200);
    assert.equal(r.triangles, 12);
    assert.equal(m.faces.length, 6);
    assert.equal(m.unit, 0.001);
  }
});

test('a cylinder: its side closed by a seam line, or bounded by two circles with no seam', () => {
  for (const seam of [true, false]) {
    const m = mesh(cylinder(10, 20, { seam }));
    solid(m, Math.PI * 100 * 20, 2 * Math.PI * 100 + 2 * Math.PI * 10 * 20);
    // Every vertex lies on the cylinder or its end planes.
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      assert.ok(Math.abs(Math.hypot(x, y) - 10) < 1e-4 || Math.abs(z) < 1e-4 || Math.abs(z - 20) < 1e-4);
    }
  }
});

test('a sphere: one face round a seam meridian between two poles, or a face with no bounds at all', () => {
  for (const bounded of [true, false]) {
    const R = 10,
      m = mesh(sphere(R, { bounded })),
      r = solid(m, (4 / 3) * Math.PI * R ** 3, 4 * Math.PI * R * R);
    assert.ok(r.triangles > 100);
    for (let i = 0; i < m.positions.length; i += 3) {
      const p = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
      assert.ok(Math.abs(len(p) - R) < 1e-4, 'vertices on the sphere');
      const n = [m.normals[i], m.normals[i + 1], m.normals[i + 2]];
      assert.ok(dot(n, p) / R > 0.999, 'normals are the exact outward normal');
    }
    // Triangle centres stay within the deflection (plus a little: refinement tests centres and edge midpoints).
    for (let t = 0; t < m.indices.length; t += 3) {
      const c = [0, 1, 2].map((k) => [0, 1, 2].reduce((sum, j) => sum + m.positions[m.indices[t + j] * 3 + k], 0) / 3);
      assert.ok(R - len(c) <= m.deflection * 1.5 + 1e-4, `centre ${R - len(c)} from the sphere`);
    }
  }
});

test('a hemisphere: a dome bounded by the equator alone closes at its pole', () => {
  const R = 10;
  solid(mesh(hemisphere(R)), (2 / 3) * Math.PI * R ** 3, 3 * Math.PI * R * R);
});

test('a cone: its side walks round the apex between the two passes of its seam', () => {
  const R = 10;
  solid(mesh(cone(R)), (Math.PI * R * R * R) / 3, Math.PI * R * R + Math.PI * R * Math.hypot(R, R));
});

test("a cone's sector: its face runs through the apex, which its exact mass properties follow", () => {
  // At the apex u has no meaning: the face's loop runs along the apex's line from one edge's u to the other's (it
  // once threw "a loop through a pole or apex is not supported yet").
  const R = 10;
  for (const a of [Math.PI / 2, (3 * Math.PI) / 2]) {
    const text = coneSector(R, a),
      volume = (a * R ** 3) / 6,
      area = (a * R * R) / 2 + (a * R * R * Math.SQRT2) / 2 + R * R;
    solid(mesh(text), volume, area);
    const { bodies, problems } = model.bodiesFromSTEP(parseSTEP(text)),
      m = model.massProperties(bodies[0]);
    assert.deepEqual(problems, []);
    assert.ok(
      Math.abs(m.volume / 1e-9 - volume) <= 1e-9 * volume,
      `sector ${a}: volume ${m.volume / 1e-9} vs ${volume}`,
    );
    assert.ok(Math.abs(m.area / 1e-6 - area) <= 1e-9 * area, `sector ${a}: area ${m.area / 1e-6} vs ${area}`);
  }
  // The whole cone: its side runs up its seam to the apex and back down, so the apex's line spans a whole turn.
  const whole = model.massProperties(model.bodiesFromSTEP(parseSTEP(cone(R))).bodies[0]);
  assert.ok(Math.abs(whole.volume / 1e-9 - (Math.PI * R ** 3) / 3) <= (1e-9 * whole.volume) / 1e-9);
});

test('a hole drilled through imported cones: a face covering its apex, and one whose loop runs through it', () => {
  // The whole cone's face is its base circle alone, covering the apex: the Boolean's box round it once stopped at the
  // base, so the hole's curve on it was dropped and the result was not a solid. A sector's face runs through the apex:
  // the Boolean re-traces that loop along the apex's line. The hole (radius a, its axis at d from the cone's, inside
  // both) removes the integral of R - rho over its disk, rho the distance from the cone's axis.
  const R = 10,
    a = 1,
    d = 5,
    mm = 0.001,
    n = 200;
  let removed = 0;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < 2 * n; j++) {
      const r = ((i + 0.5) * a) / n,
        t = ((j + 0.5) * Math.PI) / n;
      removed += (R - Math.hypot(d + r * Math.cos(t), r * Math.sin(t))) * r * (a / n) * (Math.PI / n);
    }
  for (const [text, volume] of [
    [cone(R), (Math.PI * R ** 3) / 3],
    [coneSector(R, (3 * Math.PI) / 2), (Math.PI * R ** 3) / 4],
  ]) {
    const [body] = model.bodiesFromSTEP(parseSTEP(text)).bodies,
      hole = model.cylinder('h', a * mm, 20 * mm, model.frameOf([0, d * mm, -15 * mm], [0, 0, 1], [1, 0, 0])),
      drilled = model.boolean('d', 'subtract', body, hole),
      got = model.massProperties(drilled).volume / mm ** 3,
      want = volume - removed;
    assert.deepEqual(model.validateBody(drilled), []);
    assert.ok(Math.abs(got - want) <= 1e-6 * want, `volume ${got} vs ${want}`);
  }
});

test('a torus: one face bounded by both seam circles', () => {
  const R = 20,
    r = 5,
    m = mesh(torus(R, r));
  solid(m, 2 * Math.PI * Math.PI * R * r * r, 4 * Math.PI * Math.PI * R * r);
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    assert.ok(Math.abs(Math.hypot(Math.hypot(x, y) - R, z) - r) < 1e-4, 'vertices on the torus');
  }
});

test('rational B-splines: the 9-point circle and a cylinder side, closed though not marked closed', () => {
  const m = mesh(nurbsCylinder(10, 20));
  solid(m, Math.PI * 100 * 20, 2 * Math.PI * 100 + 2 * Math.PI * 10 * 20);
  for (let i = 0; i < m.positions.length; i += 3) {
    const [x, y, z] = [m.positions[i], m.positions[i + 1], m.positions[i + 2]];
    assert.ok(Math.abs(Math.hypot(x, y) - 10) < 1e-4 || Math.abs(z) < 1e-4 || Math.abs(z - 20) < 1e-4);
  }
});

test('a B-spline face collapsed to a point at one u end (v meaningless there) closes a tetrahedron', () => {
  // Faces counter-clockwise from outside; the slanted face ABC is S(u, v) = (1 - u) A + u ((1 - v) B + v C), whose
  // control row at u = 0 is A twice: at A, v has no meaning (NIST CTC02 has such patches).
  const O = [0, 0, 0],
    A = [10, 0, 0],
    B = [0, 10, 0],
    C = [0, 0, 10];
  const text = polyhedron(
    [O, A, B, C],
    [
      [0, 2, 1],
      [0, 1, 3],
      [0, 3, 2],
      [1, 2, 3],
    ],
    {
      surface: {
        3: (w) =>
          w.add(
            `B_SPLINE_SURFACE_WITH_KNOTS('',1,1,((${w.point(A)},${w.point(A)}),(${w.point(B)},${w.point(C)})),` +
              '.UNSPECIFIED.,.F.,.F.,.F.,(2,2),(2,2),(0.,1.),(0.,1.),.UNSPECIFIED.)',
          ),
      },
    },
  );
  const r = solid(mesh(text), 1000 / 6, 150 + (Math.sqrt(3) / 4) * 200);
  assert.ok(r.triangles >= 4);
});

/**
 * A thread's flank as a sheet: a ruled B-spline from an outer to an inner, raised helix-like quadratic spline, swept
 * `turns` turns, bounded by both splines and its two end rulings.
 */
function flank(turns, perTurn, outerRadius, innerRadius, pitch, lift) {
  const n = turns * perTurn + 2,
    helix = (radius, dz) =>
      Array.from({ length: n }, (_, i) => {
        const t = (2 * Math.PI * i) / perTurn;
        return [radius * Math.cos(t), radius * Math.sin(t), (pitch * t) / (2 * Math.PI) + dz];
      }),
    outer = helix(outerRadius, 0),
    inner = helix(innerRadius, lift),
    knots = `(${Array.from({ length: n - 1 }, (_, i) => real(i)).join(',')})`,
    mult = `(${Array.from({ length: n - 1 }, (_, i) => (i === 0 || i === n - 2 ? 3 : 1)).join(',')})`,
    w = new Writer(),
    row = (r) => `(${r.map((p) => w.point(p)).join(',')})`,
    curve = (r) =>
      w.add(`B_SPLINE_CURVE_WITH_KNOTS('',2,${row(r)},.UNSPECIFIED.,.F.,.F.,${mult},${knots},.UNSPECIFIED.)`),
    surface = w.add(
      `B_SPLINE_SURFACE_WITH_KNOTS('',1,2,(${row(outer)},${row(inner)}),.UNSPECIFIED.,.F.,.F.,.F.,(2,2),${mult},(0.,1.),${knots},.UNSPECIFIED.)`,
    ),
    [o0, o1, i0, i1] = [outer[0], outer[n - 1], inner[0], inner[n - 1]].map((p) => w.vertex(p)),
    ruling = (a, b) => w.line(a, sub(b, a)),
    along = w.edge(o0, o1, curve(outer)),
    back = w.edge(i0, i1, curve(inner)),
    end = w.edge(o1, i1, ruling(outer[n - 1], inner[n - 1])),
    start = w.edge(i0, o0, ruling(inner[0], outer[0])),
    // Counter-clockwise in (u, v) is (0, 0) (1, 0) (1, 1) (0, 1); this loop runs the other way, so the face is reversed.
    face = w.face([w.loop([along, true], [end, true], [back, false], [start, true])], surface, false);
  return w.part(
    w.add(`SHELL_BASED_SURFACE_MODEL('',(${w.add(`OPEN_SHELL('',(${face}))`)}))`),
    'MANIFOLD_SURFACE_SHAPE_REPRESENTATION',
  );
}

test('a line through a thread flank crosses it once a turn (every sheet, not only the nearest one)', () => {
  // Six turns of flank; a line parallel to the axis at radius 1.7 mm and angle 0.6 pi meets each turn once. Counting
  // by the distance to the nearest place followed along the line saw one sheet only, and in/out tests went wrong.
  const step = parseSTEP(flank(6, 8, 2, 1.4, 0.5, 0.15)),
    [sheet] = model.bodiesFromSTEP(step).bodies,
    a = 0.6 * Math.PI,
    mm = 0.001,
    line = { kind: 'line', origin: [1.7 * mm * Math.cos(a), 1.7 * mm * Math.sin(a), -1 * mm], direction: [0, 0, 1] };
  assert.equal(model.curveSurfaceCrossings(line, sheet.faces[0].surface, 0, 6 * mm).length, 6);
});

test('a thread flank (a ruled B-spline round many turns) meshes, and its exact area matches the mesh', () => {
  // A point's nearest place on such a surface, or on its edges, is easily on the next turn: that once cut the edges to
  // a part of a span, crossed the mesh's boundary and left the exact area at 1% to 50% of the true one.
  for (const args of [
    [6, 8, 2, 1.4, 0.5, 0.15],
    [10, 6, 2, 1.5, 0.4, 0.3],
    [30, 8, 2, 1.6, 0.5, 0.2],
  ]) {
    const step = parseSTEP(flank(...args)),
      m = tessellateSTEP(step, { relativeDeflection: 0.00005, angle: 0.05 })[0],
      { bodies, problems } = model.bodiesFromSTEP(step);
    assert.deepEqual(m.failures, []);
    assert.deepEqual(problems, []);
    const exact = model.massProperties(bodies[0]).area / m.unit ** 2,
      meshed = measure(m).area;
    assert.ok(Math.abs(meshed - exact) <= 5e-4 * exact, `flank ${args}: mesh ${meshed} vs exact ${exact} mm2`);
  }
});

/** Heights of the bicubic Bezier top of a 10 x 10 block (millimetres): control point (i, j) sits at x = 10 i / 3, y = 10 j / 3. */
const BUMP = [
  [5, 6, 6, 5],
  [6, 8, 7, 6],
  [6, 7, 8, 6],
  [5, 6, 6, 5],
];
const bernstein = (t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
/** The bump's height at (x, y) of the block's own square. */
const bumpHeight = (x, y) => {
  const bu = bernstein(x / 10),
    bv = bernstein(y / 10);
  let z = 0;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) z += bu[i] * bv[j] * BUMP[i][j];
  return z;
};

/**
 * A 10 x 10 block on z = 0 (moved by `at`) whose top is the bicubic Bezier BUMP, its four top edges the net's border
 * rows, four planar sides. `lift` raises the front top edge's curve (not the surface) by that much, as a writer's fit
 * leaves an edge a little off its face.
 */
function bumpBlock({ at = [0, 0, 0], lift = 0 } = {}) {
  const w = new Writer(),
    P = (i, j) => [(10 * i) / 3 + at[0], (10 * j) / 3 + at[1], BUMP[i][j] + at[2]],
    line = (a, b, pa, pb) => w.edge(a, b, w.line(pa, sub(pb, pa))),
    bezier = (pts) =>
      w.add(
        `B_SPLINE_CURVE_WITH_KNOTS('',3,(${pts.map((p) => w.point(p)).join(',')}),.UNSPECIFIED.,.F.,.F.,(4,4),(0.,1.),.UNSPECIFIED.)`,
      ),
    B = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ].map((q) => [q[0] + at[0], q[1] + at[1], q[2] + at[2]]),
    T = [P(0, 0), P(3, 0), P(3, 3), P(0, 3)],
    front = [0, 1, 2, 3].map((i) => P(i, 0)).map((p, i) => (i === 1 || i === 2 ? [p[0], p[1], p[2] + lift] : p)),
    [b0, b1, b2, b3] = B.map((p) => w.vertex(p)),
    [t0, t1, t2, t3] = T.map((p) => w.vertex(p)),
    e01 = w.edge(t0, t1, bezier(front)),
    e12 = w.edge(t1, t2, bezier([0, 1, 2, 3].map((j) => P(3, j)))),
    e32 = w.edge(t3, t2, bezier([0, 1, 2, 3].map((i) => P(i, 3)))),
    e03 = w.edge(t0, t3, bezier([0, 1, 2, 3].map((j) => P(0, j)))),
    [v0, v1, v2, v3] = [0, 1, 2, 3].map((k) => line([b0, b1, b2, b3][k], [t0, t1, t2, t3][k], B[k], T[k])),
    f01 = line(b0, b1, B[0], B[1]),
    f12 = line(b1, b2, B[1], B[2]),
    f32 = line(b3, b2, B[3], B[2]),
    f03 = line(b0, b3, B[0], B[3]),
    net = [0, 1, 2, 3].map((i) => `(${[0, 1, 2, 3].map((j) => w.point(P(i, j))).join(',')})`).join(','),
    top = w.add(
      `B_SPLINE_SURFACE_WITH_KNOTS('',3,3,(${net}),.UNSPECIFIED.,.F.,.F.,.F.,(4,4),(4,4),(0.,1.),(0.,1.),.UNSPECIFIED.)`,
    ),
    plane = (o, n, x) => w.add(`PLANE('',${w.axis(o, n, x)})`);
  return w.file([
    w.face([w.loop([e01, true], [e12, true], [e32, false], [e03, false])], top),
    w.face([w.loop([f03, true], [f32, true], [f12, false], [f01, false])], plane(B[0], [0, 0, -1], X)),
    w.face([w.loop([f01, true], [v1, true], [e01, false], [v0, false])], plane(B[0], [0, -1, 0], X)),
    w.face([w.loop([f12, true], [v2, true], [e12, false], [v1, false])], plane(B[1], X, [0, 1, 0])),
    w.face([w.loop([f32, false], [v3, true], [e32, true], [v2, false])], plane(B[3], [0, 1, 0], [-1, 0, 0])),
    w.face([w.loop([f03, false], [v0, true], [e03, true], [v3, false])], plane(B[0], [-1, 0, 0], [0, -1, 0])),
  ]);
}

/** Gauss-Legendre nodes and weights on [0, 1], 8 points (exact for the bump's polynomials). */
const GAUSS8 = (() => {
  const x = [0.1834346424956498, 0.525532409916329, 0.7966664774136267, 0.9602898564975363],
    w = [0.362683783378362, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];
  return [...x.map((v, i) => [(1 - v) / 2, w[i] / 2]), ...x.map((v, i) => [(1 + v) / 2, w[i] / 2])];
})();

test('spline Booleans: a hole, a corner box and another spline block cut a block with a bicubic top', () => {
  const mm = 0.001,
    [block] = model.bodiesFromSTEP(parseSTEP(bumpBlock())).bodies,
    full = (100 * BUMP.flat().reduce((a, b) => a + b)) / 16,
    volume = (b) => model.massProperties(b).volume / mm ** 3;
  assert.ok(Math.abs(volume(block) - full) <= 1e-9 * full);
  // The bump is a polynomial in x and y: over a disk it integrates exactly with 8 Gauss points in r and 16 in angle.
  const disk = (cx, cy, a) => {
    let sum = 0;
    for (const [r, wr] of GAUSS8)
      for (let k = 0; k < 16; k++) {
        const t = (2 * Math.PI * k) / 16;
        sum += bumpHeight(cx + a * r * Math.cos(t), cy + a * r * Math.sin(t)) * a * r * wr * a * ((2 * Math.PI) / 16);
      }
    return sum;
  };
  const rectangle = (x0, x1, y0, y1) => {
    let sum = 0;
    for (const [s, ws] of GAUSS8)
      for (const [t, wt] of GAUSS8) sum += bumpHeight(x0 + s * (x1 - x0), y0 + t * (y1 - y0)) * ws * wt;
    return sum * (x1 - x0) * (y1 - y0);
  };
  // Over the overlap [4, 10] x [3, 10], a copy moved by (4, 3, -1.5) removes up to the lower of the two tops.
  let lower = 0;
  const n = 400;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const x = 4 + ((i + 0.5) * 6) / n,
        y = 3 + ((j + 0.5) * 7) / n;
      lower += Math.min(bumpHeight(x, y), bumpHeight(x - 4, y - 3) - 1.5) * (6 / n) * (7 / n);
    }
  const frame = (x, y, z) => model.frameOf([x * mm, y * mm, z * mm], [0, 0, 1], [1, 0, 0]),
    [shifted] = model.bodiesFromSTEP(parseSTEP(bumpBlock({ at: [4, 3, -1.5] }))).bodies;
  for (const [tool, want, tolerance] of [
    [model.cylinder('h', 1 * mm, 30 * mm, frame(5, 5, -5)), full - disk(5, 5, 1), 1e-7],
    [model.cylinder('h', 1.5 * mm, 30 * mm, frame(3, 6, -5)), full - disk(3, 6, 1.5), 1e-7],
    [model.box('b', [6 * mm, 5 * mm, 30 * mm], frame(6, -1, -5)), full - rectangle(6, 10, 0, 4), 1e-7],
    [shifted, full - lower, 1e-6],
  ]) {
    const cut = model.boolean('c', 'subtract', block, tool);
    assert.deepEqual(model.validateBody(cut), []);
    assert.ok(Math.abs(volume(cut) - want) <= tolerance * want, `volume ${volume(cut)} vs ${want}`);
  }
});

test('an imported edge a micrometre off its face keeps that gap as its tolerance, and the part still cuts', () => {
  const mm = 0.001,
    { bodies, problems } = model.bodiesFromSTEP(parseSTEP(bumpBlock({ lift: 0.001 }))),
    [block] = bodies,
    edge = block.edges.find(
      (e) => e.curve.kind === 'spline' && Math.abs(e.start.point[1]) < 1e-9 && Math.abs(e.end.point[1]) < 1e-9,
    );
  // Lifting the middle control points by 1 micrometre lifts the curve's middle by 3/4 of that.
  assert.deepEqual(problems, []);
  assert.ok(edge.tolerance >= 0.75e-6 && edge.tolerance <= 1.5 * 0.75e-6 * 1.01, `tolerance ${edge.tolerance}`);
  const cut = model.boolean(
    'c',
    'subtract',
    block,
    model.box('b', [6 * mm, 5 * mm, 30 * mm], model.frameOf([6 * mm, -1 * mm, -5 * mm], [0, 0, 1], [1, 0, 0])),
  );
  assert.deepEqual(model.validateBody(cut), []);
});

test('a tessellated solid (AP242): triangles, strips and fans through pnindex, read as written', () => {
  // A unit tetrahedron (millimetres): two TRIANGULATED_FACEs and one COMPLEX_TRIANGULATED_FACE share one point list.
  for (const [strips, fans] of [
    ['((1,2,3,4))', '()'],
    ['((1,2,3))', '((4,3,2))'],
  ]) {
    const w = new Writer(),
      points = w.add("COORDINATES_LIST('',4,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)))"),
      faces = [
        w.add(`TRIANGULATED_FACE('',${points},4,((0.,0.,-1.)),$,(),((1,3,2)))`),
        w.add(`TRIANGULATED_FACE('',${points},3,(),$,(1,2,4),((1,2,3)))`),
        w.add(`COMPLEX_TRIANGULATED_FACE('',${points},4,(),$,(1,4,3,2),${strips},${fans})`),
      ],
      m = mesh(
        w.part(w.add(`TESSELLATED_SOLID('tetrahedron',(${faces.join(',')}),$)`), 'TESSELLATED_SHAPE_REPRESENTATION'),
      );
    const r = solid(m, 1 / 6, 1.5 + Math.sqrt(3) / 2);
    assert.equal(r.triangles, 4);
    assert.deepEqual(
      m.faces.map((f) => f.count / 3),
      [1, 1, 2],
    );
    assert.deepEqual([...m.normals.slice(0, 3)], [0, 0, -1], "the file's one normal for a face is every point's");
  }
});

test('a tessellated face indexing past its points is a failure that names the face', () => {
  const w = new Writer(),
    points = w.add("COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)))"),
    face = w.add(`TRIANGULATED_FACE('',${points},3,(),$,(),((1,2,7)))`),
    m = mesh(w.part(w.add(`TESSELLATED_SOLID('',(${face}),$)`), 'TESSELLATED_SHAPE_REPRESENTATION'));
  assert.equal(m.failures.length, 1);
  assert.match(m.failures[0].reason, /outside its points/);
  assert.equal(m.indices.length, 0);
});

test("validation properties: the file's own volume, area, centre and box, checked against the mesh", () => {
  // A 10 x 20 x 30 mm box. The part states its volume, area, centre and box (and the centre of loose points, which is
  // not the solid's); a shape aspect naming the solid states a wrong area in a complex measure item.
  let text = box(10, 20, 30);
  const solid = text.match(/#(\d+)=MANIFOLD_SOLID_BREP/)[1],
    rep = text.match(/#(\d+)=ADVANCED_BREP_SHAPE_REPRESENTATION/)[1];
  text = text.replace(
    'ENDSEC;\nEND-ISO',
    `#9001=DERIVED_UNIT_ELEMENT(#8,3.);
#9002=DERIVED_UNIT((#9001));
#9003=DERIVED_UNIT_ELEMENT(#8,2.);
#9004=DERIVED_UNIT((#9003));
#9005=MEASURE_REPRESENTATION_ITEM('volume measure',VOLUME_MEASURE(6000.),#9002);
#9006=MEASURE_REPRESENTATION_ITEM('surface area measure',AREA_MEASURE(2200.),#9004);
#9007=CARTESIAN_POINT('centre point',(5.,10.,15.));
#9008=CARTESIAN_POINT('bounding box corner point',(0.,0.,0.));
#9009=CARTESIAN_POINT('bounding box corner point',(10.,20.,30.));
#9010=CARTESIAN_POINT('independent points centre point',(99.,99.,99.));
#9011=REPRESENTATION('',(#9005,#9006,#9007,#9008,#9009,#9010),#10);
#9012=PROPERTY_DEFINITION('geometric validation property','of the part',#7);
#9013=PROPERTY_DEFINITION_REPRESENTATION(#9012,#9011);
#9020=SHAPE_ASPECT('','the solid',#7,.F.);
#9021=GEOMETRIC_ITEM_SPECIFIC_USAGE('','',#9020,#${rep},#${solid});
#9022=(AREA_MEASURE_WITH_UNIT()MEASURE_REPRESENTATION_ITEM()MEASURE_WITH_UNIT(AREA_MEASURE(2300.),#9004)REPRESENTATION_ITEM('surface area measure'));
#9023=REPRESENTATION('surface area',(#9022),#10);
#9024=PROPERTY_DEFINITION('area of the solid','geometric validation property',#9020);
#9025=PROPERTY_DEFINITION_REPRESENTATION(#9024,#9023);
ENDSEC;
END-ISO`,
  );
  const model = parseSTEP(text),
    [part, aspect] = model.validation;
  assert.equal(model.validation.length, 2);
  assert.deepEqual([part.label, part.product, part.bodies, part.tessellated], ['Solid', 0, undefined, false]);
  assert.ok(Math.abs(part.volume - 6e-6) < 1e-15 && Math.abs(part.area - 2.2e-3) < 1e-12);
  assert.deepEqual(
    part.centroid.map((c) => +c.toFixed(9)),
    [0.005, 0.01, 0.015],
  );
  assert.deepEqual(
    part.box[1].map((c) => +c.toFixed(9)),
    [0.01, 0.02, 0.03],
  );
  assert.deepEqual([aspect.label, aspect.bodies, +aspect.area.toFixed(9)], ['the solid', [0], 0.0023]);
  const [good, bad] = validateSTEP(model, tessellateSTEP(model));
  assert.equal(good.ok, true);
  for (const d of Object.values(good.differences)) assert.ok(d < 1e-6, `difference ${d}`);
  assert.equal(bad.ok, false);
  assert.ok(Math.abs(bad.differences.area - (1 - 2200 / 2300)) < 1e-6);
  assert.throws(() => validateSTEP(model, []), { name: 'RangeError', message: /one mesh per body/ });
});

test('a finer deflection gives more triangles and a closer volume', () => {
  const R = 10,
    exact = (4 / 3) * Math.PI * R ** 3,
    coarse = measure(mesh(sphere(R), 0.1)),
    fine = measure(mesh(sphere(R), 0.01));
  assert.ok(fine.triangles > coarse.triangles * 4);
  assert.ok(Math.abs(fine.volume - exact) < Math.abs(coarse.volume - exact) / 4);
});

test('a face on a surface the kernel lacks is listed as a failure; the rest of the body still meshes', () => {
  const m = mesh(box(10, 10, 10, { surface: { 2: (w, p0) => w.add(`FANCY_SURFACE('',${w.axis(p0)})`) } }));
  assert.equal(m.failures.length, 1);
  assert.match(m.failures[0].reason, /FANCY_SURFACE/);
  assert.equal(m.faces.length, 5);
  assert.equal(m.indices.length, 5 * 2 * 3);
});

test('options out of range throw a RangeError that names the fix', () => {
  const model = parseSTEP(box(1, 1, 1));
  assert.throws(() => tessellateSTEP(model, { angle: 4 }), {
    name: 'RangeError',
    message: /angle must be between 0 and pi/,
  });
  assert.throws(() => tessellateSTEP(model, { relativeDeflection: 0 }), {
    name: 'RangeError',
    message: /relativeDeflection/,
  });
  assert.throws(() => tessellateSTEP(model, { deflection: -1 }), { name: 'RangeError', message: /deflection must be/ });
  assert.throws(() => tessellateSTEP(model, { maxFaceVertices: 3 }), {
    name: 'RangeError',
    message: /maxFaceVertices/,
  });
});
