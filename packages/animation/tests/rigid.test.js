// compileRigidClip: keys of rigidly bound meshes become stepped bone tracks, and the clip poses a Skeleton.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Skeleton, applyKeyframeClip, compileRigidClip } from '../dist/index.js';

const s = Math.SQRT1_2;
const bones = [
  { id: 'hip', translation: [0, 1, 0] },
  { id: 'arm', translation: [0.5, 1.5, 0] },
];
const bindings = [
  { object: 'body', bone: 'hip', position: [0, 1, 0], rotation: [0, 0, 0, 1] },
  { object: 'sword', bone: 'arm', position: [1, 1, 0], rotation: [0, 0, 0, 1] },
  { object: 'hand', bone: 'arm', position: [0.5, 1.5, 0], rotation: [0, s, 0, s] },
];
const track = (clip, target, path) => clip.tracks.find((t) => t.target === target && t.path === path);

test('keys move bones by the mesh offset from rest, held to the duration', () => {
  const clip = compileRigidClip(
    bones,
    bindings,
    [
      { object: 'body', time: 0.5, position: [0, 2, 0], rotation: [0, 0, 0, 1] },
      { object: 'ghost', time: 0, position: [9, 9, 9], rotation: [0, 0, 0, 1] },
    ],
    { duration: 2, name: 'Jump' },
  );
  assert.equal(clip.name, 'Jump');
  assert.equal(clip.tracks.length, 2, 'only the keyed bone has tracks');
  const position = track(clip, 'hip', 'translation');
  assert.deepEqual([...position.times], [0, 0.5, 2]);
  assert.deepEqual([...position.values], [0, 1, 0, 0, 2, 0, 0, 2, 0]);
  assert.ok(position.interpolations.every((i) => i === 'discrete'));
});

test('rotation is the key relative to the rest rotation, and the earliest-bound keyed mesh leads', () => {
  const clip = compileRigidClip(bones, bindings, [
    { object: 'hand', time: 0, position: [0.5, 1.5, 0], rotation: [0, 1, 0, 0] },
    { object: 'sword', time: 1, position: [1, 2, 0], rotation: [0, 0, 0, 1] },
  ]);
  const rotation = track(clip, 'arm', 'rotation').values,
    translation = track(clip, 'arm', 'translation').values;
  // hand: 180 deg about Y relative to its 90 deg rest = 90 deg about Y.
  assert.ok([0, s, 0, s].every((v, i) => Math.abs(rotation[i] - v) < 1e-12));
  // At t=1 the sword (bound first) takes the bone over.
  assert.deepEqual([...translation.slice(3)], [0.5, 2.5, 0]);
  assert.deepEqual([...rotation.slice(4)], [0, 0, 0, 1]);
});

test('the clip poses a skeleton', () => {
  const skeleton = new Skeleton([
    { name: 'hip', parent: -1, translation: [0, 1, 0] },
    { name: 'arm', parent: 0, translation: [0.5, 1.5, 0] },
  ]);
  const clip = compileRigidClip(bones, bindings, [
    { object: 'body', time: 0, position: [1, 1, 0], rotation: [0, 0, 0, 1] },
  ]);
  applyKeyframeClip(clip, skeleton, 0);
  assert.deepEqual(skeleton.getPose(0).translation, [1, 1, 0]);
});

test('refuses malformed input with the fix in the message', () => {
  assert.throws(() => compileRigidClip(bones, [{ ...bindings[0], bone: 'tail' }], []), {
    name: 'TypeError',
    message: /unknown bone/,
  });
  assert.throws(() => compileRigidClip(bones, [bindings[0], bindings[0]], []), {
    name: 'TypeError',
    message: /repeated/,
  });
  assert.throws(
    () =>
      compileRigidClip(bones, bindings, [{ object: 'body', time: -1, position: [0, 0, 0], rotation: [0, 0, 0, 1] }]),
    RangeError,
  );
  assert.throws(
    () => compileRigidClip(bones, bindings, [{ object: 'body', time: 0, position: [0, 0], rotation: [0, 0, 0, 1] }]),
    TypeError,
  );
  assert.throws(() => compileRigidClip(bones, bindings, [], { duration: Number.NaN }), RangeError);
});
