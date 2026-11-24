import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { AudioEventContainer } from '../dist/events.js';
import { FakeAudioContext } from './fake-web-audio.js';

function setup() {
  const context = new FakeAudioContext();
  const listener = new AudioListener({ context, autoResume: false });
  const buffers = [1, 2, 3].map(n => context.createBuffer(1, n * 4800, 48000));
  return {context, listener, buffers};
}

test('sequence wraps, variation is per play, cooldown rejects without advancing or drawing', () => {
  const s = setup();
  let draws = 0;
  const container = new AudioEventContainer(s.listener, s.buffers, {
    mode: 'sequence', voices: 2, cooldown: 0.25,
    volume: [0.5, 1], pitch: [-1200, 1200], random: () => { draws++; return 0.75; },
  });
  const first = container.play([1, 2, 3]);
  assert.equal(first.buffer, s.buffers[0]);
  assert.equal(first.volume, 0.875);
  assert.equal(first.playbackRate, Math.SQRT2);
  assert.deepEqual([...first.worldPosition], [1, 2, 3]);
  assert.equal(first.source.playbackRate.value, Math.SQRT2);
  assert.equal(container.play(), null);
  assert.equal(draws, 2);
  assert.equal(container.lastIndex, 0);
  s.context.currentTime = 0.25;
  assert.equal(container.play().buffer, s.buffers[1]);
  s.context.currentTime = 0.5;
  assert.equal(container.play().buffer, s.buffers[2]);
  s.context.currentTime = 0.75;
  assert.equal(container.play().buffer, s.buffers[0]);
  container.stopAll();
  assert.equal(first.isPlaying, false);
  s.listener.dispose();
  assert.throws(() => container.play(), e => e.code === 'disposed' && /errors#disposed/.test(e.message));
});

test('random selection is uniform over all indices except the preceding one, including both endpoints', () => {
  const s = setup();
  let value = 0;
  const container = new AudioEventContainer(s.listener, s.buffers, {random: () => value});
  const indices = [];
  for (const draw of [0, 0, 0, 0.999999, 0.999999, 0.5]) {
    value = draw;
    const voice = container.play();
    indices.push(container.lastIndex);
    assert.equal(voice.buffer, s.buffers[container.lastIndex]);
  }
  assert.deepEqual(indices, [0, 1, 0, 2, 1, 2]);
  container.dispose();
  container.dispose();
  const single = new AudioEventContainer(s.listener, [s.buffers[0]], {random: () => { throw new Error('No draw needed'); }});
  for (let i = 0; i < 6; i++) assert.equal(single.play().buffer, s.buffers[0]);
  s.listener.dispose();
});

test('voices overlap and stealing is bounded per buffer; disposal releases every graph', () => {
  const s = setup();
  const container = new AudioEventContainer(s.listener, [s.buffers[0]], {voices: 2});
  const first = container.play(), second = container.play();
  assert.notEqual(first, second);
  const oldNode = first.source;
  assert.equal(container.play(), first);
  assert.equal(oldNode.outputs.size, 0);
  assert.equal(oldNode.stopped.when, 0);
  assert.equal(s.context.bufferSources.filter(node => node.outputs.size).length, 2);
  container.dispose();
  assert.ok(s.context.bufferSources.every(node => node.outputs.size === 0));
  assert.equal(first.gain.outputs.size, 0);
  assert.equal(second.panner.outputs.size, 0);
  assert.throws(() => container.stopAll(), e => e.code === 'disposed');
  s.listener.dispose();
});

test('invalid draws and positions cannot consume sequence history, cooldown or an existing voice', () => {
  const s = setup();
  let random = 0.5;
  let draws = 0;
  const container = new AudioEventContainer(s.listener, s.buffers, {
    voices: 1, mode: 'sequence', volume: [0.5, 1], random: () => { draws++; return random; },
  });
  const voice = container.play();
  const node = voice.source;
  for (const value of [NaN, Infinity, -0.1, 1]) {
    random = value;
    assert.throws(() => container.play(), RangeError);
    assert.equal(container.lastIndex, 0);
    assert.equal(voice.source, node);
    assert.equal(node.stopped, null);
  }
  const beforeInvalidPositions = draws;
  assert.throws(() => container.play([NaN, 0, 0]), RangeError);
  assert.throws(() => container.play([, 0, 0]), RangeError);
  assert.equal(draws, beforeInvalidPositions);
  assert.equal(voice.source, node);
  assert.equal(node.stopped, null);
  random = 0;
  assert.equal(container.play().buffer, s.buffers[1]);
  s.listener.dispose();
});

test('ranges are snapshotted, options validated, and a backwards audio clock starts a fresh cooldown', () => {
  const s = setup();
  for (const options of [{mode:'bad'}, {cooldown:-1}, {cooldown:NaN}, {volume:[1,0]}, {volume:[-1,1]}, {volume:[,1]}, {pitch:[0,,]}, {pitch:[-4801,0]}, {pitch:[0,Infinity]}, {voices:0}, {random:4}])
    assert.throws(() => new AudioEventContainer(s.listener, s.buffers, options));
  assert.throws(() => new AudioEventContainer(s.listener, []), e => e.code === 'state');
  const volume = [0.5, 0.5];
  const container = new AudioEventContainer(s.listener, s.buffers, {volume, cooldown: 1, mode:'sequence'});
  volume[0] = 1;
  volume[1] = 1;
  s.context.currentTime = 5;
  assert.equal(container.play().volume, 0.5);
  assert.equal(container.play(), null);
  s.context.currentTime = 2;
  assert.equal(container.play().buffer, s.buffers[1]);
  s.listener.dispose();
});
