// Writes the animation fixtures (our own files, written from the COLLADA 1.4.1 and glTF 2.0 / KHR_animation_pointer
// specifications). The animation-formats demo draws the first two:
//   bend-tube.dae         a tube skinned to three joints, the upper two bending back and forth (LINEAR, 2 s loop)
//   pointer-cube.gltf     a cube whose base colour, emissive colour and position are animated through
//                         KHR_animation_pointer (LINEAR, 2 s loop), with the buffer embedded as a data URI
//   pointer-all.gltf      one clip animating every pointer target @margoengine/animation/pointer plays, with STEP,
//                         LINEAR and CUBICSPLINE samplers, plus one valid pointer it skips (node extras)
//   pointer-invalid.gltf  pointer-all.gltf plus a pointer at a property animations may not change (alphaMode)
// Run: node examples/assets/animation-formats/generate.mjs
import { writeFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const round = (v) => +v.toFixed(5);

// ---- bend-tube.dae ----
const sides = 16,
  rings = 13,
  height = 3,
  radius = 0.3;
const positions = [],
  normals = [],
  triangles = [],
  vcount = [],
  v = [];
for (let r = 0; r < rings; r++)
  for (let s = 0; s < sides; s++) {
    const a = (s / sides) * Math.PI * 2,
      y = (r / (rings - 1)) * height;
    positions.push(round(Math.cos(a) * radius), round(y), round(Math.sin(a) * radius));
    normals.push(round(Math.cos(a)), 0, round(Math.sin(a)));
    // Weights blend between the two nearest joints (at y = 0, 1 and 2).
    const t = Math.min(y, 2),
      j = Math.min(Math.floor(t), 1),
      w = t - j;
    if (y >= 2 || w === 0) {
      vcount.push(1);
      v.push(Math.min(Math.round(t), 2), 0);
    } else {
      vcount.push(2);
      v.push(j, 0, j + 1, 1);
    }
  }
const weights = [1];
// Weight values: index 0 is 1; each blended vertex appends (1 - w, w).
let cursor = 0;
for (let r = 0; r < rings; r++)
  for (let s = 0; s < sides; s++, cursor++) {
    const y = (r / (rings - 1)) * height,
      t = Math.min(y, 2),
      j = Math.min(Math.floor(t), 1),
      w = t - j;
    if (!(y >= 2 || w === 0)) {
      const at = weights.length;
      weights.push(round(1 - w), round(w));
      // Point this vertex's pair at its two weights.
      let k = 0,
        pos = 0;
      for (; k < cursor; k++) pos += vcount[k] * 2;
      v[pos + 1] = at;
      v[pos + 3] = at + 1;
    }
  }
for (let r = 0; r < rings - 1; r++)
  for (let s = 0; s < sides; s++) {
    const a = r * sides + s,
      b = r * sides + ((s + 1) % sides),
      c = a + sides,
      d = b + sides;
    triangles.push(a, c, b, b, c, d);
  }
const p = triangles.flatMap((i) => [i, i]);
const inverseBinds = [0, 1, 2].flatMap((y) => [1, 0, 0, 0, 0, 1, 0, -y, 0, 0, 1, 0, 0, 0, 0, 1]);
const array = (id, values, stride, params, type = 'float') =>
  `<source id="${id}"><${type}_array id="${id}-a" count="${values.length}">${values.join(' ')}</${type}_array>` +
  `<technique_common><accessor source="#${id}-a" count="${values.length / stride}" stride="${stride}">` +
  params
    .map(
      (n) =>
        `<param name="${n}" type="${type === 'Name' ? 'name' : type === 'float' && stride === 16 ? 'float4x4' : 'float'}"/>`,
    )
    .join('') +
  `</accessor></technique_common></source>`;
const names = (id, values, param) =>
  `<source id="${id}"><Name_array id="${id}-a" count="${values.length}">${values.join(' ')}</Name_array>` +
  `<technique_common><accessor source="#${id}-a" count="${values.length}"><param name="${param}" type="name"/></accessor></technique_common></source>`;
const bend = (id, joint, angles) =>
  `<animation id="${id}">` +
  array(`${id}-in`, [0, 0.5, 1, 1.5, 2], 1, ['TIME']) +
  array(`${id}-out`, angles, 1, ['ANGLE']) +
  names(`${id}-interp`, Array(5).fill('LINEAR'), 'INTERPOLATION') +
  `<sampler id="${id}-s"><input semantic="INPUT" source="#${id}-in"/><input semantic="OUTPUT" source="#${id}-out"/>` +
  `<input semantic="INTERPOLATION" source="#${id}-interp"/></sampler>` +
  `<channel source="#${id}-s" target="${joint}/rz.ANGLE"/></animation>`;
const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
<asset><unit meter="1"/><up_axis>Y_UP</up_axis></asset>
<library_geometries><geometry id="tube" name="tube"><mesh>
${array('tube-p', positions, 3, ['X', 'Y', 'Z'])}
${array('tube-n', normals, 3, ['X', 'Y', 'Z'])}
<vertices id="tube-v"><input semantic="POSITION" source="#tube-p"/></vertices>
<triangles count="${triangles.length / 3}"><input semantic="VERTEX" source="#tube-v" offset="0"/><input semantic="NORMAL" source="#tube-n" offset="1"/><p>${p.join(' ')}</p></triangles>
</mesh></geometry></library_geometries>
<library_controllers><controller id="tube-skin"><skin source="#tube">
<bind_shape_matrix>1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1</bind_shape_matrix>
${names('skin-joints', ['J0', 'J1', 'J2'], 'JOINT')}
${array('skin-binds', inverseBinds, 16, ['TRANSFORM'])}
${array('skin-weights', weights, 1, ['WEIGHT'])}
<joints><input semantic="JOINT" source="#skin-joints"/><input semantic="INV_BIND_MATRIX" source="#skin-binds"/></joints>
<vertex_weights count="${vcount.length}"><input semantic="JOINT" source="#skin-joints" offset="0"/><input semantic="WEIGHT" source="#skin-weights" offset="1"/>
<vcount>${vcount.join(' ')}</vcount><v>${v.join(' ')}</v></vertex_weights>
</skin></controller></library_controllers>
<library_animations>
${bend('bend1', 'J1', [0, 35, 0, -35, 0])}
${bend('bend2', 'J2', [0, 45, 0, -45, 0])}
</library_animations>
<library_visual_scenes><visual_scene id="scene">
<node id="J0" sid="J0" name="J0" type="JOINT"><rotate sid="rz">0 0 1 0</rotate>
<node id="J1" sid="J1" name="J1" type="JOINT"><translate sid="t">0 1 0</translate><rotate sid="rz">0 0 1 0</rotate>
<node id="J2" sid="J2" name="J2" type="JOINT"><translate sid="t">0 1 0</translate><rotate sid="rz">0 0 1 0</rotate></node>
</node></node>
<node id="body" name="body"><instance_controller url="#tube-skin"><skeleton>#J0</skeleton></instance_controller></node>
</visual_scene></library_visual_scenes>
<scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>
`;
writeFileSync(here('bend-tube.dae'), dae);

// ---- pointer-cube.gltf ----
const boxPositions = [],
  boxNormals = [],
  boxIndices = [];
for (const [axis, sign, other] of [
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, 2],
  [1, -1, 2],
  [2, 1, 0],
  [2, -1, 0],
]) {
  const u = other,
    w = 3 - axis - other,
    base = boxPositions.length / 3;
  for (const [a, b] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ]) {
    const point = [0, 0, 0],
      normal = [0, 0, 0];
    point[axis] = 0.5 * sign;
    point[u] = 0.5 * a;
    point[w] = 0.5 * b;
    normal[axis] = sign;
    boxPositions.push(...point);
    boxNormals.push(...normal);
  }
  // Counter-clockwise seen from outside.
  const flip = sign > 0 !== ((u + 1) % 3 === w);
  boxIndices.push(...(flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3]).map((i) => base + i));
}
const times = [0, 0.5, 1, 1.5, 2],
  colors = [0.9, 0.2, 0.15, 1, 0.95, 0.75, 0.1, 1, 0.15, 0.6, 0.95, 1, 0.6, 0.2, 0.9, 1, 0.9, 0.2, 0.15, 1],
  emissive = [0, 0, 0, 0.6, 0.4, 0, 0, 0, 0, 0, 0.3, 0.6, 0, 0, 0],
  moves = [0, 0.5, 0, 0, 1.1, 0, 0, 0.5, 0, 0, 0.9, 0, 0, 0.5, 0];
const chunks = [
  ['positions', new Float32Array(boxPositions), 'VEC3', 34962],
  ['normals', new Float32Array(boxNormals), 'VEC3', 34962],
  ['indices', new Uint16Array(boxIndices), 'SCALAR', 34963],
  ['times', new Float32Array(times), 'SCALAR'],
  ['colors', new Float32Array(colors), 'VEC4'],
  ['emissive', new Float32Array(emissive), 'VEC3'],
  ['moves', new Float32Array(moves), 'VEC3'],
];
let length = 0;
const views = [],
  accessors = [];
for (const [, data, type, target] of chunks) {
  length = Math.ceil(length / 4) * 4;
  views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, ...(target ? { target } : {}) });
  const count = data.length / { SCALAR: 1, VEC3: 3, VEC4: 4 }[type],
    accessor = { bufferView: views.length - 1, componentType: data instanceof Uint16Array ? 5123 : 5126, count, type };
  if (accessors.length === 0) {
    accessor.min = [-0.5, -0.5, -0.5];
    accessor.max = [0.5, 0.5, 0.5];
  }
  if (accessors.length === 3) {
    accessor.min = [0];
    accessor.max = [2];
  }
  accessors.push(accessor);
  length += data.byteLength;
}
const bytes = new Uint8Array(Math.ceil(length / 4) * 4);
chunks.forEach(([, data], i) => bytes.set(new Uint8Array(data.buffer), views[i].byteOffset));
const pointer = (sampler, path) => ({
  sampler,
  target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: path } } },
});
const gltf = {
  asset: { version: '2.0', generator: 'Margo Engine examples/assets/animation-formats/generate.mjs' },
  extensionsUsed: ['KHR_animation_pointer'],
  extensionsRequired: ['KHR_animation_pointer'],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'cube', mesh: 0, translation: [0, 0.5, 0] }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [
    { pbrMetallicRoughness: { baseColorFactor: [0.9, 0.2, 0.15, 1], roughnessFactor: 0.4 }, doubleSided: true },
  ],
  animations: [
    {
      name: 'show',
      samplers: [
        { input: 3, output: 4, interpolation: 'LINEAR' },
        { input: 3, output: 5, interpolation: 'LINEAR' },
        { input: 3, output: 6, interpolation: 'LINEAR' },
      ],
      channels: [
        pointer(0, '/materials/0/pbrMetallicRoughness/baseColorFactor'),
        pointer(1, '/materials/0/emissiveFactor'),
        pointer(2, '/nodes/0/translation'),
      ],
    },
  ],
  buffers: [
    { byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` },
  ],
  bufferViews: views,
  accessors,
};
writeFileSync(here('pointer-cube.gltf'), `${JSON.stringify(gltf, null, 1)}\n`);

// ---- pointer-all.gltf and pointer-invalid.gltf ----
{
  // A 2x2 RGBA PNG (stored deflate), embedded in the buffer.
  const pngChunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]),
      head = Buffer.alloc(4),
      tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.from([0, 255, 255, 255, 255, 40, 120, 220, 255, 0, 40, 120, 220, 255, 255, 255, 255, 255]);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  const parts = [],
    views = [],
    accessors = [];
  let size = 0;
  const view = (data, target) => {
    size = Math.ceil(size / 4) * 4;
    views.push({ buffer: 0, byteOffset: size, byteLength: data.byteLength, ...(target ? { target } : {}) });
    parts.push([size, new Uint8Array(data.buffer, data.byteOffset, data.byteLength)]);
    size += data.byteLength;
    return views.length - 1;
  };
  const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const add = (values, type, extra = {}, componentType = 5126, target) => {
    const data =
      componentType === 5126
        ? new Float32Array(values)
        : componentType === 5121
          ? new Uint8Array(values)
          : new Uint16Array(values);
    accessors.push({
      bufferView: view(data, target),
      componentType,
      count: values.length / widths[type],
      type,
      ...extra,
    });
    return accessors.length - 1;
  };
  const position = add(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
      'VEC3',
      { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] },
      5126,
      34962,
    ),
    normal = add([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3', {}, 5126, 34962),
    uv = add([0, 1, 1, 1, 1, 0, 0, 0], 'VEC2', {}, 5126, 34962),
    index = add([0, 1, 2, 0, 2, 3], 'SCALAR', {}, 5123, 34963),
    morph = add([0, 0, 0.25, 0, 0, 0.25, 0, 0, 0.25, 0, 0, 0.25], 'VEC3', { min: [0, 0, 0.25], max: [0, 0, 0.25] }),
    image = view(png),
    keyTimes = add([0, 1, 2], 'SCALAR', { min: [0], max: [2] });
  const samplers = [],
    channels = [];
  // Three keys at 0, 1 and 2 s. CUBICSPLINE outputs hold in tangent, value, out tangent per key.
  const animate = (path, keys, interpolation, tangents) => {
    const width = keys[0].length,
      type = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' }[width],
      output =
        interpolation === 'CUBICSPLINE'
          ? keys.flatMap((key, k) => [...tangents[k][0], ...key, ...tangents[k][1]])
          : keys.flat(),
      bool = path.endsWith('/visible');
    samplers.push({ input: keyTimes, output: add(output, type, {}, bool ? 5121 : 5126), interpolation });
    channels.push({
      sampler: samplers.length - 1,
      target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: path } } },
    });
  };
  const m = '/materials/0',
    transform = `${m}/pbrMetallicRoughness/baseColorTexture/extensions/KHR_texture_transform`,
    light = '/extensions/KHR_lights_punctual/lights/0';
  animate(
    `${m}/pbrMetallicRoughness/baseColorFactor`,
    [
      [1, 1, 1, 1],
      [0.2, 0.6, 1, 1],
      [1, 0.3, 0.1, 0.8],
    ],
    'LINEAR',
  );
  animate(`${m}/pbrMetallicRoughness/metallicFactor`, [[0], [1], [0.5]], 'STEP');
  animate(`${m}/pbrMetallicRoughness/roughnessFactor`, [[1], [0.2], [0.6]], 'CUBICSPLINE', [
    [[0], [0]],
    [[-0.5], [-0.5]],
    [[0.3], [0]],
  ]);
  animate(
    `${m}/emissiveFactor`,
    [
      [0, 0, 0],
      [1, 0.5, 0],
      [0, 0.25, 1],
    ],
    'LINEAR',
  );
  animate(`${m}/alphaCutoff`, [[0.5], [0.1], [0.9]], 'STEP');
  animate(`${m}/normalTexture/scale`, [[1], [0.25], [2]], 'LINEAR');
  animate(`${m}/occlusionTexture/strength`, [[1], [0], [0.5]], 'CUBICSPLINE', [
    [[0], [-1]],
    [[0], [0.5]],
    [[0.25], [0]],
  ]);
  animate(
    `${transform}/offset`,
    [
      [0, 0],
      [0.5, 0.25],
      [1, 0],
    ],
    'LINEAR',
  );
  animate(
    `${transform}/scale`,
    [
      [1, 1],
      [2, 0.5],
      [0.5, 2],
    ],
    'STEP',
  );
  animate(`${transform}/rotation`, [[0], [1.5], [0.5]], 'CUBICSPLINE', [
    [[0], [1]],
    [[0.5], [0]],
    [[-1], [0]],
  ]);
  animate(`${m}/extensions/KHR_materials_emissive_strength/emissiveStrength`, [[1], [3], [2]], 'LINEAR');
  animate(
    `${light}/color`,
    [
      [1, 1, 1],
      [1, 0.4, 0.1],
      [0.2, 0.4, 1],
    ],
    'LINEAR',
  );
  animate(`${light}/intensity`, [[5], [20], [10]], 'CUBICSPLINE', [
    [[0], [10]],
    [[5], [0]],
    [[0], [0]],
  ]);
  animate(`${light}/range`, [[4], [8], [6]], 'STEP');
  animate(`${light}/spot/innerConeAngle`, [[0.1], [0.3], [0.2]], 'LINEAR');
  animate(`${light}/spot/outerConeAngle`, [[0.5], [0.7], [0.6]], 'LINEAR');
  animate('/cameras/0/perspective/yfov', [[0.8], [0.4], [1.2]], 'LINEAR');
  animate('/cameras/0/perspective/znear', [[0.1], [0.5], [0.2]], 'STEP');
  animate('/cameras/0/perspective/zfar', [[100], [50], [200]], 'LINEAR');
  animate('/cameras/0/perspective/aspectRatio', [[1.5], [1], [2]], 'CUBICSPLINE', [
    [[0], [0]],
    [[-1], [1]],
    [[0], [0]],
  ]);
  animate('/cameras/1/orthographic/xmag', [[1], [2], [3]], 'LINEAR');
  animate('/cameras/1/orthographic/ymag', [[1], [3], [2]], 'STEP');
  animate('/cameras/1/orthographic/znear', [[0.1], [1], [0.5]], 'LINEAR');
  animate('/cameras/1/orthographic/zfar', [[10], [20], [15]], 'CUBICSPLINE', [
    [[0], [5]],
    [[0], [0]],
    [[-5], [0]],
  ]);
  const s = Math.SQRT1_2;
  animate(
    '/nodes/0/translation',
    [
      [0, 0, 0],
      [1, 0.5, 0],
      [0, 1, -1],
    ],
    'LINEAR',
  );
  animate(
    '/nodes/0/rotation',
    [
      [0, 0, 0, 1],
      [0, 0, s, s],
      [0, 1, 0, 0],
    ],
    'LINEAR',
  );
  animate(
    '/nodes/0/scale',
    [
      [1, 1, 1],
      [2, 1, 1],
      [1, 0.5, 1],
    ],
    'CUBICSPLINE',
    [
      [
        [0, 0, 0],
        [1, 0, 0],
      ],
      [
        [0, 0, 0],
        [0, -0.5, 0],
      ],
      [
        [0, 0, 0],
        [0, 0, 0],
      ],
    ],
  );
  animate('/nodes/0/weights', [[0], [1], [0.5]], 'LINEAR');
  animate('/meshes/0/weights', [[0], [0.8], [0.2]], 'CUBICSPLINE', [
    [[0], [1]],
    [[0], [0]],
    [[0], [0]],
  ]);
  animate('/nodes/0/extensions/KHR_node_visibility/visible', [[1], [0], [1]], 'STEP');
  // Valid but not played: application-defined extras.
  animate('/nodes/0/extras/blink', [[0], [1], [0]], 'LINEAR');
  const data = new Uint8Array(Math.ceil(size / 4) * 4);
  for (const [at, part] of parts) data.set(part, at);
  const all = {
    asset: { version: '2.0', generator: 'Margo Engine examples/assets/animation-formats/generate.mjs' },
    extensionsUsed: [
      'KHR_animation_pointer',
      'KHR_texture_transform',
      'KHR_materials_emissive_strength',
      'KHR_lights_punctual',
      'KHR_node_visibility',
    ],
    extensionsRequired: ['KHR_animation_pointer'],
    scene: 0,
    scenes: [{ nodes: [0, 1, 2, 3, 4] }],
    nodes: [
      { name: 'quad', mesh: 0, extensions: { KHR_node_visibility: { visible: true } }, extras: { blink: 0 } },
      { name: 'twin', mesh: 0, translation: [1.5, 0, 0] },
      { name: 'spot', translation: [0, 2, 1], extensions: { KHR_lights_punctual: { light: 0 } } },
      { name: 'eye', camera: 0, translation: [0, 0, 4] },
      { name: 'top', camera: 1, translation: [0, 4, 0], rotation: [-s, 0, 0, s] },
    ],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
            indices: index,
            material: 0,
            targets: [{ POSITION: morph }],
          },
        ],
        weights: [0],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [1, 1, 1, 1],
          metallicFactor: 0,
          roughnessFactor: 1,
          baseColorTexture: {
            index: 0,
            extensions: { KHR_texture_transform: { offset: [0, 0], scale: [1, 1], rotation: 0 } },
          },
        },
        normalTexture: { index: 0, scale: 1 },
        occlusionTexture: { index: 0, strength: 1 },
        emissiveFactor: [0, 0, 0],
        alphaMode: 'MASK',
        alphaCutoff: 0.5,
        doubleSided: true,
        extensions: { KHR_materials_emissive_strength: { emissiveStrength: 1 } },
      },
    ],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ magFilter: 9728, minFilter: 9728 }],
    images: [{ bufferView: image, mimeType: 'image/png' }],
    cameras: [
      { type: 'perspective', perspective: { yfov: 0.8, aspectRatio: 1.5, znear: 0.1, zfar: 100 } },
      { type: 'orthographic', orthographic: { xmag: 1, ymag: 1, znear: 0.1, zfar: 10 } },
    ],
    extensions: {
      KHR_lights_punctual: {
        lights: [
          {
            type: 'spot',
            color: [1, 1, 1],
            intensity: 5,
            range: 4,
            spot: { innerConeAngle: 0.1, outerConeAngle: 0.5 },
          },
        ],
      },
    },
    animations: [{ name: 'everything', samplers, channels }],
    buffers: [
      { byteLength: data.length, uri: `data:application/octet-stream;base64,${Buffer.from(data).toString('base64')}` },
    ],
    bufferViews: views,
    accessors,
  };
  writeFileSync(here('pointer-all.gltf'), `${JSON.stringify(all)}\n`);
  // The same file with one more channel at a property glTF does not let animations change.
  const invalid = structuredClone(all);
  invalid.animations[0].channels.push({
    sampler: 1,
    target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/materials/0/alphaMode' } } },
  });
  writeFileSync(here('pointer-invalid.gltf'), `${JSON.stringify(invalid)}\n`);
}
console.log('wrote bend-tube.dae, pointer-cube.gltf, pointer-all.gltf and pointer-invalid.gltf');
