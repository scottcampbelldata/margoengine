import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseSVG } from '../dist/svg.js';

// Reference results for parseSVG (69 documents), with the binding parts and tolerances of the loader-svg spec:
// paths, commands within 1e-6, styles, root size, shape bounds and areas, warning subjects, thrown codes, and
// strokes measured by their covered (union) area on a 400 x 400 sample grid.
const vectors = JSON.parse(readFileSync(new URL('./fixtures/svg-vectors.json', import.meta.url), 'utf8'));
const near = (actual, expected, tolerance = 1e-6) =>
  Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(expected));

/** Union area of the triangles: the fraction of 400 x 400 cell centres over their bounds that any triangle covers. */
function coveredArea(geometry) {
  const p = geometry.positions,
    triangles = [];
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]);
    x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]);
    y1 = Math.max(y1, p[i + 1]);
  }
  for (let i = 0; i < geometry.indices.length; i += 3)
    triangles.push([0, 1, 2].map((k) => [p[geometry.indices[i + k] * 3], p[geometry.indices[i + k] * 3 + 1]]));
  const n = 400,
    dx = (x1 - x0) / n,
    dy = (y1 - y0) / n;
  let hits = 0;
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const x = x0 + (i + 0.5) * dx,
        y = y0 + (j + 0.5) * dy;
      const edge = (u, v) => (v[0] - u[0]) * (y - u[1]) - (v[1] - u[1]) * (x - u[0]);
      if (triangles.some(([a, b, c]) => edge(a, b) >= -1e-12 && edge(b, c) >= -1e-12 && edge(c, a) >= -1e-12)) hits++;
    }
  return { area: (hits / (n * n)) * (x1 - x0) * (y1 - y0), bounds: [x0, y0, x1, y1] };
}

/** Bounds and shoelace area of a contour's getPoints(16). */
function contour(shape) {
  const points = shape.getPoints(16);
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i],
      [bx, by] = points[(i + 1) % points.length];
    area += ax * by - bx * ay;
  }
  const xs = points.map((q) => q[0]),
    ys = points.map((q) => q[1]);
  return { bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], area: Math.abs(area / 2) };
}

function checkContour(actual, expected, label) {
  const { bounds, area } = contour(actual);
  bounds.forEach((v, k) => assert.ok(near(v, expected.bounds[k]), `${label}: bounds ${bounds} vs ${expected.bounds}`));
  assert.ok(near(area, Math.abs(expected.signedArea16)), `${label}: area ${area} vs ${expected.signedArea16}`);
}

/** The subject a warning is about: the quoted text, the #id or the <element>, else the whole text. */
const subject = (warning) =>
  /"[^"]*"|#[\w-]+|<\w+>|@\w+/.exec(warning.replace(/^.*skipped: (SVG: )?/, ''))?.[0] ?? warning;

for (const vector of vectors.cases) {
  if (vector.svg === '(bytes)') continue;
  test(`SVG vectors: ${vector.name}`, () => {
    if (vector.throws) {
      assert.throws(
        () => parseSVG(vector.svg),
        (e) => e.name === vector.throws.name && e.code === vector.throws.code,
      );
      return;
    }
    const loaded = parseSVG(vector.svg);
    for (const key of ['viewBox', 'width', 'height'])
      if (vector[key] === undefined) assert.equal(loaded[key], undefined, key);
      else [vector[key]].flat().forEach((v, k) => assert.ok(near([loaded[key]].flat()[k], v, 1e-9), key));
    for (const warning of vector.warnings)
      assert.ok(
        loaded.warnings.some((w) => w.includes(subject(warning))),
        `warning about ${subject(warning)} in ${JSON.stringify(loaded.warnings)}`,
      );
    assert.equal(loaded.paths.length, vector.paths.length, 'paths');
    loaded.paths.forEach((path, i) => {
      const expected = vector.paths[i],
        label = `path ${i}`;
      assert.equal(path.element, expected.element);
      assert.equal(path.id, expected.id);
      assert.deepEqual(
        path.commands.map((c) => c[0]),
        expected.commands.map((c) => c[0]),
        `${label} command letters`,
      );
      path.commands.forEach((c, j) =>
        c.forEach((v, k) => k && assert.ok(near(v, expected.commands[j][k]), `${label} command ${j}: ${c}`)),
      );
      for (const key of ['fill', 'stroke'])
        if (expected[key] === null) assert.equal(path[key], null, key);
        else expected[key].forEach((v, k) => assert.ok(near(path[key][k], v), `${label} ${key}`));
      for (const key of ['fillOpacity', 'strokeOpacity', 'strokeWidth', 'strokeMiterLimit'])
        assert.ok(near(path[key], expected[key]), `${label} ${key} ${path[key]} vs ${expected[key]}`);
      for (const key of ['fillRule', 'strokeLineJoin', 'strokeLineCap']) assert.equal(path[key], expected[key], key);
      for (const [key, options] of [
        ['shapes', {}],
        ['shapesFlipY', { flipY: true }],
      ]) {
        const shapes = path.toShapes(options);
        assert.equal(shapes.length, expected[key].length, `${label} ${key}`);
        shapes.forEach((shape, s) => {
          checkContour(shape, expected[key][s], `${label} ${key} ${s}`);
          assert.equal(shape.holes.length, expected[key][s].holes.length, `${label} ${key} ${s} holes`);
          shape.holes.forEach((hole, h) => checkContour(hole, expected[key][s].holes[h], `${label} hole ${h}`));
        });
      }
      for (const stroke of expected.strokes) {
        const geometry = path.toStrokeGeometry(stroke.options),
          tag = `${label} stroke ${JSON.stringify(stroke.options)}`;
        if (stroke.triangles === 0) {
          for (const key of ['positions', 'normals', 'uvs', 'indices']) assert.equal(geometry[key].length, 0, tag);
          continue;
        }
        const p = geometry.positions;
        for (let t = 0; t < geometry.indices.length; t += 3) {
          const [a, b, c] = [0, 1, 2].map((k) => geometry.indices[t + k] * 3);
          assert.ok((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]) > 0, `${tag} ccw`);
        }
        for (let v = 0; v < p.length / 3; v++) {
          assert.equal(p[3 * v + 2], 0);
          assert.deepEqual([...geometry.normals.subarray(3 * v, 3 * v + 3)], [0, 0, 1]);
          assert.deepEqual([...geometry.uvs.subarray(2 * v, 2 * v + 2)], [p[3 * v], p[3 * v + 1]]);
        }
        const round =
          path.strokeLineJoin === 'round' ||
          path.strokeLineCap === 'round' ||
          path.commands.some((c) => c[0] === 'C' || c[0] === 'Q');
        const { area, bounds } = coveredArea(geometry);
        assert.ok(
          Math.abs(area - stroke.coveredAreaGrid400) <= (round ? 0.01 : 0.005) * stroke.coveredAreaGrid400,
          `${tag}: covered ${area} vs ${stroke.coveredAreaGrid400}`,
        );
        const half = (stroke.options.width ?? path.strokeWidth) / 2,
          divisions = stroke.options.divisions ?? 12;
        // Float32 positions: allow their rounding on top of the spec's bound.
        const tolerance = (round ? half * (1 - Math.cos(Math.PI / 4 / divisions)) : 0) + 1e-5;
        bounds.forEach((v, k) => assert.ok(Math.abs(v - stroke.bounds[k]) <= tolerance, `${tag}: bounds ${bounds}`));
      }
    });
  });
}

test('SVG vectors: stroke option errors', () => {
  const [path] = parseSVG(vectors.cases.find((c) => c.name === 'stroke-miter').svg).paths;
  for (const { options, throws } of vectors.strokeErrors) {
    const [key, value] = options.split(' ');
    assert.throws(
      () => path.toStrokeGeometry({ [key]: Number(value) }),
      (e) => e.name === throws,
      options,
    );
  }
});
