import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener, PositionalAudio } from '../dist/index.js';
import { AudioDoppler } from '../dist/doppler.js';
import { FakeAudioContext } from './fake-web-audio.js';

function scene(options) {
  const context = new FakeAudioContext();
  const listener = new AudioListener({ context, smoothing: 0, autoResume: false });
  listener.follow(null);
  const sound = new PositionalAudio(listener, { playbackRate: 1.5, detune: 100, volume: 0.4 });
  sound.setBuffer(context.createBuffer(1, 480000, 48000));
  sound.setPosition(10, 0, 0).play();
  const control = new AudioDoppler(sound, options);
  listener.update();
  return { context, listener, sound, control };
}
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);

test('source and listener radial velocities have distinct Doppler ratios, with authored pitch preserved', () => {
  const s = scene({ speedOfSound: 100 });
  s.context.currentTime = 0.1;
  s.sound.setPosition(9, 0, 0);
  s.listener.update();
  close(s.control.ratio, 100 / 90);
  close(s.sound.playbackRate, 1.5 * 100 / 90);
  assert.equal(s.sound.detune, 100);
  assert.equal(s.sound.volume, 0.4);
  s.context.currentTime = 0.2;
  s.sound.setPosition(10, 0, 0);
  s.listener.update();
  close(s.control.ratio, 100 / 110);
  s.context.currentTime = 0.3;
  s.listener.setPose([1, 0, 0], [0, 0, -1], [0, 1, 0]);
  s.listener.update();
  close(s.control.ratio, 1.1);
  s.control.playbackRate = 2;
  close(s.sound.playbackRate, 2.2);
  s.context.currentTime = 0.4;
  s.listener.setPose([0, 0, 0], [0, 0, -1], [0, 1, 0]);
  s.listener.update();
  close(s.control.ratio, 0.9);
  s.listener.dispose();
  assert.equal(s.sound.playbackRate, 2);
});

test('co-motion, transverse motion, stationary and coincident positions stay neutral', () => {
  const s = scene();
  s.context.currentTime = 1;
  s.sound.setPosition(11, 0, 0);
  s.listener.setPose([1, 0, 0], [0, 0, -1], [0, 1, 0]);
  s.listener.update();
  close(s.control.ratio, 1);
  // End separation points along X; both Y displacements are perpendicular to it.
  s.control.reset();
  s.listener.setPose([1, 1, 0], [0, 0, -1], [0, 1, 0]);
  s.listener.update();
  s.context.currentTime = 2;
  s.sound.setPosition(11, 1, 0);
  s.listener.update();
  close(s.control.ratio, 1);
  s.context.currentTime = 3;
  s.listener.update();
  close(s.control.ratio, 1);
  s.context.currentTime = 4;
  s.sound.setPosition(1, 1, 0);
  s.listener.update();
  close(s.control.ratio, 1);
  s.listener.dispose();
});

test('same-clock updates preserve samples; reset handles teleports; supersonic projections stay bounded', () => {
  const s = scene({ speedOfSound: 100 });
  s.sound.setPosition(9, 0, 0);
  s.listener.update();
  close(s.control.ratio, 1);
  s.context.currentTime = 0.1;
  s.listener.update();
  close(s.control.ratio, 100 / 90);
  s.sound.setPosition(10000, 0, 0);
  s.control.reset();
  s.listener.update();
  s.context.currentTime = 0.2;
  s.listener.update();
  close(s.control.ratio, 1);
  s.context.currentTime = 0.3;
  s.sound.setPosition(1, 0, 0);
  s.listener.setPose([0.9, 0, 0], [0, 0, -1], [0, 1, 0]);
  s.listener.update();
  assert.ok(s.control.ratio > 1 && s.control.ratio <= 39);
  s.context.currentTime = -1;
  s.listener.update();
  close(s.control.ratio, 1);
  s.control.dispose();
  s.control.dispose();
  close(s.sound.playbackRate, 1.5);
  assert.throws(() => s.control.update(), (e) => e.code === 'disposed' && /https:/.test(e.message));
  s.listener.dispose();
});

test('controller follows new buffer sources and uses existing playback-rate smoothing', () => {
  const s = scene({ speedOfSound: 100 });
  s.listener.smoothing = 0.02;
  s.context.state = 'running';
  s.context.currentTime = 0.1;
  s.sound.setPosition(9, 0, 0);
  s.listener.update();
  assert.deepEqual(s.sound.source.playbackRate.last(), ['target', 1.5 * 100 / 90, 0.1, 0.02]);
  s.sound.pause().play();
  close(s.sound.source.playbackRate.value, s.sound.playbackRate);
  s.control.dispose();
  s.listener.dispose();
});

test('invalid options and unsupported sources give coded help errors without attaching a controller', () => {
  const s = scene();
  assert.throws(() => new AudioDoppler(s.sound), (e) => e.code === 'attached' && /errors#state/.test(e.message));
  s.control.dispose();
  for (const speedOfSound of [0, -1, NaN, Infinity])
    assert.throws(() => new AudioDoppler(s.sound, { speedOfSound }), (e) => e instanceof RangeError && /https:/.test(e.message));
  for (const playbackRate of [-1, NaN, Infinity, 1e38])
    assert.throws(() => new AudioDoppler(s.sound, { playbackRate }), RangeError);
  s.sound.setNodeSource(s.context.createGain());
  assert.throws(() => new AudioDoppler(s.sound), (e) => e.code === 'unsupported');
  s.listener.dispose();
});

test('disposing a sound unregisters its controller on the next listener frame', () => {
  const s = scene();
  s.sound.dispose();
  s.listener.update();
  assert.throws(() => s.control.update(), (e) => e.code === 'disposed');
  s.listener.dispose();
});
