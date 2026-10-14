// Real-GPU pixel proof for gltf-pro's discard constants: the same scene drawn by gltf-pro at 15c87f1 and by the working tree.
import {Engine} from '/packages/core/dist/extension.js';
import {SSAO} from '/packages/post/dist/index.js';
const which = new URLSearchParams(location.search).get('which');
const gltf = await import(which === 'before' ? '/test-results/gltf-before/margoengine.js' : '/packages/gltf-pro/dist/index.js');
const quad = () => {
  const positions = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const colors = new Float32Array([1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0]), indices = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const buffers = [positions, normals, colors, indices];
  const doc = {asset: {version: '2.0'}, extensionsUsed: ['KHR_materials_unlit', 'KHR_materials_clearcoat'], buffers: buffers.map(b => ({byteLength: b.byteLength})), bufferViews: buffers.map((b, i) => ({buffer: i, byteLength: b.byteLength})),
    accessors: [{bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0]}, {bufferView: 1, componentType: 5126, count: 4, type: 'VEC3'}, {bufferView: 2, componentType: 5126, count: 4, type: 'VEC4'}, {bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR'}],
    materials: [{alphaMode: 'MASK', alphaCutoff: 0.5}, {alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true}, {doubleSided: false}, {doubleSided: true, pbrMetallicRoughness: {baseColorFactor: [0.2, 0.6, 0.9, 1]}},
      {alphaMode: 'BLEND', pbrMetallicRoughness: {baseColorFactor: [1, 0.4, 0.2, 0.6]}}, {extensions: {KHR_materials_unlit: {}}, pbrMetallicRoughness: {baseColorFactor: [0.9, 0.9, 0.2, 1]}}, {extensions: {KHR_materials_clearcoat: {clearcoatFactor: 1}}, pbrMetallicRoughness: {metallicFactor: 0.2, roughnessFactor: 0.4}}],
    meshes: [], nodes: []};
  // Each material twice: facing the camera and turned away (single-sided ones must vanish from behind).
  for (let k = 0; k < 7; k++) {doc.meshes.push({primitives: [{attributes: {POSITION: 0, NORMAL: 1, COLOR_0: 2}, indices: 3, material: k}]});
    for (const back of [0, 1]) doc.nodes.push({mesh: k, translation: [(k - 3) * 1.1, back ? -0.6 : 0.6, 0], rotation: back ? [0, 0.9238795, 0, 0.3826834] : [0, 0.3826834, 0, 0.9238795]});}
  return {doc, buffers};
};
const engine = await Engine.create(document.getElementById('view'), {backend: 'webgpu', camera: {position: [0, 0, 6], target: [0, 0, 0], fov: 50}});
const errors = []; engine.gpu.addEventListener('uncapturederror', e => errors.push(e.error.message));
const {doc, buffers} = quad(), model = gltf.parseGLTF(engine, doc, buffers);
const helmet = await gltf.loadGLTF(engine, '/examples/assets/damaged-helmet.glb'); helmet.root.setPosition([0, 0, -3]).setScale([1.6, 1.6, 1.6]);
const ssao = SSAO.attach(engine, {radius: 0.5}); ssao.add(model); ssao.add(helmet);
for (let i = 0; i < 10; i++) {engine.render(); await engine.gpu.queue.onSubmittedWorkDone();}
window.result = {errors, which};
