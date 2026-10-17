// STEP stages 2 to 4: exact geometry and tessellation, on solids written here from their textbook definitions. Each mesh
// must be closed (every edge used once each way after joining equal positions), wound outward, as close to the true
// surface as the deflection asks, and enclose the solid's volume.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSTEP, tessellateSTEP } from '../dist/index.js';

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
    const shell = this.add(`CLOSED_SHELL('',(${faces.join(',')}))`),
      solid = this.add(`MANIFOLD_SOLID_BREP('solid',${shell})`),
      rep = this.add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${solid},#12),#10)`);
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
