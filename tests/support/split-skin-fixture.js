// A skinned and morphed grid big enough to split into parts (gltf/pbr maxPartVertices), and the same mesh split by
// hand into one primitive per part, as an asset builder did before gltf/pbr split skinned primitives itself.
//
// The grid lies in the xy plane, x from 0 to 2 and y from 0 to 1. Joint 0 sits at the origin and joint 1 at x = 1;
// vertices blend from joint 0 to joint 1 between x = 0.8 and x = 1.2 (two influences, so the weights matter). One
// morph target lifts z by 0.1 sin(7x) cos(5y) and tilts the normal. Clip "bend" turns joint 1 by 90 degrees about +Z
// and drives the morph weight from 0 to 1 over one second.

const WIDTHS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** A `columns` x `rows` vertex grid as a skinned, morphed glTF; `arrays` holds each per-vertex attribute's values. */
export function splitSkinGrid(columns, rows) {
  const count = columns * rows,
    positions = new Float32Array(count * 3),
    normals = new Float32Array(count * 3),
    uvs = new Float32Array(count * 2),
    joints = new Uint8Array(count * 4),
    weights = new Float32Array(count * 4),
    lift = new Float32Array(count * 3),
    tilt = new Float32Array(count * 3);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < columns; c++) {
      const i = r * columns + c,
        x = (2 * c) / (columns - 1),
        y = r / (rows - 1),
        t = Math.min(1, Math.max(0, (x - 0.8) / 0.4));
      positions.set([x, y, 0], i * 3);
      normals.set([0, 0, 1], i * 3);
      uvs.set([x / 2, y], i * 2);
      joints.set([0, 1, 0, 0], i * 4);
      weights.set([1 - t, t, 0, 0], i * 4);
      lift.set([0, 0, 0.1 * Math.sin(7 * x) * Math.cos(5 * y)], i * 3);
      tilt.set([0.2 * Math.cos(7 * x), 0, 0], i * 3);
    }
  const indices = new Uint32Array((columns - 1) * (rows - 1) * 6);
  for (let r = 0, o = 0; r + 1 < rows; r++)
    for (let c = 0; c + 1 < columns; c++, o += 6) {
      const i = r * columns + c;
      indices.set([i, i + 1, i + columns, i + 1, i + columns + 1, i + columns], o);
    }
  const gltf = documentBuilder(),
    s = Math.SQRT1_2,
    arrays = {
      POSITION: positions,
      NORMAL: normals,
      TEXCOORD_0: uvs,
      JOINTS_0: joints,
      WEIGHTS_0: weights,
      lift,
      tilt,
    };
  const primitive = primitiveOf(gltf, arrays, indices, count);
  const inverseBind = gltf.add(
    new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 1]),
    'MAT4',
  );
  const times = gltf.add(new Float32Array([0, 1]), 'SCALAR');
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0, skin: 0 }, { children: [2] }, { translation: [1, 0, 0] }],
    meshes: [{ primitives: [primitive], weights: [0] }],
    materials: [
      { pbrMetallicRoughness: { baseColorFactor: [0.8, 0.6, 0.4, 1], metallicFactor: 0, roughnessFactor: 0.6 } },
    ],
    skins: [{ joints: [1, 2], inverseBindMatrices: inverseBind }],
    animations: [
      {
        name: 'bend',
        channels: [
          { sampler: 0, target: { node: 2, path: 'rotation' } },
          { sampler: 1, target: { node: 0, path: 'weights' } },
        ],
        samplers: [
          { input: times, output: gltf.add(new Float32Array([0, 0, 0, 1, 0, 0, s, s]), 'VEC4') },
          { input: times, output: gltf.add(new Float32Array([0, 1]), 'SCALAR') },
        ],
      },
    ],
    buffers: gltf.buffers,
    bufferViews: gltf.bufferViews,
    accessors: gltf.accessors,
  };
  return { doc, buffers: gltf.data, arrays, indices, count };
}

/**
 * The grid of {@link splitSkinGrid} with its one primitive replaced by one primitive per part: part k holds the
 * vertices `parts[k].vertexMap` names (each attribute gathered from the whole grid's) and the local triangles
 * `parts[k].indices`. Skin, nodes, materials and animation stay as they are.
 */
export function handSplit(grid, parts) {
  const gltf = documentBuilder(grid.doc, grid.buffers),
    primitives = parts.map(({ vertexMap, indices }) => {
      const gathered = {};
      for (const [name, values] of Object.entries(grid.arrays)) {
        const width = values.length / grid.count,
          out = new values.constructor(vertexMap.length * width);
        for (let k = 0; k < vertexMap.length; k++)
          for (let c = 0; c < width; c++) out[k * width + c] = values[vertexMap[k] * width + c];
        gathered[name] = out;
      }
      return primitiveOf(gltf, gathered, Uint32Array.from(indices), vertexMap.length);
    });
  const doc = {
    ...grid.doc,
    meshes: [{ ...grid.doc.meshes[0], primitives }],
    buffers: gltf.buffers,
    bufferViews: gltf.bufferViews,
    accessors: gltf.accessors,
  };
  return { doc, buffers: gltf.data };
}

/** The parts of a loaded model's split primitive as `handSplit` takes them. */
export const partsOf = (model) => model.primitives.map((p) => ({ vertexMap: p.part.vertexMap, indices: p.indices }));

/** One buffer per accessor, appended to `doc`'s (when given). */
function documentBuilder(doc, data) {
  const out = {
    buffers: [...(doc?.buffers ?? [])],
    bufferViews: [...(doc?.bufferViews ?? [])],
    accessors: [...(doc?.accessors ?? [])],
    data: [...(data ?? [])],
    add(values, type, componentType = 5126) {
      const buffer = out.data.length,
        view = out.bufferViews.length;
      out.data.push(values);
      out.buffers.push({ byteLength: values.byteLength });
      out.bufferViews.push({ buffer, byteLength: values.byteLength });
      const accessor = { bufferView: view, componentType, count: values.length / WIDTHS[type], type };
      if (type === 'VEC3' && componentType === 5126 && out.positions) {
        accessor.min = [Infinity, Infinity, Infinity];
        accessor.max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < values.length; i += 3)
          for (let k = 0; k < 3; k++) {
            accessor.min[k] = Math.min(accessor.min[k], values[i + k]);
            accessor.max[k] = Math.max(accessor.max[k], values[i + k]);
          }
      }
      return out.accessors.push(accessor) - 1;
    },
    positions: false,
  };
  return out;
}

function primitiveOf(gltf, arrays, indices, count) {
  gltf.positions = true;
  const POSITION = gltf.add(arrays.POSITION, 'VEC3'),
    lift = gltf.add(arrays.lift, 'VEC3');
  gltf.positions = false;
  if (arrays.POSITION.length !== count * 3) throw new RangeError('split-skin fixture: vertex count mismatch');
  return {
    attributes: {
      POSITION,
      NORMAL: gltf.add(arrays.NORMAL, 'VEC3'),
      TEXCOORD_0: gltf.add(arrays.TEXCOORD_0, 'VEC2'),
      JOINTS_0: gltf.add(arrays.JOINTS_0, 'VEC4', 5121),
      WEIGHTS_0: gltf.add(arrays.WEIGHTS_0, 'VEC4'),
    },
    indices: gltf.add(indices, 'SCALAR', 5125),
    targets: [{ POSITION: lift, NORMAL: gltf.add(arrays.tilt, 'VEC3') }],
    material: 0,
  };
}
