import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { Animation as BaseAnimation } from '../dist/index.js';
import { Animation, PlaybackAnimation, LoopOnce, LoopRepeat, LoopPingPong } from '../dist/playback.js';
import { PBRModel, GLTFAsset } from '../../gltf-pro/dist/index.js';
import { ownerEngine } from './owner-lifetime.fixture.js';
import { skinnedStrip } from '../test/fixture.js';

async function make(t, options = {}) {
  const engine = await ownerEngine(t),
    data = skinnedStrip(),
    model = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
  const animation = new Animation(model, options);
  t.after(() => {
    animation.dispose();
    model.dispose();
  });
  return { engine, model, animation };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('optional plain Animation remains a base Animation and starts at the first key', async (t) => {
  const { animation } = await make(t);
  assert.ok(animation instanceof BaseAnimation);
  assert.ok(animation instanceof PlaybackAnimation);
  const initial = animation.finished;
  animation.play('bend');
  assert.equal(animation.finished, initial);
  close(animation.time, 0);
  animation.onPreUpdate(0.25);
  close(animation.time, 0.25);
});
test('repeat count, multi-loop event delta, exact last pose and completion promise', async (t) => {
  const { animation } = await make(t, { repetitions: 3 });
  const events = [];
  animation.on('loop', (e) => events.push(['loop', e.loopDelta, animation.time]));
  animation.on('finished', (e) => events.push(['finished', e.direction, animation.time]));
  animation.play();
  const done = animation.finished;
  animation.onPreUpdate(0.75);
  animation.onPreUpdate(1.5);
  close(animation.time, 0.25);
  animation.onPreUpdate(0.75);
  close(animation.time, 1);
  assert.equal(animation.playing, false);
  const result = await done;
  assert.equal(result.animation, animation);
  assert.equal(result.type, 'finished');
  assert.deepEqual(events, [
    ['loop', 2, 0.25],
    ['finished', 1, 1],
  ]);
  animation.onPreUpdate(2);
  assert.equal(events.length, 2);
});
test('ping-pong samples endpoints without wrapping and counts each traversal', async (t) => {
  const { animation, model, engine } = await make(t, { loopMode: LoopPingPong, repetitions: 2 });
  animation.play();
  const times = [];
  let loops = 0;
  animation.addEventListener('loop', (e) => (loops += e.loopDelta));
  for (let i = 0; i < 4; i++) {
    animation.onPreUpdate(0.5);
    times.push(animation.time);
  }
  assert.deepEqual(times, [0.5, 1, 0.5, 0]);
  assert.equal(loops, 1);
  await animation.finished;
  const qz = engine.store.transforms.qz[model.nodes[2].id];
  close(qz, 0);
});
test('once honors legacy loop=false, speed, pause, and holds the end', async (t) => {
  const { animation } = await make(t, { loop: false, speed: 2 });
  animation.play();
  animation.playing = false;
  animation.onPreUpdate(2);
  close(animation.time, 0);
  animation.playing = true;
  animation.onPreUpdate(0.25);
  close(animation.time, 0.5);
  animation.onPreUpdate(1);
  close(animation.time, 1);
  await animation.finished;
});
test('reverse once starts at the last key and finishes at the first', async (t) => {
  const { animation } = await make(t, { loopMode: LoopOnce, timeScale: -1 });
  animation.play();
  close(animation.time, 1);
  animation.onPreUpdate(0.25);
  close(animation.time, 0.75);
  animation.onPreUpdate(0.75);
  close(animation.time, 0);
  assert.equal((await animation.finished).direction, -1);
});
test('reverse repeat and ping-pong preserve direction and exact terminal poses', async (t) => {
  for (const mode of [LoopRepeat, LoopPingPong]) {
    const { animation } = await make(t, { loopMode: mode, repetitions: 2, timeScale: -1 });
    animation.play();
    let loops = 0;
    animation.on('loop', (e) => (loops += e.loopDelta));
    animation.onPreUpdate(1.5);
    close(animation.time, 0.5);
    assert.equal(loops, -1);
    animation.onPreUpdate(0.5);
    close(animation.time, mode === LoopRepeat ? 0 : 1);
    assert.equal(animation.playing, false);
    await animation.finished;
  }
});
test('seeking emits no events; zero rate stops; setLoop preserves the clock', async (t) => {
  const { animation } = await make(t);
  animation.play();
  let loops = 0;
  animation.on('loop', () => loops++);
  animation.seek(2.25);
  close(animation.time, 0.25);
  assert.equal(loops, 0);
  animation.timeScale = 0;
  animation.onPreUpdate(4);
  close(animation.time, 0.25);
  animation.setLoop(LoopPingPong, 4);
  animation.timeScale = 1;
  animation.onPreUpdate(0.25);
  close(animation.time, 0.5);
});
test('finished promise renews and rejects an interrupted run with AbortError', async (t) => {
  const { animation } = await make(t, { loop: false });
  animation.play();
  const first = animation.finished;
  animation.play();
  await assert.rejects(first, { name: 'AbortError' });
  const second = animation.finished;
  assert.notEqual(first, second);
  animation.onPreUpdate(1);
  await second;
  animation.play();
  assert.notEqual(second, animation.finished);
});
test('subscriber abort and independent wait cancellation release listeners without stopping playback', async (t) => {
  const { animation } = await make(t, { repetitions: 2 });
  animation.play();
  const sub = new AbortController(),
    wait = new AbortController();
  let events = 0;
  animation.on('loop', () => events++, { signal: sub.signal });
  const pending = animation.waitForFinished({ signal: wait.signal });
  assert.equal(getEventListeners(wait.signal, 'abort').length, 1);
  wait.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(wait.signal, 'abort').length, 0);
  sub.abort();
  animation.onPreUpdate(1);
  assert.equal(events, 0);
  assert.equal(animation.playing, true);
  animation.onPreUpdate(1);
  await animation.finished;
});
test('disposal and caller abort reject pending completion and remove the owning abort listener', async (t) => {
  const signal = new AbortController(),
    { animation } = await make(t, { signal: signal.signal });
  animation.play();
  const pending = animation.finished;
  assert.equal(getEventListeners(signal.signal, 'abort').length, 1);
  signal.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
  animation.dispose();
  assert.throws(() => animation.play(), { code: 'disposed' });
});
test('attach uses the model scene and already-aborted attachment never registers', async (t) => {
  const { engine, model } = await make(t);
  const scene = engine.createScene('playback-owner');
  let other;
  scene.use({
    name: 'make-model',
    setup() {
      const data = skinnedStrip();
      other = new PBRModel(engine, new GLTFAsset(data.doc, data.buffers));
    },
  });
  scene.removePlugin('make-model');
  const animation = Animation.attach(other, { loop: false });
  t.after(() => {
    animation.dispose();
    other.dispose();
  });
  assert.equal(engine.sceneOf(animation), scene);
  const signal = new AbortController();
  signal.abort();
  const stopped = Animation.attach(model, { signal: signal.signal });
  await assert.rejects(stopped.finished, { name: 'AbortError' });
  assert.equal(engine.sceneOf(stopped), undefined);
});
test('invalid loop/rate/count rejects before advancing; zero duration resolves once', async (t) => {
  const { animation } = await make(t);
  animation.play();
  assert.throws(() => animation.setLoop(LoopRepeat, 1.5), { code: 'arguments' });
  assert.equal(animation.repetitions, Infinity);
  animation.timeScale = NaN;
  assert.throws(() => animation.onPreUpdate(1), { code: 'arguments' });
  close(animation.time, 0);
  animation.timeScale = 1;
  assert.throws(() => animation.onPreUpdate(-1), { code: 'arguments' });
  const clip = animation.clips[0];
  clip.duration = 0;
  animation.onPreUpdate(0);
  close(animation.time, 0);
  await animation.finished;
});
test('listeners see the final pose and can start another clip reentrantly', async (t) => {
  const { animation } = await make(t, { loop: false });
  animation.play();
  const first = animation.finished;
  let seen;
  animation.on('finished', () => {
    seen = animation.time;
    animation.play();
  });
  animation.onPreUpdate(1);
  await first;
  close(seen, 1);
  assert.equal(animation.playing, true);
  close(animation.time, 0);
  animation.onPreUpdate(0.25);
  close(animation.time, 0.25);
});

test('failed attachment releases the caller abort subscription', async (t) => {
  const { model } = await make(t),
    signal = new AbortController(),
    scene = model.root.scene;
  const use = scene.use;
  scene.use = () => {
    throw new Error('setup-failure');
  };
  try {
    assert.throws(() => Animation.attach(model, { signal: signal.signal }), /setup-failure/);
  } finally {
    scene.use = use;
  }
  assert.equal(getEventListeners(signal.signal, 'abort').length, 0);
});
