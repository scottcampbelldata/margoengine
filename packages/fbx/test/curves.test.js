// NURBS curves from real files. 3ds Max wrote one curve twice, as a spline and turned into a line, so the second is
// a truth for the first that shares nothing with this reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { convertFBX } from '../dist/index.js';
import { fbxCurves, nurbsCurves, spline } from '../dist/curves.js';

const real = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/real', name));
const curves = async (name) => {
  const glb = await convertFBX(real(name), { extensions: [nurbsCurves] }),
    doc = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, new DataView(glb).getUint32(12, true))));
  return fbxCurves(doc.nodes.filter((n) => n.extras).map((n) => ({ name: n.name, extras: n.extras })));
};

test('a 3ds Max spline passes through every point of the line Max made from it', async () => {
  const list = await curves('max_nurbs_to_line_7500_binary.fbx'),
    line = list.find((c) => c.name === 'Line').record.polyline,
    nurbs = list.find((c) => c.name === 'Nurbs').curve,
    dense = nurbs.getPoints(4000);
  assert.equal(line.length, 31 * 3);
  // The two nodes have the same transform. 4,000 chords of a curve about 7 m long sit under 2 mm apart, and Max keeps
  // its points in Float32, so 2 mm of search grid is the bound.
  for (let i = 0; i < line.length; i += 3) {
    const near = Math.min(...dense.map((p) => Math.hypot(p[0] - line[i], p[1] - line[i + 1], p[2] - line[i + 2])));
    assert.ok(near < 0.002, `point ${i / 3} is ${near} m off the spline`);
  }
});

test('the three forms Maya writes close as they say, and stay on the circle Maya drew', async () => {
  const list = await curves('maya_nurbs_curve_form_7700_binary.fbx');
  assert.deepEqual(list.map((c) => c.record.form), ['Open', 'Closed', 'Periodic']);
  for (const { record } of list.slice(1)) {
    const p = record.polyline,
      n = p.length;
    assert.ok(Math.hypot(p[0] - p[n - 3], p[1] - p[n - 2], p[2] - p[n - 1]) < 1e-9, `${record.form} closes`);
  }
  // Maya's cubic circle: radius 1 cm in the file's units, and a cubic stays within 3 percent of a circle at this count.
  const periodic = list[2].record.polyline;
  for (let i = 0; i < periodic.length; i += 3) {
    const radius = Math.hypot(periodic[i], periodic[i + 1], periodic[i + 2]);
    assert.ok(radius > 0.0095 && radius < 0.0155, `radius ${radius}`);
  }
});

test('a rational curve keeps its weights: weight pulls it toward a control point', async () => {
  const [{ record, curve }] = await curves('max_nurbs_curve_rational_7500_binary.fbx');
  assert.deepEqual(record.weights.slice(0, 3), [1, 2, 2.5]);
  // De Boor on homogeneous points, by the book, written apart from the evaluator.
  const u = (curve.start + curve.end) / 2,
    { knots, degree: p, weights } = record,
    span = knots.findLastIndex((k) => k <= u),
    d = [];
  for (let j = 0; j <= p; j++) {
    const i = span - p + j,
      w = weights[i];
    d.push([record.points[i * 3] * w, record.points[i * 3 + 1] * w, record.points[i * 3 + 2] * w, w]);
  }
  for (let r = 1; r <= p; r++)
    for (let j = p; j >= r; j--) {
      const i = span - p + j,
        alpha = (u - knots[i]) / (knots[i + p - r + 1] - knots[i]);
      d[j] = d[j].map((v, k) => (1 - alpha) * d[j - 1][k] + alpha * v);
    }
  const expected = d[p].slice(0, 3).map((v) => v / d[p][3]),
    got = curve.evaluate(u),
    flat = spline({ ...record, weights: weights.map(() => 1) }).evaluate(u);
  expected.forEach((v, k) => assert.ok(Math.abs(got[k] - v) < 1e-9));
  assert.ok(Math.hypot(got[0] - flat[0], got[1] - flat[1], got[2] - flat[2]) > 0.01, 'the weights change the curve');
});

test('without the entry a curve is left out, and a file of only curves has nothing to show', async () => {
  await assert.rejects(convertFBX(real('maya_nurbs_curve_form_7700_binary.fbx')), /no mesh geometry/);
});
