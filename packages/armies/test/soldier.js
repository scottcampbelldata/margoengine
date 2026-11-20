// A body built in code for the armies tests (a test stand-in, never shown as a person): a 1.75 m figure of tapered
// cylinders, eleven joints, every vertex on one bone, and four clips, 'stand', 'walk', 'run' and 'ride'. The walk covers
// two 30 inch steps in one second, the run two 36 inch steps in 2/3 of a second. `rings` sets the mesh detail.
const JOINTS = [
  // name, parent, rest translation from the parent
  ['hips', -1, [0, 0.93, 0]],
  ['spine', 0, [0, 0.12, 0]],
  ['head', 1, [0, 0.5, 0]],
  ['thighL', 0, [0.09, -0.04, 0]],
  ['shinL', 3, [0, -0.43, 0]],
  ['thighR', 0, [-0.09, -0.04, 0]],
  ['shinR', 5, [0, -0.43, 0]],
  ['armL', 1, [0.2, 0.42, 0]],
  ['foreL', 7, [0, -0.3, 0]],
  ['armR', 1, [-0.2, 0.42, 0]],
  ['foreR', 9, [0, -0.3, 0]],
];
// Segment of each joint: radius at its top and bottom, length down (up for spine and head).
const SEGMENTS = {
  hips: [0.15, 0.16, -0.1],
  spine: [0.17, 0.14, 0.5],
  head: [0.08, 0.1, 0.22],
  thighL: [0.075, 0.055, -0.43],
  shinL: [0.05, 0.04, -0.46],
  thighR: [0.075, 0.055, -0.43],
  shinR: [0.05, 0.04, -0.46],
  armL: [0.045, 0.04, -0.3],
  foreL: [0.038, 0.03, -0.28],
  armR: [0.045, 0.04, -0.3],
  foreR: [0.038, 0.03, -0.28],
};
const world = (j) => {
  const p = [0, 0, 0];
  for (let k = j; k >= 0; k = JOINTS[k][1]) for (let a = 0; a < 3; a++) p[a] += JOINTS[k][2][a];
  return p;
};
const qx = (angle) => [Math.sin(angle / 2), 0, 0, Math.cos(angle / 2)];
const qz = (angle) => [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
/** Joint rotations (about x: + swings the limb forward toward +Z for a hanging limb) per clip at phase t in [0, 1]. */
function pose(clip, t) {
  const w = 2 * Math.PI * t,
    r = {};
  if (clip === 'walk') {
    Object.assign(r, { thighL: qx(-0.45 * Math.sin(w)), thighR: qx(0.45 * Math.sin(w)), shinL: qx(0.5 * Math.max(0, Math.sin(w + 1.2))), shinR: qx(0.5 * Math.max(0, -Math.sin(w + 1.2))), armL: qx(0.35 * Math.sin(w)), armR: qx(-0.35 * Math.sin(w)) });
  } else if (clip === 'run') {
    Object.assign(r, { thighL: qx(-0.7 * Math.sin(w)), thighR: qx(0.7 * Math.sin(w)), shinL: qx(1.1 * Math.max(0, Math.sin(w + 1))), shinR: qx(1.1 * Math.max(0, -Math.sin(w + 1))), armL: qx(0.6 * Math.sin(w)), armR: qx(-0.6 * Math.sin(w)), foreL: qx(-1.2), foreR: qx(-1.2), spine: qx(0.2) });
  } else if (clip === 'ride') {
    Object.assign(r, { thighL: qx(-1.2), thighR: qx(-1.2), shinL: qx(1.4), shinR: qx(1.4), armL: qx(-0.5), armR: qx(-0.5), foreL: qx(-0.9), foreR: qx(-0.9), spine: qx(0.08 * Math.sin(w)) });
  } else Object.assign(r, { spine: qz(0.02 * Math.sin(w)), armL: qz(0.05), armR: qz(-0.05) });
  return r;
}
const CLIPS = [
  ['stand', 2],
  ['walk', 1],
  ['run', 2 / 3],
  ['ride', 1],
];

/** The figure as a glTF document and buffers. */
export function soldier({ rings = 6, sides = 12 } = {}) {
  const positions = [],
    normals = [],
    uvs = [],
    joints = [],
    weights = [],
    indices = [];
  JOINTS.forEach(([name], j) => {
    const [r0, r1, length] = SEGMENTS[name],
      top = world(j),
      base = positions.length / 3;
    for (let i = 0; i <= rings; i++) {
      const f = i / rings,
        radius = r0 + (r1 - r0) * f;
      for (let s = 0; s < sides; s++) {
        const a = (2 * Math.PI * s) / sides;
        positions.push(top[0] + radius * Math.cos(a), top[1] + length * f, top[2] + radius * Math.sin(a));
        normals.push(Math.cos(a), 0, Math.sin(a));
        uvs.push(s / sides, f);
        joints.push(j, 0, 0, 0);
        weights.push(1, 0, 0, 0);
      }
    }
    for (let i = 0; i < rings; i++)
      for (let s = 0; s < sides; s++) {
        const a = base + i * sides + s,
          b = base + i * sides + ((s + 1) % sides),
          c = a + sides,
          d = b + sides;
        // Wound so the outside faces out whichever way the segment runs.
        if (length < 0) indices.push(a, b, c, b, d, c);
        else indices.push(a, c, b, b, c, d);
      }
  });
  const buffers = [],
    bufferViews = [],
    accessors = [];
  const accessor = (data, type, componentType = 5126, extra = {}) => {
    buffers.push(new Uint8Array(data.buffer.slice(0)));
    bufferViews.push({ buffer: buffers.length - 1, byteLength: data.byteLength });
    accessors.push({ bufferView: bufferViews.length - 1, componentType, count: data.length / { VEC4: 4, VEC3: 3, VEC2: 2, SCALAR: 1, MAT4: 16 }[type], type, ...extra });
    return accessors.length - 1;
  };
  const p = new Float32Array(positions),
    min = [0, 1, 2].map((a) => Math.min(...positions.filter((_, i) => i % 3 === a))),
    max = [0, 1, 2].map((a) => Math.max(...positions.filter((_, i) => i % 3 === a)));
  const attributes = {
    POSITION: accessor(p, 'VEC3', 5126, { min, max }),
    NORMAL: accessor(new Float32Array(normals), 'VEC3'),
    TEXCOORD_0: accessor(new Float32Array(uvs), 'VEC2'),
    JOINTS_0: accessor(new Uint16Array(joints), 'VEC4', 5123),
    WEIGHTS_0: accessor(new Float32Array(weights), 'VEC4'),
  };
  const index = accessor(new Uint32Array(indices), 'SCALAR', 5125);
  const ibm = new Float32Array(JOINTS.length * 16);
  JOINTS.forEach((_, j) => {
    const w = world(j);
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1], j * 16);
  });
  const animations = CLIPS.map(([name, duration]) => {
    const keys = 24,
      times = new Float32Array(keys + 1).map((_, k) => (k / keys) * duration),
      input = accessor(times, 'SCALAR', 5126, { min: [0], max: [duration] }),
      samplers = [],
      channels = [];
    JOINTS.forEach(([joint], j) => {
      const out = new Float32Array((keys + 1) * 4);
      for (let k = 0; k <= keys; k++) out.set(pose(name, k / keys)[joint] ?? [0, 0, 0, 1], k * 4);
      samplers.push({ input, output: accessor(out, 'VEC4') });
      channels.push({ sampler: samplers.length - 1, target: { node: j, path: 'rotation' } });
    });
    // The hips bob twice a cycle on foot, once riding.
    const bob = new Float32Array((keys + 1) * 3);
    for (let k = 0; k <= keys; k++) {
      const t = k / keys,
        y = name === 'walk' ? 0.02 * Math.cos(4 * Math.PI * t) : name === 'run' ? 0.04 * Math.cos(4 * Math.PI * t) : name === 'ride' ? 0.01 * Math.cos(2 * Math.PI * t) : 0;
      bob.set([0, 0.93 + y, 0], k * 3);
    }
    samplers.push({ input, output: accessor(bob, 'VEC3') });
    channels.push({ sampler: samplers.length - 1, target: { node: 0, path: 'translation' } });
    return { name, samplers, channels };
  });
  const nodes = JOINTS.map(([name, , t], j) => ({ name, translation: [...t], children: JOINTS.map((x, i) => (x[1] === j ? i : -1)).filter((i) => i >= 0) }));
  for (const n of nodes) if (!n.children.length) delete n.children;
  nodes.push({ name: 'body', mesh: 0, skin: 0 });
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, nodes.length - 1] }],
    nodes,
    meshes: [{ primitives: [{ attributes, indices: index, material: 0 }] }],
    materials: [{ name: 'Uniform', pbrMetallicRoughness: { baseColorFactor: [0.42, 0.4, 0.34, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    skins: [{ joints: JOINTS.map((_, j) => j), inverseBindMatrices: accessor(ibm, 'MAT4'), skeleton: 0 }],
    animations,
    accessors,
    bufferViews,
    buffers: buffers.map((b) => ({ byteLength: b.byteLength })),
  };
  return { doc, buffers, vertices: positions.length / 3, triangles: indices.length / 3 };
}

/** The figure as one GLB file, for a page. */
export function soldierGLB(options) {
  const { doc, buffers } = soldier(options);
  let offset = 0;
  const at = buffers.map((b) => {
    const o = offset;
    offset += (b.byteLength + 3) & ~3;
    return o;
  });
  const bin = new Uint8Array(offset);
  buffers.forEach((b, i) => bin.set(b, at[i]));
  const json = { ...doc, buffers: [{ byteLength: offset }], bufferViews: doc.bufferViews.map((v, i) => ({ ...v, buffer: 0, byteOffset: at[i] })) };
  let text = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array((text.length + 3) & ~3).fill(0x20);
  padded.set(text);
  text = padded;
  const out = new Uint8Array(12 + 8 + text.length + 8 + bin.length),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, text.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  view.setUint32(20 + text.length, bin.length, true);
  view.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);
  return out;
}
