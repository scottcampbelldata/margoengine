// An original humanoid test character for the README runner (scripts/run-readme-examples.mjs): a skinned figure of
// boxes, 1.7 m tall, facing +z with its left at +x, in the bone naming people search for (Mixamo's `mixamorig:` rig or
// Godot's humanoid profile), with ARKit-named face shapes, elbow and shoulder correctives, hair, earring and belly bones
// for spring bones, and Idle and Walk clips. Written from the glTF 2.0 specification (skins, morph targets,
// animations); nothing in it comes from another tool's file. `humanoidVRM` adds a VRM 1.0 avatar to it.
// Mixamo is a trademark of Adobe Inc.; Godot is a trademark of the Godot Foundation; ARKit is a trademark of Apple Inc.
// Margo is not affiliated with them: only their published bone and shape names are used, as names.

// [humanoid bone, parent, world position]
const BODY = [
  ['hips', null, [0, 0.95, 0]],
  ['spine', 'hips', [0, 1.05, 0]],
  ['chest', 'spine', [0, 1.17, 0]],
  ['upperChest', 'chest', [0, 1.29, 0]],
  ['neck', 'upperChest', [0, 1.45, 0]],
  ['head', 'neck', [0, 1.55, 0]],
  ...['left', 'right'].flatMap((side) => {
    const x = side === 'left' ? 1 : -1;
    return [
      [`${side}Eye`, 'head', [0.032 * x, 1.63, 0.085]],
      [`${side}Shoulder`, 'upperChest', [0.05 * x, 1.4, 0]],
      [`${side}UpperArm`, `${side}Shoulder`, [0.17 * x, 1.4, 0]],
      [`${side}LowerArm`, `${side}UpperArm`, [0.44 * x, 1.4, 0]],
      [`${side}Hand`, `${side}LowerArm`, [0.69 * x, 1.4, 0]],
      [`${side}UpperLeg`, 'hips', [0.09 * x, 0.91, 0]],
      [`${side}LowerLeg`, `${side}UpperLeg`, [0.09 * x, 0.5, 0.01]],
      [`${side}Foot`, `${side}LowerLeg`, [0.09 * x, 0.08, 0]],
      [`${side}Toes`, `${side}Foot`, [0.09 * x, 0.02, 0.13]],
    ];
  }),
];
// Bones no humanoid map has, named the same in every naming: a hair strand, an earring and a belly to jiggle.
const EXTRA = [
  ['Hair1', 'head', [0, 1.66, -0.09]],
  ['Hair2', 'Hair1', [0, 1.55, -0.13]],
  ['Hair3', 'Hair2', [0, 1.42, -0.14]],
  ['LeftEarring', 'head', [0.085, 1.56, 0]],
  ['Belly', 'spine', [0, 1.08, 0.1]],
];
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const MIXAMO = {
  hips: 'Hips',
  spine: 'Spine',
  chest: 'Spine1',
  upperChest: 'Spine2',
  neck: 'Neck',
  head: 'Head',
  ...Object.fromEntries(
    ['left', 'right'].flatMap((s) => {
      const S = capital(s);
      return [
        [`${s}Eye`, `${S}Eye`],
        [`${s}Shoulder`, `${S}Shoulder`],
        [`${s}UpperArm`, `${S}Arm`],
        [`${s}LowerArm`, `${S}ForeArm`],
        [`${s}Hand`, `${S}Hand`],
        [`${s}UpperLeg`, `${S}UpLeg`],
        [`${s}LowerLeg`, `${S}Leg`],
        [`${s}Foot`, `${S}Foot`],
        [`${s}Toes`, `${S}ToeBase`],
      ];
    }),
  ),
};
const boneName = (naming, bone) => (naming === 'mixamo' ? `mixamorig:${MIXAMO[bone]}` : capital(bone));

/** Apple's 52 ARFaceAnchor.BlendShapeLocation names, as face trackers report them. */
export const ARKIT_SHAPES = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
  'cheekSquintRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight', 'eyeLookInLeft',
  'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight', 'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft',
  'eyeSquintRight', 'eyeWideLeft', 'eyeWideRight', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthFunnel', 'mouthLeft',
  'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmileLeft', 'mouthSmileRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight',
  'tongueOut',
];
/** Face shapes under another tool's names, for `addFace`'s `map`, on the VRM avatar. */
export const AVATAR_SHAPES = ['Mouth_Open', 'Blink_L', 'Blink_R', 'Lash_L'];
const CORRECTIVES = ['LeftElbowFix', 'RightElbowFix', 'LeftShoulderRaise', 'LeftShoulderForward'];

/** Corners of a box from `a` to `b` (its long axis) with half-width `r`: 24 vertices, 36 indices, flat normals. */
function box(a, b, r) {
  const lo = [0, 1, 2].map((i) => Math.min(a[i], b[i]) - r),
    hi = [0, 1, 2].map((i) => Math.max(a[i], b[i]) + r),
    positions = [],
    normals = [],
    indices = [];
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const u = (axis + 1) % 3,
        v = (axis + 2) % 3,
        base = positions.length / 3;
      for (const [su, sv] of [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ]) {
        const p = [0, 0, 0];
        p[axis] = sign < 0 ? lo[axis] : hi[axis];
        p[u] = su ? hi[u] : lo[u];
        p[v] = sv ? hi[v] : lo[v];
        positions.push(...p);
        const n = [0, 0, 0];
        n[axis] = sign;
        normals.push(...n);
      }
      indices.push(...(sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]).map((i) => base + i));
    }
  return { positions, normals, indices };
}

/**
 * The character as GLB bytes.
 * @param {{naming?: 'mixamo' | 'godot', shapes?: readonly string[]}} options `shapes`: the face's morph target names
 *   (default the 52 ARKit names).
 */
export function humanoidGLB({ naming = 'mixamo', shapes = ARKIT_SHAPES } = {}) {
  const bones = [
    ...(naming === 'godot' ? [['Root', null, [0, 0, 0]]] : []),
    ...BODY.map(([bone, parent, at]) => [
      boneName(naming, bone),
      parent ? boneName(naming, parent) : naming === 'godot' ? 'Root' : null,
      at,
    ]),
    ...EXTRA.map(([name, parent, at]) => [name, BODY.some(([b]) => b === parent) ? boneName(naming, parent) : parent, at]),
  ];
  const index = new Map(bones.map(([name], i) => [name, i])),
    world = bones.map(([, , at]) => at);
  const nodes = bones.map(([name, parent, at]) => {
    const p = parent ? world[index.get(parent)] : [0, 0, 0];
    return { name, translation: at.map((v, i) => +(v - p[i]).toFixed(6)) };
  });
  bones.forEach(([, parent], i) => {
    if (parent) (nodes[index.get(parent)].children ??= []).push(i);
  });
  // Body: a box per bone toward its first child (or a small one at a leaf), skinned rigidly to that bone.
  const body = { positions: [], normals: [], indices: [], joints: [], segments: new Map() };
  const add = (target, part, joint) => {
    const base = target.positions.length / 3;
    target.positions.push(...part.positions);
    target.normals.push(...part.normals);
    target.indices.push(...part.indices.map((i) => base + i));
    for (let k = 0; k < part.positions.length / 3; k++) target.joints.push(joint);
    return [base, base + part.positions.length / 3];
  };
  const name = (bone) => boneName(naming, bone);
  for (const [bone] of BODY) {
    if (bone === 'head' || bone.endsWith('Eye')) continue;
    const i = index.get(name(bone)),
      child = BODY.find(([b, parent]) => parent === bone && !b.endsWith('Eye'));
    const to = child ? world[index.get(name(child[0]))] : world[i].map((v, a) => v + (a === 2 ? 0.08 : 0));
    const r = /Leg|Arm/.test(bone) ? 0.05 : /Hand|Foot|Toes/.test(bone) ? 0.04 : 0.11;
    body.segments.set(bone, add(body, box(world[i], to, r), i));
  }
  // Correctives: each moves its segment's vertices outward a little.
  const bodyTargets = CORRECTIVES.map((shape) => {
    const segment = body.segments.get(
      { LeftElbowFix: 'leftLowerArm', RightElbowFix: 'rightLowerArm' }[shape] ?? 'leftUpperArm',
    );
    const delta = new Array(body.positions.length).fill(0);
    for (let v = segment[0]; v < segment[1]; v++) delta[v * 3 + 1] = shape.includes('Forward') ? 0 : 0.01;
    if (shape.includes('Forward')) for (let v = segment[0]; v < segment[1]; v++) delta[v * 3 + 2] = 0.01;
    return delta;
  });
  // Face: a head box skinned to the head, one morph target per shape, each moving its own corner.
  const face = { positions: [], normals: [], indices: [], joints: [] };
  const head = index.get(name('head'));
  add(face, box(world[head], world[head].map((v, a) => v + (a === 1 ? 0.2 : 0)), 0.1), head);
  const faceTargets = shapes.map((shape, s) => {
    const delta = new Array(face.positions.length).fill(0),
      v = s % (face.positions.length / 3);
    delta[v * 3 + (/jaw|Mouth/i.test(shape) ? 1 : 2)] = /jaw|Mouth/i.test(shape) ? -0.02 : 0.01;
    return delta;
  });

  // Binary buffer and accessors.
  const chunks = [],
    views = [],
    accessors = [];
  let length = 0;
  const push = (array, type, componentType, { target, minmax } = {}) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    length = (length + 3) & ~3;
    chunks.push([length, bytes]);
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    length += bytes.byteLength;
    const size = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type],
      accessor = { bufferView: views.length - 1, componentType, count: array.length / size, type };
    if (minmax) {
      accessor.min = [...Array(size)].map((_, c) => Math.min(...array.filter((_, k) => k % size === c)));
      accessor.max = [...Array(size)].map((_, c) => Math.max(...array.filter((_, k) => k % size === c)));
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };
  const FLOAT = 5126,
    USHORT = 5123,
    UINT = 5125;
  const primitive = (part, targets) => {
    const count = part.positions.length / 3,
      weights = new Float32Array(count * 4),
      joints = new Uint16Array(count * 4);
    for (let v = 0; v < count; v++) {
      joints[v * 4] = part.joints[v];
      weights[v * 4] = 1;
    }
    return {
      attributes: {
        POSITION: push(new Float32Array(part.positions), 'VEC3', FLOAT, { target: 34962, minmax: true }),
        NORMAL: push(new Float32Array(part.normals), 'VEC3', FLOAT, { target: 34962 }),
        JOINTS_0: push(joints, 'VEC4', USHORT, { target: 34962 }),
        WEIGHTS_0: push(weights, 'VEC4', FLOAT, { target: 34962 }),
      },
      indices: push(new Uint32Array(part.indices), 'SCALAR', UINT, { target: 34963 }),
      targets: targets.map((delta) => ({
        POSITION: push(new Float32Array(delta), 'VEC3', FLOAT, { target: 34962, minmax: true }),
      })),
    };
  };
  const meshes = [
    {
      name: 'Body',
      primitives: [primitive(body, bodyTargets)],
      weights: CORRECTIVES.map(() => 0),
      extras: { targetNames: CORRECTIVES },
    },
    {
      name: 'Face',
      primitives: [primitive(face, faceTargets)],
      weights: shapes.map(() => 0),
      extras: { targetNames: [...shapes] },
    },
  ];
  // Joints bind at their rest world positions: the inverse bind matrix is a translation by minus that position.
  const inverse = new Float32Array(bones.length * 16);
  world.forEach((p, j) => {
    inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -p[0], -p[1], -p[2], 1], j * 16);
  });
  const skins = [
    { name: 'Armature', joints: bones.map((_, i) => i), skeleton: 0, inverseBindMatrices: push(inverse, 'MAT4', FLOAT) },
  ];
  const bodyNode = nodes.push({ name: 'Body', mesh: 0, skin: 0 }) - 1,
    faceNode = nodes.push({ name: 'Face', mesh: 1, skin: 0 }) - 1;
  // Clips: rotations about x (legs and arms swing) and y (the head looks round).
  const quat = (axis, angle) => {
    const q = [0, 0, 0, Math.cos(angle / 2)];
    q[axis] = Math.sin(angle / 2);
    return q;
  };
  const clip = (clipName, duration, tracks) => {
    const times = [0, 0.25, 0.5, 0.75, 1].map((t) => t * duration),
      input = push(new Float32Array(times), 'SCALAR', FLOAT, { minmax: true }),
      samplers = [],
      channels = [];
    for (const [bone, axis, amplitude] of tracks) {
      const output = push(
        new Float32Array(times.flatMap((t) => quat(axis, amplitude * Math.sin((2 * Math.PI * t) / duration)))),
        'VEC4',
        FLOAT,
      );
      samplers.push({ input, output, interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node: index.get(name(bone)), path: 'rotation' } });
    }
    return { name: clipName, samplers, channels };
  };
  const animations = [
    clip('Idle', 2, [
      ['chest', 0, 0.03],
      ['head', 1, 0.15],
    ]),
    clip('Walk', 1, [
      ['leftUpperLeg', 0, 0.4],
      ['rightUpperLeg', 0, -0.4],
      ['leftLowerLeg', 0, -0.3],
      ['rightLowerLeg', 0, 0.3],
      ['leftUpperArm', 0, -0.3],
      ['rightUpperArm', 0, 0.3],
    ]),
  ];
  const bin = new Uint8Array((length + 3) & ~3);
  for (const [offset, bytes] of chunks) bin.set(bytes, offset);
  const json = {
    asset: { version: '2.0', generator: 'Margo README humanoid' },
    scene: 0,
    scenes: [{ nodes: [0, bodyNode, faceNode] }],
    nodes,
    meshes,
    skins,
    animations,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
  };
  return glb(json, bin);
}

/** GLB container (glTF 2.0 section 4.4): header, JSON chunk padded with spaces, BIN chunk padded with zeros. */
function glb(json, bin) {
  const text = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = (text.length + 3) & ~3,
    total = 12 + 8 + jsonLength + 8 + bin.byteLength,
    out = new Uint8Array(total),
    view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, bin.byteLength, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  out.set(bin, 28 + jsonLength);
  return out;
}

/**
 * Writes the README runner's rig samples into `folder` and returns them as [file name, path] pairs: the Mixamo-named
 * character under the names the rigging examples use, the Godot-named one, and the VRM avatar.
 */
export async function writeReadmeRigs(folder) {
  const { writeFileSync } = await import('node:fs'),
    { join } = await import('node:path'),
    { detectSkeleton, humanoidBones } = await import('../../packages/rigging/dist/retarget.js'),
    { createVRM, writeVRM } = await import('../../packages/rigging/dist/vrm.js');
  const write = (name, bytes) => {
    const path = join(folder, name);
    writeFileSync(path, bytes);
    return path;
  };
  const mixamo = write('humanoid-mixamo.glb', humanoidGLB({ naming: 'mixamo' })),
    godot = write('humanoid-godot.glb', humanoidGLB({ naming: 'godot' }));
  const avatarGLB = humanoidGLB({ naming: 'mixamo', shapes: AVATAR_SHAPES }),
    json = JSON.parse(new TextDecoder().decode(avatarGLB.subarray(20, 20 + new DataView(avatarGLB.buffer).getUint32(12, true)))),
    names = json.nodes.map((n) => n.name),
    face = names.indexOf('Face'),
    bind = (shape) => ({ morphTargetBinds: [{ node: face, index: AVATAR_SHAPES.indexOf(shape), weight: 1 }] }),
    avatar = write(
      'avatar.vrm',
      writeVRM(
        avatarGLB,
        createVRM({
          name: 'Margo test figure',
          authors: ['Margo'],
          bones: humanoidBones(names, detectSkeleton(names).preset),
          expressions: {
            preset: { aa: bind('Mouth_Open'), blinkLeft: bind('Blink_L'), blinkRight: bind('Blink_R') },
          },
        }),
      ),
    );
  return [
    ['character.glb', mixamo],
    ['rigged.glb', mixamo],
    ['mixamo-walk.glb', mixamo],
    ['godot-hero.glb', godot],
    ['avatar.vrm', avatar],
  ];
}
