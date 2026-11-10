import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { prepareVideo } from '../dist/playback.js';
const fixture = () => {
  const dom = new JSDOM('<video></video><button id="custom">Start</button>', { url: 'https://example.test/' }),
    video = dom.window.document.querySelector('video');
  let state = 0,
    pauses = 0;
  Object.defineProperty(video, 'readyState', { get: () => state });
  video.pause = () => {
    pauses++;
  };
  return {
    dom,
    video,
    setState: (n) => {
      state = n;
      video.dispatchEvent(new dom.window.Event('loadeddata'));
    },
    get pauses() {
      return pauses;
    },
  };
};
test('muted autoplay calls native play immediately, sets poster and resolves readiness only with a decoded frame', async () => {
  const f = fixture();
  let calls = 0;
  f.video.play = () => {
    calls++;
    assert.equal(f.video.muted, true);
    assert.equal(f.video.playsInline, true);
    return Promise.resolve();
  };
  using playback = prepareVideo(f.video, { poster: 'poster.jpg' });
  assert.equal(calls, 1);
  assert.equal(f.video.poster, 'https://example.test/poster.jpg');
  await playback.started;
  assert.equal(playback.blocked, false);
  f.setState(1);
  f.setState(2);
  assert.equal(await playback.ready, f.video);
  playback.dispose();
  assert.equal(f.pauses, 1);
  await assert.rejects(playback.play(), (e) => e.code === 'disposed');
  f.dom.window.close();
});
test('policy-only fallback preserves click activation, ready does not wait for permission, concurrent calls coalesce', async () => {
  const f = fixture();
  let activation = false,
    calls = 0;
  f.video.play = () => {
    calls++;
    return activation ? Promise.resolve() : Promise.reject(new f.dom.window.DOMException('blocked', 'NotAllowedError'));
  };
  using playback = prepareVideo(f.video);
  const a = playback.play(),
    b = playback.play();
  assert.equal(a, b);
  await assert.rejects(a, (e) => e.code === 'state' && e.cause.name === 'NotAllowedError');
  assert.equal(calls, 1);
  assert.equal(playback.blocked, true);
  assert.equal(playback.fallback.isConnected, true);
  f.setState(2);
  assert.equal(await playback.ready, f.video);
  activation = true;
  playback.fallback.click();
  activation = false;
  await playback.started;
  assert.equal(calls, 2);
  assert.equal(playback.blocked, false);
  assert.equal(playback.fallback.isConnected, false);
  assert.equal(playback.error, undefined);
  playback.dispose();
  f.dom.window.close();
});
test('caller fallback remains visible and owned; failures are observable after ready resolves', async () => {
  const f = fixture(),
    button = f.dom.window.document.querySelector('button');
  f.setState(2);
  f.video.play = () => Promise.reject(new Error('codec failed'));
  using playback = prepareVideo(f.video, { autoplay: false, fallback: button });
  await playback.ready;
  await assert.rejects(playback.play(), (e) => e.code === 'failed' && e.cause.message === 'codec failed');
  await assert.rejects(playback.started, (e) => e.code === 'failed');
  assert.equal(playback.error.code, 'failed');
  assert.equal(button.isConnected, true);
  assert.equal(button.hidden, false);
  playback.dispose();
  f.dom.window.close();
});
test('abort cancels pending play and readiness, removes fallback/listeners and keeps source ownership', async () => {
  const f = fixture(),
    controller = new AbortController();
  let calls = 0,
    finish;
  f.video.src = 'clip.mp4';
  f.video.play = () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const playback = prepareVideo(f.video, { signal: controller.signal }),
    pending = playback.play();
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  await assert.rejects(playback.ready, (e) => e.name === 'AbortError');
  await assert.rejects(playback.started, (e) => e.name === 'AbortError');
  playback.fallback.click();
  assert.equal(calls, 1);
  assert.equal(f.video.src, 'https://example.test/clip.mp4');
  assert.equal(f.video.isConnected, true);
  assert.equal(f.pauses, 1);
  finish();
  playback.dispose();
  f.dom.window.close();
});
test('ready timeout, existing media errors and invalid arguments terminate without autoplay loops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  f.video.play = () => Promise.resolve();
  const playback = prepareVideo(f.video, { autoplay: false, timeout: 30 });
  t.mock.timers.tick(30);
  await assert.rejects(playback.ready, (e) => e.code === 'failed' && /timed out/.test(e.message));
  assert.equal(f.pauses, 1);
  for (const options of [
    { timeout: 0 },
    { timeout: Infinity },
    { autoplay: 1 },
    { muted: 'yes' },
    { poster: 7 },
    { fallback: {} },
  ])
    assert.throws(() => prepareVideo(f.video, options));
  assert.throws(() => prepareVideo({}), TypeError);
  Object.defineProperty(f.video, 'error', { value: { code: 4 } });
  const failed = prepareVideo(f.video);
  await assert.rejects(failed.ready, (e) => e.code === 'failed');
  await assert.rejects(failed.started, (e) => e.code === 'failed');
  f.dom.window.close();
});
