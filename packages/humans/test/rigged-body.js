// A small rigged body built in code for the garment fit tests (@margoengine/humans/fit): a humanoid skeleton (the
// humanoid bone names) and closed skinned parts (torso, neck, head, arms, hands, legs, feet) of about the 1919 US Army
// central size, in a T-pose or an A-pose, with linear blend skinning weights that blend across each joint. Also poses
// for it (skin matrices) and a GLB of it with a clip, for the GPU check.
const RAD = Math.PI / 180;

/** Joint positions in the rest pose: arms out at `armAngle` degrees from hanging (90 is a T-pose). */
function joints(armAngle) {
  const a = armAngle * RAD,
    J = {
      hips: [0, 0.95, 0],
      spine: [0, 1.06, 0],
      chest: [0, 1.25, 0],
      neck: [0, 1.46, 0],
      head: [0, 1.56, 0],
    };
  for (const [s, side] of [
    [1, 'left'],
    [-1, 'right'],
  ]) {
    const sh = [s * 0.19, 1.41, 0],
      dir = [s * Math.sin(a), -Math.cos(a), 0];
    J[`${side}Shoulder`] = [s * 0.04, 1.42, 0];
    J[`${side}UpperArm`] = sh;
    J[`${side}LowerArm`] = sh.map((v, i) => v + dir[i] * 0.29);
    J[`${side}Hand`] = sh.map((v, i) => v + dir[i] * 0.55);
    J[`${side}UpperLeg`] = [s * 0.09, 0.9, 0];
    J[`${side}LowerLeg`] = [s * 0.09, 0.48, 0.01];
    J[`${side}Foot`] = [s * 0.09, 0.08, -0.01];
    J[`${side}Toes`] = [s * 0.09, 0.02, 0.14];
  }
  return J;
}
const PARENT = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  neck: 'chest',
  head: 'neck',
  leftShoulder: 'chest',
  leftUpperArm: 'leftShoulder',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightShoulder: 'chest',
  rightUpperArm: 'rightShoulder',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  leftToes: 'leftFoot',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
  rightToes: 'rightFoot',
};
export const BONES = Object.keys(PARENT);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const norm = (v) => Math.hypot(v[0], v[1], v[2]);
const unit = (v) => v.map((c) => c / (norm(v) || 1));
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * The body: `pose` 'T' (arms at 90 degrees) or 'A' (45). Returns a RiggedBody plus `parts` (closed surface per triangle)
 * and `rest` (joint positions by bone name). With `jaw` the head gets a jaw and chin reaching down in front of the neck to
 * 1.505 m, as a real head's does. With `lean` the torso is a lean man's like dressed Wilbur's (a Character Creator body):
 * the chest broader than the hips, and the torso's centre line moving forward at the belly and back at the waist and
 * the shoulder blades, as a real torso's does. With `armRoots` the torso stands out 2.5 cm at each side under the arm
 * and those vertices carry part of the upper arm's weight, as the roots of the lats and deltoids of a body modelled in
 * an A or T pose do (a Character Creator body's armpit): lowering the arms pulls them in.
 */
export function riggedTestBody(pose = 'T', { jaw = false, lean = false, armRoots = false } = {}) {
  const J = joints(pose === 'T' ? 90 : 45),
    P = [],
    N = [],
    I = [],
    JO = [],
    W = [],
    S = [];
  let surface = 0;
  const bone = (name) => BONES.indexOf(name);
  // A closed tube along `axis(t)` for t in 0..1 with elliptical sections; caps close both ends to points.
  const tube = (rows, cols, ring, weights) => {
    const first = P.length / 3;
    for (let r = 0; r <= rows; r++) {
      const t = r / rows,
        { c, x, y, a, b } = ring(t);
      for (let k = 0; k < cols; k++) {
        const phi = (k / cols) * 2 * Math.PI,
          ca = Math.cos(phi),
          sa = Math.sin(phi),
          p = [0, 1, 2].map((i) => c[i] + x[i] * a * ca + y[i] * b * sa),
          n = unit([0, 1, 2].map((i) => (x[i] * ca) / Math.max(a, 1e-6) + (y[i] * sa) / Math.max(b, 1e-6)));
        P.push(...p);
        N.push(...n);
        const w = weights(p, t);
        const entries = Object.entries(w)
          .filter(([, v]) => v > 0)
          .sort((p1, p2) => p2[1] - p1[1])
          .slice(0, 4);
        const total = entries.reduce((s, [, v]) => s + v, 0);
        for (let i = 0; i < 4; i++) {
          JO.push(entries[i] ? bone(entries[i][0]) : 0);
          W.push(entries[i] ? entries[i][1] / total : 0);
        }
      }
    }
    // Wind every triangle outward: the first quad of the middle row decides for the whole tube.
    const m = first + Math.floor(rows / 2) * cols,
      e1 = [0, 1, 2].map((i) => P[(m + cols) * 3 + i] - P[m * 3 + i]),
      e2 = [0, 1, 2].map((i) => P[(m + 1) * 3 + i] - P[m * 3 + i]),
      g = cross(e1, e2),
      flip = g[0] * N[m * 3] + g[1] * N[m * 3 + 1] + g[2] * N[m * 3 + 2] < 0;
    for (let r = 0; r < rows; r++)
      for (let k = 0; k < cols; k++) {
        const a = first + r * cols + k,
          b = first + r * cols + ((k + 1) % cols),
          c = a + cols,
          d = b + cols;
        if (flip) I.push(a, b, c, b, d, c);
        else I.push(a, c, b, b, c, d);
        S.push(surface, surface);
      }
    surface++;
  };
  // Rounded ends: radius shrinks as sqrt near each end over `cap` of the length.
  const ends = (t, cap = 0.12) => Math.sqrt(Math.max(0, Math.min(1, t / cap, (1 - t) / cap)));
  const X = [1, 0, 0],
    Y = [0, 1, 0],
    Z = [0, 0, 1];
  // Torso, crotch (0.84) to the neck root (1.47): half breadth and depth by height.
  // A fourth column moves the section forward (+z) or back.
  const torso = lean
    ? [
        [0.84, 0.12, 0.1, 0],
        [0.9, 0.15, 0.12, 0.012],
        [1.05, 0.13, 0.095, -0.01],
        [1.25, 0.175, 0.11, 0],
        [1.38, 0.18, 0.095, -0.012],
        [1.47, 0.08, 0.065, 0],
      ]
    : [
        [0.84, 0.12, 0.1, 0],
        [0.9, 0.17, 0.12, 0],
        [1.05, 0.14, 0.1, 0],
        [1.25, 0.16, 0.11, 0],
        [1.38, 0.17, 0.095, 0],
        [1.47, 0.08, 0.065, 0],
      ];
  /** Where the arm's roots stand out of the torso: 1 at the side 4 cm under the shoulder joint, 0 off it. */
  const root = (x, y) => (armRoots ? Math.max(0, 1 - ((y - 1.36) / 0.06) ** 2) * smooth(0.08, 0.15, Math.abs(x)) : 0);
  const along = (table, y) => {
    for (let i = 1; i < table.length; i++)
      if (y <= table[i][0]) {
        const f = (y - table[i - 1][0]) / (table[i][0] - table[i - 1][0]);
        return table[i - 1].map((v, j) => lerp(v, table[i][j], f));
      }
    return table[table.length - 1];
  };
  tube(
    40,
    48,
    (t) => {
      const y = lerp(0.84, 1.49, t),
        [, a, b, cz] = along(torso, y),
        e = ends(t, 0.06);
      return { c: [0, y, cz], x: X, y: Z, a: a * e, b: b * e };
    },
    ([x, y]) => {
      const up = smooth(1.0, 1.14, y),
        mid = smooth(1.16, 1.3, y),
        side = x > 0 ? 'left' : 'right',
        sh = smooth(0.1, 0.17, Math.abs(x)) * smooth(1.3, 1.38, y),
        neck = smooth(1.42, 1.49, y);
      const w = { hips: 1 - up, spine: up * (1 - mid), chest: up * mid * (1 - sh) * (1 - neck), neck: up * mid * neck };
      w[`${side}Shoulder`] = up * mid * sh * (1 - neck);
      const arm = 0.4 * root(x, y);
      if (arm > 0) {
        for (const k of Object.keys(w)) w[k] *= 1 - arm;
        w[`${side}UpperArm`] = arm;
      }
      return w;
    },
  );
  if (armRoots)
    for (let v = 0; v < P.length / 3; v++) P[v * 3] += Math.sign(P[v * 3]) * 0.025 * root(P[v * 3], P[v * 3 + 1]);
  // Neck and head.
  tube(
    10,
    24,
    (t) => {
      const e = ends(t, 0.1);
      return { c: [0, lerp(1.4, 1.6, t), 0], x: X, y: Z, a: 0.055 * e, b: 0.055 * e };
    },
    ([, y]) => ({ neck: 1 - smooth(1.52, 1.58, y), head: smooth(1.52, 1.58, y) }),
  );
  tube(
    24,
    32,
    (t) => {
      const s = Math.sin(t * Math.PI);
      return { c: [0, lerp(1.51, 1.72, t), 0.01], x: X, y: Z, a: 0.078 * s, b: 0.095 * s };
    },
    () => ({ head: 1 }),
  );
  if (jaw)
    tube(
      12,
      24,
      (t) => {
        const sn = Math.sin(t * Math.PI);
        return { c: [0, lerp(1.505, 1.585, t), 0.045], x: X, y: Z, a: 0.05 * sn, b: 0.035 * sn };
      },
      () => ({ head: 1 }),
    );
  for (const [s, side] of [
    [1, 'left'],
    [-1, 'right'],
  ]) {
    const sh = J[`${side}UpperArm`],
      el = J[`${side}LowerArm`],
      wr = J[`${side}Hand`],
      dir = unit(el.map((v, i) => v - sh[i])),
      front = Z,
      across = unit(cross(front, dir));
    // Arm: from 4 cm inside the shoulder joint to the wrist; deltoid 5 cm, elbow 3.8, wrist 2.8.
    tube(
      36,
      24,
      (t) => {
        const d = lerp(-0.04, 0.56, t),
          r =
            d < 0.06 ? 0.05 : d < 0.29 ? lerp(0.047, 0.039, (d - 0.06) / 0.23) : lerp(0.042, 0.028, (d - 0.29) / 0.27),
          e = ends(t, 0.08);
        return { c: sh.map((v, i) => v + dir[i] * d), x: across, y: front, a: r * e, b: r * e };
      },
      (p) => {
        const d = (p[0] - sh[0]) * dir[0] + (p[1] - sh[1]) * dir[1] + (p[2] - sh[2]) * dir[2],
          root = 1 - smooth(-0.04, 0.03, d),
          elbow = smooth(0.25, 0.33, d),
          wrist = smooth(0.52, 0.56, d);
        return {
          [`${side}Shoulder`]: root * 0.5,
          [`${side}UpperArm`]: (1 - root * 0.5) * (1 - elbow),
          [`${side}LowerArm`]: elbow * (1 - wrist),
          [`${side}Hand`]: wrist,
        };
      },
    );
    tube(
      12,
      16,
      (t) => {
        const sn = Math.sin(t * Math.PI);
        return {
          c: wr.map((v, i) => v + dir[i] * lerp(0.0, 0.18, t)),
          x: across,
          y: front,
          a: 0.045 * sn,
          b: 0.02 * sn,
        };
      },
      () => ({ [`${side}Hand`]: 1 }),
    );
    // Leg: hip joint line to the ankle; thigh 8.5 cm, knee 5.5, calf 6, ankle 3.5.
    const hip = J[`${side}UpperLeg`],
      knee = J[`${side}LowerLeg`],
      ankle = J[`${side}Foot`];
    const legR = [
      [0.98, 0.07],
      [0.9, 0.085],
      [0.75, 0.075],
      [0.48, 0.052],
      [0.36, 0.058],
      [0.12, 0.034],
      [0.06, 0.03],
    ];
    tube(
      44,
      24,
      (t) => {
        const y = lerp(0.98, 0.06, t),
          r = along(
            legR.map(([yy, rr]) => [-yy, rr]),
            -y,
          )[1],
          e = ends(t, 0.04),
          k = y > knee[1] ? (hip[1] - y) / (hip[1] - knee[1]) : (knee[1] - y) / (knee[1] - ankle[1]),
          c = y > knee[1] ? hip.map((v, i) => lerp(v, knee[i], k)) : knee.map((v, i) => lerp(v, ankle[i], k));
        return { c: [c[0], y, c[2]], x: X, y: Z, a: r * e, b: r * e };
      },
      ([, y]) => {
        const top = smooth(0.86, 0.98, y),
          kn = 1 - smooth(0.44, 0.52, y),
          an = 1 - smooth(0.06, 0.12, y);
        return {
          hips: top * 0.7,
          [`${side}UpperLeg`]: (1 - top * 0.7) * (1 - kn),
          [`${side}LowerLeg`]: kn * (1 - an),
          [`${side}Foot`]: an,
        };
      },
    );
    // Foot: heel to toe along z, sole at the floor.
    tube(
      20,
      20,
      (t) => {
        const z = lerp(-0.06, 0.2, t),
          e = ends(t, 0.15);
        return { c: [s * 0.09, 0.04, z], x: X, y: Y, a: 0.045 * e, b: 0.04 * e };
      },
      ([, , z]) => ({ [`${side}Foot`]: 1 - smooth(0.1, 0.16, z), [`${side}Toes`]: smooth(0.1, 0.16, z) }),
    );
  }
  const bones = BONES.map((name) => ({
    name,
    parent: PARENT[name] ? BONES.indexOf(PARENT[name]) : -1,
    bind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...J[name], 1],
  }));
  return {
    positions: new Float32Array(P),
    normals: new Float32Array(N),
    indices: new Uint32Array(I),
    joints: new Uint32Array(JO),
    weights: new Float32Array(W),
    bones,
    surfaces: new Uint32Array(S),
    rest: J,
  };
}

/** A rotation of `deg` degrees about the unit `axis`, as a quaternion [x, y, z, w]. */
export const quat = (axis, deg) => {
  const h = (deg * RAD) / 2,
    s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
};
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/**
 * Test poses for a body in rest pose `pose` ('T' or 'A'): local rotations (quaternions x, y, z, w) by bone name. The
 * arms come down 35 degrees from a T-pose and 10 from an A-pose, so no pose presses an arm into the trunk (the fit
 * skins the clothes; it does not push cloth aside where the body meets itself).
 */
export const posesFor = (pose = 'T') => ({
  rest: {},
  'arms lowered, elbows bent': {
    leftUpperArm: quat([0, 0, 1], pose === 'T' ? -35 : -10),
    rightUpperArm: quat([0, 0, 1], pose === 'T' ? 35 : 10),
    leftLowerArm: quat([0, 1, 0], -40),
    rightLowerArm: quat([0, 1, 0], 40),
  },
  stride: {
    leftUpperLeg: quat([1, 0, 0], -25),
    leftLowerLeg: quat([1, 0, 0], 30),
    rightUpperLeg: quat([1, 0, 0], 15),
    leftUpperArm: quat([0, 0, 1], pose === 'T' ? -20 : 0),
    rightUpperArm: quat([0, 0, 1], pose === 'T' ? 20 : 0),
  },
  'turn and lean': {
    spine: quat([1, 0, 0], -8),
    chest: qmul(quat([0, 1, 0], 15), quat([0, 0, 1], 5)),
    head: quat([0, 1, 0], -20),
    leftUpperArm: quat([1, 0, 0], -20),
  },
});
export const POSES = posesFor('T');
const rotation = (q) => {
  const [x, y, z, w] = q;
  return [
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
    0,
    0,
    0,
    1,
  ];
};
const mul = (a, b) => {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
};
const translate = (t) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0], t[1], t[2], 1];
/** Skin matrices (16 numbers a bone) of `body` in `pose`: each bone's posed world matrix times its inverse bind. */
export function poseSkin(body, pose) {
  const world = {},
    out = new Float64Array(BONES.length * 16);
  for (const name of BONES) {
    const parent = PARENT[name],
      offset = parent ? body.rest[name].map((v, i) => v - body.rest[parent][i]) : body.rest[name],
      local = mul(translate(offset), rotation(pose[name] ?? [0, 0, 0, 1]));
    world[name] = parent ? mul(world[parent], local) : local;
    out.set(mul(world[name], translate(body.rest[name].map((v) => -v))), BONES.indexOf(name) * 16);
  }
  return out;
}

/** The body as a GLB: bone nodes, a skinned mesh named `body` with material `Skin`, and a clip `pose` (rest at 0 s, `pose` at 1 s). */
export function riggedTestGLB(pose = 'T', clipPose = POSES['arms lowered, elbows bent']) {
  const body = riggedTestBody(pose),
    chunks = [],
    views = [],
    accessors = [];
  let length = 0;
  const view = (data, target) => {
    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength, ...(target ? { target } : {}) });
    length += data.byteLength;
    const pad = (4 - (data.byteLength % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      length += pad;
    }
    return views.length - 1;
  };
  const acc = (data, type, count, componentType, extra = {}, target) => {
    accessors.push({ bufferView: view(data, target), componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const n = body.positions.length / 3,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < body.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], body.positions[i]);
    max[i % 3] = Math.max(max[i % 3], body.positions[i]);
  }
  const attributes = {
    POSITION: acc(body.positions, 'VEC3', n, 5126, { min, max }, 34962),
    NORMAL: acc(body.normals, 'VEC3', n, 5126, {}, 34962),
    TEXCOORD_0: acc(new Float32Array(n * 2), 'VEC2', n, 5126, {}, 34962),
    JOINTS_0: acc(Uint16Array.from(body.joints), 'VEC4', n, 5123, {}, 34962),
    WEIGHTS_0: acc(body.weights, 'VEC4', n, 5126, {}, 34962),
  };
  const indices = acc(body.indices, 'SCALAR', body.indices.length, 5125, {}, 34963);
  const ibm = new Float32Array(BONES.length * 16);
  BONES.forEach((name, i) => ibm.set(translate(body.rest[name].map((v) => -v)), i * 16));
  const binds = acc(ibm, 'MAT4', BONES.length, 5126);
  const nodes = BONES.map((name) => {
    const parent = PARENT[name],
      t = parent ? body.rest[name].map((v, i) => v - body.rest[parent][i]) : body.rest[name],
      children = BONES.filter((c) => PARENT[c] === name).map((c) => BONES.indexOf(c));
    return { name, translation: t, ...(children.length ? { children } : {}) };
  });
  nodes.push({ name: 'body', mesh: 0, skin: 0 });
  const posed = Object.keys(clipPose),
    times = acc(new Float32Array([0, 1]), 'SCALAR', 2, 5126, { min: [0], max: [1] }),
    channels = [],
    samplers = [];
  for (const name of posed) {
    samplers.push({
      input: times,
      output: acc(new Float32Array([0, 0, 0, 1, ...clipPose[name]]), 'VEC4', 2, 5126),
      interpolation: 'LINEAR',
    });
    channels.push({ sampler: samplers.length - 1, target: { node: BONES.indexOf(name), path: 'rotation' } });
  }
  const bin = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.byteLength;
  }
  const doc = {
    asset: { version: '2.0', generator: 'humans fit test body' },
    scene: 0,
    scenes: [{ nodes: [0, nodes.length - 1] }],
    nodes,
    meshes: [{ name: 'body', primitives: [{ attributes, indices, material: 0 }] }],
    materials: [
      {
        name: 'Skin',
        pbrMetallicRoughness: { baseColorFactor: [0.9, 0.05, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.6 },
      },
    ],
    skins: [{ joints: BONES.map((_, i) => i), inverseBindMatrices: binds }],
    animations: [{ name: 'pose', channels, samplers }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  const raw = new TextEncoder().encode(JSON.stringify(doc)),
    json = new Uint8Array((raw.length + 3) & ~3).fill(0x20);
  json.set(raw);
  const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length),
    dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  dv.setUint32(20 + json.length, bin.length, true);
  dv.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}
