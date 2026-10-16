import { Engine, PbrMaterial, box } from '@margoengine/core';
import { engineRuntime, meshRuntime } from '@margoengine/core/extension';
import { parseGLTF } from '@margoengine/gltf';
import { exportGLB, exportGLTF, exportOBJ, exportPLY, exportSTL } from '@margoengine/exporters';

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Renders one frame and copies the canvas in the same task, before the swap chain texture expires. */
function snapshot(engine) {
  engine.render({ culling: false });
  const canvas = document.createElement('canvas');
  canvas.width = engine.canvas.width;
  canvas.height = engine.canvas.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(engine.canvas, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}
function difference(a, b) {
  let count = 0;
  for (let i = 0; i < a.length; i += 4)
    if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 12) count++;
  return count;
}
const covered = (pixels, background) => {
  let n = 0;
  for (let i = 0; i < pixels.length; i += 4)
    if (
      Math.abs(pixels[i] - background[0]) +
        Math.abs(pixels[i + 1] - background[1]) +
        Math.abs(pixels[i + 2] - background[2]) >
      12
    )
      n++;
  return n;
};

window.runExporterTests = async () => {
  const checks = [],
    report = { checks };
  const engine = await Engine.create(document.getElementById('view'), {
    camera: { position: [0, 2.5, 7], target: [0, 1, 0] },
  });
  const runtime = engineRuntime(engine),
    gpu = runtime.gpu,
    gpuErrors = [];
  report.backend = engine.backend;
  if (gpu) {
    gpu.addEventListener('uncapturederror', (event) => gpuErrors.push(event.error.message));
    gpu.pushErrorScope('validation');
  }

  // A small hierarchy: parented meshes, a transform-only node, shared geometry, two materials, a hidden mesh.
  const cube = box(1, 2, 1),
    red = new PbrMaterial({ color: '#e03030', roughness: 0.4 }),
    blue = new PbrMaterial({ color: '#3050e0', roughness: 0.8, metalness: 0.2, doubleSided: false });
  const base = engine
    .createMesh()
    .setGeometry(cube)
    .setMaterial(red)
    .setPosition([-2, 0, 0])
    .setRotation([0, 0.5, 0.2]);
  base.name = 'base';
  const arm = engine
    .createMesh(base)
    .setGeometry(cube)
    .setMaterial(blue)
    .setPosition([1.2, 1.5, 0])
    .setScale([0.6, 0.8, 0.6])
    .setRotation([0, 0, -0.6]);
  arm.name = 'arm';
  const pivot = engine.createMesh(arm).setPosition([0, 1.4, 0]).setRotation([0.4, 0, 0]);
  pivot.name = 'pivot';
  const hand = engine.createMesh(pivot).setGeometry(cube).setMaterial(red).setScale([1.5, 0.4, 1.5]);
  hand.name = 'hand';
  const other = engine
    .createMesh()
    .setGeometry(cube)
    .setMaterial(blue)
    .setPosition([2.5, 0.5, -1])
    .setScale([1, 1, -1.5]);
  other.name = 'other';
  const ghost = engine.createMesh(base).setGeometry(box()).setMaterial(blue).setPosition([0, -3, 0]);
  ghost.name = 'ghost';
  ghost.visible = false;
  const originals = [base, arm, hand, other];

  const before = snapshot(engine),
    background = Array.from(before.slice(0, 3));
  report.coveredPixels = covered(before, background);
  assert(report.coveredPixels > 500, `scene renders (${report.coveredPixels} covered pixels)`);
  checks.push(`Original hierarchy renders on ${engine.backend} (${report.coveredPixels} covered pixels)`);

  const glb = exportGLB(engine, { generator: 'Margo Engine exporters browser test' });
  const gltf = exportGLTF(engine);
  const flat = exportGLB(engine, { flatten: true });
  report.glb = Array.from(glb);
  report.gltf = gltf.text;
  report.flat = Array.from(flat);
  const wanted = originals.map((mesh) => ({
    name: mesh.name,
    matrix: Array.from(meshRuntime(mesh).matrix),
    vertices: Array.from(mesh.geometry.vertices),
    material: Array.from(mesh.material.data),
  }));

  // Hide the originals and re-import the GLB with @margoengine/gltf into the same engine.
  base.visible = false;
  other.visible = false;
  const model = parseGLTF(engine, glb);
  const after = snapshot(engine);
  report.pixelDifference = difference(before, after);
  assert(
    report.pixelDifference <= 8,
    `re-imported scene renders like the original (${report.pixelDifference} pixels differ)`,
  );
  model.root.visible = false;
  report.coveredWithBothHidden = covered(snapshot(engine), background);
  assert(report.coveredWithBothHidden === 0, 'originals and import hidden leaves an empty frame');
  model.root.visible = true;
  checks.push(
    `Re-imported GLB renders like the original (${report.pixelDifference} of ${after.length / 4} pixels differ)`,
  );

  assert(model.meshes.length === 4, `imported ${model.meshes.length} renderable meshes`);
  assert(!model.nodes.some((node) => node.name === 'ghost'), 'hidden mesh skipped');
  for (const want of wanted) {
    const node = model.nodes.find((n) => n.name === want.name),
      mesh = model.meshes.find((m) => engineRuntime(engine).store.parents[meshRuntime(m).id] === meshRuntime(node).id);
    const got = meshRuntime(mesh).matrix;
    for (let i = 0; i < 16; i++)
      assert(
        Math.abs(got[i] - want.matrix[i]) < 1e-5,
        `${want.name} world matrix [${i}] ${got[i]} vs ${want.matrix[i]}`,
      );
    assert(
      mesh.geometry.vertices.every((v, i) => v === want.vertices[i]),
      `${want.name} vertices`,
    );
    assert(
      mesh.material.data.every((v, i) => Math.abs(v - want.material[i]) < 1e-7),
      `${want.name} material`,
    );
  }
  const imported = new Set(model.meshes.map((m) => m.geometry));
  // The exporter writes one accessor set for the shared geometry; margoengine-gltf builds one Geometry per glTF mesh (one per material).
  assert(imported.size === 2, `expected 2 imported Geometry objects, got ${imported.size}`);
  checks.push('World matrices, vertex data and materials match after re-import');

  // The re-imported model exports to the same structure (names, meshes, materials).
  model.dispose();
  base.visible = true;
  other.visible = true;
  report.formats = {
    stlBytes: exportSTL(engine).length,
    stlAsciiLines: exportSTL(engine, { binary: false }).split('\n').length,
    objLines: exportOBJ(engine, { materials: true }).obj.split('\n').length,
    plyBytes: exportPLY(engine, { binary: true, colors: true }).length,
  };
  assert(report.formats.stlBytes === 84 + 48 * 50, 'STL size');
  checks.push('STL, OBJ and PLY export from a live engine');

  if (gpu) report.validationError = (await gpu.popErrorScope())?.message ?? null;
  report.gpuErrors = gpuErrors;
  assert(
    !report.validationError && !gpuErrors.length,
    `WebGPU validation errors: ${report.validationError} ${gpuErrors}`,
  );
  if (gpu) checks.push('Zero WebGPU validation errors');
  engine.dispose();
  return report;
};
