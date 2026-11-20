// VRM 1.0 first person: the `auto` split (VRMC_vrm 1.0 firstPerson.md) on the VRM Consortium's Twist sample, Seed-san
// and DWANGO's Alicia, and on built files that reach every glTF layout the split reads. The checks read the files
// with their own small glTF reader, so a split that loses, doubles or misfiles a triangle fails here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GLB_BIN, GLB_JSON, GLB_MAGIC, glbChunks } from '../../shared/glb.js';
import {
  FIRST_PERSON_ONLY_LAYER,
  THIRD_PERSON_ONLY_LAYER,
  addVRMFirstPerson,
  splitVRMFirstPerson,
} from '../dist/vrm-first-person.js';
import { checkVRM, readVRM } from '../dist/vrm.js';
import { convertVRM0Bytes } from '../dist/vrm0.js';
import { compressDraco } from '../../exporters/dist/draco.js';
import { compressMeshopt } from '../../exporters/dist/meshopt.js';
import { decodeNativeDraco } from '../../decoders/dist/draco-native-codec.js';

const file = (name) => new Uint8Array(readFileSync(new URL(`../../../examples/assets/vrm/${name}`, import.meta.url)));
const json = (bytes) => JSON.parse(new TextDecoder().decode(glbChunks(bytes)[0].data));
const binOf = (bytes) => glbChunks(bytes).find((c) => c.type === GLB_BIN)?.data;

// ---- An independent glTF reader for the checks ----
const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 },
  WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
function viewBytes(doc, bin, index) {
  const view = doc.bufferViews[index];
  assert.equal(view.extensions, undefined, 'the check reader reads plain buffer views');
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}
function number(bytes, at, type) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    5120: () => v.getInt8(at),
    5121: () => v.getUint8(at),
    5122: () => v.getInt16(at, true),
    5123: () => v.getUint16(at, true),
    5125: () => v.getUint32(at, true),
    5126: () => v.getFloat32(at, true),
  }[type]();
}
/** Every element of accessor `index` as its own bytes. */
function elements(doc, bin, index) {
  const a = doc.accessors[index],
    element = SIZE[a.componentType] * WIDTH[a.type],
    out = Array.from({ length: a.count }, () => new Uint8Array(element));
  if (a.bufferView !== undefined) {
    const bytes = viewBytes(doc, bin, a.bufferView),
      stride = doc.bufferViews[a.bufferView].byteStride ?? element;
    for (let i = 0; i < a.count; i++)
      out[i].set(bytes.subarray((a.byteOffset ?? 0) + i * stride, (a.byteOffset ?? 0) + i * stride + element));
  }
  if (a.sparse) {
    const keys = viewBytes(doc, bin, a.sparse.indices.bufferView).subarray(a.sparse.indices.byteOffset ?? 0),
      values = viewBytes(doc, bin, a.sparse.values.bufferView).subarray(a.sparse.values.byteOffset ?? 0);
    for (let i = 0; i < a.sparse.count; i++)
      out[number(keys, i * SIZE[a.sparse.indices.componentType], a.sparse.indices.componentType)].set(
        values.subarray(i * element, (i + 1) * element),
      );
  }
  return out;
}
const values = (doc, bin, index) => {
  const a = doc.accessors[index];
  return elements(doc, bin, index).map((e) =>
    Array.from({ length: WIDTH[a.type] }, (_, c) => number(e, c * SIZE[a.componentType], a.componentType)),
  );
};
/** The points, lines or triangles of a primitive as vertex lists (glTF 2.0 section 3.7.2.1). */
function shapes(doc, bin, p) {
  const count = doc.accessors[p.attributes.POSITION].count,
    idx =
      p.indices === undefined
        ? Array.from({ length: count }, (_, i) => i)
        : values(doc, bin, p.indices).map((v) => v[0]),
    mode = p.mode ?? 4,
    out = [];
  if (mode === 0) for (const i of idx) out.push([i]);
  if (mode === 1) for (let i = 0; i + 1 < idx.length; i += 2) out.push([idx[i], idx[i + 1]]);
  if (mode === 2 || mode === 3) {
    for (let i = 0; i + 1 < idx.length; i++) out.push([idx[i], idx[i + 1]]);
    if (mode === 2 && idx.length > 2) out.push([idx.at(-1), idx[0]]);
  }
  if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) out.push([idx[i], idx[i + 1], idx[i + 2]]);
  if (mode === 5)
    for (let i = 0; i + 2 < idx.length; i++)
      out.push(i % 2 ? [idx[i + 1], idx[i], idx[i + 2]] : [idx[i], idx[i + 1], idx[i + 2]]);
  // A triangle is the same whichever vertex it starts from (winding kept): start each at its smallest vertex key.
  if (mode === 6) for (let i = 0; i + 2 < idx.length; i++) out.push([idx[i + 1], idx[i + 2], idx[0]]);
  return out;
}
/** Per vertex: every attribute's and morph target's bytes, as one key; and whether it is weighted to the head set. */
function vertices(doc, bin, p, headJoints, threshold = 0) {
  const semantics = Object.keys(p.attributes).sort(),
    columns = semantics.map((s) => elements(doc, bin, p.attributes[s])),
    targets = (p.targets ?? []).flatMap((t) =>
      Object.keys(t)
        .sort()
        .map((s) => elements(doc, bin, t[s])),
    ),
    count = columns[0].length,
    keys = [],
    head = new Uint8Array(count);
  for (let v = 0; v < count; v++)
    keys.push([...columns, ...targets].map((c) => Buffer.from(c[v]).toString('hex')).join('|'));
  for (let set = 0; p.attributes[`JOINTS_${set}`] !== undefined; set++) {
    const joints = values(doc, bin, p.attributes[`JOINTS_${set}`]),
      wa = doc.accessors[p.attributes[`WEIGHTS_${set}`]],
      norm = { 5121: 255, 5123: 65535 }[wa.componentType] ?? 1,
      weights = values(doc, bin, p.attributes[`WEIGHTS_${set}`]);
    for (let v = 0; v < count; v++)
      for (let c = 0; c < 4; c++) if (headJoints.has(joints[v][c]) && weights[v][c] / norm > threshold) head[v] = 1;
  }
  return { keys, head };
}
function headSet(doc) {
  const head = doc.extensions.VRMC_vrm.humanoid.humanBones.head.node,
    set = new Set(),
    stack = [head];
  while (stack.length) {
    const n = stack.pop();
    set.add(n);
    stack.push(...(doc.nodes[n].children ?? []));
  }
  return set;
}
const typeOf = (doc, node) => doc.extensions.VRMC_vrm.firstPerson?.meshAnnotations?.find((a) => a.node === node)?.type;

/**
 * Checks the split of skinned `auto` node `n`: the rest and the head part hold exactly the original shapes (by vertex
 * bytes, material and kind), none twice; every head shape has a head vertex and no rest shape has one; and the parts
 * hold the original used vertices plus the seam.
 */
function checkSplit(before, after, n, threshold = 0) {
  const a = json(before),
    b = json(after),
    abin = binOf(before),
    bbin = binOf(after),
    node = b.nodes[n],
    child = node.children?.find((c) => c >= a.nodes.length && b.nodes[c].mesh !== undefined);
  assert.ok(child !== undefined, `node ${n} has a head part`);
  assert.equal(typeOf(b, n), 'both');
  assert.equal(typeOf(b, child), 'thirdPersonOnly');
  assert.equal(b.nodes[child].skin, node.skin);
  assert.equal(
    b.nodes[child].matrix ?? b.nodes[child].translation ?? b.nodes[child].rotation ?? b.nodes[child].scale,
    undefined,
  );
  const set = headSet(a),
    joints = new Set(a.skins[a.nodes[n].skin].joints.flatMap((j, i) => (set.has(j) ? [i] : []))),
    expected = new Map(),
    keyOf = (doc, bin, p, vs, shape) => {
      const keys = shape.map((v) => vs.keys[v]);
      if (keys.length === 3) {
        const start = keys.indexOf([...keys].sort()[0]);
        keys.push(...keys.splice(0, start));
      }
      return `${p.material}/${keys.length}/${keys.join(',')}`;
    };
  let used = 0,
    seam = 0;
  for (const p of a.meshes[a.nodes[n].mesh].primitives) {
    const vs = vertices(a, abin, p, joints, threshold),
      list = shapes(a, abin, p),
      inHead = new Set(),
      inRest = new Set();
    for (const shape of list) {
      const key = keyOf(a, abin, p, vs, shape);
      expected.set(key, (expected.get(key) ?? 0) + 1);
      (shape.some((v) => vs.head[v]) ? inHead : inRest).add(shape);
    }
    const h = new Set([...inHead].flat()),
      r = new Set([...inRest].flat());
    used += new Set([...h, ...r]).size;
    for (const v of h) if (r.has(v)) seam++;
  }
  let vertexCount = 0;
  const seen = new Set();
  for (const [mesh, head] of [
    [b.nodes[n].mesh, false],
    [b.nodes[child].mesh, true],
  ])
    for (const p of b.meshes[mesh].primitives) {
      const vs = vertices(b, bbin, p, joints, threshold),
        list = shapes(b, bbin, p),
        usedHere = new Set(list.flat());
      if (p.attributes.POSITION >= a.accessors.length) {
        assert.equal(
          b.accessors[p.attributes.POSITION].count,
          usedHere.size,
          'a compact part holds only the vertices it uses',
        );
        const pos = values(b, bbin, p.attributes.POSITION);
        assert.deepEqual(
          b.accessors[p.attributes.POSITION].min,
          [0, 1, 2].map((c) => Math.min(...pos.map((x) => x[c]))),
        );
        assert.deepEqual(
          b.accessors[p.attributes.POSITION].max,
          [0, 1, 2].map((c) => Math.max(...pos.map((x) => x[c]))),
        );
      }
      if (!seen.has(p.attributes.POSITION)) vertexCount += usedHere.size;
      seen.add(p.attributes.POSITION);
      for (const shape of list) {
        assert.equal(
          shape.some((v) => vs.head[v]),
          head,
          `a ${head ? 'head' : 'rest'} shape of node ${n} is misfiled`,
        );
        const key = keyOf(b, bbin, p, vs, shape),
          left = expected.get(key);
        assert.ok(left, `node ${n}: a shape that was not in the original, or one taken twice`);
        if (left === 1) expected.delete(key);
        else expected.set(key, left - 1);
      }
    }
  assert.equal(expected.size, 0, `node ${n}: ${expected.size} original shapes are missing`);
  assert.equal(vertexCount, used + seam, 'the parts hold the used vertices plus the seam');
  return child;
}

test('the Twist sample: every auto node resolves, the Body splits exactly, and a second split changes nothing', async () => {
  const before = file('VRM1_Constraint_Twist_Sample.vrm');
  assert.deepEqual(
    json(before).extensions.VRMC_vrm.firstPerson.meshAnnotations.map((a) => a.type),
    ['auto', 'auto', 'auto'],
  );
  const after = await splitVRMFirstPerson(before),
    doc = json(after);
  assert.ok(doc.extensions.VRMC_vrm.firstPerson.meshAnnotations.every((a) => a.type !== 'auto'));
  assert.deepEqual(checkVRM(readVRM(doc), doc), []);
  // Body holds the neck; Face and Hair are weighted to the head everywhere.
  assert.equal(typeOf(doc, 1), 'thirdPersonOnly');
  assert.equal(typeOf(doc, 2), 'thirdPersonOnly');
  checkSplit(before, after, 0);
  // Face's morph targets and its mesh stay as they were.
  assert.deepEqual(doc.meshes[1], json(before).meshes[1]);
  // The original BIN is a prefix of the new one: nothing moved.
  assert.deepEqual(binOf(after).subarray(0, binOf(before).length), binOf(before));
  assert.equal(await splitVRMFirstPerson(after), after);
});

test('Seed-san: explicit annotations come back byte for byte', async () => {
  const before = file('Seed-san.vrm');
  assert.equal(await splitVRMFirstPerson(before), before);
});

test('Alicia, converted from VRM 0.x: every Auto mesh resolves by its weights, geometry untouched', async () => {
  const before = convertVRM0Bytes(file('AliciaSolid_vrm-0.51.vrm')),
    after = await splitVRMFirstPerson(before),
    doc = json(after),
    bin = binOf(after),
    set = headSet(doc);
  assert.deepEqual(checkVRM(readVRM(doc), doc), []);
  // Alicia's head meshes are separate: none is mixed, so none splits and the BIN is the same.
  assert.equal(doc.nodes.length, json(before).nodes.length);
  assert.deepEqual(bin, binOf(before));
  const types = {};
  for (const { node, type } of doc.extensions.VRMC_vrm.firstPerson.meshAnnotations) {
    const n = doc.nodes[node],
      joints = new Set(doc.skins[n.skin].joints.flatMap((j, i) => (set.has(j) ? [i] : []))),
      heads = doc.meshes[n.mesh].primitives
        .map((p) => {
          const vs = vertices(doc, bin, p, joints);
          return shapes(doc, bin, p).map((shape) => shape.some((v) => vs.head[v]));
        })
        .flat();
    assert.equal(type, heads.every(Boolean) ? 'thirdPersonOnly' : 'both', n.name);
    if (type === 'both') assert.ok(!heads.some(Boolean), n.name);
    types[n.name] = type;
  }
  assert.equal(types.face, 'thirdPersonOnly');
  assert.equal(types.body_top, 'both');
});

test('threshold keeps vertices with a small head weight out of the head', async () => {
  const before = built({ weightOnHead: 0.25 }),
    loose = json(await splitVRMFirstPerson(before)),
    strict = json(await splitVRMFirstPerson(before, { threshold: 0.5 }));
  assert.equal(loose.nodes.length, json(before).nodes.length + 1);
  assert.equal(strict.nodes.length, json(before).nodes.length, 'no vertex passes 0.5: nothing splits');
  assert.equal(typeOf(strict, MESH), 'both');
  checkSplit(before, await splitVRMFirstPerson(before, { threshold: 0.2 }), MESH, 0.2);
  await assert.rejects(splitVRMFirstPerson(before, { threshold: 1 }), RangeError);
});

// ---- Built files ----
// Nodes: 0 hips > 1 spine > 2 head > 3 hat (unskinned), 4 the skinned mesh, 5 a second user of mesh 0 when asked.
const MESH = 4;
const BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
];
class Bin {
  parts = [];
  length = 0;
  doc = { asset: { version: '2.0' }, buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [] };
  view(bytes, extra = {}) {
    this.doc.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength, ...extra });
    this.parts.push(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const pad = (4 - (bytes.byteLength % 4)) % 4;
    if (pad) this.parts.push(new Uint8Array(pad));
    this.length += bytes.byteLength + pad;
    return this.doc.bufferViews.length - 1;
  }
  accessor(array, type, componentType, extra = {}) {
    const bufferView = this.view(array);
    this.doc.accessors.push({ bufferView, componentType, count: array.length / WIDTH[type], type, ...extra });
    return this.doc.accessors.length - 1;
  }
  glb(doc) {
    doc.buffers[0].byteLength = this.length;
    const bin = new Uint8Array(this.length);
    let at = 0;
    for (const part of this.parts) {
      bin.set(part, at);
      at += part.length;
    }
    const text = new TextEncoder().encode(JSON.stringify(doc)),
      padded = (text.length + 3) & ~3,
      total = 20 + padded + 8 + bin.length,
      out = new Uint8Array(total),
      view = new DataView(out.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, padded, true);
    view.setUint32(16, GLB_JSON, true);
    out.set(text, 20);
    out.fill(32, 20 + text.length, 20 + padded);
    view.setUint32(20 + padded, bin.length, true);
    view.setUint32(24 + padded, GLB_BIN, true);
    out.set(bin, 28 + padded);
    return out;
  }
}
/**
 * A three-row ribbon, rows at y 0, 1 and 2, two vertices a row; rows 0 and 1 weighted to the spine, row 2 to the head
 * (or `weightOnHead` of it). As triangles: two rest triangles below, two head triangles above, row 1 the seam.
 */
function built(options = {}) {
  const {
    mode = 4,
    indexType = 5125,
    indexed = true,
    joints1 = false,
    sparse = false,
    twoUsers = false,
    weightOnHead = 1,
    morph = false,
    firstPerson = true,
    extras = {},
  } = options;
  const b = new Bin(),
    positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 2, 0, 1, 2, 0]),
    normals = new Float32Array(18).map((_, i) => (i % 3 === 2 ? 1 : 0)),
    joints = new Uint8Array(24),
    weights = new Float32Array(24);
  for (let v = 0; v < 6; v++) {
    joints[v * 4] = 1;
    weights[v * 4] = 1;
    if (v >= 4) {
      joints[v * 4 + 1] = 2;
      weights[v * 4] = 1 - weightOnHead;
      weights[v * 4 + 1] = weightOnHead;
    }
  }
  // Triangles in each mode, all covering the same two quads.
  const lists = {
    4: [0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5],
    5: [0, 1, 2, 3, 4, 5],
    6: [2, 0, 1, 3, 5, 4],
    1: [0, 2, 1, 3, 2, 4, 3, 5],
    3: [0, 2, 4],
    2: [0, 2, 4, 5],
    0: [0, 2, 4, 5],
  };
  const order = lists[mode],
    primitive = { attributes: {}, mode, material: 0 };
  // Without indices the vertices themselves are in drawing order.
  const use = indexed ? null : order;
  const pick = (array, width) =>
    use ? array.constructor.from(use.flatMap((v) => Array.from(array.subarray(v * width, v * width + width)))) : array;
  primitive.attributes.POSITION = b.accessor(pick(positions, 3), 'VEC3', 5126, {
    min: [0, 0, 0],
    max: [1, 2, 0],
  });
  primitive.attributes.NORMAL = b.accessor(pick(normals, 3), 'VEC3', 5126);
  if (sparse) {
    // Joints as a sparse accessor over zeros: only rows 0 and 2 are stored.
    const keys = new Uint16Array([0, 1, 2, 3, 4, 5]);
    b.doc.accessors.push({
      componentType: 5121,
      count: 6,
      type: 'VEC4',
      sparse: {
        count: 6,
        indices: { bufferView: b.view(keys), componentType: 5123 },
        values: { bufferView: b.view(joints) },
      },
    });
    primitive.attributes.JOINTS_0 = b.doc.accessors.length - 1;
  } else if (joints1) {
    // The head influence lives in the second set.
    const first = new Uint8Array(24),
      second = new Uint8Array(24),
      w0 = new Float32Array(24),
      w1 = new Float32Array(24);
    for (let v = 0; v < 6; v++) {
      first[v * 4] = 1;
      w0[v * 4] = v >= 4 ? 1 - weightOnHead : 1;
      second[v * 4] = 2;
      w1[v * 4] = v >= 4 ? weightOnHead : 0;
    }
    primitive.attributes.JOINTS_0 = b.accessor(pick(first, 4), 'VEC4', 5121);
    primitive.attributes.WEIGHTS_0 = b.accessor(pick(w0, 4), 'VEC4', 5126);
    primitive.attributes.JOINTS_1 = b.accessor(pick(second, 4), 'VEC4', 5121);
    primitive.attributes.WEIGHTS_1 = b.accessor(pick(w1, 4), 'VEC4', 5126);
  }
  if (!joints1) {
    primitive.attributes.JOINTS_0 ??= b.accessor(pick(joints, 4), 'VEC4', 5121);
    // Normalized unsigned bytes: 255 is a weight of 1.
    primitive.attributes.WEIGHTS_0 = b.accessor(
      pick(
        Uint8Array.from(weights, (w) => Math.round(w * 255)),
        4,
      ),
      'VEC4',
      5121,
      { normalized: true },
    );
  }
  if (indexed) {
    const Index = { 5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array }[indexType];
    primitive.indices = b.accessor(Index.from(order), 'SCALAR', indexType);
  }
  if (morph) {
    const delta = new Float32Array(18).map((_, i) => (i % 3 === 0 ? 0.5 : 0));
    primitive.targets = [{ POSITION: b.accessor(pick(delta, 3), 'VEC3', 5126, { min: [0, 0, 0], max: [0.5, 0, 0] }) }];
  }
  const hat = {
    attributes: {
      POSITION: b.accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3', 5126, {
        min: [0, 0, 0],
        max: [1, 1, 0],
      }),
    },
  };
  const nodes = [
    { name: 'hips', children: [1] },
    { name: 'spine', children: [2], translation: [0, 1, 0] },
    { name: 'head', children: [3], translation: [0, 1, 0] },
    { name: 'hat', mesh: 1 },
    { name: 'ribbon', mesh: 0, skin: 0, ...(morph ? { weights: [0.25] } : {}) },
  ];
  if (twoUsers) nodes.push({ name: 'ribbon again', mesh: 0, skin: 0 });
  const bones = Object.fromEntries(BONES.map((bone) => [bone, { node: { hips: 0, spine: 1, head: 2 }[bone] ?? 0 }]));
  const doc = {
    ...b.doc,
    extensionsUsed: ['VRMC_vrm'],
    nodes,
    scenes: [{ nodes: [0, 4, ...(twoUsers ? [5] : [])] }],
    scene: 0,
    materials: [{}],
    meshes: [
      {
        name: 'ribbon',
        primitives: [primitive],
        ...(morph ? { weights: [0], extras: { targetNames: ['wide'] } } : {}),
      },
      { primitives: [hat] },
    ],
    skins: [{ joints: [0, 1, 2], inverseBindMatrices: undefined }],
    extensions: {
      VRMC_vrm: {
        specVersion: '1.0',
        meta: { name: 'ribbon', authors: ['tests'], licenseUrl: 'https://vrm.dev/licenses/1.0/' },
        humanoid: { humanBones: bones },
        ...(firstPerson ? { firstPerson: { meshAnnotations: [] } } : {}),
      },
    },
    ...extras,
  };
  delete doc.skins[0].inverseBindMatrices;
  if (morph) {
    doc.extensions.VRMC_vrm.expressions = {
      preset: { aa: { morphTargetBinds: [{ node: MESH, index: 0, weight: 1 }] } },
    };
    const time = b.accessor(new Float32Array([0, 1]), 'SCALAR', 5126, { min: [0], max: [1] }),
      output = b.accessor(new Float32Array([0, 1]), 'SCALAR', 5126);
    doc.accessors = b.doc.accessors;
    doc.bufferViews = b.doc.bufferViews;
    doc.animations = [
      {
        samplers: [{ input: time, output }],
        channels: [
          { sampler: 0, target: { node: MESH, path: 'weights' } },
          {
            sampler: 0,
            target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: `/nodes/${MESH}/weights` } } },
          },
          {
            sampler: 0,
            target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/meshes/0/weights' } } },
          },
        ],
      },
    ];
  }
  return b.glb(doc);
}

for (const [label, options] of [
  ['triangles, u32 indices', {}],
  ['triangles, u16 indices', { indexType: 5123 }],
  ['triangles, u8 indices', { indexType: 5121 }],
  ['triangles, no indices', { indexed: false }],
  ['a triangle strip', { mode: 5 }],
  ['a triangle fan', { mode: 6 }],
  ['lines', { mode: 1 }],
  ['a line strip', { mode: 3 }],
  ['a line loop', { mode: 2 }],
  ['points', { mode: 0 }],
  ['the head weight in JOINTS_1', { joints1: true }],
  ['sparse joints', { sparse: true }],
  ['morph targets', { morph: true }],
  ['no firstPerson at all', { firstPerson: false }],
]) {
  test(`built file, ${label}: the split is exact`, async () => {
    const before = built(options),
      after = await splitVRMFirstPerson(before),
      doc = json(after);
    checkSplit(before, after, MESH);
    // The unskinned hat sits under the head bone.
    assert.equal(typeOf(doc, 3), 'thirdPersonOnly');
    assert.equal(await splitVRMFirstPerson(after), after);
  });
}

test('built file, a mesh on two nodes: each node gets its head part and the shared mesh is left for neither', async () => {
  const before = built({ twoUsers: true }),
    after = await splitVRMFirstPerson(before),
    doc = json(after);
  const a = checkSplit(before, after, MESH),
    b = checkSplit(before, after, 5);
  assert.equal(doc.nodes[a].mesh, doc.nodes[b].mesh, 'one head mesh for one mesh and skin');
  assert.equal(doc.nodes[MESH].mesh, doc.nodes[5].mesh);
  assert.notEqual(doc.nodes[MESH].mesh, 0);
});

test('built file, morph targets: expression binds and weight channels get twins on the head part', async () => {
  const before = built({ morph: true }),
    doc = json(await splitVRMFirstPerson(before)),
    child = doc.nodes[MESH].children.at(-1),
    head = doc.nodes[child].mesh;
  assert.deepEqual(doc.extensions.VRMC_vrm.expressions.preset.aa.morphTargetBinds, [
    { node: MESH, index: 0, weight: 1 },
    { node: child, index: 0, weight: 1 },
  ]);
  assert.deepEqual(doc.nodes[child].weights, [0.25]);
  assert.deepEqual(doc.meshes[head].weights, [0]);
  assert.deepEqual(doc.meshes[head].extras, { targetNames: ['wide'] });
  const targets = doc.animations[0].channels.map(
    (c) => c.target.node ?? c.target.extensions.KHR_animation_pointer.pointer,
  );
  assert.deepEqual(targets, [
    MESH,
    `/nodes/${MESH}/weights`,
    '/meshes/0/weights',
    child,
    `/nodes/${child}/weights`,
    `/meshes/${head}/weights`,
  ]);
  assert.deepEqual(
    checkVRM(readVRM(doc), doc).filter((issue) => !/bone|meta/.test(issue)),
    [],
  );
});

test('built file: a mesh all on the head is thirdPersonOnly, one with no head weight is both, geometry untouched', async () => {
  for (const [weight, rows, type] of [
    [1, 'all', 'thirdPersonOnly'],
    [0, 'none', 'both'],
  ]) {
    const before = built({ weightOnHead: weight, mode: 0 }),
      doc = json(before);
    // Points on row 2 only, or none on it.
    void rows;
    const after = await splitVRMFirstPerson(weight ? onlyHeadPoints(before) : before),
      out = json(after);
    assert.equal(typeOf(out, MESH), type);
    assert.equal(out.nodes.length, doc.nodes.length);
    assert.deepEqual(binOf(after), binOf(weight ? onlyHeadPoints(before) : before));
  }
});
/** The built file with its points cut to row 2, all on the head. */
function onlyHeadPoints(glb) {
  const doc = json(glb),
    bin = new Uint8Array(binOf(glb)),
    p = doc.meshes[0].primitives[0],
    a = doc.accessors[p.indices],
    view = doc.bufferViews[a.bufferView];
  new DataView(bin.buffer).setUint32(view.byteOffset, 4, true);
  new DataView(bin.buffer).setUint32(view.byteOffset + 4, 5, true);
  a.count = 2;
  const b = new Bin();
  b.parts = [bin];
  b.length = bin.length;
  return b.glb(doc);
}

test('built file, Draco: the split decodes the stream and writes plain parts', async () => {
  const before = built(),
    { glb: compressed, compressed: count } = await compressDraco(before);
  assert.equal(count, 2, 'the ribbon and the hat are Draco streams');
  const { instance } = await WebAssembly.instantiate(
    readFileSync(new URL('../../decoders/dist/draco-native.wasm', import.meta.url)),
  );
  const draco = { decode: async (data, request) => decodeNativeDraco(instance.exports, data, request) };
  const after = await splitVRMFirstPerson(compressed, { draco }),
    doc = json(after),
    plain = json(await splitVRMFirstPerson(before)),
    child = doc.nodes[MESH].children.at(-1);
  for (const [mesh, other] of [
    [doc.nodes[MESH].mesh, plain.nodes[MESH].mesh],
    [doc.nodes[child].mesh, plain.nodes[plain.nodes[MESH].children.at(-1)].mesh],
  ]) {
    const p = doc.meshes[mesh].primitives[0],
      q = plain.meshes[other].primitives[0];
    assert.equal(p.extensions, undefined, 'the parts are plain');
    // Positions were quantized by Draco; the shape count, skin and weights are the plain split's.
    assert.equal(
      shapes(doc, binOf(after), p).length,
      shapes(plain, binOf(await splitVRMFirstPerson(before)), q).length,
    );
    assert.deepEqual(
      values(doc, binOf(after), p.attributes.JOINTS_0).sort(),
      values(plain, binOf(await splitVRMFirstPerson(before)), q.attributes.JOINTS_0).sort(),
    );
  }
  assert.equal(typeOf(doc, 3), 'thirdPersonOnly');
  // The hat, a whole part, keeps its stream.
  assert.ok(doc.meshes[1].primitives[0].extensions.KHR_draco_mesh_compression);
  // Node has no Web Worker: the default decoder decodes in this thread (GAP-FILM-DRACO-NODE), to the same parts.
  assert.deepEqual(await splitVRMFirstPerson(compressed), after, 'the default decoder in Node gives the same file');
});

test('built file, meshopt and quantized vertices: the split decodes the streams and writes plain parts', async () => {
  const before = built(),
    { glb: compressed, compressed: count } = await compressMeshopt(before);
  assert.ok(count > 0);
  const after = await splitVRMFirstPerson(compressed),
    doc = json(after),
    child = doc.nodes[MESH].children.at(-1),
    head = doc.meshes[doc.nodes[child].mesh].primitives[0],
    rest = doc.meshes[doc.nodes[MESH].mesh].primitives[0],
    bin = binOf(after);
  for (const p of [head, rest])
    for (const index of Object.values(p.attributes))
      assert.equal(doc.bufferViews[doc.accessors[index].bufferView].extensions, undefined);
  assert.equal(shapes(doc, bin, head).length, 2);
  assert.equal(shapes(doc, bin, rest).length, 2);
  // Quantized positions keep their integer type, and every vertex element is 4-byte aligned.
  for (const index of Object.values(head.attributes)) {
    const view = doc.bufferViews[doc.accessors[index].bufferView];
    assert.equal(
      (view.byteStride ?? SIZE[doc.accessors[index].componentType] * WIDTH[doc.accessors[index].type]) % 4,
      0,
    );
  }
  assert.deepEqual(
    checkVRM(readVRM(doc), doc).filter((issue) => !/bone|meta/.test(issue)),
    [],
  );
});

test('the split refuses what it cannot read, with the reason', async () => {
  await assert.rejects(splitVRMFirstPerson(new Uint8Array(8)), TypeError);
  const doc = json(built()),
    bad = (edit) => {
      const copy = structuredClone(doc);
      edit(copy);
      const b = new Bin();
      b.parts = [binOf(built())];
      b.length = b.parts[0].length;
      return b.glb(copy);
    };
  await assert.rejects(
    splitVRMFirstPerson(bad((d) => (d.extensions.VRMC_vrm.firstPerson.meshAnnotations = [{ node: 99, type: 'both' }]))),
    { name: 'MargoError', code: 'failed' },
  );
  await assert.rejects(
    splitVRMFirstPerson(bad((d) => (d.extensions.VRMC_vrm.firstPerson.meshAnnotations = [{ node: 4, type: 'Auto' }]))),
    /not auto, both/,
  );
  await assert.rejects(splitVRMFirstPerson(bad((d) => (d.buffers[0].uri = 'ribbon.bin'))), { code: 'unsupported' });
  await assert.rejects(
    splitVRMFirstPerson(bad((d) => (d.accessors[d.meshes[0].primitives[0].indices].count = 99))),
    /runs past/,
  );
  const aborted = AbortSignal.abort(new Error('stop'));
  await assert.rejects(splitVRMFirstPerson(built(), { signal: aborted }), /stop/);
});

// ---- addVRMFirstPerson on a stand-in model: the masks it sets, the cameras and dispose ----
function standIn(glbDoc) {
  const nodes = glbDoc.nodes.map((_, i) => ({
      id: i,
      matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1]),
    })),
    camera = { name: 'engine camera' };
  return { asset: { doc: glbDoc }, nodes, root: { engine: { camera } }, camera };
}
const registry = () => globalThis[Symbol.for('margoengine.layers')];

test('addVRMFirstPerson sets each annotated node mask, the camera masks, and dispose puts them back', async () => {
  const doc = json(await splitVRMFirstPerson(built())),
    model = standIn(doc),
    eye = { name: 'eye' },
    child = doc.nodes[MESH].children.at(-1);
  doc.extensions.VRMC_vrm.lookAt = { offsetFromHeadBone: [0, 0.1, 0.05] };
  registry()?.masks.delete(model.nodes[3]);
  const fp = addVRMFirstPerson(model, { firstPersonCameras: [eye] });
  assert.equal(fp.firstPersonOnlyLayer, FIRST_PERSON_ONLY_LAYER);
  assert.equal(fp.thirdPersonOnlyLayer, THIRD_PERSON_ONLY_LAYER);
  assert.equal(fp.firstPersonLayers, (0xffffffff & ~(1 << 30)) >>> 0);
  assert.equal(fp.thirdPersonLayers, (0xffffffff & ~(1 << 29)) >>> 0);
  assert.equal(registry().masks.get(model.nodes[child]), 1 << 30);
  assert.equal(registry().masks.get(model.nodes[3]), 1 << 30);
  assert.equal(registry().masks.get(model.nodes[MESH]), undefined, 'both keeps its mask');
  assert.equal(registry().cameras.get(eye), fp.firstPersonLayers);
  assert.equal(
    registry().cameras.get(model.camera),
    undefined,
    'no firstPersonOnly mesh: the engine camera keeps every layer',
  );
  assert.deepEqual(fp.viewpoint(), [0, 2.1, 0.05]);
  assert.deepEqual(
    fp.meshAnnotations.map((a) => a.type),
    ['thirdPersonOnly', 'both', 'thirdPersonOnly'],
  );
  fp[Symbol.dispose]();
  assert.equal(registry().masks.get(model.nodes[child]), undefined);
  assert.equal(registry().cameras.get(eye), undefined);
  fp.dispose();
});

test('addVRMFirstPerson: firstPersonOnly masks the third-person cameras, a set mask comes back, layers are checked', async () => {
  const doc = json(await splitVRMFirstPerson(built())),
    model = standIn(doc);
  doc.extensions.VRMC_vrm.firstPerson.meshAnnotations.find((a) => a.node === 3).type = 'firstPersonOnly';
  registry().masks.set(model.nodes[3], 4);
  const fp = addVRMFirstPerson(model, { firstPersonOnlyLayer: 5, thirdPersonOnlyLayer: 6 });
  assert.equal(registry().masks.get(model.nodes[3]), 1 << 5);
  assert.equal(registry().cameras.get(model.camera), (0xffffffff & ~(1 << 5)) >>> 0);
  fp.dispose();
  assert.equal(registry().masks.get(model.nodes[3]), 4);
  assert.equal(registry().cameras.get(model.camera), undefined);
  assert.throws(() => addVRMFirstPerson(model, { firstPersonOnlyLayer: 32 }), RangeError);
  assert.throws(() => addVRMFirstPerson(model, { firstPersonOnlyLayer: 3, thirdPersonOnlyLayer: 3 }), RangeError);
});

test('addVRMFirstPerson refuses an auto mesh and names loadVRM', () => {
  const model = standIn(json(built()));
  assert.throws(
    () => addVRMFirstPerson(model),
    (error) => error.code === 'state' && /loadVRM/.test(error.message),
  );
});
