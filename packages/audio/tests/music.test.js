import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioListener } from '../dist/index.js';
import { AudioMusic } from '../dist/music.js';
import { FakeAudioContext } from './fake-web-audio.js';

function setup(options = {}) {
  const context = new FakeAudioContext({ state: 'running' });
  const listener = new AudioListener({ context });
  const stems = { a: context.createBuffer(1, 96000, 48000), b: context.createBuffer(1, 96000, 48000) };
  const states = { idle: { a: 0 }, combat: { a: -6, b: 0 } };
  const music = new AudioMusic(listener, stems, states, options);
  return { context, listener, stems, states, music };
}
const fader = (source) => [...[...[...source.outputs][0].outputs][0].outputs][0];

test('stems share start and loop phase; beat/bar transitions use the audio clock and mixer automation', () => {
  const s = setup();
  assert.equal(s.music.start('idle', 1), 1);
  const [a, b] = s.context.bufferSources;
  for (const source of [a, b]) {
    assert.deepEqual(source.started, { when: 1, offset: 0, duration: 2 });
    assert.equal(source.loop, false);
  }
  assert.equal(a.buffer, s.stems.a);
  assert.equal(fader(a).gain.value, 1);
  assert.equal(fader(b).gain.value, 0);
  s.context.currentTime = 1.1;
  assert.equal(s.music.transition('combat', { quantize: 'beat' }), 1.5);
  assert.deepEqual(fader(b).gain.last(), ['target', 1, 1.5, 0.005]);
  assert.equal(s.music.transition('idle'), 3);
  assert.equal(s.music.transition('combat', { after: 3, fade: 0 }), 3);
  assert.deepEqual(fader(b).gain.last(), ['set', 1, 3]);
  assert.equal(s.music.transition('idle', { after: 3.01 }), 5);
  s.listener.dispose();
  assert.ok(s.context.bufferSources.every((source) => source.stopped && source.outputs.size === 0));
  assert.throws(
    () => s.music.transition('idle'),
    (e) => e.code === 'disposed' && /errors#disposed/.test(e.message),
  );
});

test('invalid requests preserve sounding sources and automation; states are copied; restart clears pending events', () => {
  const s = setup({ leadTime: 0 });
  s.states.idle.a = -20;
  s.music.start('idle');
  const source = s.context.bufferSources[0],
    param = fader(source).gain;
  assert.equal(param.value, 1);
  const before = [...param.events];
  for (const action of [
    () => s.music.start('idle'),
    () => s.music.transition('missing'),
    () => s.music.transition('idle', { quantize: 'bad' }),
    () => s.music.transition('idle', { after: NaN }),
    () => s.music.transition('idle', { fade: -1 }),
  ])
    assert.throws(action);
  assert.deepEqual(param.events, before);
  assert.equal(source.stopped, null);
  s.music.transition('combat', { after: 10 });
  s.music.stop();
  assert.equal(source.outputs.size, 0);
  s.context.currentTime = 1;
  assert.equal(s.music.start('idle'), 1);
  assert.deepEqual(param.events.slice(-2), [
    ['cancel', 1],
    ['set', 1, 1],
  ]);
  s.music.dispose();
  s.music.dispose();
  s.listener.dispose();
});

test('grid, buffer length and complete state validation happen before graph allocation', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const buffer = context.createBuffer(1, 96000, 48000);
  for (const options of [
    { bpm: 0 },
    { bpm: NaN },
    { bpm: Number.MIN_VALUE },
    { beatsPerBar: 1.5 },
    { loopBeats: 0 },
    { fade: -1 },
    { leadTime: Infinity },
  ])
    assert.throws(() => new AudioMusic(listener, { a: buffer }, { idle: {} }, options));
  for (const [stems, states] of [
    [{}, { idle: {} }],
    [{ a: { duration: 1 } }, { idle: {} }],
    [{ a: buffer }, {}],
    [{ a: buffer }, { idle: { b: 0 } }],
    [{ a: buffer }, { idle: { a: NaN } }],
    [{ a: buffer }, { idle: { a: 10000 } }],
  ])
    assert.throws(() => new AudioMusic(listener, stems, states));
  assert.equal(context.bufferSources.length, 0);
  const music = new AudioMusic(listener, { a: buffer }, { idle: {} });
  assert.throws(
    () => music.transition('idle'),
    (e) => e.code === 'state',
  );
  assert.throws(() => music.start('idle', -1));
  listener.dispose();
});

test('every loop is its own source anchored at origin + k * loop, so whole-frame rounding never accumulates', () => {
  // 130 bpm, 4 beats: 1.846... s, a fractional frame count at every common rate. A looping source with a
  // fractional loopEnd drifts in a browser that truncates loop points to whole frames (Firefox).
  const s = setup({ bpm: 130, loopBeats: 4 });
  const loop = (4 * 60) / 130;
  s.music.start('idle', 0.5);
  for (let t = 0; t < 3600; t += 0.7) {
    s.context.currentTime = t;
    s.music.update();
  }
  const sources = s.context.bufferSources;
  assert.ok(sources.length > (2 * 3600) / loop, `${sources.length} sources`);
  sources.forEach((source, n) => {
    const k = Math.floor(n / 2);
    assert.equal(source.loop, false);
    assert.deepEqual(source.started, { when: 0.5 + k * loop, offset: 0, duration: loop });
    assert.equal(source.buffer, n % 2 ? s.stems.b : s.stems.a);
  });
  // A loop end refills without a frame pass (a hidden tab), and the ended source leaves the graph.
  const count = sources.length;
  s.context.currentTime += 3 * loop;
  sources[0].end();
  assert.equal(sources[0].outputs.size, 0);
  assert.ok(sources.length > count);
  s.music.dispose();
  s.listener.dispose();
});

test('a loop whose start passed during a stall starts now at its matching offset; an offline render is scheduled whole', () => {
  const s = setup({ bpm: 120, loopBeats: 4, leadTime: 0 });
  s.music.start('idle', 0);
  const before = s.context.bufferSources.length;
  s.context.currentTime = 10.5;
  s.music.update();
  const late = s.context.bufferSources.slice(before).filter((source) => source.started.when === 10.5);
  assert.equal(late.length, 2);
  for (const source of late) assert.deepEqual(source.started, { when: 10.5, offset: 0.5, duration: 1.5 });
  s.listener.dispose();
  const context = new FakeAudioContext({ state: 'running' });
  context.length = 48000 * 9;
  context.sampleRate = 48000;
  context.startRendering = () => {};
  const listener = new AudioListener({ context });
  const music = new AudioMusic(listener, { a: context.createBuffer(1, 96000, 48000) }, { on: { a: 0 } });
  music.start('on', 0);
  assert.deepEqual(
    context.bufferSources.map((source) => source.started.when),
    [0, 2, 4, 6, 8],
  );
  listener.dispose();
});

/** An OfflineAudioContext with suspend(time): suspend points wait until the test reaches them. */
function offlineContext(seconds, { refuse = false } = {}) {
  const context = new FakeAudioContext({ state: 'running' });
  context.sampleRate = 48000;
  context.length = 48000 * seconds;
  context.startRendering = () => {};
  context.points = [];
  context.resumes = 0;
  context.suspend = (at) => {
    if (refuse)
      return Promise.reject(new DOMException('a suspend is already scheduled at this frame', 'InvalidStateError'));
    return new Promise((resolve) => context.points.push({ at, resolve }));
  };
  context.resume = async () => {
    context.resumes++;
  };
  return context;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('an offline render with suspend(time) is scheduled a window at a time, refilled at suspend points (KB5029b)', async () => {
  // One hour at 130 bpm: 1,950 loops of two stems. Scheduling them all at once made Chromium's render about 40 times
  // slower, as every scheduled source is visited on every render quantum until it ends.
  const seconds = 3600,
    loop = (4 * 60) / 130,
    context = offlineContext(seconds),
    listener = new AudioListener({ context });
  const stems = { a: context.createBuffer(1, 96000, 48000), b: context.createBuffer(1, 96000, 48000) };
  const music = new AudioMusic(listener, stems, { on: { a: 0, b: 0 } }, { bpm: 130, loopBeats: 4, leadTime: 0 });
  music.start('on', 0);
  const window = Math.max(8, 8 * loop),
    most = 2 * Math.ceil((window + loop) / loop + 1);
  assert.ok(context.bufferSources.length <= most, `${context.bufferSources.length} sources before rendering`);
  let refills = 0;
  while (context.points.length) {
    const { at, resolve } = context.points.shift();
    assert.ok(
      Math.abs(Math.round((at * 48000) / 128) * 128 - at * 48000) < 1e-6,
      'suspend points fall on render quanta',
    );
    // Every source the render reaches before the next refill already exists, and only a window of them.
    const ahead = context.bufferSources.filter((source) => source.started.when >= at);
    assert.ok(ahead.length > 0 && Math.max(...ahead.map((s) => s.started.when)) >= at + window / 2 - loop);
    assert.ok(ahead.length <= most, `${ahead.length} sources ahead of ${at}`);
    context.currentTime = at;
    resolve();
    await flush();
    refills++;
  }
  assert.ok(refills > 100, `${refills} refills`);
  assert.equal(context.resumes, refills, 'the render resumes after every refill');
  // The same loops as a whole-render schedule: every k * loop before the end, once per stem.
  const starts = context.bufferSources.map((source) => source.started.when);
  const expected = [];
  for (let k = 0; k * loop < seconds; k++) expected.push(k * loop, k * loop);
  assert.deepEqual(starts, expected);
  listener.dispose();
});

test('an offline render whose suspend point is refused is scheduled whole, as without suspend(time)', async () => {
  const context = offlineContext(600, { refuse: true }),
    listener = new AudioListener({ context });
  const music = new AudioMusic(listener, { a: context.createBuffer(1, 96000, 48000) }, { on: { a: 0 } });
  music.start('on', 0);
  await flush();
  assert.equal(context.bufferSources.length, 300, 'every 2 s loop of the 600 s render');
  assert.equal(context.bufferSources.at(-1).started.when, 598);
  listener.dispose();
});
