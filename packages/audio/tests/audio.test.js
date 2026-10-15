import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext, FakeMediaElement, FakeNode, FakeParam, chain, fakeEngine } from './fake-web-audio.js';

globalThis.AudioContext = FakeAudioContext;
const created = FakeAudioContext.created;
const {
  AudioListener,
  Audio,
  PositionalAudio,
  AudioAnalyser,
  loadAudioBuffer,
  clearAudioBufferCache,
  distanceGain,
  coneGain,
} = await import('../dist/index.js');
const close = (a, b, epsilon = 1e-9) => Math.abs(a - b) <= epsilon;
const buffer = (duration = 10) => ({ duration, length: duration * 48000 });

test('importing and constructing creates no AudioContext; first use creates one lazily', () => {
  assert.equal(FakeAudioContext.created, created);
  const listener = new AudioListener();
  assert.equal(listener.hasContext, false);
  assert.equal(FakeAudioContext.created, created);
  assert.ok(listener.context instanceof FakeAudioContext);
  assert.equal(FakeAudioContext.created, created + 1);
  assert.equal(listener.context, listener.context);
  listener.dispose();
});

test('listener follows the engine camera every frame: position, forward toward target, Y up', () => {
  const engine = fakeEngine(),
    context = new FakeAudioContext({ state: 'running' });
  const listener = new AudioListener({ context, smoothing: 0.05 });
  listener.setup(engine);
  listener.registerPasses(engine.graph);
  assert.equal(engine.passes[0].name, 'margoengine-audio');
  assert.ok(engine.passes[0].order > 0);
  engine.camera.position = [1, 2, 3];
  engine.camera.target = [1, 2, -7];
  engine.frame();
  assert.deepEqual([...listener.position], [1, 2, 3]);
  assert.deepEqual([...listener.forward], [0, 0, -1]);
  assert.deepEqual([...listener.up], [0, 1, 0]);
  // The first write is immediate so the listener does not sweep in from the origin.
  assert.deepEqual(context.listener.positionX.last(), ['set', 1, 0]);
  context.currentTime = 1;
  engine.camera.position = [4, 2, 3];
  engine.camera.target = [4, 2, 6];
  engine.frame();
  assert.deepEqual(context.listener.positionX.last(), ['target', 4, 1, 0.05]);
  assert.deepEqual(context.listener.forwardZ.last(), ['target', 1, 1, 0.05]);
  const before = context.listener.positionX.events.length;
  engine.frame();
  assert.equal(context.listener.positionX.events.length, before, 'unchanged pose must not schedule automation');
  listener.dispose();
});

test('listener camera following avoids per-frame pose slices and rejects invalid poses atomically', () => {
  const engine = fakeEngine(),
    listener = new AudioListener({ autoResume: false });
  listener.setup(engine);
  const slice = Array.prototype.slice;
  let slices = 0;
  try {
    Array.prototype.slice = function (...args) {
      slices++;
      return slice.apply(this, args);
    };
    for (let i = 0; i < 120; i++) listener.update();
  } finally {
    Array.prototype.slice = slice;
  }
  assert.equal(slices, 0, 'steady camera poses should use retained storage');
  listener.setPose([1, 2, 3], [0, 0, -2], [0, 3, 0]);
  assert.deepEqual([...listener.position], [1, 2, 3]);
  assert.deepEqual([...listener.forward], [0, 0, -1]);
  assert.deepEqual([...listener.up], [0, 1, 0]);
  assert.throws(() => listener.setPose([9, NaN, 8], [1, 0, 0], [0, 0, 1]), /Listener pose must be finite/);
  assert.deepEqual([...listener.position], [1, 2, 3]);
  assert.deepEqual([...listener.forward], [0, 0, -1]);
  assert.deepEqual([...listener.up], [0, 1, 0]);
  listener.dispose();
});

test('listener falls back to setPosition/setOrientation where AudioParams are missing', () => {
  const context = new FakeAudioContext(),
    calls = [];
  context.listener = {
    setPosition: (...a) => calls.push(['p', ...a]),
    setOrientation: (...a) => calls.push(['o', ...a]),
  };
  const listener = new AudioListener({ context });
  listener.setPose([1, 0, 0], [0, 0, -2]);
  new Audio(listener);
  assert.deepEqual(calls, [
    ['p', 1, 0, 0],
    ['o', 0, 0, -1, 0, 1, 0],
  ]);
});

test('master volume, suspend, resume and automatic resume on the first gesture', async () => {
  const engine = fakeEngine(),
    context = new FakeAudioContext({ state: 'suspended' });
  const listener = new AudioListener({ context, volume: 0.5 });
  listener.setup(engine);
  assert.equal(listener.input.gain.value, 0.5);
  assert.deepEqual(chain(listener.input), ['gain', 'destination']);
  engine.view.dispatchEvent(new Event('pointerdown'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.state, 'running');
  assert.deepEqual(context.calls, ['resume']);
  engine.view.dispatchEvent(new Event('keydown'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(context.calls, ['resume'], 'gesture listeners are removed once running');
  listener.volume = 0.25;
  assert.equal(listener.input.gain.last()[0], 'target');
  await listener.suspend();
  assert.equal(context.state, 'suspended');
  await listener.resume();
  assert.equal(context.state, 'running');
  assert.throws(() => {
    listener.volume = -1;
  }, RangeError);
});

test('global audio graph: source -> filters -> fade -> volume -> master -> destination', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const low = context.createBiquadFilter(),
    high = context.createBiquadFilter();
  const audio = new Audio(listener, { filters: [low, high], volume: 0.7 });
  audio.setBuffer(buffer()).play();
  assert.deepEqual(chain(audio.source), ['buffer-source', 'biquad', 'biquad', 'gain', 'gain', 'gain', 'destination']);
  assert.equal(audio.gain.gain.value, 0.7);
  audio.setFilters([]);
  assert.deepEqual(chain(audio.source), ['buffer-source', 'gain', 'gain', 'gain', 'destination']);
  assert.equal(low.outputs.size, 0);
  audio.setFilter(high);
  assert.deepEqual(chain(audio.source), ['buffer-source', 'biquad', 'gain', 'gain', 'gain', 'destination']);
  assert.equal(audio.getFilter(), high);
});

test('positional audio graph inserts the panner and applies its options', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const audio = new PositionalAudio(listener, {
    panningModel: 'equalpower',
    distanceModel: 'linear',
    refDistance: 2,
    maxDistance: 50,
    rolloffFactor: 0.5,
    coneInnerAngle: 60,
    coneOuterAngle: 120,
    coneOuterGain: 0.2,
  });
  audio.setBuffer(buffer()).play();
  assert.deepEqual(chain(audio.source), ['buffer-source', 'gain', 'gain', 'panner', 'gain', 'destination']);
  assert.equal(audio.getOutput(), audio.panner);
  const p = audio.panner;
  assert.deepEqual(
    [
      p.panningModel,
      p.distanceModel,
      p.refDistance,
      p.maxDistance,
      p.rolloffFactor,
      p.coneInnerAngle,
      p.coneOuterAngle,
      p.coneOuterGain,
    ],
    ['equalpower', 'linear', 2, 50, 0.5, 60, 120, 0.2],
  );
  assert.equal(new PositionalAudio(listener).panner.panningModel, 'HRTF');
  assert.throws(() => {
    audio.distanceModel = 'cubic';
  }, TypeError);
  assert.throws(() => {
    audio.refDistance = -1;
  }, RangeError);
  assert.throws(() => audio.setDirectionalCone(10, 20, 2), RangeError);
});

test('play, pause and resume track the playhead with playback rate, offset and duration', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const audio = new Audio(listener, { offset: 1, duration: 5, playbackRate: 2, detune: 100 });
  audio.setBuffer(buffer(10));
  audio.play();
  let node = audio.source;
  assert.deepEqual(node.started, { when: 0, offset: 1, duration: 5 });
  assert.equal(node.playbackRate.value, 2);
  assert.equal(node.detune.value, 100);
  context.currentTime = 1.5;
  assert.equal(audio.currentTime, 4);
  audio.pause();
  assert.equal(audio.isPlaying, false);
  assert.ok(node.stopped);
  audio.play();
  node = audio.source;
  assert.deepEqual(node.started, { when: 1.5, offset: 4, duration: 2 });
  audio.stop();
  audio.play(0.5);
  assert.deepEqual(audio.source.started, { when: 2, offset: 1, duration: 5 });
  audio.stop();
  assert.throws(() => audio.play(-1), RangeError);
});

test('loop points wrap the resume position and are forwarded to the source node', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const audio = new Audio(listener, { loop: true, loopStart: 2, loopEnd: 4 });
  audio.setBuffer(buffer(10)).play();
  const node = audio.source;
  assert.deepEqual([node.loop, node.loopStart, node.loopEnd], [true, 2, 4]);
  assert.equal(node.started.duration, undefined, 'looping ignores duration');
  context.currentTime = 5; // played 0..4, then 2..4 twice, then 1 s into the region
  audio.pause();
  audio.play();
  assert.ok(close(audio.source.started.offset, 3), `resume at ${audio.source.started.offset}`);
  audio.loopEnd = 3.5;
  assert.equal(audio.source.loopEnd, 3.5);
  audio.loop = false;
  assert.equal(audio.source.loop, false);
});

test('changing playback rate mid-play keeps the playhead consistent and is smoothed', () => {
  const context = new FakeAudioContext({ state: 'running' }),
    listener = new AudioListener({ context, smoothing: 0.01 });
  const audio = new Audio(listener).setBuffer(buffer(100)).play();
  context.currentTime = 2;
  audio.playbackRate = 3;
  assert.deepEqual(audio.source.playbackRate.last(), ['target', 3, 2, 0.01]);
  context.currentTime = 4;
  assert.equal(audio.currentTime, 8);
  audio.detune = -200;
  assert.deepEqual(audio.source.detune.last(), ['target', -200, 4, 0.01]);
});

test('onEnded fires only on a natural end', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  let ended = 0;
  const audio = new Audio(listener, { onEnded: () => ended++ }).setBuffer(buffer(1));
  audio.play();
  const first = audio.source;
  first.end();
  assert.equal(ended, 1);
  assert.equal(audio.isPlaying, false);
  assert.equal(first.outputs.size, 0);
  audio.play();
  const second = audio.source;
  audio.stop();
  second.end();
  assert.equal(ended, 1);
  audio.play();
  const third = audio.source;
  audio.pause();
  third.end();
  assert.equal(ended, 1);
});

test('fade-in and fade-out schedule linear ramps; fade-out stops the source at the end', () => {
  const context = new FakeAudioContext({ state: 'running' }),
    listener = new AudioListener({ context });
  const audio = new Audio(listener).setBuffer(buffer(10));
  context.currentTime = 1;
  audio.fadeIn(0.5);
  assert.equal(audio.isPlaying, true);
  const events = audio.fade.gain.events.filter((event) => event[0] !== 'cancel');
  assert.deepEqual(events.slice(-2), [
    ['set', 0, 1],
    ['linear', 1, 1.5],
  ]);
  const node = audio.source;
  context.currentTime = 3;
  audio.fadeOut(2);
  assert.deepEqual(audio.fade.gain.last('linear'), ['linear', 0, 5]);
  assert.deepEqual(node.stopped, { when: 5 });
  assert.equal(audio.isPlaying, false);
  audio.play();
  assert.deepEqual(audio.fade.gain.last(), ['set', 1, 3], 'play() restores the fade stage');
});

test('volume changes are smoothed with setTargetAtTime only on a running context', () => {
  const context = new FakeAudioContext({ state: 'suspended' }),
    listener = new AudioListener({ context, smoothing: 0.03 });
  const audio = new Audio(listener);
  audio.volume = 0.4;
  assert.deepEqual(audio.gain.gain.last(), ['set', 0.4, 0]);
  context.state = 'running';
  context.currentTime = 2;
  audio.volume = 0.8;
  assert.deepEqual(audio.gain.gain.last(), ['target', 0.8, 2, 0.03]);
  assert.deepEqual(audio.gain.gain.events.at(-2), ['cancel', 2]);
  listener.smoothing = 0;
  audio.volume = 0.1;
  assert.deepEqual(audio.gain.gain.last(), ['set', 0.1, 2]);
});

test('the listener can follow a mesh (world position, local forward axis, local up) instead of the camera', () => {
  const engine = fakeEngine(),
    context = new FakeAudioContext({ state: 'running' });
  const listener = new AudioListener({ context, smoothing: 0 });
  listener.setup(engine);
  listener.registerPasses(engine.graph);
  const hero = engine.createMesh();
  // 90 degrees about Y with scale 2: local +Z maps to world +X; at (4, 5, 6).
  engine.store.matrices.set([0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 4, 5, 6, 1], hero.id * 16);
  assert.equal(listener.following, 'camera');
  assert.equal(listener.follow(hero), listener);
  engine.frame();
  assert.deepEqual([...listener.position], [4, 5, 6]);
  assert.deepEqual([...listener.forward], [1, 0, 0], 'local +Z by default (glTF characters face +Z)');
  assert.deepEqual([...listener.up], [0, 1, 0]);
  assert.equal(context.listener.positionX.value, 4);
  listener.follow(hero, [-1, 0, 0]);
  engine.frame();
  assert.deepEqual([...listener.forward], [0, 0, 1], 'custom local forward axis');
  // A disposed mesh keeps the last pose; null leaves the listener where setPose puts it; 'camera' goes back.
  engine.meshes.delete(hero.id);
  engine.frame();
  assert.deepEqual([...listener.position], [4, 5, 6]);
  listener.follow(null).setPose([1, 1, 1], [0, 0, -1]);
  engine.frame();
  assert.deepEqual([...listener.position], [1, 1, 1]);
  listener.follow('camera');
  engine.frame();
  assert.deepEqual([...listener.position], [0, 0, 5]);
  assert.throws(() => listener.follow(hero, [0, 0, 0]), /nonzero/);
  assert.throws(() => listener.follow({}), /follows a core Mesh/);
  listener.dispose();
});

test('positional audio follows a mesh world matrix, its +Z direction, and mutes while hidden', () => {
  const engine = fakeEngine(),
    context = new FakeAudioContext({ state: 'running' });
  const listener = new AudioListener({ context, smoothing: 0.02 });
  listener.setup(engine);
  listener.registerPasses(engine.graph);
  const parent = engine.createMesh(),
    mesh = engine.createMesh();
  engine.store.parents[mesh.id] = parent.id;
  // 90 degrees about Y with scale 2: local +Z maps to world +X. Translation (4, 5, 6).
  engine.store.matrices.set([0, 0, -2, 0, 0, 2, 0, 0, 2, 0, 0, 0, 4, 5, 6, 1], mesh.id * 16);
  const audio = new PositionalAudio(listener, { mesh, muteWhenHidden: true, volume: 0.9 });
  engine.frame();
  assert.deepEqual([...audio.worldPosition], [4, 5, 6]);
  assert.deepEqual([...audio.worldDirection], [1, 0, 0]);
  assert.equal(audio.panner.positionX.target, 4);
  assert.equal(audio.panner.orientationX.target ?? audio.panner.orientationX.value, 1);
  engine.store.hidden[parent.id] = 1;
  engine.frame();
  assert.equal(audio.isMuted, true);
  assert.equal(audio.gain.gain.last()[1], 0);
  engine.store.hidden[parent.id] = 0;
  engine.frame();
  assert.equal(audio.gain.gain.last()[1], 0.9);
  audio.setDirection([0, 1, 0]);
  engine.frame();
  assert.deepEqual([...audio.worldDirection], [0, 1, 0]);
  engine.meshes.delete(mesh.id);
  engine.store.matrices.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 9, 9, 9, 1], mesh.id * 16);
  engine.frame();
  assert.deepEqual([...audio.worldPosition], [4, 5, 6], 'a disposed mesh keeps the last pose');
  audio.setPosition(1, 2, 3);
  assert.equal(audio.mesh, null);
  assert.deepEqual([...audio.worldPosition], [1, 2, 3]);
});

test('positional audio first pose write is immediate, later writes are smoothed', () => {
  const context = new FakeAudioContext({ state: 'running' }),
    listener = new AudioListener({ context, smoothing: 0.02 });
  const audio = new PositionalAudio(listener);
  audio.setPosition(3, 0, 0);
  assert.equal(audio.panner.positionX.events.find((event) => event[0] === 'set')[1], 0);
  assert.deepEqual(audio.panner.positionX.last(), ['target', 3, 0, 0.02]);
  const fresh = new PositionalAudio(new AudioListener({ context: new FakeAudioContext({ state: 'running' }) }), {});
  assert.deepEqual(fresh.panner.positionX.last(), ['set', 0, 0]);
});

test('media element, media stream and node sources', async () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const element = new FakeMediaElement();
  let ended = 0;
  const audio = new Audio(listener, { loop: false, playbackRate: 1.5, onEnded: () => ended++ });
  audio.setMediaElementSource(element);
  assert.equal(element.playbackRate, 1.5);
  assert.deepEqual(chain(audio.source), ['media-source', 'gain', 'gain', 'gain', 'destination']);
  audio.play();
  assert.equal(element.plays, 1);
  element.dispatchEvent(new Event('ended'));
  assert.equal(ended, 1);
  audio.play();
  audio.stop();
  assert.equal(element.paused, true);
  const again = new Audio(listener).setMediaElementSource(element);
  assert.equal(
    context.calls.filter((call) => call === 'media').length,
    1,
    'one MediaElementSource per element and context',
  );
  again.dispose();
  const stream = new Audio(listener).setMediaStreamSource({ id: 'mic' });
  assert.equal(stream.source.outputs.size, 0);
  stream.play();
  assert.equal(stream.source.outputs.size, 1);
  stream.pause();
  assert.equal(stream.source.outputs.size, 0);
  const oscillator = new FakeNode(context, 'oscillator');
  const tone = new Audio(listener).setNodeSource(oscillator).play();
  assert.deepEqual(chain(oscillator), ['oscillator', 'gain', 'gain', 'gain', 'destination']);
  tone.stop();
  assert.equal(oscillator.outputs.size, 0);
  assert.throws(() => new Audio(listener).play(), /no source/);
});

test('analyser taps the sound output and averages frequency bins', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context });
  const audio = new PositionalAudio(listener);
  const analyser = new AudioAnalyser(audio, 64);
  assert.ok(audio.panner.outputs.has(analyser.analyser));
  assert.equal(analyser.data.length, 32);
  assert.equal(analyser.getAverageFrequency(), (200 * 4) / 32);
  assert.equal(analyser.getWaveformData().length, 64);
  assert.equal(analyser.getFloatWaveformData().length, 64);
  assert.equal(analyser.getDominantFrequency(), 0);
  analyser.dispose();
  assert.equal(audio.panner.outputs.has(analyser.analyser), false);
});

test('distance models match the Web Audio formulas', () => {
  assert.equal(distanceGain('inverse', 4, 1, 100, 1), 1 / 4);
  assert.equal(distanceGain('inverse', 0.5, 1, 100, 1), 1);
  assert.equal(distanceGain('inverse', 5, 1, 100, 2), 1 / 9);
  assert.equal(distanceGain('linear', 6, 1, 11, 1), 0.5);
  assert.equal(distanceGain('linear', 50, 1, 11, 1), 0);
  assert.equal(distanceGain('linear', 6, 1, 11, 3), 0.5, 'linear rolloff is clamped to 1');
  assert.equal(distanceGain('exponential', 4, 1, 100, 2), 1 / 16);
  assert.equal(distanceGain('exponential', 4, 0, 100, 2), 0);
  assert.throws(() => distanceGain('cubic', 1), TypeError);
});

test('cone gain is 1 inside, outer gain outside and linear between', () => {
  const at = (angle) => [Math.sin((angle * Math.PI) / 180), 0, Math.cos((angle * Math.PI) / 180)];
  assert.equal(coneGain([0, 0, 0], [0, 0, 1], at(10), 60, 120, 0.2), 1);
  assert.ok(close(coneGain([0, 0, 0], [0, 0, 1], at(45), 60, 120, 0.2), 0.6));
  assert.ok(close(coneGain([0, 0, 0], [0, 0, 1], at(180), 60, 120, 0.2), 0.2));
  assert.equal(coneGain([0, 0, 0], [0, 0, 1], at(180), 360, 360, 0.2), 1);
  assert.equal(coneGain([0, 0, 0], [0, 0, 0], at(180), 60, 120, 0.2), 1);
});

test('loader shares downloads, caches buffers, honors AbortSignal and does not cache failures', async () => {
  const context = new FakeAudioContext();
  const requests = [];
  const fetch = (url, init) => {
    const request = { url, signal: init.signal };
    requests.push(request);
    return new Promise((resolve, reject) => {
      request.resolve = () =>
        resolve({
          ok: !url.includes('missing'),
          status: url.includes('missing') ? 404 : 200,
          arrayBuffer: async () => new ArrayBuffer(8),
        });
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  };
  const a = loadAudioBuffer(context, '/a.ogg', { fetch }),
    b = loadAudioBuffer(context, '/a.ogg', { fetch });
  assert.equal(requests.length, 1);
  requests[0].resolve();
  const [first, second] = await Promise.all([a, b]);
  assert.equal(first, second);
  assert.equal(first.duration, 8);
  assert.equal(await loadAudioBuffer(context, '/a.ogg', { fetch }), first);
  assert.equal(requests.length, 1);

  // One of two waiters aborts: it rejects, the shared download continues for the other.
  const controller = new AbortController();
  const c = loadAudioBuffer(context, '/c.ogg', { fetch, signal: controller.signal }),
    d = loadAudioBuffer(context, '/c.ogg', { fetch });
  controller.abort();
  await assert.rejects(c, { name: 'AbortError' });
  assert.equal(requests[1].signal.aborted, false);
  requests[1].resolve();
  assert.equal((await d).duration, 8);

  // Every waiter aborts: the download is cancelled and the entry dropped.
  const solo = new AbortController();
  const e = loadAudioBuffer(context, '/e.ogg', { fetch, signal: solo.signal });
  solo.abort();
  await assert.rejects(e, { name: 'AbortError' });
  assert.equal(requests[2].signal.aborted, true);
  const retry = loadAudioBuffer(context, '/e.ogg', { fetch });
  assert.equal(requests.length, 4);
  requests[3].resolve();
  await retry;

  await assert.rejects(loadAudioBuffer(context, '/x.ogg', { fetch, signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
  const missing = loadAudioBuffer(context, '/missing.ogg', { fetch });
  requests[4].resolve();
  await assert.rejects(missing, /HTTP 404/);
  const missingAgain = loadAudioBuffer(context, '/missing.ogg', { fetch });
  assert.equal(requests.length, 6, 'failures are not cached');
  requests[5].resolve();
  await assert.rejects(missingAgain);
  clearAudioBufferCache(context, '/a.ogg');
  void loadAudioBuffer(context, '/a.ogg', { fetch });
  assert.equal(requests.length, 7);
  requests[6].resolve();
  const listener = new AudioListener({ context });
  const viaListener = listener.load('/z.ogg', { fetch, cache: false });
  requests[7].resolve();
  assert.equal((await viaListener).duration, 8);
});

test('listener dispose stops and disconnects every sound and closes only a context it created', () => {
  const engine = fakeEngine();
  const listener = new AudioListener();
  listener.setup(engine);
  const context = listener.context;
  const audio = new Audio(listener).setBuffer(buffer()).play(),
    node = audio.source;
  const positional = new PositionalAudio(listener);
  listener.dispose();
  assert.equal(audio.isPlaying, false);
  assert.ok(node.stopped);
  assert.equal(audio.gain.outputs.size, 0);
  assert.equal(positional.panner.outputs.size, 0);
  assert.equal(context.state, 'closed');
  assert.throws(() => audio.play(), /disposed/);
  const shared = new FakeAudioContext(),
    borrowed = new AudioListener({ context: shared });
  new Audio(borrowed);
  borrowed.dispose();
  assert.notEqual(shared.state, 'closed');
});

test('moving listener writes avoid temporary parameter pair arrays over 120 frames', () => {
  const context = new FakeAudioContext({ state: 'running' }),
    listener = new AudioListener({ context, autoResume: false, smoothing: 0.05 });
  const iterator = Array.prototype[Symbol.iterator];
  let pairs = 0;
  try {
    Array.prototype[Symbol.iterator] = function () {
      if (this.length === 2 && this[0] instanceof FakeParam) pairs++;
      return iterator.call(this);
    };
    for (let i = 0; i < 120; i++) {
      context.currentTime = i / 60;
      listener.setPose([i, 2, 3], [0, 0, -1]);
    }
  } finally {
    Array.prototype[Symbol.iterator] = iterator;
  }
  assert.equal(pairs, 0);
  assert.deepEqual(context.listener.positionX.last(), ['target', 119, 119 / 60, 0.05]);
  listener.dispose();
});

test('positional input errors preserve the previous complete pose and followed mesh', () => {
  const listener = new AudioListener({ context: new FakeAudioContext() }),
    sound = new PositionalAudio(listener),
    mesh = {};
  sound.setPosition(1, 2, 3).attach(mesh);
  assert.throws(() => sound.setPosition(9, NaN, 8), /y must/);
  assert.deepEqual([...sound.worldPosition], [1, 2, 3]);
  assert.equal(sound.mesh, mesh);
  listener.dispose();
});

test('invalid positional setup unregisters the sound and disconnects all created nodes', () => {
  const context = new FakeAudioContext(),
    listener = new AudioListener({ context }),
    created = [];
  for (const method of ['createGain', 'createPanner']) {
    const create = context[method];
    context[method] = function () {
      const node = create.call(this);
      created.push(node);
      return node;
    };
  }
  assert.throws(() => new PositionalAudio(listener, { maxDistance: 0 }), /maxDistance must/);
  assert.equal(listener.sources.size, 0);
  assert.ok(created.filter((node) => node !== listener.input).every((node) => node.outputs.size === 0));
  listener.dispose();
});

test('cancellation after downloading bytes prevents abandoned audio decoding', async () => {
  const context = new FakeAudioContext(),
    controller = new AbortController(),
    reason = new Error('caller cancelled');
  let release;
  const bytes = new Promise((resolve) => {
    release = resolve;
  });
  const promise = loadAudioBuffer(context, '/abandoned.wav', {
    signal: controller.signal,
    fetch: async () => ({ ok: true, arrayBuffer: () => bytes }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(reason);
  await assert.rejects(promise, (error) => error === reason);
  release(new ArrayBuffer(8));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.calls.filter((call) => call === 'decode').length, 0);
});

test('positional mesh updates reuse direction storage across 120 frames and preserve finite poses', () => {
  const engine = fakeEngine(),
    context = new FakeAudioContext(),
    listener = new AudioListener({ context }),
    mesh = engine.createMesh(),
    sound = new PositionalAudio(listener, { mesh });
  engine.store.matrices.set([4, 5, 6], 12);
  const every = Array.prototype.every;
  let positions = 0;
  try {
    Array.prototype.every = function (...args) {
      if (this.length === 3 && this[0] === 4 && this[1] === 5 && this[2] === 6) positions++;
      return every.apply(this, args);
    };
    for (let i = 0; i < 120; i++) sound.update(engine);
  } finally {
    Array.prototype.every = every;
  }
  try {
    assert.equal(positions, 0);
    assert.deepEqual([...sound.worldPosition], [4, 5, 6]);
    assert.deepEqual([...sound.worldDirection], [0, 0, 1]);
    engine.store.matrices[12] = NaN;
    sound.update(engine);
    assert.deepEqual([...sound.worldPosition], [4, 5, 6]);
    engine.store.matrices[12] = 7;
    engine.store.matrices[10] = 0;
    sound.update(engine);
    assert.deepEqual([...sound.worldPosition], [7, 5, 6]);
    assert.deepEqual([...sound.worldDirection], [0, 0, 1]);
    sound.detach().setDirection([2, 0, 0]);
    assert.deepEqual([...sound.worldDirection], [1, 0, 0]);
    assert.throws(() => sound.setDirection([0, 0, 0]), /nonzero/);
    assert.deepEqual([...sound.worldDirection], [1, 0, 0]);
  } finally {
    listener.dispose();
  }
});
