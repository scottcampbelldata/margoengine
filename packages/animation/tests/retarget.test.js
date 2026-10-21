// Retarget: poses and clips moved between skeletons with different names, bone axes, lengths and hip heights.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Animation, Skeleton, applyKeyframeClip, createKeyframeClip } from '../dist/index.js';
import { Retarget, retargetRig } from '../dist/skeleton-utils.js';
import { skinnedStrip } from '../test/fixture.js';
import { axisAngle, engine, model, near, quaternion, sameRotation } from './support/models.js';

const Z = [0, 0, 1],
  Y = [0, 1, 0];
// Source: hips 1 up, spine, an arm along +x in its own frame. Target: other names, hips 2 up, a tail the source does
// not have, and an arm whose bone axis is local +y, turned -90 degrees about z so it also points along +x at rest.
const source = () =>
  new Skeleton([
    { name: 'mixamorig:Hips', parent: -1, translation: [0, 1, 0] },
    { name: 'mixamorig:Spine', parent: 0, translation: [0, 0.5, 0] },
    { name: 'mixamorig:Arm', parent: 1, translation: [0.2, 0.3, 0] },
    { name: 'mixamorig:Hand', parent: 2, translation: [0.5, 0, 0] },
  ]);
const target = () =>
  new Skeleton([
    { name: 'Hips', parent: -1, translation: [0, 2, 0] },
    { name: 'Tail', parent: 0, translation: [0, -0.2, -0.3], rotation: axisAngle([1, 0, 0], 20) },
    { name: 'Spine', parent: 0, translation: [0, 0.8, 0], rotation: axisAngle(Y, 180) },
    { name: 'Arm', parent: 2, translation: [-0.3, 0.4, 0], rotation: axisAngle(Z, 90) },
    { name: 'Hand', parent: 3, translation: [0, 0.6, 0] },
  ]);
const names = { Hips: 'mixamorig:Hips', Spine: 'mixamorig:Spine', Arm: 'mixamorig:Arm', Hand: 'mixamorig:Hand' };
const at = (skeleton, bone) => Array.from(skeleton.matrices.subarray(bone * 16 + 12, bone * 16 + 15));
/** World direction from a bone to its child, and its length. */
const bone = (skeleton, from, to) => {
  const a = at(skeleton, skeleton.index(from)),
    b = at(skeleton, skeleton.index(to)),
    d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]],
    l = Math.hypot(...d);
  return { direction: d.map((v) => v / l), length: l };
};

test('rest poses map to rest poses, whatever the bone axes and names', () => {
  const s = source(),
    t = target(),
    retarget = new Retarget(retargetRig(s), retargetRig(t), { names, hip: 'Hips' });
  assert.deepEqual(Array.from(retarget.map), [0, -1, 1, 2, 3]);
  assert.equal(retarget.hipScale, 2, 'hip heights 2 over 1');
  near(bone(t, 'Arm', 'Hand').direction, [1, 0, 0], 1e-12, 'target arm points +x at rest');
  const before = t.matrices.slice();
  retarget.apply(s, t);
  near(t.matrices, before, 1e-12, 'unchanged');
});

test('each mapped bone turns in model space as its source bone does; lengths and the unmapped tail stay', () => {
  const s = source(),
    t = target(),
    retarget = new Retarget(retargetRig(s), retargetRig(t), { names, hip: 'Hips' }),
    tail = t.getPose(1);
  // Hips turn 45 degrees about y and move 0.3 along x; the arm lifts 90 degrees about its own z.
  s.setPose(0, { rotation: axisAngle(Y, 45), translation: [0.3, 1, 0] });
  s.setPose(2, { rotation: axisAngle(Z, 90) });
  retarget.apply(s, t);
  for (const [a, b, c, d] of [
    ['mixamorig:Hips', 'mixamorig:Spine', 'Hips', 'Spine'],
    ['mixamorig:Arm', 'mixamorig:Hand', 'Arm', 'Hand'],
  ]) {
    const from = bone(s, a, b),
      to = bone(t, c, d);
    near(to.direction, from.direction, 1e-12, `${c} follows ${a}`);
  }
  near([bone(t, 'Arm', 'Hand').length], [0.6], 1e-12, 'target arm keeps its length');
  near(bone(t, 'Arm', 'Hand').direction, [0, 1, 0], 1e-12, 'lifted: 45 about y then 90 about the arm z');
  // The hip moves twice as far (rest heights 2 and 1); the tail keeps its rest local pose.
  near(at(t, 0), [0.6, 2, 0], 1e-12, 'scaled hip motion');
  near(t.getPose(1).rotation, tail.rotation, 0, 'tail untouched');
  // pose() is the same maths on raw arrays.
  const raw = new Float64Array(4 * 10);
  for (let b = 0; b < 4; b++) {
    const p = s.getPose(b);
    raw.set([...p.translation, ...p.rotation, ...p.scale], b * 10);
  }
  const out = retarget.pose(raw);
  sameRotation(Array.from(out.subarray(33, 37)), t.getPose(3).rotation, 1e-12, 'pose() matches apply()');
  assert.throws(() => retarget.pose(new Float64Array(3)), /Float64Array of 40 numbers/);
  // With an output array, pose() creates no typed arrays.
  const into = new Float64Array(50),
    Type = Float64Array;
  try {
    globalThis.Float64Array = new Proxy(Type, { construct: () => assert.fail('pose allocated') });
    for (let i = 0; i < 100; i++) retarget.pose(raw, into);
  } finally {
    globalThis.Float64Array = Type;
  }
  near(into, out, 0, 'same pose');
});

test('an explicit hip scale, same-name mapping and unmapping a bone with an empty name', () => {
  const s = source(),
    t = new Skeleton([
      { name: 'mixamorig:Hips', parent: -1, translation: [0, 1, 0] },
      { name: 'mixamorig:Spine', parent: 0, translation: [0, 0.5, 0] },
      { name: 'mixamorig:Arm', parent: 1, translation: [0.2, 0.3, 0] },
    ]),
    retarget = new Retarget(retargetRig(s), retargetRig(t), {
      names: { 'mixamorig:Spine': '' },
      hip: 'mixamorig:Hips',
      hipScale: 0.5,
    });
  assert.deepEqual(Array.from(retarget.map), [0, -1, 2]);
  s.setPose(0, { translation: [1, 1, 0] });
  s.setPose(1, { rotation: axisAngle(Z, 30) });
  retarget.apply(s, t);
  near(t.getPose(0).translation, [0.5, 1, 0], 1e-12, 'half the hip motion');
  near(t.getPose(1).rotation, [0, 0, 0, 1], 0, 'spine left at rest');
});

test('retargeted clips sample the source clip each frame and play on the target', () => {
  const s = source(),
    t = target(),
    retarget = new Retarget(retargetRig(s), retargetRig(t), { names, hip: 'Hips' }),
    lift = createKeyframeClip({
      name: 'Lift',
      tracks: [
        {
          target: 'mixamorig:Arm',
          path: 'rotation',
          keys: [
            { time: 0, value: [0, 0, 0, 1] },
            { time: 1, value: axisAngle(Z, 90) },
          ],
        },
        {
          target: 'mixamorig:Hips',
          path: 'translation',
          keys: [
            { time: 0, value: [0, 1, 0] },
            { time: 1, value: [0.3, 1, 0] },
          ],
        },
        { target: 'nobody', path: 'scale', keys: [{ time: 0, value: [2, 2, 2] }] },
      ],
    }),
    clip = retarget.clip(lift, { fps: 10 });
  assert.equal(clip.name, 'Lift');
  assert.equal(clip.duration, 1);
  assert.deepEqual(clip.tracks.map((track) => `${track.target} ${track.path}`).sort(), [
    'Arm rotation',
    'Hand rotation',
    'Hips rotation',
    'Hips translation',
    'Spine rotation',
  ]);
  assert.equal(clip.tracks[0].times.length, 11, 'a key per frame at 10 fps, both ends included');
  for (const time of [0, 0.5, 1]) {
    applyKeyframeClip(lift, s, time);
    applyKeyframeClip(clip, t, time);
    const angle = (90 * time * Math.PI) / 180;
    near(bone(t, 'Arm', 'Hand').direction, [Math.cos(angle), Math.sin(angle), 0], 1e-9, `arm at ${time}`);
    near(at(t, 0), [0.6 * time, 2, 0], 1e-9, `hips at ${time}`);
  }
});

test('glTF-pro models: rigs from every node, live apply, and clips sampled through their Animation', async () => {
  const e = await engine(),
    named = () => {
      const fixture = skinnedStrip();
      fixture.doc.nodes[1].name = 'root';
      fixture.doc.nodes[2].name = 'tip';
      return fixture;
    },
    a = model(e, named()),
    b = model(e, named());
  // The target's tip bone rests a quarter turn about z; the source's does not.
  b.nodes[2].setQuaternion(axisAngle(Z, 90));
  const rig = retargetRig(b);
  assert.deepEqual(rig.names, ['', 'root', 'tip']);
  assert.deepEqual(rig.parents, [-1, -1, 1]);
  const retarget = new Retarget(retargetRig(a), rig),
    animation = new Animation(a);
  assert.deepEqual(Array.from(retarget.map), [-1, 1, 2], 'unnamed nodes never map by name');
  animation.seek(0.5);
  retarget.apply(a, b);
  sameRotation(quaternion(b.nodes[2]), axisAngle(Z, 135), 1e-6, 'rest offset plus the source turn');
  // A glTF clip sampled through the source's Animation; its state is restored afterwards.
  animation.play('bend');
  animation.seek(0.3);
  animation.playing = false;
  const clip = retarget.clip({ animation, clip: 'bend' }, { fps: 4 });
  assert.equal(animation.time, 0.3);
  assert.equal(animation.playing, false);
  sameRotation(quaternion(a.nodes[2]), axisAngle(Z, 27), 1e-6, 'source pose restored');
  const tip = clip.tracks.find((track) => track.target === 'tip');
  assert.equal(tip.times.length, 5);
  sameRotation(Array.from(tip.values.subarray(8, 12)), axisAngle(Z, 135), 1e-6, 'clip key at 0.5');
  assert.throws(() => retarget.clip({ animation, clip: 'missing' }), /not one of the source model's clips/);
  assert.throws(() => retarget.apply(a, source()), /bones but its rig/);
});

test('bad rigs and options throw with the fix in the message', () => {
  const s = retargetRig(source()),
    t = retargetRig(target());
  assert.throws(() => new Retarget(s, t), /maps no bones/);
  assert.throws(() => new Retarget(s, t, { names: { Hips: 'pelvis' } }), /source does not have/);
  assert.throws(() => new Retarget(s, t, { names, hip: 'Pelvis' }), /not a target bone/);
  assert.throws(() => new Retarget(s, t, { names: { Spine: 'mixamorig:Spine' }, hip: 'Hips' }), /has no source bone/);
  assert.throws(() => new Retarget(s, t, { names, hipScale: 0 }), /hipScale 0/);
  assert.throws(
    () => new Retarget({ names: ['a'], parents: [0], rest: new Float64Array(10) }, t, { names }),
    /parent 0/,
  );
  assert.throws(() => new Retarget(s, { names: ['a'] }), TypeError);
  assert.throws(() => retargetRig({}), TypeError);
  assert.throws(() => new Retarget(s, t, { names }).clip(createKeyframeClip({ tracks: [] }), { fps: 0 }), /fps 0/);
});
