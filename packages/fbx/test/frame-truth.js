// Compares a converted GLB, posed at a time, with an OBJ a DCC tool wrote of that frame: nothing of the engine runs here,
// only the glTF rules (keyframes, node TRS, skinning, morph weights) written out plainly.
import assert from 'node:assert/strict';
import { readGLB } from './native-scene-helper.js';

const multiply = (a, b) => {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
};
const compose = (t, q, s) => {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0],
    2 * (x * y + w * z) * s[0],
    2 * (x * z - w * y) * s[0],
    0,
    2 * (x * y - w * z) * s[1],
    (1 - 2 * (x * x + z * z)) * s[1],
    2 * (y * z + w * x) * s[1],
    0,
    2 * (x * z + w * y) * s[2],
    2 * (y * z - w * x) * s[2],
    (1 - 2 * (x * x + y * y)) * s[2],
    0,
    t[0],
    t[1],
    t[2],
    1,
  ];
};
const point = (m, x, y, z) => [
  m[0] * x + m[4] * y + m[8] * z + m[12],
  m[1] * x + m[5] * y + m[9] * z + m[13],
  m[2] * x + m[6] * y + m[10] * z + m[14],
];

function keyed(times, values, width, step, time, normalize) {
  let i = 0;
  while (i + 1 < times.length && times[i + 1] <= time) i++;
  const at = (k) => Array.from(values.subarray(k * width, k * width + width));
  if (step || time <= times[0] || i + 1 === times.length) return at(i);
  const a = at(i),
    b = at(i + 1),
    alpha = (time - times[i]) / (times[i + 1] - times[i]);
  if (!normalize) return a.map((v, k) => v + (b[k] - v) * alpha);
  // Keys this close make the arc and the chord the same to Float32, which is what slerp gives here.
  const sign = a.reduce((sum, v, k) => sum + v * b[k], 0) < 0 ? -1 : 1,
    out = a.map((v, k) => v + (b[k] * sign - v) * alpha),
    length = Math.hypot(...out);
  return out.map((v) => v / length);
}

/** Every vertex of the GLB's meshes in world space at `time` of clip `clip` (default the first). */
export function posed(buffer, time, clip = 0, capture) {
  const { doc, accessor } = readGLB(buffer),
    state = doc.nodes.map((n) => ({
      t: n.translation ?? [0, 0, 0],
      r: n.rotation ?? [0, 0, 0, 1],
      s: n.scale ?? [1, 1, 1],
      w: n.weights ?? doc.meshes?.[n.mesh]?.weights,
    }));
  const animation = doc.animations?.[clip];
  for (const channel of animation?.channels ?? []) {
    const sampler = animation.samplers[channel.sampler],
      times = accessor(sampler.input),
      values = accessor(sampler.output),
      step = sampler.interpolation === 'STEP',
      target = state[channel.target.node],
      path = channel.target.path;
    if (path === 'weights') target.w = keyed(times, values, values.length / times.length, step, time, false);
    else if (path === 'rotation') target.r = keyed(times, values, 4, step, time, true);
    else target[path[0]] = keyed(times, values, 3, step, time, false);
  }
  const world = new Array(doc.nodes.length),
    walk = (index, parent) => {
      const s = state[index];
      world[index] = multiply(parent, compose(s.t, s.r, s.s));
      for (const child of doc.nodes[index].children ?? []) walk(child, world[index]);
    };
  const identity = compose([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  for (const root of doc.scenes[doc.scene ?? 0].nodes) walk(root, identity);
  const out = [];
  doc.nodes.forEach((node, index) => {
    if (node.mesh === undefined) return;
    for (const primitive of doc.meshes[node.mesh].primitives) {
      const base = accessor(primitive.attributes.POSITION),
        positions = Float64Array.from(base),
        weights = state[index].w ?? [];
      (primitive.targets ?? []).forEach((target, k) => {
        if (!weights[k] || target.POSITION === undefined) return;
        const delta = accessor(target.POSITION);
        for (let i = 0; i < positions.length; i++) positions[i] += delta[i] * weights[k];
      });
      const skin = node.skin === undefined ? undefined : doc.skins[node.skin];
      if (!skin) {
        for (let i = 0; i < positions.length; i += 3)
          out.push(point(world[index], positions[i], positions[i + 1], positions[i + 2]));
        continue;
      }
      const binds = accessor(skin.inverseBindMatrices),
        joints = accessor(primitive.attributes.JOINTS_0),
        amounts = accessor(primitive.attributes.WEIGHTS_0),
        matrices = skin.joints.map((joint, k) => multiply(world[joint], Array.from(binds.subarray(k * 16, k * 16 + 16))));
      capture?.({ matrices, joints, weights: amounts, positions });
      for (let v = 0; v * 3 < positions.length; v++) {
        const sum = [0, 0, 0];
        for (let k = 0; k < 4; k++) {
          const amount = amounts[v * 4 + k];
          if (!amount) continue;
          const p = point(matrices[joints[v * 4 + k]], positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
          for (let a = 0; a < 3; a++) sum[a] += p[a] * amount;
        }
        out.push(sum);
      }
    }
  });
  return out;
}

/** What the skinning of the first skinned primitive reads at `time`, for a runtime other than plain glTF. */
export function skinInputs(buffer, time) {
  let got;
  posed(buffer, time, 0, (inputs) => {
    got ??= inputs;
  });
  const palette = new Float32Array(got.matrices.length * 16);
  got.matrices.forEach((m, i) => palette.set(m, i * 16));
  return {
    palette,
    joints: Uint16Array.from(got.joints),
    weights: Float32Array.from(got.weights),
    positions: Float32Array.from(got.positions),
  };
}

export const objVertices = (text) =>
  text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('v '))
    .map((line) => line.trim().split(/\s+/).slice(1).map(Number));

/** The largest distance from a vertex of either set to the nearest of the other, after scaling `ours`. */
export function farthest(ours, theirs, scale = 1) {
  const near = (from, to) => {
    let worst = 0;
    for (const p of from) {
      let best = Infinity;
      for (const q of to) best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
      worst = Math.max(worst, best);
    }
    return worst;
  };
  const scaled = ours.map((p) => p.map((v) => v * scale));
  return Math.max(near(scaled, theirs), near(theirs, scaled));
}

export function assertFrame(buffer, time, obj, tolerance, label, scale = 100) {
  const distance = farthest(posed(buffer, time), objVertices(obj), scale);
  assert.ok(distance <= tolerance, `${label}: ${distance} > ${tolerance}`);
  return distance;
}
