// A two-bone skinned strip (x 0..2, y 0..0.2) whose second joint, at x=1, turns 90 degrees about +Z over one second.
// Vertices with x >= 1 follow joint 1, so at time t they sit at (1,0,0) + Rz(t * 90 degrees) * (x - 1, y, 0).
export function skinnedStrip({columns = 5, extraClip = false} = {}) {
  const buffers = [], bufferViews = [], accessors = [];
  const add = (data, type, componentType = 5126) => {const id = buffers.length, width = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16}[type]; buffers.push(data); bufferViews.push({buffer: id, byteLength: data.byteLength}); accessors.push({bufferView: id, componentType, count: data.length / width, type}); return id;};
  const positions = [], uvs = [], joints = [], weights = [], indices = [];
  for (let c = 0; c < columns; c++) for (const y of [0, 0.2]) {const x = c * 2 / (columns - 1); positions.push(x, y, 0); uvs.push(x / 2, y / 0.2); const j = x >= 1 ? 1 : 0; joints.push(j, 0, 0, 0); weights.push(1, 0, 0, 0);}
  for (let c = 0; c + 1 < columns; c++) {const a = c * 2; indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);}
  const count = positions.length / 3, s = Math.SQRT1_2, index = add(new Uint32Array(indices), 'SCALAR', 5125);
  const attributes = {POSITION: add(new Float32Array(positions), 'VEC3'), NORMAL: add(new Float32Array(count * 3).map((_, i) => +(i % 3 === 2)), 'VEC3'), TEXCOORD_0: add(new Float32Array(uvs), 'VEC2'),
    JOINTS_0: add(new Uint8Array(joints), 'VEC4', 5121), WEIGHTS_0: add(new Float32Array(weights), 'VEC4')};
  const inverseBind = add(new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1, 1,0,0,0, 0,1,0,0, 0,0,1,0, -1,0,0,1]), 'MAT4');
  const animations = [{name: 'bend', channels: [{sampler: 0, target: {node: 2, path: 'rotation'}}], samplers: [{input: add(new Float32Array([0, 1]), 'SCALAR'), output: add(new Float32Array([0, 0, 0, 1, 0, 0, s, s]), 'VEC4')}]}];
  if (extraClip) animations.push({name: 'lift', channels: [{sampler: 0, target: {node: 1, path: 'translation'}}], samplers: [{input: add(new Float32Array([0, 2]), 'SCALAR'), output: add(new Float32Array([0, 0, 0, 0, 1, 0]), 'VEC3')}]});
  const doc = {asset: {version: '2.0'}, buffers: buffers.map(b => ({byteLength: b.byteLength})), bufferViews, accessors,
    meshes: [{primitives: [{attributes, indices: index}]}], materials: [],
    nodes: [{mesh: 0, skin: 0}, {children: [2]}, {translation: [1, 0, 0]}], scenes: [{nodes: [0, 1]}], skins: [{joints: [1, 2], inverseBindMatrices: inverseBind}], animations};
  return {doc, buffers, positions, uvs};
}
/** Where vertex (x, y) of the strip is at time t of the bend clip. */
export function bent(x, y, t) {
  if (x < 1) return [x, y, 0];
  const a = Math.PI / 2 * Math.min(1, t), c = Math.cos(a), s = Math.sin(a);
  return [1 + (x - 1) * c - y * s, (x - 1) * s + y * c, 0];
}
