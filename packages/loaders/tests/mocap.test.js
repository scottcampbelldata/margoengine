// parseBVH: hierarchy, Euler order, positions, end sites, limits, and the clip through the animation package.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBVH } from '../dist/mocap.js';
import { LoaderError } from '../dist/common.js';
import { Skeleton, applyKeyframeClip, createKeyframeClip } from '../../animation/dist/index.js';

const FILE = `HIERARCHY
ROOT Hips
{
  OFFSET 1 2 3
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Chest
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    End Site
    {
      OFFSET 0 5 0
    }
  }
  JOINT Leg
  {
    OFFSET 4 -10 0
    CHANNELS 3 Xrotation Yrotation Zrotation
    End Site { OFFSET 0 -8 0 }
  }
}
MOTION
Frames: 2
Frame Time: 0.5
0 0 0 0 0 0 0 0 0 0 0 0
10 20 30 90 0 0 0 90 0 90 0 0
`;

const near = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) < 1e-9, `${label}: ${actual} against ${expected}`));
};
const code = (fn, expected, pattern) =>
  assert.throws(
    fn,
    (e) => e instanceof LoaderError && e.code === expected && e.format === 'BVH' && pattern.test(e.message),
  );

test('the hierarchy becomes bones, parents first, with end sites', () => {
  const { bones, frames, frameTime, clip } = parseBVH(FILE);
  assert.deepEqual(
    bones.map((b) => b.name),
    ['Hips', 'Chest', 'Leg'],
  );
  assert.deepEqual(
    bones.map((b) => b.parent),
    [-1, 0, 0],
  );
  assert.deepEqual(bones[2].translation, [4, -10, 0]);
  assert.deepEqual(bones[1].endSite, [0, 5, 0]);
  assert.equal(bones[0].endSite, undefined);
  assert.equal(frames, 2);
  assert.equal(frameTime, 0.5);
  assert.equal(clip.name, 'mocap');
  assert.deepEqual(
    clip.tracks.map((t) => `${t.target}.${t.path}`),
    ['Hips.translation', 'Hips.rotation', 'Chest.rotation', 'Leg.rotation'],
  );
});

test('position channels move the joint from its OFFSET and scale applies to both', () => {
  const { clip } = parseBVH(FILE, { scale: 0.01 });
  const keys = clip.tracks[0].keys;
  near(keys[0].value, [0.01, 0.02, 0.03], 'frame 0');
  near(keys[1].value, [0.11, 0.22, 0.33], 'frame 1');
  assert.equal(keys[1].time, 0.5);
  assert.deepEqual(parseBVH(FILE, { scale: 0.01 }).bones[1].translation, [0, 0.1, 0]);
});

test('Euler channels follow the listed order', () => {
  const s = Math.SQRT1_2;
  const { clip } = parseBVH(FILE);
  near(clip.tracks[1].keys[1].value, [0, 0, s, s], 'Hips 90 about Z');
  near(clip.tracks[2].keys[1].value, [s, 0, 0, s], 'Chest 90 about X');
  near(clip.tracks[3].keys[1].value, [s, 0, 0, s], 'Leg 90 about X');
  // Two rotations against the matrix product Rz(90) * Rx(90): the local x axis lands on world y, y on z, z on x.
  const both = parseBVH(`HIERARCHY ROOT R { OFFSET 0 0 0 CHANNELS 3 Zrotation Xrotation Yrotation }
MOTION Frames: 1 Frame Time: 1
90 90 0`).clip.tracks[0].keys[0].value;
  near(both, [0.5, 0.5, 0.5, 0.5], 'Z then X');
  // The other order is a different rotation: Rx(90) * Rz(90).
  const other = parseBVH(`HIERARCHY ROOT R { OFFSET 0 0 0 CHANNELS 3 Xrotation Zrotation Yrotation }
MOTION Frames: 1 Frame Time: 1
90 90 0`).clip.tracks[0].keys[0].value;
  near(other, [0.5, -0.5, 0.5, 0.5], 'X then Z');
});

test('the result plays through the animation package', () => {
  const { bones, clip } = parseBVH(FILE);
  const skeleton = new Skeleton(bones);
  const playable = createKeyframeClip(clip);
  assert.equal(playable.duration, 0.5);
  applyKeyframeClip(playable, skeleton, 0.5);
  assert.equal(skeleton.index('Leg'), 2);
});

test('bad files and limits throw coded errors', () => {
  code(() => parseBVH('MOTION'), 'header', /HIERARCHY/);
  code(() => parseBVH('HIERARCHY MOTION Frames: 0 Frame Time: 1'), 'header', /no ROOT/);
  code(() => parseBVH('HIERARCHY ROOT'), 'truncated', /joint name/);
  code(() => parseBVH('HIERARCHY JOINT A'), 'syntax', /wrong place/);
  code(() => parseBVH('HIERARCHY ROOT A { OFFSET x 0 0'), 'syntax', /invalid number/);
  code(() => parseBVH('HIERARCHY ROOT A { OFFSET 0 0 0 CHANNELS 7'), 'syntax', /7 channels/);
  code(() => parseBVH('HIERARCHY ROOT A { OFFSET 0 0 0 CHANNELS 1 Wrotation'), 'syntax', /unknown channel/);
  code(() => parseBVH('HIERARCHY ROOT A { OFFSET 0 0 0 CHANNELS 0 JOINT A'), 'syntax', /named twice/);
  code(() => parseBVH('HIERARCHY ROOT A { OFFSET 0 0 0 CHANNELS 0 MOTION'), 'syntax', /inside joint/);
  code(() => parseBVH('HIERARCHY } MOTION'), 'syntax', /closing brace/);
  const one = 'HIERARCHY ROOT A { OFFSET 0 0 0 CHANNELS 1 Xrotation } MOTION ';
  code(() => parseBVH(`${one}Frames: 2 Frame Time: 0`), 'range', /frame time/);
  code(() => parseBVH(`${one}Frames: -1 Frame Time: 1`), 'header', /frame count/);
  code(() => parseBVH(`${one}Frames: 999999 Frame Time: 1 0`), 'truncated', /too short/);
  code(() => parseBVH(`${one}Frames: 2 Frame Time: 1 0   `), 'truncated', /frame 1/);
  code(() => parseBVH(`${one}Frames: 1 Frame Time: 1 nan`), 'syntax', /invalid number/);
  code(() => parseBVH(`${one}Frames: 2 Frame Time: 1 0 0`, { maxKeys: 1 }), 'limit', /keys/);
  code(() => parseBVH(FILE, { maxJoints: 2 }), 'limit', /joint count/);
  code(() => parseBVH(FILE, { scale: 0 }), 'range', /scale/);
  code(() => parseBVH(FILE, { maxKeys: -1 }), 'range', /maxKeys/);
  assert.deepEqual(parseBVH(`${one}Frames: 0 Frame Time: 1`).clip.tracks, []);
});

test('bytes work like text, and a deep chain does not run out the stack', () => {
  assert.equal(parseBVH(new TextEncoder().encode(FILE)).bones.length, 3);
  const depth = 3000;
  let deep = 'HIERARCHY\n';
  for (let i = 0; i < depth; i++) deep += `${i ? 'JOINT' : 'ROOT'} J${i} { OFFSET 0 1 0 CHANNELS 0\n`;
  deep += `${'}'.repeat(depth)}\nMOTION Frames: 0 Frame Time: 1`;
  assert.equal(parseBVH(deep).bones.length, depth);
});
