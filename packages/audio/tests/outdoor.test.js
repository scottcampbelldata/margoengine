// OutdoorAudio (@margoengine/audio/outdoor): the filter chain it puts on a positional sound and the numbers it writes
// from a solved path. The browser rendering is checked in outdoor-sound.browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { AudioListener, PositionalAudio } from '../dist/index.js';
import { OutdoorAudio } from '../dist/outdoor.js';
import { FakeAudioContext, FakeNode, FakeParam } from './fake-web-audio.js';

async function scene() {
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(32),
    { backend: 'webgpu', gpu: null, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 4], target: [0, 0, 0] },
    null,
  );
  const context = new FakeAudioContext();
  context.createDelay = (longest) =>
    Object.assign(new FakeNode(context, 'delay'), { delayTime: new FakeParam(0), longest });
  // The shared stand-in's biquad has no shelf gain.
  const biquad = context.createBiquadFilter.bind(context);
  context.createBiquadFilter = () => Object.assign(biquad(), { gain: new FakeParam(0) });
  const listener = new AudioListener({ context, autoResume: false });
  listener.setup(engine);
  const sound = new PositionalAudio(listener, { mesh: engine.createMesh().setGeometry(box()), rolloffFactor: 2 });
  return {
    context,
    listener,
    sound,
    update() {
      engine.store.tick();
      listener.update();
    },
    dispose() {
      listener.dispose();
      engine.dispose();
    },
  };
}

const gainDb = [-2, -3, -4, -5, -6, -8, -11, -14];

test('a path sets the delay, the level and the two shelves, and follows later paths', async (t) => {
  const s = await scene();
  t.after(() => s.dispose());
  const own = s.context.createGain();
  s.sound.setFilters([own]);
  let path = { delaySeconds: 0.5, gainDb };
  const outdoor = new OutdoorAudio(s.sound, () => path, { maxDelay: 2, smoothing: 0.1 });
  const [first, delay, bass, treble, level] = s.sound.getFilters();
  assert.equal(first, own);
  assert.equal(delay.longest, 2);
  assert.equal(delay.delayTime.value, 0.5);
  assert.ok(Math.abs(level.gain.value - 10 ** (-6 / 20)) < 1e-12);
  assert.equal(bass.gain.value, 4);
  assert.equal(treble.gain.value, -8);
  assert.deepEqual([bass.type, treble.type], ['lowshelf', 'highshelf']);
  assert.equal(s.sound.rolloffFactor, 0);
  // A running context takes later paths smoothly.
  s.context.state = 'running';
  path = { delaySeconds: 1, gainDb };
  s.update();
  assert.deepEqual(delay.delayTime.last(), ['target', 1, 0, 0.1]);
  outdoor.dispose();
  outdoor[Symbol.dispose]();
  assert.deepEqual(s.sound.getFilters(), [own]);
  assert.equal(s.sound.rolloffFactor, 2);
});

test('one controller a sound; bad options and paths are refused', async (t) => {
  const s = await scene();
  t.after(() => s.dispose());
  const good = () => ({ delaySeconds: 0, gainDb });
  assert.throws(() => new OutdoorAudio(s.sound, good, null), { name: 'MargoError', code: 'unsupported' });
  assert.throws(() => new OutdoorAudio(s.sound, good, { maxDelay: 0 }), { name: 'MargoError', code: 'unsupported' });
  assert.throws(() => new OutdoorAudio(s.sound, good, { smoothing: -1 }), { name: 'MargoError', code: 'unsupported' });
  assert.throws(() => new OutdoorAudio(s.sound, () => ({ delaySeconds: 31, gainDb })), /delay line/);
  assert.throws(() => new OutdoorAudio(s.sound, () => ({ delaySeconds: 0, gainDb: [0] })), /eight-band/);
  const outdoor = new OutdoorAudio(s.sound, good);
  assert.throws(() => new OutdoorAudio(s.sound, good), { code: 'attached' });
  outdoor.dispose();
  new OutdoorAudio(s.sound, good).dispose();
});

test('an invalid band or unrepresentable path gain changes none of the audio parameters', async (t) => {
  const s = await scene();
  t.after(() => s.dispose());
  let path = { delaySeconds: 0.125, gainDb };
  const outdoor = new OutdoorAudio(s.sound, () => path, { maxDelay: 2 });
  t.after(() => outdoor.dispose());
  const [delay, bass, treble, level] = s.sound.getFilters();
  const current = () => [delay.delayTime.value, bass.gain.value, treble.gain.value, level.gain.value];
  const accepted = current();
  path = { delaySeconds: 0.25, gainDb: gainDb.map((db, i) => (i === 3 ? NaN : db)) };
  assert.throws(() => outdoor.update(), { name: 'MargoError', code: 'unsupported' });
  assert.deepEqual(current(), accepted);
  path = { delaySeconds: 0.25, gainDb: gainDb.map((db, i) => (i === 4 ? 900 : db)) };
  assert.throws(() => outdoor.update(), { name: 'MargoError', code: 'failed' });
  assert.deepEqual(current(), accepted);
  path = { delaySeconds: 0.25, gainDb };
  outdoor.update();
  assert.equal(delay.delayTime.value, 0.25);
});
