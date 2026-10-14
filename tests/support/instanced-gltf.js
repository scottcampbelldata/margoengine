// Generated glTF fixtures for EXT_mesh_gpu_instancing (nothing is downloaded): one textured quad mesh drawn at
// `transforms`, either as one node carrying the extension or as one node per instance (the non-instanced reference).
// ROTATION is stored as normalized int16, as exporters commonly write it; `rotation(q)` gives the decoded value.
const add = (state, data, type, componentType = 5126, normalized) => {
  const id = state.buffers.length; state.buffers.push(data); state.bufferViews.push({buffer: id, byteLength: data.byteLength});
  state.accessors.push({bufferView: id, componentType, count: data.length / {VEC2: 2, VEC3: 3, VEC4: 4, SCALAR: 1}[type], type, ...normalized ? {normalized: true} : {}}); return id;
};
export const rotation = q => {const d = q.map(v => Math.max(-1, Math.round(v * 32767) / 32767)), l = Math.hypot(...d); return d.map(v => v / l);};
/** transforms: [{t: [x, y, z], r: [x, y, z, w], s: [x, y, z]}]; image: an optional glTF image (e.g. a data: URI PNG) for the base colour. */
export function instancedGLTF(transforms, {instanced = true, required = instanced, image, material = {}} = {}) {
  const state = {buffers: [], bufferViews: [], accessors: []};
  const POSITION = add(state, new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 'VEC3');
  const NORMAL = add(state, new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3');
  const TEXCOORD_0 = add(state, new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 'VEC2');
  const indices = add(state, new Uint16Array([0, 1, 2, 0, 2, 3]), 'SCALAR', 5123);
  const doc = {asset: {version: '2.0'}, accessors: state.accessors, bufferViews: state.bufferViews,
    meshes: [{primitives: [{attributes: {POSITION, NORMAL, TEXCOORD_0}, indices, material: 0}]}],
    materials: [{pbrMetallicRoughness: {metallicFactor: 0, roughnessFactor: 0.7, ...image ? {baseColorTexture: {index: 0}} : {}}, ...material}],
    ...image ? {images: [{uri: image}], textures: [{source: 0}]} : {}};
  if (instanced) {
    const T = add(state, new Float32Array(transforms.flatMap(x => x.t ?? [0, 0, 0])), 'VEC3');
    const R = add(state, new Int16Array(transforms.flatMap(x => (x.r ?? [0, 0, 0, 1]).map(v => Math.round(v * 32767)))), 'VEC4', 5122, true);
    const S = add(state, new Float32Array(transforms.flatMap(x => x.s ?? [1, 1, 1])), 'VEC3');
    doc.nodes = [{mesh: 0, extensions: {EXT_mesh_gpu_instancing: {attributes: {TRANSLATION: T, ROTATION: R, SCALE: S}}}}];
    doc.extensionsUsed = ['EXT_mesh_gpu_instancing']; if (required) doc.extensionsRequired = ['EXT_mesh_gpu_instancing'];
  } else doc.nodes = transforms.map(x => ({mesh: 0, translation: x.t ?? [0, 0, 0], rotation: rotation(x.r ?? [0, 0, 0, 1]), scale: x.s ?? [1, 1, 1]}));
  doc.buffers = state.buffers.map(data => ({byteLength: data.byteLength}));
  return {doc, buffers: state.buffers};
}
