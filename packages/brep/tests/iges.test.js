import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { igesToSTEP, isIGES, parseIGES, readIGES, tessellateSTEP } from '../dist/index.js';
import { cube, cylinder, model, plate, square114 } from './iges-models.js';
import { writeIGES } from './iges-writer.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/iges/${name}.igs`, import.meta.url), 'latin1');

/** Volume, area, open edges and box of a mesh (or of one face's run of it), vertices joined where positions are equal. */
function measure(m, first = 0, count = m.indices.length) {
  const p = m.positions,
    t = m.indices,
    ids = new Map(),
    weld = (i) => {
      const key = `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
      if (!ids.has(key)) ids.set(key, ids.size);
      return ids.get(key);
    },
    directed = new Map(),
    box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let volume = 0,
    area = 0;
  for (let k = first; k < first + count; k += 3) {
    const [a, b, c] = [t[k], t[k + 1], t[k + 2]].map((i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]);
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
      v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    for (const q of [a, b, c])
      for (let j = 0; j < 3; j++) {
        box[j] = Math.min(box[j], q[j]);
        box[j + 3] = Math.max(box[j + 3], q[j]);
      }
    const w = [t[k], t[k + 1], t[k + 2]].map(weld);
    for (const [x, y] of [
      [w[0], w[1]],
      [w[1], w[2]],
      [w[2], w[0]],
    ])
      directed.set(`${x},${y}`, (directed.get(`${x},${y}`) ?? 0) + 1);
  }
  let open = 0;
  for (const [key, n] of directed) {
    const [x, y] = key.split(',');
    if (n !== 1 || directed.get(`${y},${x}`) !== 1) open++;
  }
  return { volume, area, open, box };
}
const near = (actual, expected, relative, what) =>
  assert.ok(Math.abs(actual - expected) <= relative * Math.abs(expected), `${what}: ${actual}, expected ${expected}`);
const mesh = (text) => {
  const model = parseIGES(text),
    meshes = tessellateSTEP(model, { relativeDeflection: 0.0002 });
  for (const m of meshes) assert.deepEqual(m.failures, []);
  return { model, meshes };
};
const faceAreas = (m) => m.faces.map((f) => measure(m, f.first, f.count).area);

test('IGES: the fixed format, Global section and directory entries read as the specification lays them out', () => {
  const file = readIGES(fixture('cylinder'));
  assert.equal(file.start, 'Margo brep test file, written from the IGES 5.3 specification.');
  assert.equal(file.global.parameterDelimiter, ',');
  assert.equal(file.global.recordDelimiter, ';');
  assert.equal(file.global.sender, 'MARGO-TEST');
  assert.equal(file.global.fileName, 'test.igs');
  assert.equal(file.global.unitsFlag, 2);
  assert.equal(file.global.millimetres, 1);
  assert.equal(file.global.version, 11);
  const msbo = file.entities.get(1);
  assert.equal(msbo.type, 186);
  assert.deepEqual(msbo.params, [3, 1, 0]);
  const types = [...file.entities.values()].map((e) => e.type);
  assert.equal(types.filter((t) => t === 510).length, 3);
  const side = [...file.entities.values()].find((e) => e.type === 192);
  assert.equal(side.form, 1);
  assert.equal(side.subordinate, 1);
  assert.equal(side.use, 0);
});

test('IGES: other delimiters, strings holding delimiters and crossing lines, defaulted fields, D exponents', () => {
  const author = 'Strings may hold , ; | and / and run past column 72, so this one crosses at least one line boundary.';
  const text = writeIGES(cube(), { pd: '|', rd: '/', author });
  const file = readIGES(text);
  assert.equal(file.global.parameterDelimiter, '|');
  assert.equal(file.global.recordDelimiter, '/');
  assert.equal(file.global.author, author);
  assert.ok(text.split('\n').filter((l) => l[72] === 'G').length > 3);
  const [m] = mesh(text).meshes;
  near(measure(m).volume, 1000, 1e-9, 'volume');

  // Empty delimiter fields mean comma and semicolon; reals may use D exponents, signs and a bare decimal point.
  const entities = plate(),
    surface = entities[0];
  surface.params = surface.params.map((v, i) => (i >= 21 && i < 33 && v === 10 ? (i % 2 ? '1.0D1' : '+10.') : v));
  const defaulted = writeIGES(entities, { defaults: true });
  assert.match(defaulted, /^,,10HMARGO-TEST/m);
  assert.equal(readIGES(defaulted).global.parameterDelimiter, ',');
  const [p] = mesh(defaulted).meshes;
  near(measure(p).area, 100 - 4 * Math.PI, 0.005, 'plate area');
});

test('IGES: a manifold solid B-rep cube (186) meshes closed, with a reversed face use', () => {
  const conversion = igesToSTEP(fixture('cube'));
  assert.deepEqual(conversion.warnings, []);
  assert.deepEqual(conversion.counts, { solids: 1, shells: 0, faces: 6 });
  const { model, meshes } = mesh(fixture('cube'));
  assert.deepEqual(
    model.bodies.map((b) => [b.kind, b.faces.length, b.unit]),
    [['solid', 6, 0.001]],
  );
  const r = measure(meshes[0]);
  assert.equal(r.open, 0);
  near(r.volume, 1000, 1e-9, 'volume');
  near(r.area, 600, 1e-9, 'area');
});

test('IGES: a manifold solid cylinder on cylindrical and plane surfaces (192, 190) meshes closed', () => {
  const { model, meshes } = mesh(fixture('cylinder'));
  assert.deepEqual(model.census.surfaces, { CYLINDRICAL_SURFACE: 1, PLANE: 2 });
  const r = measure(meshes[0]);
  assert.equal(r.open, 0);
  near(r.volume, Math.PI * 25 * 8, 0.002, 'volume');
  near(r.area, Math.PI * 80 + Math.PI * 50, 0.002, 'area');
});

test('IGES: transformation matrices (124) chain, and a colour definition (314) colours the solid', () => {
  const rotate = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0],
    move = [1, 0, 0, 100, 0, 1, 0, 0, 0, 0, 1, 0];
  const { model, meshes } = mesh(writeIGES(cylinder({ transforms: [rotate, move], color: [100, 50, 0] })));
  const r = measure(meshes[0]);
  near(r.volume, Math.PI * 25 * 8, 0.002, 'volume');
  // Rotated a quarter turn about x (z becomes -y), then moved 100 along x.
  const box = r.box.map((v) => Math.round(v * 10) / 10);
  assert.deepEqual(box, [95, -8, -5, 105, 0, 5]);
  assert.deepEqual(new Set([...model.faceColors.values()].map((c) => c.join())), new Set(['1,0.5,0,1']));
});

test('IGES: the units flag and model space scale size the model in millimetres', () => {
  const inches = igesToSTEP(writeIGES(cube(), { units: 1 }));
  assert.equal(inches.unit, 25.4);
  const [a] = mesh(writeIGES(cube(), { units: 1 })).meshes;
  near(measure(a).volume, 1000 * 25.4 ** 3, 1e-9, 'inch volume');
  const [b] = mesh(writeIGES(cube(), { units: 3, unitsName: 'CM' })).meshes;
  near(measure(b).volume, 1000 * 1000, 1e-9, 'centimetre volume');
  // A model space scale of 0.5: one model unit is two real-world units.
  const [c] = mesh(writeIGES(cube(), { scale: 0.5 })).meshes;
  near(measure(c).volume, 8000, 1e-9, 'scaled volume');
});

test('IGES: a trimmed surface (144) with a parameter-space outer boundary and a model-space hole', () => {
  const { model, meshes } = mesh(fixture('plate'));
  assert.deepEqual(
    model.bodies.map((b) => b.kind),
    ['shell'],
  );
  near(measure(meshes[0]).area, 100 - 4 * Math.PI, 0.005, 'area');
  // Colour number 2 is red.
  assert.deepEqual([...model.faceColors.values()], [[1, 0, 0, 1]]);
});

test('IGES: a boundary built from every curve entity (100, 102, 104, 106, 110, 112, 124, 126) encloses its area', () => {
  const { meshes } = mesh(fixture('curves'));
  near(measure(meshes[0]).area, 100 + 9.5 * Math.PI + 20 / 3, 0.002, 'area');
});

test('IGES: parabolic and hyperbolic conic arcs (104 forms 3 and 2) become exact rational quadratics', () => {
  const { model, meshes } = mesh(fixture('conics'));
  near(measure(meshes[0]).area, 100 + 50 / 3 - (10 * Math.SQRT2 - 5 * (Math.SQRT2 + Math.asinh(1))), 0.002, 'area');
  // The parabola's middle weight is 1 (a polynomial spline); the hyperbola's is not.
  const curves = model.census.curves;
  assert.equal(curves.B_SPLINE_CURVE_WITH_KNOTS, 1);
  assert.equal(Object.entries(curves).filter(([k, n]) => /RATIONAL_B_SPLINE_CURVE/.test(k) && n === 1).length, 1);
});

test('IGES: untrimmed surfaces (118, 120, 122, 128, 140) mesh over their whole parameter rectangles', () => {
  const { meshes } = mesh(fixture('surfaces')),
    areas = faceAreas(meshes[0]);
  assert.equal(areas.length, 5);
  near(areas[0], 80 * Math.PI, 0.002, 'surface of revolution');
  near(areas[1], 24 * Math.PI, 0.005, 'tabulated cylinder');
  near(areas[2], 6 * Math.PI * Math.sqrt(13), 0.002, 'ruled surface');
  near(areas[3], 6, 1e-9, 'offset surface');
  near(areas[4], 4, 1e-9, 'B-spline surface');
  // The offset (140) lies 0.5 above its base square at z = 1, along the base's normal Su x Sv.
  const offset = meshes[0].faces[3],
    r = measure(meshes[0], offset.first, offset.count);
  assert.deepEqual(
    [r.box[2], r.box[5]].map((v) => Math.round(v * 1e6) / 1e6),
    [1.5, 1.5],
  );
  assert.deepEqual(
    [r.box[0], r.box[3]].map((v) => Math.round(v * 1e6) / 1e6),
    [70, 72],
  );
});

test('IGES: a parametric spline surface (114) is refused until its coefficient order is verified', () => {
  const m = model();
  square114(m, 0);
  assert.throws(() => igesToSTEP(writeIGES(m.list)), {
    name: 'MargoError',
    code: 'unsupported',
    message:
      'unsupported IGES entity 114 (parametric spline surface): coefficient order not yet verified against the IGES 5.3 spec; convert the surface to entity 128 in the sending CAD system',
  });
  // Beside other surfaces it is left out with the same message, and the rest converts.
  const n = model();
  square114(n, 0);
  n.list.push(
    ...plate().map((e) => ({
      ...e,
      params: e.params.map((v) => (v && typeof v === 'object' && 'ref' in v ? { ref: v.ref + 1 } : v)),
    })),
  );
  const conversion = igesToSTEP(writeIGES(n.list));
  assert.equal(conversion.counts.faces, 1);
  assert.match(conversion.warnings[0], /entity 114 .*convert the surface to entity 128/);
});

test('IGES: bounded surfaces (143, 141) with a hole and an offset curve (130), and a bounded plane (108)', () => {
  const { meshes } = mesh(fixture('bounded')),
    areas = faceAreas(meshes[0]);
  near(areas[0], 15, 1e-9, 'square with hole');
  near(areas[1], 8, 1e-6, 'rectangle with an offset side');
  near(areas[2], Math.PI, 0.01, 'bounded plane');
});

test('IGES: an entity that cannot be built is left out with a warning, not the whole file', () => {
  const entities = plate(),
    trimmed = entities.find((e) => e.type === 144);
  entities.push({ ...trimmed, params: [999, 0, 0, 0] });
  const conversion = igesToSTEP(writeIGES(entities));
  assert.equal(conversion.counts.faces, 1);
  assert.match(conversion.warnings.join('\n'), /surface 999 is missing/);
});

test('IGES: malformed input throws a TypeError that says what is wrong', () => {
  const good = fixture('cylinder'),
    lines = good.trimEnd().split('\n');
  assert.throws(() => readIGES('not an iges file'), { name: 'TypeError', message: /column 73/ });
  assert.throws(() => readIGES(lines.slice(0, -1).join('\n')), { name: 'TypeError', message: /Terminate/ });
  const firstD = lines.findIndex((l) => l[72] === 'D');
  assert.throws(() => readIGES([...lines.slice(0, firstD), ...lines.slice(firstD + 1)].join('\n')), {
    name: 'TypeError',
    message: /two/,
  });
  assert.throws(() => readIGES(`${' '.repeat(72)}C      1\n${good}`), { name: 'TypeError', message: /Compressed/ });
  assert.throws(() => readIGES(writeIGES(cylinder({ color: [1, 2, 3] })).replace('4HTEST', '9HTEST')), {
    name: 'TypeError',
    message: /character count|runs past|no record delimiter/,
  });
  assert.throws(() => readIGES(good.replace(/^186,/m, '187,')), { name: 'TypeError', message: /not its type 186/ });
  const swapped = [...lines];
  swapped[firstD] = `${swapped[firstD].slice(0, 72)}P${swapped[firstD].slice(73)}`;
  assert.throws(() => readIGES(swapped.join('\n')), { name: 'TypeError', message: /section/ });
  // Wireframe only: nothing to mesh.
  const wire = writeIGES([{ type: 110, params: [0, 0, 0, 1, 0, 0] }]);
  assert.throws(() => igesToSTEP(wire), { name: 'TypeError', message: /no surfaces or solids/ });
});

test('IGES: file detection', () => {
  assert.ok(isIGES(fixture('cube')));
  assert.ok(isIGES(new TextEncoder().encode(fixture('plate'))));
  assert.ok(!isIGES('ISO-10303-21;\nHEADER;\n'));
  assert.ok(!isIGES('solid cube\nfacet normal 0 0 1\n'));
});
