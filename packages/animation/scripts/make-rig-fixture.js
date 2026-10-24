// Writes tests/fixtures/tentacle-rig.glb, the Margo-made rig scripts/animation-influences-browser-tests.js loads
// (deterministic bytes, no third-party data). Run `node packages/animation/scripts/make-rig-fixture.js` after
// building the packages (it uses the exporters' GLB writer).
//
// A tapered tube (21 rings of 13 vertices, the seam doubled for UVs) with POSITION, NORMAL, TANGENT and TEXCOORD_0,
// skinned to a custom rig: an armature node (offset and turned, not a joint) above a chain of 8 joints whose rest
// poses are turned, so the inverse bind matrices are not plain translations. Each vertex takes a Gaussian falloff
// over every joint, keeps weights of at least 0.002 and stores them strongest first: JOINTS_0/WEIGHTS_0 hold the four
// strongest and JOINTS_1/WEIGHTS_1 the rest (unsigned 16-bit joints, float weights, sums of 1). Most vertices have
// five to eight active influences, so dropping the second set changes the deformation. Two linear rotation clips,
// "wave" (2 s) and "curl" (1.5 s), animate every joint.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { joinGLB } from '../../exporters/dist/glb.js';

const RINGS = 21,
  SIDES = 12,
  JOINTS = 8,
  LENGTH = 1,
  SIGMA = 0.24,
  MIN_WEIGHT = 0.002;
const radius = (y) => 0.12 - 0.09 * y,
  slope = -0.09;

// Joint rest poses (local to the parent): a step up the tube and a small alternating turn about z.
const rest = Array.from({ length: JOINTS }, (_, i) => {
  const angle = (i % 2 ? -1 : 1) * 0.04;
  return {
    translation: [0, i ? LENGTH / (JOINTS - 1) : 0, 0],
    rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
  };
});
const armature = { translation: [0, -0.5, 0], rotation: [0, Math.sin(0.15), 0, Math.cos(0.15)] };

// Column-major 4x4 helpers.
const compose = ({ translation: t = [0, 0, 0], rotation: [x, y, z, w] = [0, 0, 0, 1] }) => [
  1 - 2 * (y * y + z * z),
  2 * (x * y + z * w),
  2 * (x * z - y * w),
  0,
  2 * (x * y - z * w),
  1 - 2 * (x * x + z * z),
  2 * (y * z + x * w),
  0,
  2 * (x * z + y * w),
  2 * (y * z - x * w),
  1 - 2 * (x * x + y * y),
  0,
  t[0],
  t[1],
  t[2],
  1,
];
const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let column = 0; column < 4; column++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[column * 4 + row] += a[k * 4 + row] * b[column * 4 + k];
  return out;
};
// Inverse of a rigid transform (rotation and translation only).
const invertRigid = (m) => {
  const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  for (let row = 0; row < 3; row++) out[12 + row] = -(out[row] * m[12] + out[4 + row] * m[13] + out[8 + row] * m[14]);
  return out;
};

// Joint world matrices and where the mesh is: the tube is modelled along the rest chain, in world space.
const world = [];
for (let i = 0; i < JOINTS; i++) world.push(multiply(i ? world[i - 1] : compose(armature), compose(rest[i])));
const jointWorld = world.map((m) => [m[12], m[13], m[14]]);
const toWorld = (p) => {
  const m = compose(armature);
  return [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r] * (p.length > 3 ? p[3] : 1));
};

const positions = [],
  normals = [],
  tangents = [],
  uvs = [],
  joints0 = [],
  weights0 = [],
  joints1 = [],
  weights1 = [];
let secondary = 0,
  most = 0;
for (let ring = 0; ring < RINGS; ring++) {
  const v = ring / (RINGS - 1),
    y = v * LENGTH,
    r = radius(y);
  for (let side = 0; side <= SIDES; side++) {
    const u = side / SIDES,
      angle = u * 2 * Math.PI,
      c = Math.cos(angle),
      s = Math.sin(angle);
    const p = toWorld([r * c, y, r * s]),
      length = Math.hypot(c, -slope, s),
      n = toWorld([c / length, -slope / length, s / length, 0]),
      t = toWorld([-s, 0, c, 0]);
    positions.push(...p);
    normals.push(...n);
    tangents.push(...t, 1);
    uvs.push(u, 1 - v);
    // Gaussian falloff over the distance to every joint, strongest first.
    const influences = jointWorld
      .map((j, index) => ({
        index,
        weight: Math.exp(-((Math.hypot(p[0] - j[0], p[1] - j[1], p[2] - j[2]) / SIGMA) ** 2)),
      }))
      .sort((a, b) => b.weight - a.weight || a.index - b.index);
    const total = influences.reduce((sum, e) => sum + e.weight, 0);
    let kept = influences.filter((e) => e.weight / total >= MIN_WEIGHT);
    const keptTotal = kept.reduce((sum, e) => sum + e.weight, 0);
    kept = kept.map((e) => ({ index: e.index, weight: e.weight / keptTotal }));
    for (let k = 0; k < 8; k++) {
      const e = kept[k];
      (k < 4 ? joints0 : joints1).push(e ? e.index : 0);
      (k < 4 ? weights0 : weights1).push(e ? e.weight : 0);
    }
    if (kept.length > 4) secondary++;
    most = Math.max(most, kept.length);
  }
}
const indices = [];
for (let ring = 0; ring < RINGS - 1; ring++)
  for (let side = 0; side < SIDES; side++) {
    const a = ring * (SIDES + 1) + side,
      b = a + 1,
      c = a + SIDES + 1,
      d = c + 1;
    indices.push(a, c, b, b, c, d);
  }

// Clips: per joint rotation keys, phase-shifted along the chain.
const quat = (axis, angle) => [...axis.map((a) => a * Math.sin(angle / 2)), Math.cos(angle / 2)];
const multiplyQuat = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const clips = [
  {
    name: 'wave',
    duration: 2,
    keys: 9,
    pose: (i, phase) => quat([0, 0, 1], 0.35 * Math.sin(phase * 2 * Math.PI - i * 0.7)),
  },
  {
    name: 'curl',
    duration: 1.5,
    keys: 7,
    pose: (i, phase) => quat([1, 0, 0], 0.25 * (i / (JOINTS - 1)) * Math.sin(phase * Math.PI)),
  },
];

// Binary layout: one buffer, each view 4-byte aligned.
const chunks = [],
  bufferViews = [],
  accessors = [];
let offset = 0;
const view = (array, target) => {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
  chunks.push(bytes);
  const pad = (4 - (bytes.length % 4)) % 4;
  if (pad) chunks.push(new Uint8Array(pad));
  offset += bytes.length + pad;
  return bufferViews.length - 1;
};
const accessor = (values, type, componentType = 5126, target, bounds = false) => {
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type],
    array = componentType === 5126 ? new Float32Array(values) : new Uint16Array(values),
    entry = { bufferView: view(array, target), componentType, count: values.length / size, type };
  if (bounds) {
    entry.min = Array.from({ length: size }, (_, c) => Math.min(...array.filter((_, i) => i % size === c)));
    entry.max = Array.from({ length: size }, (_, c) => Math.max(...array.filter((_, i) => i % size === c)));
  }
  accessors.push(entry);
  return accessors.length - 1;
};
const VERTEX = 34962,
  INDEX = 34963;
const attributes = {
  POSITION: accessor(positions, 'VEC3', 5126, VERTEX, true),
  NORMAL: accessor(normals, 'VEC3', 5126, VERTEX),
  TANGENT: accessor(tangents, 'VEC4', 5126, VERTEX),
  TEXCOORD_0: accessor(uvs, 'VEC2', 5126, VERTEX),
  JOINTS_0: accessor(joints0, 'VEC4', 5123, VERTEX),
  WEIGHTS_0: accessor(weights0, 'VEC4', 5126, VERTEX),
  JOINTS_1: accessor(joints1, 'VEC4', 5123, VERTEX),
  WEIGHTS_1: accessor(weights1, 'VEC4', 5126, VERTEX),
};
const indexAccessor = accessor(indices, 'SCALAR', 5123, INDEX);
const inverseBind = accessor(world.flatMap(invertRigid), 'MAT4');

// Nodes: 0 the mesh, 1 the armature, 2.. the joint chain.
const nodes = [
  { name: 'tentacle', mesh: 0, skin: 0 },
  { name: 'armature', ...armature, children: [2] },
  ...rest.map((pose, i) => ({ name: 'joint' + i, ...pose, ...(i < JOINTS - 1 ? { children: [3 + i] } : {}) })),
];
const animations = clips.map(({ name, duration, keys, pose }) => {
  const times = Array.from({ length: keys }, (_, k) => (k / (keys - 1)) * duration),
    input = accessor(times, 'SCALAR', 5126, undefined, true),
    samplers = [],
    channels = [];
  for (let i = 0; i < JOINTS; i++) {
    const values = times.flatMap((time) => multiplyQuat(rest[i].rotation, pose(i, time / duration)));
    samplers.push({ input, output: accessor(values, 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: i, target: { node: 2 + i, path: 'rotation' } });
  }
  return { name, samplers, channels };
});

const bin = new Uint8Array(offset);
let at = 0;
for (const chunk of chunks) {
  bin.set(chunk, at);
  at += chunk.length;
}
const json = {
  asset: { version: '2.0', generator: 'Margo Engine packages/animation/scripts/make-rig-fixture.js' },
  scene: 0,
  scenes: [{ nodes: [0, 1] }],
  nodes,
  meshes: [{ name: 'tentacle', primitives: [{ attributes, indices: indexAccessor, material: 0 }] }],
  materials: [{ name: 'skin', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.35, 0.4, 1], roughnessFactor: 0.6 } }],
  skins: [{ name: 'rig', skeleton: 2, joints: rest.map((_, i) => 2 + i), inverseBindMatrices: inverseBind }],
  animations,
  accessors,
  bufferViews,
  buffers: [{ byteLength: bin.length }],
};
const out = joinGLB({ json, bin }),
  file = fileURLToPath(new URL('../tests/fixtures/tentacle-rig.glb', import.meta.url));
writeFileSync(file, out);
console.log(
  `${file}: ${out.length} bytes, ${positions.length / 3} vertices, ${JOINTS} joints, ${clips.length} clips, ` +
    `${secondary} vertices with more than four influences (up to ${most})`,
);
