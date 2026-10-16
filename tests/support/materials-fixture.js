/** Synthetic glTF quad with independent UV sets and an explicit tangent frame. */
export function materialQuad(clearcoat) {
  const buffers = [],
    bufferViews = [],
    accessors = [];
  const add = (data, type, componentType = 5126) => {
    const index = buffers.length;
    buffers.push(data);
    bufferViews.push({ buffer: index, byteLength: data.byteLength });
    accessors.push({
      bufferView: index,
      componentType,
      count: data.length / { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type],
      type,
    });
    return index;
  };
  const attributes = {
    POSITION: add(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 'VEC3'),
    NORMAL: add(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3'),
    TANGENT: add(new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]), 'VEC4'),
    TEXCOORD_0: add(new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), 'VEC2'),
    TEXCOORD_1: add(new Float32Array([1, 1, 0, 1, 0, 0, 1, 0]), 'VEC2'),
  };
  const indices = add(new Uint16Array([0, 1, 2, 0, 2, 3]), 'SCALAR', 5123);
  const doc = {
    asset: { version: '2.0' },
    buffers: buffers.map((data) => ({ byteLength: data.byteLength })),
    bufferViews,
    accessors,
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes, indices, material: 0 }] }],
    materials: [
      {
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [0.08, 0.08, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.6 },
        ...(clearcoat === undefined ? {} : { extensions: { KHR_materials_clearcoat: clearcoat } }),
      },
    ],
  };
  return { doc, buffers };
}
