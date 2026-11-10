import test from 'node:test';
import assert from 'node:assert/strict';
import { Audio, AudioListener, PositionalAudio } from '../dist/index.js';
import { AudioVoiceManager } from '@margoengine/audio/voices';
import { FakeAudioContext } from './fake-web-audio.js';

function setup(options = {}) {
  const context = new FakeAudioContext({ state: 'suspended' }),
    listener = new AudioListener({ context, smoothing: 0 });
  const manager = new AudioVoiceManager(listener, { maxVoices: 1, ...options });
  const buffer = context.createBuffer(1, 480000, 48000);
  const sound = (opts = {}) => new Audio(listener, { loop: true, ...opts }).setBuffer(buffer);
  return { context, listener, manager, sound, buffer };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);

test('global cap, deterministic ties, priority, threshold and zero-source virtualization', () => {
  const s = setup(),
    a = s.manager.add(s.sound()),
    b = s.manager.add(s.sound());
  a.play();
  b.play();
  assert.equal(s.manager.activeCount, 1);
  assert.equal(s.manager.virtualCount, 1);
  assert.equal(a.isVirtual, false);
  assert.equal(b.isVirtual, true);
  assert.equal(s.context.bufferSources.length, 1);
  b.priority = 1;
  assert.equal(a.isVirtual, true);
  assert.equal(b.isVirtual, false);
  s.manager.maxVoices = 0;
  assert.equal(s.manager.activeCount, 0);
  assert.equal(s.manager.virtualCount, 2);
  s.manager.maxVoices = 2;
  assert.equal(s.manager.activeCount, 2);
  a.sound.volume = 0;
  s.manager.update();
  assert.equal(a.isVirtual, true);
  a.sound.volume = 1;
  s.manager.update();
  assert.equal(a.isVirtual, false);
  s.listener.dispose();
  assert.equal(a.sound.isDisposed, true);
  s.manager.dispose();
  a.dispose();
});

test('virtual phases include pitch, detune, loop region, suspension, seeks and one-shot natural completion', () => {
  const s = setup({ maxVoices: 0 }),
    sound = s.sound({ offset: 1, loopStart: 2, loopEnd: 4, playbackRate: 2, detune: 1200 });
  const voice = s.manager.add(sound).play();
  s.context.currentTime = 1;
  near(voice.currentTime, 3);
  s.manager.maxVoices = 1;
  near(s.context.bufferSources.at(-1).started.offset, 3);
  s.context.currentTime = 1.125;
  voice.pause();
  near(voice.currentTime, 3.5);
  s.context.currentTime = 5;
  near(voice.currentTime, 3.5);
  voice.playbackRate = 1;
  voice.detune = 0;
  voice.play();
  s.manager.maxVoices = 0;
  s.context.currentTime = 5.75;
  near(voice.currentTime, 2.25);
  voice.seek(3.75);
  s.manager.maxVoices = 1;
  near(s.context.bufferSources.at(-1).started.offset, 3.75);
  voice.stop();
  near(voice.currentTime, 1);
  assert.equal(voice.isPlaying, false);
  let ended = 0;
  const once = s.manager.add(s.sound({ loop: false, offset: 1, duration: 2, onEnded: () => ended++ }));
  s.manager.maxVoices = 0;
  once.play();
  s.context.currentTime = 8;
  s.manager.update();
  assert.equal(once.isPlaying, false);
  near(once.currentTime, 3);
  assert.equal(ended, 1);
  s.manager.update();
  assert.equal(ended, 1);
  s.listener.dispose();
});

test('physical natural ends notify once; releasing a handle preserves the caller-owned sound', () => {
  const s = setup();
  let ended = 0;
  const sound = s.sound({ loop: false, duration: 1, onEnded: () => ended++ }),
    voice = s.manager.add(sound).play();
  s.context.currentTime = 1;
  s.context.bufferSources.at(-1).end();
  assert.equal(ended, 1);
  s.manager.update();
  assert.equal(ended, 1);
  assert.equal(voice.isPlaying, false);
  voice.dispose();
  assert.equal(sound.isDisposed, false);
  s.manager.add(sound).dispose();
  s.listener.dispose();
});

test('positional distance/cone, current pose and app gain rank all registered sounds', () => {
  const s = setup();
  const far = new PositionalAudio(s.listener, { loop: true }).setBuffer(s.buffer).setPosition(0, 0, -10);
  const nearSound = new PositionalAudio(s.listener, { loop: true }).setBuffer(s.buffer).setPosition(0, 0, -2);
  const a = s.manager.add(far).play(),
    b = s.manager.add(nearSound).play();
  assert.equal(a.isVirtual, true);
  far.setPosition(0, 0, -1);
  s.listener.update();
  assert.equal(a.isVirtual, false);
  assert.equal(b.isVirtual, true);
  let gain = 0;
  const c = s.manager.add(s.sound(), { priority: 2, gain: () => gain }).play();
  assert.equal(c.isVirtual, true);
  gain = 0.1;
  s.manager.update();
  assert.equal(c.isVirtual, false);
  s.listener.dispose();
});

test('validation and disposed/duplicate/source ownership errors', () => {
  const s = setup(),
    sound = s.sound(),
    a = s.manager.add(sound);
  assert.throws(
    () => s.manager.add(sound),
    (e) => e.code === 'attached',
  );
  assert.throws(
    () => s.manager.add(new Audio(s.listener)),
    (e) => e.code === 'unsupported',
  );
  for (const cap of [-1, NaN, 1.5]) assert.throws(() => (s.manager.maxVoices = cap));
  for (const priority of [NaN, Infinity]) assert.throws(() => (a.priority = priority));
  for (const pitch of [NaN, Infinity, -1]) assert.throws(() => (a.playbackRate = pitch));
  assert.throws(() => (a.detune = Infinity));
  assert.throws(() => a.seek(-1));
  s.manager.dispose();
  assert.equal(sound.isDisposed, false);
  assert.throws(
    () => a.play(),
    (e) => e.code === 'disposed',
  );
  s.listener.dispose();
});

test('seeking an ended one-shot keeps the seek for the next play', () => {
  const s = setup({ maxVoices: 0 });
  const voice = s.manager.add(s.sound({ loop: false, offset: 1, duration: 2 })).play();
  s.context.currentTime = 3;
  s.manager.update();
  assert.equal(voice.isPlaying, false);
  voice.seek(1.5).play();
  near(voice.currentTime, 1.5);
  s.context.currentTime = 3.5;
  near(voice.currentTime, 2);
  assert.equal(voice.isPlaying, true);
  s.listener.dispose();
});
