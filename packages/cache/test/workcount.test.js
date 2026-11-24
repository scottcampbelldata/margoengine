// Batch 170: work counts of the hit path. Workbox 7.4.1 CacheFirst with its ExpirationPlugin, run as a black box in
// engine-bench, opens one IndexedDB read-write transaction per hit to stamp the time; the parent here did too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

/** Counts transactions by mode on every database the fake opens. */
function counted() {
  const factory = fakeIndexedDB(),
    open = factory.open.bind(factory),
    modes = { readonly: 0, readwrite: 0 };
  factory.open = (...args) => {
    const request = open(...args);
    let seen;
    Object.defineProperty(request, 'result', {
      configurable: true,
      get: () => seen,
      set(db) {
        const transaction = db.transaction.bind(db);
        db.transaction = (names, mode = 'readonly') => {
          modes[mode]++;
          return transaction(names, mode);
        };
        seen = db;
      },
    });
    return request;
  };
  return { factory, modes };
}

test('work count: a burst of hits stamps their files in one write, with the records separate writes leave', async () => {
  const { factory, modes } = counted();
  globalThis.indexedDB = factory;
  const files = Object.fromEntries(
      ['/a.glb', '/b.glb', '/c.glb'].map((path, i) => [path, { body: bytes(100 + i), etag: `"${i}"`, control: 'max-age=3600' }]),
    ),
    network = server(files),
    cache = new AssetCache({ name: 'burst', fetch: network });
  for (const path of Object.keys(files)) await read(await cache.fetch(base + path.slice(1)));
  await cache.flush();
  const now = Date.now;
  const stamp = now.call(Date) + 10_000;
  Date.now = () => stamp;
  try {
    modes.readonly = modes.readwrite = 0;
    const answers = await Promise.all(
      Array.from({ length: 300 }, (_, i) => cache.fetch(base + Object.keys(files)[i % 3].slice(1))),
    );
    for (const [i, answer] of answers.entries())
      assert.deepEqual(await read(answer), files[Object.keys(files)[i % 3]].body);
    await cache.flush();
  } finally {
    Date.now = now;
  }
  assert.equal(network.log.length, 3, 'every hit came from the cache');
  assert.equal(cache.stats.hits, 300);
  assert.equal(modes.readonly, 300, 'one lookup per hit, as before');
  assert.ok(modes.readwrite <= 2, `hits stamped in ${modes.readwrite} writes; the parent used 300`);
  const records = await new Promise((done) => {
    const request = indexedDB.open('burst');
    request.onsuccess = () => {
      const t = request.result.transaction(['meta'], 'readonly'),
        all = t.objectStore('meta').getAll();
      all.onsuccess = () => done(all.result);
    };
  });
  const stamped = records.filter((r) => r?.url);
  assert.equal(stamped.length, 3);
  for (const record of stamped) assert.equal(record.used, stamp);
});
