// A generated GLB for parse tests and benchmarks: `meshes` grids of segments x segments quads under one parent node,
// float positions/normals/uvs with uint32 indices, and every other grid without normals (gltf-pro generates them).
// `instances` > 0 draws each grid that many times through EXT_mesh_gpu_instancing (TRANSLATION + SCALE).
export function bigGLB({segments = 256, meshes = 2, instances = 0} = {}) {
  const n = segments + 1, count = n * n, chunks = [], bufferViews = [], accessors = [], gltfMeshes = [];
  let length = 0;
  const add = (data, type, componentType, target, extra = {}) => {
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)); bufferViews.push({buffer: 0, byteOffset: length, byteLength: data.byteLength, target});
    length += data.byteLength + (-data.byteLength & 3); if (data.byteLength & 3) chunks.push(new Uint8Array(-data.byteLength & 3));
    accessors.push({bufferView: bufferViews.length - 1, componentType, count: data.length / {SCALAR: 1, VEC2: 2, VEC3: 3}[type], type, ...extra}); return accessors.length - 1;
  };
  for (let m = 0; m < meshes; m++) {
    const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3), uvs = new Float32Array(count * 2), indices = new Uint32Array(segments * segments * 6);
    for (let y = 0, i = 0; y < n; y++) for (let x = 0; x < n; x++, i++) {
      const u = x / segments, v = y / segments, h = 0.1 * Math.sin(u * 12 + m) * Math.cos(v * 9);
      positions.set([u * 4 - 2 + m * 4.5, h, v * 4 - 2], i * 3); normals.set([0, 1, 0], i * 3); uvs.set([u, v], i * 2);
    }
    for (let y = 0, k = 0; y < segments; y++) for (let x = 0; x < segments; x++) {const a = y * n + x; indices.set([a, a + n, a + 1, a + 1, a + n, a + n + 1], k); k += 6;}
    const attributes = {POSITION: add(positions, 'VEC3', 5126, 34962, {min: [-2 + m * 4.5, -0.1, -2], max: [2 + m * 4.5, 0.1, 2]}), TEXCOORD_0: add(uvs, 'VEC2', 5126, 34962)};
    if (m % 2 === 0) attributes.NORMAL = add(normals, 'VEC3', 5126, 34962);
    gltfMeshes.push({primitives: [{attributes, indices: add(indices, 'SCALAR', 5125, 34963), material: 0}]});
  }
  const instancing = i => instances ? {extensions: {EXT_mesh_gpu_instancing: {attributes: {TRANSLATION: add(Float32Array.from({length: instances * 3}, (_, k) => k % 3 === 1 ? 0 : (k + i) * 0.37), 'VEC3', 5126), SCALE: add(new Float32Array(instances * 3).fill(0.5 + i), 'VEC3', 5126)}}}} : {};
  const json = {asset: {version: '2.0'}, ...instances ? {extensionsUsed: ['EXT_mesh_gpu_instancing']} : {}, scene: 0, scenes: [{nodes: [0]}], nodes: [{name: 'root', children: gltfMeshes.map((_, i) => i + 1)}, ...gltfMeshes.map((_, i) => ({name: 'grid' + i, mesh: i, translation: [0, i * 0.01, 0], ...instancing(i)}))],
    meshes: gltfMeshes, materials: [{pbrMetallicRoughness: {baseColorFactor: [0.8, 0.8, 0.85, 1], metallicFactor: 0.1, roughnessFactor: 0.6}}], accessors, bufferViews, buffers: [{byteLength: length}]};
  const text = new TextEncoder().encode(JSON.stringify(json)), pad = -text.length & 3, glb = new Uint8Array(12 + 8 + text.length + pad + 8 + length), view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, glb.length, true);
  view.setUint32(12, text.length + pad, true); view.setUint32(16, 0x4e4f534a, true); glb.set(text, 20); glb.fill(0x20, 20 + text.length, 20 + text.length + pad);
  let at = 20 + text.length + pad; view.setUint32(at, length, true); view.setUint32(at + 4, 0x004e4942, true); at += 8;
  for (const chunk of chunks) {glb.set(chunk, at); at += chunk.length;}
  return glb;
}
