// AnimationGroup: one clip and one clock over many models, with per-member offsets and no per-frame allocation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportGLB } from '../../exporters/dist/index.js';
import { Animation, AnimationGroup, Skeleton, applyKeyframeClip, createKeyframeClip } from '../dist/index.js';
import { skinnedStrip } from '../test/fixture.js';
import { axisAngle, engine, fromGLB, model, near, position, quaternion, sameRotation } from './support/models.js';

// The strip's 'bend' clip turns node 2 from 0 to 90 degrees about +z over one second.
const bend = (t) => axisAngle([0, 0, 1], 90 * t);
const strips = async (count, options) => {
  const e = await engine();
  return Array.from({ length: count }, () => new Animation(model(e, skinnedStrip({ extraClip: true })), options));
};
const wave = createKeyframeClip({
  name: 'Wave',
  tracks: [
    {
      target: 'arm',
      path: 'rotation',
      keys: [
        { time: 0, value: [0, 0, 0, 1] },
        { time: 2, value: axisAngle([0, 0, 1], 90) },
      ],
    },
    {
      target: 'arm',
      path: 'translation',
      keys: [
        { time: 0, value: [0, 1, 0] },
        { time: 2, value: [0, 2, 0] },
      ],
    },
  ],
});

test('a glTF clip by name drives every member at the group time plus its offset', async () => {
  const members = await strips(3),
    group = new AnimationGroup('bend');
  group.add(members[0]).add(members[1], 0.25).add(members[2], -0.25);
  assert.equal(group.size, 3);
  assert.ok(
    members.every((m) => m.playing === false && m.clip === 0),
    'own playback paused on the shared clip',
  );
  group.seek(0.5);
  sameRotation(quaternion(members[0].model.nodes[2]), bend(0.5), 1e-6, 'no offset');
  sameRotation(quaternion(members[1].model.nodes[2]), bend(0.75), 1e-6, 'ahead');
  sameRotation(quaternion(members[2].model.nodes[2]), bend(0.25), 1e-6, 'behind');
  // At group time 0 the member behind wraps to the end of the looping clip.
  group.seek(0);
  sameRotation(quaternion(members[2].model.nodes[2]), bend(0.75), 1e-6, 'wrapped');
  group.setOffset(members[2], 0.5).update(0.25);
  sameRotation(quaternion(members[2].model.nodes[2]), bend(0.75), 1e-6, 'new offset');
  group.remove(members[1]);
  assert.ok(!group.has(members[1]) && group.size === 2);
  // The second clip by index, and speed.
  const lift = new AnimationGroup(1, { speed: 2 }),
    [solo] = await strips(1);
  lift.add(solo).update(0.5);
  near(position(solo.model.nodes[1]), [0, 0.5, 0], 1e-6, 'lift at clip time 1 of 2');
  // A non-looping member holds its first frame before the group reaches it.
  const [once] = await strips(1, { loop: false });
  new AnimationGroup('bend').add(once, -0.5);
  sameRotation(quaternion(once.model.nodes[2]), bend(0), 1e-6, 'held');
});

test('a code-authored clip drives Skeletons and models through bindings made once', async () => {
  const bones = () =>
      new Skeleton([
        { name: 'root', parent: -1 },
        { name: 'arm', parent: 0, translation: [0, 1, 0] },
      ]),
    a = bones(),
    b = bones(),
    group = new AnimationGroup(wave, { loop: false });
  group.add(a).add(b, 1).seek(0.5);
  const expect = (t) => {
    const reference = bones();
    applyKeyframeClip(wave, reference, t);
    return reference.getPose(1);
  };
  for (const [skeleton, t] of [
    [a, 0.5],
    [b, 1.5],
  ]) {
    const pose = skeleton.getPose(1),
      reference = expect(t);
    near(pose.rotation, reference.rotation, 1e-12, `rotation at ${t}`);
    near(pose.translation, reference.translation, 1e-12, `translation at ${t}`);
  }
  // Not looping: past the end holds the last key.
  group.seek(10);
  near(b.getPose(1).translation, [0, 2, 0], 1e-12, 'held at the end');
  // Looping wraps member time into [0, duration), also for negative offsets.
  const looping = new AnimationGroup(wave),
    c = bones();
  looping.add(c, -0.5);
  near(c.getPose(1).translation, expect(1.5).translation, 1e-12, 'wrapped behind');

  // On a glTF-pro model: node transforms by name and morph weights through setMorph.
  const face = {
      name: 'face',
      geometry: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2],
        morphs: [{ positions: [0, 0, 0, 0, 0, 0, 0, 0.5, 0] }],
      },
    },
    blink = createKeyframeClip({
      tracks: [
        {
          target: 'face',
          path: 'weights',
          keys: [
            { time: 0, value: [0] },
            { time: 1, value: [1] },
          ],
        },
        {
          target: 'face',
          path: 'scale',
          keys: [
            { time: 0, value: [1, 1, 1] },
            { time: 1, value: [2, 2, 2] },
          ],
        },
      ],
    }),
    e = await engine(),
    heads = [0, 1].map(() => new Animation(fromGLB(e, exportGLB({ nodes: [face] })))),
    faces = new AnimationGroup(blink);
  faces.add(heads[0]).add(heads[1], 0.5).seek(0.25);
  near(heads[0].model.primitives[0].weights, [0.25], 1e-7, 'weight');
  near(heads[1].model.primitives[0].weights, [0.75], 1e-7, 'offset weight');
  const { scale } = heads[1].model.nodes[0];
  near([scale.x, scale.y, scale.z], [1.75, 1.75, 1.75], 1e-6, 'scale');
  const wide = createKeyframeClip({
    tracks: [{ target: 'face', path: 'weights', keys: [{ time: 0, value: [0, 1] }] }],
  });
  assert.throws(() => new AnimationGroup(wide).add(heads[0]), /has 2 values but the node has 1 morph targets/);
});

test('updating a group of glTF and code-clip members creates no typed arrays', async () => {
  const members = await strips(4),
    group = new AnimationGroup('bend'),
    skeletons = [0, 1, 2].map(
      () =>
        new Skeleton([
          { name: 'root', parent: -1 },
          { name: 'arm', parent: 0 },
        ]),
    ),
    code = new AnimationGroup(wave);
  members.forEach((m, i) => group.add(m, i * 0.1));
  skeletons.forEach((s, i) => code.add(s, i * 0.3));
  const arrays = { Float32Array, Float64Array, Uint32Array },
    from = Array.from,
    fail = () => assert.fail('Group playback allocated a typed array');
  try {
    for (const [name, Type] of Object.entries(arrays)) globalThis[name] = new Proxy(Type, { construct: fail });
    Array.from = fail;
    for (let i = 0; i < 120; i++) {
      group.update(1 / 60);
      code.update(1 / 60);
    }
  } finally {
    for (const [name, Type] of Object.entries(arrays)) globalThis[name] = Type;
    Array.from = from;
  }
  sameRotation(quaternion(members[3].model.nodes[2]), bend((2 + 0.3) % 1), 1e-5, 'after 120 frames');
});

test('as an engine plugin the group advances in onPreUpdate and leaves on dispose; bad input throws', async () => {
  const [member] = await strips(1),
    e = member.model.root.engine,
    group = new AnimationGroup('bend');
  e.use(group);
  assert.ok(e.hasPlugin(group.name));
  group.add(member);
  group.onPreUpdate(0.5);
  sameRotation(quaternion(member.model.nodes[2]), bend(0.5), 1e-6, 'advanced');
  group.playing = false;
  group.onPreUpdate(0.25);
  sameRotation(quaternion(member.model.nodes[2]), bend(0.5), 1e-6, 'paused');
  // A member whose model is disposed leaves at the next update.
  const [gone] = await strips(1);
  group.add(gone);
  gone.model.dispose();
  group.update(0.1);
  assert.ok(!group.has(gone) && group.has(member));
  group.dispose();
  assert.ok(!e.hasPlugin(group.name) && group.size === 0);
  assert.throws(
    () => group.add(member),
    (error) => error.code === 'disposed',
  );
  assert.throws(() => new AnimationGroup('missing').add(member), /not one of this model's clips/);
  assert.throws(() => new AnimationGroup(7).add(member), RangeError);
  assert.throws(() => new AnimationGroup('bend').add(new Skeleton([{ name: 'a', parent: -1 }])), /Animation members/);
  assert.throws(() => new AnimationGroup({}), TypeError);
  assert.throws(() => new AnimationGroup('bend', { speed: -1 }), /speed -1/);
  assert.throws(() => new AnimationGroup('bend').seek(-1), RangeError);
  assert.throws(() => new AnimationGroup('bend').add(member, Number.NaN), /offset/);
});
