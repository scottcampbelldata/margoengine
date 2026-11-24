// Reads a real skinned glTF for the weight tests: a skin's joints at their bind positions, and one mesh's vertices,
// triangles and authored weights in that same space. Written for these tests.
import { readFileSync } from 'node:fs';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';

const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 },
  TYPES = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

function accessorReader(doc, bin) {
  return (index) => {
    const a = doc.accessors[index],
      view = doc.bufferViews[a.bufferView],
      Type = TYPES[a.componentType],
      size = SIZES[a.type],
      stride = view.byteStride ?? size * Type.BYTES_PER_ELEMENT,
      start = bin.byteOffset + (view.byteOffset ?? 0) + (a.byteOffset ?? 0),
      data = new DataView(bin.buffer),
      out = new Type(a.count * size),
      read = {
        5120: 'getInt8',
        5121: 'getUint8',
        5122: 'getInt16',
        5123: 'getUint16',
        5125: 'getUint32',
        5126: 'getFloat32',
      }[a.componentType];
    for (let i = 0; i < a.count; i++)
      for (let c = 0; c < size; c++)
        out[i * size + c] = data[read](start + i * stride + c * Type.BYTES_PER_ELEMENT, true);
    return out;
  };
}

/**
 * The first node with a mesh and a skin that `pick` passes, as test data. `parts` lists its primitives: each one's first
 * vertex, vertex count and own indices.
 */
export function realSkin(url, pick = () => true) {
  const chunks = glbChunks(new Uint8Array(readFileSync(url))),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
    bin = chunks.find((c) => c.type === GLB_BIN).data,
    accessor = accessorReader(doc, bin),
    node = doc.nodes.find((n) => n.mesh !== undefined && n.skin !== undefined && pick(n, doc)),
    skin = doc.skins[node.skin],
    bind = accessor(skin.inverseBindMatrices),
    parentOf = new Map();
  doc.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parentOf.set(c, i)));
  const slot = new Map(skin.joints.map((node, i) => [node, i]));
  const joints = skin.joints.map((jointNode, i) => {
    let parent = parentOf.get(jointNode);
    while (parent !== undefined && !slot.has(parent)) parent = parentOf.get(parent);
    return {
      name: `${i}:${doc.nodes[jointNode].name ?? ''}`,
      parent: parent === undefined ? -1 : slot.get(parent),
      position: inversePosition(bind.subarray(i * 16, i * 16 + 16)),
    };
  });
  const positions = [],
    indices = [],
    authored = [],
    parts = [];
  for (const primitive of doc.meshes[node.mesh].primitives) {
    const base = positions.length / 3,
      p = accessor(primitive.attributes.POSITION),
      js = accessor(primitive.attributes.JOINTS_0),
      ws = accessor(primitive.attributes.WEIGHTS_0),
      list = primitive.indices === undefined ? Array.from({ length: p.length / 3 }, (_, i) => i) : accessor(primitive.indices),
      scale = { 5121: 255, 5123: 65535 }[doc.accessors[primitive.attributes.WEIGHTS_0].componentType] ?? 1;
    positions.push(...p);
    parts.push({ first: base, count: p.length / 3, indices: Uint32Array.from(list) });
    for (const i of list) indices.push(base + i);
    for (let v = 0; v < p.length / 3; v++) {
      const row = new Map();
      for (let k = 0; k < 4; k++)
        if (ws[v * 4 + k] > 0) row.set(js[v * 4 + k], (row.get(js[v * 4 + k]) ?? 0) + ws[v * 4 + k] / scale);
      authored.push(row);
    }
  }
  return {
    joints,
    mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
    authored,
    parts,
  };
}

/** The translation of the inverse of an affine column-major matrix. */
function inversePosition(m) {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]],
    c = [
      a[4] * a[8] - a[5] * a[7],
      a[2] * a[7] - a[1] * a[8],
      a[1] * a[5] - a[2] * a[4],
      a[5] * a[6] - a[3] * a[8],
      a[0] * a[8] - a[2] * a[6],
      a[2] * a[3] - a[0] * a[5],
      a[3] * a[7] - a[4] * a[6],
      a[1] * a[6] - a[0] * a[7],
      a[0] * a[4] - a[1] * a[3],
    ],
    det = a[0] * c[0] + a[3] * c[1] + a[6] * c[2],
    t = [m[12], m[13], m[14]];
  return [0, 1, 2].map((r) => -(c[r] * t[0] + c[3 + r] * t[1] + c[6 + r] * t[2]) / det);
}

/**
 * Across vertices: `gap`, the mean of half the L1 gap between two weight rows; `same`, the share with the same strongest
 * joint; `near`, the share whose strongest joints are the same or parent and child (with `joints`).
 */
export function compare(authored, weights, joints = []) {
  const n = authored.length,
    bones = weights.boneCount;
  let gap = 0,
    same = 0,
    near = 0;
  for (let v = 0; v < n; v++) {
    const row = authored[v];
    let sum = 0,
      best = -1,
      bestWeight = 0,
      theirs = -1,
      theirWeight = 0;
    for (const [joint, w] of row)
      if (w > theirWeight) {
        theirs = joint;
        theirWeight = w;
      }
    for (let b = 0; b < bones; b++) {
      const w = weights.values[v * bones + b];
      if (w > bestWeight) {
        best = b;
        bestWeight = w;
      }
      sum += Math.abs(w - (row.get(b) ?? 0));
    }
    gap += sum / 2;
    if (best === theirs) same++;
    if (best === theirs || joints[best]?.parent === theirs || joints[theirs]?.parent === best) near++;
  }
  return { gap: gap / n, same: same / n, near: near / n };
}

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};

/** A glTF node's local matrix, column-major. */
function localMatrix(node) {
  if (node.matrix) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1],
    [sx, sy, sz] = node.scale ?? [1, 1, 1],
    [tx, ty, tz] = node.translation ?? [0, 0, 0];
  return [
    (1 - 2 * (y * y + z * z)) * sx,
    2 * (x * y + z * w) * sx,
    2 * (x * z - y * w) * sx,
    0,
    2 * (x * y - z * w) * sy,
    (1 - 2 * (x * x + z * z)) * sy,
    2 * (y * z + x * w) * sy,
    0,
    2 * (x * z + y * w) * sz,
    2 * (y * z - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

/**
 * Every mesh of a real character file as one bare mesh, the way a fit that sees only triangles gets it, and the authored
 * skeleton kept apart to mark the fit: `bones` holds each named node's bind position (its world position when no skin
 * uses it) and `human` the VRM humanoid map, bone to node name. `skip(node)` leaves a node's mesh out. A skinned mesh
 * sits in its bind space, which is the world for the files read here.
 */
export function realFigure(url, skip = () => false) {
  const chunks = glbChunks(new Uint8Array(readFileSync(url))),
    doc = JSON.parse(new TextDecoder().decode(chunks.find((c) => c.type === GLB_JSON).data)),
    accessor = accessorReader(doc, chunks.find((c) => c.type === GLB_BIN).data),
    world = new Map(),
    walk = (index, parent) => {
      const matrix = multiply(parent, localMatrix(doc.nodes[index]));
      world.set(index, matrix);
      for (const child of doc.nodes[index].children ?? []) walk(child, matrix);
    };
  for (const root of doc.scenes[doc.scene ?? 0].nodes) walk(root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const positions = [],
    indices = [];
  doc.nodes.forEach((node, i) => {
    if (node.mesh === undefined || skip(node) || !world.has(i)) return;
    const m = node.skin === undefined ? world.get(i) : null;
    for (const primitive of doc.meshes[node.mesh].primitives) {
      const base = positions.length / 3,
        p = accessor(primitive.attributes.POSITION);
      for (let k = 0; k < p.length; k += 3) {
        const [x, y, z] = [p[k], p[k + 1], p[k + 2]];
        if (m)
          positions.push(
            m[0] * x + m[4] * y + m[8] * z + m[12],
            m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14],
          );
        else positions.push(x, y, z);
      }
      const list =
        primitive.indices === undefined ? Array.from({ length: p.length / 3 }, (_, k) => k) : accessor(primitive.indices);
      for (const k of list) indices.push(base + k);
    }
  });
  const bones = {};
  for (const [i, m] of world) if (doc.nodes[i].name) bones[doc.nodes[i].name] = [m[12], m[13], m[14]];
  for (const skin of doc.skins ?? []) {
    if (skin.inverseBindMatrices === undefined) continue;
    const bind = accessor(skin.inverseBindMatrices);
    skin.joints.forEach((node, k) => {
      bones[doc.nodes[node].name] = inversePosition(bind.subarray(k * 16, k * 16 + 16));
    });
  }
  const human = {};
  for (const [bone, { node }] of Object.entries(doc.extensions?.VRMC_vrm?.humanoid?.humanBones ?? {}))
    human[bone] = doc.nodes[node].name;
  return {
    mesh: { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) },
    bones,
    human,
  };
}
