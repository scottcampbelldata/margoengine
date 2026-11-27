// Assemble the CC0 Poly Haven Modular Factory Facade kit for Last Tram.
// Pass the directory containing modular_factory_facade_1k.gltf and a destination GLB.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [source, output] = process.argv.slice(2);
if (!source || !output) throw Error('Pass the Poly Haven kit folder and an output GLB.');
const kit = JSON.parse(await readFile(join(source, 'modular_factory_facade_1k.gltf'), 'utf8'));
const library = new Map(kit.nodes.map((node) => [node.name, node]));
const bays = {
  wall: [3, 'wall_standard_standard_01'],
  window: [3, 'wall_window_centered_large_01', 'window_centered_large_01'],
  square: [3, 'wall_window_centered_medium_03', 'window_centered_medium_03'],
  paired: [3, 'wall_window_centered_double_01', 'window_centered_double_01'],
  narrow: [3, 'wall_window_tall_small_01', 'window_tall_small_01'],
  door: [3, 'wall_door_recessed_large_01', 'door_recessed_large_01'],
  loading: [6, 'wall_door_garage_door_01', 'door_garage_door_01'],
};
const nodes = [];
const root = [];
const binary = [await readFile(join(source, kit.buffers[0].uri))];
let byteLength = binary[0].length;
const align = (length) => (length + 3) & ~3;
function append(bytes, target) {
  const index = kit.bufferViews.length;
  const start = align(byteLength);
  if (start !== byteLength) binary.push(Buffer.alloc(start - byteLength));
  binary.push(bytes);
  byteLength = start + bytes.length;
  kit.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: bytes.length, ...(target ? { target } : {}) });
  return index;
}
for (const image of kit.images) {
  image.bufferView = append(await readFile(join(source, image.uri)));
  image.mimeType = 'image/jpeg';
  delete image.uri;
}

function add(name, translation, children, mesh, yaw = 0) {
  const index = nodes.length;
  nodes.push({
    name,
    translation,
    ...(children ? { children } : {}),
    ...(mesh === undefined ? {} : { mesh }),
    ...(yaw ? { rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] } : {}),
  });
  return index;
}
function piece(name, x, y, z) {
  const node = library.get(name);
  if (!node || node.mesh === undefined) throw Error('Missing facade piece ' + name);
  return add(name, [x, y, z], undefined, node.mesh);
}
function facade(rows, origin, yaw) {
  const children = [];
  for (const [floor, row] of rows.entries()) {
    let x = 0;
    const y = floor * 3;
    const rowWidth = row.reduce((length, bay) => length + bays[bay][0], 0);
    for (const bay of row) {
      const [width, ...parts] = bays[bay];
      x += width;
      for (const name of parts) children.push(piece(name, x, y, 0));
      if (x < rowWidth)
        children.push(piece('wall_pier_standard_01', x, y, 0));
    }
    if (floor) {
      for (let end = 3; end <= x; end += 3)
        children.push(piece('cornice02_standard_standard_01', end, y, 0));
    }
  }
  const width = rows[0].reduce((length, bay) => length + bays[bay][0], 0);
  for (let end = 3; end <= width; end += 3)
    children.push(piece('crown_standard_standard_01', end, rows.length * 3, 0));
  return add('Factory facade', origin, children, undefined, yaw);
}
const roofMaterial = kit.materials.length;
kit.materials.push({
  name: 'Standing-seam roof charcoal',
  pbrMetallicRoughness: { baseColorFactor: [0.09, 0.105, 0.113, 1], metallicFactor: 0.4, roughnessFactor: 0.53 },
});
function roof(width, depth, height) {
  const position = new Float32Array([0, height, 0, width, height, 0, width, height, -depth, 0, height, -depth]);
  const normal = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const triangles = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const accessor = (data, type, count, componentType, target, bounds) => {
    const index = kit.accessors.length;
    kit.accessors.push({
      bufferView: append(Buffer.from(data.buffer), target),
      componentType,
      count,
      type,
      ...bounds,
    });
    return index;
  };
  const p = accessor(position, 'VEC3', 4, 5126, 34962, { min: [0, height, -depth], max: [width, height, 0] });
  const n = accessor(normal, 'VEC3', 4, 5126, 34962);
  const i = accessor(triangles, 'SCALAR', 6, 5123, 34963);
  const mesh = kit.meshes.length;
  kit.meshes.push({ name: 'Roof deck', primitives: [{ attributes: { POSITION: p, NORMAL: n }, indices: i, material: roofMaterial }] });
  return add('Roof deck', [0, 0, 0], undefined, mesh);
}
function building(name, [centerX, centerZ], yaw, depth, ground, upper) {
  const width = ground.reduce((length, bay) => length + bays[bay][0], 0);
  if (upper && upper.length * 3 !== width) throw Error('Floor widths differ for ' + name);
  const stories = upper ? 2 : 1;
  const side = Array.from({ length: stories }, (_, floor) =>
    Array.from({ length: depth / 3 }, (_, i) => (floor && i === 1 ? 'square' : 'wall')),
  );
  const back = Array.from({ length: stories }, () => Array(width / 3).fill('wall'));
  const front = upper ? [ground, upper] : [ground];
  root.push(
    add(
      name,
      [centerX - (Math.cos(yaw) * width) / 2, -0.13, centerZ + (Math.sin(yaw) * width) / 2],
      [
        facade(front, [0, 0, 0], 0),
        facade(side, [width, 0, 0], Math.PI / 2),
        facade(back, [width, 0, -depth], Math.PI),
        facade(side, [0, 0, -depth], -Math.PI / 2),
        roof(width, depth, stories * 3 + 0.09),
      ],
      undefined,
      yaw,
    ),
  );
}
function trackside(name, distance, setback, depth, bays, upper) {
  const arc = Math.min(0, Math.max(-45, distance));
  const yaw = arc / 34;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const extra = distance - arc;
  const x = 34 * (1 - c) + extra * s - setback * c;
  const z = 34 * s + extra * c + setback * s;
  building(name, [x, z], yaw + Math.PI / 2, depth, bays, upper);
}

building(
  'North Yard service depot',
  [8.9, 23],
  -Math.PI / 2,
  9,
  ['wall', 'narrow', 'door', 'window', 'loading', 'square', 'wall', 'paired', 'loading', 'window', 'door', 'paired', 'wall', 'square', 'loading', 'wall', 'narrow', 'wall', 'door'],
  ['wall', 'square', 'paired', 'square', 'window', 'window', 'paired', 'square', 'wall', 'window', 'window', 'square', 'square', 'paired', 'wall', 'window', 'window', 'window', 'paired', 'square', 'window', 'wall'],
);
trackside('Track engineering shed', -74, 11.5, 9, ['wall', 'loading', 'door', 'narrow', 'loading', 'wall']);
trackside('Traction workshop', -48, 13.5, 9, ['wall', 'paired', 'loading', 'door', 'loading', 'wall'], ['wall', 'window', 'square', 'window', 'paired', 'window', 'square', 'wall']);
trackside('Parts store', -20, 12.5, 9, ['wall', 'loading', 'square', 'door', 'window', 'wall']);
building('Maintenance annex', [-15, 21], Math.PI / 2, 9, ['wall', 'window', 'loading', 'door', 'narrow', 'wall']);

const groups = new Map();
function collect(index, x, y, z, yaw) {
  const node = nodes[index];
  const [dx, dy, dz] = node.translation;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const pose = [x + c * dx + s * dz, y + dy, z - s * dx + c * dz, yaw];
  if (node.rotation) pose[3] += 2 * Math.atan2(node.rotation[1], node.rotation[3]);
  if (node.mesh === undefined) {
    for (const child of node.children) collect(child, ...pose);
  } else {
    const group = groups.get(node.mesh) ?? [];
    group.push({ pose, name: node.name });
    groups.set(node.mesh, group);
  }
}
for (const index of root) collect(index, 0, 0, 0, 0);
function instanceAccessor(values, count, type) {
  const index = kit.accessors.length;
  const array = new Float32Array(values);
  kit.accessors.push({
    bufferView: append(Buffer.from(array.buffer), 34962),
    componentType: 5126,
    count,
    type,
  });
  return index;
}
const meshes = [...groups].map(([mesh, group]) => {
  const rotation = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const { name, pose } = group[0];
  if (group.length === 1)
    return { name, mesh, translation: pose.slice(0, 3), rotation: rotation(pose[3]) };
  const translations = group.flatMap(({ pose }) => pose.slice(0, 3));
  const rotations = group.flatMap(({ pose }) => rotation(pose[3]));
  return {
    name,
    mesh,
    extensions: {
      EXT_mesh_gpu_instancing: {
        attributes: {
          TRANSLATION: instanceAccessor(translations, group.length, 'VEC3'),
          ROTATION: instanceAccessor(rotations, group.length, 'VEC4'),
        },
      },
    },
  };
});
// Pack the selected pieces. The geometry and transforms share the kit's materials and image atlases.
const unpacked = Buffer.concat(binary);
const oldViews = kit.bufferViews;
const oldAccessors = kit.accessors;
const usedViews = new Map();
const usedAccessors = new Map();
kit.bufferViews = [];
kit.accessors = [];
binary.length = 0;
byteLength = 0;
function packView(index) {
  if (!usedViews.has(index)) {
    const view = oldViews[index];
    const start = view.byteOffset ?? 0;
    usedViews.set(index, append(unpacked.subarray(start, start + view.byteLength), view.target));
  }
  return usedViews.get(index);
}
function packAccessor(index) {
  if (!usedAccessors.has(index)) {
    const accessor = oldAccessors[index];
    usedAccessors.set(index, kit.accessors.length);
    kit.accessors.push({ ...accessor, bufferView: packView(accessor.bufferView) });
  }
  return usedAccessors.get(index);
}
const packAttributes = (attributes) =>
  Object.fromEntries(Object.entries(attributes).map(([name, index]) => [name, packAccessor(index)]));
kit.meshes = meshes.map((node, index) => {
  const mesh = kit.meshes[node.mesh];
  node.mesh = index;
  const instances = node.extensions?.EXT_mesh_gpu_instancing;
  if (instances) instances.attributes = packAttributes(instances.attributes);
  return {
    ...mesh,
    primitives: mesh.primitives.map((primitive) => ({
      ...primitive,
      attributes: packAttributes(primitive.attributes),
      indices: packAccessor(primitive.indices),
    })),
  };
});
for (const image of kit.images) image.bufferView = packView(image.bufferView);
kit.asset.generator = 'Margo Engine North Yard assembly from Poly Haven CC0 modules';
kit.nodes = meshes;
kit.scenes = [{ name: 'North Yard industrial buildings', nodes: meshes.map((_, i) => i) }];
kit.scene = 0;
kit.extensionsUsed = ['EXT_mesh_gpu_instancing'];
kit.extensionsRequired = ['EXT_mesh_gpu_instancing'];
kit.buffers = [{ byteLength }];
const json = Buffer.from(JSON.stringify(kit));
const padded = Buffer.concat([json, Buffer.alloc(align(json.length) - json.length, 0x20)]);
const bin = Buffer.concat([...binary, Buffer.alloc(align(byteLength) - byteLength)]);
const header = Buffer.alloc(12);
header.write('glTF');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(header.length + 16 + padded.length + bin.length, 8);
const chunk = (data, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(data.length);
  h.writeUInt32LE(type, 4);
  return [h, data];
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, Buffer.concat([header, ...chunk(padded, 0x4e4f534a), ...chunk(bin, 0x004e4942)]));
console.log(nodes.length + ' pieces across ' + root.length + ' buildings, drawn in ' + meshes.length + ' mesh groups');
