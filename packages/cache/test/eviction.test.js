// @margoengine/cache/eviction: an index on last use and running totals, so a write reads only what it evicts instead of
// every entry's metadata, with the same eviction as the default.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetCache } from '../dist/index.js';
import { evictionIndex } from '../dist/eviction.js';
import { varyKeys } from '../dist/vary.js';
import { base, bytes, fakeIndexedDB, read, server } from './support.js';

const tick = () => new Promise((r) => setTimeout(r, 2));

test('deleting every Vary entry updates indexed usage once for the complete set', async () => {
  for (const variants of [2, 5]) {
    globalThis.indexedDB = fakeIndexedDB();
    const network = server({
      '/variants': { body: bytes(100), headers: { vary: 'Accept-Language' } },
      '/other': { body: bytes(50) },
    });
    const cache = new AssetCache({
      name: `delete-variants-${variants}`,
      fetch: network,
      keys: varyKeys(),
      eviction: evictionIndex(),
    });
    for (let i = 0; i < variants; i++) {
      await read(await cache.fetch(base + 'variants', { headers: { 'accept-language': `lang-${i}` } }));
      await cache.flush();
    }
    await read(await cache.fetch(base + 'other'));
    await cache.flush();
    assert.equal((await cache.usage()).bytes, variants * 100 + 50);
    assert.equal((await cache.usage()).files, variants + 1);
    for (let i = 0; i < 2; i++) {
      await cache.delete(base + 'variants');
      assert.deepEqual(await cache.usage(), { bytes: 50, files: 1, quota: undefined, usage: undefined });
    }
    network.offline = true;
    await assert.rejects(cache.fetch(base + 'variants', { headers: { 'accept-language': 'lang-0' } }), TypeError);
    assert.deepEqual(await read(await cache.fetch(base + 'other')), bytes(50));
    cache.dispose();
    await cache.flush();
  }
});

test('the least recently used files are evicted, as without the index; a file over the budget is not stored', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const files = {
      '/a': { body: bytes(100), etag: '"a"' },
      '/b': { body: bytes(100), etag: '"b"' },
      '/c': { body: bytes(100), etag: '"c"' },
      '/huge': { body: bytes(400) },
    },
    network = server(files);
  const cache = new AssetCache({ name: 'x1', maxBytes: 250, fetch: network, eviction: evictionIndex() });
  for (const name of ['a', 'b', 'a', 'c', 'huge']) {
    await read(await cache.fetch(base + name));
    await cache.flush();
    await tick();
  }
  assert.equal(cache.stats.evicted, 1);
  assert.deepEqual(await cache.usage(), { bytes: 200, files: 2, quota: undefined, usage: undefined });
  // A replaced file counts once.
  files['/a'] = { body: bytes(120, 4), etag: '"a2"' };
  const replace = new AssetCache({ name: 'x1', maxBytes: 250, fetch: network, eviction: evictionIndex() });
  await read(await replace.fetch(base + 'a'));
  await replace.flush();
  network.offline = true;
  const offline = new AssetCache({ name: 'x1', maxBytes: 250, fetch: network, eviction: evictionIndex() });
  assert.deepEqual(await offline.usage(), { bytes: 220, files: 2, quota: undefined, usage: undefined });
  assert.deepEqual(await read(await offline.fetch(base + 'a')), files['/a'].body);
  await assert.rejects(offline.fetch(base + 'b'), TypeError, 'b was evicted');
  await offline.delete(base + 'a');
  assert.deepEqual(await offline.usage(), { bytes: 100, files: 1, quota: undefined, usage: undefined });
  await offline.clear();
  assert.deepEqual(await offline.usage(), { bytes: 0, files: 0, quota: undefined, usage: undefined });
});

test('a write reads the records it evicts, not every entry: 2,000 files, 30 more writes', async () => {
  const run = async (eviction) => {
    const idb = (globalThis.indexedDB = fakeIndexedDB()),
      files = {};
    for (let i = 0; i < 2030; i++) files[`/tile/${i}`] = { body: bytes(10, i) };
    const network = server(files),
      cache = new AssetCache({ name: 'x2', maxBytes: 20_000, fetch: network, eviction });
    for (let i = 0; i < 2000; i++) await read(await cache.fetch(`${base}tile/${i}`));
    await cache.flush();
    const before = idb.counts.reads;
    for (let i = 2000; i < 2030; i++) {
      await read(await cache.fetch(`${base}tile/${i}`));
      await cache.flush();
    }
    return { reads: idb.counts.reads - before, cache };
  };
  const plain = await run(undefined),
    indexed = await run(evictionIndex());
  assert.equal(indexed.cache.stats.evicted, 30);
  assert.equal(plain.cache.stats.evicted, 30);
  // Per write the default reads all 2,000 entries; the index reads the totals, the evicted entry and the cursor's rows.
  assert.ok(plain.reads >= 30 * 2000, `default read ${plain.reads}`);
  assert.ok(indexed.reads <= 30 * 8, `index read ${indexed.reads}`);
  assert.deepEqual(
    (await indexed.cache.usage()).files,
    (await plain.cache.usage()).files,
    'both keep the same number of files',
  );
});

test('an existing database gets the index and totals once; an AssetCache without the index then goes to the network', async () => {
  globalThis.indexedDB = fakeIndexedDB();
  const network = server({ '/a': { body: bytes(100) }, '/b': { body: bytes(50) }, '/c': { body: bytes(100) } }),
    old = new AssetCache({ name: 'x3', fetch: network });
  for (const name of ['a', 'b']) {
    await read(await old.fetch(base + name));
    await old.flush();
    await tick();
  }
  old.dispose();
  await old.flush();
  const indexed = new AssetCache({ name: 'x3', maxBytes: 200, fetch: network, eviction: evictionIndex() });
  assert.deepEqual(await indexed.usage(), { bytes: 150, files: 2, quota: undefined, usage: undefined });
  await read(await indexed.fetch(base + 'c'));
  await indexed.flush();
  assert.equal(indexed.stats.evicted, 1, 'a, the oldest, makes room');
  assert.deepEqual(await indexed.usage(), { bytes: 150, files: 2, quota: undefined, usage: undefined });
  const plain = new AssetCache({ name: 'x3', fetch: network });
  await read(await plain.fetch(base + 'b'));
  await plain.flush();
  assert.equal(plain.stats.hits, 0, 'version 2 cannot be opened at version 1');
});

test('QuotaExceededError evicts room for the new file and retries once', async () => {
  globalThis.indexedDB = fakeIndexedDB({ quota: 150 });
  const files = { '/a': { body: bytes(100) }, '/b': { body: bytes(100, 3) }, '/big': { body: bytes(200, 4) } },
    network = server(files),
    cache = new AssetCache({ name: 'x4', fetch: network, eviction: evictionIndex() });
  for (const name of ['a', 'b']) {
    await read(await cache.fetch(base + name));
    await cache.flush();
    await tick();
  }
  assert.deepEqual(
    { stored: cache.stats.stored, evicted: cache.stats.evicted, errors: cache.stats.errors },
    { stored: 2, evicted: 1, errors: 0 },
  );
  assert.deepEqual(await read(await cache.fetch(base + 'big')), files['/big'].body);
  await cache.flush();
  assert.equal(cache.stats.errors, 1);
  assert.deepEqual(await cache.usage(), { bytes: 100, files: 1, quota: undefined, usage: undefined });
});
