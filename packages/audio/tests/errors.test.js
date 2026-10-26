import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeAudioContext } from './fake-web-audio.js';

const { AudioListener, Audio, PositionalAudio, loadAudioBuffer, clearAudioBufferCache, distanceGain } = await import(
  '../dist/index.js'
);

// MargoError matches by name and carries a stable code; every message names its fix.
const coded = (code, pattern) => (error) => {
  assert.equal(error.name, 'MargoError');
  assert.equal(error.code, code);
  assert.match(error.message, pattern);
  return true;
};

test('a sound without a source reports a state error that names the setters', () => {
  const listener = new AudioListener({ context: new FakeAudioContext({ state: 'running' }) });
  const sound = new Audio(listener);
  assert.throws(() => sound.play(), coded('state', /no source; call setBuffer, setMediaElementSource/));
  listener.dispose();
});

test('a disposed sound reports code disposed and says to create a new one', () => {
  const listener = new AudioListener({ context: new FakeAudioContext({ state: 'running' }) });
  const sound = new Audio(listener);
  sound.dispose();
  assert.throws(() => sound.play(), coded('disposed', /Audio is disposed; create a new Audio/));
  listener.dispose();
});

test('no Web Audio reports code unsupported and points at options.context', () => {
  const saved = globalThis.AudioContext;
  delete globalThis.AudioContext;
  try {
    const listener = new AudioListener();
    assert.throws(
      () => listener.context,
      coded('unsupported', /unavailable in this environment; run in a browser, or pass options\.context/),
    );
  } finally {
    if (saved) globalThis.AudioContext = saved;
  }
});

test('distance model errors list the valid models', () => {
  assert.throws(
    () => distanceGain('cubic', 1),
    /Unknown distance model cubic; use 'linear', 'inverse' or 'exponential'/,
  );
  const listener = new AudioListener({ context: new FakeAudioContext({ state: 'running' }) });
  const sound = new PositionalAudio(listener);
  assert.throws(() => (sound.distanceModel = 'cubic'), /use 'linear', 'inverse' or 'exponential'/);
  assert.throws(() => listener.follow({}), /follows a core Mesh, 'camera' or null; pass one of those/);
  listener.dispose();
});

test('loading reports HTTP failures and a missing fetch as coded errors that say what to check', async () => {
  const context = new FakeAudioContext({ state: 'running' });
  clearAudioBufferCache?.(context);
  await assert.rejects(
    loadAudioBuffer(context, '/missing.ogg', { fetch: async () => new Response('', { status: 404 }) }),
    coded('failed', /HTTP 404 loading \/missing\.ogg; check the URL/),
  );
  const saved = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    await assert.rejects(
      loadAudioBuffer(context, '/x.ogg', { cache: false }),
      coded('unsupported', /fetch is unavailable in this environment; pass options\.fetch/),
    );
  } finally {
    globalThis.fetch = saved;
  }
});
