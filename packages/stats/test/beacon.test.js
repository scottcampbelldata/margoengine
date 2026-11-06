import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameBeacon } from '../dist/beacon.js';

const endpoint = 'https://telemetry.example/frames';
// A browser with sendBeacon and fetch that keep what they are given; `visible` drives document.visibilityState.
function browser(t, { accept = true, beacon = true } = {}) {
  const sent = [],
    fetched = [],
    documentListeners = new Set(),
    pageListeners = new Set(),
    b = {
      sent,
      fetched,
      documentListeners,
      pageListeners,
      visibilityState: 'visible',
      hide() {
        b.visibilityState = 'hidden';
        documentListeners.forEach((listener) => listener());
      },
      leave: () => pageListeners.forEach((listener) => listener()),
    };
  const stub = (name, value) => {
    const had = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    t.after(() => {
      if (had) Object.defineProperty(globalThis, name, had);
      else delete globalThis[name];
    });
  };
  stub('navigator', {
    sendBeacon: beacon
      ? (url, body) => {
          if (accept) sent.push({ url, body: JSON.parse(body) });
          return accept;
        }
      : undefined,
  });
  stub('fetch', async (url, init) => {
    fetched.push({ url, init });
    if (b.fetchError) throw b.fetchError;
    return {};
  });
  stub('document', {
    get visibilityState() {
      return b.visibilityState;
    },
    addEventListener: (type, listener) => type === 'visibilitychange' && documentListeners.add(listener),
    removeEventListener: (type, listener) => documentListeners.delete(listener),
  });
  stub('addEventListener', (type, listener) => type === 'pagehide' && pageListeners.add(listener));
  stub('removeEventListener', (type, listener) => pageListeners.delete(listener));
  return b;
}
const fill = (beacon, count, milliseconds = 16) => {
  for (let i = 0; i < count; i++) beacon.frame(milliseconds);
};

test('percentiles sit within one bin of the exact values, and max is exact', (t) => {
  browser(t);
  const beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0 }),
    values = Array.from({ length: 10000 }, (_, i) => 4 + ((i * 7919) % 10000) / 200);
  values.forEach((value) => beacon.frame(value));
  values.sort((a, b) => a - b);
  const report = beacon.toJSON();
  for (const [key, p] of [
    ['p50', 0.5],
    ['p90', 0.9],
    ['p95', 0.95],
    ['p99', 0.99],
  ]) {
    const exact = values[Math.ceil(p * values.length) - 1];
    assert.ok(report[key] >= exact - 0.005, `${key} ${report[key]} is not under ${exact}`);
    assert.ok(report[key] <= exact * 1.046 + 0.005, `${key} ${report[key]} is within 4.6% of ${exact}`);
  }
  assert.equal(report.frames, 10000);
  assert.equal(report.max, Math.round(values.at(-1) * 100) / 100);
  beacon.dispose();
});

test('one repeated frame time reads as itself, not as its bin edge', (t) => {
  browser(t);
  const beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0 });
  fill(beacon, 100, 16.67);
  const { p50, p99, max, seconds } = beacon.toJSON();
  assert.deepEqual([p50, p99, max, seconds], [16.67, 16.67, 16.67, 1.67]);
  beacon.dispose();
});

test('frames outside the bins land in the end bins and max stays true', (t) => {
  browser(t);
  const beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0 });
  beacon.frame(0.001);
  beacon.frame(60000);
  const report = beacon.toJSON();
  assert.equal(report.max, 60000);
  assert.ok(report.p50 <= 0.11);
  assert.ok(report.p99 >= 9000);
  beacon.dispose();
});

test('flush sends JSON through sendBeacon with the context and nothing else, then starts over', (t) => {
  const b = browser(t),
    context = { build: '1.2.3', tier: 2 },
    beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0, context });
  fill(beacon, 60);
  context.scene = 'menu';
  assert.equal(beacon.flush(), true);
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].url, endpoint);
  assert.deepEqual(Object.keys(b.sent[0].body), ['frames', 'seconds', 'p50', 'p90', 'p95', 'p99', 'max', 'context']);
  assert.deepEqual(b.sent[0].body.context, { build: '1.2.3', tier: 2, scene: 'menu' });
  assert.equal(b.sent[0].body.frames, 60);
  assert.equal(beacon.sent, 1);
  assert.equal(beacon.toJSON().frames, 0);
  assert.equal(beacon.toJSON().max, 0);
  beacon.dispose();
});

test('under minFrames nothing is sent and the frames wait', (t) => {
  const b = browser(t),
    beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0, minFrames: 10 });
  fill(beacon, 9);
  assert.equal(beacon.flush(), false);
  assert.equal(b.sent.length, 0);
  beacon.frame(16);
  assert.equal(beacon.flush(), true);
  assert.equal(b.sent[0].body.frames, 10);
  beacon.dispose();
});

test('hiding the page and leaving it send; a visible change does not', (t) => {
  const b = browser(t),
    beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0, minFrames: 1 });
  beacon.frame(16);
  b.documentListeners.forEach((listener) => listener());
  assert.equal(b.sent.length, 0);
  b.hide();
  assert.equal(b.sent.length, 1);
  beacon.frame(16);
  b.leave();
  assert.equal(b.sent.length, 2);
  beacon.dispose();
  assert.equal(b.documentListeners.size, 0);
  assert.equal(b.pageListeners.size, 0);
});

test('the interval sends and dispose stops it after a last report', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const b = browser(t),
    beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 1000, minFrames: 1 });
  beacon.frame(16);
  t.mock.timers.tick(1000);
  assert.equal(b.sent.length, 1);
  beacon.frame(16);
  beacon.dispose();
  beacon.dispose();
  assert.equal(b.sent.length, 2);
  t.mock.timers.tick(5000);
  assert.equal(b.sent.length, 2);
  assert.throws(() => beacon.frame(16), { code: 'disposed' });
  assert.equal(beacon.flush(), false);
});

test('a refused or missing sendBeacon falls back to keepalive fetch without credentials', async (t) => {
  for (const options of [{ accept: false }, { beacon: false }]) {
    const b = browser(t, options),
      beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0, minFrames: 1 });
    beacon.frame(16);
    assert.equal(beacon.flush(), true);
    assert.equal(b.fetched.length, 1);
    const { url, init } = b.fetched[0];
    assert.equal(url, endpoint);
    assert.equal(JSON.parse(init.body).frames, 1);
    assert.deepEqual(
      [init.method, init.keepalive, init.mode, init.credentials],
      ['POST', true, 'no-cors', 'omit'],
    );
    await new Promise(setImmediate);
    assert.equal(beacon.sent, 1);
    beacon.dispose();
  }
});

test('a fetch that fails is counted, kept, and not retried', async (t) => {
  const b = browser(t, { beacon: false }),
    beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0, minFrames: 1 });
  b.fetchError = new TypeError('offline');
  beacon.frame(16);
  beacon.flush();
  await new Promise(setImmediate);
  assert.equal(beacon.failed, 1);
  assert.equal(beacon.sent, 0);
  assert.equal(beacon.lastError, b.fetchError);
  assert.equal(b.fetched.length, 1);
  beacon.dispose();
});

test('sampleRate leaves a session out entirely: no timer, no listeners, no sends', (t) => {
  const b = browser(t),
    random = t.mock.method(Math, 'random', () => 0.5),
    out = new FrameBeacon({ endpoint, sampleRate: 0.5, minFrames: 1 });
  assert.equal(out.active, false);
  out.frame(16);
  assert.equal(out.toJSON().frames, 0);
  assert.equal(out.flush(), false);
  assert.equal(b.documentListeners.size, 0);
  out.dispose();
  random.mock.mockImplementation(() => 0.49);
  const chosen = new FrameBeacon({ endpoint, sampleRate: 0.5, intervalMilliseconds: 0 });
  assert.equal(chosen.active, true);
  chosen.dispose();
  assert.equal(new FrameBeacon({ endpoint, sampleRate: 0 }).active, false);
});

test('an abort signal stops it, with a last report; one already aborted never starts', (t) => {
  const b = browser(t),
    controller = new AbortController(),
    beacon = new FrameBeacon({ endpoint, intervalMilliseconds: 0, minFrames: 1, signal: controller.signal });
  beacon.frame(16);
  controller.abort();
  assert.equal(b.sent.length, 1);
  assert.throws(() => beacon.frame(16), { code: 'disposed' });
  const late = new FrameBeacon({ endpoint, signal: controller.signal });
  assert.equal(late.active, false);
  assert.equal(b.documentListeners.size, 0);
  late.dispose();
});

test('attach samples the engine frames, leaves out pauses, and goes with dispose', (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const b = browser(t),
    callbacks = new Set(),
    engine = {
      use: (plugin) => plugin.setup(engine),
      onFrame(callback) {
        callbacks.add(callback);
        return () => callbacks.delete(callback);
      },
      removePlugin(name) {
        engine.removed = name;
      },
    },
    step = (milliseconds, delta = milliseconds / 1000) => {
      now += milliseconds;
      callbacks.forEach((callback) => callback(engine, delta));
    },
    beacon = FrameBeacon.attach(engine, { endpoint, intervalMilliseconds: 0, minFrames: 1 });
  assert.throws(() => beacon.setup(engine), { code: 'attached' });
  step(16, 0);
  step(16);
  step(20);
  step(5000, 0);
  step(16);
  assert.equal(beacon.toJSON().frames, 3);
  assert.equal(beacon.toJSON().max, 20);
  beacon.dispose();
  assert.equal(b.sent.length, 1);
  assert.equal(engine.removed, 'frame-beacon');
  assert.equal(callbacks.size, 0);
});

test('a rejected attach leaves nothing running', (t) => {
  const b = browser(t),
    failing = {
      use() {
        throw new Error('Duplicate plugin');
      },
    };
  assert.throws(() => FrameBeacon.attach(failing, { endpoint }), /Duplicate/);
  assert.equal(b.documentListeners.size, 0);
});

test('the endpoint and options are checked', (t) => {
  browser(t);
  assert.throws(() => new FrameBeacon({}), TypeError);
  assert.throws(() => new FrameBeacon({ endpoint: 'not a url' }), TypeError);
  assert.throws(() => new FrameBeacon({ endpoint: 'ftp://example.com/' }), TypeError);
  assert.throws(() => new FrameBeacon({ endpoint, intervalMilliseconds: -1 }), RangeError);
  assert.throws(() => new FrameBeacon({ endpoint, minFrames: 0 }), RangeError);
  assert.throws(() => new FrameBeacon({ endpoint, sampleRate: 2 }), RangeError);
  assert.throws(() => new FrameBeacon({ endpoint, sampleRate: NaN }), RangeError);
  const beacon = new FrameBeacon({ endpoint: new URL(endpoint), intervalMilliseconds: 0 });
  assert.throws(() => beacon.frame(0), RangeError);
  assert.throws(() => beacon.frame(Infinity), RangeError);
  beacon.dispose();
});
