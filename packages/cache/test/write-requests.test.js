// IndexedDB requests per stored miss. Each request is a round trip to the browser's storage process: Playwright WebKit
// on Windows answers each one on a timer tick of about 15 ms, so a write that asks for records it does not use costs
// time there in proportion (the browser check's 2,030 writes once took 158.9 s against 17.7 s in Chromium).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { evictionIndex } from '../dist/eviction.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

async function perMiss(indexed) {
  const factory = fakeIndexedDB();
  globalThis.indexedDB = factory;
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/t${i}`, { body: bytes(10, i) }])),
    cache = new AssetCache({ name: 'requests', maxBytes: 40, fetch: server(files), ...(indexed && { eviction: evictionIndex() }) });
  await read(await cache.fetch(`${base}t0`));
  await cache.flush();
  const counts = [];
  for (let i = 1; i < 6; i++) {
    const before = factory.counts.requests;
    await read(await cache.fetch(`${base}t${i}`));
    await cache.flush();
    counts.push(factory.counts.requests - before);
  }
  const usage = await cache.usage();
  return { counts, evicted: cache.stats.evicted, files: usage.files, bytes: usage.bytes };
}

test('a stored miss without the index: one lookup request and one write transaction (getAll, then the writes)', async () => {
  const { counts, evicted, files, bytes } = await perMiss(false);
  // Lookup: 1 get. Write: getAll, data put, meta put, and per eviction two deletes.
  assert.deepEqual(counts, [4, 4, 4, 6, 6]);
  assert.deepEqual([evicted, files, bytes], [2, 4, 40]);
});

test('a stored miss with the index: no data read on a miss and no cursor while within the budget', async () => {
  const { counts, evicted, files, bytes } = await perMiss(true);
  // Lookup: 1 get. Write: 3 gets and 4 puts; over the budget a cursor of 2 steps and 2 deletes per eviction.
  assert.deepEqual(counts, [8, 8, 8, 12, 12]);
  assert.deepEqual([evicted, files, bytes], [2, 4, 40]);
});

/** 60 misses of 10 bytes under a 200-byte budget, one at a time or all at once: transactions and what stays stored. */
async function burst(indexed, together) {
  const factory = fakeIndexedDB();
  globalThis.indexedDB = factory;
  const files = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`/b${i}`, { body: bytes(10, i) }])),
    cache = new AssetCache({ name: 'burst', maxBytes: 200, fetch: server(files), ...(indexed && { eviction: evictionIndex() }) });
  await cache.usage();
  let transactions = 0;
  const db = factory.databases.get('burst');
  const before = factory.counts.requests;
  const urls = Object.keys(files).map((path) => base + path.slice(1));
  if (together) await Promise.all(urls.map(async (url) => read(await cache.fetch(url))));
  else for (const url of urls) await read(await cache.fetch(url));
  await cache.flush();
  transactions = factory.counts.requests - before;
  const usage = await cache.usage(),
    kept = [...db.stores.get('meta')?.map.keys() ?? []].filter((k) => !String(k).startsWith('\0')).sort();
  return { requests: transactions, stored: cache.stats.stored, evicted: cache.stats.evicted, usage, kept };
}

for (const indexed of [false, true])
  test(`a burst of misses${indexed ? ' with the index' : ''} is written in one transaction per batch, and keeps what separate writes keep`, async () => {
    const one = await burst(indexed, false),
      all = await burst(indexed, true);
    assert.deepEqual([all.stored, all.evicted], [60, 40]);
    assert.deepEqual([all.usage.bytes, all.usage.files], [200, 20]);
    assert.deepEqual(all.usage, one.usage);
    assert.deepEqual(all.kept, one.kept);
    assert.equal(all.kept.length, 20);
    // Without the index the batch reads the records once, not once per file; with it the totals once.
    assert.ok(all.requests < one.requests, `${all.requests} requests against ${one.requests}`);
  });
