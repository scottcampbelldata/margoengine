// @margoengine/cache/prefetch: files the app needs next, fetched in idle time, highest priority first, a few at a time,
// with groups to cancel, holds for foreground loads, and a bandwidth cap through throttle().
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { Prefetcher, throttle } from '../dist/prefetch.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

const names = (network) => network.log.map((entry) => new URL(entry.url).pathname.slice(1));
const files = (list) => Object.fromEntries(list.map((name, i) => [`/${name}`, { body: bytes(100, i) }]));
// A fetch whose answers wait until released, to see what is in flight.
function gated() {
  const open = new Map(),
    started = [];
  const fetch = (input, init) =>
    new Promise((resolve, reject) => {
      const name = new URL(String(input)).pathname.slice(1);
      started.push(name);
      open.set(name, () => resolve(new Response(bytes(10))));
      init?.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  return { fetch, started, release: (name) => open.get(name)?.(), open };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test('highest priority first, equal priorities in the order added, each URL once', async () => {
  const network = server(files(['a', 'b', 'c', 'd', 'e'])),
    prefetch = new Prefetcher({ fetch: network, concurrency: 1, idle: false });
  const first = prefetch.add([base + 'a', base + 'b', { url: base + 'c', priority: 5 }]);
  prefetch.add(base + 'd', { priority: 1 });
  prefetch.add({ url: base + 'b', priority: 9 }); // raises b while it waits
  prefetch.add(base + 'a'); // already queued: not twice
  const outcomes = await first;
  await prefetch.settle();
  assert.deepEqual(names(network), ['b', 'c', 'd', 'a']);
  assert.deepEqual(
    outcomes.map((o) => [o.url.slice(base.length), o.status, o.bytes]),
    [
      ['a', 'done', 100],
      ['b', 'done', 100],
      ['c', 'done', 100],
    ],
  );
  assert.deepEqual(await prefetch.add(base + 'c'), [{ url: base + 'c', status: 'done', bytes: 100 }], 'done once');
  assert.equal(network.log.length, 4);
  assert.deepEqual(prefetch.stats, { queued: 0, active: 0, done: 4, failed: 0, cancelled: 0, bytes: 400 });
});

test('requests start in idle time and at most `concurrency` run at once', async () => {
  const idle = [],
    saved = globalThis.requestIdleCallback;
  globalThis.requestIdleCallback = (run, options) => idle.push([run, options]);
  try {
    const gate = gated(),
      prefetch = new Prefetcher({ fetch: gate.fetch, concurrency: 2, idleTimeout: 500 });
    const done = prefetch.add(['a', 'b', 'c'].map((n) => base + n));
    await tick();
    assert.equal(gate.started.length, 0, 'nothing before idle time');
    assert.equal(idle[0][1].timeout, 500);
    while (idle.length) idle.shift()[0]();
    await tick();
    assert.deepEqual(gate.started, ['a', 'b'], 'two at a time');
    gate.release('a');
    await tick();
    while (idle.length) idle.shift()[0]();
    await tick();
    assert.deepEqual(gate.started, ['a', 'b', 'c']);
    gate.release('b');
    gate.release('c');
    assert.deepEqual(
      (await done).map((o) => o.status),
      ['done', 'done', 'done'],
    );
  } finally {
    globalThis.requestIdleCallback = saved;
  }
});

test('cancel(group) drops waiting files and aborts those in flight; hold and pause stop new requests', async () => {
  const gate = gated(),
    prefetch = new Prefetcher({ fetch: gate.fetch, concurrency: 1, idle: false });
  const level2 = prefetch.add([base + 'x', base + 'y'], { group: 'level2' }),
    level3 = prefetch.add(base + 'z', { group: 'level3' });
  await tick();
  assert.deepEqual(gate.started, ['x']);
  assert.equal(prefetch.cancel('level2'), 2);
  assert.deepEqual(
    (await level2).map((o) => o.status),
    ['cancelled', 'cancelled'],
  );
  await tick();
  assert.deepEqual(gate.started, ['x', 'z'], 'the next group goes on');
  // A foreground load holds prefetching until it ends.
  let finish;
  const load = prefetch.hold(new Promise((resolve) => (finish = resolve)));
  prefetch.add(base + 'w');
  gate.release('z');
  await level3;
  await tick();
  assert.deepEqual(gate.started, ['x', 'z'], 'held');
  finish('model');
  assert.equal(await load, 'model');
  await tick();
  assert.deepEqual(gate.started, ['x', 'z', 'w']);
  prefetch.pause();
  const later = prefetch.add(base + 'x'); // cancelled before, so it may come back
  gate.release('w');
  await tick();
  assert.equal(gate.started.length, 3, 'paused');
  prefetch.resume();
  await tick();
  gate.release('x');
  assert.equal((await later)[0].status, 'done');
  prefetch.dispose();
  assert.equal((await prefetch.add(base + 'v'))[0].status, 'cancelled', 'after dispose');
  assert.throws(() => new Prefetcher({ concurrency: 0 }), RangeError);
});

test('an HTTP error or network failure is reported per file; prefetched files are then in the cache, offline', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server(files(['tile/1', 'tile/2'])),
    cache = new AssetCache({ name: 'p1', fetch: network }),
    prefetch = new Prefetcher({ fetch: cache.fetch, idle: false });
  const outcomes = await prefetch.add([base + 'tile/1', base + 'tile/2', base + 'missing']);
  assert.deepEqual(
    outcomes.map((o) => o.status),
    ['done', 'done', 'failed'],
  );
  assert.equal(outcomes[2].error.code, 'failed');
  await cache.flush();
  network.offline = true;
  const offline = new AssetCache({ name: 'p1', fetch: network });
  assert.deepEqual(await read(await offline.fetch(base + 'tile/2')), bytes(100, 1));
  const down = new Prefetcher({ fetch: network, idle: false });
  const [lost] = await down.add(base + 'tile/9');
  assert.equal(lost.status, 'failed');
  assert.ok(lost.error instanceof TypeError);
});

test('throttle caps the body bytes read per second over all requests through it', async () => {
  const chunked = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(5000));
          controller.close();
        },
      }),
    );
  const slow = throttle(chunked, { bytesPerSecond: 400_000, burst: 0 }),
    started = performance.now(),
    bodies = await Promise.all([slow(base + 'a'), slow(base + 'b')].map(async (r) => (await r).arrayBuffer()));
  const elapsed = performance.now() - started;
  assert.deepEqual(
    bodies.map((b) => b.byteLength),
    [50_000, 50_000],
  );
  // 100,000 bytes at 400,000 bytes a second is 250 ms at least; 20 timers may each fire up to 1 ms early.
  assert.ok(elapsed >= 230, `took ${elapsed} ms`);
  assert.throws(() => throttle(chunked, { bytesPerSecond: 0 }), RangeError);
  // Through an AssetCache, as the README sets it up: the cache stores the throttled download.
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/area.glb': { body: bytes(1000) } }),
    background = new AssetCache({ name: 'p2', fetch: throttle(network, { bytesPerSecond: 1e6 }) }),
    prefetch = new Prefetcher({ fetch: background.fetch, idle: false });
  assert.equal((await prefetch.add(base + 'area.glb'))[0].bytes, 1000);
  await background.flush();
  assert.equal((await new AssetCache({ name: 'p2', fetch: network }).usage()).files, 1);
});
