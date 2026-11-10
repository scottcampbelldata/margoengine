import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BooleanKeyframeTrack,
  StringKeyframeTrack,
  InterpolateDiscrete,
  createDiscreteClip,
  parseDiscreteTrack,
} from '../dist/discrete-tracks.js';
import { AnimationMixer, LoopOnce, AdditiveAnimationBlendMode } from '../dist/mixer.js';
import { ownerEngine } from './owner-lifetime.fixture.js';
import { PBRModel, GLTFAsset } from '../../gltf-pro/dist/index.js';
import { skinnedStrip } from '../test/fixture.js';

test('step sampling agrees with an independent scan at keys, between keys and outside', () => {
  const times = [-2, 0, 0.125, 1, 3],
    values = ['a', 'β', '你好', '🙂', 'last'],
    track = new StringKeyframeTrack('text', times, values);
  for (let i = -256; i <= 512; i++) {
    const time = i / 64;
    let index = 0;
    for (let k = 0; k < times.length; k++) if (times[k] <= time) index = k;
    assert.equal(track.sample(time), values[index]);
  }
  const flag = new BooleanKeyframeTrack('.visible', [0, 0.5, 1], [true, false, true]);
  assert.deepEqual(
    [-1, 0, 0.49999, 0.5, 0.9999, 1, 10].map((t) => flag.sample(t)),
    [true, true, true, false, false, true, true],
  );
});
test('inputs are copied, values are frozen, clones and reusable interpolants remain categorical', () => {
  const times = [0, 1],
    values = [false, true],
    track = new BooleanKeyframeTrack('flag', times, values);
  times[1] = 2;
  values[0] = true;
  assert.deepEqual([...track.times], [0, 1]);
  assert.deepEqual(track.values, [false, true]);
  assert.ok(Object.isFrozen(track.values));
  const clone = track.clone().shift(2);
  assert.notEqual(clone.times, track.times);
  assert.equal(clone.ValueTypeName, 'bool');
  assert.equal(track.getValueSize(), 1);
  assert.equal(track.ValueBufferType, Array);
  assert.equal(track.TimeBufferType, Float64Array);
  assert.equal(track.getInterpolation(), InterpolateDiscrete);
  const buffer = [],
    interpolant = track.createInterpolant(buffer);
  assert.equal(interpolant.evaluate(0), buffer);
  assert.equal(buffer[0], false);
  assert.equal(interpolant.evaluate(1)[0], true);
  assert.equal(track.setInterpolation(InterpolateDiscrete), track);
  assert.throws(() => track.setInterpolation(2301), { code: 'arguments' });
});
test('editing preserves holds, endpoints, duration and strict order', () => {
  const track = new StringKeyframeTrack('text', [0, 1, 2, 3], ['a', 'a', 'b', 'b']);
  track.optimize();
  assert.deepEqual([...track.times], [0, 2, 3]);
  track.trim(0.5, 2.5);
  assert.deepEqual([...track.times], [0.5, 2, 2.5]);
  assert.deepEqual(track.values, ['a', 'b', 'b']);
  track.scale(-2).shift(5);
  assert.deepEqual([...track.times], [0, 1, 4]);
  // b held on [2, 2.5] and a on [0.5, 2) mirror to b on [0, 1) and a on [1, 4].
  assert.deepEqual(track.values, ['b', 'a', 'a']);
  assert.equal(track.validate(), true);
  const before = track.toJSON();
  assert.throws(() => track.scale(0), { code: 'arguments' });
  assert.throws(() => track.shift(1e308), { code: 'arguments' });
  assert.deepEqual(track.toJSON(), before);
  const parsed = parseDiscreteTrack(JSON.parse(JSON.stringify(before)));
  assert.deepEqual(parsed.toJSON(), before);
});
test('binding resolves nested arrays and quoted keys once, and supports explicit accessors', () => {
  const target = { children: [{ visible: true }], labels: { 'a.b': { text: 'old' } } };
  const flag = new BooleanKeyframeTrack('children[0].visible', [0, 1], [false, true]).bind(target);
  flag.write(flag.sample(0));
  assert.equal(target.children[0].visible, false);
  const text = new StringKeyframeTrack('labels["a.b"].text', [0, 1], ['α', 'β']).bind(target);
  text.write(text.sample(1));
  assert.equal(target.labels['a.b'].text, 'β');
  let state = 'original';
  const explicit = new StringKeyframeTrack('state', [0], ['next']).bind(target, {
    get: () => state,
    set: (value) => (state = value),
  });
  assert.equal(explicit.read(), 'original');
  explicit.write('next');
  assert.equal(state, 'next');
});
test('plain-object actions step boolean and string properties, then restore originals', () => {
  const root = { visible: true, text: 'original' },
    clip = createDiscreteClip('state', [
      new BooleanKeyframeTrack('.visible', [0, 0.5, 1], [true, false, true]).bind(root),
      new StringKeyframeTrack('text', [0, 0.5, 1], ['start', 'middle', 'end']).bind(root),
    ]),
    mixer = new AnimationMixer(root),
    action = mixer.clipAction(clip).play();
  mixer.update(0.49);
  assert.deepEqual(root, { visible: true, text: 'start' });
  mixer.update(0.01);
  assert.deepEqual(root, { visible: false, text: 'middle' });
  action.setLoop(LoopOnce);
  action.clampWhenFinished = true;
  mixer.update(0.5);
  assert.deepEqual(root, { visible: true, text: 'end' });
  action.stop();
  assert.deepEqual(root, { visible: true, text: 'original' });
  mixer.dispose();
});
test('categorical crossfades use weights and original-state influence without numeric conversion', () => {
  const root = { text: 'original' },
    mixer = new AnimationMixer(root),
    make = (name, value) =>
      createDiscreteClip(name, [new StringKeyframeTrack('text', [0, 1], [value, value]).bind(root)]);
  const a = mixer.clipAction(make('a', 'A')).play().setEffectiveWeight(0.49);
  mixer.update(0);
  assert.equal(root.text, 'original');
  a.weight = 0.5;
  mixer.update(0);
  assert.equal(root.text, 'A');
  a.weight = 1;
  const b = mixer.clipAction(make('b', 'B')).play();
  a.crossFadeTo(b, 1);
  mixer.update(0.25);
  assert.equal(root.text, 'A');
  mixer.update(0.25);
  assert.equal(root.text, 'B');
  mixer.update(0.5);
  assert.equal(root.text, 'B');
  mixer.stopAllAction();
  assert.equal(root.text, 'original');
});
test('highest categorical contributor wins among multiple actions; ties are deterministic', () => {
  const root = { text: 'original' },
    mixer = new AnimationMixer(root);
  for (const [name, value, weight] of [
    ['a', 'A', 0.3],
    ['b', 'B', 0.3],
    ['c', 'C', 0.4],
  ])
    mixer
      .clipAction(createDiscreteClip(name, [new StringKeyframeTrack('text', [0, 1], [value, value]).bind(root)]))
      .play()
      .setEffectiveWeight(weight);
  mixer.update(0);
  assert.equal(root.text, 'C');
  mixer.stopAllAction();
  assert.equal(root.text, 'original');
});
test('capture originals on first play, restore on last stop and release after uncache', () => {
  const root = { visible: true },
    track = new BooleanKeyframeTrack('visible', [0, 1], [false, false]),
    clip = createDiscreteClip('flag', [track.bind(root)]),
    mixer = new AnimationMixer(root),
    action = mixer.clipAction(clip);
  root.visible = false;
  action.play();
  mixer.update(0);
  action.stop();
  assert.equal(root.visible, false);
  root.visible = true;
  action.play();
  mixer.update(0);
  mixer.uncacheAction(clip);
  assert.equal(root.visible, true);
  root.visible = false;
  mixer.update(0);
  assert.equal(root.visible, false);
});
test('one-key default-loop categorical actions hold rather than disappearing on first update', () => {
  const root = { visible: true, text: 'original' },
    mixer = new AnimationMixer(root),
    clip = createDiscreteClip('static', [
      new BooleanKeyframeTrack('visible', [0], [false]).bind(root),
      new StringKeyframeTrack('text', [0], ['held']).bind(root),
    ]);
  mixer.clipAction(clip).play();
  mixer.update(0.1);
  assert.deepEqual(root, { visible: false, text: 'held' });
  mixer.update(10);
  assert.deepEqual(root, { visible: false, text: 'held' });
  mixer.dispose();
  assert.deepEqual(root, { visible: true, text: 'original' });
});
test('invalid, sparse and wrong-type values never become categorical samples', () => {
  for (const values of [[true, 1], [true, undefined], new Array(2)])
    assert.throws(() => new BooleanKeyframeTrack('flag', [0, 1], values), { code: 'arguments' });
  for (const times of [[], [1, 0], [0, 0], [0, NaN], [0, Infinity]])
    assert.throws(
      () =>
        new StringKeyframeTrack(
          'text',
          times,
          times.map(() => ''),
        ),
      { code: 'arguments' },
    );
  const flag = new BooleanKeyframeTrack('visible', [0], [true]);
  assert.throws(() => flag.sample(Infinity), { code: 'arguments' });
  assert.throws(() => flag.bind({ visible: 'true' }), { code: 'arguments' });
  assert.throws(() => flag.createInterpolant(new Float32Array(1)), { code: 'arguments' });
});
test('unsafe and malformed property paths reject and duplicate/additive channels reject', () => {
  const root = { visible: true },
    mixer = new AnimationMixer(root);
  for (const path of ['__proto__.visible', 'constructor.prototype.visible', 'visible[', 'missing.value', 'visible..x'])
    assert.throws(() => new BooleanKeyframeTrack(path, [0], [false]).bind(root), { code: 'arguments' });
  const track = new BooleanKeyframeTrack('visible', [0, 1], [false, true]).bind(root);
  assert.throws(() => createDiscreteClip('bad', [track, track]), { code: 'arguments' });
  assert.throws(() => mixer.clipAction(createDiscreteClip('flag', [track]), root, AdditiveAnimationBlendMode), {
    code: 'arguments',
  });
  assert.equal(Object.prototype.visible, undefined);
  assert.throws(
    () =>
      createDiscreteClip('invalid original', [
        { target: root, property: 'visible', duration: 1, sample: () => true, read: () => 1, write() {} },
      ]),
    { code: 'arguments' },
  );
});

test('discrete model-root disposal never restores a property on a destroyed Mesh', async (t) => {
  const engine = await ownerEngine(t),
    data = skinnedStrip(),
    model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers)),
    mixer = new AnimationMixer(model);
  const clip = createDiscreteClip('visible', [
    new BooleanKeyframeTrack('visible', [0, 1], [false, false]).bind(model.root),
  ]);
  const action = mixer.clipAction(clip).play();
  mixer.update(0.25);
  assert.equal(model.root.visible, false);
  model.dispose();
  assert.doesNotThrow(() => action.stop());
  assert.doesNotThrow(() => mixer.dispose());
});

test('a negative scale samples the original backwards over every held interval', () => {
  const original = new StringKeyframeTrack('s', [0, 1, 2], ['a', 'b', 'c']);
  const mirrored = new StringKeyframeTrack('s', [0, 1, 2], ['a', 'b', 'c']).scale(-1);
  assert.deepEqual([...mirrored.times], [-2, -1, 0]);
  for (const t of [-1.75, -1.5, -1.25, -0.75, -0.5, -0.25, 0, 0.5]) assert.equal(mirrored.sample(t), original.sample(-t), `${t}`);
  const flags = new BooleanKeyframeTrack('v', [0, 2, 3], [false, true, false]).scale(-2);
  assert.deepEqual([...flags.times], [-6, -4, 0]);
  assert.equal(flags.sample(-5), true);
  assert.equal(flags.sample(-1), false);
  assert.equal(flags.sample(1), false);
});
