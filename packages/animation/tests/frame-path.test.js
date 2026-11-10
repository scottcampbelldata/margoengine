// Batch 161 job 1: the Animation frame path does no per-frame validation pass, walks keys with a cursor instead of a
// binary search, and writes nodes through the transform refs, with the same transform store bits as sampling each
// track with sampleTrackInto and driving setPosition, setScale and setQuaternion by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation, sampleTrackInto } from '../dist/index.js';
import { engine, model } from './support/models.js';
import { animatorGLB } from '../../../tests/support/animator-rig.js';

const robot = new URL('../../../examples/assets/robot-expressive.glb', import.meta.url);

/** Every transform lane and rotation lane of the given nodes, as numbers. */
function lanes(nodes) {
  const store = nodes[0].engine.store,
    t = store.transforms,
    out = [];
  for (const node of nodes) {
    const id = node.id;
    for (const k of ['x', 'y', 'z', 'sx', 'sy', 'sz', 'qx', 'qy', 'qz', 'qw']) out.push(t[k][id]);
    for (let c = 0; c < 3; c++) out.push(store.rotations[id * 3 + c]);
  }
  return out;
}
/** The parent commit's apply(), driven by hand with the exported sampler and the checked node setters. */
function applyByHand(animation, target, clipId, time) {
  const clip = animation.clips[clipId],
    t = clip.duration > 0 ? time % clip.duration : Math.min(time, clip.duration);
  for (const track of clip.tracks) {
    const value = sampleTrackInto(
        track.times,
        track.values,
        track.width,
        t,
        track.interpolation,
        track.path === 'rotation',
        new Float32Array(track.width),
      ),
      node = target.nodes[track.node];
    if (track.path === 'translation') node.setPosition(value);
    else if (track.path === 'scale') node.setScale(value);
    else if (track.path === 'rotation') node.setQuaternion(Array.from(value));
    else for (const p of target.primitives) if (p.nodeIndex === track.node) p.weights.set(value);
  }
}
const same = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++)
    if (!Object.is(actual[i], expected[i])) assert.fail(`${label}: lane ${i} ${actual[i]} !== ${expected[i]}`);
};

test('Walking seeked 600 times forward, backward and looped writes the same bits as sampleTrackInto and the setters', async () => {
  using e = await engine();
  const data = animatorGLB(robot),
    m = model(e, data),
    hand = model(e, animatorGLB(robot)),
    a = new Animation(m),
    clip = a.clips.findIndex((c) => c.name === 'Walking');
  assert.ok(clip >= 0, 'RobotExpressive has a Walking clip');
  a.clip = clip;
  const duration = a.clips[clip].duration,
    times = [];
  for (let i = 0; i < 300; i++) times.push((i / 300) * duration);
  for (let i = 0; i < 150; i++) times.push(duration * (1 - i / 150) * 0.97);
  for (let i = 0; i < 150; i++) times.push(duration * 0.5 + (i / 40) * duration);
  assert.equal(times.length, 600);
  for (const [i, time] of times.entries()) {
    a.seek(time);
    applyByHand(a, hand, clip, time);
    same(lanes(m.nodes), lanes(hand.nodes), `seek ${i} at ${time}`);
  }
  // Every clip of the file, forward then back, so scale, translation and rotation tracks of every shape are covered.
  for (let c = 0; c < a.clips.length; c++) {
    a.clip = c;
    const d = a.clips[c].duration;
    for (const time of [0, d * 0.1, d * 0.35, d * 0.9, d * 0.2, d * 1.3, 0]) {
      a.seek(time);
      applyByHand(a, hand, c, time);
      same(lanes(m.nodes), lanes(hand.nodes), `clip ${a.clips[c].name} at ${time}`);
    }
  }
  a.dispose();
  m.dispose();
  hand.dispose();
});

test('forward playback reads at most 3 key times per track sample and never calls setPosition or setScale', async () => {
  using e = await engine();
  const m = model(e, animatorGLB(robot)),
    a = new Animation(m);
  a.play('Walking');
  const tracks = a.clips[a.clip].tracks,
    reads = new Int32Array(tracks.length);
  tracks.forEach((track, i) => {
    const times = track.times;
    track.times = new Proxy(times, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) reads[i]++;
        return Reflect.get(target, key);
      },
    });
  });
  let setters = 0;
  for (const node of m.nodes) {
    const { setPosition, setScale } = node;
    node.setPosition = function (value) {
      setters++;
      return setPosition.call(this, value);
    };
    node.setScale = function (value) {
      setters++;
      return setScale.call(this, value);
    };
  }
  const frames = Math.floor(a.clips[a.clip].duration * 60) - 2;
  assert.ok(frames > 30);
  for (let f = 0; f < frames; f++) {
    reads.fill(0);
    a.onPreUpdate(1 / 60);
    for (let i = 0; i < tracks.length; i++)
      assert.ok(reads[i] <= 3, `frame ${f} track ${i} read ${reads[i]} key times (cursor walk reads 2 or 3)`);
  }
  assert.equal(setters, 0, 'setPosition and setScale calls per frame');
  a.dispose();
  m.dispose();
});

test('frames re-check morph widths without the validate pass and its Map; the group table is preallocated', async () => {
  using e = await engine();
  const m = model(
      e,
      animatorGLB(new URL('../../../examples/assets/khronos/MorphStressTest/MorphStressTest.glb', import.meta.url)),
    ),
    a = new Animation(m);
  let validates = 0;
  const validate = a.validate;
  a.validate = function () {
    validates++;
    return validate.call(this);
  };
  assert.ok(a.groupItems instanceof Int32Array, 'primitives grouped by node in an Int32Array');
  assert.ok(a.groupStart instanceof Int32Array);
  const items = a.groupItems,
    start = a.groupStart;
  for (let f = 0; f < 120; f++) a.onPreUpdate(1 / 60);
  assert.equal(validates, 0, 'validate() passes per frame');
  assert.equal(a.groupItems, items, 'group table kept across frames');
  assert.equal(a.groupStart, start);
  // The per-frame check still throws the constructor's error when a node's primitives disagree.
  const morphed = m.primitives.filter((p) => p.weights.length),
    sibling = morphed.find((p) => m.primitives.some((q) => q !== p && q.nodeIndex === p.nodeIndex));
  if (sibling) {
    const weights = sibling.weights;
    sibling.weights = new Float32Array(weights.length + 1);
    assert.throws(() => a.onPreUpdate(1 / 60), /Morph target counts must match/);
    sibling.weights = weights;
  }
  a.onPreUpdate(1 / 60);
  a.dispose();
  m.dispose();
});

test('a zero scale key still throws core setScale error from the frame path', async () => {
  using e = await engine();
  const m = model(e, animatorGLB(robot)),
    a = new Animation(m);
  // RobotExpressive keys no scale: drive one of its translation tracks as a zero scale.
  const clip = a.clips.findIndex((c) => c.tracks.some((t) => t.path === 'translation'));
  assert.ok(clip >= 0);
  const track = a.clips[clip].tracks.find((t) => t.path === 'translation');
  track.path = 'scale';
  track.values = new Float32Array(track.values.length);
  a.clip = clip;
  let expected;
  try {
    m.nodes[track.node].setScale([0, 0, 0]);
  } catch (error) {
    expected = error;
  }
  assert.ok(expected, 'core rejects a zero scale');
  assert.throws(
    () => a.seek(0),
    (error) => error.constructor === expected.constructor && error.message === expected.message,
  );
  a.dispose();
  m.dispose();
});
