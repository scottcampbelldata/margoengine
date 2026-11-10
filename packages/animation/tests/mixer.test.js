import assert from 'node:assert/strict';
import test from 'node:test';
import { Skeleton, createKeyframeClip, Animation } from '../dist/index.js';
import { AnimationMixer, LoopOnce, LoopRepeat, LoopPingPong, AdditiveAnimationBlendMode } from '../dist/mixer.js';
import { ownerEngine } from './owner-lifetime.fixture.js';
import { PBRModel, GLTFAsset } from '../../gltf-pro/dist/index.js';
import { skinnedStrip } from '../test/fixture.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
const skeleton = () => new Skeleton([{ name: 'root', parent: -1 }]);
const clip = (name, start, end, duration = 1, path = 'translation') =>
  createKeyframeClip({
    name,
    tracks: [
      {
        target: 'root',
        path,
        keys: [
          { time: 0, value: start },
          { time: duration, value: end },
        ],
      },
    ],
  });
const position = (s) => s.getPose(0).translation[0];

test('actions cache by clip/root, have independent clocks and blend shared properties once', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root),
    a = clip('a', [0, 0, 0], [10, 0, 0]),
    b = clip('b', [20, 0, 0], [20, 0, 0]);
  const first = mixer.clipAction(a).play().setEffectiveWeight(0.25),
    second = mixer.clipAction(b).play().setEffectiveWeight(0.75);
  assert.equal(mixer.clipAction(a), first);
  assert.equal(mixer.existingAction(a), first);
  first.timeScale = 0.5;
  mixer.update(0.5);
  close(first.time, 0.25);
  close(second.time, 0.5);
  close(position(root), 15.625);
  const other = skeleton();
  assert.notEqual(mixer.clipAction(a, other), first);
  mixer.stopAllAction();
  close(position(root), 0);
  mixer.dispose();
});

test('weights below one retain originals; overweight actions normalize; stopping restores once', () => {
  const root = skeleton();
  root.setPose(0, { translation: [4, 0, 0] });
  const mixer = new AnimationMixer(root),
    a = mixer.clipAction(clip('a', [12, 0, 0], [12, 0, 0])).play();
  a.weight = 0.25;
  mixer.update(0);
  close(position(root), 6);
  a.weight = 2;
  mixer.update(0);
  close(position(root), 12);
  a.stop();
  mixer.update(0);
  close(position(root), 4);
  root.setPose(0, { translation: [8, 0, 0] });
  mixer.update(0);
  close(position(root), 8);
});

test('crossfades multiply action weight, return actions and preserve independent time scales', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root);
  const a = mixer.clipAction(clip('a', [10, 0, 0], [10, 0, 0])).play(),
    b = mixer.clipAction(clip('b', [20, 0, 0], [20, 0, 0])).play();
  assert.equal(a.crossFadeTo(b, 2), a);
  mixer.update(1);
  close(a.getEffectiveWeight(), 0.5);
  close(b.getEffectiveWeight(), 0.5);
  close(position(root), 15);
  mixer.update(1);
  close(position(root), 20);
  assert.equal(a.enabled, false);
  a.reset().play().setEffectiveWeight(0.4).fadeIn(2);
  b.stop();
  mixer.update(1);
  close(a.getEffectiveWeight(), 0.2);
  close(position(root), 2);
  mixer.update(1);
  close(a.getEffectiveWeight(), 0.4);
});

test('warp uses signed absolute rates, zero duration, halt and global pause', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root),
    action = mixer.clipAction(clip('long', [0, 0, 0], [20, 0, 0], 20)).play();
  action.warp(1, 3, 2);
  mixer.update(1);
  close(action.time, 2);
  close(action.getEffectiveTimeScale(), 2);
  mixer.update(1);
  close(action.time, 5);
  close(action.timeScale, 3);
  action.warp(-2, -2, 0);
  mixer.update(1);
  close(action.time, 3);
  action.halt(1);
  mixer.update(1);
  assert.equal(action.paused, true);
  close(action.getEffectiveTimeScale(), 0);
  action.paused = false;
  action.setEffectiveTimeScale(2);
  mixer.timeScale = 0;
  mixer.update(10);
  close(action.time, 3);
  mixer.timeScale = 1;
  action.fadeOut(0);
  mixer.update(0);
  close(action.getEffectiveWeight(), 0);
});

test('effective weight and rate follow assignments before the next update, so halt warps from the set rate', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root),
    a = mixer.clipAction(clip('a', [0, 0, 0], [10, 0, 0], 10));
  a.timeScale = 2;
  a.weight = 0.5;
  a.play();
  assert.equal(a.getEffectiveTimeScale(), 2);
  assert.equal(a.getEffectiveWeight(), 0.5);
  a.halt(1);
  assert.equal(a.getEffectiveTimeScale(), 2);
  mixer.update(0.5);
  close(a.getEffectiveTimeScale(), 1);
  close(a.time, 0.5);
  a.fadeOut(1);
  assert.equal(a.getEffectiveWeight(), 0.5);
  mixer.update(0.5);
  close(a.getEffectiveWeight(), 0.25);
  a.enabled = false;
  assert.equal(a.getEffectiveWeight(), 0);
});
test('warped crossfade matches cycle rates for different durations', () => {
  const mixer = new AnimationMixer(skeleton());
  const a = mixer.clipAction(clip('short', [0, 0, 0], [1, 0, 0], 1)).play(),
    b = mixer.clipAction(clip('long', [0, 0, 0], [1, 0, 0], 2)).play();
  a.crossFadeTo(b, 1, true);
  mixer.update(0.5);
  close(a.getEffectiveTimeScale(), 0.75);
  close(b.getEffectiveTimeScale(), 1.5);
  close(a.time, 0.375);
  close(b.time, 0.75);
});

test('repeat, once and ping-pong cover exact endpoints, backwards and multi-loop jumps', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root),
    action = mixer.clipAction(clip('travel', [0, 0, 0], [10, 0, 0])).play();
  mixer.update(1.25);
  close(position(root), 2.5);
  action.setEffectiveTimeScale(-1);
  mixer.update(0.5);
  close(action.time, 0.75);
  close(position(root), 7.5);
  action.reset().setLoop(LoopOnce).setEffectiveTimeScale(1).play();
  action.clampWhenFinished = true;
  mixer.update(2);
  close(position(root), 10);
  assert.equal(action.paused, true);
  action.reset().setLoop(LoopPingPong, 2).play();
  mixer.update(1.5);
  close(position(root), 5);
  mixer.update(0.5);
  close(position(root), 0);
  assert.equal(action.paused, true);
  action.reset().setLoop(LoopRepeat, 3).play();
  mixer.update(3.25);
  close(position(root), 10);
  assert.equal(action.paused, true);
});

test('quaternions use a shortest arc; additive translation, scale and rotations compose', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root),
    s = Math.SQRT1_2;
  mixer
    .clipAction(clip('turn', [0, 0, 0, 1], [0, 0, s, s], 1, 'rotation'))
    .play()
    .setEffectiveWeight(0.5);
  mixer.update(0.5);
  const q = root.getPose(0).rotation;
  close(q[2], Math.sin(Math.PI / 16));
  close(q[3], Math.cos(Math.PI / 16));
  mixer
    .clipAction(clip('delta', [2, 0, 0], [2, 0, 0]), root, AdditiveAnimationBlendMode)
    .play()
    .setEffectiveWeight(0.5);
  mixer
    .clipAction(clip('scale', [2, 2, 2], [2, 2, 2], 1, 'scale'), root, AdditiveAnimationBlendMode)
    .play()
    .setEffectiveWeight(0.5);
  mixer.update(0);
  close(position(root), 1);
  close(root.getPose(0).scale[0], 1.5);
});

test('property-only clips bind once, restore originals and uncache releases their writes', () => {
  const target = { value: 3 },
    root = skeleton(),
    mixer = new AnimationMixer(root);
  const c = createKeyframeClip({
    tracks: [
      {
        target,
        property: 'value',
        keys: [
          { time: 0, value: [5] },
          { time: 1, value: [9] },
        ],
      },
    ],
  });
  mixer.clipAction(c).play();
  mixer.update(0.5);
  close(target.value, 7);
  mixer.uncacheAction(c);
  close(target.value, 3);
  target.value = 19;
  mixer.update(0);
  close(target.value, 19);
  assert.equal(mixer.existingAction(c), null);
});

test('glTF clips retain sparse channels and drive the real Animation model', async (t) => {
  const engine = await ownerEngine(t),
    data = skinnedStrip({ extraClip: true }),
    model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
  const animation = new Animation(model),
    mixer = new AnimationMixer(animation);
  t.after(() => {
    mixer.dispose();
    animation.dispose();
    model.dispose();
  });
  assert.equal(animation.playing, false);
  const bend = mixer.clipAction('bend').play().setEffectiveWeight(0.5),
    lift = mixer.clipAction('lift').play();
  mixer.update(0.5);
  close(bend.time, 0.5);
  close(lift.time, 0.5);
  const tfs = engine.store.transforms,
    joint = model.nodes[2].id,
    root = model.nodes[1].id;
  close(tfs.qz[joint], Math.sin(Math.PI / 16));
  close(tfs.y[root], 0.25);
  mixer.stopAllAction();
  close(tfs.qz[joint], 0);
  close(tfs.y[root], 0);
});

test('invalid inputs reject before crossfade mutation; disposal is terminal and idempotent', () => {
  const mixer = new AnimationMixer(skeleton()),
    c = clip('a', [0, 0, 0], [1, 0, 0]),
    a = mixer.clipAction(c),
    other = new AnimationMixer(skeleton()).clipAction(c);
  assert.throws(() => a.crossFadeTo(other, 1), { code: 'arguments' });
  for (const n of [NaN, Infinity, -1]) assert.throws(() => a.fadeIn(n), { code: 'arguments' });
  assert.throws(() => a.setLoop(LoopRepeat, 1.5), { code: 'arguments' });
  assert.throws(() => a.setDuration(0), { code: 'arguments' });
  assert.throws(() => mixer.update(Infinity), { code: 'arguments' });
  mixer.dispose();
  mixer.dispose();
  assert.throws(() => mixer.clipAction(c), { code: 'disposed' });
  assert.throws(() => a.play(), { code: 'disposed' });
});

test('original properties are captured at first play and restored immediately on final stop', () => {
  const root = skeleton(),
    mixer = new AnimationMixer(root),
    action = mixer.clipAction(clip('pose', [12, 0, 0], [12, 0, 0]));
  root.setPose(0, { translation: [7, 0, 0] });
  action.play().setEffectiveWeight(0.5);
  mixer.update(0);
  close(position(root), 9.5);
  action.stop();
  close(position(root), 7);
  root.setPose(0, { translation: [9, 0, 0] });
  action.play();
  mixer.update(0);
  close(position(root), 10.5);
  action.stop();
  close(position(root), 9);
});

test('mixer registers in its own scene and disposal preserves a same-name plugin elsewhere', async (t) => {
  const engine = await ownerEngine(t),
    scene = engine.createScene('mixer-owner'),
    mixer = new AnimationMixer(skeleton());
  scene.use(mixer);
  const sentinel = { name: mixer.name, setup() {} };
  engine.use(sentinel);
  mixer.dispose();
  assert.equal(engine.sceneOf(mixer), undefined);
  assert.equal(engine.plugins.get(sentinel.name), sentinel);
  assert.throws(() => mixer.setup(engine), { code: 'disposed' });
});

test('model roots register owned Animation in the model scene, and tolerate model disposal', async (t) => {
  const engine = await ownerEngine(t),
    scene = engine.createScene('model-owner');
  let model;
  scene.use({
    name: 'create-model',
    setup() {
      const data = skinnedStrip();
      model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
    },
  });
  scene.removePlugin('create-model');
  const mixer = new AnimationMixer(model),
    owned = scene.plugins.get('animation:' + model.name);
  assert.ok(owned instanceof Animation);
  assert.equal(engine.sceneOf(owned), scene);
  mixer.clipAction('bend').play();
  mixer.update(0.5);
  model.dispose();
  mixer.update(0.1);
  mixer.dispose();
  assert.equal(engine.sceneOf(owned), undefined);
});

test('attach registers a mixer that updates actions and detaches on disposal', async (t) => {
  const engine = await ownerEngine(t), root = skeleton();
  const mixer = AnimationMixer.attach(engine, root);
  assert.equal(engine.hasPlugin(mixer.name), true);
  mixer.clipAction(clip('move', [0, 0, 0], [10, 0, 0])).play();
  engine.render({ delta: 0.5 });
  close(position(root), 5);
  mixer.dispose();
  assert.equal(engine.hasPlugin(mixer.name), false);
  assert.throws(() => mixer.update(0), { code: 'disposed' });
});
