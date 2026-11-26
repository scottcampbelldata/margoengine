// A two-bone skinned strip (x 0..2, y 0..0.2) whose second joint, at x=1, turns 90 degrees about +Z over one second.
// Vertices with x >= 1 follow joint 1, so at time t they sit at (1,0,0) + Rz(t * 90 degrees) * (x - 1, y, 0).
export function skinnedStrip({ columns = 5, extraClip = false } = {}) {
  const buffers = [],
    bufferViews = [],
    accessors = [];
  const add = (data, type, componentType = 5126) => {
    const id = buffers.length,
      width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    buffers.push(data);
    bufferViews.push({ buffer: id, byteLength: data.byteLength });
    accessors.push({ bufferView: id, componentType, count: data.length / width, type });
    return id;
  };
  const positions = [],
    uvs = [],
    joints = [],
    weights = [],
    indices = [];
  for (let c = 0; c < columns; c++)
    for (const y of [0, 0.2]) {
      const x = (c * 2) / (columns - 1);
      positions.push(x, y, 0);
      uvs.push(x / 2, y / 0.2);
      const j = x >= 1 ? 1 : 0;
      joints.push(j, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
  for (let c = 0; c + 1 < columns; c++) {
    const a = c * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const count = positions.length / 3,
    s = Math.SQRT1_2,
    index = add(new Uint32Array(indices), 'SCALAR', 5125);
  const attributes = {
    POSITION: add(new Float32Array(positions), 'VEC3'),
    NORMAL: add(
      new Float32Array(count * 3).map((_, i) => +(i % 3 === 2)),
      'VEC3',
    ),
    TEXCOORD_0: add(new Float32Array(uvs), 'VEC2'),
    JOINTS_0: add(new Uint8Array(joints), 'VEC4', 5121),
    WEIGHTS_0: add(new Float32Array(weights), 'VEC4'),
  };
  const inverseBind = add(
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1]),
    'MAT4',
  );
  const animations = [
    {
      name: 'bend',
      channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }],
      samplers: [
        {
          input: add(new Float32Array([0, 1]), 'SCALAR'),
          output: add(new Float32Array([0, 0, 0, 1, 0, 0, s, s]), 'VEC4'),
        },
      ],
    },
  ];
  if (extraClip)
    animations.push({
      name: 'lift',
      channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      samplers: [
        { input: add(new Float32Array([0, 2]), 'SCALAR'), output: add(new Float32Array([0, 0, 0, 0, 1, 0]), 'VEC3') },
      ],
    });
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
    bufferViews,
    accessors,
    meshes: [{ primitives: [{ attributes, indices: index }] }],
    materials: [],
    nodes: [{ mesh: 0, skin: 0 }, { children: [2] }, { translation: [1, 0, 0] }],
    scenes: [{ nodes: [0, 1] }],
    skins: [{ joints: [1, 2], inverseBindMatrices: inverseBind }],
    animations,
  };
  return { doc, buffers, positions, uvs };
}
/** Where vertex (x, y) of the strip is at time t of the bend clip. */
export function bent(x, y, t) {
  if (x < 1) return [x, y, 0];
  const a = (Math.PI / 2) * Math.min(1, t),
    c = Math.cos(a),
    s = Math.sin(a);
  return [1 + (x - 1) * c - y * s, (x - 1) * s + y * c, 0];
}
/**
 * The skinned strip with two morph targets: 'lift' raises every vertex 0.5 and tips its normal 0.1 along x; 'stretch'
 * moves a vertex half its x along x and has no normal offsets. The mesh starts at weights [0.25, 0]. `extra` adds an
 * unskinned triangle with no targets on a node of its own.
 */
export function morphedStrip({ extra = false, ...options } = {}) {
  const strip = skinnedStrip(options),
    { doc, buffers, positions } = strip,
    count = positions.length / 3,
    add = (data, type = 'VEC3', componentType = 5126) => {
      const id = buffers.length;
      buffers.push(data);
      doc.buffers.push({ byteLength: data.byteLength });
      doc.bufferViews.push({ buffer: id, byteLength: data.byteLength });
      doc.accessors.push({ bufferView: id, componentType, count: data.length / (type === 'VEC3' ? 3 : 1), type });
      return id;
    },
    each = (value) =>
      Float32Array.from({ length: count * 3 }, (_, i) => value(positions[Math.floor(i / 3) * 3], i % 3));
  doc.meshes[0].primitives[0].targets = [
    { POSITION: add(each((x, c) => (c === 1 ? 0.5 : 0))), NORMAL: add(each((x, c) => (c === 0 ? 0.1 : 0))) },
    { POSITION: add(each((x, c) => (c === 0 ? x * 0.5 : 0))) },
  ];
  doc.meshes[0].weights = [0.25, 0];
  doc.meshes[0].extras = { targetNames: ['lift', 'stretch'] };
  if (extra) {
    doc.meshes.push({
      primitives: [
        {
          attributes: {
            POSITION: add(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])),
            NORMAL: add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])),
          },
          indices: add(new Uint32Array([0, 1, 2]), 'SCALAR', 5125),
        },
      ],
    });
    doc.scenes[0].nodes.push(doc.nodes.push({ mesh: 1, translation: [0, 1, 0] }) - 1);
  }
  return strip;
}
/** Where vertex (x, y) of the morphed strip is at time t of the bend clip: morphed by [lift, stretch], then bent. */
export function morphedBent(x, y, t, [lift, stretch]) {
  const mx = x + x * 0.5 * stretch,
    my = y + 0.5 * lift;
  if (x < 1) return [mx, my, 0];
  const a = (Math.PI / 2) * Math.min(1, t),
    c = Math.cos(a),
    s = Math.sin(a);
  return [1 + (mx - 1) * c - my * s, (mx - 1) * s + my * c, 0];
}
