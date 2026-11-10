// Batch 132 audit regressions (RFC 9110, RFC 9111 and the Fetch standard; each failed before its fix).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { HashedAssets, hashBytes } from '../dist/hashed.js';
import { RangeCache } from '../dist/ranges.js';
import { AssetBundles } from '../dist/bundles.js';
import { Prefetcher, throttle } from '../dist/prefetch.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

const tick = () => new Promise((r) => setTimeout(r, 2));

test('delete right after a miss leaves nothing stored', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new AssetCache({ name: 'f1', fetch: server({ '/a': { body: bytes(100), etag: '"a"' } }) });
  await read(await cache.fetch(`${base}a`));
  await cache.delete(`${base}a`);
  await cache.flush();
  assert.equal((await cache.usage()).files, 0);
});

test('HashedAssets mismatch drops the stored copy (real AssetCache)', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const good = await hashBytes(bytes(10, 1));
  const cache = new AssetCache({ name: 'f1b', fetch: server({ '/a': { body: bytes(10, 2), etag: '"a"' } }) });
  const assets = new HashedAssets(cache, { [`${base}a`]: good });
  await assert.rejects(assets.fetch(`${base}a`), (e) => e.code === 'failed');
  await cache.flush();
  assert.equal((await cache.usage()).files, 0);
});

test('an aborted signal rejects a fresh AssetCache hit', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new AssetCache({ name: 'f4', fetch: server({ '/a': { body: bytes(10), control: 'max-age=600' } }) });
  await read(await cache.fetch(`${base}a`));
  await cache.flush();
  await assert.rejects(cache.fetch(`${base}a`, { signal: AbortSignal.abort() }), { name: 'AbortError' });
});

test('an aborted signal rejects a RangeCache hit', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const ranges = new RangeCache({
    name: 'f4b',
    block: 10,
    fetch: server({ '/a': { body: bytes(100), etag: '"a"', control: 'max-age=600' } }),
  });
  await read(await ranges.fetch(`${base}a`, { headers: { range: 'bytes=0-9' } }));
  await ranges.flush();
  await assert.rejects(ranges.fetch(`${base}a`, { headers: { range: 'bytes=0-9' }, signal: AbortSignal.abort() }), {
    name: 'AbortError',
  });
});

test('RangeCache no-store miss answers the range asked for', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const ranges = new RangeCache({
    name: 'f5',
    block: 64,
    fetch: server({ '/a': { body: bytes(200), control: 'no-store' } }),
  });
  const response = await ranges.fetch(`${base}a`, { headers: { range: 'bytes=10-19' } });
  assert.equal(response.headers.get('content-range'), 'bytes 10-19/200');
  assert.equal((await read(response)).length, 10);
});

test('Expires that is not an HTTP-date is stale (RFC 9111 5.3)', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/a': { body: bytes(10), etag: '"a"', headers: { expires: '2100' } } });
  await read(await new AssetCache({ name: 'f6', fetch: network }).fetch(`${base}a`));
  const second = new AssetCache({ name: 'f6', fetch: network });
  await tick();
  await new AssetCache({ name: 'f6', fetch: network }).flush();
  const before = network.log.length;
  await read(await second.fetch(`${base}a`));
  assert.equal(network.log.length, before + 1, 'Expires: 2100 was taken as fresh until the year 2100');
});

test('If-Range with another validator gets the whole file, not a 206 (RFC 9110 13.1.5)', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new AssetCache({
    name: 'f8',
    fetch: server({ '/a': { body: bytes(100), etag: '"new"', control: 'max-age=600' } }),
  });
  await read(await cache.fetch(`${base}a`));
  await cache.flush();
  const response = await cache.fetch(`${base}a`, { headers: { range: 'bytes=0-9', 'if-range': '"old"' } });
  assert.equal(response.status, 200);
});

test('settle() resolves when the last file ends during a pause', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const prefetch = new Prefetcher({
    idle: false,
    fetch: async () => {
      await gate;
      return new Response('x');
    },
  });
  const done = prefetch.add(`${base}a`);
  await tick();
  prefetch.pause();
  const settle = prefetch.settle();
  release();
  await done;
  const settled = await Promise.race([settle.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
  assert.ok(settled, 'settle() waits for resume() though nothing waits or runs');
});

test('a failed bundle load stops fetching the rest', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = {},
    manifestFiles = {};
  for (let i = 0; i < 20; i++) {
    const body = bytes(10, i);
    files[`/f${i}`] = { body, etag: `"${i}"` };
    manifestFiles[`${base}f${i}`] = await hashBytes(body);
  }
  delete files['/f0']; // 404
  const network = server(files);
  const bundles = new AssetBundles(new AssetCache({ name: 'f10', fetch: network }), {
    bundles: { one: { files: manifestFiles } },
  });
  await assert.rejects(bundles.load('one', { concurrency: 1 }));
  // fixed-wait: a check that nothing happens; a stopped worker would have asked again within this time
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(network.log.length, 1, `${network.log.length} requests after the first failed`);
});

test('concurrency 4: other workers stop after a failure', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = {},
    manifestFiles = {};
  for (let i = 0; i < 40; i++) {
    const body = bytes(10, i);
    files[`/g${i}`] = { body, etag: `"${i}"` };
    manifestFiles[`${base}g${i}`] = await hashBytes(body);
  }
  delete files['/g0'];
  const network = server(files);
  const bundles = new AssetBundles(new AssetCache({ name: 'f10b', fetch: network }), {
    bundles: { one: { files: manifestFiles } },
  });
  await assert.rejects(bundles.load('one'));
  // fixed-wait: a check that nothing happens; stopped workers would have asked again within this time
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(network.log.length <= 4, `${network.log.length} of 40 files requested after the load failed`);
});

test('HashedAssets keeps a Request input signal', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const hash = await hashBytes(bytes(10));
  const cache = new AssetCache({ name: 'f11', fetch: server({ '/a': { body: bytes(10) } }) });
  const assets = new HashedAssets(cache, { [`${base}a`]: hash });
  await assert.rejects(assets.fetch(new Request(`${base}a`, { signal: AbortSignal.abort() })), { name: 'AbortError' });
});

test('throttle does not pile abort listeners on the signal', async () => {
  const controller = new AbortController();
  let added = 0;
  const original = controller.signal.addEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => {
    if (args[0] === 'abort') added++;
    return original(...args);
  };
  let removed = 0;
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.removeEventListener = (...args) => {
    if (args[0] === 'abort') removed++;
    return originalRemove(...args);
  };
  const chunks = 50;
  const body = () =>
    new ReadableStream({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(1000));
        c.close();
      },
    });
  const slow = throttle(async () => new Response(body()), { bytesPerSecond: 1e7, burst: 0 });
  await (await slow('https://x.test/a', { signal: controller.signal })).arrayBuffer();
  assert.ok(added - removed <= 1, `${added - removed} abort listeners left on the signal after ${chunks} chunks`);
});

test('RangeCache.clear right after a miss leaves nothing stored', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const ranges = new RangeCache({ name: 'f1c', block: 10, fetch: server({ '/a': { body: bytes(100), etag: '"a"' } }) });
  await read(await ranges.fetch(`${base}a`, { headers: { range: 'bytes=0-9' } }));
  await ranges.clear();
  await ranges.flush();
  assert.equal((await ranges.usage()).files, 0);
});

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  two = (n) => String(n).padStart(2, '0'),
  clock = (d) => `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`,
  imf = (t) => new Date(t).toUTCString(),
  rfc850 = (t, d = new Date(t)) =>
    `${LONG[d.getUTCDay()]}, ${two(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${two(d.getUTCFullYear() % 100)} ${clock(d)} GMT`,
  asctime = (t, d = new Date(t)) =>
    `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${clock(d)} ${d.getUTCFullYear()}`;

/** Whether a second session answers from storage (fresh) after a first one stored a file with these headers. */
async function fresh(name, headers) {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/a': { body: bytes(10), etag: '"a"', headers } });
  const one = new AssetCache({ name, fetch: network });
  await read(await one.fetch(`${base}a`));
  await one.flush();
  const before = network.log.length;
  await read(await new AssetCache({ name, fetch: network }).fetch(`${base}a`));
  return network.log.length === before;
}

test('Expires and Date take the three RFC 9110 HTTP-date formats, in UTC and any case, and nothing else', async () => {
  const now = Date.now(),
    hour = 3600e3;
  for (const format of [imf, rfc850, asctime]) {
    assert.equal(
      await fresh(`d-${format.name}-ahead`, { date: imf(now), expires: format(now + hour) }),
      true,
      format.name,
    );
    // asctime is UTC: read as local time west of Greenwich, an hour ago was still fresh.
    assert.equal(
      await fresh(`d-${format.name}-past`, { date: imf(now), expires: format(now - hour) }),
      false,
      format.name,
    );
  }
  assert.equal(await fresh('d-lower', { expires: imf(now + hour).toLowerCase() }), true);
  for (const bad of [
    '2100',
    '99999',
    '0',
    'Sun, 31 Feb 2100 08:49:37 GMT',
    '2100-01-01T00:00:00Z',
    'Fri, 01 Jan 2100 00:00:00 +0000',
  ])
    assert.equal(await fresh(`d-${bad}`, { expires: bad }), false, bad);
});

test('If-Range with a weak tag never matches; RangeCache sends a mismatched If-Range to the server', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const cache = new AssetCache({
    name: 'weak',
    fetch: server({ '/a': { body: bytes(100), etag: 'W/"a"', control: 'max-age=600' } }),
  });
  await read(await cache.fetch(`${base}a`));
  await cache.flush();
  assert.equal((await cache.fetch(`${base}a`, { headers: { range: 'bytes=0-9', 'if-range': 'W/"a"' } })).status, 200);
  const network = server({ '/b': { body: bytes(100), etag: '"new"', control: 'max-age=600' } }),
    ranges = new RangeCache({ name: 'if-range', block: 10, fetch: network });
  await read(await ranges.fetch(`${base}b`, { headers: { range: 'bytes=0-9' } }));
  await ranges.flush();
  const before = network.log.length;
  await read(await ranges.fetch(`${base}b`, { headers: { range: 'bytes=0-9', 'if-range': '"old"' } }));
  assert.equal(network.log.length, before + 1);
  assert.equal(network.log.at(-1).headers['if-range'], '"old"');
});
