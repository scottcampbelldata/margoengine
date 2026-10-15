import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';

// Minimal in-memory IndexedDB: the calls AssetCache makes, with request callbacks after the call (microtasks), commit on
// a later task, structured-clone semantics for records, and an optional byte quota on stored Blobs (QuotaExceededError).
function fakeIndexedDB({ quota = Infinity, broken = false } = {}) {
  const databases = new Map(),
    later = (fn) => setTimeout(fn, 0);
  const copy = (value) => (value instanceof Blob ? value : structuredClone(value));
  const store = (map, writable) => {
    const request = (run) => {
      const r = {};
      queueMicrotask(() => {
        r.result = run();
        r.onsuccess?.({ target: r });
      });
      return r;
    };
    const write = (run) => {
      if (!writable) throw new DOMException('read only', 'ReadOnlyError');
      return request(run);
    };
    return {
      get: (key) => request(() => copy(map.get(key))),
      getAll: () => request(() => [...map.values()].map(copy)),
      getAllKeys: () => request(() => [...map.keys()]),
      put: (value, key) =>
        write(() => {
          map.set(key, copy(value));
          return key;
        }),
      delete: (key) =>
        write(() => {
          map.delete(key);
        }),
      clear: () =>
        write(() => {
          map.clear();
        }),
    };
  };
  return {
    databases,
    open(name) {
      const request = {};
      later(() => {
        if (broken) {
          request.error = new DOMException('blocked', 'InvalidStateError');
          request.onerror?.();
          return;
        }
        let stores = databases.get(name);
        const created = !stores;
        if (created) databases.set(name, (stores = new Map()));
        const db = (request.result = {
          closed: false,
          close() {
            db.closed = true;
          },
          createObjectStore(n) {
            stores.set(n, new Map());
          },
          transaction(names, mode) {
            if (db.closed) throw new DOMException('closed', 'InvalidStateError');
            const staged = new Map(names.map((n) => [n, new Map(stores.get(n))])),
              t = { error: null, objectStore: (n) => store(staged.get(n), mode === 'readwrite') };
            later(() => {
              const bytes = [...staged.get('data').values()].reduce((sum, blob) => sum + blob.size, 0);
              if (bytes > quota) {
                t.error = new DOMException('quota', 'QuotaExceededError');
                t.onabort?.();
                return;
              }
              for (const [n, map] of staged) stores.set(n, map);
              t.oncomplete?.();
            });
            return t;
          },
        });
        if (created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

// A tiny HTTP server as a fetch function: ETag / Last-Modified / 304, Range, Cache-Control, offline and hanging modes.
function server(files) {
  const log = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init),
      file = files[new URL(request.url).pathname];
    log.push({
      url: request.url,
      range: request.headers.get('range'),
      etag: request.headers.get('if-none-match'),
      since: request.headers.get('if-modified-since'),
    });
    if (fetch.offline) throw new TypeError('Failed to fetch');
    if (fetch.hang)
      return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)));
    if (!file) return new Response('missing', { status: 404 });
    const headers = {
      'content-type': 'model/gltf-binary',
      ...(file.etag && { etag: file.etag }),
      ...(file.modified && { 'last-modified': file.modified }),
      ...(file.control && { 'cache-control': file.control }),
    };
    if (
      (file.etag && request.headers.get('if-none-match') === file.etag) ||
      (!file.etag && file.modified && request.headers.get('if-modified-since') === file.modified)
    )
      return new Response(null, { status: 304, headers });
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
    if (range) return new Response(file.body.slice(+range[1], +range[2] + 1), { status: 206, headers });
    return new Response(file.body, { status: 200, headers });
  };
  fetch.log = log;
  return fetch;
}
const bytes = (n, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255);
const read = async (response) => new Uint8Array(await response.arrayBuffer());
const base = 'https://cdn.example/';

test('miss stores, a new session revalidates with ETag (304), the same session serves without the network', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = { '/helmet.glb': { body: bytes(1000), etag: '"v1"' } },
    network = server(files);
  const first = new AssetCache({ name: 'a', fetch: network });
  assert.deepEqual(await read(await first.fetch(base + 'helmet.glb')), files['/helmet.glb'].body);
  await first.flush();
  assert.deepEqual(first.stats, { hits: 0, revalidated: 0, offline: 0, misses: 1, stored: 1, evicted: 0, errors: 0 });
  assert.deepEqual(await read(await first.fetch(base + 'helmet.glb')), files['/helmet.glb'].body);
  assert.equal(network.log.length, 1, 'the same AssetCache does not revalidate twice');
  const second = new AssetCache({ name: 'a', fetch: network }),
    response = await second.fetch(base + 'helmet.glb#frag');
  assert.equal(network.log.at(-1).etag, '"v1"');
  assert.equal(response.url, base + 'helmet.glb');
  assert.equal(response.headers.get('content-length'), '1000');
  assert.deepEqual(await read(response), files['/helmet.glb'].body);
  assert.equal(second.stats.revalidated, 1);
  assert.deepEqual(await second.usage(), { bytes: 1000, files: 1, quota: undefined, usage: undefined });
});

test('a changed file (200 to the conditional request) replaces the stored copy; Last-Modified works without ETag', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = { '/part.step': { body: bytes(300), modified: 'Mon, 12 Oct 2026 10:00:00 GMT' } },
    network = server(files);
  const first = new AssetCache({ name: 'b', fetch: network });
  await read(await first.fetch(base + 'part.step'));
  await first.flush();
  const second = new AssetCache({ name: 'b', fetch: network });
  await read(await second.fetch(base + 'part.step'));
  assert.equal(network.log.at(-1).since, 'Mon, 12 Oct 2026 10:00:00 GMT');
  assert.equal(second.stats.revalidated, 1);
  files['/part.step'] = { body: bytes(400, 9), modified: 'Wed, 14 Oct 2026 10:00:00 GMT' };
  const third = new AssetCache({ name: 'b', fetch: network });
  assert.deepEqual(await read(await third.fetch(base + 'part.step')), files['/part.step'].body);
  await third.flush();
  network.offline = true;
  assert.deepEqual(
    await read(await new AssetCache({ name: 'b', fetch: network }).fetch(base + 'part.step')),
    files['/part.step'].body,
  );
});

test('offline, failing and timed-out revalidation serve the stored copy; a miss offline still throws', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = { '/a.bin': { body: bytes(64), etag: '"a"' } },
    network = server(files);
  const warm = new AssetCache({ name: 'c', fetch: network });
  await read(await warm.fetch(base + 'a.bin'));
  await warm.flush();
  network.offline = true;
  const offline = new AssetCache({ name: 'c', fetch: network });
  assert.deepEqual(await read(await offline.fetch(base + 'a.bin')), files['/a.bin'].body);
  assert.equal(offline.stats.offline, 1);
  await assert.rejects(offline.fetch(base + 'missing.bin'), TypeError);
  network.offline = false;
  files['/a.bin'].etag = '"changed"';
  files['/a.bin'].body = bytes(64, 5);
  const broken = new AssetCache({ name: 'c', fetch: async () => new Response('down', { status: 503 }) });
  assert.deepEqual(await read(await broken.fetch(base + 'a.bin')), bytes(64), 'a 503 keeps the stored copy');
  const dropped = new AssetCache({
    name: 'c',
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(3));
            c.error(new TypeError('connection reset'));
          },
        }),
        { status: 200 },
      ),
  });
  assert.deepEqual(
    await read(await dropped.fetch(base + 'a.bin')),
    bytes(64),
    'a changed file that fails mid-download keeps the stored copy',
  );
  network.hang = true;
  const slow = new AssetCache({ name: 'c', fetch: network, timeout: 20 }),
    started = Date.now();
  assert.deepEqual(await read(await slow.fetch(base + 'a.bin')), bytes(64));
  assert.ok(Date.now() - started < 1000);
  assert.equal(slow.stats.offline, 1);
  const controller = new AbortController(),
    aborted = new AssetCache({ name: 'c', fetch: network, timeout: 10_000 }).fetch(base + 'a.bin', {
      signal: controller.signal,
    });
  setTimeout(() => controller.abort(new Error('user abort')), 10);
  await assert.rejects(aborted, /user abort/, "the caller's abort is not turned into a cache hit");
});

test('Cache-Control: max-age skips revalidation while fresh; no-store is never stored; non-GET passes through', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = {
      '/fresh.glb': { body: bytes(10), etag: '"f"', control: 'public, max-age=3600' },
      '/private.glb': { body: bytes(10), control: 'no-store' },
    },
    network = server(files);
  const first = new AssetCache({ name: 'd', fetch: network });
  await read(await first.fetch(base + 'fresh.glb'));
  await read(await first.fetch(base + 'private.glb'));
  await first.flush();
  assert.equal(first.stats.stored, 1);
  const second = new AssetCache({ name: 'd', fetch: network }),
    before = network.log.length;
  await read(await second.fetch(base + 'fresh.glb'));
  assert.equal(network.log.length, before, 'fresh entry served without a request');
  await read(await second.fetch(base + 'private.glb'));
  assert.equal(network.log.length, before + 1);
  await second.fetch(base + 'fresh.glb', { method: 'POST', body: 'x' });
  assert.equal(network.log.length, before + 2);
});

test('an app version bump deletes every stored file', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/m.glb': { body: bytes(50), etag: '"m"' } });
  const v1 = new AssetCache({ name: 'e', version: 1, fetch: network });
  await read(await v1.fetch(base + 'm.glb'));
  await v1.flush();
  assert.equal((await new AssetCache({ name: 'e', version: 1, fetch: network }).usage()).files, 1);
  const v2 = new AssetCache({ name: 'e', version: 2, fetch: network });
  assert.deepEqual(await v2.usage(), { bytes: 0, files: 0, quota: undefined, usage: undefined });
  await read(await v2.fetch(base + 'm.glb'));
  assert.equal(network.log.at(-1).etag, null, 'unconditional request after the bump');
});

test('over maxBytes the least recently used files are evicted; a file over the budget is not stored', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = {
      '/a': { body: bytes(100), etag: '"a"' },
      '/b': { body: bytes(100), etag: '"b"' },
      '/c': { body: bytes(100), etag: '"c"' },
      '/huge': { body: bytes(400) },
    },
    network = server(files);
  const cache = new AssetCache({ name: 'f', maxBytes: 250, fetch: network });
  for (const name of ['a', 'b']) {
    await read(await cache.fetch(base + name));
    await cache.flush();
    await new Promise((r) => setTimeout(r, 2));
  }
  await read(await cache.fetch(base + 'a'));
  await cache.flush();
  await new Promise((r) => setTimeout(r, 2)); // a is now more recent than b
  await read(await cache.fetch(base + 'c'));
  await cache.flush();
  await read(await cache.fetch(base + 'huge'));
  await cache.flush();
  assert.equal(cache.stats.evicted, 1);
  assert.deepEqual(await cache.usage(), { bytes: 200, files: 2, quota: undefined, usage: undefined });
  network.offline = true;
  const offline = new AssetCache({ name: 'f', maxBytes: 250, fetch: network });
  assert.deepEqual(await read(await offline.fetch(base + 'a')), files['/a'].body);
  assert.deepEqual(await read(await offline.fetch(base + 'c')), files['/c'].body);
  await assert.rejects(offline.fetch(base + 'b'), TypeError, 'b was evicted');
  await offline.delete(base + 'a');
  await offline.clear();
  assert.equal((await offline.usage()).files, 0);
});

test('QuotaExceededError evicts room for the new file and retries once; a hopeless write still returns the bytes', async () => {
  globalThis.indexedDB = fakeIndexedDB({ quota: 150 });
  const files = { '/a': { body: bytes(100) }, '/b': { body: bytes(100, 3) }, '/big': { body: bytes(200, 4) } },
    network = server(files);
  const cache = new AssetCache({ name: 'g', fetch: network });
  await read(await cache.fetch(base + 'a'));
  await cache.flush();
  await read(await cache.fetch(base + 'b'));
  await cache.flush();
  assert.deepEqual(
    { stored: cache.stats.stored, evicted: cache.stats.evicted, errors: cache.stats.errors },
    { stored: 2, evicted: 1, errors: 0 },
  );
  assert.deepEqual(await read(await cache.fetch(base + 'big')), files['/big'].body);
  await cache.flush();
  assert.equal(cache.stats.errors, 1);
  assert.deepEqual(
    await cache.usage(),
    { bytes: 100, files: 1, quota: undefined, usage: undefined },
    'the failed write changed nothing',
  );
});

test('without IndexedDB (missing or failing to open, as in some private modes) every request goes to the network', async () => {
  for (const db of [undefined, fakeIndexedDB({ broken: true })]) {
    globalThis.indexedDB = db;
    const network = server({ '/a': { body: bytes(10), etag: '"a"' } }),
      cache = new AssetCache({ fetch: network });
    for (let i = 0; i < 3; i++) assert.deepEqual(await read(await cache.fetch(base + 'a')), bytes(10));
    await cache.flush();
    assert.equal(network.log.length, 3);
    assert.equal(cache.stats.stored, 0);
    assert.deepEqual(await cache.usage(), { bytes: 0, files: 0, quota: undefined, usage: undefined });
  }
});

test('Range requests: a miss passes through and fills the whole file in the background; hits are sliced from the stored file', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const body = bytes(100),
    network = server({ '/big.glb': { body, etag: '"x"' } }),
    cache = new AssetCache({ name: 'h', fetch: network });
  const partial = await cache.fetch(base + 'big.glb', { headers: { range: 'bytes=10-19' } });
  assert.equal(partial.status, 206);
  assert.deepEqual(await read(partial), body.slice(10, 20));
  await cache.flush();
  assert.deepEqual(network.log.map((entry) => entry.range).sort(), ['bytes=10-19', null]);
  network.offline = true;
  for (const [range, start, end] of [
    ['bytes=10-19', 10, 19],
    ['bytes=90-', 90, 99],
    ['bytes=-5', 95, 99],
    ['bytes=95-500', 95, 99],
  ]) {
    const response = await cache.fetch(base + 'big.glb', { headers: { range } });
    assert.equal(response.status, 206, range);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/100`);
    assert.deepEqual(await read(response), body.slice(start, end + 1));
  }
  assert.equal((await cache.fetch(base + 'big.glb', { headers: { range: 'bytes=100-' } })).status, 416);
  assert.equal(
    (await cache.fetch(base + 'big.glb', { headers: { range: 'bytes=0-1,5-6' } })).status,
    200,
    'multipart ranges get the whole file',
  );
});

// gltf-pro, fbx, usdz and machinery take the same `fetch` option; they need a GPU engine, so the real-browser check
// (examples/package-benchmarks/cache/) covers them with loadGLTF.
test('@margoengine/loaders fetchBytes takes cache.fetch and loads offline from the cache', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const { fetchBytes } = await import('@margoengine/loaders');
  const network = server({ '/scan.ply': { body: bytes(20), etag: '"p"' } }),
    cache = new AssetCache({ name: 'i', fetch: network });
  assert.deepEqual(await fetchBytes(base + 'scan.ply', { fetch: cache.fetch }), bytes(20));
  await cache.flush();
  network.offline = true;
  const offline = new AssetCache({ name: 'i', fetch: network });
  assert.deepEqual(await fetchBytes(base + 'scan.ply', { fetch: offline.fetch }), bytes(20));
  assert.equal(offline.stats.offline, 1);
});
