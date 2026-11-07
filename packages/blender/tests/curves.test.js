// Curves, points and volumes: a real Blender 5.2.3 export (tests/fixtures/curves.margo, made by
// tools/blender-addon/tests/blender_curves.py with curves=True) carries curves as splines, a point cloud as points and
// a volume as its OpenVDB grids, and the curves entry gives back what Blender itself evaluates
// (tests/fixtures/curves-truth.json: Convert to Mesh polylines, the cloud's points and openvdb's own voxel reads).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseVDB } from '@margoengine/loaders/vdb';
import { decodeMargo } from '../dist/index.js';
import { margoToGLTF } from '../dist/anim.js';
import { decodeMargoCurves, evaluateSpline } from '../dist/curves.js';

const bytes = await readFile(new URL('./fixtures/curves.margo', import.meta.url));
const truth = JSON.parse(await readFile(new URL('./fixtures/curves-truth.json', import.meta.url), 'utf8'));
const shapes = decodeMargoCurves(bytes);
const close = (actual, expected, tolerance, what) => {
  assert.equal(actual.length, expected.length, `${what}: ${actual.length} values against Blender's ${expected.length}`);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tolerance, `${what} [${i}]: ${v} against Blender's ${expected[i]}`));
};
const apply = (m, [x, y, z]) => [0, 1, 2].map((r) => m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r]);

test('the file holds the floor mesh and every curves object, point cloud and volume by name', () => {
  assert.deepEqual(shapes.curves.map((c) => c.name).sort(), ['Hair', 'Lines', 'Path']);
  assert.deepEqual(shapes.points.map((p) => p.name), ['Cloud']);
  assert.deepEqual(shapes.volumes.map((v) => [v.name, v.grids]), [['Smoke', ['density']]]);
  assert.equal(shapes.asset.document.meshes.length, 1);
  assert.equal(shapes.asset.document.nodes.find((n) => n.mesh !== undefined).name, 'Floor');
  const path = shapes.curves.find((c) => c.name === 'Path');
  assert.deepEqual(path.splines.map((s) => [s.type, s.cyclic, s.resolution, s.positions.length / 3]), [['bezier', false, 6, 4], ['bezier', true, 4, 4]]);
  const lines = shapes.curves.find((c) => c.name === 'Lines');
  assert.deepEqual(lines.splines.map((s) => [s.type, s.order, s.knots]), [['poly', 0, undefined], ['nurbs', 4, 'endpoint'], ['nurbs', 3, 'normal'], ['nurbs', 4, 'endpoint']]);
});

test('each curves object evaluates to the polyline Blender draws (Bezier, poly, NURBS and Catmull-Rom)', () => {
  for (const curves of shapes.curves) {
    // Lines' last spline is a cyclic NURBS with Endpoint knots, which evaluateSpline refuses (below): 34 points before it.
    const splines = curves.name === 'Lines' ? curves.splines.slice(0, -1) : curves.splines,
      expected = truth.polylines[curves.name].flat().slice(0, curves.name === 'Lines' ? 34 * 3 : undefined);
    close(splines.flatMap((spline) => [...evaluateSpline(spline)]), expected, 2e-5, `${curves.name} polyline`);
  }
});

test("a curve's node places its points where Blender's world matrix does", () => {
  const path = shapes.curves.find((c) => c.name === 'Path');
  close(apply(path.matrix, path.splines[0].positions.subarray(0, 3)), truth.worlds.Path, 1e-5, 'Path first point');
  const tips = shapes.curves.find((c) => c.name === 'Path').splines[0];
  close([...tips.radius], [1, 1.25, 1.5, 1.75], 1e-6, 'radius');
  close([...tips.tilt], [0, 0.1, 0.2, 0.3], 1e-6, 'tilt');
});

test('the point cloud keeps its positions, radii and colour', () => {
  const [cloud] = shapes.points;
  close([...cloud.positions], truth.points.Cloud.positions.flat(), 1e-6, 'positions');
  close([...cloud.radius], truth.points.Cloud.radius, 1e-7, 'radius');
  assert.equal(cloud.colors.length, 64 * 4);
  close([...cloud.colors.subarray(63 * 4, 64 * 4)], [1, 0.5, 0, 1], 1e-6, 'last colour');
});

test("the volume's OpenVDB file reads with @margoengine/loaders/vdb as openvdb reads it, and its node places it", async () => {
  const [volume] = shapes.volumes;
  const { grids, skipped } = await parseVDB(volume.vdb);
  assert.deepEqual(skipped, []);
  const density = grids.find((g) => g.name === 'density');
  const expected = truth.volumes.density;
  assert.equal(density.activeVoxels, expected.activeVoxels);
  for (const [[i, j, k], value] of expected.probes) assert.ok(Math.abs(density.at(i, j, k) - value) < 1e-6, `voxel ${i},${j},${k}`);
  expected.probes.forEach(([ijk], index) => {
    const world = apply(density.matrix, ijk);
    close(world, expected.world[index], 1e-5, 'index to object space');
    close(apply(volume.matrix, world), expected.scene[index], 1e-5, 'object space to scene');
  });
});

test('the static and animation readers refuse a shapes file by name', () => {
  assert.throws(() => decodeMargo(bytes), /curves, point clouds or volumes; load it with parseMargoCurves/);
  assert.throws(() => margoToGLTF(bytes), /curves, point clouds or volumes; load it with parseMargoCurves/);
});

test('a static file decodes with no shapes', async () => {
  const plain = decodeMargoCurves(await readFile(new URL('./fixtures/triangle.margo', import.meta.url)));
  assert.equal(plain.curves.length + plain.points.length + plain.volumes.length, 0);
  assert.ok(plain.asset.document.meshes.length);
});

/** The fixture with its manifest rewritten by `change` (same length, padded with spaces). */
function edited(change) {
  const copy = new Uint8Array(bytes),
    view = new DataView(copy.buffer),
    offset = view.getUint32(68, true),
    length = view.getUint32(72, true),
    doc = JSON.parse(new TextDecoder().decode(copy.subarray(offset, offset + length)));
  change(doc);
  const text = new TextEncoder().encode(JSON.stringify(doc));
  assert.ok(text.length <= length);
  copy.fill(0x20, offset, offset + length);
  copy.set(text, offset);
  return copy;
}

test('corrupt shape records fail by name', () => {
  assert.throws(() => decodeMargoCurves(edited((d) => { d.curves[0].splines[0].points += 1; })), /Invalid \.margo spline/);
  assert.throws(() => decodeMargoCurves(edited((d) => { d.curves[0].attributes.position.byteOffset = 1e9; })), /Invalid \.margo shape attribute position/);
  assert.throws(() => decodeMargoCurves(edited((d) => { d.pointClouds[0].attributes.position.components = 4; })), /Invalid \.margo shape attribute position/);
  assert.throws(() => decodeMargoCurves(edited((d) => { d.nodes.find((n) => n.volume !== undefined).volume = 7; })), /Invalid \.margo node volume reference/);
  assert.throws(() => decodeMargoCurves(edited((d) => { d.volumes[0].section = 1; })), /Invalid \.margo shape section reference/);
  assert.throws(() => decodeMargoCurves(edited((d) => { d.curves[0].splines[0].type = 'hermite'; })), /Invalid \.margo spline/);
});

test('NURBS with Bezier knots, cyclic Endpoint knots or too few points are refused by name', () => {
  const spline = { ...shapes.curves.find((c) => c.name === 'Lines').splines[1] };
  assert.throws(() => evaluateSpline({ ...spline, knots: 'bezier' }), /Bezier knots/);
  assert.throws(() => evaluateSpline({ ...spline, order: 6 }), /order 6 needs at least 6 points/);
  assert.throws(() => evaluateSpline(shapes.curves.find((c) => c.name === 'Lines').splines[3]), /cyclic NURBS with Endpoint knots/);
});
