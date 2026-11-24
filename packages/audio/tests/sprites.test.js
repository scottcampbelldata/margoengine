import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { AudioSpriteBank, loadAudioFallback } from '@margoengine/audio/sprites';
import { FakeAudioContext } from './fake-web-audio.js';

test('named immutable sprites share buffers, overlap and use native clip/loop bounds', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const buffer = context.createBuffer(1, 48000, 48000),
    map = { hit: { offset: 0.1, duration: 0.2 }, bed: { offset: 0.5, duration: 0.25, loop: true } };
  const bank = new AudioSpriteBank(listener, buffer, map);
  map.hit.offset = 0.9;
  const a = bank.play('hit'),
    b = bank.play('hit', { playbackRate: 2 }, 0.1),
    c = bank.play('bed');
  assert.equal(a.buffer, buffer);
  assert.equal(b.buffer, buffer);
  assert.equal(c.buffer, buffer);
  assert.deepEqual(context.bufferSources[0].started, { when: 0, offset: 0.1, duration: 0.2 });
  assert.deepEqual(context.bufferSources[1].started, { when: 0.1, offset: 0.1, duration: 0.2 });
  assert.equal(context.bufferSources[2].loopStart, 0.5);
  assert.equal(context.bufferSources[2].loopEnd, 0.75);
  assert.equal(c.loop, true);
  let ended = 0;
  const d = bank.play('hit', { onEnded: () => ended++ });
  context.bufferSources.at(-1).end();
  assert.equal(ended, 1);
  assert.equal(d.isDisposed, true);
  bank.stopAll();
  assert.equal(a.isPlaying, false);
  bank.dispose();
  assert.equal(a.isDisposed, true);
  assert.throws(
    () => bank.play('hit'),
    (e) => e.code === 'disposed',
  );
  listener.dispose();
});

test('sprite validation is atomic and unknown names never allocate a source', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context }),
    buffer = context.createBuffer(1, 48000, 48000);
  for (const value of [
    { offset: -1, duration: 1 },
    { offset: 0, duration: 0 },
    { offset: 0.9, duration: 0.2 },
    { offset: NaN, duration: 1 },
    { offset: 0, duration: 1, loop: 1 },
  ])
    assert.throws(() => new AudioSpriteBank(listener, buffer, { bad: value }));
  const bank = new AudioSpriteBank(listener, buffer, { ok: { offset: 0, duration: 1 } });
  assert.throws(() => bank.play('absent'));
  assert.throws(() => bank.play('ok', {}, -1));
  assert.equal(context.bufferSources.length, 0);
  bank.dispose();
  listener.dispose();
});

test('codec support filters in order and supported fetch/decode failures fall through once', async () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context }),
    loaded = [],
    probes = [];
  const expected = context.createBuffer(1, 48000, 48000);
  listener.load = async (url, options) => {
    loaded.push([url, options.signal]);
    if (url === 'bad.mp3') throw new DOMException('Bad codec', 'EncodingError');
    return expected;
  };
  const controller = new AbortController();
  const actual = await loadAudioFallback(
    listener,
    [{ url: 'skip', type: 'audio/unknown' }, 'bad.mp3', 'good.wav?x=1'],
    {
      signal: controller.signal,
      canPlayType: (type) => {
        probes.push(type);
        return type === 'audio/unknown' ? '' : 'maybe';
      },
    },
  );
  assert.equal(actual, expected);
  assert.deepEqual(
    loaded.map((v) => v[0]),
    ['bad.mp3', 'good.wav?x=1'],
  );
  assert.deepEqual(probes, ['audio/unknown', 'audio/mpeg', 'audio/wav']);
  assert.ok(loaded.every((v) => v[1] === controller.signal));
  listener.dispose();
});

test('fallback exhaustion preserves causes and abort never starts the next candidate', async () => {
  const listener = new AudioListener({ context: new FakeAudioContext() }),
    failure = new Error('Decoder failed');
  listener.load = async () => {
    throw failure;
  };
  await assert.rejects(
    loadAudioFallback(listener, ['a.mp3', 'b.wav'], { canPlayType: () => 'probably' }),
    (e) => e.code === 'failed' && e.cause.errors.length === 2 && e.cause.errors.every((x) => x === failure),
  );
  await assert.rejects(
    loadAudioFallback(listener, ['a.mp3'], { canPlayType: () => '' }),
    (e) => e.code === 'unsupported',
  );
  await assert.rejects(
    loadAudioFallback(listener, ['no-extension'], { canPlayType: () => 'maybe' }),
    (e) => e.code === 'state',
  );
  const controller = new AbortController();
  let calls = 0;
  listener.load = async () => {
    calls++;
    controller.abort(new Error('Cancelled'));
    throw failure;
  };
  await assert.rejects(
    loadAudioFallback(listener, ['a.wav', 'b.wav'], { canPlayType: () => 'maybe', signal: controller.signal }),
    /Cancelled/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    loadAudioFallback(listener, ['a.wav'], { canPlayType: () => 'maybe', signal: controller.signal }),
    /Cancelled/,
  );
  assert.equal(calls, 1);
  listener.dispose();
});

test('stopAll releases fire-and-forget instances; created clips survive natural ends and replay', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context }),
    buffer = context.createBuffer(1, 48000, 48000);
  const bank = new AudioSpriteBank(listener, buffer, { shot: { offset: 0, duration: 0.1 }, hit: { offset: 0.2, duration: 0.1 } });
  const shots = Array.from({ length: 8 }, () => bank.play('shot'));
  let ended = 0;
  const owned = bank.create('hit', { onEnded: () => ended++ });
  owned.play();
  bank.stopAll();
  assert.ok(shots.every((s) => s.isDisposed));
  assert.equal(owned.isDisposed, false);
  assert.equal(owned.isPlaying, false);
  assert.equal(bank.sounds.size, 1);
  owned.play();
  context.bufferSources.at(-1).end();
  assert.equal(ended, 1);
  assert.equal(owned.isDisposed, false);
  owned.play();
  assert.equal(owned.isPlaying, true);
  owned.dispose();
  bank.update();
  assert.equal(bank.sounds.size, 0);
  bank.dispose();
  listener.dispose();
});
