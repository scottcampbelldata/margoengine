// margo-convert-cad (tools/margo-convert-cad): converts STEP and IGES files through Margo's own B-rep kernel,
// validates every GLB with the Khronos glTF-Validator (a root dev dependency: npm ci), loads it with gltf/pbr and the
// light glTF loader, and checks triangles and part names against loadCAD of the same file (the same kernel and
// default tessellation, run in Node through a stand-in Worker that executes the built CAD worker in-process) and
// bounds against the shapes' closed forms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Geometry } from '@margoengine/core';
import { parseGLTFAsync } from '@margoengine/gltf/pbr';
import { parseGLTF } from '@margoengine/gltf';
import { loadCAD } from '@margoengine/cad';
import { model as brep } from '@margoengine/brep';
import { featureEdges } from '@margoengine/machinery/edges';
import { convert, formatOf } from '../tools/margo-convert-cad/convert.js';
import { headless, headlessModels } from './support/pbr-snapshot.js';

const root = resolve(import.meta.dirname, '..'),
  require = createRequire(join(root, 'package.json'));
const files = {
  assembly: 'packages/cad/test/fixtures/bracket-assembly.step',
  cubeIges: 'packages/brep/tests/fixtures/iges/cube.igs',
};
const read = (name) => new Uint8Array(readFileSync(join(root, files[name])));
const encode = (text) => new TextEncoder().encode(text);
/** A 10 x 20 x 30 mm box from the kernel's modeler, as STEP. */
const boxStep = () => encode(brep.bodiesToSTEP([brep.box('box', [0.01, 0.02, 0.03])]));
/** A cylinder of radius 5 mm and height 8 mm, as STEP. */
const cylinderStep = () => encode(brep.bodiesToSTEP([brep.cylinder('cyl', 0.005, 0.008)]));
const validator = require('gltf-validator');

function readGLB(glb) {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength),
    length = view.getUint32(12, true);
  return { json: JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + length))), bin: glb.subarray(28 + length) };
}
function accessor({ json, bin }, index) {
  const a = json.accessors[index],
    v = json.bufferViews[a.bufferView],
    at = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const size = { SCALAR: 1, VEC3: 3 }[a.type] * a.count;
  return a.componentType === 5126
    ? new Float32Array(bin.buffer.slice(at, at + size * 4))
    : a.componentType === 5123
      ? new Uint32Array(new Uint16Array(bin.buffer.slice(at, at + size * 2)))
      : new Uint32Array(bin.buffer.slice(at, at + size * 4));
}
async function validate(glb) {
  const report = await validator.validateBytes(glb, { maxIssues: 0 });
  assert.equal(
    report.issues.numErrors,
    0,
    JSON.stringify(report.issues.messages.filter((m) => m.severity === 0).slice(0, 5)),
  );
  return report.issues;
}

/** Stand-in for a browser Worker: runs the built cad-runtime.js in-process with a `self` shim. */
class InProcessWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  constructor(url) {
    this.code = readFileSync(fileURLToPath(url), 'utf8');
  }
  postMessage(data) {
    const self = {
      onmessage: null,
      postMessage: (message) => queueMicrotask(() => this.onmessage?.({ data: message })),
    };
    new Function('self', this.code)(self);
    self.onmessage({ data });
  }
  terminate() {}
}

/** loadCAD in Node: triangles and part names. */
async function viaLoadCAD(bytes, file) {
  const saved = globalThis.Worker;
  globalThis.Worker = InProcessWorker;
  try {
    const engine = await headless(),
      model = await loadCAD(engine, `https://cad.test/${file}`, { fetch: async () => new Response(bytes) });
    return {
      triangles: model.meshes.reduce((n, mesh) => n + mesh.geometry.indices.length / 3, 0),
      names: model.meshes.map((mesh) => mesh.name).sort(),
    };
  } finally {
    globalThis.Worker = saved;
  }
}

/** gltf/pbr: triangles, world bounds and the names of the nodes that draw. */
async function viaGLTFPbr(glb) {
  const model = await headlessModels(async () => parseGLTFAsync(await headless(), glb.slice()));
  return {
    triangles: model.primitives.reduce((n, p) => n + p.indices.length / 3, 0),
    bounds: [...model.bounds],
    names: model.primitives.map((p) => model.nodes[p.nodeIndex].name).sort(),
    primitives: model.primitives.length,
  };
}

const near = (a, b, label, epsilon = 1e-6) =>
  a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) <= epsilon, `${label}[${i}]: ${v} vs ${b[i]}`));

for (const [name, bytes, file, bounds] of [
  // The triangle (0, 0, 0), (10, 0, 0), (0, 10, 0) mm placed at x = 100 mm turned 90 degrees about z, and at y = 50 mm.
  ['assembly', () => read('assembly'), 'bracket-assembly.step', [0, 0, 0, 0.1, 0.06, 0]],
  ['box', boxStep, 'box.step', [0, 0, 0, 0.01, 0.02, 0.03]],
  ['cube IGES', () => read('cubeIges'), 'cube.igs', undefined],
])
  test(`margo-convert-cad ${name}: valid GLB that matches loadCAD (triangles, part names) and the exact bounds`, {
    timeout: 60_000,
  }, async () => {
    const data = bytes(),
      { glb, stats, warnings } = await convert(data, formatOf(file));
    assert.equal(stats.failedFaces, 0, warnings.join('; '));
    const issues = await validate(glb),
      pro = await viaGLTFPbr(glb),
      cad = await viaLoadCAD(data, file);
    assert.equal(stats.triangles, cad.triangles);
    assert.equal(pro.triangles, cad.triangles);
    assert.deepEqual(pro.names, cad.names);
    if (bounds) near(pro.bounds, bounds, 'bounds');
    // The light loader (core meshes, so FeatureEdges, AssemblyBVH, sections and ExplodedView apply) reads it too.
    const light = parseGLTF(await headless(), glb);
    assert.equal(
      light.meshes.reduce((n, mesh) => n + mesh.geometry.indices.length / 3, 0),
      cad.triangles,
    );
    console.log(
      `${file}: ${data.length} B -> ${glb.length} B, ${stats.parts} parts, ${stats.meshes} meshes, ${stats.triangles} triangles, validator ${issues.numErrors} errors / ${issues.numWarnings} warnings / ${issues.numInfos} infos`,
    );
  });

test('margo-convert-cad shares one mesh between the placements of a body and keeps names, colours and the tree', async () => {
  const { glb, stats } = await convert(read('assembly'), 'step'),
    { json } = readGLB(glb);
  assert.deepEqual([stats.parts, stats.meshes, stats.instanced], [2, 1, 1]);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.nodes.filter((n) => n.mesh !== undefined).length, 2);
  const top = json.nodes[json.scenes[0].nodes[0]];
  assert.equal(top.name, 'Assembly');
  assert.deepEqual(
    top.children.map((i) => json.nodes[i].name),
    ['Bracket', 'Bracket'],
  );
  const turned = top.children.map((i) => json.nodes[i]).find((n) => Math.abs((n.matrix?.[12] ?? 0) - 0.1) < 1e-12);
  assert.ok(turned, 'the part placed 100 mm along x');
  near(turned.matrix, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0.1, 0, 0, 1], 'turned 90 degrees about z', 1e-12);
  const [material] = json.materials;
  // sRGB 0.8, 0.2, 0.1 as a linear base colour.
  const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  near(material.pbrMetallicRoughness.baseColorFactor, [linear(0.8), linear(0.2), linear(0.1), 1], 'colour');
  const flat = await convert(read('assembly'), 'step', { instancing: false });
  assert.equal(readGLB(flat.glb).json.meshes.length, 2);
  near((await viaGLTFPbr(flat.glb)).bounds, (await viaGLTFPbr(glb)).bounds, 'instanced vs flat bounds');
});

test('margo-convert-cad --merge writes one world-space node per material', async () => {
  const merged = await convert(read('assembly'), 'step', { merge: true }),
    { json } = readGLB(merged.glb),
    pro = await viaGLTFPbr(merged.glb);
  await validate(merged.glb);
  assert.equal(json.nodes.length, json.materials.length);
  assert.equal(pro.triangles, 2);
  near(pro.bounds, [0, 0, 0, 0.1, 0.06, 0], 'merged bounds');
});

test("margo-convert-cad --edges bakes FeatureEdges' edges into mesh extras", async () => {
  const { glb, stats } = await convert(boxStep(), 'step', { edges: 30 }),
    gltf = readGLB(glb);
  await validate(glb);
  let segments = 0;
  for (const mesh of gltf.json.meshes) {
    const p = mesh.primitives[0],
      positions = accessor(gltf, p.attributes.POSITION),
      normals = accessor(gltf, p.attributes.NORMAL);
    // What FeatureEdges computes at load time from the same geometry.
    const expected = featureEdges(new Geometry(positions, normals, accessor(gltf, p.indices)), 30);
    assert.equal(mesh.extras.featureAngle, 30);
    assert.deepEqual(accessor(gltf, mesh.extras.featureEdges), expected);
    segments += expected.length / 2;
  }
  assert.equal(stats.edges, segments);
  assert.equal(segments, 12, 'a box has 12 edges');
  await viaGLTFPbr(glb);
  parseGLTF(await headless(), glb); // loaders ignore the extras
});

test('margo-convert-cad tessellation options; .brep files and the units option are refused', async () => {
  const coarse = await convert(cylinderStep(), 'step', { linearDeflection: 0.1, angularDeflection: 60 }),
    fine = await convert(cylinderStep(), 'step', { linearDeflection: 0.001, angularDeflection: 5 });
  assert.ok(fine.stats.triangles > 2 * coarse.stats.triangles, `${fine.stats.triangles} vs ${coarse.stats.triangles}`);
  await validate(fine.glb);
  // Radius 5 mm, height 8 mm, axis z from the origin: every rim sample lies on the circle, so no bound passes it.
  const bounds = (await viaGLTFPbr(fine.glb)).bounds;
  assert.ok(bounds.slice(0, 2).every((v) => v >= -0.005 - 1e-7) && bounds.slice(3, 5).every((v) => v <= 0.005 + 1e-7));
  near([bounds[2], bounds[5]], [0, 0.008], 'cylinder height', 1e-7);
  await assert.rejects(convert(boxStep(), 'step', { linearDeflection: -1 }), /linearDeflection/);
  await assert.rejects(convert(boxStep(), 'step', { units: 'in' }), /units option/);
  await assert.rejects(convert(encode('not a step file'), 'step'), TypeError);
  assert.throws(() => formatOf('part.obj'), /Unsupported CAD file/);
  assert.throws(() => formatOf('part.brep'), /Unsupported CAD file/);
  assert.equal(formatOf('part.x_t'), 'xt');
  assert.equal(formatOf('part.JT'), 'jt');
});

test('margo-convert-cad CLI writes the GLB, reports, and refuses bad arguments; the tool type-checks', {
  timeout: 120_000,
}, (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'margo-convert-cad-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cli = join(root, 'tools/margo-convert-cad/cad-cli.js'),
    input = join(temp, 'box.step'),
    out = join(temp, 'box.glb');
  writeFileSync(input, boxStep());
  const report = execFileSync(process.execPath, [cli, input, out, '--edges'], { encoding: 'utf8' });
  assert.match(report, /1 parts, 1 meshes \(0 instanced\), 12 triangles, 12 edge segments/);
  assert.equal(readFileSync(out).readUInt32LE(0), 0x46546c67);
  const fails = (args) =>
    assert.throws(
      () => execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' }),
      (error) => /margo-convert-cad: /.test(String(error.stderr)),
    );
  fails([]);
  fails([input, out, '--units', 'mm']);
  fails([input, out, '--linear-deflection', 'x']);
  fails(['part.obj']);
  fails([input, input]); // the output would overwrite the input
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tools/margo-convert-cad')],
    { stdio: 'pipe' },
  );
});
