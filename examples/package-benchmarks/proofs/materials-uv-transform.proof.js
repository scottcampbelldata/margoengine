// Proof that texture transforms (materials `uvTransform`, gltf-pro's shared `textureTransform`) leave untransformed
// rendering unchanged: a 12-frame story of materials meshes (textured, untextured, normal-mapped, transparent, matcap)
// and a glTF with and without KHR_texture_transform makes byte-identical GPU calls, shaders and uniform writes with
// @margoengine/materials + @margoengine/gltf-pro built from `ref` and from the working tree.
// Run: node examples/package-benchmarks/proofs/materials-uv-transform.proof.js [ref]
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {isAbsolute, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'vite';
import {Engine, TransformStore} from '@margoengine/core/extension';
import {mockGPU, context} from './gpu-recorder.js';

const root = resolve(import.meta.dirname, '../../..'), slash = value => value.replaceAll('\\', '/'), ref = process.argv[2] ?? '1970fda';
const sources = ['materials/src', 'gltf-pro/src', 'shared'].map(name => slash(resolve(root, 'packages', name)) + '/');
const show = (from, file) => {try {return execFileSync('git', ['show', `${from}:${file.slice(slash(root).length + 1)}`], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']});} catch {return;}};
/** materials with gltf-pro (every entry) bundled in (core stays external), both read from `from` or the working tree. */
async function load(from) {
  const plugins = [{name: 'git-source', enforce: 'pre',
    resolveId(id, importer) {
      if (id.startsWith('@margoengine/gltf-pro')) return resolve(root, `packages/gltf-pro/src/${id.slice(22) || 'index'}.ts`);
      // A file renamed or deleted since `from` (shared/math.js, gltf-pro's instances.ts) resolves to its path in `from`.
      if (!from || !importer || !id.startsWith('.')) return null;
      const file = slash(resolve(importer.split('?')[0], '..', id)), ts = file.replace(/\.js$/, '.ts');
      if (sources.some(s => file.startsWith(s)) && !existsSync(file) && !existsSync(ts)) return show(from, ts) === undefined ? file : ts;
      return null;
    },
    load(id) {
      const file = slash(id.split('?')[0]); if (!from || !sources.some(s => file.startsWith(s))) return;
      return show(from, file);
    }}];
  const result = await build({root, configFile: false, publicDir: false, logLevel: 'silent', plugins,
    build: {write: false, minify: false, target: 'es2022', lib: {entry: resolve(root, 'packages/materials/src/index.ts'), formats: ['es']}, rollupOptions: {external: id => id.startsWith('@margoengine/core')}}});
  const chunks = result[0].output.filter(item => item.type === 'chunk'); assert.equal(chunks.length, 1);
  const directory = resolve(root, 'test-results/proofs-tmp'); await mkdir(directory, {recursive: true});
  const file = resolve(directory, `materials-uvt-${from ?? 'working'}-${process.pid}.mjs`); await writeFile(file, chunks[0].code + '\nexport {PBRModel as __PBRModel, GLTFAsset as __GLTFAsset};\n');
  return import(pathToFileURL(file).href);
}
const baseline = await load(ref), candidate = await load();

const box = (() => {const p = [], n = [], uv = [], idx = [];
  for (let f = 0; f < 6; f++) {const axis = f >> 1, sign = f & 1 ? -1 : 1, b = p.length / 3;
    for (let i = 0; i < 4; i++) {const v = [0, 0, 0], u = (i & 1) * 2 - 1, w = (i >> 1) * 2 - 1; v[axis] = sign * 0.5; v[(axis + 1) % 3] = u * 0.5; v[(axis + 2) % 3] = w * 0.5; p.push(...v); const nn = [0, 0, 0]; nn[axis] = sign; n.push(...nn); uv.push((u + 1) / 2, (w + 1) / 2);}
    idx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);}
  return {positions: p, normals: n, uvs: uv, indices: idx};})();
const pixels = (w, h, seed) => ({width: w, height: h, data: Uint8Array.from({length: w * h * 4}, (_, i) => (i * seed + 3) % 256)});
const glTF = () => {
  const P = new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), N = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), UV = new Float32Array([0, 0, 1, 0, 0.5, 1]), buffers = [P, N, UV];
  const accessors = [['VEC3', 3], ['VEC3', 3], ['VEC2', 3]].map(([type, count], i) => ({bufferView: i, componentType: 5126, count, type}));
  const transform = {extensions: {KHR_texture_transform: {offset: [0.25, 0.5], rotation: 0.3, scale: [2, 0.5]}}};
  return {buffers, doc: {asset: {version: '2.0'}, buffers: buffers.map(b => ({byteLength: b.byteLength})), bufferViews: buffers.map((b, i) => ({buffer: i, byteLength: b.byteLength})), accessors,
    textures: [{source: 0}, {source: 1}], images: [{}, {}], extensionsUsed: ['KHR_texture_transform'],
    materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}, normalTexture: {index: 1}}, {pbrMetallicRoughness: {baseColorTexture: {index: 0, ...transform}}, emissiveTexture: {index: 1}}],
    meshes: [{primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, material: 0}]}, {primitives: [{attributes: {POSITION: 0, NORMAL: 1, TEXCOORD_0: 2}, material: 1}]}],
    nodes: [{mesh: 0}, {mesh: 1, translation: [2, 0, 0]}]}};
};
async function story(api) {
  const gpu = mockGPU(), device = gpu.device, store = await TransformStore.create(64);
  device.createCommandEncoder = () => ({...gpu.encoder, finish: () => ({})}); device.lost = new Promise(() => {});
  const engine = new Engine({width: 128, height: 96, clientWidth: 128, clientHeight: 96}, store, {backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {}}, {position: [0, 0, 4], target: [0, 0, 0]}, null);
  engine.camera.update(128 / 96, true);
  const view = context(gpu, {samples: 4, format: 'bgra8unorm'});
  return gpu.record(() => {
    const map = new api.Texture(pixels(8, 4, 7), {wrapS: 'repeat', anisotropy: 4}), normal = new api.Texture(pixels(4, 4, 3)), matcap = new api.Texture(pixels(2, 2, 5));
    const materials = [new api.Material({map, roughness: 0.4}), new api.Material({color: '#3080ff'}), new api.Material({map, normalMap: normal, aoMap: normal, emissiveMap: map, metalness: 1}),
      new api.Material({map, transparent: true, opacity: 0.5}), new api.Material({shading: 'matcap', matcap, map})];
    const meshes = materials.map((m, i) => {const mesh = api.createMesh(engine, box, m); mesh.root.setPosition([i - 2, 0, 0]); return mesh;});
    const {doc, buffers} = glTF(), model = new api.__PBRModel(engine, new api.__GLTFAsset(doc, buffers), [{width: 8, height: 4, close() {}}, {width: 4, height: 4, close() {}}]);
    engine.use(model);
    for (let frame = 0; frame < 12; frame++) {
      if (frame === 3) materials[0].color[0] = 0.25; if (frame === 5) materials[2].roughness = 0.9; if (frame === 7) meshes[1].root.setPosition([0, 2, 0]);
      if (frame === 9) map.update();
      view.begin(frame); store.tick(false); engine.frameGraph.execute(view.c); view.end();
    }
    for (const mesh of meshes) mesh.destroy(); model.destroy();
  });
}
const expected = await story(baseline), actual = await story(candidate);
assert.ok(expected.filter(e => e[0] === 'pass.drawIndexed').length >= 12 * 7, 'every mesh drew every frame');
assert.ok(expected.some(e => e[0] === 'module' && e[2].code.includes('mat_baseMap')), 'patched materials shaders were compiled');
assert.deepEqual(actual, expected, 'GPU calls differ');
console.log(JSON.stringify({packages: ['materials', 'gltf-pro'], baseline: ref, identicalCalls: expected.length, draws: expected.filter(e => e[0] === 'pass.drawIndexed').length,
  shaderModules: expected.filter(e => e[0] === 'module').length, uniformWrites: expected.filter(e => e[0] === 'writeBuffer').length, result: 'byte-identical'}));
