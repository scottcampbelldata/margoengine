// parseBVH against an independent forward-kinematics reader written from the Biovision BVH description alone: each
// joint's channels in the order the file declares them, the rotation matrix the product R1 R2 R3 of those channels'
// axis rotations (column vectors), the OFFSET in the parent's space plus any position channels, degrees, one scale.
// Sources: Meredith and Maddock (2001), "Motion Capture File Formats Explained", University of Sheffield CS-01-11;
// Thingvold's Biovision BVH description (1999). No code from any other reader.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBVH } from '../dist/mocap.js';
import { Skeleton, applyKeyframeClip, createKeyframeClip } from '../../animation/dist/index.js';

const ORDERS = ['XYZ', 'XZY', 'YXZ', 'YZX', 'ZXY', 'ZYX'];
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

/** A chain of joints that uses every Euler order, a 6-channel joint below the root and End Sites, `frames` frames. */
function file(frames) {
  const names = ['Hips', 'Chest', 'Collar', 'Shoulder', 'Elbow', 'Wrist', 'Leg'],
    parents = [-1, 0, 1, 2, 3, 4, 0],
    offsets = [
      [0, 0, 0],
      [0, 12, -0.5],
      [3, 7, 0],
      [15, 0, 0.2],
      [31, 0, 0],
      [25, 0.3, 0],
      [-10, 0, 0],
    ],
    channels = names.map((_, i) => {
      const order = ORDERS[i % 6].split('').map((a) => `${a}rotation`);
      return i === 0 || i === 3 ? ['Xposition', 'Yposition', 'Zposition', ...order] : order;
    });
  let text = 'HIERARCHY\n';
  const close = (i) => names.some((_, j) => parents[j] === i);
  const write = (i, depth) => {
    const pad = ' '.repeat(depth);
    text += `${pad}${i ? 'JOINT' : 'ROOT'} ${names[i]}\n${pad}{\n${pad} OFFSET ${offsets[i].join(' ')}\n`;
    text += `${pad} CHANNELS ${channels[i].length} ${channels[i].join(' ')}\n`;
    names.forEach((_, j) => parents[j] === i && write(j, depth + 1));
    if (!close(i)) text += `${pad} End Site\n${pad} {\n${pad}  OFFSET 4 1 0\n${pad} }\n`;
    text += `${pad}}\n`;
  };
  write(0, 0);
  text += `MOTION\nFrames: ${frames}\nFrame Time: 0.0333333\n`;
  const values = [];
  for (let f = 0; f < frames; f++) {
    const row = channels.flatMap((list) => list.map((c) => (c.endsWith('position') ? random() * 40 : random() * 170)));
    values.push(row);
    text += row.map((v) => v.toFixed(4)).join(' ') + '\n';
  }
  return { text, names, parents, offsets, channels, values: values.map((r) => r.map((v) => Number(v.toFixed(4)))) };
}

const rotation = (axis, degrees) => {
  const a = (degrees * Math.PI) / 180,
    c = Math.cos(a),
    s = Math.sin(a);
  return { X: [1, 0, 0, 0, c, -s, 0, s, c], Y: [c, 0, s, 0, 1, 0, -s, 0, c], Z: [c, -s, 0, s, c, 0, 0, 0, 1] }[axis];
};
const times = (a, b) =>
  Array.from({ length: 9 }, (_, i) => {
    const r = Math.floor(i / 3),
      c = i % 3;
    return a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  });
const apply = (m, v) => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);

/** World joint positions of one frame, by matrices, from the file's own description. */
function independent({ names, parents, offsets, channels }, row, scale) {
  const world = [],
    at = [];
  let k = 0;
  names.forEach((_, j) => {
    let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const local = offsets[j].map((v) => v * scale);
    for (const channel of channels[j]) {
      const value = row[k++],
        axis = channel[0];
      if (channel.endsWith('position')) local['XYZ'.indexOf(axis)] += value * scale;
      else r = times(r, rotation(axis, value));
    }
    const p = parents[j];
    world[j] = p < 0 ? r : times(world[p], r);
    at[j] = p < 0 ? local : apply(world[p], local).map((v, c) => v + at[p][c]);
  });
  return at;
}

test('parseBVH world joints match an independent BVH forward-kinematics reader in every Euler order', () => {
  const scale = 0.01,
    bvh = file(12),
    parsed = parseBVH(bvh.text, { scale }),
    skeleton = new Skeleton(parsed.bones),
    clip = createKeyframeClip(parsed.clip);
  assert.equal(parsed.frames, 12);
  let worst = 0;
  bvh.values.forEach((row, frame) => {
    applyKeyframeClip(clip, skeleton, frame * parsed.frameTime);
    const m = skeleton.matrices,
      expected = independent(bvh, row, scale);
    expected.forEach((p, j) => {
      worst = Math.max(worst, Math.hypot(m[j * 16 + 12] - p[0], m[j * 16 + 13] - p[1], m[j * 16 + 14] - p[2]));
    });
  });
  assert.ok(worst < 1e-9, `largest world joint error ${worst} m`);
});
