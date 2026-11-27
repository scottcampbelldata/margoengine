// The scene writers export the lines of @margoengine/lines and the clouds of @margoengine/points, read through
// engine.plugins by their public fields (exporters imports neither package). glTF writes each as a LINES or POINTS
// primitive (glTF 2.0 section 3.9.7 gives them no size), its width in primitive extras (lineWidth, pointSize and their
// units) and per-point multipliers as `_WIDTH`. No width extension is written: the Khronos validator warns
// (MULTIPLE_EXTENSIONS) on any extension beside KHR_materials_unlit, which these unlit lines and points need. USDZ writes world-unit widths as UsdGeom `widths`. A Margo loader reads every one of them back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, Geometry, PbrMaterial } from '@margoengine/core';
import { Lines, Line } from '@margoengine/lines';
import { Stroke } from '@margoengine/lines/stroke';
import { PointsPlugin, PointCloud } from '@margoengine/points';
import { LineBatches, LineBatch } from '@margoengine/lines/batch';
import { DebugLines } from '@margoengine/lines/debug';
import { Splats } from '@margoengine/splats';
import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import { GLTFAsset } from '@margoengine/gltf/asset';
import { parseOBJ, readZipDirectory, readZipEntry } from '@margoengine/loaders';
import { parseUSDZ } from '@margoengine/usdz';
import { curves } from '@margoengine/usdz/curves';
import { mockGPU, installWebGPU } from '../../../tests/support/gpu-recorder.js';
import { exportGLB, exportOBJ, exportSTL } from '../dist/index.js';
import { exportUSDZ } from '../dist/usdz.js';
import { readGLB, validate } from './helpers.js';

const srgb = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const near = (a, b, label) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 1e-6, `${label}[${i}]: ${v} vs ${b[i]}`));

/** A public Engine on the recording mock GPU with Lines and PointsPlugin, a box mesh, and the plugin items. */
async function scene() {
  const gpu = mockGPU(),
    { canvas, restore } = installWebGPU(gpu),
    engine = await Engine.create(canvas, { backend: 'webgpu' });
  restore();
  const lines = Lines.attach(engine),
    points = new PointsPlugin();
  engine.use(points);
  const geometry = new Geometry([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1], [0, 1, 2]),
    box = engine.createMesh().setGeometry(geometry).setMaterial(new PbrMaterial());
  box.name = 'Box';
  // Follows the box: written in the box's mesh after its triangle, at the box's transform.
  const attached = lines.add(
    new Line({ positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], mode: 'strip', width: 3, color: [1, 0, 0], mesh: box }),
  );
  // Follows nothing: a node of its own at its matrix, a closed loop of world-unit width with vertex colours.
  const loop = lines.add(
    new Line({
      positions: [0, 0, 0, 1, 0, 0, 1, 0, 1],
      mode: 'loop',
      width: 0.05,
      worldUnits: true,
      colors: [1, 1, 1, 1, 0, 1, 0, 0.5, 0, 0, 1, 1],
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1]),
    }),
  );
  // A stroke's per-point widths multiply its width.
  const stroke = lines.add(
    new Stroke({ positions: [0, 0, 0, 0, 1, 0, 0, 2, 0], widths: [1, 2, 0.5], width: 0.1, worldUnits: true }),
  );
  // sRGB bytes decoded to linear COLOR_0; the NaN point is drawn nowhere and written nowhere.
  const cloud = points.add(
    new PointCloud({
      name: 'Scan',
      positions: [0, 0, 0, 1, 0, 0, Number.NaN, 0, 0, 0, 0, 1],
      colors: new Uint8Array([255, 128, 0, 255, 0, 64, 255, 128, 10, 10, 10, 255, 255, 255, 255, 255]),
      colorComponents: 4,
      sizes: [1, 2, 1, 3],
      material: { size: 6, color: [0.5, 0.5, 0.5] },
    }),
  );
  return { engine, lines, points, box, attached, loop, stroke, cloud };
}

const primitivesOf = (json) => json.meshes.flatMap((mesh, m) => mesh.primitives.map((p) => ({ ...p, mesh: m })));

test('exportGLB writes plugin lines and clouds with their widths, colours and transforms, and gltf/pbr reads them back', async () => {
  const { engine } = await scene(),
    warnings = [],
    glb = exportGLB(engine, { onWarning: (w) => warnings.push(w) }),
    report = await validate(glb);
  assert.deepEqual(warnings, []);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.equal(report.warnings, 0, JSON.stringify(report.messages));
  const { json, bin } = readGLB(glb),
    asset = new GLTFAsset(json, [bin]),
    all = primitivesOf(json);
  // The box's mesh: its triangle, then the attached strip as a line list.
  const boxNode = json.nodes.find((n) => n.name === 'Box'),
    boxMesh = json.meshes[boxNode.mesh];
  assert.deepEqual(
    boxMesh.primitives.map((p) => p.mode),
    [4, 1],
  );
  const strip = boxMesh.primitives[1];
  assert.deepEqual(Array.from(asset.accessor(strip.indices)), [0, 1, 1, 2]);
  assert.deepEqual(strip.extras, { lineWidth: 3, lineWidthUnits: 'pixels' });
  const stripMaterial = json.materials[strip.material];
  assert.deepEqual(Object.keys(stripMaterial.extensions), ['KHR_materials_unlit'], 'lines draw unlit');
  assert.deepEqual(stripMaterial.pbrMetallicRoughness.baseColorFactor, [1, 0, 0, 1]);
  assert.equal(strip.attributes.NORMAL, undefined, 'a line without normals keeps none (glTF 2.0 section 3.9.7)');

  // The loop: its own node at its matrix, closed, world width (no pixel extension), colours kept, BLEND for alpha 0.5.
  const loop = all.find((p) => p.extras?.lineWidth === 0.05);
  assert.deepEqual(loop.extras, { lineWidth: 0.05, lineWidthUnits: 'world' });
  assert.deepEqual(Array.from(asset.accessor(loop.indices)), [0, 1, 1, 2, 2, 0]);
  const loopNode = json.nodes.find((n) => n.mesh === loop.mesh);
  assert.deepEqual(loopNode.translation, [0, 5, 0]);
  const loopMaterial = json.materials[loop.material];
  assert.equal(loopMaterial.alphaMode, 'BLEND');
  near(Array.from(asset.accessor(loop.attributes.COLOR_0)), [1, 1, 1, 1, 0, 1, 0, 0.5, 0, 0, 1, 1], 'loop colours');

  // The stroke: per-point multipliers as _WIDTH.
  const stroke = all.find((p) => p.extras?.lineWidth === 0.1);
  near(Array.from(asset.accessor(stroke.attributes._WIDTH)), [1, 2, 0.5], 'stroke widths');

  // The cloud: finite points only, linear colours, sizes as _WIDTH.
  const cloud = all.find((p) => p.mode === 0);
  assert.deepEqual(cloud.extras, { pointSize: 6, pointSizeUnits: 'pixels' });
  assert.deepEqual(Array.from(asset.accessor(cloud.indices)), [0, 1, 3]);
  near(Array.from(asset.accessor(cloud.attributes.COLOR_0)).slice(0, 4), [1, srgb(128 / 255), 0, 1], 'cloud colour');
  near(Array.from(asset.accessor(cloud.attributes._WIDTH)), [1, 2, 1, 3], 'cloud sizes');
  assert.equal(json.nodes.find((n) => n.mesh === cloud.mesh).name, 'Scan');

  // gltf/pbr reads the same lists back; the widths stay on the document it keeps.
  const back = await parseGLTFAsync(engine, glb);
  assert.deepEqual(back.pointsAndLines.map((p) => p.topology).sort(), [
    'line-list',
    'line-list',
    'line-list',
    'point-list',
  ]);
  const kept = back.asset.doc.meshes.flatMap((m) => m.primitives.map((p) => p.extras)).filter(Boolean);
  assert.deepEqual(
    kept.map((e) => e.lineWidth ?? e.pointSize).sort((a, b) => a - b),
    [0.05, 0.1, 3, 6],
  );
});

test('a hidden line or cloud, or one on a hidden mesh, is left out unless onlyVisible is false', async () => {
  const { engine, box, loop, cloud } = await scene(),
    count = (options) => primitivesOf(readGLB(exportGLB(engine, options)).json).filter((p) => p.mode !== 4).length;
  assert.equal(count(), 4);
  loop.visible = false;
  cloud.visible = false;
  assert.equal(count(), 2);
  assert.equal(count({ onlyVisible: false }), 4);
  box.visible = false;
  assert.equal(count(), 1, 'the attached strip goes with its hidden mesh');
});

test('a root export keeps only the lines that follow its subtree', async () => {
  const { engine, box } = await scene(),
    json = readGLB(exportGLB(engine, { root: box })).json;
  assert.deepEqual(
    primitivesOf(json).map((p) => p.mode),
    [4, 1],
  );
});

test('a sheared matrix places the line in world space under an identity node', async () => {
  const { engine, loop } = await scene();
  loop.matrix.set([1, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const { json, bin } = readGLB(exportGLB(engine)),
    asset = new GLTFAsset(json, [bin]),
    prim = primitivesOf(json).find((p) => p.extras?.lineWidth === 0.05),
    node = json.nodes.find((n) => n.mesh === prim.mesh);
  assert.equal(node.translation, undefined);
  assert.equal(node.matrix, undefined);
  // y' = x + y: (1, 0, 0) goes to (1, 1, 0) and (1, 0, 1) to (1, 1, 1).
  near(Array.from(asset.accessor(prim.attributes.POSITION)), [0, 0, 0, 1, 1, 0, 1, 1, 1], 'baked');
});

test('USDZ writes world-unit widths per vertex and @margoengine/usdz reads them back', async () => {
  const { engine } = await scene(),
    usdz = exportUSDZ(engine),
    entry = readZipDirectory(usdz).find((e) => e.name === 'scene.usda'),
    text = new TextDecoder().decode(await readZipEntry(usdz, entry));
  assert.match(text, /float\[\] widths = \[0\.05\] \(interpolation = "constant"\)/);
  assert.match(text, /float\[\] widths = \[0\.1, 0\.2, 0\.05\] \(interpolation = "vertex"\)/);
  // A pixel width has no USD form: the 0.01 default, times the cloud's per-point sizes.
  assert.match(text, /float\[\] widths = \[0\.01, 0\.02, 0\.03\] \(interpolation = "vertex"\)/);
  const asset = await parseUSDZ(usdz, { extensions: [curves()] }),
    gltf = new GLTFAsset(asset.document, asset.buffers),
    widths = asset.document.meshes
      .flatMap((m) => m.extras?.usdCurves ?? [])
      .map((part) => Array.from(gltf.accessor(part.widths)).map((v) => Math.round(v * 1e6) / 1e6));
  assert.deepEqual(
    widths.map((w) => w.join(' ')).sort(),
    // The reader gives every point its width, a constant one included.
    ['0.01 0.01 0.01', '0.01 0.02 0.03', '0.05 0.05 0.05 0.05', '0.1 0.2 0.05'].sort(),
  );
});

test('OBJ writes them as l and p elements; STL warns once for the mesh and once per free item', async () => {
  const { engine, loop, cloud, stroke } = await scene(),
    { obj } = exportOBJ(engine),
    back = await parseOBJ(obj);
  assert.match(obj, /^l /m);
  assert.match(obj, /^p /m);
  assert.ok(back);
  const warnings = [];
  exportSTL(engine, { onWarning: (w) => warnings.push(w) });
  assert.equal(warnings.length, 4);
  assert.equal(warnings[0].node?.name, 'Box');
  assert.deepEqual(
    warnings.slice(1).map((w) => [w.node, w.item]),
    [
      [null, loop],
      [null, stroke],
      [null, cloud],
    ],
  );
});

test('LineBatches batches are written as line lists with colours and widths; debug lines are not', async () => {
  const { engine, box } = await scene(),
    batches = LineBatches.attach(engine),
    debug = DebugLines.attach(engine);
  debug.drawLine([0, 0, 0], [9, 9, 9], { width: 7 });
  // Two separate segments, a colour per point at 8 bits sRGB, an alpha below 1, world widths and a matrix.
  const wire = batches.add(
    new LineBatch({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      colors: [1, 0, 0, 1, 1, 0, 0, 1, 0, 0.25, 0, 0.5, 0, 0, 1, 1],
      color: [1, 0.5, 1],
      opacity: 0.75,
      width: 0.02,
      worldUnits: true,
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 3, 1]),
    }),
  );
  // White points take no COLOR_0; attached to the box, the batch goes into its mesh.
  batches.add(new LineBatch({ positions: [0, 0, 1, 1, 0, 1], width: 5, mesh: box }));
  const warnings = [],
    glb = exportGLB(engine, { onWarning: (w) => warnings.push(w) }),
    report = await validate(glb);
  assert.deepEqual(warnings, []);
  assert.equal(report.errors, 0, JSON.stringify(report.messages));
  assert.equal(report.warnings, 0, JSON.stringify(report.messages));
  const { json, bin } = readGLB(glb),
    asset = new GLTFAsset(json, [bin]),
    all = primitivesOf(json);
  assert.ok(!all.some((p) => p.extras?.lineWidth === 7), 'a debug queue is no part of the scene');
  const attached = all.find((p) => p.extras?.lineWidth === 5);
  assert.equal(json.meshes[attached.mesh].primitives[0].mode, 4, 'after the box triangle');
  assert.equal(attached.attributes.COLOR_0, undefined);
  const part = all.find((p) => p.extras?.lineWidth === 0.02);
  assert.equal(part.mode, 1);
  assert.deepEqual(part.extras, { lineWidth: 0.02, lineWidthUnits: 'world' });
  assert.deepEqual(Array.from(asset.accessor(part.indices)), [0, 1, 2, 3]);
  assert.deepEqual(Array.from(asset.accessor(part.attributes.POSITION)), [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]);
  // The stored bytes are sRGB of the linear input; decoded they are within a byte step of it.
  const colors = Array.from(asset.accessor(part.attributes.COLOR_0)),
    want = [1, 0, 0, 1, 1, 0, 0, 1, 0, 0.25, 0, 0.5, 0, 0, 1, 1];
  colors.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.005, `colour ${i}: ${v} vs ${want[i]}`));
  assert.equal(colors[11], Math.fround(128 / 255));
  const material = json.materials[part.material];
  assert.equal(material.alphaMode, 'BLEND');
  assert.deepEqual(material.pbrMetallicRoughness.baseColorFactor, [1, 0.5, 1, 0.75]);
  assert.deepEqual(json.nodes.find((n) => n.mesh === part.mesh).translation, [0, 0, 3]);
  wire.visible = false;
  assert.ok(!primitivesOf(readGLB(exportGLB(engine)).json).some((p) => p.extras?.lineWidth === 0.02));
});

test('a splat cloud no scene writer holds is named in a warning, not dropped in silence', async () => {
  const { engine, box } = await scene(),
    splats = new Splats({
      positions: new Float32Array(3),
      covariances: new Float32Array([1, 0, 0, 1, 0, 1]),
      colors: new Float32Array([1, 1, 1, 1]),
    });
  engine.use(splats);
  for (const write of [exportGLB, exportOBJ, exportSTL, exportUSDZ]) {
    const warnings = [];
    await write(engine, { onWarning: (w) => warnings.push(w) });
    const left = warnings.filter((w) => w.item === splats);
    assert.equal(left.length, 1, write.name);
    assert.equal(left[0].code, 'unsupported');
    assert.equal(left[0].node, null);
    assert.match(left[0].message, /exportGaussianGLB/);
  }
  // A subtree export asks for that mesh alone.
  const warnings = [];
  exportGLB(engine, { root: box, onWarning: (w) => warnings.push(w) });
  assert.deepEqual(warnings, []);
});
