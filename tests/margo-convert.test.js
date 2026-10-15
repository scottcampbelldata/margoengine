// margo-convert (tools/margo-convert): converts the occt-import-js sample STEP / IGES / BREP files, validates every GLB
// with the Khronos glTF-Validator, loads it with gltf-pro and the light glTF loader, and compares triangles, bounds and
// part names with machinery's loadCAD of the same file (same OCCT build and default tessellation), run in Node through
// a stand-in Worker that executes the built CAD worker in-process. Skips when the OCCT Wasm cannot load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Geometry } from '@margoengine/core';
import { parseGLTFAsync } from '@margoengine/gltf-pro';
import { parseGLTF } from '@margoengine/gltf';
import { loadCAD } from '@margoengine/machinery/cad';
import { featureEdges } from '@margoengine/machinery/edges';
import { convert, formatOf, loadOCCT } from '../tools/margo-convert/convert.js';
import { headless, headlessModels } from './support/pbr-snapshot.js';

const root = resolve(import.meta.dirname, '..'),
  require = createRequire(join(root, 'package.json'));
const samples = join(root, 'node_modules/occt-import-js/test/testfiles');
const files = {
  as1: 'cax-if/as1-oc-214.stp',
  cubeStep: 'cube-10x10mm/Cube 10x10.stp',
  cubeIges: 'cube-10x10mm/Cube 10x10.igs',
  brep: 'cax-if-brep/as1_pe_203.brep',
};
const read = (name) => new Uint8Array(readFileSync(join(samples, files[name])));
const occt = await loadOCCT().then(
  () => null,
  (error) => `OCCT Wasm did not load: ${error.message}`,
);
const validator = existsSync(join(root, 'node_modules/gltf-validator')) ? require('gltf-validator') : null;
const skip = occt ? { skip: occt } : {};

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
  if (!validator) return null;
  const report = await validator.validateBytes(glb, { maxIssues: 0 });
  assert.equal(
    report.issues.numErrors,
    0,
    JSON.stringify(report.issues.messages.filter((m) => m.severity === 0).slice(0, 5)),
  );
  return report.issues;
}

/** Stand-in for a browser Worker: runs machinery's built cad-runtime.js in-process with a `self` shim and the Node OCCT. */
class InProcessWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  constructor(url) {
    this.code = readFileSync(fileURLToPath(url), 'utf8');
    this.href = url.href;
  }
  postMessage(data) {
    const self = {
      onmessage: null,
      location: { href: this.href },
      postMessage: (message) => queueMicrotask(() => this.onmessage?.({ data: message })),
    };
    self.importScripts = () => {
      self.occtimportjs = () => require('occt-import-js')({ print() {} });
    };
    new Function('self', this.code)(self);
    self.onmessage({ data });
  }
  terminate() {}
}

/** loadCAD in Node: triangles, world bounds and part names. */
async function viaLoadCAD(bytes, file) {
  const saved = globalThis.Worker;
  globalThis.Worker = InProcessWorker;
  try {
    const engine = await headless(),
      model = await loadCAD(engine, `https://cad.test/${file}`, { fetch: async () => new Response(bytes) });
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    let triangles = 0;
    for (const mesh of model.meshes) {
      const v = mesh.geometry.vertices;
      triangles += mesh.geometry.indices.length / 3;
      for (let i = 0; i < v.length; i += 6)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], v[i + a]);
          max[a] = Math.max(max[a], v[i + a]);
        }
    }
    return { triangles, bounds: [...min, ...max], names: model.meshes.map((mesh) => mesh.name).sort() };
  } finally {
    globalThis.Worker = saved;
  }
}

/** gltf-pro: triangles, world bounds and the names of the nodes that draw. */
async function viaGLTFPro(glb) {
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

for (const name of ['as1', 'cubeStep', 'cubeIges']) {
  test(`margo-convert ${files[name]}: valid GLB that matches loadCAD (triangles, bounds, part names)`, {
    ...skip,
    timeout: 60_000,
  }, async () => {
    const bytes = read(name),
      { glb, stats } = await convert(bytes, formatOf(files[name]));
    const issues = await validate(glb),
      pro = await viaGLTFPro(glb),
      cad = await viaLoadCAD(bytes, files[name].split('/').at(-1));
    assert.equal(stats.triangles, cad.triangles);
    assert.equal(pro.triangles, cad.triangles);
    assert.deepEqual(pro.names, cad.names);
    near(pro.bounds, cad.bounds, 'bounds');
    // The light loader (core meshes, so FeatureEdges, AssemblyBVH, sections and ExplodedView apply) reads it too.
    const light = parseGLTF(await headless(), glb);
    assert.equal(
      light.meshes.reduce((n, mesh) => n + mesh.geometry.indices.length / 3, 0),
      cad.triangles,
    );
    console.log(
      `${files[name]}: ${bytes.length} B -> ${glb.length} B, ${stats.parts} parts, ${stats.meshes} meshes, ${stats.triangles} triangles, validator ${issues ? `${issues.numErrors} errors / ${issues.numWarnings} warnings / ${issues.numInfos} infos` : 'not installed'}`,
    );
  });
}

test(
  'margo-convert shares one mesh between rigid copies (rotated and translated) and keeps names, colours and the tree',
  skip,
  async () => {
    const { glb, stats } = await convert(read('as1'), 'step'),
      { json } = readGLB(glb);
    // 18 parts: 6 nuts, 6 bolts, 2 l-brackets, rod and plate; nut, bolt, l-bracket, rod and plate are written once.
    assert.deepEqual([stats.parts, stats.meshes, stats.instanced], [18, 5, 13]);
    assert.equal(json.meshes.length, 5);
    assert.equal(json.nodes.filter((n) => n.mesh !== undefined).length, 18);
    assert.ok(
      json.nodes.some((n) => n.rotation),
      'the second l-bracket-assembly is a rotated copy',
    );
    const top = json.nodes[json.scenes[0].nodes[0]];
    assert.equal(top.name, 'as1');
    assert.deepEqual(
      top.children.map((i) => json.nodes[i].name),
      ['rod-assembly', 'l-bracket-assembly', 'plate', 'l-bracket-assembly'],
    );
    const nut = json.nodes.find((n) => n.name === 'nut');
    assert.deepEqual(
      json.materials[json.meshes[nut.mesh].primitives[0].material].pbrMetallicRoughness.baseColorFactor,
      [1, 0, 0, 1],
    );
    const flat = await convert(read('as1'), 'step', { instancing: false });
    assert.equal(readGLB(flat.glb).json.meshes.length, 18);
    near((await viaGLTFPro(flat.glb)).bounds, (await viaGLTFPro(glb)).bounds, 'instanced vs flat bounds');
    assert.ok(glb.length < flat.glb.length * 0.5, `instancing ${glb.length} vs ${flat.glb.length} bytes`);
  },
);

test('margo-convert --merge writes one world-space node per material', skip, async () => {
  const merged = await convert(read('as1'), 'step', { merge: true }),
    { json } = readGLB(merged.glb),
    pro = await viaGLTFPro(merged.glb);
  await validate(merged.glb);
  assert.equal(json.nodes.length, json.materials.length);
  assert.equal(pro.triangles, 5040);
  near(pro.bounds, (await viaGLTFPro((await convert(read('as1'), 'step')).glb)).bounds, 'merged bounds');
});

test("margo-convert --edges bakes FeatureEdges' edges into mesh extras", skip, async () => {
  const { glb, stats } = await convert(read('as1'), 'step', { edges: 30 }),
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
  assert.ok(segments > 0);
  await viaGLTFPro(glb);
  parseGLTF(await headless(), glb); // loaders ignore the extras
});

test('margo-convert tessellation options and BREP units', skip, async () => {
  const coarse = await convert(read('as1'), 'step', { linearDeflection: 0.5, angularDeflection: 60 }),
    fine = await convert(read('as1'), 'step', { linearDeflection: 0.01, angularDeflection: 5 });
  assert.ok(fine.stats.triangles > 2 * coarse.stats.triangles, `${fine.stats.triangles} vs ${coarse.stats.triangles}`);
  await validate(fine.glb);
  const mm = await viaGLTFPro((await convert(read('brep'), 'brep')).glb),
    inch = await viaGLTFPro((await convert(read('brep'), 'brep', { units: 'in' })).glb);
  near(
    inch.bounds,
    mm.bounds.map((v) => v * 25.4),
    'inch bounds',
    1e-4,
  );
  await validate((await convert(read('brep'), 'brep')).glb);
  await assert.rejects(convert(read('as1'), 'step', { linearDeflection: -1 }), /linearDeflection/);
  await assert.rejects(convert(new TextEncoder().encode('not a step file'), 'step'), /could not read/);
  assert.throws(() => formatOf('part.obj'), /Unsupported CAD file/);
});

test('margo-convert CLI writes the GLB, reports, and refuses bad arguments; the tool type-checks', {
  ...skip,
  timeout: 120_000,
}, (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'margo-convert-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const cli = join(root, 'tools/margo-convert/cli.js'),
    out = join(temp, 'cube.glb');
  const report = execFileSync(process.execPath, [cli, join(samples, files.cubeStep), out, '--edges'], {
    encoding: 'utf8',
  });
  assert.match(report, /1 parts, 1 meshes \(0 instanced\), 12 triangles, 12 edge segments/);
  assert.equal(readFileSync(out).readUInt32LE(0), 0x46546c67);
  const fails = (args) =>
    assert.throws(
      () => execFileSync(process.execPath, [cli, ...args], { stdio: 'pipe' }),
      (error) => /margo-convert: /.test(String(error.stderr)),
    );
  fails([]);
  fails([join(samples, files.cubeStep), out, '--units', 'yd']);
  fails([join(samples, files.cubeStep), out, '--linear-deflection', 'x']);
  fails(['part.obj']);
  execFileSync(
    process.execPath,
    [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tools/margo-convert')],
    { stdio: 'pipe' },
  );
});
