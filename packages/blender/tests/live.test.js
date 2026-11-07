// @margoengine/blender/live without Blender or a GPU: a stand-in event stream, fetch and parser check the order of
// fetches, attachments and disposals. scripts/modern-blender-tests.js runs the real add-on in Blender 5.2.3 against
// a real page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { margoLive } from '../dist/live.js';

/** A stand-in EventSource: `emit(version)` sends a scene event, `fail()` ends the stream for good. */
function stream() {
  const sources = [];
  class Source extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(url) {
      super();
      this.url = url;
      sources.push(this);
    }
    close() {
      this.readyState = Source.CLOSED;
      this.closed = true;
    }
  }
  const emit = (version) => sources.at(-1).dispatchEvent(Object.assign(new Event('scene'), { data: String(version) }));
  const fail = () => {
    sources.at(-1).readyState = Source.CLOSED;
    sources.at(-1).dispatchEvent(new Event('error'));
  };
  return { Source, sources, emit, fail };
}

function harness() {
  const log = [],
    fetched = [],
    s = stream();
  let release;
  const fetch = async (url) => {
    fetched.push(url.searchParams.get('v'));
    if (release) await new Promise((resolve) => (release = resolve));
    return new Response(new Uint8Array([Number(url.searchParams.get('v'))]));
  };
  const parse = async (engine, bytes) => {
    const version = bytes[0];
    log.push(`attach ${version}`);
    return { version, dispose: () => log.push(`dispose ${version}`) };
  };
  return { log, fetched, ...s, fetch, parse, hold: () => (release = () => {}),
    go: () => {
      const resume = release;
      release = undefined;
      resume();
    },
  };
}

test('each version is fetched, attached and yielded; the one before is disposed first', async () => {
  const h = harness(),
    seen = [];
  const live = margoLive({}, 'http://127.0.0.1:8765/', { EventSource: h.Source, fetch: h.fetch, parse: h.parse });
  const first = live.next();
  assert.equal(h.sources[0].url, 'http://127.0.0.1:8765/events');
  h.emit(1);
  seen.push((await first).value.version);
  const second = live.next();
  h.emit(2);
  seen.push((await second).value.version);
  await live.return();
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(h.log, ['attach 1', 'attach 2', 'dispose 1', 'dispose 2']);
  assert.ok(h.sources[0].closed, 'the event stream closes when the loop ends');
});

test('edits that arrive while a version loads are coalesced into the newest', async () => {
  const h = harness();
  const live = margoLive({}, 'http://127.0.0.1:8765/', { EventSource: h.Source, fetch: h.fetch, parse: h.parse });
  h.hold();
  const first = live.next();
  h.emit(1);
  await new Promise((resolve) => setImmediate(resolve));
  h.emit(2);
  h.emit(3);
  h.go();
  assert.equal((await first).value.version, 1);
  assert.equal((await live.next()).value.version, 3);
  await live.return();
  assert.deepEqual(h.fetched, ['1', '3'], 'version 2 was never fetched');
});

test('the signal ends the loop and disposes the last model', async () => {
  const h = harness(),
    controller = new AbortController();
  const live = margoLive({}, 'http://127.0.0.1:8765/', {
    EventSource: h.Source,
    fetch: h.fetch,
    parse: h.parse,
    signal: controller.signal,
  });
  const first = live.next();
  h.emit(1);
  await first;
  const waiting = live.next();
  controller.abort();
  assert.deepEqual(await waiting, { value: undefined, done: true });
  assert.deepEqual(h.log, ['attach 1', 'dispose 1']);
  assert.ok(h.sources[0].closed);
});

test('a stream that cannot be opened rejects with a coded error', async () => {
  const h = harness();
  const live = margoLive({}, 'http://127.0.0.1:8765/', { EventSource: h.Source, fetch: h.fetch, parse: h.parse });
  const first = live.next();
  h.fail();
  await assert.rejects(first, (e) => e.name === 'MargoError' && e.code === 'failed' && /start the live link/.test(e.message));
  await assert.rejects(margoLive({}, 'file:///scene', { EventSource: h.Source }).next(), TypeError);
});
