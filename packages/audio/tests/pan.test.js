import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { StereoAudio } from '@margoengine/audio/pan';
import { FakeAudioContext, FakeNode, FakeParam } from './fake-web-audio.js';

test('stereo graph, pan validation, smoothing, source lifecycle and teardown', () => {
  const context = new FakeAudioContext({ state: 'running' });
  context.createStereoPanner = () => Object.assign(new FakeNode(context, 'stereo-panner'), { pan: new FakeParam(0) });
  const listener = new AudioListener({ context, smoothing: 0.02 });
  assert.throws(() => new StereoAudio(listener, { pan: NaN }), /Pan/);
  const sound = new StereoAudio(listener, { pan: -1 });
  assert.equal(sound.getOutput(), sound.panner);
  assert.deepEqual([...sound.gain.outputs], [sound.panner]);
  assert.deepEqual([...sound.panner.outputs], [listener.input]);
  assert.equal(sound.pan, -1);
  sound.pan = 0.5;
  assert.deepEqual(sound.panner.pan.last(), ['target', 0.5, 0, 0.02]);
  for (const pan of [-2, 2, Infinity, NaN])
    assert.throws(() => {
      sound.pan = pan;
    });
  assert.equal(sound.pan, 0.5);
  sound.setBuffer(context.createBuffer(1, 48000, 48000)).play();
  sound.pause();
  sound.play();
  assert.equal(sound.isPlaying, true);
  listener.dispose();
  assert.equal(sound.panner.outputs.size, 0);
  assert.equal(sound.isDisposed, true);
  sound.dispose();
  assert.throws(
    () => {
      sound.pan = 0;
    },
    (e) => e.code === 'disposed',
  );
});

test('unsupported panner fails before registering or allocating a sound', () => {
  const listener = new AudioListener({ context: new FakeAudioContext() });
  assert.throws(
    () => new StereoAudio(listener),
    (e) => e.code === 'unsupported',
  );
  listener.dispose();
});
